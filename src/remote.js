'use strict';
// A project on another machine, reached over SSH -- the Mac mini in the next room -- attached to a
// prompt from whatever folder this window has open, without opening a remote window.
//
// It is the same brief as a local project, read the same way and under the same rules, only through
// `ssh`. Two round trips, on purpose:
//   1. list names    (never a file's contents), so the deny-list runs HERE, before anything is read
//   2. read exactly the files that survived it, each capped, in one stream
// A deny-list applied on the far side would be a shell script nobody can test; a deny-list applied
// to what came back would already have read the file it meant to skip.
//
// SSH runs in batch mode: a key or an agent, never a password prompt nobody can answer. Hosts come
// from ~/.ssh/config, the same file VS Code's Remote-SSH reads.
const nodeFs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { DENY_DIRS, DENY_FILE, MANIFESTS, SELF_DESCRIBING, CONVENTION, MAX_FILE_BYTES } = require('./project');

const SSH_OPTS = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** A host name ssh will accept and a shell cannot misread. */
const validHost = (h) => /^[A-Za-z0-9._@-]{1,253}$/.test(String(h || '')) && !String(h).startsWith('-');

/** The concrete Host entries in an ssh config (wildcards are patterns, not places to go). */
function sshHosts({ home = os.homedir(), fs = nodeFs, extra = [] } = {}) {
  const files = [nodePath.join(home, '.ssh', 'config'), ...extra.filter(Boolean)];
  const out = [];
  for (const f of files) {
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    let current = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const m = /^host\s+(.+)$/i.exec(line);
      if (m) {
        current = m[1].split(/\s+/).filter((h) => !/[*?!]/.test(h) && validHost(h));
        for (const h of current) if (!out.some((x) => x.host === h)) out.push({ host: h, hostName: null, user: null });
        continue;
      }
      const kv = /^(hostname|user)\s+(\S+)/i.exec(line);
      if (kv && current) {
        for (const h of current) {
          const row = out.find((x) => x.host === h);
          if (row) row[kv[1].toLowerCase() === 'hostname' ? 'hostName' : 'user'] = kv[2];
        }
      }
    }
  }
  return out;
}

/** The folder on the far side, as the shell there should see it: ~ expanded by that shell, not this one. */
function remoteCd(dir) {
  const d = String(dir || '').trim();
  if (!d || d === '~') return 'cd "$HOME"';
  if (d.startsWith('~/')) return `cd "$HOME"/${shq(d.slice(2))}`;
  return `cd ${shq(d)}`;
}

