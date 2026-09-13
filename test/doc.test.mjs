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

test('a title is at most five words, whoever proposed it; setTitle rewrites the H1', () => {
  // The fallback when the engine offers no title. Five words, not eight: a name, not a sentence.
  assert.equal(doc.titleFrom('make the landing page sell the 6-week course to freelance designers who want more'), 'Make the landing page sell');
  assert.equal(doc.titleFrom('- ship by friday, no excuses\nsecond line ignored'), 'Ship by friday, no excuses');
  assert.equal(doc.titleFrom('   '), 'Untitled');

  // capTitle is the guarantee behind the instruction: a model told "at most five words" that
  // returns nine still yields five, and the quoting and trailing punctuation come off.
  // ...and the cut backs up past words that would leave the name hanging ("…, with a").
  assert.equal(doc.capTitle('"Collapsible prompt sidebar, with a plug and a hammer icon."'), 'Collapsible prompt sidebar');
  assert.equal(doc.capTitle('**Landing page rewrite**'), 'Landing page rewrite');
  assert.equal(doc.capTitle('Ship it.'), 'Ship it');
  assert.equal(doc.capTitle(''), '', 'nothing proposed is not a title');
  assert.equal(doc.capTitle(null), '');
  assert.equal(doc.setTitle('# Untitled\n\n## Goal\n\nx\n', 'Brief'), '# Brief\n\n## Goal\n\nx\n');
  assert.equal(doc.setTitle('no heading\n', 'Brief'), '# Brief\n\nno heading\n');
});

test('a title never ends on a dangling word, and survives a polish that drops or rewords it', () => {
  assert.equal(doc.capTitle('Emails that book calls for'), 'Emails that book calls');
  assert.equal(doc.capTitle('Sidebar with a plug and a hammer'), 'Sidebar with a plug');
  assert.equal(doc.capTitle('Cold email sequence for plumbers'), 'Cold email sequence for plumbers', 'a whole phrase is left alone');
  assert.equal(doc.titleOf('# Brief\n\n<goal>\nx\n</goal>\n'), 'Brief');
  assert.equal(doc.titleOf('Opening sentence.\n\n<goal>'), null);
  assert.equal(doc.titleOf('# Task\n\nDo it.'), null, 'a GPT section heading is not a title');
  assert.equal(doc.ensureTitle('Opening sentence.\n\n<goal>\n\nx\n\n</goal>\n', 'Brief'), '# Brief\n\nOpening sentence.\n\n<goal>\n\nx\n\n</goal>\n', 'a dropped title is put back on top');
  assert.equal(doc.ensureTitle('# Brief Reworded By Polish\n\nx\n', 'Brief'), '# Brief\n\nx\n', 'a reworded title is restored');
  assert.equal(doc.ensureTitle('# Task\n\nDo it.\n', 'Brief'), '# Brief\n\n# Task\n\nDo it.\n', 'a section heading is not mistaken for the title');
});
