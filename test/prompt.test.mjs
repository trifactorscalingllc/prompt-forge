import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildMergePrompt, buildPolishPrompt, OUTPUT_CONTRACT } = require('../src/engine/prompt.js');
const targets = require('../src/targets/index.js');
const ROOT = new URL('..', import.meta.url).pathname;

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

test('merge prompt lists revised ideas with their old and new wording and tells the engine to replace, not add', () => {
  const p = buildMergePrompt({ ...base, ideas: [], revisions: [{ id: 'e1', before: 'ship friday', after: 'ship monday' }] });
  assert.ok(p.includes('<revisions>'));
  assert.ok(p.includes('ship friday') && p.includes('ship monday'));
  assert.match(p, /no longer reflect/i);
});

// ----------------------------------------------------------------------------------------------
// The three faults found by reading the merge and polish prompts against each other (0.5.0).
// ----------------------------------------------------------------------------------------------

const solo = { doc: '# P\n\n## Goal\n\nShip it.\n', target: { id: 'fable-5.1', label: 'Claude Fable 5.1', family: 'claude' } };

test('the section alias table matches what the style guides actually tell polish to write', () => {
  // This is the guard against the drift, not the mapping itself: polish renames sections per the
  // guide, and if a guide is edited without the table, the next merge reads headings it was never
  // told about and files ideas into duplicates.
  for (const family of targets.FAMILIES) {
    const guide = fs.readFileSync(path.join(ROOT, 'src/targets', `${family}.md`), 'utf8');
    const rows = targets.sectionsFor(family);
    assert.equal(rows.length, 7, `${family} maps all seven sections`);
    for (const { canonical, name } of rows) {
      assert.ok(guide.includes(name), `${family}.md must actually use ${name} (for ${canonical})`);
    }
  }
});

test('every canonical section has one name per family, and Goal is the one that moves', () => {
  const { SECTIONS } = require('../src/doc.js');
  for (const family of targets.FAMILIES) {
    assert.deepEqual(targets.sectionsFor(family).map((r) => r.canonical), SECTIONS, `${family} covers the canonical set in order`);
  }
  // The rename that actually bites: a GPT-polished document has no heading called "Goal" at all.
  assert.equal(targets.sectionsFor('gpt').find((r) => r.canonical === 'Goal').name, '# Task');
  assert.equal(targets.sectionsFor('claude').find((r) => r.canonical === 'Open questions').name, '<open_questions>');
  assert.equal(targets.sectionsFor('nonsense')[0].name, '<goal>', 'an unknown family falls back rather than throwing');
});

test('the merge prompt states the aliases instead of leaving them to be inferred', () => {
  assert.ok(!buildMergePrompt(solo).includes('\u2192'), 'no aliases given, none claimed');
  const gpt = buildMergePrompt({ ...solo, target, sectionNames: targets.sectionsFor('gpt') });
  assert.ok(gpt.includes('Goal \u2192 # Task'), 'the rename is spelled out');
  assert.ok(gpt.includes('they are the same sections'), 'and said to be the same section, not a new one');
  assert.ok(/never a reason to add a second one/.test(gpt));
  assert.ok(/Keep whatever naming the document already uses/.test(gpt));
});

test('a truncated already-merged list says so, and names the real record', () => {
  const recent = Array.from({ length: 12 }, (_, i) => ({ ts: 0, text: `idea ${i}` }));
  const whole = buildMergePrompt({ ...solo, recent, mergedTotal: 12 });
  assert.ok(!/showing="/.test(whole), 'a complete list makes no claim about being partial');

  // The old prompt said "those ideas are already merged, do not add them again" over a window of
  // 12, with no hint that 28 others existed. Rule 2 cannot fold a duplicate it is not shown.
  const cut = buildMergePrompt({ ...solo, recent, mergedTotal: 40 });
  assert.ok(cut.includes('showing="12" of="40"'));
  assert.ok(cut.includes('the 12 most recent of 40'));
  assert.ok(cut.includes('the earlier 28 are not shown'));
  assert.ok(/The DOCUMENT is the complete record/.test(cut), 'it is pointed at the thing that is actually complete');
});

test('merge may not invent, which until now only polish was told', () => {
  const p = buildMergePrompt(solo);
  assert.ok(/Add nothing of your own/.test(p));
  assert.ok(/must come from a new idea, a resolution, or text already in the document/.test(p));
  for (const word of ['requirements', 'constraints', 'examples', 'names', 'numbers', 'file paths']) {
    assert.ok(p.includes(word), `the rule names ${word} explicitly`);
  }
  // "Prefer a concrete statement over a vague one" is the line that, under pressure, manufactures
  // specifics. The new rule has to disclaim it by name or the two read as contradictory.
  assert.ok(/it is not permission to supply material they did not/.test(p));
  assert.ok(/a section with no material is left out/.test(p), 'and no filling a section to look complete');
  assert.ok(p.indexOf('prefer a concrete statement') < p.indexOf('Add nothing of your own'), 'the disclaimer follows the rule it qualifies');
});

test('polish still carries its own no-invention rule, unchanged', () => {
  assert.ok(/Add nothing the document does not say; drop nothing it does/.test(buildPolishPrompt({ ...solo, styleGuide: 'g' })));
});
