import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const store = require('../src/store.js');
const docm = require('../src/doc.js');
const { createSession } = require('../src/session.js');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const docOf = (prompt) => /<document>\n([\s\S]*?)<\/document>/.exec(prompt)[1];

/** An engine that merges by appending a line under Goal, or fails, per `impl`. */
const mergeReply = (req, line, conflicts = []) => {
  const doc = docOf(req.prompt);
  return {
    text: JSON.stringify({ doc: doc.includes('## Goal\n') ? doc.replace('## Goal\n', `## Goal\n\n${line}\n`) : `${doc}\n## Goal\n\n${line}\n`, conflicts, changes: [line] }),
    usage: { input: 10, output: 2 }, error: null,
    call: { provider: 'fake', mode: 'cli', model: req.role === 'polish' ? 'best' : 'fast', role: req.role, ms: 1, usage: { input: 10, output: 2 } },
  };
};
const echoReply = (req) => ({
  text: JSON.stringify({ doc: docOf(req.prompt), conflicts: [], changes: [] }),
  usage: { input: 1, output: 1 }, error: null,
  call: { provider: 'fake', mode: 'cli', model: 'best', role: req.role, ms: 1, usage: { input: 1, output: 1 } },
});

function setup(impl, { title = 'T', caps = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-session-'));
  const s = store.open(dir);
  const { slug } = s.create(title);
  const docs = new Map();
  const docio = {
    readDoc: async (p) => (docs.has(p) ? docs.get(p) : fs.readFileSync(p, 'utf8')),
    writeDoc: async (p, t) => { docs.set(p, t); fs.writeFileSync(p, t); },
    isOpen: () => false,
  };
  const calls = [];
  const engine = { call: async (req) => { calls.push({ ...req, sidecarAtCall: s.read(slug) }); return impl(req, calls.length); }, ...(caps ? { capabilities: () => caps } : {}) };
  const published = [];
  const session = createSession({
    slug, store: s, docio, engine, log: silent,
    cfg: () => ({ engine: { timeoutSeconds: 5, recentEntries: 12 } }),
    settleMs: 0,
    publish: (why) => published.push(why),
  });
  return { s, slug, docs, docio, calls, session, published, docPath: s.docPath(slug) };
}

test('an idea is on disk as pending before the engine is called, then merged with a snapshot and call meta', async () => {
  const { s, slug, session, calls, docio, docPath } = setup((req) => mergeReply(req, 'Ship by Friday.'));
  await session.load();
  session.submitIdea('ship by friday');
  await session.idle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, 'merge');
  assert.equal(calls[0].sidecarAtCall.entries[0].status, 'pending', 'logged before the call');
  assert.ok(calls[0].prompt.includes('1. ship by friday'));
  const sc = s.read(slug);
  assert.equal(sc.entries[0].status, 'merged');
  assert.equal(sc.entries[0].snapshotId, 's2');
  assert.equal(sc.snapshots[1].kind, 'merge');
  assert.deepEqual(sc.snapshots[1].entryIds, ['e1']);
  assert.equal(sc.snapshots[1].call.provider, 'fake');
  assert.ok((await docio.readDoc(docPath)).includes('Ship by Friday.'));
  assert.equal(session.snapshot().engine.state, 'idle');
});

test('ideas submitted while a merge is running become ONE follow-up merge', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { session, calls } = setup(async (req, n) => { if (n === 1) await gate; return mergeReply(req, `line ${n}`); });
  await session.load();
  session.submitIdea('a');
  await new Promise((r) => setImmediate(r));
  session.submitIdea('b');
  session.submitIdea('c');
  assert.equal(session.snapshot().engine.queued, 2);
  release();
  await session.idle();
  assert.equal(calls.length, 2);
  assert.ok(calls[1].prompt.includes('1. b') && calls[1].prompt.includes('2. c'));
  assert.equal(session.snapshot().engine.queued, 0);
});

test('an engine failure marks the entry failed with the error, leaves the doc alone, and retry recovers it', async () => {
  const { s, slug, session, docPath, docio } = setup((req, n) => (n === 1
    ? { text: '', usage: null, error: 'claude: not logged in', call: { provider: 'fake', mode: 'cli', model: 'fast', role: 'merge', ms: 1 } }
    : mergeReply(req, 'Recovered.')));
  await session.load();
  session.submitIdea('x');
  await session.idle();
  let sc = s.read(slug);
  assert.equal(sc.entries[0].status, 'failed');
  assert.match(sc.entries[0].error, /not logged in/);
  assert.equal(await docio.readDoc(docPath), docm.seed('T'));
  assert.equal(session.snapshot().engine.state, 'error');
  session.retry('e1');
  await session.idle();
  sc = s.read(slug);
  assert.equal(sc.entries[0].status, 'merged');
  assert.ok((await docio.readDoc(docPath)).includes('Recovered.'));
  assert.equal(session.snapshot().engine.state, 'idle');
});

