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

test('an answer given while a merge runs survives that merge rewriting the list, closes stamped when it was given, and can be taken back', () => {
  const s = store.open(tmp());
  const { slug } = s.create('P');
  s.setConflicts(slug, [{ id: 'C1', section: 'Goal', existing: 'a', incoming: 'b' }]);
  s.answerConflict(slug, 'C1', 'new', { by: { name: 'sam', machine: 'LAPTOP' } });
  assert.equal(s.list()[0].openConflicts, 0, 'an answered conflict is not counted as open');
  s.setConflicts(slug, [{ id: 'C1', section: 'Goal', existing: 'a', incoming: 'b' }, { id: 'C2', section: 'Goal', existing: 'c', incoming: 'd' }]);
  const c1 = s.read(slug).conflicts[0];
  assert.equal(c1.answer, 'new');
  assert.deepEqual(c1.answeredBy, { name: 'sam', machine: 'LAPTOP' });
  s.resolveConflict(slug, 'C1', 'new');
  const r = s.read(slug).resolved[0];
  assert.equal(r.ts, c1.answeredAt);
  assert.deepEqual(r.who, { name: 'sam', machine: 'LAPTOP' });
  s.answerConflict(slug, 'C2', 'old');
  s.unanswerConflicts(slug, ['C2']);
  assert.equal(s.read(slug).conflicts[0].answer, undefined);
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

test('an image is written beside the prompt, and only its path goes in the sidecar', () => {
  const fsn = require('node:fs');
  const osn = require('node:os');
  const pathn = require('node:path');
  const dir = fsn.mkdtempSync(pathn.join(osn.tmpdir(), 'forge-img-'));
  const s = store.open(dir);
  const { slug } = s.create('Shot');

  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');
  const img = s.saveImage(slug, { data: png, ext: 'png', name: 'screen.png' });
  assert.ok(img && img.id && img.bytes === 16);
  assert.ok(fsn.existsSync(img.path), 'the bytes are on disk');
  assert.ok(img.path.includes(`${slug}.images`), 'beside the prompt, in its own folder');

  s.appendEntry(slug, 'like this', [img]);
  const raw = fsn.readFileSync(s.sidecarPath(slug), 'utf8');
  assert.ok(!raw.includes(png), 'the bytes are not in the sidecar: it is rewritten constantly');
  // Nor is the absolute path. A library synced to another machine carries this same JSON to a
  // different home and a different library root, and an absolute path would be wrong on arrival.
  assert.ok(!raw.includes(dir), 'no absolute path is stored');
  assert.ok(raw.includes(img.file), 'just the filename');
  // read() rebuilds it against wherever the library actually is now.
  assert.equal(s.read(slug).entries[0].images[0].path, img.path);
  assert.equal(s.read(slug).entries[0].images[0].file, img.file);

  // Deleting the prompt takes its screenshots, or the library keeps files nothing points at.
  s.remove(slug);
  assert.ok(!fsn.existsSync(pathn.join(dir, `${slug}.images`)));
  assert.ok(fsn.readdirSync(pathn.join(dir, '.trash')).some((f) => f.endsWith('.images')));

  assert.equal(s.saveImage(slug, { data: '' }), null, 'empty data is not a file');
  fsn.rmSync(dir, { recursive: true, force: true });
});

test('old version bodies are dropped but their record survives, and restore refuses rather than emptying the document', () => {
  const fsn = require('node:fs');
  const osn = require('node:os');
  const pathn = require('node:path');
  const dir = fsn.mkdtempSync(pathn.join(osn.tmpdir(), 'forge-prune-'));
  const s = store.open(dir);
  const { slug } = s.create('Long');

  for (let i = 0; i < 8; i += 1) {
    // The body text is deliberately distinct from anything in the diff or the changes, so the
    // assertion below can tell "the body was dropped" from "the record mentions it".
    s.addSnapshot(slug, { kind: 'merge', doc: `# Long\n\nBODY${i}\n`, changes: [`change ${i}`], diff: [{ heading: '## Goal', added: [`added line ${i}`], removed: [] }] }, { keepBodies: 3 });
  }
  const snaps = s.read(slug).snapshots;
  const withBody = snaps.filter((x) => typeof x.doc === 'string');
  assert.equal(withBody.length, 3, 'only the newest keep their text');
  assert.equal(snaps.length, 9, 'nine records: the seed and eight merges, none of them lost');
  assert.equal(snaps[snaps.length - 1].doc, '# Long\n\nBODY7\n', 'and the newest is never pruned');

  // The history still reads: when, what kind, what changed, and the diff.
  // snaps[0] is the seed the prompt was created with, so the oldest merge is snaps[1].
  const old = snaps[1];
  assert.equal(old.kind, 'merge');
  assert.equal(old.bodyDropped, true);
  assert.ok(old.ts && old.changes.length && old.diff.length, 'the record survives the body');

  const raw = fsn.readFileSync(s.sidecarPath(slug), 'utf8');
  assert.ok(!raw.includes('BODY0'), 'the dropped body really is gone from disk');
  assert.ok(raw.includes('change 0') && raw.includes('added line 0'), 'its summary and diff are not');
  assert.ok(raw.includes('BODY7'), 'and the recent bodies are still there');

  // 0 means keep everything, for anyone who would rather have the disk than the guarantee.
  const { slug: s2 } = s.create('Keep');
  for (let i = 0; i < 5; i += 1) s.addSnapshot(s2, { kind: 'merge', doc: `d${i}`, changes: [] }, { keepBodies: 0 });
  assert.ok(s.read(s2).snapshots.every((x) => typeof x.doc === 'string'));
  fsn.rmSync(dir, { recursive: true, force: true });
});

test('a project path is stored portably, so the same library opens on another machine', () => {
  const fsn = require('node:fs');
  const osn = require('node:os');
  const pathn = require('node:path');
  const dir = fsn.mkdtempSync(pathn.join(osn.tmpdir(), 'forge-port-'));
  const s = store.open(dir);
  const { slug } = s.create('P');

  const under = pathn.join(osn.homedir(), 'some-project');
  s.setProjects(slug, [{ id: 'p1', label: 'some-project', path: under, brief: 'x', files: [] }]);
  const raw = fsn.readFileSync(s.sidecarPath(slug), 'utf8');
  assert.ok(raw.includes(`~${pathn.sep === '\\' ? '\\\\' : '/'}some-project`), 'recorded relative to home');

  assert.equal(s.portablePath(pathn.join(osn.homedir(), 'a', 'b')), `~${pathn.sep}a${pathn.sep}b`);
  assert.equal(s.portablePath('/opt/elsewhere'), '/opt/elsewhere', 'outside home it stays absolute, because it has to');
  assert.equal(s.resolvePortable(`~${pathn.sep}a`), pathn.join(osn.homedir(), 'a'));
  fsn.rmSync(dir, { recursive: true, force: true });
});

test('advice is added to what is already there, never replaced, and a dismissal is what removes it', () => {
  const s = store.open(path.join(tmp(), 'lib'));
  const { slug } = s.create('Advice');
  s.addSuggestions(slug, [{ section: 'Goal', text: 'Say who reads it.' }, { section: 'Requirements', text: 'Name the formats.' }]);
  s.addSuggestions(slug, [{ section: 'Goal', text: '  say WHO reads it!  ' }, { section: 'Output format', text: 'Say what it returns.' }]);
  assert.deepEqual(s.read(slug).suggestions.map((x) => x.text), ['Say who reads it.', 'Name the formats.', 'Say what it returns.'], 'the same advice reworded is one card, in the order it first arrived');
  assert.ok(s.read(slug).suggestions.every((x) => x.ts > 0));

  s.dismissSuggestion(slug, 'name the formats');
  assert.deepEqual(s.read(slug).suggestions.map((x) => x.text), ['Say who reads it.', 'Say what it returns.'], 'dismissed by what it says, not by exact characters');
  s.addSuggestions(slug, [{ section: 'Requirements', text: 'Name the formats.' }]);
  assert.equal(s.read(slug).suggestions.length, 2, 'a dismissed one never comes back');

  // Only an explicit clear empties them, and a prompt that collects too many drops its oldest.
  s.setSuggestions(slug, [{ section: 'Goal', text: 'Fresh advice for the new target.' }]);
  assert.deepEqual(s.read(slug).suggestions.map((x) => x.text), ['Fresh advice for the new target.']);
  for (let n = 0; n < 60; n++) s.addSuggestions(slug, [{ section: 'Goal', text: `advice ${n}` }]);
  const kept = s.read(slug).suggestions;
  assert.equal(kept.length, 40);
  assert.equal(kept[kept.length - 1].text, 'advice 59');

  s.addIdeas(slug, [{ text: 'Add a launch checklist.' }]);
  s.addIdeas(slug, [{ text: 'Add a launch checklist.' }, { text: 'Add a rollback plan.' }]);
  assert.deepEqual(s.read(slug).ideas.map((x) => x.text), ['Add a launch checklist.', 'Add a rollback plan.']);
  s.dismissIdea(slug, 'Add a launch checklist.');
  assert.deepEqual(s.read(slug).ideas.map((x) => x.text), ['Add a rollback plan.']);
});
