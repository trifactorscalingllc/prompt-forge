'use strict';
// One prompt's controller: the queue, the store, the document and the engine, and the rules that
// keep an idea from ever being lost or a hand edit from ever being overwritten.
const { createQueue } = require('./queue');
const docm = require('./doc');
const targets = require('./targets');
const { buildMergePrompt, buildPolishPrompt } = require('./engine/prompt');
const { buildAddendum, diffSections } = require('./addendum');
const nodeFs = require('node:fs');
const projectMod = require('./project');

// Injected so a session test never touches a real filesystem.
const defaultLookup = (dir, idea) => projectMod.lookup(dir, idea, { fs: nodeFs });
const { parseEngineOutput } = require('./engine/output');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const publicConflict = (c) => ({ id: c.id, section: c.section, existing: c.existing, incoming: c.incoming });

function createSession({ slug, store, docio, engine, cfg, log, publish = () => {}, settleMs = 450, lookupFor = defaultLookup }) {
  const docPath = store.docPath(slug);
  let sc = null;
  let disposed = false;
  let engineState = { state: 'idle', op: null, model: null, startedAt: 0, error: null };

  const reread = () => { sc = store.read(slug); return sc; };
  const lastSnapshot = () => sc.snapshots[sc.snapshots.length - 1];
  const engineCfg = () => (cfg() && cfg().engine) || {};
  const keepBodies = () => {
    const n = (cfg() || {}).keepVersionBodies;
    return Number.isFinite(n) ? n : 20;
  };

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
    const revised = batch.revisions || [];
    engineState = { state: 'busy', op: role, model: null, startedAt: Date.now(), error: null };
    publish('engine');
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        // A formatted editor writes hand edits with a short debounce; give the last keystrokes time to land.
        if (settleMs) await sleep(settleMs);
        const body = await currentBody();
        if (body !== lastSnapshot().doc) {
          store.addSnapshot(slug, { kind: 'hand-edit', entryIds: [], doc: body, conflicts: sc.conflicts, changes: [], target: sc.target }, { keepBodies: keepBodies() });
          reread();
          publish('hand-edit');
        }
        const target = targets.resolve(sc.target);
        const ideas = entryIds.map((id) => sc.entries.find((e) => e.id === id)).filter(Boolean);
        const recentN = Number.isFinite(engineCfg().recentEntries) ? engineCfg().recentEntries : 12;
        const recent = sc.entries.filter((e) => e.status === 'merged').slice(-recentN);
        const conflicts = sc.conflicts.map(publicConflict);
        const revisions = revised.map((r) => { const e = sc.entries.find((x) => x.id === r.entryId); return e ? { id: e.id, before: r.before, after: e.text } : null; }).filter(Boolean);
        const touched = [...entryIds, ...revised.map((r) => r.entryId)];
        const projects = sc.projects || [];
        // Opt-in and per idea. It costs a filesystem scan on every Enter, which is exactly why it
        // is off by default and why an empty result is a normal, silent outcome.
        let excerpts = [];
        if (role === 'merge' && ((cfg() || {}).project || {}).context === 'brief+lookup') {
          const dir = projects.find((p) => p.path && !p.error);
          if (dir) {
            try { excerpts = lookupFor(dir.path, ideas.map((i) => i.text).join(' ')); } catch { excerpts = []; }
          }
        }
        const needsTitle = role === 'merge' && /^Untitled( \d+)?$/.test(sc.title) && !sc.entries.some((e) => e.status === 'merged');
        const mergedTotal = sc.entries.filter((e) => e.status === 'merged').length;
        const sectionNames = targets.sectionsFor(target.family);
        const suggest = role === 'merge' && (cfg() || {}).suggestions !== false;
        const prompt = role === 'polish'
          ? buildPolishPrompt({ doc: body, conflicts, target, styleGuide: targets.styleGuide(target.family), projects })
          : buildMergePrompt({ doc: body, ideas, resolutions, revisions, conflicts, recent, target, projects, excerpts, needsTitle, suggest, sectionNames, mergedTotal });
        const timeoutMs = (engineCfg().timeoutSeconds || 240) * 1000;

        const res = await engine.call({ role, prompt, timeoutMs });
        if (disposed) return;
        if (res.call) engineState.model = res.call.model;
        if (res.error) return fail(touched, res.error, res.call);
        const out = parseEngineOutput(res.text, { kind: role, inputDoc: body });
        if (!out.ok) return fail(touched, out.error, res.call);

        // Did the person edit while the engine was thinking? Never overwrite that: run once more.
        const nowRaw = await docio.readDoc(docPath);
        const nowBody = nowRaw == null ? body : docm.stripConflictBlock(nowRaw);
        if (nowBody !== body && attempt === 0) {
          log.info(`${slug}: document changed during the call; merging again`);
          publish('notice:The document changed while the engine was working. Merging again.');
          continue;
        }

        // Only a merge may change the open-conflict list. A polish that returns none (or forgets
        // the key) must not make a contradiction disappear; that is the one thing this tool is for.
        if (role === 'merge') {
          for (const r of resolutions) store.resolveConflict(slug, r.conflictId, r.keep);
          reread();
          store.setConflicts(slug, out.conflicts, { entryId: entryIds.length ? entryIds[entryIds.length - 1] : null });
          reread();
        }
        // An untitled prompt takes its name from the first idea that lands.
        if (role === 'merge' && entryIds.length && /^Untitled( \d+)?$/.test(sc.title) && !sc.entries.some((e) => e.status === 'merged')) {
          // The engine names it, because it has just read the idea and knows what it is about. The
          // first five words of raw typing gave us "Oh idea".
          const title = docm.capTitle(out.title) || docm.titleFrom(ideas[0] ? ideas[0].text : '');
          store.setTitle(slug, title);
          out.doc = docm.setTitle(out.doc, title);
          reread();
        }
        // Written to the sidecar, never to the document: that is the whole guarantee that a copy
        // cannot carry them. `out.doc` is what reaches disk and it has never seen them.
        if (role === 'merge') { store.setSuggestions(slug, suggest ? out.suggestions : []); reread(); }
        await docio.writeDoc(docPath, docm.withConflictBlock(out.doc, sc.conflicts));
        const kind = role === 'polish' ? 'polish' : entryIds.length ? 'merge' : revised.length ? 'revise' : 'resolve';
        const diff = diffSections(lastSnapshot().doc || '', out.doc);
        const snap = store.addSnapshot(slug, { kind, entryIds: touched, doc: out.doc, conflicts: sc.conflicts, changes: out.changes, target: sc.target, call: res.call, diff }, { keepBodies: keepBodies() });
        for (const id of touched) store.updateEntry(slug, id, { status: 'merged', snapshotId: snap.id, error: null });
        reread();
        engineState = { state: 'idle', op: null, model: null, startedAt: 0, error: null };
        publish('landed');
        return;
      }
    } catch (e) {
      fail([...entryIds, ...revised.map((r) => r.entryId)], e.message || String(e));
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

  function submitIdea(text, images = []) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const entry = store.appendEntry(slug, t, images);
    reread();
    queue.push({ kind: 'idea', entryId: entry.id });
    publish('idea');
    return entry;
  }

  /** Rewrite an idea already sent. The document is re-merged so it follows the new wording. */
  function editIdea(entryId, text) {
    const t = String(text == null ? '' : text).trim();
    const e = sc.entries.find((x) => x.id === entryId);
    if (!t || !e || t === e.text) return false;
    const before = e.text;
    store.updateEntry(slug, entryId, { text: t, status: 'pending', error: null, edits: [...(e.edits || []), { ts: Date.now(), text: before }] });
    reread();
    queue.push({ kind: 'revise', entryId, before });
    publish('edit');
    return true;
  }

  function retry(entryId) {
    const e = sc.entries.find((x) => x.id === entryId);
    if (!e || e.status !== 'failed') return false;
    store.updateEntry(slug, entryId, { status: 'pending', error: null });
    reread();
    if (!queue.busy() && !queue.size()) engineState = { state: 'idle', op: null, model: null, startedAt: 0, error: null };
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
    // Pruned versions keep their record but not their text. Refusing is the only honest answer;
    // writing `undefined` would empty the document to save a sidecar some bytes.
    if (snap.bodyDropped || typeof snap.doc !== 'string') return { ok: false, reason: 'that version is too old to restore: only its summary was kept' };
    store.setConflicts(slug, snap.conflicts || []);
    reread();
    await docio.writeDoc(docPath, docm.withConflictBlock(snap.doc, sc.conflicts));
    store.addSnapshot(slug, { kind: 'restore', from: snap.id, entryIds: [], doc: snap.doc, conflicts: sc.conflicts, changes: [`restored ${snap.id}`], target: sc.target }, { keepBodies: keepBodies() });
    reread();
    publish('restore');
    return { ok: true };
  }

  /** Rename the prompt: sidecar title and the document's H1, recorded as its own version. */
  async function rename(title) {
    const t = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
    if (!t || t === sc.title) return false;
    store.setTitle(slug, t);
    reread();
    const body = docm.setTitle(await currentBody(), t);
    await docio.writeDoc(docPath, docm.withConflictBlock(body, sc.conflicts));
    store.addSnapshot(slug, { kind: 'rename', entryIds: [], doc: body, conflicts: sc.conflicts, changes: [`renamed to ${t}`], target: sc.target }, { keepBodies: keepBodies() });
    reread();
    publish('rename');
    return true;
  }

  async function copyText() {
    const raw = await docio.readDoc(docPath);
    const text = docm.stripForCopy(raw == null ? lastSnapshot().doc : raw);
    // Copying is what starts an add-on round: from here, "new" means new relative to this.
    store.setCopyMark(slug, text);
    reread();
    publish('copied');
    return text;
  }

  /**
   * Send the finished prompt to a model and keep the answer. The one thing the forge could never
   * do was show you a prompt working; everything else is a guess about whether it does.
   *
   * It runs on whichever engine is signed in, which is often NOT the family the prompt is written
   * for -- a Claude subscription can polish a prompt for GPT-5. What ran is recorded with the
   * answer rather than implied, because "it worked" means nothing without it.
   */
  async function run() {
    const raw = await docio.readDoc(docPath);
    const prompt = docm.stripForCopy(raw == null ? lastSnapshot().doc : raw);
    if (!prompt.trim()) return { error: 'There is no prompt to run yet.' };
    engineState = { state: 'busy', op: 'run', model: null, startedAt: Date.now(), error: null };
    publish('engine');
    const res = await engine.call({ role: 'run', prompt, timeoutMs: (engineCfg().timeoutSeconds || 240) * 1000 });
    if (disposed) return { error: 'disposed' };
    engineState = res.error
      ? { state: 'error', op: null, model: res.call ? res.call.model : null, startedAt: 0, error: res.error }
      : { state: 'idle', op: null, model: res.call ? res.call.model : null, startedAt: 0, error: null };
    if (res.error) { publish('run'); return { error: res.error }; }
    store.addRun(slug, {
      text: String(res.text || ''),
      target: sc.target,
      provider: res.call ? res.call.provider : null,
      model: res.call ? res.call.model : null,
      ms: res.call ? res.call.ms : 0,
      usage: res.usage || null,
      promptChars: prompt.length,
    });
    reread();
    publish('run');
    return { ok: true };
  }

  /** The addendum since the last copy, or null when there is nothing new. Advances the mark. */
  async function copyNewText() {
    const mark = sc && sc.copied;
    if (!mark) return null;
    const raw = await docio.readDoc(docPath);
    const now = docm.stripForCopy(raw == null ? lastSnapshot().doc : raw);
    const add = buildAddendum(mark.doc, now);
    if (!add.text) return null;
    store.setCopyMark(slug, now);
    reread();
    publish('copied');
    return add;
  }

  /** What the panel needs to decide whether to offer the add-on copy at all. */
  function newSinceCopy() {
    if (!sc || !sc.copied) return null;
    const add = buildAddendum(sc.copied.doc, lastSnapshot().doc);
    return add.text ? { added: add.added, removed: add.removed, restyled: add.restyled } : null;
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
      keepVersions: keepBodies(),
      projects: (sc.projects || []).map((p) => ({ ...p })),
      suggestions: (sc.suggestions || []).map((x) => ({ ...x })),
      copied: sc.copied ? { ts: sc.copied.ts } : null,
      runs: (sc.runs || []).map((r) => ({ ...r })),
      newSinceCopy: newSinceCopy(),
      engine: { ...engineState, queued: queue.size() },
      usage,
    };
  }

  async function idle() {
    while (queue.busy() || queue.size()) await tick();
  }

  return {
    slug, docPath, load, snapshot, submitIdea, editIdea, retry, retryAll,
    // The runtime owns attaching a project (it needs the picker and the engine), so it writes the
    // sidecar and tells the session to pick the change up.
    reread: () => { reread(); },
    resolve: (conflictId, keep) => queue.push({ kind: 'resolve', conflictId, keep }),
    polish: () => queue.push({ kind: 'polish' }),
    setTarget(target) { store.setTarget(slug, target); reread(); queue.push({ kind: 'polish' }); },
    restore, rename, copyText, copyNewText, run, idle,
    dismissSuggestion(text) { store.dismissSuggestion(slug, text); reread(); publish('suggestions'); },
    busy: () => queue.busy() || queue.size() > 0,
    dispose() { disposed = true; queue.clear(); },
  };
}

module.exports = { createSession };
