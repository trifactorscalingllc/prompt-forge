// The document as structure: parsing sections, applying an engine's edits, and the formatter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const S = require('../src/engine/sections.js');
const { applyEdits } = require('../src/engine/edits.js');
const { formatDoc, FILLER } = require('../src/engine/format.js');

const MD = '# Title\n\nOpening line.\n\n## Goal\n\nShip it.\n\n## Requirements\n\n- one\n- two\n\n### Detail\n\nnested\n\n## Output format\n\nJSON.\n';
const XML = '# T\n\nDo the job.\n\n<goal>\n\nShip it.\n\n</goal>\n\n<examples>\n\n<example>\nA\n</example>\n\n</examples>\n';
const GPT = '# P\n\n# Task\n\nDo.\n\n# Context\n\nC.\n';

// ---- parse / serialize -----------------------------------------------------------------------

test('a markdown document parses into title, preamble and sections, and round-trips exactly', () => {
  const st = S.parse(MD);
  assert.equal(st.title, '# Title');
  assert.deepEqual(S.trimBlank(st.preamble), ['Opening line.']);
  assert.deepEqual(st.sections.map((s) => s.name), ['Goal', 'Requirements', 'Output format']);
  assert.ok(st.sections[1].body.includes('### Detail'), 'a deeper heading stays inside its section');
  assert.equal(st.style, 'md');
  assert.equal(st.level, 2);
  assert.equal(S.serialize(st), MD);
});

test('a tagged document parses nested tags as content, and round-trips exactly', () => {
  const st = S.parse(XML);
  assert.deepEqual(st.sections.map((s) => s.name), ['goal', 'examples']);
  assert.ok(st.sections[1].body.includes('<example>'));
  assert.equal(st.style, 'xml');
  assert.equal(S.serialize(st), XML);
});

test('a heading inside a code fence is example text, not a section', () => {
  const st = S.parse('# T\n\n## Examples\n\n```md\n## Goal\n```\n');
  assert.equal(st.sections.length, 1);
});

test('a GPT document: the first H1 is the title and "# Task" is Goal', () => {
  const st = S.parse(GPT);
  assert.equal(st.title, '# P');
  assert.deepEqual(st.sections.map((s) => s.name), ['Task', 'Context']);
  assert.equal(S.canonicalOf('Task'), 'Goal');
  assert.equal(S.canonicalOf('<output_format>'), 'Output format');
  assert.ok(S.sameSection('## Open Questions', 'open_questions'));
});

// ---- edits -----------------------------------------------------------------------------------

test('replace changes only the named section; every other byte is carried over', () => {
  const r = applyEdits(MD, [{ section: 'Requirements', op: 'replace', text: '- one\n- two\n- three' }]);
  assert.ok(r.ok);
  assert.equal(r.doc, MD.replace('- one\n- two\n\n### Detail\n\nnested', '- one\n- two\n- three'));
});

test('append joins a list tightly, and anything else as its own paragraph', () => {
  assert.equal(applyEdits('# T\n\n## Requirements\n\n- one\n', [{ section: 'requirements', op: 'append', text: '- two' }]).doc, '# T\n\n## Requirements\n\n- one\n- two\n');
  assert.equal(applyEdits('# T\n\n## Context\n\nFirst.\n', [{ section: 'Context', op: 'append', text: 'Second.' }]).doc, '# T\n\n## Context\n\nFirst.\n\nSecond.\n');
});

test('create places a new section in the standard order, in the document\'s own shape', () => {
  const md = applyEdits('# T\n\n## Goal\n\nG.\n\n## Output format\n\nJSON.\n', [{ section: 'Constraints', op: 'create', text: 'No ads.' }]);
  assert.equal(md.doc, '# T\n\n## Goal\n\nG.\n\n## Constraints\n\nNo ads.\n\n## Output format\n\nJSON.\n');
  const xml = applyEdits(XML, [{ section: 'Open questions', op: 'create', text: 'Who?' }]);
  assert.ok(xml.doc.endsWith('</examples>\n\n<open_questions>\n\nWho?\n\n</open_questions>\n'));
  const gpt = applyEdits(GPT, [{ section: 'Requirements', op: 'create', text: '1. x' }, { section: 'Goal', op: 'replace', text: 'Do it well.' }]);
  assert.equal(gpt.doc, '# P\n\n# Task\n\nDo it well.\n\n# Context\n\nC.\n\n# Requirements\n\n1. x\n', 'the alias is honoured and the level matches');
  assert.equal(applyEdits('# T\n', [{ section: 'Goal', op: 'create', text: 'Ship.' }]).doc, '# T\n\n## Goal\n\nShip.\n', 'a fresh document gets a level-2 heading');
});

test('a repeated heading or tag in the edit text is stripped, not duplicated', () => {
  assert.equal(applyEdits(MD, [{ section: 'Goal', op: 'replace', text: '## Goal\n\nNew.' }]).doc, MD.replace('Ship it.', 'New.'));
  assert.equal(applyEdits(XML, [{ section: 'goal', op: 'replace', text: '<goal>\nNew.\n</goal>' }]).doc, XML.replace('Ship it.', 'New.'));
});

test('an edit that cannot be placed without guessing fails the whole reply', () => {
  const two = applyEdits('# T\n\n## Notes\n\na\n\n## Notes\n\nb\n', [{ section: 'Notes', op: 'append', text: 'c' }]);
  assert.equal(two.ok, false);
  assert.match(two.error, /without guessing/);
  assert.equal(applyEdits(MD, [{ section: 'Goal', op: 'rewrite', text: 'x' }]).ok, false);
  assert.equal(applyEdits(MD, [{ op: 'append', text: 'x' }]).ok, false);
  assert.equal(applyEdits(MD, 'nope').ok, false);
});

