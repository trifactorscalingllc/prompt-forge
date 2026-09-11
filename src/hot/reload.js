// Vendored from TriFactor Scaling's shared VS Code hot-reload kit (MIT). Do not edit here;
// the cold shell (extension.js) registers, everything under src/ and media/ reloads live.

'use strict';
// The mechanism behind reloading a VS Code extension's code without restarting the extension host.
//
// Node caches every module it requires. Re-requiring a file you have just edited returns the OLD
// object unless its cache entry is removed first — which is the entire trick, and also the entire
// failure mode: forget one entry and you get a runtime built half from new code and half from old,
// which is far more confusing than no reload at all. So this drops the whole subtree at once.
const path = require('node:path');
const fs = require('node:fs');

/**
 * Forget every cached module under `<root>/<dir>`, and report how many went.
 *
 * The count is not decoration — it is the only visible evidence that a reload re-read anything. A
 * reload that silently drops zero modules looks identical to one that worked, so log it.
 */
function bustCache(root, { subdir = 'src', cache = require.cache, realpath = fs.realpathSync } = {}) {
  // Node keys the cache by REAL path. On macOS /tmp is a symlink to /private/tmp, and plenty of home
  // directories and mounts are symlinked too — so a source path given in symlinked form matches
  // nothing in the cache, drops zero modules, and reloads nothing while reporting success.
  let base = root;
  try { base = realpath(root); } catch { /* not there yet; the literal path is the best guess */ }
  const dir = path.join(base, subdir) + path.sep;
  let dropped = 0;
  for (const key of Object.keys(cache)) {
    if (key.startsWith(dir)) { delete cache[key]; dropped += 1; }
  }
  return dropped;
}

/**
 * Which tree to load runtime code from: a working copy if one is configured and real, else the
 * installed extension.
 *
 * The existence check matters. A sourcePath left pointing at a moved or deleted directory would
 * otherwise throw on every reload; falling back to the installed copy means a stale setting degrades
 * to "the extension still works" rather than "the extension is dead".
 */
function resolveRoot({ sourcePath, extensionPath, probeFile = 'src/runtime.js', exists = fs.existsSync }) {
  if (sourcePath && exists(path.join(sourcePath, ...probeFile.split('/')))) return sourcePath;
  return extensionPath;
}

module.exports = { bustCache, resolveRoot };
