'use strict';
// Which files make up a prompt library, and what changed in it. A live share replicates exactly
// these and nothing else: `<slug>.md`, `<slug>.forge.json`, and the files attached to ideas in
// `<slug>.images/` and `<slug>.files/`. Never the .git folder, the trash, a half-written .tmp, or a
// path a remote side made up -- every path that arrives over the network is checked here first.
const nodePath = require('node:path');

const TOP = /^[^/\\.][^/\\]*\.(md|forge\.json)$/;
const SUB = /^[^/\\.][^/\\]*\.(images|files)\/[^/\\.][^/\\]*$/;
const DIR = /^[^/\\.][^/\\]*\.(images|files)$/;

/** A library-relative path, '/'-separated, that a share may read or write. */
function isLibraryFile(rel) {
  const r = String(rel == null ? '' : rel);
  if (!r || r.length > 400 || /\.tmp$/i.test(r)) return false;
  return TOP.test(r) || SUB.test(r);
}

/** 'cold-email' for 'cold-email.md', 'cold-email.forge.json' or 'cold-email.images/x.png'. */
function slugOfRel(rel) {
  const r = String(rel || '');
  const m = /^([^/]+?)\.(md|forge\.json|images|files)(\/|$)/.exec(r);
  return m ? m[1] : null;
}

/** Map of rel -> { size, mtimeMs } for every library file under `dir`. A file that vanishes mid-scan is skipped. */
function scan(dir, fs) {
  const out = new Map();
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  const add = (rel, abs) => {
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) out.set(rel, { size: st.size, mtimeMs: Math.round(st.mtimeMs) });
    } catch { /* gone between the listing and the stat */ }
  };
  for (const d of entries) {
    const name = d.name;
    if (d.isFile() && isLibraryFile(name)) add(name, nodePath.join(dir, name));
    else if (d.isDirectory() && DIR.test(name)) {
      let subs;
      try { subs = fs.readdirSync(nodePath.join(dir, name)); } catch { continue; }
      for (const s of subs) {
        const rel = `${name}/${s}`;
        if (isLibraryFile(rel)) add(rel, nodePath.join(dir, name, s));
      }
    }
  }
  return out;
}

const sameVersion = (a, b) => Boolean(a && b && a.size === b.size && a.mtimeMs === b.mtimeMs);

/** What moved between two scans. */
function diffManifest(prev, next) {
  const changed = [];
  const removed = [];
  for (const [rel, v] of next) if (!sameVersion(prev.get(rel), v)) changed.push(rel);
  for (const rel of prev.keys()) if (!next.has(rel)) removed.push(rel);
  return { changed, removed };
}

/** The absolute path for a checked rel, inside `dir` and nowhere else. null when the rel fails the check. */
function absOf(dir, rel) {
  if (!isLibraryFile(rel)) return null;
  const abs = nodePath.join(dir, ...String(rel).split('/'));
  const inside = nodePath.relative(dir, abs);
  return inside && !inside.startsWith('..') && !nodePath.isAbsolute(inside) ? abs : null;
}

module.exports = { isLibraryFile, slugOfRel, scan, diffManifest, sameVersion, absOf };
