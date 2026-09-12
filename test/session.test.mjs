import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

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

function setup(impl, { title = 'T' } = {}) {
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
  const engine = { call: async (req) => { calls.push({ ...req, sidecarAtCall: s.read(slug) }); return impl(req, calls.length); } };
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

test('conflicts land in the sidecar and the doc block; resolve rides the next merge and clears them', async () => {
  const { s, slug, session, calls, docio, docPath } = setup((req, n) => (n === 1
    ? mergeReply(req, 'Keep it short.', [{ id: 'C1', section: 'Goal', existing: 'Keep it short.', incoming: 'Make it long.' }])
    : mergeReply(req, 'Resolved.', [])));
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
  assert.equal(calls.length, 2);
  assert.match(calls[1].prompt, /C1: keep old/);
  assert.ok(!docOf(calls[1].prompt).includes('## Open conflicts'), 'the engine sees the body, never the block');
  sc = s.read(slug);
  assert.equal(sc.conflicts.length, 0);
  assert.equal(sc.resolved[0].id, 'C1');
  assert.equal(sc.resolved[0].keep, 'old');
  assert.ok(!(await docio.readDoc(docPath)).includes('## Open conflicts'));
  assert.equal(sc.snapshots[sc.snapshots.length - 1].kind, 'resolve');
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

test('setTarget persists the target and runs a polish on the polish model; Polish alone does the same', async () => {
  const { s, slug, session, calls } = setup((req) => echoReply(req));
  await session.load();
  session.setTarget('gpt-5');
  await session.idle();
  assert.equal(s.read(slug).target, 'gpt-5');
  assert.equal(calls[0].role, 'polish');
  assert.ok(calls[0].prompt.includes('<style-guide family="gpt">'));
  const snaps = s.read(slug).snapshots;
  assert.equal(snaps[snaps.length - 1].kind, 'polish');
  assert.equal(snaps[snaps.length - 1].target, 'gpt-5');
  session.polish();
  await session.idle();
  assert.equal(calls.length, 2);
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
  assert.deepEqual(s.read(slug).suggestions, [{ section: 'Output format', text: ADVICE }]);
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
  assert.ok(!add.text.includes('- Requirement 1.'), 'and the already-sent one is not');

  // Using it advances the mark, so the button goes until there is something new again...
  assert.equal(session.snapshot().newSinceCopy, null);
  assert.equal(await session.copyNewText(), null, 'and a second press has nothing to give');

  // ...and the round repeats without limit.
  session.submitIdea('three');
  await session.idle();
  const third = await session.copyNewText();
  assert.ok(third.text.includes('- Requirement 3.'));
  assert.ok(!third.text.includes('- Requirement 2.'));
});