test('unparseable engine output is a failed entry, not a crash or an overwrite', async () => {
  const { s, slug, session } = setup(() => ({ text: 'I cannot do that', usage: null, error: null, call: { provider: 'fake', mode: 'cli', model: 'fast', role: 'merge', ms: 1 } }));
  await session.load();
  session.submitIdea('x');
  await session.idle();
  assert.equal(s.read(slug).entries[0].status, 'failed');
  assert.match(s.read(slug).entries[0].error, /JSON/i);
  assert.equal(s.read(slug).snapshots.length, 1);
});

test('conflicts land in the sidecar and the doc block; keep old closes them with no engine call at all', async () => {
  const { s, slug, session, calls, docio, docPath } = setup((req) => mergeReply(req, 'Keep it short.', [{ id: 'C1', section: 'Goal', existing: 'Keep it short.', incoming: 'Make it long.' }]));
  await session.load();
  session.submitIdea('make it long');
  await session.idle();
  let sc = s.read(slug);
  assert.equal(sc.conflicts.length, 1);
  assert.equal(sc.conflicts[0].entryId, 'e1');
  assert.ok((await docio.readDoc(docPath)).includes('## Open conflicts'));
  assert.equal(session.snapshot().conflicts.length, 1);
  session.resolve('C1', 'old');
  await session.idle();
  assert.equal(calls.length, 1, 'keeping what is already there needs no model');
  sc = s.read(slug);
  assert.equal(sc.conflicts.length, 0);
  assert.equal(sc.resolved[0].id, 'C1');
  assert.equal(sc.resolved[0].keep, 'old');
  assert.equal(sc.resolved[0].by, 'local');
  assert.equal(sc.resolved[0].entryId, 'e1', 'the answer knows which idea raised it, so the thread can place it');
  const body = await docio.readDoc(docPath);
  assert.ok(!body.includes('## Open conflicts') && body.includes('Keep it short.'));
  assert.equal(sc.snapshots[sc.snapshots.length - 1].kind, 'resolve');
  assert.equal(session.snapshot().resolved.length, 1, 'the panel can show the answer in the thread');
});

test('an answer leaves the conflict strip and is in the thread the moment it is given, and comes back as a question if the merge fails', async () => {
  const conflict = [{ id: 'C1', section: 'Goal', existing: 'Keep it short.', incoming: 'but i want it long' }];
  let down = false;
  const { session } = setup((req, n) => {
    if (n === 1) return mergeReply(req, 'Keep it short.', conflict);
    return down ? { text: '', usage: null, error: 'engine down', call: null } : mergeReply(req, 'Make it long.', []);
  });
  await session.load();
  session.submitIdea('but i want it long');
  await session.idle();

  down = true;
  assert.equal(session.resolve('C1', 'new'), true);
  let snap = session.snapshot();
  assert.deepEqual(snap.conflicts, [], 'off the strip before any merge has run');
  assert.equal(snap.resolved.length, 1);
  assert.equal(snap.resolved[0].pending, true, 'in the thread, marked as merging');
  assert.equal(snap.resolved[0].keep, 'new');
  assert.equal(session.resolve('C1', 'old'), false, 'a second click is not a second answer');
  await session.idle();
  snap = session.snapshot();
  assert.equal(snap.conflicts.length, 1, 'the merge failed, so it is a question again');
  assert.equal(snap.resolved.length, 0);

  down = false;
  session.resolve('C1', 'new', { by: { name: 'sam', machine: 'LAPTOP' } });
  const answeredAt = session.snapshot().resolved[0].ts;
  await session.idle();
  snap = session.snapshot();
  assert.deepEqual(snap.conflicts, []);
  assert.equal(snap.resolved.length, 1);
  assert.ok(!snap.resolved[0].pending);
  assert.equal(snap.resolved[0].ts, answeredAt, 'it stays where it appeared in the thread');
  assert.deepEqual(snap.resolved[0].who, { name: 'sam', machine: 'LAPTOP' });
});

test('keep new is placed without a model when the incoming side reads as prompt text, and goes to the engine when it is a remark', async () => {
  const conflict = (incoming) => [{ id: 'C1', section: 'Goal', existing: 'Keep it short.', incoming }];
  const a = setup((req) => mergeReply(req, 'Keep it short.', conflict('Make it long.')));
  await a.session.load();
  a.session.submitIdea('make it long');
  await a.session.idle();
  a.session.resolve('C1', 'new');
  await a.session.idle();
  assert.equal(a.calls.length, 1);
  const doc = await a.docio.readDoc(a.docPath);
  assert.ok(doc.includes('Make it long.') && !doc.includes('Keep it short.'), 'the existing text was replaced exactly');

  const b = setup((req, n) => (n === 1 ? mergeReply(req, 'Keep it short.', conflict('but i want it long')) : mergeReply(req, 'Make it long.', [])));
  await b.session.load();
  b.session.submitIdea('but i want it long');
  await b.session.idle();
  b.session.resolve('C1', 'new');
  await b.session.idle();
  assert.equal(b.calls.length, 2, 'a remark to the tool is rewritten by the engine, not pasted in');
  assert.match(b.calls[1].prompt, /C1: keep new/);
  assert.ok(!docOf(b.calls[1].prompt).includes('## Open conflicts'), 'the engine sees the body, never the block');
  assert.equal(b.s.read(b.slug).conflicts.length, 0);
  assert.equal(b.s.read(b.slug).resolved[0].by, 'engine');
});

