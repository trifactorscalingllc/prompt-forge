'use strict';
// The HOT entry point. Everything here is disposed and re-required on reload. It holds no
// registration VS Code will not let us redo: the panel, the secrets and the settings come in
// through the host object, owned by extension.js.
//
// create() must touch nothing but `host` (the shell test builds it with a vscode that throws on
// any access); every VS Code side effect lives in start() or a message handler.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const view = require('./view');
const storeMod = require('./store');
const { createDocio } = require('./docio');
const { createDocEditors } = require('./docedit');
const { createSession } = require('./session');
const { createEngine } = require('./engine/engine');
const { createProviders, secretKey } = require('./providers');
const { runCli, resolveBin } = require('./providers/spawn');
const targets = require('./targets');
const docm = require('./doc');
const { modelBlurb, ROLE_BLURBS } = require('./blurbs');
const project = require('./project');

const LAST_OPEN = 'promptForge.lastOpen';

function create(host) {
  const { log, vscode, config, getPanel, ensurePanel, globalState, secrets } = host;

  let store = null;
  let bootError = null;
  let disposed = false;
  const sessions = new Map();
  let activeSlug = null;
  const disposables = [];

  const docio = createDocio(vscode, { log });
  // The custom editor is registered by the cold shell; this owns what happens inside one.
  const docEditors = createDocEditors({
    vscode, docio, log,
    docHtml: view.docHtml,
    mediaRoots: () => (host.mediaRoots ? host.mediaRoots() : []),
  });
  const providers = createProviders({ runCli, resolveBin, fetch: globalThis.fetch, fs, home: os.homedir() });
  const engine = createEngine({ providers, config, secrets, log });

  // ------------------------------------------------------------------------------------------
  // Settings
  //
  // A setting can only be written if the running extension host has it in its manifest, and the
  // manifest is read once at host start. So between installing a vsix that adds a setting and
  // reloading the window, `update` throws "not a registered configuration" — while the new code is
  // already running, because src/ and media/ hot-reload and package.json does not. Rather than
  // failing the click, the value is kept for this session and the reload is asked for once.
  // ------------------------------------------------------------------------------------------
  const overrides = new Map();
  let askedForReload = false;

  async function updateSetting(key, value) {
    try {
      await vscode.workspace.getConfiguration('promptForge').update(key, value, vscode.ConfigurationTarget.Global);
      overrides.delete(key);
      return true;
    } catch (e) {
      overrides.set(key, value);
      log.warn(`could not persist promptForge.${key}: ${e.message}`);
      if (!askedForReload) {
        askedForReload = true;
        notice('info', 'Prompt Forge was updated in place. Reload the VS Code window to save settings permanently — until then these apply to this session only.');
      }
      return false;
    }
  }

  const setting = (key, fallback) => (overrides.has(key) ? overrides.get(key) : fallback);

  // The defaults are repeated rather than read from the manifest for the same reason: an extension
  // host running an older manifest hands back nothing at all for a setting it does not know.
  const LAYOUT = { mode: 'auto', stackWidth: 620, split: 52, railCollapsed: false };
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  const layoutState = () => {
    const l = config().layout || {};
    return {
      mode: setting('layout', l.mode) || LAYOUT.mode,
      stackWidth: num(setting('layoutStackWidth', l.stackWidth), LAYOUT.stackWidth),
      split: num(setting('layoutSplit', l.split), LAYOUT.split),
      railCollapsed: Boolean(setting('railCollapsed', l.railCollapsed) ?? LAYOUT.railCollapsed),
    };
  };

  function buildState() {
    if (!store) {
      if (!bootError) return null;
      return { bootError, library: config().libraryPath, prompts: [], active: null, engine: engine.state(), targets: targets.TARGETS, docEditor: setting('docEditor', config().docEditor), layout: layoutState(), engineCfg: config().engine || {} };
    }
    const session = activeSlug ? sessions.get(activeSlug) : null;
    return {
      library: store.dir,
      prompts: store.list(),
      active: session ? session.snapshot() : null,
      engine: engine.state(),
      targets: targets.TARGETS,
      docEditor: setting('docEditor', config().docEditor),
      layout: layoutState(),
      engineCfg: config().engine || {},
      project: projectCfg(),
      blurbs: blurbs(engine.state()),
    };
  }

  /** One line per known model id (catalog, API list, or configured), plus the role lines. */
  function blurbs(engineState) {
    const models = {};
    for (const p of engineState.providers || []) for (const m of p.models || []) models[m.id] = modelBlurb(m.id);
    const e = config().engine || {};
    for (const id of [e.mergeModel, e.polishModel]) if (id && id !== 'auto') models[id] = modelBlurb(id);
    return { roles: ROLE_BLURBS, models, targets: Object.fromEntries(targets.TARGETS.map((t) => [t.id, t.blurb])) };
  }

  function post() {
    const p = getPanel();
    const data = buildState();
    if (!p || !data) return;
    const s = active();
    if (!s || !data.active) { p.webview.postMessage({ type: 'state', data }); return; }
    // The live document rides along so the prompt panel is the same text the editor holds.
    docio.readDoc(s.docPath).then((raw) => {
      data.active.doc = docm.stripConflictBlock(raw == null ? '' : raw);
      data.active.docBlank = docm.isBlank(raw == null ? '' : raw);
      p.webview.postMessage({ type: 'state', data });
    }, () => p.webview.postMessage({ type: 'state', data }));
  }

  let repaintTimer = null;
  function repaintSoon() {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => { if (!disposed) post(); }, 300);
  }

  function notice(level, text) {
    const p = getPanel();
    if (p) p.webview.postMessage({ type: 'notice', level, text });
    if (level === 'error') log.error(text); else log.info(text);
  }

  // ------------------------------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------------------------------

  async function openSession(slug, { reveal = false } = {}) {
    let s = sessions.get(slug);
    if (!s) {
      s = createSession({
        slug, store, docio, engine, cfg: config, log,
        publish: (why) => {
          if (why.startsWith('notice:')) notice('info', why.slice('notice:'.length));
          if (slug === activeSlug) post();
        },
      });
      await s.load();
      sessions.set(slug, s);
    }
    activeSlug = slug;
    await globalState.update(LAST_OPEN, slug);
    post();
    if (reveal) await openDoc();
    return s;
  }

  const active = () => (activeSlug ? sessions.get(activeSlug) : null);

  async function openDoc() {
    const s = active();
    if (!s) return;
    try { await docio.openBeside(s.docPath, { editor: config().docEditor }); } catch (e) { notice('error', `Could not open the document: ${e.message}`); }
  }

  // ------------------------------------------------------------------------------------------
  // Engine sign-in
  // ------------------------------------------------------------------------------------------

  const providerById = (id) => providers.find((p) => p.id === id) || null;

  async function pickProvider(placeHolder, filter = () => true) {
    const items = providers.filter(filter).map((p) => ({ label: p.label, id: p.id }));
    const pick = await vscode.window.showQuickPick(items, { placeHolder });
    return pick ? pick.id : null;
  }

  // ------------------------------------------------------------------------------------------
  // Project context
  //
  // Two scopes, deliberately different sizes. The picker LISTS several roots — names and paths
  // only, never a file. The brief READS exactly one folder, the one the person chose. Umbrella
  // reading is refused; docs/project-context.md records why, because it will be proposed again.
  // ------------------------------------------------------------------------------------------
  const projectCfg = () => {
    const p = config().project || {};
    return {
      roots: Array.isArray(p.roots) ? p.roots : [],
      context: p.context === 'off' ? 'off' : 'brief',
      attachDefault: p.attachDefault === 'workspace' ? 'workspace' : 'none',
      maxFiles: Number.isFinite(p.maxFiles) ? p.maxFiles : 400,
      maxBytes: Number.isFinite(p.maxBytes) ? p.maxBytes : 2000000,
    };
  };

  const workspaceDir = () => {
    const f = vscode.workspace.workspaceFolders;
    return f && f.length ? f[0].uri.fsPath : null;
  };

  /** HEAD without spawning git. Detached HEAD is the sha itself; otherwise follow the ref, then
   *  packed-refs, which is where a freshly cloned repo keeps its branches. */
  function gitHead(dir) {
    try {
      const head = fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim();
      const m = /^ref:\s*(.+)$/.exec(head);
      if (!m) return /^[0-9a-f]{7,40}$/i.test(head) ? head.slice(0, 7) : null;
      try { return fs.readFileSync(path.join(dir, '.git', m[1]), 'utf8').trim().slice(0, 7); } catch { /* packed below */ }
      const packed = fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8');
      const line = packed.split('\n').find((l) => l.trim().endsWith(` ${m[1]}`));
      return line ? line.trim().slice(0, 7) : null;
    } catch { return null; }
  }

  async function pickProjectDir() {
    const cfg = projectCfg();
    const ws = workspaceDir();
    const items = [];
    if (ws) items.push({ label: `$(root-folder) ${path.basename(ws)}`, description: ws, detail: 'The folder this window has open', dir: ws });
    for (const p of project.discover(cfg.roots, { fs, home: os.homedir() })) {
      if (ws && p.path === ws) continue;
      items.push({ label: `$(folder) ${p.label}`, description: p.path, dir: p.path });
    }
    items.push({ label: '$(folder-opened) Browse\u2026', detail: 'Pick any folder', dir: '\u0000browse' });
    if (!cfg.roots.length) items.push({ label: '$(gear) Add folders to list projects from\u2026', detail: 'Sets promptForge.projectRoots, so you never hunt for a path again', dir: '\u0000roots' });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Which project is this prompt for? Only the folder you choose is read.',
      matchOnDescription: true,
    });
    if (!pick) return null;
    if (pick.dir === '\u0000roots') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'promptForge.projectRoots');
      return null;
    }
    if (pick.dir === '\u0000browse') {
      const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Attach this project' });
      return sel && sel.length ? sel[0].fsPath : null;
    }
    return pick.dir;
  }

  /** One call, on attach, with the polish model. Its output is reused on every merge after. */
  async function buildBrief(dir, label) {
    const cfg = projectCfg();
    let collected;
    try { collected = project.collect(dir, { fs, maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes }); } catch (e) { return { error: e.message }; }
    if (!collected.files.length) return { error: `Nothing readable in ${dir}. A project needs a README or a manifest to describe itself.` };
    const res = await engine.call({
      role: 'polish',
      prompt: project.buildBriefPrompt({ label, dir, collected }),
      timeoutMs: ((config().engine || {}).timeoutSeconds || 240) * 1000,
    });
    if (res.error) return { error: res.error };
    const brief = project.capBrief(res.text);
    if (!brief) return { error: 'The engine returned an empty brief.' };
    return { brief, files: collected.files, truncated: collected.truncated, call: res.call };
  }

  async function attachProject(slug, dir) {
    if (!store || !slug) return;
    const label = path.basename(dir) || dir;
    if (!engine.selection().ok) {
      // Attaching without an engine is allowed: the folder is recorded and the brief builds later.
      const list = (store.read(slug).projects || []).filter((p) => p.path !== dir);
      list.push({ id: `p${list.length + 1}`, label, path: dir, brief: '', builtAt: 0, head: gitHead(dir), files: [], error: engine.selection().reason });
      store.setProjects(slug, list);
      const sess = sessions.get(slug); if (sess) sess.reread();
      notice('info', `${label} attached. Its brief will build once an engine is signed in.`);
      post();
      return;
    }
    const built = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Reading ${label}\u2026`, cancellable: false },
      () => buildBrief(dir, label),
    );
    const list = (store.read(slug).projects || []).filter((p) => p.path !== dir);
    const id = `p${Date.now().toString(36)}`;
    if (built.error) {
      list.push({ id, label, path: dir, brief: '', builtAt: 0, head: gitHead(dir), files: [], error: built.error });
      notice('error', `Could not describe ${label}: ${built.error}`);
    } else {
      list.push({
        id, label, path: dir, brief: built.brief, builtAt: Date.now(), head: gitHead(dir),
        files: built.files, truncated: built.truncated,
        call: built.call ? { model: built.call.model, in: (built.call.usage || {}).input || 0, out: (built.call.usage || {}).output || 0 } : null,
        error: null,
      });
      notice('info', `${label} attached \u2014 read ${built.files.length} file${built.files.length === 1 ? '' : 's'}.`);
    }
    store.setProjects(slug, list);
    const sess = sessions.get(slug); if (sess) sess.reread();
    post();
  }

  function detachProject(slug, id) {
    if (!store || !slug) return;
    store.setProjects(slug, (store.read(slug).projects || []).filter((p) => p.id !== id));
    const sess = sessions.get(slug); if (sess) sess.reread();
    post();
  }

  async function signIn(id, mode) {
    const p = providerById(id);
    if (!p) return;
    if (mode === 'apiKey' || !p.signIn) return setKey(id);
    const det = engine.detections().find((d) => d.id === id);
    if (!det || !det.cli.found) {
      const choice = await vscode.window.showInformationMessage(`The ${p.label} CLI is not on your PATH. Install it, then sign in.`, 'Open install page', 'Use an API key instead');
      if (choice === 'Open install page' && p.installUrl) await vscode.env.openExternal(vscode.Uri.parse(p.installUrl));
      if (choice === 'Use an API key instead') await setKey(id);
      return;
    }
    const cmd = [det.cli.path || p.signIn.cli.command, ...p.signIn.cli.args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    const term = vscode.window.createTerminal({ name: `Prompt Forge: ${p.label} sign-in` });
    term.show(true);
    term.sendText(cmd, true);
    notice('info', `Finish the ${p.label} login in the terminal, then click "Detect again".`);
  }

  async function setKey(id) {
    const p = providerById(id);
    if (!p) return;
    const value = await vscode.window.showInputBox({
      prompt: `API key for ${p.label}${p.keyUrl ? ` (get one at ${p.keyUrl})` : ''}`,
      password: true, ignoreFocusOut: true, placeHolder: 'pasted here, stored in your OS keychain, never in settings',
    });
    if (value == null) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    await secrets.store(secretKey(id), trimmed);
    notice('info', `${p.label} key stored.`);
    await engine.detectAll();
    post();
  }

  async function forgetKey(id) {
    const p = providerById(id);
    if (!p) return;
    await secrets.delete(secretKey(id));
    notice('info', `${p.label} key removed.`);
    await engine.detectAll();
    post();
  }

  async function selectEngine({ provider, mergeModel, polishModel }) {
    const c = vscode.workspace.getConfiguration('promptForge');
    const target = vscode.ConfigurationTarget.Global;
    // Model ids belong to a provider. Switching providers without naming models resets both to
    // auto, or Gemini would be asked for a Claude model id.
    if (provider && provider !== c.get('engine.provider', 'auto')) {
      if (mergeModel === undefined) mergeModel = 'auto';
      if (polishModel === undefined) polishModel = 'auto';
    }
    if (provider) await c.update('engine.provider', provider, target);
    if (mergeModel !== undefined) await c.update('engine.mergeModel', mergeModel || 'auto', target);
    if (polishModel !== undefined) await c.update('engine.polishModel', polishModel || 'auto', target);
    await engine.detectAll();
    post();
  }

  // ------------------------------------------------------------------------------------------
  // Messages from the webview (and from the cold shell's commands)
  // ------------------------------------------------------------------------------------------

  async function handleMessage(m) {
    if (!m || typeof m !== 'object' || !m.type) return;
    if (!store && m.type !== 'ready') {
      notice('error', bootError ? `Prompt Forge cannot open its library folder: ${bootError}` : 'Prompt Forge is still starting.');
      return;
    }
    try {
      await dispatch(m);
    } catch (e) {
      // A thrown handler must never be a silent loss: the panel already cleared the idea box.
      notice('error', `${m.type} failed: ${e.message || e}`);
      log.error(`${m.type} failed: ${e.stack || e.message}`);
      post();
    }
  }

  async function dispatch(m) {
    const s = active();
    switch (m.type) {
      case 'ready':
        post();
        return;
      case 'panelOpened':
        post();
        return;
      case 'openPrompt':
        if (m.slug && store.exists(m.slug)) await openSession(m.slug);
        return;
      case 'newPrompt': {
        // No naming step: the prompt names itself from the first idea, and the title is editable.
        const title = String(m.title || 'Untitled').trim() || 'Untitled';
        const { slug } = store.create(title);
        await openSession(slug);
        const p = getPanel();
        if (p) p.webview.postMessage({ type: 'focus', target: 'idea' });
        return;
      }
      case 'deletePrompt': {
        const item = store.list().find((x) => x.slug === m.slug);
        if (!item) return;
        const ok = await vscode.window.showWarningMessage(`Delete "${item.title}"? It moves to the library's .trash folder.`, { modal: true }, 'Delete');
        if (ok !== 'Delete') return;
        const sess = sessions.get(m.slug);
        if (sess) { sess.dispose(); sessions.delete(m.slug); }
        store.remove(m.slug);
        if (activeSlug === m.slug) { activeSlug = null; await globalState.update(LAST_OPEN, undefined); }
        post();
        return;
      }
      case 'idea':
        if (!s) { notice('info', 'Create or open a prompt first.'); return; }
        if (!engine.selection().ok) { notice('error', engine.selection().reason); return; }
        s.submitIdea(m.text);
        return;
      case 'setTarget':
        if (s && m.target) s.setTarget(String(m.target));
        return;
      case 'project.connect': {
        if (!s) { notice('info', 'Create or open a prompt first.'); return; }
        const ws = workspaceDir();
        if (!ws) { notice('error', 'This window has no folder open, so there is nothing to connect to. Use Prompt Forge: Attach a Project Folder to pick one.'); return; }
        await attachProject(s.slug, ws);
        return;
      }
      case 'project.pick': {
        if (!s) { notice('info', 'Create or open a prompt first.'); return; }
        const dir = await pickProjectDir();
        if (dir) await attachProject(s.slug, dir);
        return;
      }
      case 'project.menu': {
        if (!s) return;
        const list = store.read(s.slug).projects || [];
        if (!list.length) { const dir = await pickProjectDir(); if (dir) await attachProject(s.slug, dir); return; }
        const items = [];
        for (const p of list) {
          const what = p.error ? `error: ${p.error}` : `${p.files.length} file(s)${p.head ? `, ${p.head}` : ''}`;
          items.push({ label: `$(eye) View the brief for ${p.label}`, description: what, act: 'view', id: p.id });
          items.push({ label: `$(refresh) Rebuild ${p.label}'s brief`, description: p.path, act: 'refresh', id: p.id });
          items.push({ label: `$(debug-disconnect) Disconnect ${p.label}`, act: 'detach', id: p.id });
        }
        items.push({ label: '$(add) Connect another project\u2026', detail: 'For a prompt that genuinely spans repos', act: 'add' });
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Project context for this prompt' });
        if (!pick) return;
        if (pick.act === 'add') { const dir = await pickProjectDir(); if (dir) await attachProject(s.slug, dir); return; }
        if (pick.act === 'detach') { detachProject(s.slug, pick.id); return; }
        await handleMessage({ type: `project.${pick.act}`, id: pick.id });
        return;
      }
      case 'project.detach':
        if (s && m.id) detachProject(s.slug, String(m.id));
        return;
      case 'project.refresh': {
        if (!s || !m.id) return;
        const p = (store.read(s.slug).projects || []).find((x) => x.id === String(m.id));
        if (p) await attachProject(s.slug, p.path);
        return;
      }
      case 'project.view': {
        if (!s || !m.id) return;
        const p = (store.read(s.slug).projects || []).find((x) => x.id === String(m.id));
        if (!p) return;
        // Opened untitled rather than written to the library: the brief is a cache, not a document,
        // and a file on disk would be a second copy to keep in step with the sidecar.
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: p.error ? `# ${p.label}\n\nNo brief. ${p.error}\n` : `${p.brief}\n\n---\nRead ${p.files.length} file(s):\n${p.files.map((f) => `- ${f}`).join('\n')}\n` });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'rename':
        if (s) await s.rename(m.title);
        return;
      case 'polish':
        if (!s) return;
        if (!engine.selection().ok) { notice('error', engine.selection().reason); return; }
        s.polish();
        return;
      case 'copy': {
        if (!s) return;
        const text = await s.copyText();
        await vscode.env.clipboard.writeText(text);
        // The button turns into a tick for a moment. A bar the eye has to travel to, to read a
        // number it can already see at the foot of the prompt, is worse than no bar.
        const p = getPanel();
        if (p) p.webview.postMessage({ type: 'copied', chars: text.length });
        log.info(`copied ${text.length} characters for ${targets.labelOf(s.snapshot().target)}`);
        return;
      }
      case 'restore': {
        if (!s) return;
        const r = await s.restore(m.snapshotId);
        if (!r.ok) notice('info', r.reason === 'busy' ? 'Wait for the engine to finish before restoring.' : 'That version is gone.');
        return;
      }
      case 'resolve':
        if (s && m.conflictId && (m.keep === 'new' || m.keep === 'old')) s.resolve(m.conflictId, m.keep);
        return;
      case 'retry':
        if (s) { if (m.entryId) s.retry(m.entryId); else s.retryAll(); }
        return;
      case 'editIdea':
        if (!s) return;
        if (!engine.selection().ok) { notice('error', engine.selection().reason); return; }
        if (!s.editIdea(m.entryId, m.text)) notice('info', 'Nothing changed.');
        return;
      case 'openDoc':
        await openDoc();
        return;
      case 'openLibrary':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(store.dir));
        return;
      case 'openUrl':
        if (m.url && /^(https?|mailto):/i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', m.query ? String(m.query) : '@ext:trifactorscaling.prompt-forge-trifactor');
        return;
      case 'setProjectContext':
        if (m.value === 'off' || m.value === 'brief') { await updateSetting('projectContext', m.value); post(); }
        return;
      case 'setDocEditor':
        if (m.value === 'forge' || m.value === 'office' || m.value === 'text') {
          await updateSetting('docEditor', m.value);
          post();
        }
        return;
      case 'setLayout': {
        if (m.mode === 'auto' || m.mode === 'columns' || m.mode === 'rows') await updateSetting('layout', m.mode);
        if (Number.isFinite(m.stackWidth)) await updateSetting('layoutStackWidth', Math.max(0, Math.min(2000, Math.round(m.stackWidth))));
        // The divider sends this on every drop; clamp here so a webview cannot write nonsense.
        if (Number.isFinite(m.split)) await updateSetting('layoutSplit', Math.max(20, Math.min(80, Math.round(m.split))));
        // The command sends `toggleRail` because it has no idea what the current state is; the
        // panel's own chevron sends the value it wants, so a stale webview cannot flip the wrong way.
        if (m.toggleRail) await updateSetting('railCollapsed', !layoutState().railCollapsed);
        else if (typeof m.railCollapsed === 'boolean') await updateSetting('railCollapsed', m.railCollapsed);
        post();
        return;
      }
      case 'engine.detect':
        await engine.detectAll();
        post();
        return;
      case 'engine.signIn':
        await signIn(m.provider || await pickProvider('Sign in to which engine?', (p) => Boolean(p.signIn)), m.mode || 'cli');
        return;
      case 'engine.setKey':
        await setKey(m.provider || await pickProvider('Store an API key for which engine?'));
        return;
      case 'engine.forgetKey':
        await forgetKey(m.provider || await pickProvider('Forget the API key for which engine?'));
        return;
      case 'engine.select':
        await selectEngine(m);
        return;
      default:
        log.debug(`unhandled message from the webview: ${m.type}`);
    }
  }

  /** Open (or re-open, after a libraryPath change) the prompt library. Failure is a state, not a crash. */
  function openStore() {
    const cfg = config();
    const wanted = cfg.libraryPath || '~/.prompt-forge/prompts';
    try {
      const next = storeMod.open(wanted);
      if (store && store.dir === next.dir) return;
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
      activeSlug = null;
      store = next;
      bootError = null;
      log.info(`library: ${store.dir}`);
    } catch (e) {
      store = null;
      bootError = `${wanted}: ${e.message}`;
      log.error(`cannot open the prompt library: ${bootError}`);
    }
  }

  // ------------------------------------------------------------------------------------------

  return {
    html: view.html,
    /** One open document editor, handed over by the cold shell on open and again after a reload. */
    attachDoc: (document, panel, gen) => docEditors.attach(document, panel, gen),
    detachDoc: (panel) => docEditors.detach(panel),
    handleMessage,
    replay() { post(); },
    start() {
      openStore();
      disposables.push(vscode.workspace.onDidSaveTextDocument((d) => { if (d && d.uri) docio.noteSaved(d.uri.fsPath); }));
      // A hand edit in the editor shows up in the prompt panel within a moment.
      disposables.push(vscode.workspace.onDidChangeTextDocument((e) => {
        const s = active();
        if (s && e.document && e.document.uri && docio.same(e.document.uri.fsPath, s.docPath)) repaintSoon();
      }));
      // The kit watches sourcePath/autoReload; the settings that change behaviour are watched here.
      disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('promptForge.libraryPath')) { openStore(); post(); }
        if (e.affectsConfiguration('promptForge.layout') || e.affectsConfiguration('promptForge.layoutStackWidth') || e.affectsConfiguration('promptForge.layoutSplit') || e.affectsConfiguration('promptForge.railCollapsed')) post();
        if (['promptForge.engine', 'promptForge.cli', 'promptForge.compatible'].some((k) => e.affectsConfiguration(k))) {
          engine.detectAll().then(() => { if (!disposed) post(); });
        }
      }));
      if (!store) { post(); return; }
      engine.detectAll().then((sel) => {
        if (disposed) return;
        log.info(sel.ok ? `engine: ${sel.provider}/${sel.mode} merge=${sel.mergeModel} polish=${sel.polishModel}` : `engine: ${sel.reason}`);
        post();
      });
      const last = globalState.get(LAST_OPEN);
      if (last && store.exists(last)) {
        openSession(last, { reveal: false }).catch((e) => log.error(`could not reopen ${last}: ${e.message}`));
      } else {
        post();
      }
    },
    dispose() {
      disposed = true;
      clearTimeout(repaintTimer);
      docEditors.dispose();
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
      for (const d of disposables) { try { d.dispose(); } catch { /* already gone */ } }
    },
  };
}

module.exports = { create };
