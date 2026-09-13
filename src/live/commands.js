'use strict';
// What a joined window may ask the sharing window to do, and nothing more. Each request names a
// prompt and is checked here -- the prompt exists, the text is a string of sane length, an attached
// file is one this library saved -- before it reaches the same session methods the panel calls.
// The person who asked is recorded on the idea, so the thread says who wrote what.
const nodeFs = require('node:fs');
const docm = require('../doc');
const { mergeDocs } = require('./mergedoc');
const { LIMITS } = require('../attachments');

const SLUG = /^[a-z0-9][a-z0-9-]{0,160}$/;
const FILE = /^[^/\\.][^/\\]{0,300}$/;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

function createHostCommands({ getStore, ensureSession, removePrompt, engineSelection, docio, keepBodies = () => 20, post = () => {}, fs = nodeFs }) {
  function slugOf(args) {
    const slug = String((args && args.slug) || '');
    if (!SLUG.test(slug) || !getStore().exists(slug)) throw new Error('That prompt is not in the library any more.');
    return slug;
  }
  const sessionFor = async (args) => ensureSession(slugOf(args));
  const needEngine = () => {
    const sel = engineSelection();
    if (!sel || !sel.ok) throw new Error((sel && sel.reason) || 'The sharing window has no engine signed in.');
  };

  /** Only records of files saved in this prompt's own folders, and only while the file is there. */
  function attachmentsFor(slug, list) {
    const store = getStore();
    return (Array.isArray(list) ? list : []).slice(0, 20)
      .filter((a) => a && typeof a.file === 'string' && FILE.test(a.file))
      .map((a) => ({
        id: str(a.id, 64), file: a.file, name: str(a.name, 200) || a.file, bytes: Number(a.bytes) || 0,
        kind: str(a.kind, 16) || undefined, mime: str(a.mime, 100) || undefined, secret: Boolean(a.secret),
        dir: a.dir === 'files' ? 'files' : 'images',
      }))
      .filter((a) => fs.existsSync(store.attachmentPath(slug, a)));
  }

  async function run(who, cmd, args = {}, bytes = null) {
    const by = { name: who.name, machine: who.machine };
    switch (cmd) {
      case 'create': {
        const title = str(args.title, 200).replace(/\s+/g, ' ').trim() || 'Untitled';
        const body = typeof args.body === 'string' && args.body.length <= 200000 ? args.body : null;
        const { slug } = getStore().create(title, body ? { body } : {});
        post();
        return { slug };
      }
      case 'delete': {
        await removePrompt(slugOf(args));
        post();
        return true;
      }
      case 'idea': {
        needEngine();
        const slug = slugOf(args);
        const text = str(args.text, 200000);
        if (!text.trim()) throw new Error('An empty idea.');
        const s = await ensureSession(slug);
        const entry = s.submitIdea(text, attachmentsFor(slug, args.attachments), { by });
        return { entryId: entry ? entry.id : null };
      }
      case 'editIdea': {
        needEngine();
        const s = await sessionFor(args);
        return s.editIdea(str(args.entryId, 32), str(args.text, 200000));
      }
      case 'retry': {
        const s = await sessionFor(args);
        return args.entryId ? s.retry(str(args.entryId, 32)) : s.retryAll();
      }
      case 'resolve': {
        if (args.keep !== 'new' && args.keep !== 'old') throw new Error('Keep old or keep new.');
        const s = await sessionFor(args);
        s.resolve(str(args.conflictId, 32), args.keep, { by });
        return true;
      }
      case 'polish': {
        needEngine();
        const s = await sessionFor(args);
        s.polish({ full: Boolean(args.full) });
        return true;
      }
      case 'setTarget': {
        const s = await sessionFor(args);
        const target = str(args.target, 80);
        if (!target) throw new Error('No target named.');
        s.setTarget(target);
        return true;
      }
      case 'rename': {
        const s = await sessionFor(args);
        const r = await s.rename(str(args.title, 200));
        post();
        return r;
      }
      case 'restore': {
        const s = await sessionFor(args);
        return s.restore(str(args.snapshotId, 32));
      }
      case 'dismissSuggestion': {
        const s = await sessionFor(args);
        s.dismissSuggestion(str(args.text, 8000));
        return true;
      }
      case 'dismissIdea': {
        const s = await sessionFor(args);
        s.dismissIdea(str(args.text, 8000));
        return true;
      }
      case 'setVars': {
        const s = await sessionFor(args);
        const values = {};
        for (const [k, v] of Object.entries(args.values && typeof args.values === 'object' ? args.values : {}).slice(0, 50)) {
          if (/^[\w.-]{1,64}$/.test(k)) values[k] = v == null ? '' : str(String(v), 10000);
        }
        s.setVars(values);
        return true;
      }
      case 'attach': {
        const slug = slugOf(args);
        if (!bytes || !bytes.length) throw new Error('The file arrived empty.');
        if (bytes.length > LIMITS.upload) throw new Error(`Attachments are capped at ${Math.round(LIMITS.upload / 1024 / 1024)} MB.`);
        const store = getStore();
        const data = Buffer.from(bytes).toString('base64');
        const saved = args.image
          ? store.saveImage(slug, { data, ext: str(args.ext, 5) || 'png', name: str(args.name, 120) })
          : store.saveFile(slug, { data, name: str(args.name, 120) || 'attachment' });
        if (!saved) throw new Error('That file could not be read.');
        if (saved.error) throw new Error(saved.error);
        const { path: _machineLocal, ...record } = saved;
        return record;
      }
      case 'docEdit': {
        // A hand edit made in the other window. `base` is the document it was typed against; when
        // this window's copy moved in the meantime, the two are joined section by section, and a
        // section both changed keeps this side's text as a version before the edit replaces it.
        const slug = slugOf(args);
        const s = await ensureSession(slug);
        if (typeof args.text !== 'string' || args.text.length > 2000000) throw new Error('That edit is too large.');
        const text = docm.stripConflictBlock(args.text);
        const raw = await docio.readDoc(s.docPath);
        const cur = docm.stripConflictBlock(raw == null ? '' : raw);
        const base = typeof args.base === 'string' ? docm.stripConflictBlock(args.base) : cur;
        const merged = base === cur ? { doc: text, clean: true } : mergeDocs(base, cur, text);
        if (merged.doc !== cur) {
          const store = getStore();
          const sc = store.read(slug);
          if (!merged.clean) {
            store.addSnapshot(slug, {
              kind: 'hand-edit', entryIds: [], doc: cur, conflicts: sc.conflicts, target: sc.target,
              changes: [`kept when ${who.name} edited the same section at the same moment`],
            }, { keepBodies: keepBodies() });
            s.reread();
          }
          await docio.writeDoc(s.docPath, docm.withConflictBlock(merged.doc, sc.conflicts));
        }
        post();
        return { doc: merged.doc, clean: merged.clean };
      }
      case 'docRead': {
        const s = await sessionFor(args);
        const raw = await docio.readDoc(s.docPath);
        return { text: raw == null ? '' : raw };
      }
      case 'typing': {
        const s = await sessionFor(args);
        if (engineSelection().ok) s.warm();
        return true;
      }
      default:
        throw new Error(`Prompt Forge in the sharing window does not know "${String(cmd).slice(0, 40)}". Update both to the same version.`);
    }
  }

  return { run };
}

module.exports = { createHostCommands };
