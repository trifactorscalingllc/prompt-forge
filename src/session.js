'use strict';
// One prompt's controller: the queue, the store, the document and the engine, and the rules that
// keep an idea from ever being lost or a hand edit from ever being overwritten.
const nodeFs = require('node:fs');
const { createQueue } = require('./queue');
const docm = require('./doc');
const targets = require('./targets');
const { buildMergePrompt, buildPolishPrompt, mergeSystem } = require('./engine/prompt');
const { buildAddendum, diffSections } = require('./addendum');
const { parseEngineOutput } = require('./engine/output');
const { formatDoc } = require('./engine/format');
const S = require('./engine/sections');
const { forEngine } = require('./attachments');
const { findVars, fillVars } = require('./vars');
const projectMod = require('./project');

// Injected so a session test never touches a real filesystem.
const defaultLookup = (dir, idea) => projectMod.lookup(dir, idea, { fs: nodeFs });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));
const publicConflict = (c) => ({ id: c.id, section: c.section, existing: c.existing, incoming: c.incoming });
const oneLine = (s, max) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max - 1)}…` : t; };
const idleState = () => ({ state: 'idle', op: null, model: null, startedAt: 0, error: null, progress: null });

/**
 * Text that can stand in the prompt as it is: a sentence or a list item, not a remark to the tool.
 * "Keep new" is placed without a model only when the incoming side reads like this; "but i dont
 * want to market it as lead generation" is an instruction, and dropping it verbatim into a Context
 * paragraph would be worse than the call it saves.
 */
function documentReady(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 2000) return false;
  if (/^(but|and|so|also|actually|no|nah|maybe|i|i'm|im|we|let's|lets|oh|ok|okay|hmm|wait|instead)\b/i.test(t)) return false;
  const shaped = /^([-*]\s+|\d+[.)]\s+)/.test(t) || (/^[A-Z"'(`]/.test(t) && /[.!?:)`"']$/.test(t));
  return shaped;
}

/** Conflict answers that need no model: keep old always, keep new when it can be placed exactly. Pure. */
function resolveLocally(body, resolutions, conflicts) {
  let doc = body;
  const applied = [];
  const remaining = [];
  for (const r of resolutions) {
    const c = conflicts.find((x) => x.id === r.conflictId);
    if (!c) continue;   // already closed, by hand or by an earlier merge
    if (r.keep === 'old') { applied.push(r); continue; }
    const existing = String(c.existing || '').trim();
    const incoming = String(c.incoming || '').trim();
    const at = existing ? doc.indexOf(existing) : -1;
    if (at >= 0 && doc.indexOf(existing, at + 1) < 0 && documentReady(incoming)) {
      doc = `${doc.slice(0, at)}${incoming}${doc.slice(at + existing.length)}`;
      applied.push(r);
      continue;
    }
    remaining.push(r);
  }
  return { doc, applied, remaining };
}

/** Which sections of `after` differ from `before`, by name as `after` writes them. Pure. */
function changedSections(before, after) {
  const A = S.parse(before);
  const B = S.parse(after);
  const text = (s) => S.trimBlank(s.body).join('\n');
  const names = [];
  const preA = S.trimBlank(A.preamble).join('\n');
  const preB = S.trimBlank(B.preamble).join('\n');
  if (preB && preA !== preB) names.push('(preamble)');
  const was = new Map(A.sections.filter((s) => s.kind !== 'loose').map((s) => [S.keyOf(s.name), text(s)]));
  let total = 0;
  for (const s of B.sections) {
    if (s.kind === 'loose') continue;
    total += 1;
    const k = S.keyOf(s.name);
    if (!was.has(k) || was.get(k) !== text(s)) names.push(s.name);
  }
  return { names, total };
}

const quotePath = (p) => (/\s/.test(p) ? `"${p}"` : p);

function createSession({ slug, store, docio, engine, cfg, log, publish = () => {}, settleMs = 450, lookupFor = defaultLookup, fs = nodeFs, readOnly = false }) {
  const docPath = store.docPath(slug);
  let sc = null;
  let disposed = false;
  let engineState = idleState();
  // readOnly: a window that joined someone else's live library. It reads the sharer's copy and never
  // writes it or runs the engine on it; what it asks for goes to the sharer. Copy and send marks are
  // the one thing it keeps for itself, because what "new since I copied" means is per person.
  const localMarks = {};

  const reread = () => {
    sc = store.read(slug);
    if (sc && readOnly) { sc.copied = localMarks.copied || null; sc.sent = localMarks.sent || null; }
    return sc;
  };
  const lastSnapshot = () => sc.snapshots[sc.snapshots.length - 1];
  const engineCfg = () => (cfg() && cfg().engine) || {};
  const keepBodies = () => {
    const n = (cfg() || {}).keepVersionBodies;
    return Number.isFinite(n) ? n : 20;
  };
  const mergeMode = () => (engineCfg().mergeOutput === 'document' ? 'document' : 'edits');
  const timeoutMs = () => (engineCfg().timeoutSeconds || 240) * 1000;
  const suggesting = () => (cfg() || {}).suggestions !== false;
  const isUntitled = () => /^Untitled( \d+)?$/.test(sc.title) && !sc.entries.some((e) => e.status === 'merged');

  const queue = createQueue({
    run: runBatch,
    onChange: () => publish('queue'),
    onError: (e) => log.error(`${slug}: batch failed: ${e.stack || e.message}`),
  });

  // Streaming progress arrives many times a second; the panel needs it a few times a second.
  let lastProgress = 0;
  let progressTimer = null;
  function progress(p) {
    if (disposed || engineState.state !== 'busy') return;
    engineState.progress = { ...p };
    const due = 250 - (Date.now() - lastProgress);
    if (due <= 0) { lastProgress = Date.now(); publish('progress'); return; }
    if (!progressTimer) {
      progressTimer = setTimeout(() => {
        progressTimer = null;
        lastProgress = Date.now();
        if (!disposed && engineState.state === 'busy') publish('progress');
      }, due);
    }
  }

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

  function recordHandEdit(body) {
    if (body === lastSnapshot().doc) return;
    store.addSnapshot(slug, { kind: 'hand-edit', entryIds: [], doc: body, conflicts: sc.conflicts, changes: [], target: sc.target }, { keepBodies: keepBodies() });
    reread();
    publish('hand-edit');
  }

  function fail(entryIds, error, call) {
    for (const id of entryIds) store.updateEntry(slug, id, { status: 'failed', error });
    reread();
    engineState = { ...idleState(), state: 'error', model: call ? call.model : null, error };
    log.error(`${slug}: ${error}`);
    publish('failed');
  }

  /** Write the document, record the version, and mark the ideas it carries as merged. */
  async function land({ kind, doc, touched = [], changes = [], call = null }) {
    await docio.writeDoc(docPath, docm.withConflictBlock(doc, sc.conflicts));
    const diff = diffSections(lastSnapshot().doc || '', doc);
    const snap = store.addSnapshot(slug, { kind, entryIds: touched, doc, conflicts: sc.conflicts, changes, target: sc.target, call, diff }, { keepBodies: keepBodies() });
    for (const id of touched) store.updateEntry(slug, id, { status: 'merged', snapshotId: snap.id, error: null });
    reread();
    return snap;
  }

  async function runBatch(batch) {
    if (disposed || readOnly) return;
    reread();
    const role = batch.kind === 'polish' ? 'polish' : 'merge';
    engineState = { ...idleState(), state: 'busy', op: role, startedAt: Date.now() };
    publish('engine');
    const touched = [...(batch.entryIds || []), ...(batch.revisions || []).map((r) => r.entryId)];
    try {
      if (role === 'polish') await runPolish(batch);
      else await runMerge(batch);
    } catch (e) {
      fail(touched, e.message || String(e));
    }
  }

  async function runMerge(batch) {
    const entryIds = batch.entryIds || [];
    const revised = batch.revisions || [];
    const touched = [...entryIds, ...revised.map((r) => r.entryId)];
    let resolutions = batch.resolutions || [];
    let mode = mergeMode();
    let reranForEdit = false;
    let fellBack = false;
    for (let guard = 0; guard < 4; guard += 1) {
      // A formatted editor writes hand edits with a short debounce; give the last keystrokes time to land.
      if (settleMs) await sleep(settleMs);
      let body = await currentBody();
      recordHandEdit(body);

      // Answers to conflicts that need no model are placed before anything is sent, so a click on
      // "keep old" lands in the time it takes to write a file.
      if (resolutions.length) {
        const local = resolveLocally(body, resolutions, sc.conflicts);
        if (local.applied.length) {
          for (const a of local.applied) store.resolveConflict(slug, a.conflictId, a.keep, { by: 'local' });
          reread();
          const doc = local.doc === body ? body : formatDoc(local.doc);
          await land({ kind: 'resolve', doc, changes: local.applied.map((a) => `${a.conflictId}: kept ${a.keep}`) });
          publish('landed');
          body = doc;
        }
        resolutions = local.remaining;
        if (!touched.length && !resolutions.length) { engineState = idleState(); publish('landed'); return; }
      }

      const target = targets.resolve(sc.target);
      const caps = typeof engine.capabilities === 'function' ? engine.capabilities() : { image: false, pdf: false };
      const ideas = entryIds.map((id) => sc.entries.find((e) => e.id === id)).filter(Boolean)
        .map((e) => ({ ...e, attached: (e.attachments || []).length ? forEngine(e.attachments, { fs, caps }) : null }));
      const blocks = ideas.flatMap((i) => (i.attached ? i.attached.blocks : []));
      const recentN = Number.isFinite(engineCfg().recentEntries) ? engineCfg().recentEntries : 12;
      const merged = sc.entries.filter((e) => e.status === 'merged');
      const conflicts = sc.conflicts.map(publicConflict);
      const revisions = revised.map((r) => { const e = sc.entries.find((x) => x.id === r.entryId); return e ? { id: e.id, before: r.before, after: e.text } : null; }).filter(Boolean);
      const projects = sc.projects || [];
      // Opt-in and per idea. It costs a filesystem scan on every Enter, which is exactly why it
      // is off by default and why an empty result is a normal, silent outcome.
      let excerpts = [];
      if (((cfg() || {}).project || {}).context === 'brief+lookup') {
        const dir = projects.find((p) => p.path && !p.error && !p.host);
        if (dir) {
          try { excerpts = lookupFor(dir.path, ideas.map((i) => i.text).join(' ')); } catch { excerpts = []; }
        }
      }
      const suggest = suggesting();
      const built = buildMergePrompt({
        doc: body, ideas, resolutions, revisions, conflicts, recent: merged.slice(-recentN), target, projects, excerpts,
        needsTitle: entryIds.length > 0 && isUntitled(), suggest, sectionNames: targets.sectionsFor(target.family), mergedTotal: merged.length, mode,
      });

      const res = await engine.call({ role: 'merge', system: built.system, prompt: built.prompt, blocks, timeoutMs: timeoutMs(), onProgress: progress });
      if (disposed) return;
      if (res.call) engineState.model = res.call.model;
      if (res.error) return fail(touched, res.error, res.call);
      const out = parseEngineOutput(res.text, { kind: 'merge', inputDoc: body });
      if (!out.ok) {
        // The engine answered, but with edits that cannot be placed without guessing. One more call
        // for the whole document is cheaper than an idea marked failed.
        if (out.retryWithDocument && mode === 'edits' && !fellBack) {
          fellBack = true;
          mode = 'document';
          log.info(`${slug}: ${out.error}; asking for the whole document`);
          continue;
        }
        return fail(touched, out.error, res.call);
      }

      // Did the person edit while the engine was thinking? Never overwrite that: run once more.
      const nowRaw = await docio.readDoc(docPath);
      const nowBody = nowRaw == null ? body : docm.stripConflictBlock(nowRaw);
      if (nowBody !== body && !reranForEdit) {
        reranForEdit = true;
        log.info(`${slug}: document changed during the call; merging again`);
        publish('notice:The document changed while the engine was working. Merging again.');
        continue;
      }

      // Only a merge may change the open-conflict list. A polish that returns none (or forgets
      // the key) must not make a contradiction disappear; that is the one thing this tool is for.
      for (const r of resolutions) store.resolveConflict(slug, r.conflictId, r.keep, { by: 'engine' });
      reread();
      store.setConflicts(slug, out.conflicts, { entryId: entryIds.length ? entryIds[entryIds.length - 1] : null });
      reread();
      // The title is the document's own, whatever the reply did with it: put back if dropped, restored if reworded.
      let doc = formatDoc(docm.ensureTitle(out.doc, docm.titleOf(body) || sc.title));
      // An untitled prompt takes its name from the first idea that lands.
      if (entryIds.length && isUntitled()) {
        // The engine names it, because it has just read the idea and knows what it is about. The
        // first five words of raw typing gave us "Oh idea".
        const title = docm.capTitle(out.title) || docm.titleFrom(ideas[0] ? ideas[0].text : '');
        store.setTitle(slug, title);
        doc = docm.setTitle(doc, title);
        reread();
      }
      // Written to the sidecar, never to the document: that is the whole guarantee that a copy
      // cannot carry them. `doc` is what reaches disk and it has never seen them.
      store.setSuggestions(slug, suggest ? out.suggestions : []);
      store.setIdeas(slug, suggest ? out.ideas : []);
      reread();
      const kind = entryIds.length ? 'merge' : revised.length ? 'revise' : 'resolve';
      await land({ kind, doc, touched, changes: out.changes, call: res.call });
      engineState = idleState();
      publish('landed');
      return;
    }
  }

  async function runPolish(batch) {
    let full = Boolean(batch.full);
    let reranForEdit = false;
    let fellBack = false;
    for (let guard = 0; guard < 4; guard += 1) {
      if (settleMs) await sleep(settleMs);
      const body = await currentBody();
      recordHandEdit(body);
      const target = targets.resolve(sc.target);

      // Polish -> merge -> polish is the normal loop. When the target is the one this was last
      // polished for, everything that has not changed since is already in shape: rewrite only
      // what moved, and nothing at all when nothing did.
      let only = [];
      const mark = sc.polished;
      if (!full && mark && mark.target === sc.target && typeof mark.doc === 'string') {
        const ch = changedSections(mark.doc, body);
        if (!ch.names.length) {
          engineState = idleState();
          publish(`notice:Nothing has changed since this was polished for ${target.label}. Alt+click Polish to rewrite all of it again.`);
          return;
        }
        // Past half the document, a partial rewrite costs what a whole one does and reads less evenly.
        if (ch.names.length * 2 <= Math.max(ch.total, 1)) only = ch.names;
      }

      const conflicts = sc.conflicts.map(publicConflict);
      // A whole-document polish writes fresh advice for the target it polished for. A partial one keeps
      // the merge's advice, which was already written for this target.
      const suggest = suggesting() && !only.length;
      const previousTarget = batch.from && batch.from !== sc.target ? targets.resolve(batch.from) : null;
      const built = buildPolishPrompt({ doc: body, conflicts, target, styleGuide: targets.styleGuide(target.family), projects: sc.projects || [], only, suggest, previousTarget });
      const res = await engine.call({ role: 'polish', system: built.system, prompt: built.prompt, timeoutMs: timeoutMs(), onProgress: progress });
      if (disposed) return;
      if (res.call) engineState.model = res.call.model;
      if (res.error) return fail([], res.error, res.call);
      const out = parseEngineOutput(res.text, { kind: 'polish', inputDoc: body });
      if (!out.ok) {
        if (only.length && !fellBack) { fellBack = true; full = true; continue; }
        return fail([], out.error, res.call);
      }
      const nowRaw = await docio.readDoc(docPath);
      const nowBody = nowRaw == null ? body : docm.stripConflictBlock(nowRaw);
      if (nowBody !== body && !reranForEdit) {
        reranForEdit = true;
        publish('notice:The document changed while the engine was working. Polishing again.');
        continue;
      }
      // The guide's shape, guaranteed: whatever the model returned, the headings, the order and the
      // tags are the family's own.
      // The style guide opens with a framing sentence, and a model writing one tends to drop or reword
      // the "# Title" line above it. The title is not the polish's to change.
      const doc = formatDoc(docm.ensureTitle(out.doc, docm.titleOf(body) || sc.title), { family: target.family });
      await land({ kind: 'polish', doc, changes: out.changes.length ? out.changes : only.length ? [`rewrote ${only.join(', ')}`] : [], call: res.call });
      if (suggest) {
        store.setSuggestions(slug, out.suggestions);
        store.setIdeas(slug, out.ideas);
      }
      store.setPolished(slug, { doc, target: sc.target });
      reread();
      engineState = idleState();
      publish('landed');
      return;
    }
  }

  async function load() {
    if (!reread()) throw new Error(`no prompt named "${slug}"`);
    // In a joined library a pending idea is being merged in the sharer's window right now.
    if (readOnly) { publish('load'); return sc; }
    // A pending entry at load time means a reload or crash cut a merge short. The idea is still here.
    for (const e of sc.entries) {
      if (e.status === 'pending') store.updateEntry(slug, e.id, { status: 'failed', error: 'interrupted: the extension reloaded during the merge' });
    }
    reread();
    if ((await docio.readDoc(docPath)) == null) await docio.writeDoc(docPath, docm.withConflictBlock(lastSnapshot().doc, sc.conflicts));
    publish('load');
    return sc;
  }

  function submitIdea(text, attachments = [], { by = null } = {}) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return null;
    const entry = store.appendEntry(slug, t, attachments, { by });
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
    if (!queue.busy() && !queue.size()) engineState = idleState();
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

  // ------------------------------------------------------------------------------------------
  // Leaving the tool: copy, send, run
  //
  // What leaves is the document without its conflict block, with {{variables}} filled, and -- when
  // ideas carried files -- a list of those files: each by name, the idea it came with, and where it
  // is. A clipboard cannot hold text and files at once, so the list is what ties a file to the line
  // of the prompt that mentions it; for a Claude Code destination the paths are @-mentions, which
  // Claude Code opens itself.
  // ------------------------------------------------------------------------------------------

  /** Files from ideas that made it into the prompt, oldest first. */
  function mergedFiles() {
    const out = [];
    for (const e of (sc && sc.entries) || []) {
      if (e.status !== 'merged') continue;
      for (const a of e.attachments || []) out.push({ name: a.name, kind: a.kind, path: a.path, idea: e.text, entryId: e.id, secret: Boolean(a.secret) });
    }
    return out;
  }

  function compose(doc, { mention = false } = {}) {
    const body = fillVars(docm.stripForCopy(doc), sc.vars).text.replace(/\n+$/, '');
    const files = mergedFiles();
    if (!files.length) return `${body}\n`;
    const what = (k) => (k === 'image' ? 'image' : k === 'pdf' ? 'PDF' : k === 'text' ? 'text file' : 'file');
    const lines = files.map((f) => `- ${f.name} (${what(f.kind)}, from the idea "${oneLine(f.idea, 90)}"): ${mention ? `@${quotePath(f.path)}` : f.path}`);
    const lead = mention ? 'Attached files, referred to above by name:' : 'Attached files, referred to above by name. Attach them alongside this prompt:';
    return `${body}\n\n${lead}\n${lines.join('\n')}\n`;
  }

  async function liveDoc() {
    const raw = await docio.readDoc(docPath);
    return raw == null ? lastSnapshot().doc : raw;
  }

  async function copyText() {
    const text = compose(await liveDoc());
    // Copying is what starts an add-on round: from here, "new" means new relative to this.
    if (readOnly) localMarks.copied = { doc: text, ts: Date.now() }; else store.setCopyMark(slug, text);
    reread();
    publish('copied');
    return text;
  }

  /** The addendum since the last copy, or null when there is nothing new. Advances the mark. */
  async function copyNewText() {
    const mark = sc && sc.copied;
    if (!mark) return null;
    const now = compose(await liveDoc());
    const add = buildAddendum(mark.doc, now);
    if (!add.text) return null;
    if (readOnly) localMarks.copied = { doc: now, ts: Date.now() }; else store.setCopyMark(slug, now);
    reread();
    publish('copied');
    return add;
  }

  /** What the panel needs to decide whether to offer the add-on copy at all. */
  function newSince(key, opts) {
    const mark = sc && sc[key];
    if (!mark) return null;
    const add = buildAddendum(mark.doc, compose(lastSnapshot().doc, opts));
    return add.text ? { added: add.added, removed: add.removed, restyled: add.restyled } : null;
  }

  /** The whole prompt for a send, with files as @-mentions. The mark moves when the runtime says it went. */
  async function sendText() { return compose(await liveDoc(), { mention: true }); }
  async function sendNewText() {
    const mark = sc && sc.sent;
    if (!mark) return null;
    const add = buildAddendum(mark.doc, compose(await liveDoc(), { mention: true }));
    return add.text ? add : null;
  }
  async function markSent(dest) {
    const text = compose(await liveDoc(), { mention: true });
    if (readOnly) localMarks.sent = { doc: text, ts: Date.now(), dest: dest || null }; else store.setSentMark(slug, text, dest);
    reread();
    publish('sent');
  }

  function variables() {
    return { names: findVars(docm.stripForCopy(lastSnapshot().doc)), values: { ...(sc.vars || {}) } };
  }

  function setVars(values) {
    store.setVars(slug, values);
    reread();
    publish('vars');
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
    const prompt = fillVars(docm.stripForCopy(await liveDoc()), sc.vars).text;
    if (!prompt.trim()) return { error: 'There is no prompt to run yet.' };
    const caps = typeof engine.capabilities === 'function' ? engine.capabilities() : { image: false, pdf: false };
    const files = mergedFiles().map((f) => ({ name: f.name, path: f.path, kind: f.kind, secret: f.secret }));
    const att = files.length ? forEngine(files, { fs, caps }) : { blocks: [], texts: [] };
    const inline = att.texts.map((t) => `<attachment name=${JSON.stringify(t.name)}>\n${t.text}\n</attachment>`).join('\n\n');
    engineState = { ...idleState(), state: 'busy', op: 'run', startedAt: Date.now() };
    publish('engine');
    const res = await engine.call({ role: 'run', prompt: inline ? `${prompt}\n${inline}\n` : prompt, blocks: att.blocks, timeoutMs: timeoutMs(), onProgress: progress });
    if (disposed) return { error: 'disposed' };
    engineState = res.error
      ? { ...idleState(), state: 'error', model: res.call ? res.call.model : null, error: res.error }
      : { ...idleState(), model: res.call ? res.call.model : null };
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

  /** Start the engine process the next merge will use, while the person is still typing. */
  function warm() {
    if (disposed || typeof engine.warm !== 'function') return false;
    return engine.warm({ role: 'merge', system: mergeSystem(mergeMode()) });
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
      resolved: (sc.resolved || []).map((r) => ({ ...r })),
      keepVersions: keepBodies(),
      projects: (sc.projects || []).map((p) => ({ ...p })),
      suggestions: (sc.suggestions || []).map((x) => ({ ...x })),
      ideas: (sc.ideas || []).map((x) => ({ ...x })),
      copied: sc.copied ? { ts: sc.copied.ts } : null,
      sent: sc.sent ? { ts: sc.sent.ts, dest: sc.sent.dest } : null,
      polished: sc.polished ? { target: sc.polished.target, ts: sc.polished.ts } : null,
      runs: (sc.runs || []).map((r) => ({ ...r })),
      files: mergedFiles().map(({ secret, ...f }) => f),
      vars: variables(),
      newSinceCopy: newSince('copied'),
      newSinceSend: newSince('sent', { mention: true }),
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
    polish: ({ full = false } = {}) => queue.push({ kind: 'polish', ...(full ? { full: true } : {}) }),
    setTarget(target) {
      const from = sc.target;
      if (String(target) === from) return;
      store.setTarget(slug, target);
      // Advice written for the old target names it and its gaps. It goes the moment the target changes,
      // and the polish that follows writes new advice for the new one.
      store.setSuggestions(slug, []);
      store.setIdeas(slug, []);
      reread();
      publish('suggestions');
      queue.push({ kind: 'polish', from });
    },
    restore, rename, copyText, copyNewText, sendText, sendNewText, markSent, variables, setVars, run, idle, warm,
    progress: () => ({ ...engineState, queued: queue.size() }),
    dismissSuggestion(text) { store.dismissSuggestion(slug, text); reread(); publish('suggestions'); },
    dismissIdea(text) { store.dismissIdea(slug, text); reread(); publish('suggestions'); },
    busy: () => queue.busy() || queue.size() > 0,
    dispose() { disposed = true; clearTimeout(progressTimer); queue.clear(); },
  };
}

module.exports = { createSession, resolveLocally, documentReady, changedSections };