test('a merge answered with edits lands them; edits that cannot be placed get one more call for the whole document', async () => {
  const ok = setup((req) => ({ text: JSON.stringify({ edits: [{ section: 'Goal', op: 'create', text: 'Ship it.' }], conflicts: [], changes: ['goal'] }), usage: null, error: null, call: { provider: 'fake', mode: 'cli', model: 'fast', role: 'merge', ms: 1 } }));
  await ok.session.load();
  ok.session.submitIdea('ship it');
  await ok.session.idle();
  assert.equal(await ok.docio.readDoc(ok.docPath), '# T\n\n## Goal\n\nShip it.\n');
  assert.match(ok.calls[0].system, /never re-send a section you are not changing/, 'edits are what is asked for by default');

  const bad = setup((req, n) => (n === 1
    ? { text: JSON.stringify({ edits: [{ section: 'Notes', op: 'append', text: 'x' }] }), usage: null, error: null, call: { provider: 'fake', mode: 'cli', model: 'fast', role: 'merge', ms: 1 } }
    : mergeReply(req, 'Placed.')));
  await bad.session.load();
  bad.docs.set(bad.docPath, '# T\n\n## Notes\n\na\n\n## Notes\n\nb\n');
  bad.session.submitIdea('note this');
  await bad.session.idle();
  assert.equal(bad.calls.length, 2);
  assert.match(bad.calls[1].system, /COMPLETE document/, 'the fallback asks for the whole document');
  assert.equal(bad.s.read(bad.slug).entries[0].status, 'merged');
});

test('streaming progress is published while the engine works, and ideas for taking the prompt further are kept beside it', async () => {
  const { s, slug, session, published } = setup((req) => {
    req.onProgress({ phase: 'writing', section: 'Goal', chars: 10 });
    const r = mergeReply(req, 'Ship it.');
    const obj = JSON.parse(r.text);
    obj.ideas = [{ text: 'Add a launch checklist.' }];
    return { ...r, text: JSON.stringify(obj) };
  });
  await session.load();
  session.submitIdea('ship it');
  await session.idle();
  assert.ok(published.includes('progress'));
  assert.deepEqual(s.read(slug).ideas, [{ text: 'Add a launch checklist.' }]);
  session.dismissIdea('Add a launch checklist.');
  assert.deepEqual(session.snapshot().ideas, []);
});

test('an idea\'s files reach the engine as blocks and by name, and copy and send carry them with the idea they came from', async () => {
  const { s, slug, session, calls } = setup((req) => mergeReply(req, 'Match the layout in shot.png.'), { caps: { image: true, pdf: true } });
  await session.load();
  const img = s.saveImage(slug, { data: Buffer.from('PNGDATA').toString('base64'), ext: 'png', name: 'shot.png' });
  const note = s.saveFile(slug, { data: Buffer.from('field: value').toString('base64'), name: 'notes.txt' });
  assert.equal(note.kind, 'text');
  session.submitIdea('make it look like this', [img, note]);
  await session.idle();
  assert.equal(calls[0].blocks.length, 1);
  assert.equal(calls[0].blocks[0].name, 'shot.png');
  assert.ok(calls[0].prompt.includes('shot.png (image, sent with this message)'));
  assert.ok(calls[0].prompt.includes('<attachment name="notes.txt" idea="1">\nfield: value\n</attachment>'));
  const raw = fs.readFileSync(s.sidecarPath(slug), 'utf8');
  assert.ok(!raw.includes('PNGDATA') && !raw.includes(s.dir), 'names only in the sidecar');

  const copy = await session.copyText();
  assert.match(copy, /Attached files, referred to above by name\. Attach them alongside this prompt:/);
  assert.ok(copy.includes(`- shot.png (image, from the idea "make it look like this"): ${img.path}`));
  assert.ok(copy.includes('- notes.txt (text file, from the idea "make it look like this")'));
  const send = await session.sendText();
  assert.ok(send.includes(`@${img.path}`) || send.includes(`@"${img.path}"`), 'a Claude Code destination gets @-mentions it opens itself');
  assert.equal(session.snapshot().files.length, 2);
});

test('{{variables}} stay in the document and are filled on the way out; a missing one stays a visible slot', async () => {
  const { session, docio, docPath } = setup((req) => mergeReply(req, 'Write to {{client}} about {{offer}}.'));
  await session.load();
  session.submitIdea('x');
  await session.idle();
  assert.deepEqual(session.variables().names, ['client', 'offer']);
  session.setVars({ client: 'Acme' });
  const copy = await session.copyText();
  assert.ok(copy.includes('Write to Acme about {{offer}}.'));
  assert.ok((await docio.readDoc(docPath)).includes('{{client}}'), 'the document keeps the slot');
  assert.equal(session.snapshot().newSinceCopy, null, 'a fill is not a change to report as an add-on');
});

