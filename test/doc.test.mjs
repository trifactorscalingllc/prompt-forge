import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const doc = require('../src/doc.js');

const ONE = [{ id: 'C1', section: 'Goal', existing: 'Ship it.', incoming: 'Do not ship.' }];

test('seed: a new prompt is only its title; isBlank tells a title-only document from a started one', () => {
  const s = doc.seed('My prompt');
  assert.equal(s, '# My prompt\n');
  assert.equal(doc.isBlank(s), true);
  assert.equal(doc.isBlank(''), true);
  assert.equal(doc.isBlank('# T\n\n## Goal\n\nShip.\n'), false);
  assert.equal(doc.isBlank(doc.withConflictBlock('# T\n', [{ id: 'C1', section: 'Goal', existing: 'a', incoming: 'b' }])), true, 'the conflict block alone is not content');
  assert.ok(doc.SECTIONS.length === 7, 'the canonical sections still guide the engine');
});

test('renderConflictBlock: nothing for an empty list', () => {
  assert.equal(doc.renderConflictBlock([]), '');
  assert.equal(doc.renderConflictBlock(null), '');
});

test('withConflictBlock puts the block right after the H1; stripConflictBlock returns the body exactly', () => {
  const body = '# T\n\n## Goal\n\nShip it.\n';
  const out = doc.withConflictBlock(body, ONE);
  assert.ok(out.startsWith('# T\n'));
  assert.ok(out.indexOf(doc.CONFLICT_OPEN) < out.indexOf('## Goal'), 'block sits before the first section');
  assert.ok(out.includes('## Open conflicts'));
  assert.ok(out.includes('C1') && out.includes('Ship it.') && out.includes('Do not ship.'));
  assert.equal(doc.stripConflictBlock(out), body);
});

test('withConflictBlock with no H1 puts the block at the top', () => {
  const body = 'Just text.\n';
  const out = doc.withConflictBlock(body, ONE);
  assert.ok(out.startsWith(doc.CONFLICT_OPEN));
  assert.equal(doc.stripConflictBlock(out), body);
});

test('withConflictBlock replaces an existing block instead of stacking a second one', () => {
  const body = '# T\n\n## Goal\n\nx\n';
  const once = doc.withConflictBlock(body, ONE);
  const twice = doc.withConflictBlock(once, [{ id: 'C2', section: 'Goal', existing: 'a', incoming: 'b' }]);
  assert.equal(twice.split(doc.CONFLICT_OPEN).length - 1, 1, 'exactly one block');
  assert.ok(twice.includes('C2') && !twice.includes('C1'));
  assert.equal(doc.stripConflictBlock(twice), body);
});

test('withConflictBlock with no conflicts is the bare body', () => {
  const body = '# T\n\n## Goal\n\nx\n';
  assert.equal(doc.withConflictBlock(doc.withConflictBlock(body, ONE), []), body);
});

test('stripConflictBlock also removes an unfenced "## Open conflicts" section up to the next heading', () => {
  const d = '# T\n\n## Open conflicts\n\n- stray line the engine wrote\n\n## Goal\n\nx\n';
  assert.equal(doc.stripConflictBlock(d), '# T\n\n## Goal\n\nx\n');
});

test('stripConflictBlock removes a trailing unfenced section with no heading after it', () => {
  const d = '# T\n\n## Goal\n\nx\n\n## Open conflicts\n\n- stray\n';
  assert.equal(doc.stripConflictBlock(d), '# T\n\n## Goal\n\nx\n');
});

test('stripForCopy: no block, no forge comments, exactly one trailing newline', () => {
  const body = '# T\n\n## Goal\n\nx\n<!-- forge:meta something -->\n\n\n';
  const out = doc.stripForCopy(doc.withConflictBlock(body, ONE));
  assert.equal(out, '# T\n\n## Goal\n\nx\n');
});

test('stripForCopy on a plain document is a no-op apart from the trailing newline', () => {
  assert.equal(doc.stripForCopy('# T\n\ntext'), '# T\n\ntext\n');
});

test('titleFrom turns the first idea into a short title; setTitle rewrites the H1', () => {
  assert.equal(doc.titleFrom('make the landing page sell the 6-week course to freelance designers who want more'), 'Make the landing page sell the 6-week course');
  assert.equal(doc.titleFrom('- ship by friday, no excuses\nsecond line ignored'), 'Ship by friday, no excuses');
  assert.equal(doc.titleFrom('   '), 'Untitled');
  assert.equal(doc.setTitle('# Untitled\n\n## Goal\n\nx\n', 'Brief'), '# Brief\n\n## Goal\n\nx\n');
  assert.equal(doc.setTitle('no heading\n', 'Brief'), '# Brief\n\nno heading\n');
});
