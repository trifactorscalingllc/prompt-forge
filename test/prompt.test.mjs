import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildMergePrompt, buildPolishPrompt } = require('../src/engine/prompt.js');
const targets = require('../src/targets/index.js');
const ROOT = new URL('..', import.meta.url).pathname;

const base = { doc: '# P\n\n## Goal\n\nShip it.\n', target: { id: 'fable-5.1', label: 'Claude Fable 5.1', family: 'claude' } };

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

test('every canonical section has exactly one name per family, and Goal is the one that moves', () => {
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
  const bare = buildMergePrompt(base);
  assert.ok(!bare.includes('→'), 'no aliases given, none claimed');

  const gpt = buildMergePrompt({ ...base, target: { id: 'gpt-5', label: 'GPT-5', family: 'gpt' }, sectionNames: targets.sectionsFor('gpt') });
  assert.ok(gpt.includes('Goal → # Task'), 'the rename is spelled out');
  assert.ok(gpt.includes('they are the same sections'), 'and said to be the same section, not a new one');
  assert.ok(/never a reason to add a second one/.test(gpt));
  assert.ok(/Keep whatever naming the document already uses/.test(gpt));
});

test('a truncated already-merged list says so, and names the real record', () => {
  const recent = Array.from({ length: 12 }, (_, i) => ({ ts: 0, text: `idea ${i}` }));

  const whole = buildMergePrompt({ ...base, recent, mergedTotal: 12 });
  assert.ok(!/showing="/.test(whole), 'a complete list makes no claim about being partial');
  assert.ok(!/most recent of/.test(whole));

  // The old prompt said "those ideas are already merged, do not add them again" over a window of
  // 12, with no hint that 28 others existed. Rule 2 cannot fold a duplicate it is not shown.
  const cut = buildMergePrompt({ ...base, recent, mergedTotal: 40 });
  assert.ok(cut.includes('showing="12" of="40"'));
  assert.ok(cut.includes('the 12 most recent of 40'));
  assert.ok(cut.includes('the earlier 28 are not shown'));
  assert.ok(/The DOCUMENT is the complete record/.test(cut), 'it is pointed at the thing that is actually complete');
});

test('merge may not invent, which until now only polish was told', () => {
  const p = buildMergePrompt(base);
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
  const p = buildPolishPrompt({ ...base, styleGuide: 'g' });
  assert.ok(/Add nothing the document does not say; drop nothing it does/.test(p));
});
