import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const send = require('../src/send.js');

function fakeHome(folder, sessions) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-send-'));
  const dir = path.join(home, '.claude', 'projects', send.projectKey(folder).toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  for (const s of sessions) {
    const file = path.join(dir, `${s.id}.jsonl`);
    fs.writeFileSync(file, s.lines.map((l) => JSON.stringify(l)).join('\n'));
    fs.utimesSync(file, s.mtime / 1000, s.mtime / 1000);
  }
  return home;
}

test('a folder\'s Claude Code conversations are found by its key, whatever the drive letter case, newest first, named sensibly', () => {
  assert.equal(send.projectKey('C:\\Users\\me\\proj'), 'C--Users-me-proj');
  const now = Date.now();
  const home = fakeHome('C:\\Users\\me\\proj', [
    { id: 'old', mtime: now - 3600e3, lines: [{ type: 'user', message: { content: '<command-name>/clear</command-name>' } }, { type: 'user', message: { content: [{ type: 'text', text: 'Fix the login bug' }] } }] },
    { id: 'new', mtime: now - 60e3, lines: [{ type: 'summary', summary: 'Landing page rewrite' }, { type: 'user', message: { content: 'hello' } }] },
  ]);
  const list = send.recentSessions('c:\\Users\\me\\proj', { home });
  assert.deepEqual(list.map((s) => s.id), ['new', 'old']);
  assert.equal(list[0].title, 'Landing page rewrite', 'a summary wins');
  assert.equal(list[1].title, 'Fix the login bug', 'a slash-command wrapper is not what anyone typed');
  assert.deepEqual(send.recentSessions('C:\\elsewhere', { home }), []);
});

test('the conversation a prompt started is found after the person sends it, and not before', () => {
  const now = Date.now();
  const home = fakeHome('/p', [{ id: 'mine', mtime: now, lines: [{ type: 'user', message: { content: '# Landing brief\n\n<goal>...' } }] }]);
  assert.equal(send.findSentSession({ folder: '/p', sentAt: now - 5000, promptStart: '# Landing brief', home }).id, 'mine');
  assert.equal(send.findSentSession({ folder: '/p', sentAt: now + 60000, promptStart: '# Landing brief', home }), null, 'older than the send');
});

test('a terminal paste is bracketed and cannot be ended early by an escape inside the prompt', () => {
  const seq = send.pasteSequence('line one\nline two\u001b[201~ sneaky');
  assert.ok(seq.startsWith('\u001b[200~') && seq.endsWith('\u001b[201~'));
  assert.equal((seq.match(/\u001b/g) || []).length, 2, 'only the two markers');
  assert.ok(seq.includes('line one\nline two'));
});

test('Claude on an SSH host starts in the project folder, with ~ left for the far shell', () => {
  const c = send.remoteClaudeCommand('mini', '~/code/my app');
  assert.ok(c.startsWith('ssh -t mini '));
  assert.ok(c.includes('$HOME') && c.includes("'code/my app'") && c.endsWith('claude"'));
});

test('destinations: the remembered place first when it still exists, then live terminals, conversations, new, remote', () => {
  const opts = {
    folder: '/work/app',
    terminals: [{ name: 'claude' }],
    sessions: [{ id: 's1', title: 'Old chat', mtime: Date.now() - 7200e3 }],
    hasClaudeExtension: true,
    remembered: { kind: 'session', id: 's1', title: 'Old chat' },
    remote: { host: 'mini', dir: '~/app' },
  };
  const d = send.destinations(opts);
  assert.deepEqual(d.map((x) => x.kind), ['session', 'terminal', 'new-panel', 'remote']);
  assert.equal(d[0].last, true);
  assert.equal(d[0].description, 'Where you sent it last');
  assert.ok(d.every((x) => x.label && !/\$\(/.test(x.label)), 'plain labels: the panel draws its own icons, codicon syntax would show as text');
  assert.equal(d.filter((x) => x.kind === 'session').length, 1, 'the remembered one is not listed twice');
  const gone = send.destinations({ ...opts, remembered: { kind: 'terminal', name: 'closed' } });
  assert.ok(!gone.some((x) => x.last), 'a closed terminal is not offered as last');
  const noExt = send.destinations({ ...opts, hasClaudeExtension: false, remembered: null });
  assert.deepEqual(noExt.map((x) => x.kind), ['terminal', 'new-terminal', 'remote'], 'without the extension there is no panel to open a conversation in');
});