test('send remembers where it went, and after more ideas offers just what changed', async () => {
  let n = 0;
  const { session } = setup((req) => { n += 1; return mergeReply(req, `Line ${n}.`); });
  await session.load();
  session.submitIdea('one');
  await session.idle();
  assert.equal(await session.sendNewText(), null, 'nothing sent yet, so no update to offer');
  await session.markSent({ kind: 'terminal', name: 'claude' });
  assert.deepEqual(session.snapshot().sent.dest, { kind: 'terminal', name: 'claude' });
  assert.equal(session.snapshot().newSinceSend, null);
  session.submitIdea('two');
  await session.idle();
  assert.ok(session.snapshot().newSinceSend.added >= 1);
  const add = await session.sendNewText();
  assert.match(add.text, /Line 2\./);
});

test('a hand edit made before the merge is recorded as its own snapshot and is what the engine sees', async () => {
  const { s, slug, session, calls, docs, docPath } = setup((req) => mergeReply(req, 'Merged.'));
  await session.load();
  docs.set(docPath, `${docm.seed('T')}\nHand-written line.\n`);
  session.submitIdea('x');
  await session.idle();
  const sc = s.read(slug);
  assert.equal(sc.snapshots[1].kind, 'hand-edit');
  assert.ok(sc.snapshots[1].doc.includes('Hand-written line.'));
  assert.ok(docOf(calls[0].prompt).includes('Hand-written line.'));
  assert.equal(sc.snapshots[2].kind, 'merge');
});

test('a hand edit made DURING the merge is never overwritten: the merge runs again on the new text', async () => {
  let ctx;
  const { s, slug, session, calls, docs, docPath, docio } = setup(async (req, n) => {
    if (n === 1) docs.set(docPath, `${docOf(req.prompt)}\nEdited mid-call.\n`);
    return mergeReply(req, `Merged ${n}.`);
  });
  ctx = { s, slug };
  await session.load();
  session.submitIdea('x');
  await session.idle();
  assert.equal(calls.length, 2, 'ran again after the doc changed underneath it');
  assert.ok(docOf(calls[1].prompt).includes('Edited mid-call.'));
  const final = await docio.readDoc(docPath);
  assert.ok(final.includes('Edited mid-call.') && final.includes('Merged 2.'));
  assert.equal(ctx.s.read(ctx.slug).entries[0].status, 'merged');
});

test('setTarget runs a full polish with the family guide; polishing again with nothing changed is skipped, and a full rewrite can be forced', async () => {
  const { s, slug, session, calls, published } = setup((req) => echoReply(req));
  await session.load();
  session.setTarget('gpt-5');
  await session.idle();
  assert.equal(s.read(slug).target, 'gpt-5');
  assert.equal(calls[0].role, 'polish');
  assert.ok(calls[0].system.includes('<style-guide family="gpt">'));
  assert.ok(!calls[0].prompt.includes('<rewrite-only>'));
  const snaps = s.read(slug).snapshots;
  assert.equal(snaps[snaps.length - 1].kind, 'polish');
  assert.equal(snaps[snaps.length - 1].target, 'gpt-5');
  assert.equal(s.read(slug).polished.target, 'gpt-5');
  session.polish();
  await session.idle();
  assert.equal(calls.length, 1, 'nothing changed since the last polish for this target');
  assert.ok(published.some((w) => /Nothing has changed since this was polished/.test(w)));
  session.polish({ full: true });
  await session.idle();
  assert.equal(calls.length, 2, 'Alt+click rewrites it all again');
});

test('a joined window reads the sharer’s prompt and never writes it: a pending idea stays pending, nothing runs, and copy marks are its own', async () => {
  const { s, slug, docio } = setup(echoReply);
  s.appendEntry(slug, 'being merged in the other window');
  const before = fs.readFileSync(s.sidecarPath(slug), 'utf8');
  const ro = createSession({
    slug, store: s, docio, log: silent, cfg: () => ({ engine: {} }), settleMs: 0, readOnly: true,
    engine: { call: async () => { throw new Error('a joined window never calls the engine'); } },
  });
  await ro.load();
  assert.equal(ro.snapshot().entries[0].status, 'pending', 'not marked interrupted: it is being merged elsewhere');
  await ro.copyText();
  assert.ok(ro.snapshot().copied, 'the copy mark is kept in this window');
  ro.polish();
  await ro.idle();
  assert.equal(fs.readFileSync(s.sidecarPath(slug), 'utf8'), before, 'nothing was written to the shared copy');
});

