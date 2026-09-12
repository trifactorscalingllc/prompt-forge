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
    for (const k of ['entries', 'snapshots', 'conflicts', 'resolved', 'projects', 'suggestions', 'dismissed', 'runs']) if (!Array.isArray(sc[k])) sc[k] = [];
    // Absolute paths are rebuilt here rather than trusted from the file. A library synced between
    // machines carries the same JSON to a different home directory and a different library root.
    for (const e of sc.entries) {
      if (!Array.isArray(e.images)) { e.images = []; continue; }
      for (const im of e.images) im.path = imagePath(slug, im);
    }
    for (const p of sc.projects) {
      if (p.portable && !fs.existsSync(String(p.path || ''))) {
        const here = resolvePortable(p.portable);
        if (fs.existsSync(here)) p.path = here;
      }
    }
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

  function create(title, { target, body: seedBody } = {}) {
    const base = slugify(title);
    let slug = base;
    for (let n = 2; exists(slug); n++) slug = `${base}-${n}`;
    const t = now();
    const body = seedBody || seed(title);
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

  function appendEntry(slug, text, images = []) {
    return withSidecar(slug, (sc) => {
      const keep = (Array.isArray(images) ? images : []).map(({ id, file, name, bytes }) => ({ id, file, name, bytes }));
      const entry = { id: nextId(sc.entries, 'e'), ts: now(), text: String(text), status: 'pending', snapshotId: null, error: null, images: keep };
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

  function addSnapshot(slug, { kind, entryIds = [], doc, conflicts = [], changes = [], target, call = null, from = null, diff = null }, { keepBodies = 20 } = {}) {
    return withSidecar(slug, (sc) => {
      const snap = { id: nextId(sc.snapshots, 's'), ts: now(), kind, entryIds, doc, conflicts, changes, target: target || sc.target, call, from, diff };
      sc.snapshots.push(snap);
      pruneBodies(sc, keepBodies);
      return snap;
    });
  }

  /**
   * Drop the document body from all but the newest `keep` snapshots. What that step changed, when,
   * and at whose hand all survive -- only the full copy goes, and `bodyDropped` says so, so restore
   * can refuse rather than write an empty document.
   */
  function pruneBodies(sc, keep) {
    if (!Number.isFinite(keep) || keep <= 0) return sc.snapshots;
    const cut = sc.snapshots.length - keep;
    for (let i = 0; i < cut; i += 1) {
      const s = sc.snapshots[i];
      if (s.doc === undefined || s.bodyDropped) continue;
      delete s.doc;
      s.bodyDropped = true;
    }
    return sc.snapshots;
  }

  const setTarget = (slug, target) => withSidecar(slug, (sc) => { sc.target = target; return sc.target; });
  const setTitle = (slug, title) => withSidecar(slug, (sc) => { sc.title = String(title); return sc.title; });
  // An allow-list the person wrote one path at a time. Replaced wholesale so a detach cannot leave
  // a half-removed entry behind.
  const setProjects = (slug, projects) => withSidecar(slug, (sc) => {
    sc.projects = (Array.isArray(projects) ? projects : []).map((p) => ({ ...p, portable: portablePath(p.path) }));
    return sc.projects;
  });
  // Suggestions live here and never in the .md, so a copy cannot carry them and a hand edit cannot
  // accidentally save one into the prompt. `dismissed` holds the text of ones waved away, because
  // every merge regenerates the list and an unremembered dismissal would nag.
  // The document as it stood when it was last copied out. Everything the add-on copy reports is
  // measured from here, so a copy is the only thing that moves it.
  // Test runs, newest last, capped: this is a scratch record of "did the prompt work", not history.
  const addRun = (slug, run) => withSidecar(slug, (sc) => {
    if (!Array.isArray(sc.runs)) sc.runs = [];
    sc.runs.push({ id: nextId(sc.runs, 'r'), ts: now(), ...run });
    sc.runs = sc.runs.slice(-5);
    return sc.runs;
  });
  // Images live beside the prompt rather than in the sidecar: a screenshot is hundreds of KB and
  // the sidecar is rewritten on every keystroke's worth of state. Only the path goes in the JSON.
  const imageDir = (slug) => path.join(dir, `${slug}.images`);
  function saveImage(slug, { data, ext = 'png', name = '' }) {
    const buf = Buffer.from(String(data || ''), 'base64');
    if (!buf.length) return null;
    fs.mkdirSync(imageDir(slug), { recursive: true });
    const safe = String(ext).replace(/[^a-z0-9]/gi, '').slice(0, 5).toLowerCase() || 'png';
    const id = `img${now().toString(36)}`;
    const file = `${id}.${safe}`;
    fs.writeFileSync(path.join(imageDir(slug), file), buf);
    return { id, file, path: path.join(imageDir(slug), file), bytes: buf.length, name: String(name || '').slice(0, 80) || file };
  }

  /** Rebuilt on read, never stored: the library may be on a different machine than it was written on. */
  const imagePath = (slug, img) => (img && img.file ? path.join(imageDir(slug), img.file) : (img && img.path) || '');

  /** `~/x` when it sits under this machine's home, so the same folder resolves on another one. */
  function portablePath(p, home = os.homedir()) {
    const s = String(p || '');
    return home && s.startsWith(`${home}${path.sep}`) ? `~${path.sep}${s.slice(home.length + 1)}` : s;
  }
  function resolvePortable(p, home = os.homedir()) {
    const s = String(p || '');
    return s.startsWith(`~${path.sep}`) || s.startsWith('~/') ? path.join(home, s.slice(2)) : s;
  }

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
    const imgs = imageDir(slug);
    if (fs.existsSync(imgs)) {
      const dest = path.join(trash, `${slug}-${stamp}.images`);
      fs.renameSync(imgs, dest);
      moved.push(dest);
    }
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
    appendEntry, updateEntry, addSnapshot, pruneBodies, setTarget, setTitle, setProjects, setCopyMark, addRun, saveImage, imageDir, imagePath, portablePath, resolvePortable, setSuggestions, dismissSuggestion, setConflicts, resolveConflict, remove,
    readDoc, writeDoc,
  };
}

module.exports = { open, expandHome, slugify };
