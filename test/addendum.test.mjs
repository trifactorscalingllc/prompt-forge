import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildAddendum, sections, key } = require('../src/addendum.js');

const V1 = `# Deligator

## Goal

Ship a VS Code extension with a boss agent.

## Requirements

- The extension must provide a boss agent.
- The boss must delegate to subagents.
`;

test('nothing copied-to-now means nothing to say', () => {
  const a = buildAddendum(V1, V1);
  assert.equal(a.text, '');
  assert.equal(a.added, 0);
  assert.equal(a.removed, 0);
});

test('an addendum carries the change, not the prompt again', () => {
  const v2 = V1.replace('- The boss must delegate to subagents.\n', '- The boss must delegate to subagents.\n- Token usage must be visible per subagent.\n');
  const a = buildAddendum(V1, v2);
  assert.equal(a.added, 1);
  assert.ok(a.text.includes('- Token usage must be visible per subagent.'));
  // The model already has the prompt; sending it a second time is the thing this avoids.
  assert.ok(!a.text.includes('Ship a VS Code extension'), 'unchanged sections are left out');
  assert.ok(!a.text.includes('- The boss must delegate to subagents.'), 'unchanged lines are left out');
  assert.ok(a.text.includes('## Requirements'), 'but the section it lands in is named');
  assert.ok(/Continuing the prompt I sent earlier/.test(a.text), 'it reads as the next message, not a new prompt');
});

test('a new section arrives whole', () => {
  const v2 = `${V1}\n## Constraints\n\n- No telemetry.\n- Must work offline.\n`;
  const a = buildAddendum(V1, v2);
  assert.equal(a.added, 2);
  assert.ok(a.text.includes('## Constraints'));
  assert.ok(a.text.includes('- No telemetry.') && a.text.includes('- Must work offline.'));
});

test('a removal is reported, because a follow-up that only adds would be wrong', () => {
  const v2 = V1.replace('- The boss must delegate to subagents.\n', '');
  const a = buildAddendum(V1, v2);
  assert.equal(a.removed, 1);
  assert.equal(a.added, 0);
  assert.ok(/No longer applies:/.test(a.text));
  assert.ok(a.text.includes('The boss must delegate to subagents.'));
});

test('a whole section disappearing is reported too', () => {
  const a = buildAddendum(V1, '# Deligator\n\n## Goal\n\nShip a VS Code extension with a boss agent.\n');
  assert.equal(a.removed, 2);
  assert.ok(/No longer applies:/.test(a.text));
});

test('a line that only moved is not reported as new', () => {
  const moved = `# Deligator

## Goal

Ship a VS Code extension with a boss agent.

## Requirements

- The boss must delegate to subagents.
- The extension must provide a boss agent.
`;
  const a = buildAddendum(V1, moved);
  assert.equal(a.text, '', 'reordering is not a change worth a follow-up message');
});

test('headings are matched across a restyle, so a polish does not fake a rewrite', () => {
  assert.equal(key('## Open questions'), key('<open_questions>'));
  assert.equal(key('## Goal'), key('<goal>'));
  assert.notEqual(key('## Goal'), key('# Task'), 'a genuine rename is a genuine difference');

  const claude = '# D\n\n<requirements>\n\n- One.\n\n</requirements>\n';
  const md = '# D\n\n## Requirements\n\n- One.\n- Two.\n';
  const a = buildAddendum(claude, md);
  assert.equal(a.added, 1, 'only the real addition');
  assert.ok(a.text.includes('- Two.') && !a.text.includes('- One.'));
});

test('a restyle of the whole prompt says so instead of pretending to be an addendum', () => {
  const rewritten = `# Deligator

<goal>
Ship a VS Code extension that fronts a boss agent for delegated work.
</goal>

<requirements>
Provide a boss agent as the primary interface.
Delegate to subagents that carry out the work.
</requirements>
`;
  const a = buildAddendum(V1, rewritten);
  assert.equal(a.restyled, true, 'most of the document moved; an add-on would be the prompt again');
  assert.ok(a.text, 'it still produces something, so the choice stays the user’s');
  assert.equal(buildAddendum(V1, V1.replace('boss agent.', 'boss agent, please.')).restyled, false);
});

test('sections split on markdown headings and on block-level tags', () => {
  const got = sections('# T\n\n## Goal\n\na\n\n<constraints>\n\nb\n\n</constraints>\n');
  assert.deepEqual(got.map((s) => s.heading), ['# T', '## Goal', '<constraints>']);
  assert.deepEqual(got[1].lines, ['a']);
  // The closing tag is structure. Kept, it would be reported as a line the person added.
  assert.deepEqual(got[2].lines, ['b']);
});

test('an empty or missing document is not a crash', () => {
  assert.equal(buildAddendum('', '').text, '');
  assert.equal(buildAddendum(null, undefined).text, '');
  assert.ok(buildAddendum('', '# T\n\n## Goal\n\nx\n').text.includes('x'));
});