test('switching the target clears the old target\'s advice at once, and the polish writes new advice for the new one', async () => {
  const polishCall = { provider: 'fake', mode: 'cli', model: 'best', role: 'polish', ms: 1 };
  const { s, slug, session, calls } = setup((req) => {
    if (req.role === 'merge') {
      const r = mergeReply(req, 'Ship it.');
      const o = JSON.parse(r.text);
      o.suggestions = [{ section: 'Output format', text: 'Say what Claude Fable 5.1 should return.' }];
      return { ...r, text: JSON.stringify(o) };
    }
    return { text: JSON.stringify({ doc: docOf(req.prompt), changes: [], suggestions: [{ section: 'Output format', text: 'Say what Claude Opus 5 should return.' }], ideas: [{ text: 'Add an example.' }] }), usage: null, error: null, call: polishCall };
  });
  await session.load();
  session.submitIdea('ship it');
  await session.idle();
  assert.match(s.read(slug).suggestions[0].text, /Fable/);
  session.setTarget('opus-5');
  assert.deepEqual(s.read(slug).suggestions, [], 'the old advice goes the moment the target changes');
  await session.idle();
  const polish = calls[calls.length - 1];
  assert.equal(polish.role, 'polish');
  assert.ok(polish.prompt.includes('This prompt was written for Claude Fable 5.1 and is now for Claude Opus 5.'));
  assert.ok(polish.prompt.includes('"suggestions"'));
  assert.match(s.read(slug).suggestions[0].text, /Opus 5/, 'and the new advice is for the new model');
  assert.deepEqual(s.read(slug).ideas, [{ text: 'Add an example.' }]);
  session.setTarget('opus-5');
  await session.idle();
  assert.equal(calls.length, 2, 'choosing the target it already has does nothing');
});

test('a polish that drops the title gets it back, and sections padded with "None provided" are left out', async () => {
  const { session, docio, docPath } = setup((req) => {
    if (req.role === 'merge') return mergeReply(req, 'Ship it.');
    return { text: JSON.stringify({ doc: 'Do the job well.\n\n<goal>\n\nShip it.\n\n</goal>\n\n<examples>\n\nNone provided.\n\n</examples>\n', changes: [] }), usage: null, error: null, call: { provider: 'fake', mode: 'cli', model: 'best', role: 'polish', ms: 1 } };
  });
  await session.load();
  session.submitIdea('ship it');
  await session.idle();
  session.polish({ full: true });
  await session.idle();
  const doc = await docio.readDoc(docPath);
  assert.ok(doc.startsWith('# T\n\nDo the job well.'), 'the title is back on the first line');
  assert.ok(doc.includes('<goal>\n\nShip it.\n\n</goal>'));
  assert.ok(!doc.includes('None provided') && !doc.includes('<examples>'), 'an empty section is not a section');
});

test('after a merge, Polish rewrites only the sections that changed, and the formatter gives them the family shape', async () => {
  const { session, calls, docs, docPath, docio } = setup((req) => {
    if (req.role === 'merge') return mergeReply(req, 'Also ship docs.');
    if (req.prompt.includes('<rewrite-only>')) {
      return { text: JSON.stringify({ edits: [{ section: 'Goal', op: 'replace', text: 'Ship the product and its docs.' }], changes: ['goal'] }), usage: null, error: null, call: { provider: 'fake', mode: 'cli', model: 'best', role: 'polish', ms: 1 } };
    }
    return echoReply(req);
  });
  await session.load();
  docs.set(docPath, '# T\n\n## Goal\n\nShip it.\n\n## Context\n\nC.\n\n## Requirements\n\n* r\n');
  session.setTarget('gemini-pro');
  await session.idle();
  session.submitIdea('also docs');
  await session.idle();
  session.polish();
  await session.idle();
  const last = calls[calls.length - 1];
  assert.equal(last.role, 'polish');
  assert.ok(last.prompt.includes('<rewrite-only>\n- Goal\n</rewrite-only>'), 'only the section the merge touched');
  const doc = await docio.readDoc(docPath);
  assert.ok(doc.includes('## Goal\n\nShip the product and its docs.'));
  assert.ok(doc.includes('## Context\n\nC.'), 'an unchanged section is untouched');
  assert.ok(doc.includes('- r') && !doc.includes('* r'), 'and the formatter normalised the list marker');
});

test('restore rewrites the doc from a snapshot and is itself recorded; refused while busy', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { s, slug, session, docio, docPath } = setup(async (req, n) => { if (n === 2) await gate; return mergeReply(req, `L${n}`); });
  await session.load();
  session.submitIdea('one');
  await session.idle();
  assert.ok((await docio.readDoc(docPath)).includes('L1'));
  const r = await session.restore('s1');
  assert.equal(r.ok, true);
  assert.equal(await docio.readDoc(docPath), docm.seed('T'));
  const snaps = s.read(slug).snapshots;
  assert.equal(snaps[snaps.length - 1].kind, 'restore');
  assert.equal(snaps[snaps.length - 1].from, 's1');
  session.submitIdea('two');
  await new Promise((r2) => setImmediate(r2));
  assert.equal((await session.restore('s1')).ok, false);
  release();
  await session.idle();
});

