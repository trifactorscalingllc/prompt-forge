import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sg = require('../src/suggest.js');
const { parseEngineOutput } = require('../src/engine/output.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('examples written into the advice become options to tick', () => {
  assert.deepEqual(sg.exampleOptions('Name the formats you accept, e.g. CSV, JSON or XML.'), ['CSV', 'JSON', 'XML']);
  assert.deepEqual(sg.exampleOptions('List the providers checkout takes, such as Stripe, PayPal, and Apple Pay'), ['Stripe', 'PayPal', 'Apple Pay']);
  assert.deepEqual(sg.exampleOptions('Say who reads it (founders, engineers, customers).'), ['founders', 'engineers', 'customers']);
  assert.deepEqual(sg.exampleOptions('Pick the tone, for example "formal" or "friendly", etc.'), ['formal', 'friendly']);
  assert.deepEqual(sg.exampleOptions('Say who reads it.'), [], 'no examples, no options');
  assert.deepEqual(sg.exampleOptions('State the rule, such as when the user is logged in and has already paid for the order'), [], 'a clause of prose is not a list of choices');
  assert.deepEqual(sg.exampleOptions('Name the file format, e.g. CSV.'), [], 'one example is not a choice');
});

test('engine options are short, distinct, two to six of them, or none', () => {
  assert.deepEqual(sg.cleanOptions(['CSV', ' csv ', 'JSON', '', 'x'.repeat(61), { label: 'XML' }]), ['CSV', 'JSON', 'XML']);
  assert.equal(sg.cleanOptions(['a', 'b', 'c', 'd', 'e', 'f', 'g']).length, 6);
  assert.deepEqual(sg.cleanOptions(['only one']), []);
  assert.deepEqual(sg.cleanOptions('CSV, JSON'), [], 'a string is not a list');
});

test('the parser keeps the engine\'s options, falls back to the examples in the text, and adds no key when there are none', () => {
  const reply = JSON.stringify({
    doc: '# T\n\n## Goal\n\nx\n',
    suggestions: [
      { section: 'Requirements', kind: 'action', text: 'Name the formats you accept.', options: ['CSV', 'JSON', 'XML'] },
      { section: 'Output format', kind: 'action', text: 'Say how long it runs, e.g. 30 seconds or 60 seconds.' },
      { section: 'Context', kind: 'info', text: 'Say who reads it.' },
    ],
  });
  const out = parseEngineOutput(reply, { kind: 'merge', inputDoc: '# T\n\n## Goal\n\nx\n' });
  assert.deepEqual(out.suggestions[0].options, ['CSV', 'JSON', 'XML']);
  assert.deepEqual(out.suggestions[1].options, ['30 seconds', '60 seconds']);
  assert.ok(!('options' in out.suggestions[2]));
});

test('ticks count only where they are offered, and become one idea naming the suggestion they answer', () => {
  assert.deepEqual(sg.picksFrom(['CSV', 'JSON', 'XML'], ['XML', 'CSV', 'YAML', 'CSV']), ['CSV', 'XML'], 'offered order, nothing invented');
  assert.deepEqual(sg.picksFrom(undefined, ['CSV']), []);
  assert.equal(
    sg.clarificationIdea({ section: 'Requirements', text: 'Name the formats you accept, e.g. CSV, JSON or XML.', picks: ['CSV', 'JSON'] }),
    'Requirements: CSV and JSON. This answers the suggestion "Name the formats you accept, e.g. CSV, JSON or XML."',
  );
  assert.equal(sg.clarificationIdea({ section: '', text: '', picks: ['A', 'B', 'C'] }), 'Requirements: A, B and C.');
});

test('the panel draws the options as buttons, and the extension handles the answer, shared library included', () => {
  const panel = fs.readFileSync(path.join(ROOT, 'media/panel.js'), 'utf8');
  assert.ok(/function suggestionChoices/.test(panel));
  assert.ok(/el\('button', 'sg-opt', opt\)/.test(panel) && /aria-pressed/.test(panel), 'each option is a toggle button');
  assert.ok(/type: 'suggestion\.apply', text: sg\.text, picks/.test(panel));
  const runtime = fs.readFileSync(path.join(ROOT, 'src/runtime.js'), 'utf8');
  assert.equal((runtime.match(/case 'suggestion\.apply'/g) || []).length, 2, 'in this window and in a joined library');
  assert.ok(/suggestMod\.picksFrom\(sg\.options, m\.picks\)/.test(runtime), 'the ticks are checked against what was offered');
  const css = fs.readFileSync(path.join(ROOT, 'media/panel.css'), 'utf8');
  assert.ok(/\.sg-opt\[aria-pressed="true"\]/.test(css));
});
