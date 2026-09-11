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
    const line = [`"${bin}"`, ...args.map(quote)].join(' ');
    return { command: (env && env.ComSpec) || 'cmd.exe', args: ['/d', '/s', '/c', line], options: { windowsVerbatimArguments: true } };
  }
  return { command: bin, args: [...args], options: {} };
}

function defaultWhich(name, platform = process.platform) {
  try {
    const r = spawnSync(platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8', env: engineEnv({ platform }), timeout: 5000 });
    if (r.status !== 0) return null;
    const first = String(r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    return first || null;
  } catch {
    return null;
  }
}

/** A configured path wins when it exists; otherwise the PATH lookup; otherwise null. */
function resolveBin(name, { configured = '', which = defaultWhich, exists = fs.existsSync, platform = process.platform } = {}) {
  const cfg = String(configured || '').trim();
  if (cfg) return exists(cfg) ? cfg : null;
  return which(name, platform) || null;
}

function runCli({ bin, args = [], stdin = null, timeoutMs = 240000, env = null, cwd = null, platform = process.platform, maxBytes = 8 * 1024 * 1024, collect = null, scrub = [] }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const childEnv = env || engineEnv({ platform, scrub });
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

module.exports = { runCli, engineEnv, spawnSpec, resolveBin, HOST_VARS };