test('copyText strips the conflict block; snapshot() carries history without doc bodies and sums usage', async () => {
  const { session } = setup((req) => mergeReply(req, 'Short.', [{ id: 'C1', section: 'Goal', existing: 'Short.', incoming: 'Long.' }]));
  await session.load();
  session.submitIdea('long');
  await session.idle();
  const copy = await session.copyText();
  assert.ok(copy.includes('Short.') && !copy.includes('Open conflicts') && !copy.includes('forge:'));
  const v = session.snapshot();
  assert.equal(v.slug, session.slug);
  assert.equal(v.entries.length, 1);
  assert.equal(v.snapshots.length, 2);
  assert.ok(!('doc' in v.snapshots[1]));
  assert.deepEqual(v.usage, { calls: 1, input: 10, output: 2 });
  assert.equal(v.conflicts[0].id, 'C1');
});

test('load() turns entries left pending by a crash into failed: interrupted, with Retry available', async () => {
  const { s, slug, session } = setup((req) => mergeReply(req, 'x'));
  s.appendEntry(slug, 'stale idea');
  await session.load();
  const e = s.read(slug).entries[0];
  assert.equal(e.status, 'failed');
  assert.match(e.error, /interrupted/);
});

test('a polish never touches open conflicts, even when the engine returns none', async () => {
  const { s, slug, session, docio, docPath } = setup((req, n) => (n === 1
    ? mergeReply(req, 'Short.', [{ id: 'C1', section: 'Goal', existing: 'Short.', incoming: 'Long.' }])
    : { text: JSON.stringify({ doc: docOf(req.prompt), changes: [] }), usage: null, error: null, call: { provider: 'fake', mode: 'cli', model: 'best', role: 'polish', ms: 1 } }));
  await session.load();
  session.submitIdea('long');
  await session.idle();
  assert.equal(s.read(slug).conflicts.length, 1);
  session.polish();
  await session.idle();
  const sc = s.read(slug);
  assert.equal(sc.conflicts.length, 1, 'still open');
  assert.equal(sc.resolved.length, 0);
  assert.ok((await docio.readDoc(docPath)).includes('## Open conflicts'));
});

test('retry on an old failure while a merge is running does not blank the busy state', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { session } = setup(async (req, n) => {
    if (n === 1) return { text: '', usage: null, error: 'boom', call: { provider: 'fake', mode: 'cli', model: 'fast', role: 'merge', ms: 1 } };
    if (n === 2) await gate;
    return mergeReply(req, `L${n}`);
  });
  await session.load();
  session.submitIdea('fails');
  await session.idle();
  session.submitIdea('second');
  await new Promise((r) => setImmediate(r));
  assert.equal(session.snapshot().engine.state, 'busy');
  session.retry('e1');
  assert.equal(session.snapshot().engine.state, 'busy', 'retry queued behind the running merge');
  release();
  await session.idle();
  assert.equal(session.snapshot().engine.state, 'idle');
});

test('editing a sent idea re-merges it: the entry text changes, the engine sees before and after, the snapshot is a revise', async () => {
  const { s, slug, session, calls, docio, docPath } = setup((req, n) => mergeReply(req, n === 1 ? 'Ship Friday.' : 'Ship Monday.'));
  await session.load();
  session.submitIdea('ship friday');
  await session.idle();
  session.editIdea('e1', 'ship monday');
  await session.idle();
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /<revisions>[\s\S]*ship friday[\s\S]*ship monday[\s\S]*<\/revisions>/);
  const sc = s.read(slug);
  assert.equal(sc.entries.length, 1, 'an edit is not a new entry');
  assert.equal(sc.entries[0].text, 'ship monday');
  assert.equal(sc.entries[0].status, 'merged');
  assert.deepEqual(sc.entries[0].edits.map((e) => e.text), ['ship friday']);
  assert.equal(sc.snapshots[sc.snapshots.length - 1].kind, 'revise');
  assert.ok((await docio.readDoc(docPath)).includes('Ship Monday.'));
});

test('editing with unchanged or empty text is a no-op', async () => {
  const { session, calls } = setup((req) => mergeReply(req, 'x'));
  await session.load();
  session.submitIdea('same');
  await session.idle();
  assert.equal(session.editIdea('e1', 'same'), false);
  assert.equal(session.editIdea('e1', '   '), false);
  await session.idle();
  assert.equal(calls.length, 1);
});

test('an untitled prompt names itself from the first idea, once; rename changes the title and the H1', async () => {
  const { s, slug, session, docio, docPath } = setup((req, n) => mergeReply(req, `L${n}`), { title: 'Untitled' });
  await session.load();
  session.submitIdea('make the landing page sell the six week course');
  await session.idle();
  let sc = s.read(slug);
  assert.equal(sc.title, 'Make the landing page sell');
  assert.ok((await docio.readDoc(docPath)).startsWith('# Make the landing page sell\n'));
  session.submitIdea('another idea that must not rename it');
  await session.idle();
  assert.equal(s.read(slug).title, 'Make the landing page sell');
  await session.rename('Landing brief');
  sc = s.read(slug);
  assert.equal(sc.title, 'Landing brief');
  assert.ok((await docio.readDoc(docPath)).startsWith('# Landing brief\n'));
  assert.equal(sc.snapshots[sc.snapshots.length - 1].kind, 'rename');
  assert.equal(session.snapshot().title, 'Landing brief');
});

