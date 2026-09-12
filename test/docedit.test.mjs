// The built-in document editor. The webview quotes a line range it rendered some moments ago, so
// the interesting cases are all about what happens when the engine rewrote the document in between:
// the edit must land where the user meant, or land nowhere and say so.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { replaceBlock, appendBlock, createDocEditors } = require('../src/docedit.js');
const md = require('../media/md.js');

const DOC = '# Goal\n\nShip one prompt.\n\n## Context\n\nA team of three.\n';
const blockOf = (text, kind) => md.blocks(text).find((b) => b.kind === kind);

test('an edit lands on the quoted range when the document has not moved', () => {
  const b = md.blocks(DOC)[2];                    // "Ship one prompt."
  const r = replaceBlock(DOC, { start: b.start, end: b.end, base: b.src, next: 'Ship two prompts.' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '# Goal\n\nShip two prompts.\n\n## Context\n\nA team of three.\n');
});

test('a multi-line block can grow and shrink without disturbing its neighbours', () => {
  const doc = '# A\n\n- one\n- two\n\n# B\n';
  const b = blockOf(doc, 'list');
  const grown = replaceBlock(doc, { start: b.start, end: b.end, base: b.src, next: '- one\n- two\n- three' });
  assert.equal(grown.text, '# A\n\n- one\n- two\n- three\n\n# B\n');
  const shrunk = replaceBlock(doc, { start: b.start, end: b.end, base: b.src, next: '- only' });
  assert.equal(shrunk.text, '# A\n\n- only\n\n# B\n');
});

test('the range is only a hint: a block that moved is found by its text', () => {
  const moved = `## New section\n\nAdded by a merge.\n\n${DOC}`;
  const b = md.blocks(DOC)[2];
  const r = replaceBlock(moved, { start: b.start, end: b.end, base: b.src, next: 'Ship two prompts.' });
  assert.equal(r.ok, true);
  assert.ok(r.text.includes('Ship two prompts.'));
  assert.ok(r.text.includes('## New section'), 'the merged section survives');
  assert.ok(!r.text.includes('Ship one prompt.'));
});

test('an ambiguous block is refused rather than guessed', () => {
  const twice = 'A line.\n\nA line.\n';
  const r = replaceBlock(twice, { start: 0, end: 1, base: 'Not this.', next: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'gone');
  const dup = replaceBlock(twice, { start: 9, end: 9, base: 'A line.', next: 'x' });
  assert.equal(dup.ok, false);
  assert.equal(dup.reason, 'drift');
});

test('a block the engine deleted is refused, and nothing is written', () => {
  const r = replaceBlock(DOC, { start: 2, end: 3, base: 'Text that is gone.', next: 'x' });
  assert.deepEqual(r, { ok: false, reason: 'gone' });
});

test('emptying a block removes it and the blank line under it', () => {
  const b = md.blocks(DOC)[2];
  const r = replaceBlock(DOC, { start: b.start, end: b.end, base: b.src, next: '   ' });
  assert.equal(r.ok, true);
  assert.equal(r.text, '# Goal\n\n## Context\n\nA team of three.\n');
});

test('CRLF input is normalised rather than doubled', () => {
  const crlf = DOC.replace(/\n/g, '\r\n');
  const b = md.blocks(DOC)[2];
  const r = replaceBlock(crlf, { start: b.start, end: b.end, base: b.src, next: 'Ship two prompts.' });
  assert.equal(r.ok, true);
  assert.ok(!r.text.includes('\r'));
});

test('append puts a new block one blank line clear of the end, and never on an empty document', () => {
  assert.equal(appendBlock(DOC, 'A new line.'), `${DOC.trimEnd()}\n\nA new line.\n`);
  assert.equal(appendBlock('', 'First.'), 'First.\n');
  assert.equal(appendBlock('body\n\n\n', 'Next.'), 'body\n\nNext.\n');
  assert.equal(appendBlock(DOC, '   '), DOC, 'nothing to add, nothing changes');
});

// ------------------------------------------------------------------------------------------
// The wiring: one fake webview, one fake document.
// ------------------------------------------------------------------------------------------
function harness(initial = DOC) {
  const state = { text: initial, written: [], commands: [], external: [], clipboard: null };
  const listeners = { message: [], change: [] };
  const disposables = [];
  const dispose = (list, fn) => { list.push(fn); return { dispose: () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); } }; };

  const document = { uri: { fsPath: '/tmp/p.md', toString: () => 'file:///tmp/p.md' }, getText: () => state.text, isDirty: false };
  const posted = [];
  const panel = {
    webview: {
      options: null,
      html: '',
      postMessage: (m) => { posted.push(m); return true; },
      onDidReceiveMessage: (fn) => dispose(listeners.message, fn),
      cspSource: 'vscode-webview:',
      asWebviewUri: (u) => `webview://${u.fsPath}`,
    },
  };
  const vscode = {
    Uri: { file: (p) => ({ fsPath: p }), parse: (u) => ({ url: u }) },
    workspace: { onDidChangeTextDocument: (fn) => dispose(listeners.change, fn) },
    commands: { executeCommand: async (...a) => { state.commands.push(a); } },
    env: { clipboard: { writeText: async (t) => { state.clipboard = t; } }, openExternal: async (u) => { state.external.push(u.url); } },
  };
  const docio = {
    writeDoc: async (fsPath, text) => { state.written.push({ fsPath, text }); state.text = text; for (const fn of [...listeners.change]) fn({ document }); },
  };
  const editors = createDocEditors({
    vscode, docio,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    docHtml: () => '<html></html>',
    mediaRoots: () => ['/ext/media'],
  });
  const send = async (m) => { for (const fn of [...listeners.message]) await fn(m); };
  return { editors, document, panel, send, posted, state, listeners, disposables };
}