test('no edits is a valid answer; delete and an empty replace both remove a section; create on an existing section appends', () => {
  assert.equal(applyEdits(MD, []).doc, MD);
  assert.ok(!applyEdits(MD, [{ section: 'Output format', op: 'delete' }]).doc.includes('Output format'));
  assert.ok(!applyEdits(MD, [{ section: 'Goal', op: 'replace', text: '' }]).doc.includes('## Goal'));
  assert.ok(applyEdits(MD, [{ section: 'Goal', op: 'create', text: 'Also this.' }]).doc.includes('Ship it.\n\nAlso this.'));
  assert.equal(applyEdits(MD, [{ section: '(preamble)', op: 'replace', text: 'New opening.' }]).doc, MD.replace('Opening line.', 'New opening.'));
});

// ---- formatter -------------------------------------------------------------------------------

test('merge mode: glued tags go on their own lines, bullets become "-", blank runs collapse', () => {
  const out = formatDoc('# T\n\n<goal>Ship it.</goal>\n\n\n\n<requirements>\n* one\n+ two   \n</requirements>\n');
  assert.equal(out, '# T\n\n<goal>\n\nShip it.\n\n</goal>\n\n<requirements>\n\n- one\n- two\n\n</requirements>\n');
});

test('merge mode: an unclosed section tag is closed before the next section; a stray closer is dropped', () => {
  assert.equal(formatDoc('# T\n\n<goal>\nShip.\n\n<context>\nC.\n</context>\n'), '# T\n\n<goal>\n\nShip.\n\n</goal>\n\n<context>\n\nC.\n\n</context>\n');
  assert.equal(formatDoc('# T\n\n## Goal\n\nShip.\n</goal>\n'), '# T\n\n## Goal\n\nShip.\n');
});

test('merge mode never renames or reorders the person\'s sections, but folds a duplicate into the first', () => {
  const out = formatDoc('# T\n\n## Requirements\n\n- a\n\n## Goal\n\nG.\n\n## requirements\n\n- b\n');
  assert.equal(out, '# T\n\n## Requirements\n\n- a\n- b\n\n## Goal\n\nG.\n');
});

test('polish for Claude: tags, the standard order, duplicates folded, headings inside a tag made bold', () => {
  const out = formatDoc('# T\n\nDo it.\n\n## Requirements\n\n- a\n\n## Goal\n\nG.\n\n### Why\n\nBecause.\n\n## requirements\n\n- b\n', { family: 'claude' });
  assert.equal(out, '# T\n\nDo it.\n\n<goal>\n\nG.\n\n**Why**\n\nBecause.\n\n</goal>\n\n<requirements>\n\n- a\n- b\n\n</requirements>\n');
});

test('polish for GPT and Gemini: the guide\'s own headings, whatever shape the reply came back in', () => {
  const src = '# T\n\n<output_format>\n\nJSON.\n\n</output_format>\n\n<goal>\n\nG.\n\n</goal>\n';
  assert.equal(formatDoc(src, { family: 'gpt' }), '# T\n\n# Task\n\nG.\n\n# Output format\n\nJSON.\n');
  assert.equal(formatDoc(src, { family: 'gemini' }), '# T\n\n## Goal\n\nG.\n\n## Output format\n\nJSON.\n');
});

test('polish mode leaves out a section with nothing in it, and never takes a real line for filler', () => {
  const src = '# T\n\n## Goal\n\nShip it.\n\n## Constraints\n\n- None recorded in the working document yet.\n\n## Output format\n\nNot yet specified in the working document.\n\n## Examples\n\n## Requirements\n\n- None of the emails may exceed 120 words.\n';
  assert.equal(formatDoc(src, { family: 'gemini' }), '# T\n\n## Goal\n\nShip it.\n\n## Requirements\n\n- None of the emails may exceed 120 words.\n');
  assert.ok(formatDoc(src).includes('## Constraints'), 'merge mode keeps what the person has, empty or not');
  for (const f of ['None provided.', '- None recorded in the working document yet.', 'Not yet specified in the working document.', 'No examples provided yet.', 'N/A', 'TBD', 'None.']) assert.ok(FILLER.test(f), `filler: ${f}`);
  for (const real of ['None of the emails may exceed 120 words.', 'No emails over 120 words.', 'Not for enterprise buyers.', 'None of these apply to trials.']) assert.ok(!FILLER.test(real), `real: ${real}`);
});

test('fenced code is never touched', () => {
  const src = '# T\n\n## Examples\n\n```\n* keep   \n<goal>x</goal>\n\n\n\n```\n';
  assert.equal(formatDoc(src), src);
  assert.equal(formatDoc(src, { family: 'claude' }), '# T\n\n<examples>\n\n```\n* keep   \n<goal>x</goal>\n\n\n\n```\n\n</examples>\n');
});

test('the formatter is idempotent in every mode', () => {
  const inputs = [MD, XML, GPT, '# T\n\n<goal>Ship it.</goal>\n\n* x\n', '# T\n\n## Goal\n\n<example>A</example>\n', '# T\n'];
  for (const src of inputs) {
    for (const family of [null, 'claude', 'gemini', 'gpt']) {
      const once = formatDoc(src, { family });
      assert.equal(formatDoc(once, { family }), once, `${family || 'merge'}: ${JSON.stringify(src)}`);
    }
  }
});
