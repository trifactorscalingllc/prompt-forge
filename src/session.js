'use strict';
// One prompt's controller: the queue, the store, the document and the engine, and the rules that
// keep an idea from ever being lost or a hand edit from ever being overwritten.
const { createQueue } = require('./queue');
const docm = require('./doc');
const targets = require('./targets');
const { buildMergePrompt, buildPolishPrompt } = require('./engine/prompt');
const { parseEngineOutput } = require('./engine/output');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const publicConflict = (c) => ({ id: c.id, section: c.section, existing: c.existing, incoming: c.incoming });

function createSession({ slug, store, docio, engine, cfg, log, publish = () => {}, settleMs = 450 }) {
  const docPath = store.docPath(slug);
  let sc = null;
  let disposed = false;
  let engineState = { state: 'idle', op: null, model: null, startedAt: 0, error: null };

  const reread = () => { sc = store.read(slug); return sc; };
  const lastSnapshot = () => sc.snapshots[sc.snapshots.length - 1];
  const engineCfg = () => (cfg() && cfg().engine) || {};

  const queue = createQueue({
    run: runBatch,
    onChange: () => publish('queue'),
    onError: (e) => log.error(`${slug}: batch failed: ${e.stack || e.message}`),
  });

  /** The body the engine should see: the live document minus the conflict block. */
  async function currentBody() {
    const raw = await docio.readDoc(docPath);
    if (raw == null) {
      // The .md was deleted or moved. The latest snapshot is the record; put it back.
      const body = lastSnapshot().doc;
      await docio.writeDoc(docPath, docm.withConflictBlock(body, sc.conflicts));
      return body;
    }
    return docm.stripConflictBlock(raw);
  }

  function fail(entryIds, error, call) {
    for (const id of entryIds) store.updateEntry(slug, id, { status: 'failed', error });
    reread();
    engineState = { state: 'error', op: null, model: call ? call.model : null, startedAt: 0, error };
    log.error(`${slug}: ${error}`);
    publish('failed');
  }

  async function runBatch(batch) {
    if (disposed) return;
    reread();
    const role = batch.kind === 'polish' ? 'polish' : 'merge';
    const entryIds = batch.entryIds || [];
    const resolutions = batch.resolutions || [];
    engineState = { state: 'busy', op: role, model: null, startedAt: Date.now(), error: null };
    publish('engine');
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // The WYSIWYG editor writes hand edits with a short debounce; give the last keystrokes time to land.
        if (settleMs) await sleep(settleMs);
        const body = await currentBody();
        if (body !== lastSnapshot().doc) {
          store.addSnapshot(slug, { kind: 'hand-edit', entryIds: [], doc: body, conflicts: sc.conflicts, changes: [], target: sc.target });
          reread();
          publish('hand-edit');
        }
        const target = targets.resolve(sc.target);
        const ideas = entryIds.map((id) => sc.entries.find((e) => e.id === id)).filter(Boolean);
        const recentN = Number.isFinite(engineCfg().recentEntries) ? engineCfg().recentEntries : 12;
        const recent = sc.entries.filter((e) => e.status === 'merged').slice(-recentN);
        const conflicts = sc.conflicts.map(publicConflict);
        const prompt = role === 'polish'
          ? buildPolishPrompt({ doc: body, conflicts, target, styleGuide: targets.styleGuide(target.family) })
          : buildMergePrompt({ doc: body, ideas, resolutions, conflicts, recent, target });
        const timeoutMs = (engineCfg().timeoutSeconds || 240) * 1000;

        const res = await engine.call({ role, prompt, timeoutMs });
        if (disposed) return;
        if (res.call) engineState.model = res.call.model;
        if (res.error) return fail(entryIds, res.error, res.call);
        const out = parseEngineOutput(res.text, { kind: role, inputDoc: body });
        if (!out.ok) return fail(entryIds, out.error, res.call);

        // Did the person edit while the engine was thinking? Never overwrite that: run once more.
        const nowRaw = await docio.readDoc(docPath);
        const nowBody = nowRaw == null ? body : docm.stripConflictBlock(nowRaw);
        if (nowBody !== body && attempt === 0) {
          log.info(`${slug}: document changed during the call; merging again`);
          publish('notice:The document changed while the engine was working. Merging again.');
          continue;
        }

        for (const r of resolutions) store.resolveConflict(slug, r.conflictId, r.keep);
        reread();
        store.setConflicts(slug, out.conflicts, { entryId: entryIds.length ? entryIds[entryIds.length - 1] : null });
        reread();
        await docio.writeDoc(docPath, docm.withConflictBlock(out.doc, sc.conflicts));
        const kind = role === 'polish' ? 'polish' : entryIds.length ? 'merge' : 'resolve';
        const snap = store.addSnapshot(slug, { kind, entryIds, doc: out.doc, conflicts: sc.conflicts, changes: out.changes, target: sc.target, call: res.call });
        for (const id of entryIds) store.updateEntry(slug, id, { status: 'merged', snapshotId: snap.id, error: null });
        reread();
        engineState = { state: 'idle', op: null, model: null, startedAt: 0, error: null };
        publish('landed');
        return;
      }
    } catch (e) {
      fail(entryIds, e.message || String(e));
    }
  }

  async function load() {
    if (!reread()) throw new Error(`no prompt named "${slug}"`);
    // A pending entry at load time means a reload or crash cut a merge short. The idea is still here.
    for (const e of sc.entries) {
      if (e.status === 'pending') store.updateEntry(slug, e.id, { status: 'failed', error: 'interrupted: the extension reloaded during the merge' });
    }
    reread();
    if ((await docio.readDoc(docPath)) == null) await docio.writeDoc(docPath, docm.withConflictBlock(lastSnapshot().doc, sc.conflicts));
    publish('load');
    return sc;
  }

  function submitIdea(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const entry = store.appendEntry(slug, t);
    reread();
    queue.push({ kind: 'idea', entryId: entry.id });
    publish('idea');
    return entry;
  }

  function retry(entryId) {
    const e = sc.entries.find((x) => x.id === entryId);
    if (!e || e.status !== 'failed') return false;
    store.updateEntry(slug, entryId, { status: 'pending', error: null });
    reread();
    engineState = { state: 'idle', op: null, model: null, startedAt: 0, error: null };
    queue.push({ kind: 'idea', entryId });
    return true;
  }

  function retryAll() {
    let n = 0;
    for (const e of sc.entries.filter((x) => x.status === 'failed')) if (retry(e.id)) n++;
    return n;
  }

  async function restore(snapshotId) {
    if (queue.busy() || queue.size()) return { ok: false, reason: 'busy' };
    reread();
    const snap = sc.snapshots.find((s) => s.id === snapshotId);
    if (!snap) return { ok: false, reason: 'no such snapshot' };
    store.setConflicts(slug, snap.conflicts || []);
    reread();
    await docio.writeDoc(docPath, docm.withConflictBlock(snap.doc, sc.conflicts));
    store.addSnapshot(slug, { kind: 'restore', from: snap.id, entryIds: [], doc: snap.doc, conflicts: sc.conflicts, changes: [`restored ${snap.id}`], target: sc.target });
    reread();
    publish('restore');
    return { ok: true };
  }

  async function copyText() {
    const raw = await docio.readDoc(docPath);
    return docm.stripForCopy(raw == null ? lastSnapshot().doc : raw);
  }

  function snapshot() {
    if (!sc) reread();
    const usage = { calls: 0, input: 0, output: 0 };
    for (const s of sc.snapshots) {
      if (!s.call || !s.call.usage) continue;
      usage.calls += 1;
      usage.input += Number(s.call.usage.input) || 0;
      usage.output += Number(s.call.usage.output) || 0;
    }
    return {
      slug, title: sc.title, target: sc.target, docPath, docOpen: docio.isOpen(docPath),
      entries: sc.entries.map((e) => ({ ...e })),
      snapshots: sc.snapshots.map(({ doc, ...rest }) => rest),
      conflicts: sc.conflicts.map((c) => ({ ...c })),
      engine: { ...engineState, queued: queue.size() },
      usage,
    };
  }

  async function idle() {
    while (queue.busy() || queue.size()) await tick();
  }

  return {
    slug, docPath, load, snapshot, submitIdea, retry, retryAll,
    resolve: (conflictId, keep) => queue.push({ kind: 'resolve', conflictId, keep }),
    polish: () => queue.push({ kind: 'polish' }),
    setTarget(target) { store.setTarget(slug, target); reread(); queue.push({ kind: 'polish' }); },
    restore, copyText, idle,
    busy: () => queue.busy() || queue.size() > 0,
    dispose() { disposed = true; queue.clear(); },
  };
}

module.exports = { createSession };