/** Run a script on the host through `sh -s`, so nothing about it has to survive argv quoting twice. */
function runRemote({ runCli, ssh, host, script, timeoutMs = 30000 }) {
  if (!validHost(host)) return Promise.resolve({ ok: false, stdout: '', stderr: '', error: `"${host}" is not a host name` });
  return runCli({ bin: ssh, args: [...SSH_OPTS, host, 'sh -s'], stdin: script, timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
}

const sshError = (res, host) => {
  const s = `${res.stderr || ''} ${res.error || ''}`;
  if (/permission denied|publickey/i.test(s)) return `ssh to ${host} needs a key or a running agent; a password prompt cannot be answered from here`;
  if (/could not resolve|name or service not known|no such host/i.test(s)) return `${host} could not be found`;
  if (/timed out|connection refused|no route/i.test(s)) return `${host} did not answer`;
  return (s.trim() || `ssh to ${host} failed`).slice(0, 300);
};

/** Folders in the host's home that look like projects, for the picker. Names only. */
async function discoverRemote({ runCli, ssh, host }) {
  const script = [
    'for d in "$HOME"/* "$HOME"/projects/* "$HOME"/Projects/* "$HOME"/code/* "$HOME"/src/* "$HOME"/dev/*; do',
    '  [ -d "$d" ] || continue',
    '  if [ -d "$d/.git" ] || [ -f "$d/package.json" ] || [ -f "$d/pyproject.toml" ] || [ -f "$d/go.mod" ] || [ -f "$d/Cargo.toml" ] || [ -f "$d/CLAUDE.md" ]; then',
    '    printf "%s\\n" "${d#"$HOME"/}"',
    '  fi',
    'done',
  ].join('\n');
  const res = await runRemote({ runCli, ssh, host, script });
  if (!res.ok) return { error: sshError(res, host), dirs: [] };
  return { dirs: String(res.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `~/${l}`), error: null };
}

/** Round trip one: names and file flags, depth 4, pruned of the directories never read anyway. */
function listScript(dir, { depth = 4, cap = 3000 } = {}) {
  const prune = [...DENY_DIRS].map((d) => `-name ${shq(d)}`).join(' -o ');
  return [
    `${remoteCd(dir)} 2>/dev/null || { echo "__NO_DIR__"; exit 3; }`,
    'printf "__HEAD__ %s\\n" "$(head -c 200 .git/HEAD 2>/dev/null)"',
    `find . -maxdepth ${depth} \\( ${prune} \\) -prune -o -print 2>/dev/null | head -n ${cap} | while IFS= read -r p; do`,
    '  if [ -d "$p" ]; then printf "D %s\\n" "$p"; else printf "F %s\\n" "$p"; fi',
    'done',
  ].join('\n');
}

/** { files: Set<rel>, dirs: Set<rel>, head } from round trip one. */
function parseListing(stdout) {
  const files = new Set();
  const dirs = new Set();
  let head = null;
  for (const line of String(stdout || '').split('\n')) {
    if (line.startsWith('__HEAD__ ')) { head = line.slice(9).trim() || null; continue; }
    const m = /^([DF]) \.\/(.+)$/.exec(line);
    if (!m) continue;
    (m[1] === 'D' ? dirs : files).add(m[2]);
  }
  return { files, dirs, head };
}

/** The same priority order as a local brief, from names alone, with the deny-list applied first. */
function choose({ files }) {
  const all = [...files];
  const root = (re) => all.filter((f) => !f.includes('/') && re.test(f));
  const docs = all.filter((f) => /^docs\/[^/]+\.md$/i.test(f) || /^docs\/[^/]+\/[^/]+\.md$/i.test(f)).sort();
  const wanted = [...root(/^README/i), ...root(/^CONTRIBUTING/i), ...docs, ...MANIFESTS, ...SELF_DESCRIBING, ...CONVENTION];
  const out = [];
  for (const rel of wanted) {
    if (out.includes(rel) || !files.has(rel)) continue;
    if (DENY_FILE.test(nodePath.posix.basename(rel))) continue;
    if (rel.split('/').some((seg) => DENY_DIRS.has(seg))) continue;
    out.push(rel);
  }
  return out;
}

/** Round trip two: exactly these files, each under the size cap, each cut to its head. */
function readScript(dir, rels, { headBytes = 20000 } = {}) {
  return [
    `${remoteCd(dir)} 2>/dev/null || exit 3`,
    `for f in ${rels.map(shq).join(' ')}; do`,
    '  [ -f "$f" ] || continue',
    '  s=$(wc -c < "$f" 2>/dev/null | tr -d " ")',
    `  [ -n "$s" ] && [ "$s" -le ${MAX_FILE_BYTES} ] || continue`,
    '  printf "\\n__FORGE_FILE__ %s\\n" "$f"',
    `  head -c ${headBytes} "$f"`,
    'done',
  ].join('\n');
}

function parseFiles(stdout) {
  const out = [];
  const parts = String(stdout || '').split('\n__FORGE_FILE__ ');
  for (const part of parts.slice(1)) {
    const nl = part.indexOf('\n');
    const rel = nl < 0 ? part.trim() : part.slice(0, nl).trim();
    const text = nl < 0 ? '' : part.slice(nl + 1);
    if (text.slice(0, 8192).includes('\u0000')) continue;   // binary, whatever the name said
    out.push({ rel, text });
  }
  return out;
}

/** The tree the brief shows: names to depth 3, dot folders out except .github, capped. */
function treeFrom({ files, dirs }, { depth = 3, cap = 400 } = {}) {
  const names = [...[...dirs].map((d) => `${d}/`), ...files]
    .filter((p) => p.replace(/\/$/, '').split('/').length <= depth)
    .filter((p) => !p.split('/').some((seg) => (seg.startsWith('.') && seg !== '.github') || DENY_DIRS.has(seg)))
    .sort();
  return names.slice(0, cap);
}

/**
 * The remote twin of project.collect: { files, tree, text, truncated, head } or { error }.
 */
async function collectRemote({ runCli, ssh, host, dir, maxFiles = 400, maxBytes = 2000000, timeoutMs = 60000 }) {
  const listed = await runRemote({ runCli, ssh, host, script: listScript(dir), timeoutMs });
  if (String(listed.stdout || '').includes('__NO_DIR__')) return { error: `${dir} does not exist on ${host}` };
  if (!listed.ok) return { error: sshError(listed, host) };
  const listing = parseListing(listed.stdout);
  const rels = choose(listing).slice(0, maxFiles);
  let got = [];
  if (rels.length) {
    const read = await runRemote({ runCli, ssh, host, script: readScript(dir, rels), timeoutMs });
    if (!read.ok) return { error: sshError(read, host) };
    got = parseFiles(read.stdout);
  }
  const files = [];
  const parts = [];
  let bytes = 0;
  let truncated = rels.length >= maxFiles;
  for (const { rel, text } of got) {
    if (bytes >= maxBytes) { truncated = true; break; }
    const slice = text.length >= 20000 ? `${text}\n… (truncated)` : text;
    files.push(rel);
    parts.push(`--- ${rel} ---\n${slice}`);
    bytes += slice.length;
  }
  const tree = treeFrom(listing);
  const head = listing.head ? (/^ref:/.test(listing.head) ? null : listing.head.slice(0, 7)) : null;
  return { files, tree, text: parts.join('\n\n'), truncated: truncated || tree.length >= 400, head };
}

module.exports = { sshHosts, discoverRemote, collectRemote, listScript, readScript, parseListing, parseFiles, choose, treeFrom, remoteCd, validHost, runRemote, SSH_OPTS };
