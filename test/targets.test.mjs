import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const targets = require('../src/targets/index.js');

test('every target maps to a family that has a substantial style guide on disk', () => {
  assert.ok(targets.TARGETS.length >= 8);
  for (const t of targets.TARGETS) {
    assert.ok(['claude', 'gemini', 'gpt'].includes(t.family), `${t.id} family`);
    assert.ok(t.label && t.id);
    const guide = targets.styleGuide(t.family);
    assert.ok(guide.length > 400, `${t.family} guide is written`);
  }
});

test('the default target exists and the lookups resolve it', () => {
  const t = targets.TARGETS.find((x) => x.id === targets.DEFAULT_TARGET);
  assert.ok(t);
  assert.equal(targets.familyOf(t.id), t.family);
  assert.equal(targets.labelOf(t.id), t.label);
});

test('an unknown id is treated as a custom target: label is the id, family defaults to claude unless given', () => {
  assert.equal(targets.labelOf('my-model'), 'my-model');
  assert.equal(targets.familyOf('my-model'), 'claude');
  assert.equal(targets.familyOf('my-model', 'gpt'), 'gpt');
  assert.deepEqual(targets.resolve('my-model', 'gemini'), { id: 'my-model', label: 'my-model', family: 'gemini' });
});

test('the claude guide insists on block-level tags (an inline tag reads as literal text)', () => {
  assert.match(targets.styleGuide('claude'), /own line/i);
});
