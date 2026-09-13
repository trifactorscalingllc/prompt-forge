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

test('parseEngineOutput: edits are applied to the input document, and only the named section moves', () => {
  const input = '# T\n\n## Goal\n\nA reasonably long goal statement so the shrink guard is not tripped.\n\n## Requirements\n\n- one\n';
  const r = parseEngineOutput(JSON.stringify({ edits: [{ section: 'Requirements', op: 'append', text: '- two' }], conflicts: [], changes: ['added two'] }), { kind: 'merge', inputDoc: input });
  assert.equal(r.ok, true);
  assert.equal(r.edited, true);
  assert.equal(r.doc, `${input}- two\n`);
  assert.deepEqual(r.changes, ['added two']);
});

test('parseEngineOutput: edits that cannot be placed fail with a request for the whole document', () => {
  const input = '# T\n\n## Notes\n\na\n\n## Notes\n\nb\n';
  const r = parseEngineOutput(JSON.stringify({ edits: [{ section: 'Notes', op: 'append', text: 'c' }] }), { kind: 'merge', inputDoc: input });
  assert.equal(r.ok, false);
  assert.equal(r.retryWithDocument, true);
  const none = parseEngineOutput(JSON.stringify({ edits: [] }), { kind: 'merge', inputDoc: DOC });
  assert.equal(none.ok, true, 'no edits is a real answer');
  assert.equal(none.doc, DOC);
});

test('parseEngineOutput: an empty or missing doc is an error', () => {
  assert.equal(parseEngineOutput(JSON.stringify({ doc: '' }), { kind: 'polish', inputDoc: DOC }).ok, false);
  assert.equal(parseEngineOutput(JSON.stringify({ conflicts: [] }), { kind: 'polish', inputDoc: DOC }).ok, false);
});
