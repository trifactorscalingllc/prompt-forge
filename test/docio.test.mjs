import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDocio } = require('../src/docio.js');

function fakeVscode({ open = [], office = false } = {}) {
  const edits = [];
  const shown = [];
  const executed = [];
  const docs = open.map((d) => ({
    uri: { fsPath: d.path, toString: () => `file://${d.path}` },
    text: d.text, dirty: true, saved: 0, lineCount: d.text.split('\n').length,
    getText() { return this.text; },
    async save() { this.saved += 1; return true; },
  }));
  return {
    edits, shown, executed, docs,
    workspace: {
      textDocuments: docs,
      applyEdit: async (e) => { edits.push(e); for (const [uri, range, text] of e.ops) { const d = docs.find((x) => x.uri.fsPath === uri.fsPath); d.text = text; } return true; },
      openTextDocument: async (uri) => docs.find((x) => x.uri.fsPath === uri.fsPath) || { uri, getText: () => fs.readFileSync(uri.fsPath, 'utf8') },
    },
    window: { showTextDocument: async (doc, opts) => { shown.push({ doc, opts }); } },
    commands: { executeCommand: async (...a) => { executed.push(a); } },
    extensions: { getExtension: (id) => (office && id === 'cweijan.vscode-office' ? {} : undefined) },
    Uri: { file: (p) => ({ fsPath: p, toString: () => `file://${p}` }) },
    WorkspaceEdit: class { constructor() { this.ops = []; } replace(uri, range, text) { this.ops.push([uri, range, text]); } },
    Range: class { constructor(a, b, c, d) { this.args = [a, b, c, d]; } },
    Position: class { constructor(l, c) { this.line = l; this.character = c; } },
    ViewColumn: { One: 1, Two: 2, Beside: -2 },
  };
}
const tmpFile = (text) => { const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-docio-')), 'x.md'); fs.writeFileSync(p, text); return p; };

test('readDoc prefers the open (dirty) document over the disk copy', async () => {
  const p = tmpFile('on disk\n');
  const v = fakeVscode({ open: [{ path: p, text: 'in editor\n' }] });
  const io = createDocio(v, { echoMs: 0 });
  assert.equal(await io.readDoc(p), 'in editor\n');
  assert.equal(io.isOpen(p), true);
  const closed = createDocio(fakeVscode(), { echoMs: 0 });
  assert.equal(await closed.readDoc(p), 'on disk\n');
  assert.equal(closed.isOpen(p), false);
  assert.equal(await closed.readDoc('/nope/x.md'), null);
});

test('writeDoc on an open document replaces the whole range through a WorkspaceEdit and saves; skips when identical', async () => {
  const p = tmpFile('old\n');
  const v = fakeVscode({ open: [{ path: p, text: 'old\n' }] });
  const io = createDocio(v, { echoMs: 0 });
  await io.writeDoc(p, 'new text\n');
  assert.equal(v.edits.length, 1);
  assert.equal(v.docs[0].text, 'new text\n');
  assert.equal(v.docs[0].saved, 1);
  await io.writeDoc(p, 'new text\n');
  assert.equal(v.edits.length, 1, 'identical content is not re-applied');
});

test('writeDoc on a closed document writes to disk', async () => {
  const p = tmpFile('old\n');
  const io = createDocio(fakeVscode(), { echoMs: 0 });
  await io.writeDoc(p, 'disk\n');
  assert.equal(fs.readFileSync(p, 'utf8'), 'disk\n');
});

test('writeDoc waits out the editor echo window after a save it was told about', async () => {
  const p = tmpFile('old\n');
  const v = fakeVscode({ open: [{ path: p, text: 'old\n' }] });
  const io = createDocio(v, { echoMs: 150 });
  io.noteSaved(p);
  const t0 = Date.now();
  await io.writeDoc(p, 'later\n');
  assert.ok(Date.now() - t0 >= 120, 'waited for the echo window');
});

test('openBeside uses the built-in editor by default, in column two', async () => {
  const p = tmpFile('x');
  const v = fakeVscode({ office: true });
  await createDocio(v, { echoMs: 0 }).openBeside(p);
  assert.equal(v.executed[0][0], 'vscode.openWith');
  assert.equal(v.executed[0][2], 'promptForge.markdown', 'ours, not a third party extension');
  assert.equal(v.executed[0][3].viewColumn, 2);
  assert.equal(v.shown.length, 0);
});

test('openBeside falls back to the text editor when the built-in one is not registered yet', async () => {
  const p = tmpFile('x');
  const v = fakeVscode();
  v.commands.executeCommand = async () => { throw new Error('No editor found for promptForge.markdown'); };
  const where = await createDocio(v, { echoMs: 0, log: { warn() {}, info() {}, error() {} } }).openBeside(p);
  assert.equal(where, 'text', 'the document still opens');
  assert.equal(v.shown.length, 1);
});

test('openBeside uses Office Viewer when installed and wanted, else the text editor in column two', async () => {
  const p = tmpFile('x');
  const office = fakeVscode({ office: true });
  await createDocio(office, { echoMs: 0 }).openBeside(p, { editor: 'office' });
  assert.equal(office.executed[0][0], 'vscode.openWith');
  assert.equal(office.executed[0][2], 'cweijan.markdownViewer');
  assert.equal(office.executed[0][3].viewColumn, 2);
  const plain = fakeVscode({ office: true });
  await createDocio(plain, { echoMs: 0 }).openBeside(p, { editor: 'text' });
  assert.equal(plain.executed.length, 0);
  assert.equal(plain.shown[0].opts.viewColumn, 2);
  const missing = fakeVscode({ office: false });
  await createDocio(missing, { echoMs: 0 }).openBeside(p, { editor: 'office' });
  assert.equal(missing.executed.length, 0);
  assert.equal(missing.shown.length, 1);
});
