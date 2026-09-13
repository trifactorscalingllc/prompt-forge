import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clipboardCommand, copyFiles } = require('../src/clipfiles.js');
const { selectionIdea } = require('../src/selection.js');

test('files onto the clipboard: one built-in way per platform, quoted so a name cannot break out', () => {
  const win = clipboardCommand(["C:\\a\\it's [1].png", 'C:\\b.pdf'], 'win32');
  assert.equal(win.bin, 'powershell.exe');
  assert.equal(win.stdin, "Set-Clipboard -LiteralPath 'C:\\a\\it''s [1].png','C:\\b.pdf'\n");
  assert.ok(!win.args.some((a) => a.includes('.png')), 'paths go on stdin, not the command line');
  const mac = clipboardCommand(['/Users/me/a "b".png'], 'darwin');
  assert.equal(mac.bin, 'osascript');
  assert.ok(mac.args[3].includes(JSON.stringify(['/Users/me/a "b".png'])));
  assert.equal(clipboardCommand(['/x'], 'linux').args.includes('text/uri-list'), true);
  assert.equal(clipboardCommand([], 'win32'), null);
});

test('copyFiles reports a failure as a sentence, never a throw', async () => {
  const r = await copyFiles(['C:\\a.png'], { runCli: async () => ({ ok: false, stderr: 'Access denied' }), platform: 'win32' });
  assert.deepEqual(r, { ok: false, error: 'Access denied' });
  assert.match((await copyFiles(['/a'], { runCli: async () => ({ ok: true }), platform: 'sunos' })).error, /not supported/);
});

test('a selection becomes an idea: the note, where it came from, the code in a fence that cannot close early', () => {
  const idea = selectionIdea({ note: ' validate before saving ', text: 'save(user)\r\n', file: 'src/api.ts', start: 12, end: 14, lang: 'typescript' });
  assert.equal(idea, 'validate before saving\n\nFrom src/api.ts:12-14:\n```typescript\nsave(user)\n```');
  const fenced = selectionIdea({ text: 'x\n```js\ny\n```', file: 'README.md', start: 3, end: 3 });
  assert.ok(fenced.startsWith('From README.md:3:\n~~~\n'), 'no note, one line, and a tilde fence around backticks');
  assert.match(selectionIdea({ text: 'a'.repeat(30), file: 'f', max: 10 }), /\(cut to fit\)/);
});
