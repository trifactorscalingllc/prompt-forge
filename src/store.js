'use strict';
// The prompt library on disk: `<slug>.md` (the document the person edits) and `<slug>.forge.json`
// (everything else: entries, snapshots, conflicts). Plain files, atomic writes, no database.
// Everything here is synchronous on purpose: the writes are small and a half-written sidecar is
// the one failure this module must never produce.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seed } = require('./doc');
const { DEFAULT_TARGET } = require('./targets');

function expandHome(p, home = os.homedir()) {
  const s = String(p == null ? '' : p).trim();
  if (s === '~') return home;
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(home, s.slice(2));
  return s;
}

function slugify(title) {
  const s = String(title == null ? '' : title)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'prompt';
}

function nextId(list, prefix) {
  let max = 0;
  for (const it of list) {
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(it && it.id));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `${prefix}${max + 1}`;
}

function readJson(p) {
  try {
    const v = JSON.parse(fs.readFileSync(p, 'utf8'));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`);
  fs.renameSync(tmp, p);
}

function open(libraryPath, { home } = {}) {
  const dir = expandHome(libraryPath, home);
  fs.mkdirSync(dir, { recursive: true });

  // Strictly increasing stamps within one store, so "newest first" is never a coin toss when two
  // writes land in the same millisecond.
  let last = 0;
  const now = () => { last = Math.max(Date.now(), last + 1); return last; };

  const docPath = (slug) => path.join(dir, `${slug}.md`);
  const sidecarPath = (slug) => path.join(dir, `${slug}.forge.json`);
  const exists = (slug) => fs.existsSync(sidecarPath(slug)) || fs.existsSync(docPath(slug));

  function read(slug) {
    const sc = readJson(sidecarPath(slug));
    if (!sc || sc.version !== 1) return null;
    for (const k of ['entries', 'snapshots', 'conflicts', 'resolved', 'projects', 'suggestions', 'dismissed']) if (!Array.isArray(sc[k])) sc[k] = [];
    return sc;
  }

  function write(slug, sc) {
    sc.updatedAt = now();
    writeJson(sidecarPath(slug), sc);
    return sc;
  }

  function withSidecar(slug, fn) {
    const sc = read(slug);
    if (!sc) throw new Error(`no prompt named "${slug}" in ${dir}`);
    const out = fn(sc);
    write(slug, sc);
    return out;
  }

  function create(title, { target } = {}) {
    const base = slugify(title);
    let slug = base;
    for (let n = 2; exists(slug); n++) slug = `${base}-${n}`;
    const t = now();
    const body = seed(title);
    fs.writeFileSync(docPath(slug), body);
    const sc = {
      version: 1,
      slug,
      title: String(title),
      target: target || DEFAULT_TARGET,
      createdAt: t,
      updatedAt: t,
      entries: [],
      snapshots: [{ id: 's1', ts: t, kind: 'seed', entryIds: [], doc: body, conflicts: [], changes: [], target: target || DEFAULT_TARGET, call: null }],
      conflicts: [],
      resolved: [],
    };
    writeJson(sidecarPath(slug), sc);
    return { slug, sidecar: sc };
  }

  // list() runs on every state push and a sidecar carries every version of its document, so a
  // row is re-parsed only when the file's mtime or size moved.
  const rows = new Map();
  let parsed = 0;

  function list() {
    const out = [];
    const seen = new Set();
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.forge.json')) continue;
      const slug = name.slice(0, -'.forge.json'.length);
      seen.add(slug);
      let st;
      try { st = fs.statSync(path.join(dir, name)); } catch { continue; }
      const cached = rows.get(slug);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) { out.push(cached.row); continue; }
      const sc = read(slug);
      parsed += 1;
      if (!sc) { rows.delete(slug); continue; }
      const row = {
        slug,
        title: sc.title,
        target: sc.target,
        updatedAt: sc.updatedAt,
        createdAt: sc.createdAt,
        entries: sc.entries.length,
        openConflicts: sc.conflicts.length,
      };
      rows.set(slug, { mtimeMs: st.mtimeMs, size: st.size, row });
      out.push(row);
    }
    for (const slug of rows.keys()) if (!seen.has(slug)) rows.delete(slug);
    return out.sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt) || a.slug.localeCompare(b.slug));
  }

  const stats = () => ({ parsed, cached: rows.size });

  function appendEntry(slug, text) {
    return withSidecar(slug, (sc) => {
      const entry = { id: nextId(sc.entries, 'e'), ts: now(), text: String(text), status: 'pending', snapshotId: null, error: null };
      sc.entries.push(entry);
      return entry;
    });
  }

  function updateEntry(slug, id, patch) {
    return withSidecar(slug, (sc) => {
      const e = sc.entries.find((x) => x.id === id);
      if (e) Object.assign(e, patch);
      return e || null;
    });
  }

  function addSnapshot(slug, { kind, entryIds = [], doc, conflicts = [], changes = [], target, call = null, from = null, diff = null }) {
    return withSidecar(slug, (sc) => {
      const snap = { id: nextId(sc.snapshots, 's'), ts: now(), kind, entryIds, doc, conflicts, changes, target: target || sc.target, call, from, diff };
      sc.snapshots.push(snap);
      return snap;
    });
  }

  const setTarget = (slug, target) => withSidecar(slug, (sc) => { sc.target = target; return sc.target; });
  const setTitle = (slug, title) => withSidecar(slug, (sc) => { sc.title = String(title); return sc.title; });
  // An allow-list the person wrote one path at a time. Replaced wholesale so a detach cannot leave
  // a half-removed entry behind.
  const setProjects = (slug, projects) => withSidecar(slug, (sc) => { sc.projects = Array.isArray(projects) ? projects : []; return sc.projects; });
  // Suggestions live here and never in the .md, so a copy cannot carry them and a hand edit cannot
  // accidentally save one into the prompt. `dismissed` holds the text of ones waved away, because
  // every merge regenerates the list and an unremembered dismissal would nag.
  // The document as it stood when it was last copied out. Everything the add-on copy reports is
  // measured from here, so a copy is the only thing that moves it.
  const setCopyMark = (slug, doc) => withSidecar(slug, (sc) => { sc.copied = { doc: String(doc == null ? '' : doc), ts: now() }; return sc.copied; });
  const setSuggestions = (slug, list) => withSidecar(slug, (sc) => {
    const gone = new Set(sc.dismissed || []);
    sc.suggestions = (Array.isArray(list) ? list : []).filter((x) => x && x.text && !gone.has(x.text));
    return sc.suggestions;
  });
  const dismissSuggestion = (slug, text) => withSidecar(slug, (sc) => {
    const t = String(text || '');
    if (t && !sc.dismissed.includes(t)) sc.dismissed.push(t);
    sc.suggestions = sc.suggestions.filter((x) => x && x.text !== t);
    return sc.suggestions;
  });

  function setConflicts(slug, conflicts, { entryId = null } = {}) {
    return withSidecar(slug, (sc) => {
      const prev = new Map(sc.conflicts.map((c) => [c.id, c]));
      sc.conflicts = (conflicts || []).map((c) => {
        const was = prev.get(c.id);
        return {
          id: c.id,
          section: c.section || '',
          existing: c.existing || '',
          incoming: c.incoming || '',
          raisedAt: was ? was.raisedAt : now(),
          entryId: was ? was.entryId : entryId,
        };
      });
      return sc.conflicts;
    });
  }

  function resolveConflict(slug, id, keep) {
    return withSidecar(slug, (sc) => {
      const i = sc.conflicts.findIndex((c) => c.id === id);
      if (i < 0) return null;
      const [c] = sc.conflicts.splice(i, 1);
      sc.resolved.push({ id: c.id, keep, ts: now(), section: c.section, existing: c.existing, incoming: c.incoming });
      return c;
    });
  }

  function remove(slug) {
    const trash = path.join(dir, '.trash');
    fs.mkdirSync(trash, { recursive: true });
    const stamp = now();
    const moved = [];
    for (const [src, ext] of [[docPath(slug), '.md'], [sidecarPath(slug), '.forge.json']]) {
      if (!fs.existsSync(src)) continue;
      const dest = path.join(trash, `${slug}-${stamp}${ext}`);
      fs.renameSync(src, dest);
      moved.push(dest);
    }
    return moved;
  }

  const readDoc = (slug) => (fs.existsSync(docPath(slug)) ? fs.readFileSync(docPath(slug), 'utf8') : null);
  const writeDoc = (slug, text) => fs.writeFileSync(docPath(slug), text);

  return {
    dir, docPath, sidecarPath, exists, read, write, create, list, stats,
    appendEntry, updateEntry, addSnapshot, setTarget, setTitle, setProjects, setCopyMark, setSuggestions, dismissSuggestion, setConflicts, resolveConflict, remove,
    readDoc, writeDoc,
  };
}

module.exports = { open, expandHome, slugify };
