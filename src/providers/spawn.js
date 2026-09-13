'use strict';
// Running a vendor CLI as a child of the extension host, on every platform, without ever rejecting.
//
// Four rules, each paid for once somewhere:
// - The child runs in an EMPTY temp directory. No flag disables a CLI's project-file discovery
//   (CLAUDE.md, GEMINI.md, AGENTS.md); an inherited instruction file can silently steer a merge.
// - The prompt goes on stdin, never in argv: Windows caps a command line at 32K characters and
//   a big document is bigger than that.
// - NODE_OPTIONS / ELECTRON_RUN_AS_NODE / VSCODE_INSPECTOR_OPTIONS are dropped. Inherited from the
//   extension host they make a Node-based CLI print a debugger banner into stdout and corrupt JSON.
// - A timeout kills the whole process group, not just the shim, or a wedged grandchild holds the
//   stdout pipe open and the call never returns.
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOST_VARS = ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'VSCODE_INSPECTOR_OPTIONS'];
const POSIX_BINS = ['/opt/homebrew/bin', '/usr/local/bin'];

function engineEnv({ base = process.env, platform = process.platform, home = os.homedir(), scrub = [], extra = {} } = {}) {
  const drop = new Set([...HOST_VARS, ...scrub].map((k) => String(k).trim().toUpperCase()));
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (drop.has(k.trim().toUpperCase())) continue;
    env[k] = v;
  }
  if (platform !== 'win32') {
    const prepend = [...POSIX_BINS, path.posix.join(home, '.local', 'bin')];
    env.PATH = [...prepend, env.PATH || ''].filter(Boolean).join(':');
  }
  Object.assign(env, extra);
  return env;
}

/** What to hand to child_process.spawn. A Windows .cmd/.bat shim cannot be spawned directly. */
function spawnSpec({ bin, args = [], platform = process.platform, env = process.env }) {
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(bin)) {
    const quote = (s) => (s === '' || /[\s"]/.test(s) ? `"${String(s).replace(/"/g, '\\"')}"` : String(s));
    // cmd /s strips the first and last quote of the line it is given, so the whole line is wrapped
    // in one more pair (the same thing Node does for shell: true).
    const line = [`"${bin}"`, ...args.map(quote)].join(' ');
    return { command: (env && env.ComSpec) || 'cmd.exe', args: ['/d', '/s', '/c', `"${line}"`], options: { windowsVerbatimArguments: true } };
  }
  return { command: bin, args: [...args], options: {} };
}

/**
 * The line to run from a `where`/`which` listing. On Windows an npm-installed CLI lists its
 * extensionless POSIX shim first; that file cannot be spawned, its .cmd sibling can.
 */
function pickBin(lines, platform = process.platform) {
  const list = (lines || []).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length) return null;
  if (platform === 'win32') {
    const runnable = list.find((l) => /\.(exe|cmd|bat)$/i.test(l));
    if (runnable) return runnable;
  }
  return list[0];
}

function defaultWhich(name, platform = process.platform) {
  try {
    const r = spawnSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', env: engineEnv({ platform }), timeout: 5000 });
    if (r.status !== 0) return null;
    return pickBin(String(r.stdout || '').split(/\r?\n/), platform);
  } catch {
    return null;
  }
}

// PATH lookups are a blocking spawnSync on the extension host, so they happen once per detection
// (`fresh: true`) and are served from here for every call in between.
const binCache = new Map();
const clearBinCache = () => binCache.clear();

/** A configured path wins when it exists; otherwise the PATH lookup; otherwise null. */
function resolveBin(name, { configured = '', which = defaultWhich, exists = fs.existsSync, platform = process.platform, fresh = false } = {}) {
  const cfg = String(configured || '').trim();
  if (cfg) return exists(cfg) ? cfg : null;
  const key = `${platform}|${name}`;
  if (!fresh && binCache.has(key)) return binCache.get(key);
  const found = which(name, platform) || null;
  binCache.set(key, found);
  return found;
}

function runCli({ bin, args = [], stdin = null, timeoutMs = 240000, env = null, cwd = null, platform = process.platform, maxBytes = 8 * 1024 * 1024, collect = null, scrub = [] }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // Scrubbing applies even to an explicit env: the subscription-billing guarantee must not
    // depend on which overload the caller reached for.
    const childEnv = engineEnv({ base: env || process.env, platform, scrub });
    let tmp = null;
    let dir = cwd;
    if (!dir) {
      try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-')); dir = tmp; } catch (e) {
        return resolve({ ok: false, stdout: '', stderr: '', code: null, error: `could not create a temp directory: ${e.message}`, ms: 0 });
      }
    }
    const cleanup = () => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } } };

    let child;
    const argv = typeof args === "function" ? args(dir) : args;
    const spec = spawnSpec({ bin, args: argv, platform, env: childEnv });
    try {
      child = spawn(spec.command, spec.args, {
        cwd: dir, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: platform !== 'win32', ...spec.options,
      });
    } catch (e) {
      cleanup();
      return resolve({ ok: false, stdout: '', stderr: '', code: null, error: e.message, ms: Date.now() - t0 });
    }

    let out = '';
    let err = '';
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (res) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let collected = null;
      if (collect && res.ok) { try { collected = collect(dir); } catch { collected = null; } }
      cleanup();
      resolve({ ms: Date.now() - t0, collected, ...res });
    };
    const kill = () => {
      try {
        if (platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { timeout: 5000 });
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish({ ok: false, stdout: out, stderr: err, code: null, error: `timed out after ${timeoutMs}ms` });
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      out += d;
      if (out.length > maxBytes) { kill(); finish({ ok: false, stdout: out.slice(0, 4096), stderr: err, code: null, error: `output exceeded ${maxBytes} bytes` }); }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => finish({ ok: false, stdout: out, stderr: err, code: null, error: e.message }));
    child.on('close', (code) => {
      if (timedOut) return;
      finish({ ok: code === 0, stdout: out, stderr: err, code, error: code === 0 ? null : (err.trim().slice(0, 800) || `exit ${code}`) });
    });

    child.stdin.on('error', () => { /* the child closed stdin first; its exit code tells the story */ });
    if (stdin != null) child.stdin.end(String(stdin)); else child.stdin.end();
  });
}