test('a suggestion never reaches the document, the disk, or the clipboard', async () => {
  const ADVICE = 'Name the three output formats you accept here.';
  const { s, slug, session, docio, docPath } = setup((req) => {
    const doc = docOf(req.prompt);
    return {
      text: JSON.stringify({
        doc: doc.includes('## Goal\n') ? doc.replace('## Goal\n', '## Goal\n\nShip it.\n') : `${doc}\n## Goal\n\nShip it.\n`,
        conflicts: [], changes: ['added goal'],
        suggestions: [{ section: 'Output format', text: ADVICE }],
      }),
      usage: { input: 10, output: 2 }, error: null,
      call: { provider: 'fake', mode: 'cli', model: 'fast', role: req.role, ms: 1, usage: { input: 10, output: 2 } },
    };
  });
  await session.load();
  session.submitIdea('ship it');
  await session.idle();

  // It exists, and the panel can see it.
  assert.deepEqual(s.read(slug).suggestions, [{ section: 'Output format', kind: 'info', text: ADVICE }]);
  assert.equal(session.snapshot().suggestions[0].text, ADVICE);

  // And it is in none of the three places a prompt actually leaves the tool from. This is the
  // point of storing it in the sidecar: there is no strip step here that could be got wrong.
  assert.ok(!(await docio.readDoc(docPath)).includes(ADVICE), 'not in the document on disk');
  assert.ok(!(await session.copyText()).includes(ADVICE), 'not in a copy');
  const sc = s.read(slug);
  assert.ok(!sc.snapshots.some((x) => String(x.doc || '').includes(ADVICE)), 'not in any snapshot, so restore cannot resurrect it');
});

test('suggestions are replaced wholesale by the next merge, never accumulated', async () => {
  let n = 0;
  const { s, slug, session } = setup((req) => {
    n += 1;
    const doc = docOf(req.prompt);
    return {
      text: JSON.stringify({
        doc: doc.includes('## Goal\n') ? doc.replace('## Goal\n', `## Goal\n\nL${n}\n`) : `${doc}\n## Goal\n\nL${n}\n`,
        conflicts: [], changes: [],
        suggestions: [{ section: 'Goal', text: `advice ${n}` }],
      }),
      usage: { input: 1, output: 1 }, error: null,
      call: { provider: 'fake', mode: 'cli', model: 'fast', role: req.role, ms: 1, usage: { input: 1, output: 1 } },
    };
  });
  await session.load();
  session.submitIdea('one');
  await session.idle();
  session.submitIdea('two');
  await session.idle();
  // Stale advice about a section that has since been filled is worse than none.
  assert.deepEqual(s.read(slug).suggestions.map((x) => x.text), ['advice 2']);
});

test('the add-on copy appears only after a copy, carries just the change, and repeats', async () => {
  let n = 0;
  const { s, slug, session } = setup((req) => {
    n += 1;
    const doc = docOf(req.prompt);
    const body = doc.includes('## Requirements\n')
      ? doc.replace('## Requirements\n', `## Requirements\n\n- Requirement ${n}.\n`)
      : `${doc}\n## Requirements\n\n- Requirement ${n}.\n`;
    return {
      text: JSON.stringify({ doc: body, conflicts: [], changes: [] }),
      usage: { input: 1, output: 1 }, error: null,
      call: { provider: 'fake', mode: 'cli', model: 'fast', role: req.role, ms: 1, usage: { input: 1, output: 1 } },
    };
  });
  await session.load();

  // Before any copy there is no add-on round to be in, so nothing is offered.
  session.submitIdea('one');
  await session.idle();
  assert.equal(session.snapshot().newSinceCopy, null, 'nothing offered before the first copy');
  assert.equal(await session.copyNewText(), null);

  const full = await session.copyText();
  assert.ok(full.includes('- Requirement 1.'));
  assert.ok(s.read(slug).copied, 'copying sets the mark');
  assert.equal(session.snapshot().newSinceCopy, null, 'and immediately after, nothing is new');

  // Merge again: now there is something to send as a follow-up.
  session.submitIdea('two');
  await session.idle();
  assert.deepEqual(session.snapshot().newSinceCopy, { added: 1, removed: 0, restyled: false });

  const add = await session.copyNewText();
  assert.ok(add.text.includes('- Requirement 2.'), 'the new line is in it');
  // The changed section is carried whole so the addition reads in place; what is actually new is
  // named in the summary, which is where the precision lives.
  assert.ok(add.text.includes('- Requirement 1.'), 'with the context around it');
  assert.ok(/- New in Requirements: Requirement 2\./.test(add.text));
  assert.ok(!/- New in Requirements: Requirement 1\./.test(add.text), 'the already-sent one is not called new');

  // Using it advances the mark, so the button goes until there is something new again...
  assert.equal(session.snapshot().newSinceCopy, null);
  assert.equal(await session.copyNewText(), null, 'and a second press has nothing to give');

  // ...and the round repeats without limit.
  session.submitIdea('three');
  await session.idle();
  const third = await session.copyNewText();
  assert.ok(/- New in Requirements: Requirement 3\./.test(third.text));
  assert.ok(!/- New in Requirements: Requirement 2\./.test(third.text), 'each round reports only its own round');
});

