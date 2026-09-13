import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { classify, forEngine, LIMITS } = require('../src/attachments.js');

const fsWith = (files) => ({ readFileSync: (p) => { if (!(p in files)) throw new Error('ENOENT'); return Buffer.from(files[p]); } });

test('classify reads the name first and sniffs the bytes only when the name says nothing', () => {
  assert.equal(classify('shot.PNG').kind, 'image');
  assert.equal(classify('brief.pdf').kind, 'pdf');
  assert.equal(classify('notes.md').kind, 'text');
  assert.equal(classify('Dockerfile').kind, 'text');
  assert.equal(classify('data.bin', Buffer.from('plain words')).kind, 'text');
  assert.equal(classify('data.bin', Buffer.from([1, 0, 2])).kind, 'other');
  assert.equal(classify('deck.pptx').kind, 'other');
});

test('a key or credentials file is never read, whatever the person attached', () => {
  const c = classify('.env.production');
  assert.equal(c.secret, true);
  const out = forEngine([{ name: '.env', path: '/x/.env', secret: true }], { fs: fsWith({ '/x/.env': 'API_KEY=sk' }), caps: { image: true, pdf: true } });
  assert.deepEqual(out.blocks, []);
  assert.deepEqual(out.texts, []);
  assert.match(out.notes[0].note, /only its name/);
});

test('images and PDFs become blocks only where the engine takes them; otherwise they are named with the reason', () => {
  const fs = fsWith({ '/a.png': 'PNGDATA', '/b.pdf': 'PDFDATA' });
  const list = [{ name: 'a.png', path: '/a.png', kind: 'image', mime: 'image/png' }, { name: 'b.pdf', path: '/b.pdf', kind: 'pdf', mime: 'application/pdf' }];
  const yes = forEngine(list, { fs, caps: { image: true, pdf: true } });
  assert.deepEqual(yes.blocks.map((b) => [b.type, b.name, Buffer.from(b.data, 'base64').toString()]), [['image', 'a.png', 'PNGDATA'], ['pdf', 'b.pdf', 'PDFDATA']]);
  const no = forEngine(list, { fs, caps: { image: true, pdf: false } });
  assert.equal(no.blocks.length, 1);
  assert.match(no.notes[0].note, /cannot read PDFs/);
});

test('text is inlined, capped per file, and a missing file is a note rather than a throw', () => {
  const big = 'x'.repeat(LIMITS.textChars + 10);
  const out = forEngine([{ name: 'big.txt', path: '/big.txt', kind: 'text' }, { name: 'gone.md', path: '/gone.md', kind: 'text' }], { fs: fsWith({ '/big.txt': big }) });
  assert.equal(out.texts[0].text.length, LIMITS.textChars);
  assert.equal(out.texts[0].truncated, true);
  assert.match(out.notes[0].note, /no longer on disk/);
});