/**
 * A CLI started now and fed later.
 *
 * The Claude CLI spends about six seconds booting before it reads a byte of its input, and it
 * spends them whether or not anyone is waiting. Started while the person is still typing, that boot
 * is already over when they press Enter: measured 1.4-1.6 s from send to answer against 6.3-6.5 s
 * cold, on a one-word reply.
 *
 * Same rules as runCli: an empty temp directory, the host variables and `scrub` dropped, a
 * process-group kill, never a rejection. The timeout starts at send(), not at spawn, because a warm
 * process sitting idle is not a slow call. `onLine` sees each stdout line as it arrives; lines that
 * arrived before anyone listened are replayed to the first listener.
 */
function openCli({ bin, args = [], env = null, platform = process.platform, maxBytes = 8 * 1024 * 1024, scrub = [] }) {
  const t0 = Date.now();
  const childEnv = engineEnv({ base: env || process.env, platform, scrub });
  let tmp = null;
  const dead = (error) => ({
    dir: null, startedAt: t0, alive: () => false, kill() {},
    send: async () => ({ ok: false, stdout: '', stderr: '', code: null, error, ms: 0, bootMs: 0 }),
  });
  try { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-forge-')); } catch (e) { return dead(`could not create a temp directory: ${e.message}`); }
  const cleanup = () => { if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } tmp = null; } };

  let child;
  try {
    const spec = spawnSpec({ bin, args: typeof args === 'function' ? args(tmp) : args, platform, env: childEnv });
    child = spawn(spec.command, spec.args, { cwd: tmp, env: childEnv, stdio: ['pipe', 'pipe', 'pipe'], detached: platform !== 'win32', ...spec.options });
  } catch (e) {
    cleanup();
    return dead(e.message);
  }
  const dir = tmp;

  let out = '';
  let err = '';
  let buf = '';
  let exit = null;           // { code, error } once the process is gone
  let sentAt = 0;
  let settled = false;
  let timer = null;
  let resolveSend = null;
  let listener = null;
  const early = [];

  const emit = (line) => {
    if (!listener) { early.push(line); return; }
    try { listener(line); } catch { /* a listener bug must not kill the call */ }
  };
  const killTree = () => {
    try {
      if (platform === 'win32') spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { timeout: 5000 });
      else process.kill(-child.pid, 'SIGKILL');
    } catch {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
  };
  const finish = (res) => {
    if (settled || !resolveSend) return;
    settled = true;
    clearTimeout(timer);
    if (buf) { emit(buf); buf = ''; }
    cleanup();
    resolveSend({ stdout: out, stderr: err, code: null, ms: Date.now() - sentAt, bootMs: sentAt - t0, ...res });
  };

  child.stdout.on('data', (d) => {
    const s = String(d);
    out += s;
    buf += s;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) emit(line); }
    if (out.length > maxBytes) { killTree(); finish({ ok: false, stdout: out.slice(0, 4096), error: `output exceeded ${maxBytes} bytes` }); }
  });
  child.stderr.on('data', (d) => { err += d; });
  child.on('error', (e) => { exit = { code: null, error: e.message }; finish({ ok: false, error: e.message }); });
  child.on('close', (code) => {
    exit = exit || { code, error: code === 0 ? null : (err.trim().slice(0, 800) || `exit ${code}`) };
    if (sentAt) finish({ ok: code === 0, code, error: exit.error });
    else cleanup();
  });
  child.stdin.on('error', () => { /* the child closed stdin first; its exit code tells the story */ });

  return {
    dir,
    startedAt: t0,
    /** True while the process is up and nothing has been sent to it. */
    alive: () => !exit && !sentAt,
    kill() {
      if (!sentAt) { killTree(); cleanup(); return; }
      if (!settled) { killTree(); finish({ ok: false, error: 'cancelled' }); }
    },
    send(stdin, { timeoutMs = 240000, onLine = null } = {}) {
      if (sentAt) return Promise.resolve({ ok: false, stdout: '', stderr: '', code: null, error: 'this process was already used', ms: 0, bootMs: 0 });
      sentAt = Date.now();
      return new Promise((resolve) => {
        resolveSend = resolve;
        listener = onLine;
        for (const line of early.splice(0)) emit(line);
        // It died while it waited (a flag an older CLI rejects, a crash): report that, not a hang.
        if (exit) { finish({ ok: false, code: exit.code, error: exit.error || 'the process exited before it was used' }); return; }
        timer = setTimeout(() => { killTree(); finish({ ok: false, error: `timed out after ${timeoutMs}ms` }); }, timeoutMs);
        child.stdin.end(String(stdin == null ? '' : stdin));
      });
    },
  };
}

module.exports = { runCli, openCli, engineEnv, spawnSpec, resolveBin, pickBin, clearBinCache, HOST_VARS };