test('a merge records what it changed, so the log can show it without re-diffing history', async () => {
  const { s, slug, session } = setup((req) => {
    const doc = docOf(req.prompt);
    return {
      text: JSON.stringify({
        doc: doc.includes('## Goal\n') ? doc.replace('## Goal\n', '## Goal\n\nShip it.\n') : `${doc}\n## Goal\n\nShip it.\n`,
        conflicts: [], changes: ['engine said something vague'],
      }),
      usage: { input: 1, output: 1 }, error: null,
      call: { provider: 'fake', mode: 'cli', model: 'fast', role: req.role, ms: 1, usage: { input: 1, output: 1 } },
    };
  });
  await session.load();
  session.submitIdea('ship it');
  await session.idle();

  const snaps = s.read(slug).snapshots;
  const last = snaps[snaps.length - 1];
  // `changes` is the engine's own account of itself; `diff` is what actually moved in the text.
  assert.ok(Array.isArray(last.diff) && last.diff.length, 'the diff is stored on the snapshot');
  assert.ok(last.diff.some((b) => b.added.includes('Ship it.')), 'and it is the real added line');
  assert.ok(session.snapshot().snapshots.some((v) => v.diff && v.diff.length), 'the panel can see it');

  // An entry points at the snapshot it produced, and the one before it is what "undo" restores to.
  const e = s.read(slug).entries[0];
  const i = snaps.findIndex((v) => v.id === e.snapshotId);
  assert.ok(i > 0, 'there is always a prior snapshot to undo to, because a prompt is seeded with one');
  assert.ok(!snaps[i - 1].doc.includes('Ship it.'), 'and it is the document before this idea landed');
});

test('a test run answers the prompt, records what actually answered it, and keeps the last five', async () => {
  let n = 0;
  const { s, slug, session } = setup((req) => {
    if (req.role === 'run') {
      n += 1;
      return {
        text: `answer ${n}`, usage: { input: 300, output: 80 }, error: null,
        call: { provider: 'anthropic', mode: 'cli', model: 'best', role: 'run', ms: 1200, usage: { input: 300, output: 80 } },
      };
    }
    return mergeReply(req, 'Ship it.');
  });
  await session.load();
  session.submitIdea('ship it');
  await session.idle();

  assert.deepEqual(await session.run(), { ok: true });
  const r = s.read(slug).runs[0];
  assert.equal(r.text, 'answer 1');
  // Which engine answered is recorded, not implied: the signed-in engine is often not the family
  // the prompt is styled for, and "it worked" means nothing without knowing who it worked on.
  assert.equal(r.provider, 'anthropic');
  assert.equal(r.model, 'best');
  assert.equal(r.target, s.read(slug).target);
  assert.deepEqual(r.usage, { input: 300, output: 80 });
  assert.ok(r.promptChars > 0);
  assert.ok(session.snapshot().runs.length === 1, 'the panel can see it');

  for (let i = 0; i < 6; i += 1) await session.run();
  const runs = s.read(slug).runs;
  assert.equal(runs.length, 5, 'a scratch record, not history');
  assert.equal(runs[runs.length - 1].text, 'answer 7', 'newest kept');
});

test('a run that fails reports it and writes nothing', async () => {
  const { s, slug, session } = setup((req) => {
    if (req.role === 'run') return { text: '', usage: null, error: 'rate limited', call: { provider: 'x', mode: 'cli', model: 'm', role: 'run', ms: 9, usage: null } };
    return mergeReply(req, 'Ship it.');
  });
  await session.load();
  session.submitIdea('ship it');
  await session.idle();
  assert.deepEqual(await session.run(), { error: 'rate limited' });
  assert.deepEqual(s.read(slug).runs, [], 'a failure is not an answer');
  assert.equal(session.snapshot().engine.error, 'rate limited');
});

test('a run uses the polish model, because it is the prompt being answered for real', async () => {
  const seen = [];
  const { session } = setup((req) => {
    seen.push(req.role);
    if (req.role === 'run') return { text: 'a', usage: null, error: null, call: { provider: 'p', mode: 'cli', model: 'm', role: 'run', ms: 1, usage: null } };
    return mergeReply(req, 'Ship it.');
  });
  await session.load();
  session.submitIdea('one');
  await session.idle();
  await session.run();
  assert.deepEqual(seen, ['merge', 'run'], 'the run is its own role, not a merge or a polish');
  const engine = require('node:fs').readFileSync(fileURLToPath(new URL('../src/engine/engine.js', import.meta.url)), 'utf8');
  assert.ok(/role === 'polish' \|\| role === 'run' \? selection\.polishModel/.test(engine), 'and it gets the good model');
});
