'use strict';
// The prompt library as a git repository, pushed to and pulled from a remote the person owns.
//
// Syncing a library folder through iCloud or Dropbox works until two machines touch the same prompt:
// the sidecar is rewritten on every change, and the sync service produces a conflicted copy with
// neither file obviously right. Git fixes the part those services cannot: it knows the common
// ancestor, so the two sides can be merged rather than one picked.
//
// The merge is structural, not textual. Two sidecars are two histories of one prompt; they are
// joined entry by entry and version by version, and ids that both machines minted independently
// (both made an e8) are renumbered on the incoming side rather than allowed to collide. The document
// follows the side that changed most recently, and the other side's text is kept as a version you
// can restore, so a sync never deletes words.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const os = require('node:os');
const docm = require('./doc');

const GITIGNORE = '.trash/\n*.tmp\n.DS_Store\n';

// ------------------------------------------------------------------------------------------------
// The sidecar merge. Pure.
// ------------------------------------------------------------------------------------------------

const idNum = (id, prefix) => { const m = new RegExp(`^${prefix}(\\d+)$`).exec(String(id || '')); return m ? Number(m[1]) : 0; };
const newer = (a, b, key = 'ts') => ((b && (b[key] || 0)) > ((a && a[key]) || 0) ? b : a);

/** Union two lists by identity; `renumber` gives an incoming item a fresh id when its id is taken. */
function unionBy(ours, theirs, identity, { prefix = null } = {}) {
  const out = ours.map((x) => ({ ...x }));
  const seen = new Set(out.map(identity));
  const renamed = new Map();
  let max = prefix ? Math.max(0, ...out.map((x) => idNum(x.id, prefix)), ...theirs.map((x) => idNum(x.id, prefix))) : 0;
  const taken = new Set(out.map((x) => x.id));
  for (const t of theirs) {
    if (seen.has(identity(t))) continue;
    const item = { ...t };
    if (prefix && taken.has(item.id)) {
      max += 1;
      renamed.set(item.id, `${prefix}${max}`);
      item.id = `${prefix}${max}`;
    }
    taken.add(item.id);
    seen.add(identity(item));
    out.push(item);
  }
  return { list: out, renamed };
}

/**
 * Two sidecars of the same prompt, joined. `oursDoc` and `theirsDoc` are the two .md files, so the
 * losing document text can be kept as a version. Returns { sidecar, doc }.
 */
function mergeSidecars(ours, theirs, { oursDoc = null, theirsDoc = null } = {}) {
  if (!ours) return { sidecar: theirs, doc: theirsDoc };
  if (!theirs) return { sidecar: ours, doc: oursDoc };
  const lead = (theirs.updatedAt || 0) > (ours.updatedAt || 0) ? theirs : ours;
  const leadIsTheirs = lead === theirs;

  // Versions first: entries point at them.
  const snaps = unionBy(ours.snapshots || [], theirs.snapshots || [], (s) => `${s.ts}|${s.kind}`, { prefix: 's' });
  const entries = unionBy(ours.entries || [], theirs.entries || [], (e) => `${e.ts}|${e.text}`, { prefix: 'e' });
  const theirSnapIds = new Set((theirs.snapshots || []).map((s) => s.id));
  for (const e of entries.list) {
    const fromTheirs = !(ours.entries || []).some((o) => o.ts === e.ts && o.text === e.text);
    if (fromTheirs && e.snapshotId && theirSnapIds.has(e.snapshotId) && snaps.renamed.has(e.snapshotId)) e.snapshotId = snaps.renamed.get(e.snapshotId);
  }
  for (const s of snaps.list) {
    s.entryIds = (s.entryIds || []).map((id) => (entries.renamed.has(id) && !(ours.snapshots || []).some((o) => o.ts === s.ts && o.kind === s.kind) ? entries.renamed.get(id) : id));
  }
  snaps.list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  entries.list.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  const resolved = unionBy(ours.resolved || [], theirs.resolved || [], (r) => `${r.id}|${r.ts}|${r.existing}|${r.incoming}`).list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const closed = new Set(resolved.map((r) => `${r.existing}|${r.incoming}`));
  const conflicts = unionBy(ours.conflicts || [], theirs.conflicts || [], (c) => `${c.existing}|${c.incoming}`, { prefix: 'C' }).list
    .filter((c) => !closed.has(`${c.existing}|${c.incoming}`));

  const union = (k) => [...new Set([...(ours[k] || []), ...(theirs[k] || [])])];
  const sidecar = {
    ...ours,
    ...lead,
    entries: entries.list,
    snapshots: snaps.list,
    conflicts,
    resolved,
    dismissed: union('dismissed'),
    dismissedIdeas: union('dismissedIdeas'),
    runs: unionBy(ours.runs || [], theirs.runs || [], (r) => `${r.ts}|${r.model}`, { prefix: 'r' }).list.sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-5),
    vars: { ...(leadIsTheirs ? ours.vars : theirs.vars), ...(lead.vars || {}) },
    copied: newer(ours.copied, theirs.copied),
    sent: newer(ours.sent, theirs.sent),
    polished: newer(ours.polished, theirs.polished),
    updatedAt: Math.max(ours.updatedAt || 0, theirs.updatedAt || 0),
  };

  // The document: the leading side's. The other side's text, when it differs, becomes a version.
  let doc = leadIsTheirs ? theirsDoc : oursDoc;
  const other = leadIsTheirs ? oursDoc : theirsDoc;
  if (doc == null) doc = other;
  if (other != null && doc != null && docm.stripConflictBlock(other) !== docm.stripConflictBlock(doc)) {
    const id = `s${Math.max(0, ...sidecar.snapshots.map((s) => idNum(s.id, 's'))) + 1}`;
    const last = sidecar.snapshots[sidecar.snapshots.length - 1];
    sidecar.snapshots.splice(Math.max(0, sidecar.snapshots.length - 1), 0, {
      id, ts: last ? last.ts - 1 : Date.now(), kind: 'sync', entryIds: [], doc: docm.stripConflictBlock(other),
      conflicts: [], changes: ['the other machine\'s version, kept when both changed this prompt'], target: sidecar.target, call: null,
    });
  }
  if (doc != null) doc = docm.withConflictBlock(docm.stripConflictBlock(doc), sidecar.conflicts);
  return { sidecar, doc };
}

