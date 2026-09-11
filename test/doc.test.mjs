import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const doc = require('../src/doc.js');

const ONE = [{ id: 'C1', section: 'Goal', existing: 'Ship it.', incoming: 'Do not ship.' }];

test('seed: an H1 title then every canonical section, in order', () => {
  const s = doc.seed('My prompt');
  assert.ok(s.startsWith('# My prompt\n'));
  let last = -1;
  for (const name of doc.SECTIONS) {
    const i = s.indexOf(`\n## ${name}\n`);
    assert.ok(i > last, `${name} present and after the previous section`);
    last = i;
  }
  assert.ok(s.endsWith('\n'));
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
