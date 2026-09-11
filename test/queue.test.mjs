import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createQueue, nextBatch } = require('../src/queue.js');
const tick = () => new Promise((r) => setImmediate(r));

test('nextBatch folds a leading run of ideas and resolutions into ONE merge', () => {
  const ops = [
    { kind: 'idea', entryId: 'e1' },
    { kind: 'resolve', conflictId: 'C1', keep: 'new' },
    { kind: 'idea', entryId: 'e2' },
    { kind: 'polish' },
    { kind: 'idea', entryId: 'e3' },
  ];
  const { batch, rest } = nextBatch(ops);
  assert.deepEqual(batch, { kind: 'merge', entryIds: ['e1', 'e2'], resolutions: [{ conflictId: 'C1', keep: 'new' }] });
  assert.deepEqual(rest, [{ kind: 'polish' }, { kind: 'idea', entryId: 'e3' }]);
});

test('nextBatch collapses consecutive polish ops into one and keeps the last payload', () => {
  const { batch, rest } = nextBatch([{ kind: 'polish', target: 'a' }, { kind: 'polish', target: 'b' }, { kind: 'idea', entryId: 'e1' }]);
  assert.deepEqual(batch, { kind: 'polish', target: 'b' });
  assert.deepEqual(rest, [{ kind: 'idea', entryId: 'e1' }]);
});

test('nextBatch on an empty list returns no batch', () => {
  assert.deepEqual(nextBatch([]), { batch: null, rest: [] });
});

test('createQueue runs one batch at a time; ops pushed while busy become the next single batch', async () => {
  const runs = [];
  const releases = [];
  const q = createQueue({ run: async (b) => { runs.push(b); await new Promise((r) => releases.push(r)); } });

  q.push({ kind: 'idea', entryId: 'e1' });
  await tick();
  assert.equal(q.busy(), true);
  assert.equal(runs.length, 1);

  q.push({ kind: 'idea', entryId: 'e2' });
  q.push({ kind: 'idea', entryId: 'e3' });
  assert.equal(q.size(), 2, 'two ops waiting behind the in-flight batch');
  assert.equal(runs.length, 1, 'nothing started while busy');

  releases[0]();
  await tick(); await tick();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1].entryIds, ['e2', 'e3']);
  assert.equal(q.size(), 0);

  releases[1]();
  await tick(); await tick();
  assert.equal(q.busy(), false);
});

test('a run that throws is reported and does not stop the next batch', async () => {
  const errors = [];
  const runs = [];
  const q = createQueue({
    run: async (b) => { runs.push(b); if (runs.length === 1) throw new Error('boom'); },
    onError: (e) => errors.push(e.message),
  });
  q.push({ kind: 'idea', entryId: 'e1' });
  q.push({ kind: 'polish' });
  await tick(); await tick(); await tick();
  assert.deepEqual(errors, ['boom']);
  assert.equal(runs.length, 2);
  assert.equal(q.busy(), false);
});

test('onChange fires when work starts and when it settles', async () => {
  const seen = [];
  const q = createQueue({ run: async () => {}, onChange: () => seen.push([q.busy(), q.size()]) });
  q.push({ kind: 'idea', entryId: 'e1' });
  await tick(); await tick();
  assert.ok(seen.some(([busy]) => busy === true), 'a busy notification');
  assert.deepEqual(seen[seen.length - 1], [false, 0], 'ends idle and empty');
});
