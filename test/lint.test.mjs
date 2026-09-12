import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { lintPrompt } = require('../src/lint.js');

const FULL = `# T

## Goal

Ship the thing.

## Requirements

- One requirement.

## Output format

Markdown, under 500 words.
`;

test('a complete prompt is quiet', () => {
  assert.deepEqual(lintPrompt(FULL), []);
});

test('an empty section is named, and the ones that matter are a warning', () => {
  const thin = `${FULL}\n## Examples\n\n## Constraints\n`;
  const soft = lintPrompt(thin);
  assert.equal(soft.length, 1);
  assert.equal(soft[0].level, 'note', 'an empty Examples is a nudge, not a problem');
  assert.ok(soft[0].text.includes('Examples') && soft[0].text.includes('Constraints'));

  // An empty Output format is different in kind: the model has to invent the shape of its answer.
  const hard = lintPrompt('# T\n\n## Goal\n\nx\n\n## Output format\n');
  assert.equal(hard[0].level, 'warn');
  assert.ok(/the model has to invent a shape/.test(hard[0].text));
});

test('open conflicts are the first thing said, because the prompt is self-contradictory', () => {
  const got = lintPrompt(FULL, { conflicts: [{ id: 'C1' }, { id: 'C2' }] });
  assert.equal(got[0].level, 'warn');
  assert.ok(/2 open conflicts/.test(got[0].text));
});

test('a placeholder left in the text is caught and quoted back', () => {
  for (const ph of ['TBD', 'TODO', 'FIXME', '???', '<insert name>', '[your audience here]', '[Language and framework]']) {
    const got = lintPrompt(FULL.replace('Ship the thing.', `Ship the thing. ${ph}`));
    assert.ok(got.some((f) => f.level === 'warn' && f.text.includes(ph.slice(0, 4))), `${ph} is caught`);
  }
  // Real words that merely contain a flagged substring must not trip it.
  assert.deepEqual(lintPrompt(FULL.replace('Ship the thing.', 'Ship the todos list and the fixtures.')), []);
  // Nor a markdown link, nor a footnote marker: both are bracketed and neither is a slot.
  assert.deepEqual(lintPrompt(FULL.replace('Ship the thing.', 'Ship it, see [the spec](https://x.test/s).')), []);
  assert.deepEqual(lintPrompt(FULL.replace('Ship the thing.', 'Ship it, per the RFC [1].')), []);
});

test('a missing output format is a note, and a short but finished prompt is silent', () => {
  const noFormat = lintPrompt('# T\n\n## Goal\n\nRewrite the billing docs.\n');
  assert.equal(noFormat.length, 1);
  assert.equal(noFormat[0].level, 'note');
  assert.ok(/shape of the answer is up to the model/.test(noFormat[0].text));

  // Length is a choice, not a defect. A lint that fires on a correct prompt teaches people to
  // ignore the lint, which costs more than the one it would have caught.
  assert.deepEqual(lintPrompt('# T\n\n## Goal\n\nDo it.\n\n## Output format\n\nJSON.\n'), []);
});

test('an empty or title-only document does not produce noise about sections it has none of', () => {
  assert.deepEqual(lintPrompt(''), []);
  assert.deepEqual(lintPrompt(null), []);
  assert.ok(!lintPrompt('# Just a title\n').some((f) => /output format/i.test(f.text)), 'no sections at all is not a missing-section problem');
});
