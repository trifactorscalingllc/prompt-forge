import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { buildMergePrompt, buildPolishPrompt, OUTPUT_CONTRACT, EDITS_CONTRACT } = require('../src/engine/prompt.js');
const targets = require('../src/targets/index.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const whole = (r) => `${r.system}\n${r.prompt}`;

const target = { id: 'gpt-5', label: 'GPT-5', family: 'gpt' };
const base = {
  doc: '# T\n\n## Goal\n\nx\n',
  ideas: [{ id: 'e1', text: 'first idea' }, { id: 'e2', text: 'second idea' }],
  resolutions: [],
  conflicts: [],
  recent: [],
  target,
};

test('merge prompt carries the document verbatim, the ideas numbered, the target, and the edits contract', () => {
  const p = buildMergePrompt(base);
  assert.ok(p.prompt.includes('<document>\n# T\n\n## Goal\n\nx\n</document>'));
  assert.ok(p.prompt.includes('1. first idea'));
  assert.ok(p.prompt.includes('2. second idea'));
  assert.ok(p.prompt.includes('<target-model>GPT-5</target-model>'));
  assert.ok(p.system.includes(EDITS_CONTRACT));
});

test('the system half is the same bytes whatever the document, target, flags or ideas: it is what gets cached', () => {
  const a = buildMergePrompt(base).system;
  const b = buildMergePrompt({ ...base, doc: '# Other\n', target: { id: 'fable-5.1', label: 'Claude Fable 5.1', family: 'claude' }, suggest: true, needsTitle: true, sectionNames: targets.sectionsFor('gpt'), recent: [{ ts: 1, text: 'x' }], mergedTotal: 40 }).system;
  assert.equal(a, b);
  assert.ok(!a.includes('GPT-5') && !a.includes('Fable'), 'no target name in the cached half');
  const pa = buildPolishPrompt({ doc: 'a', target, styleGuide: 'G' }).system;
  const pb = buildPolishPrompt({ doc: 'b', target: { ...target, label: 'GPT-5 mini' }, styleGuide: 'G', only: ['Goal'], conflicts: [{ id: 'C1' }] }).system;
  assert.equal(pa, pb);
});

test('merge prompt says (none yet) with no history and lists recent entries oldest first otherwise', () => {
  assert.ok(buildMergePrompt(base).prompt.includes('(none yet)'));
  const p = buildMergePrompt({ ...base, recent: [{ ts: 1, text: 'older' }, { ts: 2, text: 'newer' }] }).prompt;
  assert.ok(p.indexOf('older') < p.indexOf('newer'));
  assert.ok(!p.includes('(none yet)'));
});

test('a long already-merged idea is shortened in the list; the document holds it in full', () => {
  const p = buildMergePrompt({ ...base, recent: [{ ts: 1, text: 'x'.repeat(2000) }] }).prompt;
  assert.ok(!p.includes('x'.repeat(401)));
});

test('merge prompt lists resolutions and open conflicts', () => {
  const p = buildMergePrompt({
    ...base,
    conflicts: [{ id: 'C1', section: 'Goal', existing: 'Ship it.', incoming: 'Do not ship.' }],
    resolutions: [{ conflictId: 'C1', keep: 'old' }],
  }).prompt;
  assert.ok(p.includes('"id": "C1"') || p.includes('"id":"C1"'));
  assert.ok(/C1.*keep old/.test(p));
});

test('merge forbids silent conflict resolution and loose bullets; edits mode forbids re-sending, document mode asks for everything', () => {
  const edits = buildMergePrompt(base).system;
  assert.match(edits, /never resolve a contradiction silently/i);
  assert.match(edits, /loose bullet/i);
  assert.match(edits, /never re-send a section you are not changing/);
  const full = buildMergePrompt({ ...base, mode: 'document' }).system;
  assert.match(full, /COMPLETE document/);
  assert.ok(full.includes(OUTPUT_CONTRACT));
});

test('merge prompt is deterministic', () => {
  assert.deepEqual(buildMergePrompt(base), buildMergePrompt(base));
});

test('polish carries the style guide in its system half, the document in the message, and does not ask for conflicts back', () => {
  const p = buildPolishPrompt({ doc: base.doc, conflicts: [], target, styleGuide: 'USE HEADERS.' });
  assert.ok(p.system.includes('<style-guide family="gpt">\nUSE HEADERS.\n</style-guide>'));
  assert.ok(p.prompt.includes('<document>\n# T\n\n## Goal\n\nx\n</document>'));
  assert.match(p.system, /change form, not substance/i);
  assert.match(p.system, /own line/i);
  assert.ok(!/"conflicts"/.test(p.system), 'polish may not change conflicts, so it is not asked to repeat them');
  assert.ok(!p.prompt.includes('<rewrite-only>'));
});

test('an incremental polish names the sections to rewrite and asks for edits to those alone', () => {
  const p = buildPolishPrompt({ doc: base.doc, target, styleGuide: 'g', only: ['Requirements', 'Context'] });
  assert.ok(p.prompt.includes('<rewrite-only>\n- Requirements\n- Context\n</rewrite-only>'));
  assert.match(p.system, /"edits"/);
  assert.match(p.prompt, /leave every other section exactly as it is/);
});

test('the contracts: the document form carries doc, conflicts, changes; the edits form names every op', () => {
  assert.match(OUTPUT_CONTRACT, /"doc"/);
  assert.match(OUTPUT_CONTRACT, /"conflicts"/);
  assert.match(OUTPUT_CONTRACT, /"changes"/);
  assert.match(OUTPUT_CONTRACT, /no code fence/i);
  for (const w of ['"edits"', '"append"', '"replace"', '"create"', '"delete"', '"conflicts"', '"changes"']) assert.ok(EDITS_CONTRACT.includes(w), w);
  assert.match(EDITS_CONTRACT, /no code fence/i);
  assert.match(EDITS_CONTRACT, /never includes the section's heading/);
});

test('merge prompt lists revised ideas with their old and new wording and tells the engine to replace, not add', () => {
  const p = buildMergePrompt({ ...base, ideas: [], revisions: [{ id: 'e1', before: 'ship friday', after: 'ship monday' }] });
  assert.ok(p.prompt.includes('<revisions>'));
  assert.ok(p.prompt.includes('ship friday') && p.prompt.includes('ship monday'));
  assert.match(whole(p), /no longer reflect/i);
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
    const guide = fs.readFileSync(path.join(ROOT, 'src', 'targets', `${family}.md`), 'utf8');
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
  assert.ok(!whole(buildMergePrompt(solo)).includes('→'), 'no aliases given, none claimed');
  const gpt = whole(buildMergePrompt({ ...solo, target, sectionNames: targets.sectionsFor('gpt') }));
  assert.ok(gpt.includes('Goal → # Task'), 'the rename is spelled out');
  assert.ok(gpt.includes('they are the same sections'), 'and said to be the same section, not a new one');
  assert.ok(/never a reason to add a second one/.test(gpt));
  assert.ok(/Keep whatever naming the document already uses/.test(gpt));
});

test('a truncated already-merged list says so, and names the real record', () => {
  const recent = Array.from({ length: 12 }, (_, i) => ({ ts: 0, text: `idea ${i}` }));
  const all = whole(buildMergePrompt({ ...solo, recent, mergedTotal: 12 }));
  assert.ok(!/showing="/.test(all), 'a complete list makes no claim about being partial');

  // The old prompt said "those ideas are already merged, do not add them again" over a window of
  // 12, with no hint that 28 others existed. Rule 2 cannot fold a duplicate it is not shown.
  const cut = whole(buildMergePrompt({ ...solo, recent, mergedTotal: 40 }));
  assert.ok(cut.includes('showing="12" of="40"'));
  assert.ok(cut.includes('the 12 most recent of 40'));
  assert.ok(cut.includes('the earlier 28 are not shown'));
  assert.ok(/The DOCUMENT is the complete record/.test(cut), 'it is pointed at the thing that is actually complete');
});

test('merge may not invent, which until now only polish was told', () => {
  const p = whole(buildMergePrompt(solo));
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

test('polish keeps the title, pads nothing, and on a target switch renames the model and writes new advice', () => {
  const p = buildPolishPrompt({ ...solo, styleGuide: 'g' });
  assert.match(p.system, /keep it as the first line, word for word/);
  assert.match(p.system, /never write placeholder text such as "None provided"/);
  assert.match(p.system, /Keep only the sections the document has material for/);
  assert.ok(!p.prompt.includes('is now for'), 'no switch, no renaming note');
  const switched = buildPolishPrompt({ ...solo, styleGuide: 'g', target: { id: 'opus-5', label: 'Claude Opus 5', family: 'claude' }, previousTarget: { label: 'Claude Fable 5.1' }, suggest: true });
  assert.ok(switched.prompt.includes('This prompt was written for Claude Fable 5.1 and is now for Claude Opus 5.'));
  assert.ok(switched.prompt.includes('"suggestions"') && switched.prompt.includes('"ideas"'), 'advice for the new model comes back with the polish');
  assert.equal(switched.system, p.system, 'still the same cached system half');
  assert.match(whole(buildMergePrompt({ ...solo, needsTitle: true })), /complete, grammatical noun phrase/);
});

test('polish still carries its own no-invention rule, unchanged', () => {
  assert.ok(/Add nothing the document does not say; drop nothing it does/.test(whole(buildPolishPrompt({ ...solo, styleGuide: 'g' }))));
});

// ----------------------------------------------------------------------------------------------
// Suggestions and ideas: advice about the prompt that must never become part of it.
// ----------------------------------------------------------------------------------------------

test('suggestions and ideas are asked for only when wanted, typed, and never into the document', () => {
  assert.ok(!whole(buildMergePrompt(solo)).includes('"suggestions"'), 'off by default in the builder');
  const p = whole(buildMergePrompt({ ...solo, suggest: true }));
  assert.ok(p.includes('"suggestions"'));
  assert.ok(p.includes('"kind"') && /"action"/.test(p) && /"info"/.test(p), 'each suggestion says whether it must be acted on');
  assert.ok(p.includes('"ideas"'), 'and ideas for taking the prompt further are asked for alongside');
  assert.ok(/up to three/.test(p) && /do not manufacture three/.test(p), 'no padding to a quota');
  assert.ok(/never as text to paste in/.test(p), 'advice to the person, not body copy');
  assert.ok(/must never appear in the document/.test(p), 'the engine is told the boundary too');
  // Polish never asks: it is a restyle of what exists, not a review of what is missing.
  assert.ok(!whole(buildPolishPrompt({ ...solo, styleGuide: 'g' })).includes('"suggestions"'));
});

test('the parser caps suggestions, drops the empty ones, pins Requirements and Context, and caps ideas', () => {
  const { parseEngineOutput } = require('../src/engine/output.js');
  const reply = JSON.stringify({
    doc: '# T\n\n## Goal\n\nx\n',
    suggestions: [
      { section: 'Requirements', kind: 'info', text: '  Name the three formats you accept.  ' },
      { section: 'Examples', text: '' },
      { section: 'Context', kind: 'action', text: 'Say which constraint wins.' },
      { section: 'Output format', kind: 'action', text: 'Who is this for?' },
      { section: 'Goal', text: 'A fourth, over the cap.' },
    ],
    ideas: ['one', { text: 'two' }, { text: '' }, 'three', 'four'],
  });
  const out = parseEngineOutput(reply, { kind: 'merge', inputDoc: '# T\n\n## Goal\n\nx\n' });
  assert.ok(out.ok);
  assert.equal(out.suggestions.length, 3, 'three at most, empties removed first');
  assert.equal(out.suggestions[0].text, 'Name the three formats you accept.', 'whitespace normalised');
  assert.deepEqual(out.suggestions.map((s) => s.kind), ['action', 'info', 'action'], 'Requirements is always act-on, Context always background');
  assert.ok(!out.suggestions.some((x) => x.text.includes('fourth')));
  assert.deepEqual(out.ideas.map((x) => x.text), ['one', 'two', 'three']);
  const bare = parseEngineOutput(JSON.stringify({ doc: '# T\n\nx\n' }), { kind: 'merge' });
  assert.deepEqual(bare.suggestions, [], 'an engine that returns none is not an error');
  assert.deepEqual(bare.ideas, []);
});

test('a dismissed suggestion does not come back when the next merge regenerates them', async () => {
  const os = require('node:os');
  const fsn = require('node:fs');
  const storeMod = require('../src/store.js');
  const dir = fsn.mkdtempSync(path.join(os.tmpdir(), 'forge-sg-'));
  const store = storeMod.open(dir);
  const { slug } = store.create('T');

  store.setSuggestions(slug, [{ section: 'Examples', text: 'Add one worked example.' }, { section: 'Goal', text: 'Say what done looks like.' }]);
  assert.equal(store.read(slug).suggestions.length, 2);

  store.dismissSuggestion(slug, 'Add one worked example.');
  assert.deepEqual(store.read(slug).suggestions.map((x) => x.text), ['Say what done looks like.']);

  // Every merge regenerates the list, so the dismissal has to be remembered or it nags forever.
  store.setSuggestions(slug, [{ section: 'Examples', text: 'Add one worked example.' }, { section: 'Context', text: 'Name the audience.' }]);
  assert.deepEqual(store.read(slug).suggestions.map((x) => x.text), ['Name the audience.']);
  fsn.rmSync(dir, { recursive: true, force: true });
});

test('an idea’s attachments are named on its line, text files inline, and bytes never in the prompt text', () => {
  const plain = whole(buildMergePrompt({ ...solo, ideas: [{ id: 'e1', text: 'make it look like this' }] }));
  assert.ok(!/Attached:/.test(plain), 'no attachments, no mention');

  const p = whole(buildMergePrompt({
    ...solo,
    ideas: [{
      id: 'e1',
      text: 'make it look like this',
      attached: {
        blocks: [{ type: 'image', name: 'shot.png', data: 'QUFBQUFB' }],
        texts: [{ name: 'notes.md', text: 'the notes', truncated: false }],
        notes: [{ name: 'deck.pptx', note: 'not a format an engine can read, so only its name is sent' }],
      },
    }],
  }));
  assert.ok(p.includes('shot.png (image, sent with this message)'));
  assert.ok(p.includes('notes.md (text, in an <attachment> block below)'));
  assert.ok(p.includes('<attachment name="notes.md" idea="1">\nthe notes\n</attachment>'));
  assert.ok(p.includes('deck.pptx (name only: not a format'));
  assert.ok(!p.includes('QUFBQUFB'), 'an image goes as a content block, never as text');
  assert.match(p, /refer to it by its file name/, 'the engine is told how the finished prompt points at a file');
});

test('advice already on the panel is listed for the engine, and only when advice is asked for', () => {
  const advice = ['Name the formats you accept here.', 'Say who reads it.'];
  const block = /\n<advice-already-shown>\n/;
  const asked = whole(buildMergePrompt({ ...solo, suggest: true, advice }));
  assert.match(asked, block);
  for (const a of advice) assert.ok(asked.includes(`- ${a}`), a);
  assert.ok(/never repeat or reword any of it/i.test(asked), 'and told not to say it again');
  assert.doesNotMatch(whole(buildMergePrompt({ ...solo, advice })), block, 'not when advice was not asked for');
  assert.doesNotMatch(whole(buildMergePrompt({ ...solo, suggest: true })), block, 'nor when there is none yet');
  const polished = whole(buildPolishPrompt({ ...solo, styleGuide: 'g', suggest: true, advice }));
  assert.match(polished, block);
  assert.ok(polished.includes('- Say who reads it.'));
});
