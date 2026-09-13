'use strict';
// Sending a finished prompt to Claude Code, where it will be used, instead of copy, switch, paste.
//
// Where it can go, in the order it is offered:
//   1. where this prompt was sent last time, if that place still exists
//   2. a terminal in this window already running Claude
//   3. a recent Claude Code conversation in the project folder, opened with the prompt in its input
//   4. a new Claude Code conversation in that folder (the panel when the extension is installed,
//      otherwise a terminal running `claude`)
//   5. for a project on an SSH host, a terminal on that host in that folder
// Nothing is ever submitted on the person's behalf. The prompt lands in the input box, and Enter is
// theirs: a prompt sent to the wrong conversation cannot be taken back.
//
// This file is the part that does not need VS Code: finding conversations on disk, ordering the
// choices, and building what is typed into a terminal. The runtime does the rest.
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const oneLine = (s, max = 80) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };

/** Claude Code keeps a folder's conversations under ~/.claude/projects/<the path, every non-alphanumeric a dash>. */
const projectKey = (folder) => String(folder || '').replace(/[^a-zA-Z0-9]/g, '-');

/** A conversation's name: its summary or custom title when it has one, else its first real message. Reads only the head. */
function sessionTitle(file, { fs = nodeFs, headBytes = 64 * 1024 } = {}) {
  let head = '';
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(headBytes);
      const n = fs.readSync(fd, buf, 0, headBytes, 0);
      head = buf.subarray(0, n).toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch { return ''; }
  let first = '';
  for (const line of head.split('\n')) {
    let j;
    try { j = JSON.parse(line); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    if (j.type === 'summary' && j.summary) return oneLine(j.summary);
    if (j.type === 'custom-title' && j.customTitle) return oneLine(j.customTitle);
    if (!first && j.type === 'user' && j.message) {
      const c = j.message.content;
      const t = typeof c === 'string' ? c : Array.isArray(c) ? ((c.find((b) => b && b.type === 'text') || {}).text || '') : '';
      // Slash commands and hook output arrive as tagged wrappers; they are not what anyone typed.
      if (t && !/^\s*<(command|local-command|system|user-prompt-submit-hook)/.test(t)) first = oneLine(t);
    }
  }
  return first;
}

/** Recent Claude Code conversations for a folder, newest first: [{ id, title, mtime, file }]. */
function recentSessions(folder, { home = os.homedir(), fs = nodeFs, limit = 8 } = {}) {
  if (!folder) return [];
  const root = path.join(home, '.claude', 'projects');
  let dirs;
  try { dirs = fs.readdirSync(root); } catch { return []; }
  // VS Code lowercases a Windows drive letter and a terminal does not; the folder is the same one.
  const want = projectKey(folder).toLowerCase();
  const found = [];
  for (const d of dirs.filter((x) => x.toLowerCase() === want)) {
    let files;
    try { files = fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    for (const f of files) {
      const file = path.join(root, d, f);
      try { found.push({ id: f.slice(0, -'.jsonl'.length), file, mtime: fs.statSync(file).mtimeMs }); } catch { /* vanished */ }
    }
  }
  found.sort((a, b) => b.mtime - a.mtime);
  return found.slice(0, limit).map((s) => ({ ...s, title: sessionTitle(s.file, { fs }) }));
}

/**
 * The conversation a prompt went into when it was sent to a NEW conversation: the newest one in the
 * folder, begun after the send, whose first message starts the way the prompt does. Until the person
 * presses Enter it does not exist, and this says so with null.
 */
function findSentSession({ folder, sentAt, promptStart, home = os.homedir(), fs = nodeFs }) {
  const want = oneLine(promptStart, 60);
  if (!want) return null;
  return recentSessions(folder, { home, fs, limit: 20 }).find((s) => s.mtime >= sentAt - 1000 && s.title.startsWith(want.slice(0, 40))) || null;
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** What a terminal on an SSH host runs to start Claude in the project folder. */
function remoteClaudeCommand(host, dir) {
  const d = String(dir || '~');
  const cd = d === '~' ? 'cd' : d.startsWith('~/') ? `cd "$HOME"/${shq(d.slice(2))}` : `cd ${shq(d)}`;
  return `ssh -t ${host} ${JSON.stringify(`${cd} && claude`)}`;
}

/**
 * A paste, not keystrokes. Wrapped in bracketed-paste markers, a multi-line prompt arrives in Claude
 * Code's input as one block; typed raw, its first newline would submit the first line. An escape
 * character inside the prompt could end the paste early, so there are none.
 */
function pasteSequence(text) {
  return `\u001b[200~${String(text == null ? '' : text).replace(/\u001b/g, '')}\u001b[201~`;
}

/**
 * The choices, in order. Each is { kind, label, description, ... }:
 *   last          the remembered destination, when it is still there
 *   terminal      { name, index }
 *   session       { id, title, mtime }
 *   new-panel     { folder }         Claude Code extension installed
 *   new-terminal  { folder }         otherwise
 *   remote        { host, dir }
 */
function destinations({ folder = null, terminals = [], sessions = [], hasClaudeExtension = false, remembered = null, remote = null, now = Date.now() }) {
  const ago = (t) => { const m = Math.round((now - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`; };
  const out = [];
  const same = (a, b) => a && b && a.kind === b.kind && (a.kind === 'terminal' ? a.name === b.name : a.kind === 'session' ? a.id === b.id : a.kind === 'remote' ? a.host === b.host && a.dir === b.dir : false);
  if (remembered) {
    const live = remembered.kind === 'terminal' ? terminals.some((t) => t.name === remembered.name)
      : remembered.kind === 'session' ? sessions.some((s) => s.id === remembered.id)
        : remembered.kind === 'remote';
    if (live) out.push({ ...remembered, last: true, label: `$(history) Where you sent it last: ${remembered.label || remembered.name || remembered.title || remembered.host}` });
  }
  terminals.forEach((t, index) => {
    const item = { kind: 'terminal', name: t.name, index, label: `$(terminal) Paste into the terminal "${t.name}"`, description: 'Claude is running there' };
    if (!out.some((o) => same(o, item))) out.push(item);
  });
  for (const s of sessions) {
    const item = { kind: 'session', id: s.id, title: s.title, mtime: s.mtime, label: `$(comment-discussion) ${s.title || s.id}`, description: `Claude Code conversation · ${ago(s.mtime)}` };
    if (hasClaudeExtension && !out.some((o) => same(o, item))) out.push(item);
  }
  if (folder) {
    out.push(hasClaudeExtension
      ? { kind: 'new-panel', folder, label: '$(add) New Claude Code conversation', description: path.basename(folder) }
      : { kind: 'new-terminal', folder, label: '$(add) New terminal running claude', description: path.basename(folder) });
  }
  if (remote) out.push({ kind: 'remote', host: remote.host, dir: remote.dir, label: `$(remote) Claude on ${remote.host}`, description: remote.dir });
  return out;
}

module.exports = { projectKey, sessionTitle, recentSessions, findSentSession, remoteClaudeCommand, pasteSequence, destinations, shq };
