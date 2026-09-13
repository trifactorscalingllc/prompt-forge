'use strict';
// Connecting a prompt to a project, fast.
//
// A brief used to be one engine call on the polish model before anything counted as connected: a
// cold CLI plus a read of up to 2 MB of project text, so the plug said "connecting…" for half a
// minute. Now connecting reads the project's own files (milliseconds locally, one ssh round trip
// remotely) and attaches a brief written from them on the spot. The engine writes the fuller brief
// in the background and it replaces the quick one when it lands. And an engine brief is remembered
// by folder and commit, so a second prompt connecting to the same project at the same commit gets it
// with no call at all.
const nodePath = require('node:path');
const project = require('./project');

const DAY = 24 * 60 * 60 * 1000;
const noop = () => {};
const keyOf = (dir, host) => `${host || ''}|${dir}`;
const labelOf = (dir, host) => (host ? `${host}:${nodePath.posix.basename(String(dir).replace(/\/+$/, '')) || dir}` : (nodePath.basename(dir) || dir));
const whereOf = (dir, host) => (host ? `${host}:${dir}` : dir);

/**
 * getStore  () => the library store
 * collect   async (dir, host) => { files, tree, text, truncated, head? } | { error }
 * describe  async ({ label, dir, collected }) => { brief, call } | { error }   the engine call
 * gitHead   (dir) => short sha | null, for a local folder
 * onChange  (slug) => void, when a prompt's projects changed in the background
 */
function createBriefs({ getStore, collect, describe, gitHead = () => null, onChange = noop, log = { warn: noop }, now = Date.now }) {
  const cache = new Map();      // key -> { brief, head, files, truncated, builtAt, call }
  const inflight = new Map();   // key -> Promise of the engine's answer
  let seededFrom = null;

  function remember(dir, host, p) {
    const k = keyOf(dir, host);
    const had = cache.get(k);
    if (had && (had.builtAt || 0) > (p.builtAt || 0)) return;
    cache.set(k, { brief: p.brief, head: p.head || null, files: p.files || [], truncated: Boolean(p.truncated), builtAt: p.builtAt || 0, call: p.call || null });
  }

  /** Engine briefs already in the library, from any prompt, so reuse works across a reload too. */
  function seed(store) {
    if (seededFrom === store) return;
    seededFrom = store;
    for (const row of store.list().slice(0, 300)) {
      const sc = store.read(row.slug);
      for (const p of (sc && sc.projects) || []) {
        if (p.brief && p.briefKind !== 'quick' && !p.error) remember(p.path, p.host, p);
      }
    }
  }

  const fresh = (hit, head) => Boolean(hit && hit.brief && (head ? hit.head === head : now() - (hit.builtAt || 0) < DAY));

  /** Attach `dir` (on `host`) to a prompt. Resolves once the project is connected: { record, reused, error }. */
  async function attach(slug, dir, host = null, { force = false, engineReady = true } = {}) {
    const store = getStore();
    const label = labelOf(dir, host);
    const where = whereOf(dir, host);
    const same = (p) => p.path === dir && (p.host || null) === (host || null);
    let collected;
    try { collected = await collect(dir, host); } catch (e) { collected = { error: e.message }; }
    const list = (store.read(slug).projects || []).filter((p) => !same(p));
    const base = { id: `p${now().toString(36)}`, label, path: dir, ...(host ? { host } : {}) };

    if (!collected || collected.error || !(collected.files || []).length) {
      const error = (collected && collected.error) || `Nothing readable in ${where}. A project needs a README or a manifest to describe itself.`;
      const record = { ...base, brief: '', builtAt: 0, head: null, files: [], error };
      store.setProjects(slug, [...list, record]);
      return { record, reused: false, error };
    }

    const head = host ? collected.head || null : gitHead(dir);
    seed(store);
    const hit = force ? null : cache.get(keyOf(dir, host));
    const reused = fresh(hit, head);
    const record = reused
      ? { ...base, brief: hit.brief, briefKind: 'engine', builtAt: hit.builtAt, head, files: hit.files, truncated: hit.truncated, call: hit.call, error: null }
      : { ...base, brief: project.quickBrief({ label, dir: where, collected }), briefKind: 'quick', builtAt: now(), head, files: collected.files, truncated: Boolean(collected.truncated), call: null, error: null };
    store.setProjects(slug, [...list, record]);
    if (!reused && engineReady) refine(slug, record, collected, where);
    return { record, reused, error: null };
  }

  /** The engine's brief, in the background. One call per project however many prompts are waiting on it. */
  function refine(slug, record, collected, where) {
    const k = keyOf(record.path, record.host);
    let job = inflight.get(k);
    if (!job) {
      job = Promise.resolve()
        .then(() => describe({ label: record.label, dir: where, collected }))
        .catch((e) => ({ error: e.message }))
        .then((r) => {
          if (r && r.brief && !r.error) remember(record.path, record.host, { ...r, head: record.head, files: collected.files, truncated: collected.truncated, builtAt: now() });
          return r || { error: 'no answer' };
        });
      inflight.set(k, job);
      job.then(() => { if (inflight.get(k) === job) inflight.delete(k); });
    }
    job.then((r) => {
      if (r.error || !r.brief) {
        log.warn(`project brief for ${record.label}: ${r.error || 'empty'}; keeping the quick brief`);
        onChange(slug);
        return;
      }
      const store = getStore();
      const sc = store && store.exists(slug) ? store.read(slug) : null;
      const list = (sc && sc.projects) || [];
      const at = list.findIndex((p) => p.id === record.id);
      // Disconnected or connected again meanwhile: that record is not this one any more.
      if (at < 0) return;
      list[at] = { ...list[at], brief: r.brief, briefKind: 'engine', builtAt: now(), call: r.call || null };
      store.setProjects(slug, list);
      onChange(slug);
    });
  }

  return {
    attach,
    refining: (dir, host) => inflight.has(keyOf(dir, host)),
    idle: () => Promise.all([...inflight.values()]),
  };
}

module.exports = { createBriefs, labelOf, whereOf };
