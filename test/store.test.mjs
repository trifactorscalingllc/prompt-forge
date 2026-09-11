import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const store = require('../src/store.js');
const doc = require('../src/doc.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-store-'));

test('expandHome and slugify', () => {
  assert.equal(store.expandHome('~/x/y', '/h'), path.join('/h', 'x', 'y'));
  assert.equal(store.expandHome('~', '/h'), '/h');
  assert.equal(store.expandHome('/abs/p', '/h'), '/abs/p');
  assert.equal(store.slugify('My Prompt: v2!'), 'my-prompt-v2');
  assert.equal(store.slugify('   '), 'prompt');
  assert.equal(store.slugify('Ünïcode  Ideas'), 'unicode-ideas');
});

test('open creates the library folder; create writes the seed doc and a sidecar with one seed snapshot', () => {
  const dir = path.join(tmp(), 'lib');
  const s = store.open(dir);
  assert.ok(fs.existsSync(dir));
  const { slug, sidecar } = s.create('Keenan reel brief');
  assert.equal(slug, 'keenan-reel-brief');
  assert.equal(fs.readFileSync(s.docPath(slug), 'utf8'), doc.seed('Keenan reel brief'));
  assert.equal(sidecar.version, 1);
  assert.equal(sidecar.title, 'Keenan reel brief');
  assert.equal(sidecar.target, 'fable-5.1');
  assert.equal(sidecar.snapshots.length, 1);
  assert.equal(sidecar.snapshots[0].kind, 'seed');
  assert.equal(sidecar.snapshots[0].doc, doc.seed('Keenan reel brief'));
  assert.deepEqual(sidecar.entries, []);
  assert.deepEqual(sidecar.conflicts, []);
  assert.ok(!fs.existsSync(`${s.sidecarPath(slug)}.tmp`), 'atomic write leaves no temp file');
});

test('create with a colliding title gets a numbered slug; a custom target is kept', () => {
  const s = store.open(tmp());
  assert.equal(s.create('Same').slug, 'same');
  assert.equal(s.create('Same').slug, 'same-2');
  assert.equal(s.create('Same').slug, 'same-3');
  assert.equal(s.create('Other', { target: 'gpt-5' }).sidecar.target, 'gpt-5');
});

test('list shows every prompt with a sidecar, newest first, with counts; strays and corrupt files are skipped', () => {
  const s = store.open(tmp());
  const a = s.create('A').slug;
  const b = s.create('B').slug;
  s.appendEntry(b, 'idea one');
  s.appendEntry(b, 'idea two');
  s.setConflicts(b, [{ id: 'C1', section: 'Goal', existing: 'x', incoming: 'y' }], { entryId: 'e2' });
  fs.writeFileSync(path.join(s.dir, 'stray.md'), '# no sidecar\n');
  fs.writeFileSync(path.join(s.dir, 'broken.forge.json'), '{not json');
  const list = s.list();
  assert.deepEqual(list.map((p) => p.slug), [b, a]);
  assert.equal(list[0].entries, 2);
  assert.equal(list[0].openConflicts, 1);
  assert.equal(list[0].title, 'B');
});

test('appendEntry logs the idea as pending with sequential ids; updateEntry patches it', () => {
  const s = store.open(tmp());
  const { slug } = s.create('P');
  const e1 = s.appendEntry(slug, 'first');
  const e2 = s.appendEntry(slug, 'second');
  assert.equal(e1.id, 'e1');
  assert.equal(e2.id, 'e2');
  assert.equal(e1.status, 'pending');
  assert.ok(e1.ts > 0);
  const patched = s.updateEntry(slug, 'e1', { status: 'merged', snapshotId: 's2' });
  assert.equal(patched.status, 'merged');
  assert.equal(s.read(slug).entries[0].snapshotId, 's2');
  assert.equal(s.read(slug).entries[1].status, 'pending');
});

test('addSnapshot appends with sequential ids and bumps updatedAt; setTarget persists', () => {
  const s = store.open(tmp());
  const { slug, sidecar } = s.create('P');
  const before = sidecar.updatedAt;
  const snap = s.addSnapshot(slug, { kind: 'merge', entryIds: ['e1'], doc: '# P\n\nbody\n', conflicts: [], changes: ['x'], target: 'fable-5.1', call: { provider: 'claude', model: 'sonnet' } });
  assert.equal(snap.id, 's2');
  const after = s.read(slug);
  assert.equal(after.snapshots.length, 2);
  assert.ok(after.updatedAt >= before);
  assert.equal(after.snapshots[1].call.provider, 'claude');
  s.setTarget(slug, 'gpt-5');
  assert.equal(s.read(slug).target, 'gpt-5');
});

test('setConflicts keeps raisedAt for ids already open and stamps new ones; resolveConflict closes and records the choice', () => {
  const s = store.open(tmp());
  const { slug } = s.create('P');
  s.setConflicts(slug, [{ id: 'C1', section: 'Goal', existing: 'a', incoming: 'b' }], { entryId: 'e1' });
  const first = s.read(slug).conflicts[0];
  assert.ok(first.raisedAt > 0);
  assert.equal(first.entryId, 'e1');
  s.setConflicts(slug, [
    { id: 'C1', section: 'Goal', existing: 'a', incoming: 'b' },
    { id: 'C2', section: 'Goal', existing: 'c', incoming: 'd' },
  ], { entryId: 'e2' });
  const now = s.read(slug).conflicts;
  assert.equal(now[0].raisedAt, first.raisedAt, 'C1 keeps its original stamp');
  assert.equal(now[1].entryId, 'e2');
  s.resolveConflict(slug, 'C1', 'new');
  const after = s.read(slug);
  assert.deepEqual(after.conflicts.map((c) => c.id), ['C2']);
  assert.equal(after.resolved.length, 1);
  assert.equal(after.resolved[0].id, 'C1');
  assert.equal(after.resolved[0].keep, 'new');
});

test('remove moves both files into .trash and the prompt leaves the list', () => {
  const s = store.open(tmp());
  const { slug } = s.create('Gone');
  const moved = s.remove(slug);
  assert.equal(moved.length, 2);
  assert.ok(!fs.existsSync(s.docPath(slug)));
  assert.ok(!fs.existsSync(s.sidecarPath(slug)));
  for (const p of moved) assert.ok(p.startsWith(path.join(s.dir, '.trash')) && fs.existsSync(p));
  assert.deepEqual(s.list(), []);
});

test('read of a missing or corrupt sidecar is null, never a throw; readDoc mirrors that', () => {
  const s = store.open(tmp());
  assert.equal(s.read('nope'), null);
  assert.equal(s.readDoc('nope'), null);
  fs.writeFileSync(s.sidecarPath('bad'), '{');
  assert.equal(s.read('bad'), null);
});

test('writeDoc replaces the .md on disk', () => {
  const s = store.open(tmp());
  const { slug } = s.create('P');
  s.writeDoc(slug, '# P\n\nnew body\n');
  assert.equal(s.readDoc(slug), '# P\n\nnew body\n');
});

test('list parses a sidecar only when its file changed on disk', () => {
  const s = store.open(tmp());
  const { slug } = s.create('Cached');
  s.list();
  const before = s.stats().parsed;
  s.list();
  assert.equal(s.stats().parsed, before, 'unchanged sidecar served from the cache');
  s.appendEntry(slug, 'idea');
  s.list();
  assert.equal(s.stats().parsed, before + 1, 'a changed sidecar is re-read');
  assert.equal(s.list()[0].entries, 1);
});
