import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeSidecars, createSync } = require('../src/sync.js');
const { runCli } = require('../src/providers/spawn.js');
const storeMod = require('../src/store.js');

const side = (over) => ({ version: 1, slug: 'p', title: 'P', target: 'fable-5.1', updatedAt: 0, entries: [], snapshots: [], conflicts: [], resolved: [], ...over });

test('mergeSidecars: both machines\' ideas survive, colliding ids are renumbered on the incoming side, and links follow', () => {
  const base = { id: 's1', ts: 1, kind: 'seed', doc: '# P\n' };
  const ours = side({
    updatedAt: 10,
    entries: [{ id: 'e1', ts: 5, text: 'from here', status: 'merged', snapshotId: 's2' }],
    snapshots: [base, { id: 's2', ts: 6, kind: 'merge', entryIds: ['e1'], doc: '# P\n\nhere\n' }],
  });
  const theirs = side({
    updatedAt: 20,
    entries: [{ id: 'e1', ts: 7, text: 'from there', status: 'merged', snapshotId: 's2' }],
    snapshots: [base, { id: 's2', ts: 8, kind: 'merge', entryIds: ['e1'], doc: '# P\n\nthere\n' }],
  });
  const { sidecar, doc } = mergeSidecars(ours, theirs, { oursDoc: '# P\n\nhere\n', theirsDoc: '# P\n\nthere\n' });
  assert.deepEqual(sidecar.entries.map((e) => [e.id, e.text]), [['e1', 'from here'], ['e2', 'from there']]);
  const theirEntry = sidecar.entries.find((e) => e.text === 'from there');
  const theirSnap = sidecar.snapshots.find((s) => s.id === theirEntry.snapshotId);
  assert.equal(theirSnap.doc, '# P\n\nthere\n', 'the renumbered idea still points at its own version');
  assert.deepEqual(theirSnap.entryIds, ['e2']);
  assert.equal(new Set(sidecar.snapshots.map((s) => s.id)).size, sidecar.snapshots.length, 'no duplicate version ids');
  assert.equal(doc, '# P\n\nthere\n', 'the document follows the side that changed last');
  assert.ok(sidecar.snapshots.some((s) => s.kind === 'sync' && s.doc === '# P\n\nhere\n'), 'and the other side\'s text is kept as a version');
});

test('mergeSidecars: a conflict answered on either machine stays closed', () => {
  const c = { id: 'C1', section: 'Goal', existing: 'a', incoming: 'b' };
  const ours = side({ updatedAt: 1, conflicts: [c] });
  const theirs = side({ updatedAt: 2, conflicts: [], resolved: [{ id: 'C1', keep: 'new', ts: 3, existing: 'a', incoming: 'b' }] });
  const { sidecar } = mergeSidecars(ours, theirs);
  assert.deepEqual(sidecar.conflicts, []);
  assert.equal(sidecar.resolved.length, 1);
});

const hasGit = spawnSync('git', ['--version']).status === 0;

test('two different prompts with the same name on two machines are both kept', { skip: !hasGit && 'git is not installed' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sync-same-'));
  const bare = path.join(root, 'remote.git');
  spawnSync('git', ['init', '--bare', bare]);
  const A = storeMod.open(path.join(root, 'a'));
  const B = storeMod.open(path.join(root, 'b'));
  A.create('Untitled');
  await new Promise((r) => setTimeout(r, 5));
  B.create('Untitled');
  A.appendEntry('untitled', 'laptop prompt');
  B.appendEntry('untitled', 'mini prompt');
  assert.equal((await createSync({ dir: A.dir, runCli, hostName: 'laptop' }).setup(bare)).ok, true);
  const b = await createSync({ dir: B.dir, runCli, hostName: 'mini' }).setup(bare);
  assert.equal(b.ok, true, b.error);
  const texts = B.list().map((p) => B.read(p.slug).entries.map((e) => e.text).join()).sort();
  assert.deepEqual(texts, ['laptop prompt', 'mini prompt'], 'neither prompt swallowed the other');
  fs.rmSync(root, { recursive: true, force: true });
});

test('two libraries sync through a remote and merge edits to the same prompt', { skip: !hasGit && 'git is not installed' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-sync-'));
  const bare = path.join(root, 'remote.git');
  spawnSync('git', ['init', '--bare', bare]);
  const libA = path.join(root, 'a');
  const libB = path.join(root, 'b');
  const A = storeMod.open(libA);
  const B = storeMod.open(libB);
  const syncA = createSync({ dir: libA, runCli, hostName: 'laptop' });
  const syncB = createSync({ dir: libB, runCli, hostName: 'mini' });

  const { slug } = A.create('Shared');
  const a1 = await syncA.setup(bare);
  assert.equal(a1.ok, true, a1.error);
  assert.equal(a1.pushed, true);

  const b1 = await syncB.setup(bare);
  assert.equal(b1.ok, true, b1.error);
  assert.ok(B.exists(slug), 'the prompt arrived on the other machine');

  A.appendEntry(slug, 'idea on the laptop');
  await new Promise((r) => setTimeout(r, 5));
  B.appendEntry(slug, 'idea on the mini');
  const a2 = await syncA.syncNow();
  assert.equal(a2.ok, true, a2.error);
  const b2 = await syncB.syncNow();
  assert.equal(b2.ok, true, b2.error);
  assert.ok(b2.merged.some((p) => p.endsWith('.forge.json')), 'the sidecar was merged structurally, not picked');
  const a3 = await syncA.syncNow();
  assert.equal(a3.ok, true, a3.error);

  for (const s of [A, B]) {
    const entries = s.read(slug).entries;
    assert.deepEqual(entries.map((e) => e.text).sort(), ['idea on the laptop', 'idea on the mini']);
    assert.equal(new Set(entries.map((e) => e.id)).size, 2, 'ids unique after the merge');
  }
  fs.rmSync(root, { recursive: true, force: true });
});
