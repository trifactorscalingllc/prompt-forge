import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildMergePrompt, buildPolishPrompt, OUTPUT_CONTRACT } = require('../src/engine/prompt.js');

const target = { id: 'gpt-5', label: 'GPT-5', family: 'gpt' };
const base = {
  doc: '# T\n\n## Goal\n\nx\n',
  ideas: [{ id: 'e1', text: 'first idea' }, { id: 'e2', text: 'second idea' }],
  resolutions: [],
  conflicts: [],
  recent: [],
  target,
};

test('merge prompt carries the document verbatim, the ideas numbered, the target, and the contract', () => {
  const p = buildMergePrompt(base);
  assert.ok(p.includes('<document>\n# T\n\n## Goal\n\nx\n</document>'));
  assert.ok(p.includes('1. first idea'));
  assert.ok(p.includes('2. second idea'));
  assert.ok(p.includes('GPT-5'));
  assert.ok(p.endsWith(OUTPUT_CONTRACT + '\n') || p.endsWith(OUTPUT_CONTRACT));
});

test('merge prompt says (none yet) with no history and lists recent entries oldest first otherwise', () => {
  assert.ok(buildMergePrompt(base).includes('(none yet)'));
  const p = buildMergePrompt({ ...base, recent: [{ ts: 1, text: 'older' }, { ts: 2, text: 'newer' }] });
  assert.ok(p.indexOf('older') < p.indexOf('newer'));
  assert.ok(!p.includes('(none yet)'));
});

test('merge prompt lists resolutions and open conflicts', () => {
  const p = buildMergePrompt({
    ...base,
    conflicts: [{ id: 'C1', section: 'Goal', existing: 'Ship it.', incoming: 'Do not ship.' }],
    resolutions: [{ conflictId: 'C1', keep: 'old' }],
  });
  assert.ok(p.includes('"id": "C1"') || p.includes('"id":"C1"'));
  assert.ok(/C1.*keep old/.test(p));
});

test('merge prompt forbids silent conflict resolution and loose bullets', () => {
  const p = buildMergePrompt(base);
  assert.match(p, /never resolve a contradiction silently/i);
  assert.match(p, /loose bullet/i);
  assert.match(p, /COMPLETE document/);
});

test('merge prompt is deterministic', () => {
  assert.equal(buildMergePrompt(base), buildMergePrompt(base));
});

test('polish prompt inlines the style guide under the family, keeps conflicts out of the body, and ends with the contract', () => {
  const p = buildPolishPrompt({ doc: base.doc, conflicts: [], target, styleGuide: 'USE HEADERS.' });
  assert.ok(p.includes('<style-guide family="gpt">\nUSE HEADERS.\n</style-guide>'));
  assert.ok(p.includes('<document>\n# T\n\n## Goal\n\nx\n</document>'));
  assert.match(p, /change form, not substance/i);
  assert.match(p, /own line/i);
  assert.ok(p.includes(OUTPUT_CONTRACT));
});

test('the contract demands one bare JSON object with doc, conflicts, changes', () => {
  assert.match(OUTPUT_CONTRACT, /"doc"/);
  assert.match(OUTPUT_CONTRACT, /"conflicts"/);
  assert.match(OUTPUT_CONTRACT, /"changes"/);
  assert.match(OUTPUT_CONTRACT, /no code fence/i);
});