test('attaching paints the page, sends the document, and follows it as it changes', async () => {
  const h = harness();
  await h.editors.attach(h.document, h.panel, 3);
  assert.equal(h.panel.webview.html, '<html></html>');
  assert.deepEqual(h.panel.webview.options.localResourceRoots, [{ fsPath: '/ext/media' }]);
  const doc = h.posted.filter((m) => m.type === 'doc');
  assert.ok(doc.length >= 1);
  assert.equal(doc[0].text, DOC);
  assert.equal(doc[0].name, 'p.md');
});

test('an edit from the page is written through docio, once', async () => {
  const h = harness();
  await h.editors.attach(h.document, h.panel, 1);
  const b = md.blocks(DOC)[2];
  await h.send({ type: 'edit', start: b.start, end: b.end, base: b.src, next: 'Ship two prompts.' });
  assert.equal(h.state.written.length, 1);
  assert.equal(h.state.written[0].fsPath, '/tmp/p.md');
  assert.ok(h.state.written[0].text.includes('Ship two prompts.'));
});

test('an edit that cannot be placed writes nothing and tells the page why', async () => {
  const h = harness();
  await h.editors.attach(h.document, h.panel, 1);
  await h.send({ type: 'edit', start: 0, end: 1, base: 'Not in the document.', next: 'x' });
  assert.equal(h.state.written.length, 0);
  const err = h.posted.filter((m) => m.type === 'notice' && m.level === 'error');
  assert.equal(err.length, 1);
  assert.match(err[0].text, /Nothing was changed/);
});

test('source mode writes the whole document, and a no-op write is skipped', async () => {
  const h = harness();
  await h.editors.attach(h.document, h.panel, 1);
  await h.send({ type: 'replaceAll', text: DOC });
  assert.equal(h.state.written.length, 0, 'identical text is not a write');
  await h.send({ type: 'replaceAll', text: '# Different\n' });
  assert.equal(h.state.written.length, 1);
  assert.equal(h.state.text, '# Different\n');
});

test('copy, open-as-text and links go where they should', async () => {
  const h = harness();
  await h.editors.attach(h.document, h.panel, 1);
  await h.send({ type: 'copy' });
  assert.equal(h.state.clipboard, DOC);
  await h.send({ type: 'openText' });
  assert.deepEqual(h.state.commands.at(-1).slice(0, 2), ['vscode.openWith', h.document.uri]);
  assert.equal(h.state.commands.at(-1)[2], 'default');
  await h.send({ type: 'openPanel' });
  assert.deepEqual(h.state.commands.at(-1), ['promptForge.open']);
  await h.send({ type: 'openUrl', url: 'https://example.com' });
  await h.send({ type: 'openUrl', url: 'javascript:alert(1)' });
  assert.deepEqual(h.state.external, ['https://example.com'], 'only a real web link is opened');
});

test('detaching drops every listener, so a reload cannot leave two runtimes writing', async () => {
  const h = harness();
  await h.editors.attach(h.document, h.panel, 1);
  assert.equal(h.editors.count(), 1);
  await h.editors.attach(h.document, h.panel, 2);      // a reload re-attaches the same panel
  assert.equal(h.editors.count(), 1, 'the old attachment is replaced, not stacked');
  assert.equal(h.listeners.message.length, 1);
  assert.equal(h.listeners.change.length, 1);
  h.editors.dispose();
  assert.equal(h.editors.count(), 0);
  assert.equal(h.listeners.message.length, 0);
  assert.equal(h.listeners.change.length, 0);
});
