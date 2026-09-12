import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const templates = require('../src/templates/index.js');
const { lintPrompt } = require('../src/lint.js');
const { sections } = require('../src/addendum.js');

test('every template is real content, never an empty heading', () => {
  assert.ok(templates.TEMPLATES.length >= 5);
  for (const t of templates.TEMPLATES) {
    assert.ok(t.id && t.label && t.blurb, `${t.id} is described`);
    const body = templates.seedFrom(t.id, t.label);
    for (const s of sections(body)) {
      if (!s.heading || /^#\s/.test(s.heading)) continue;
      assert.ok(s.lines.length, `${t.id}: "${s.heading}" must not ship empty`);
    }
  }
});

test('a fresh template warns about nothing except the brackets you have not filled in', () => {
  for (const t of templates.TEMPLATES) {
    const found = lintPrompt(templates.seedFrom(t.id, t.label));
    // The only finding allowed is the placeholder one -- and it must fire, because that is the
    // loop: a template marks its unknowns in [brackets] and the lint catches the ones left behind.
    assert.ok(found.length, `${t.id}: the unfilled brackets are caught`);
    assert.ok(found.every((f) => /placeholder is still in the prompt/.test(f.text)),
      `${t.id} should raise nothing else, got: ${found.map((f) => f.text).join(' | ')}`);
  }
});

test('a template carries the sections a prompt of that kind actually needs', () => {
  for (const t of templates.TEMPLATES) {
    const heads = sections(templates.seedFrom(t.id, t.label)).map((s) => s.heading.toLowerCase());
    for (const need of ['## goal', '## requirements', '## output format']) {
      assert.ok(heads.includes(need), `${t.id} has ${need}`);
    }
  }
});

test('an unknown id is null rather than a broken document', () => {
  assert.equal(templates.byId('nope'), null);
  assert.equal(templates.seedFrom('nope', 'T'), null);
  assert.ok(templates.seedFrom('code-review', 'My review').startsWith('# My review\n'));
});
