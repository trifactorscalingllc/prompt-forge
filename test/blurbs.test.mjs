import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { modelBlurb, ROLE_BLURBS, FALLBACK } = require('../src/blurbs.js');
const catalog = require('../src/providers/catalog.json');
const targets = require('../src/targets/index.js');

test('every catalog model has its own one-liner, and every role and target does too', () => {
  for (const fam of ['claude', 'gemini', 'openai']) {
    for (const m of catalog[fam]) {
      const b = modelBlurb(m.id);
      assert.ok(b && b !== FALLBACK, `${m.id} has a blurb`);
      assert.ok(b.length < 160, `${m.id} blurb is one line`);
    }
  }
  for (const role of ['merge', 'polish', 'provider', 'target']) assert.ok(ROLE_BLURBS[role].length > 20, role);
  for (const t of targets.TARGETS) assert.ok(t.blurb && t.blurb.length > 20, `${t.id} target blurb`);
});

test('API-listed ids resolve by family; an unknown id gets the honest fallback', () => {
  assert.match(modelBlurb('claude-sonnet-5'), /merge/i);
  assert.match(modelBlurb('claude-fable-5-1'), /polish/i);
  assert.match(modelBlurb('gemini-2.5-flash'), /quick|fast|cheap/i);
  assert.match(modelBlurb('gpt-5-mini'), /fast|cheap/i);
  assert.match(modelBlurb('o3'), /reasoning/i);
  assert.equal(modelBlurb('my-local-model'), FALLBACK);
});