// ------------------------------------------------------------------------------------------------
// Git
// ------------------------------------------------------------------------------------------------

function createSync({ dir, runCli, git = 'git', log = { info() {}, warn() {}, error() {} }, fs = nodeFs, hostName = os.hostname() }) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '' };
  let running = null;
  let lastResult = null;

  const g = async (args, { timeoutMs = 60000, allowFail = false } = {}) => {
    const res = await runCli({ bin: git, args: ['-c', 'core.quotepath=false', '-c', `user.name=Prompt Forge (${hostName})`, '-c', 'user.email=prompt-forge@localhost', ...args], cwd: dir, env, timeoutMs });
    if (!res.ok && !allowFail) throw new Error(`git ${args[0]}: ${(res.stderr || res.error || '').trim().slice(0, 400)}`);
    return res;
  };

  const isRepo = () => fs.existsSync(nodePath.join(dir, '.git'));

  async function remoteUrl() {
    if (!isRepo()) return null;
    const r = await g(['remote', 'get-url', 'origin'], { allowFail: true });
    return r.ok ? r.stdout.trim() : null;
  }

  /** Make the library a repository pointing at `url`. Idempotent; never discards a file. */
  async function setup(url) {
    if (!isRepo()) await g(['init']);
    const ignore = nodePath.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, GITIGNORE);
    const have = await remoteUrl();
    if (url && have !== url) await g(have ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url]);
    await g(['symbolic-ref', 'HEAD', 'refs/heads/main'], { allowFail: true });
    return syncNow({ reason: 'setup' });
  }

  async function show(stage, file) {
    const r = await g(['show', `:${stage}:${file}`], { allowFail: true });
    return r.ok ? r.stdout : null;
  }

  /** Resolve every conflicted path after a merge, structurally for prompts and by recency for anything else. */
  async function resolveConflicts() {
    const r = await g(['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
    const paths = String(r.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
    const done = new Set();
    for (const p of paths) {
      if (done.has(p)) continue;
      if (p.endsWith('.forge.json') || p.endsWith('.md')) {
        const slug = p.replace(/\.forge\.json$|\.md$/, '');
        const sideJson = `${slug}.forge.json`;
        const sideMd = `${slug}.md`;
        const parse = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
        const ours = parse(await show(2, sideJson)) || parse(readIf(sideJson));
        const theirs = parse(await show(3, sideJson));
        const oursDoc = (await show(2, sideMd)) ?? readIf(sideMd);
        // A document identical on both sides merges cleanly and is never staged as theirs; read it
        // from the commit being merged instead.
        let theirsDoc = await show(3, sideMd);
        if (theirsDoc == null) {
          const t = await g(['show', `MERGE_HEAD:${sideMd}`], { allowFail: true });
          theirsDoc = t.ok ? t.stdout : null;
        }
        const addExisting = (paths) => g(['add', '--', ...paths.filter((p2) => fs.existsSync(nodePath.join(dir, p2)))], { allowFail: true });
        const base = await show(1, sideJson);
        // Added on both machines with no common ancestor and born at different moments: these are two
        // different prompts that happen to share a name ("untitled" on both). Both are kept.
        if (!base && ours && theirs && ours.createdAt !== theirs.createdAt) {
          let n = 2;
          let other = `${slug}-${n}`;
          while (fs.existsSync(nodePath.join(dir, `${other}.forge.json`)) || fs.existsSync(nodePath.join(dir, `${other}.md`))) { n += 1; other = `${slug}-${n}`; }
          fs.writeFileSync(nodePath.join(dir, sideJson), `${JSON.stringify(ours, null, 2)}\n`);
          if (oursDoc != null) fs.writeFileSync(nodePath.join(dir, sideMd), oursDoc);
          fs.writeFileSync(nodePath.join(dir, `${other}.forge.json`), `${JSON.stringify({ ...theirs, slug: other }, null, 2)}\n`);
          if (theirsDoc != null) fs.writeFileSync(nodePath.join(dir, `${other}.md`), theirsDoc);
          await addExisting([sideJson, sideMd, `${other}.forge.json`, `${other}.md`]);
          done.add(sideJson);
          done.add(sideMd);
          log.info(`sync: two different prompts were both called ${slug}; the other machine's is now ${other}`);
          continue;
        }
        // Only the document conflicted: the sidecar is one history, but the other text is still kept.
        const merged = mergeSidecars(ours, theirs || ours, { oursDoc, theirsDoc });
        if (merged.sidecar) fs.writeFileSync(nodePath.join(dir, sideJson), `${JSON.stringify(merged.sidecar, null, 2)}\n`);
        if (merged.doc != null) fs.writeFileSync(nodePath.join(dir, sideMd), merged.doc);
        await addExisting([sideJson, sideMd]);
        done.add(sideJson);
        done.add(sideMd);
        log.info(`sync: merged both machines' histories of ${slug}`);
        continue;
      }
      // Attachments have unique names, so this is rare: keep ours, which is the file on this disk.
      await g(['checkout', '--ours', '--', p], { allowFail: true });
      await g(['add', '--', p], { allowFail: true });
      done.add(p);
    }
    return [...done];
  }

  const readIf = (rel) => { try { return fs.readFileSync(nodePath.join(dir, rel), 'utf8'); } catch { return null; } };

  /**
   * Commit what changed here, bring in what changed there, merge, push. Serialised: a second call
   * while one runs waits for it and returns its result. { ok, changedHere, pulled, merged, error }
   */
  function syncNow({ reason = 'manual' } = {}) {
    if (running) return running;
    running = (async () => {
      const result = { ok: false, reason, changedHere: false, pulled: false, merged: [], pushed: false, error: null, at: Date.now() };
      try {
        if (!isRepo()) throw new Error('the library is not set up for sync yet');
        const url = await remoteUrl();
        if (!url) throw new Error('no remote is set; set promptForge.sync.remote');
        await g(['add', '-A']);
        const status = await g(['status', '--porcelain']);
        if (status.stdout.trim()) {
          await g(['commit', '-m', `prompts from ${hostName}`]);
          result.changedHere = true;
        }
        const fetched = await g(['fetch', 'origin'], { allowFail: true, timeoutMs: 90000 });
        if (!fetched.ok) throw new Error(`could not reach the remote: ${(fetched.stderr || fetched.error || '').trim().slice(0, 300)}`);
        const hasRemoteMain = (await g(['rev-parse', '--verify', '--quiet', 'refs/remotes/origin/main'], { allowFail: true })).ok;
        const hasLocal = (await g(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).ok;
        if (hasRemoteMain) {
          if (!hasLocal) {
            await g(['reset', '--hard', 'origin/main']);
            result.pulled = true;
          } else {
            const m = await g(['merge', '--no-edit', '--allow-unrelated-histories', 'origin/main'], { allowFail: true });
            if (!m.ok) {
              result.merged = await resolveConflicts();
              const left = await g(['diff', '--name-only', '--diff-filter=U'], { allowFail: true });
              if (left.stdout.trim()) { await g(['merge', '--abort'], { allowFail: true }); throw new Error(`could not merge ${left.stdout.trim().split('\n').join(', ')}`); }
              await g(['commit', '--no-edit', '-m', `merge prompts from the remote on ${hostName}`]);
            }
            result.pulled = !/Already up to date/i.test(m.stdout || '');
          }
        }
        if ((await g(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true })).ok) {
          const pushed = await g(['push', 'origin', 'HEAD:main'], { allowFail: true, timeoutMs: 90000 });
          if (!pushed.ok) throw new Error(`could not push: ${(pushed.stderr || pushed.error || '').trim().slice(0, 300)}`);
          result.pushed = true;
        }
        result.ok = true;
      } catch (e) {
        result.error = e.message;
        log.warn(`sync (${reason}) failed: ${e.message}`);
      }
      lastResult = result;
      return result;
    })();
    return running.finally(() => { running = null; });
  }

  return { setup, syncNow, remoteUrl, isRepo, last: () => lastResult, busy: () => Boolean(running) };
}

module.exports = { createSync, mergeSidecars, unionBy, GITIGNORE };
