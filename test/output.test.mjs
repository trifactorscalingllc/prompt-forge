import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractJson, parseEngineOutput } = require('../src/engine/output.js');

const DOC = '# T\n\n## Goal\n\nA reasonably long goal statement so the shrink guard is not tripped.\n';
const good = { doc: DOC, conflicts: [], changes: ['added goal'] };

test('extractJson: bare, fenced, and prose-wrapped JSON all parse', () => {
  assert.deepEqual(extractJson(JSON.stringify(good)), good);
  assert.deepEqual(extractJson('```json\n' + JSON.stringify(good) + '\n```'), good);
  assert.deepEqual(extractJson('Here you go:\n' + JSON.stringify(good) + '\nDone.'), good);
});

test('extractJson: garbage is null, never a throw', () => {
  assert.equal(extractJson('not json at all'), null);
  assert.equal(extractJson(''), null);
  assert.equal(extractJson(null), null);
});

test('parseEngineOutput: a good merge result', () => {
  const r = parseEngineOutput(JSON.stringify(good), { kind: 'merge', inputDoc: DOC });
  assert.equal(r.ok, true);
  assert.equal(r.doc, DOC);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.changes, ['added goal']);
});

test('parseEngineOutput: non-JSON is an error object, not a throw', () => {
  const r = parseEngineOutput('sorry, cannot', { kind: 'merge', inputDoc: DOC });
  assert.equal(r.ok, false);
  assert.match(r.error, /JSON/i);
});

test('parseEngineOutput: conflicts get ids after the highest existing one, duplicates dropped, fields coerced', () => {
  const r = parseEngineOutput(JSON.stringify({
    doc: DOC,
    conflicts: [
      { id: 'C3', section: 'Goal', existing: 'a', incoming: 'b' },
      { section: 'Goal', existing: 'c', incoming: 'd' },
      { id: 'C3', section: 'Goal', existing: 'dup', incoming: 'dup' },
      { id: 7, existing: 1 },
    ],
    changes: 'not an array',
  }), { kind: 'merge', inputDoc: DOC });
  assert.equal(r.ok, true);
  assert.deepEqual(r.conflicts.map((c) => c.id), ['C3', 'C4', 'C5']);
  assert.deepEqual(r.conflicts[2], { id: 'C5', section: '', existing: '1', incoming: '' });
  assert.deepEqual(r.changes, []);
});

test('parseEngineOutput: strips \\r, normalises to one trailing newline, removes a stray Open conflicts section', () => {
  const r = parseEngineOutput(JSON.stringify({
    doc: '# T\r\n\r\n## Open conflicts\r\n\r\n- stray\r\n\r\n## Goal\r\n\r\nA reasonably long goal statement so the shrink guard is not tripped.\r\n\r\n\r\n',
  }), { kind: 'merge', inputDoc: DOC });
  assert.equal(r.ok, true);
  assert.equal(r.doc, DOC);
});

test('parseEngineOutput: a merge that returns a much shorter document is refused', () => {
  const r = parseEngineOutput(JSON.stringify({ doc: '# T\n' }), { kind: 'merge', inputDoc: DOC });
  assert.equal(r.ok, false);
  assert.match(r.error, /shorter/i);
});

test('parseEngineOutput: polish is not subject to the shrink guard', () => {
  const r = parseEngineOutput(JSON.stringify({ doc: '# T\n' }), { kind: 'polish', inputDoc: DOC });
  assert.equal(r.ok, true);
});

test('parseEngineOutput: an empty or missing doc is an error', () => {
  assert.equal(parseEngineOutput(JSON.stringify({ doc: '' }), { kind: 'polish', inputDoc: DOC }).ok, false);
  assert.equal(parseEngineOutput(JSON.stringify({ conflicts: [] }), { kind: 'polish', inputDoc: DOC }).ok, false);
});
