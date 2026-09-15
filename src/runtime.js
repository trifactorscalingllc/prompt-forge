'use strict';
// The HOT entry point. Everything here is disposed and re-required on reload. It holds no
// registration VS Code will not let us redo: the panel, the secrets and the settings come in
// through the host object, owned by extension.js.
//
// create() must touch nothing but `host` (the shell test builds it with a vscode that throws on
// any access); every VS Code side effect lives in start() or a message handler.
const crypto = require('node:crypto');
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
const { runCli, openCli, resolveBin } = require('./providers/spawn');
const targets = require('./targets');
const docm = require('./doc');
const { modelBlurb, ROLE_BLURBS } = require('./blurbs');
const project = require('./project');
const remote = require('./remote');
const sendMod = require('./send');
const suggestMod = require('./suggest');
const { createAutoForge } = require('./autoforge/controller');
const { createAgent } = require('./autoforge/agent');
const { createInstaller, pluginVersion } = require('./autoforge/install');
const afDetect = require('./autoforge/detect');
const clipfiles = require('./clipfiles');
const { selectionIdea } = require('./selection');
const { createSync } = require('./sync');
const { lintPrompt } = require('./lint');
const { diffSections } = require('./addendum');
const templates = require('./templates');
const { createLive } = require('./live');
const { createHostCommands } = require('./live/commands');
const { slugOfRel } = require('./live/files');
const { LIMITS } = require('./attachments');
const { createBriefs } = require('./briefs');

const LAST_OPEN = 'promptForge.lastOpen';
const CLAUDE_EXTENSION = 'anthropic.claude-code';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function create(host) {
  const { log, vscode, config, getPanel, ensurePanel, globalState, secrets } = host;

  let store = null;
  let bootError = null;
  let disposed = false;
  const sessions = new Map();
  let activeSlug = null;
  const disposables = [];

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

  /** The configuration with this session's unsaved settings laid over it. What every consumer reads. */
  function effectiveConfig() {
    const c = config() || {};
    const engineCfg = { ...(c.engine || {}) };
    for (const k of ['mergeEffort', 'polishEffort', 'prewarm', 'mergeOutput']) if (overrides.has(`engine.${k}`)) engineCfg[k] = overrides.get(`engine.${k}`);
    const sync = { ...(c.sync || {}) };
    for (const k of ['remote', 'intervalMinutes', 'auto']) if (overrides.has(`sync.${k}`)) sync[k] = overrides.get(`sync.${k}`);
    const proj = { ...(c.project || {}) };
    if (overrides.has('projectContext')) proj.context = overrides.get('projectContext');
    if (overrides.has('projectRoots')) proj.roots = overrides.get('projectRoots');
    if (overrides.has('tokenBudget')) proj.tokenBudget = overrides.get('tokenBudget');
    return { ...c, engine: engineCfg, sync, project: proj, suggestions: setting('suggestions', c.suggestions) };
  }

  const docio = createDocio(vscode, { log });
  // The custom editor is registered by the cold shell; this owns what happens inside one.
  const docEditors = createDocEditors({
    vscode, docio, log,
    docHtml: view.docHtml,
    mediaRoots: () => (host.mediaRoots ? host.mediaRoots() : []),
  });
  const providers = createProviders({ runCli, openCli, resolveBin, fetch: globalThis.fetch, fs, home: os.homedir() });
  const engine = createEngine({ providers, config: effectiveConfig, secrets, log });

  // A live library (src/live): this window shares its library, or has joined someone else's. What a
  // joined window asks for arrives here as a command and runs on the same sessions the panel uses.
  const hostCommands = createHostCommands({
    getStore: () => store,
    ensureSession: (slug) => ensureSession(slug),
    removePrompt: (slug) => removePrompt(slug),
    engineSelection: () => engine.selection(),
    docio,
    keepBodies: () => { const n = (config() || {}).keepVersionBodies; return Number.isFinite(n) ? n : 20; },
    post: () => post(),
  });
  const live = createLive({
    log, secrets, globalState,
    accountOf: () => engineAccount(),
    onCommand: (who, cmd, args, bytes) => hostCommands.run(who, cmd, args, bytes),
    onEvent: (e) => onLiveEvent(e),
    writeDoc: (abs, text, rel) => mirrorWrite(abs, text, rel),
  });

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

  const engineOptions = () => {
    const e = effectiveConfig().engine || {};
    return { mergeEffort: e.mergeEffort || 'low', polishEffort: e.polishEffort || 'auto', prewarm: e.prewarm !== false, mergeOutput: e.mergeOutput || 'edits' };
  };

  function buildState() {
    if (!store) {
      if (!bootError) return null;
      return { bootError, library: config().libraryPath, prompts: [], active: null, engine: engine.state(), targets: targets.TARGETS, docEditor: setting('docEditor', config().docEditor), layout: layoutState(), engineCfg: config().engine || {} };
    }
    const session = activeSlug ? sessions.get(activeSlug) : null;
    const snap = session ? session.snapshot() : null;
    // In a joined library the engine runs in the sharer's window, so what it is doing comes from there.
    if (snap && live.isGuest()) { const remote = live.engineFor(snap.slug); if (remote) snap.engine = remote; }
    // A project connected with its quick brief says so while the engine writes the fuller one.
    if (snap && snap.projects.length) snap.projects = snap.projects.map((p) => (briefs.refining(p.path, p.host) ? { ...p, refining: true } : p));
    return {
      library: store.dir,
      prompts: store.list(),
      active: snap,
      live: live.state(),
      engine: engine.state(),
      targets: targets.TARGETS,
      docEditor: setting('docEditor', config().docEditor),
      layout: layoutState(),
      engineCfg: config().engine || {},
      engineOptions: engineOptions(),
      project: projectCfg(),
      projectBusy: activeSlug ? attaching.has(activeSlug) : false,
      suggestions: setting('suggestions', config().suggestions) !== false,
      blurbs: blurbs(engine.state()),
      sync: syncState(),
      hasClaudeExtension: hasClaudeExtension(),
      autoForge: (() => { const a = autoForgeSettings(); return { mode: a.mode, minChars: a.minChars, minPrompts: a.minPrompts, listening: Boolean(afAgent && afAgent.owns()) }; })(),
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

  /** Streaming progress: a few bytes, several times a second, without rebuilding the whole state. */
  function postProgress(slug) {
    const p = getPanel();
    const s = sessions.get(slug);
    if (!p || !s || slug !== activeSlug) return;
    p.webview.postMessage({ type: 'progress', slug, engine: s.progress() });
  }

  let repaintTimer = null;
  function repaintSoon(ms = 300) {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => { if (!disposed) post(); }, ms);
  }

  /** A line in the panel's notice bar, with an optional button: { label, message } posts `message` back. */
  function notice(level, text, action = null) {
    const p = getPanel();
    if (p) p.webview.postMessage({ type: 'notice', level, text, action });
    if (level === 'error') log.error(text); else if (level === 'warn') log.warn(text); else log.info(text);
  }

  // ------------------------------------------------------------------------------------------
  // In-panel dialogs
  //
  // Every choice and every typed answer happens inside the Prompt Forge panel, in the floating style
  // of the model picker -- never in VS Code's box at the top of the window or a toast in the corner.
  // The runtime asks, the panel draws, and the answer comes back as `ui.reply`. A question asked
  // before the panel has loaded is replayed when it reports `ready`; the panel ignores an id it has
  // already shown, so a replay can never show one twice.
  // ------------------------------------------------------------------------------------------
  let uiSeq = 0;
  const uiPending = new Map();   // id -> { resolve, msg }
  const onceQueue = new Map();   // once -> msg, for messages the panel must act on exactly once

  const panelNow = () => getPanel() || (ensurePanel ? ensurePanel() : null);

  function ui(kind, opts) {
    return new Promise((resolve) => {
      uiSeq += 1;
      const id = `ui${Date.now().toString(36)}${uiSeq}`;
      const msg = { type: 'ui.open', id, kind, ...opts };
      uiPending.set(id, { resolve, msg });
      const p = panelNow();
      if (p) p.webview.postMessage(msg);
    });
  }
  /** The `value` of one of `items` ({ value, label, description?, detail?, icon? }), or null. */
  const uiPick = (opts) => ui('pick', opts);
  /** The text typed, or null when cancelled. `pattern` is a regex source; `allowEmpty` accepts ''. */
  const uiAsk = (opts) => ui('ask', opts);
  /** true only when the person confirmed. */
  const uiConfirm = async (opts) => (await ui('confirm', opts)) === true;

  /** A message the panel acts on once, even when it is still loading (a draft, a focus). */
  function panelOnce(msg) {
    uiSeq += 1;
    const once = `once${Date.now().toString(36)}${uiSeq}`;
    const full = { ...msg, once };
    onceQueue.set(once, full);
    const p = panelNow();
    if (p) p.webview.postMessage(full);
  }

  // ------------------------------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------------------------------

  const opening = new Map();

  /** A prompt's session, loaded once, without making it the prompt the panel shows. */
  function ensureSession(slug) {
    if (sessions.has(slug)) return Promise.resolve(sessions.get(slug));
    if (opening.has(slug)) return opening.get(slug);
    const loading = (async () => {
      const guest = live.isGuest();
      const lib = store;
      const s = createSession({
        slug, store, docio, engine, cfg: effectiveConfig, log, readOnly: guest,
        publish: (why) => {
          // Everyone in a shared library sees each prompt's engine at work, not only the one open here.
          if (live.isHost()) live.engine(slug, s.progress());
          if (why === 'progress') { postProgress(slug); return; }
          if (why.startsWith('notice:')) notice('info', why.slice('notice:'.length));
          if (why === 'landed') syncSoon('change');
          if (slug === activeSlug) post();
        },
      });
      await s.load();
      // Joined or left a live library while this was opening: it belongs to a library no longer shown.
      if (store !== lib || disposed) { s.dispose(); throw new Error('The library changed while that prompt was opening.'); }
      if (guest) {
        const raw = await docio.readDoc(store.docPath(slug));
        liveDoc(slug).base = docm.stripConflictBlock(raw == null ? '' : raw);
      }
      sessions.set(slug, s);
      return s;
    })();
    opening.set(slug, loading);
    loading.then(() => opening.delete(slug), () => opening.delete(slug));
    return loading;
  }

  async function openSession(slug, { reveal = false } = {}) {
    const s = await ensureSession(slug);
    if (!sessions.has(slug)) return s;
    activeSlug = slug;
    // The last prompt reopened on start is one from this window's own library, never a joined one.
    if (!live.isGuest()) await globalState.update(LAST_OPEN, slug);
    live.view(slug);
    post();
    if (reveal) await openDoc();
    return s;
  }

  /** Delete a prompt: to the library's trash, its session closed. */
  async function removePrompt(slug) {
    const sess = sessions.get(slug);
    if (sess) { sess.dispose(); sessions.delete(slug); }
    store.remove(slug);
    if (activeSlug === slug) {
      activeSlug = null;
      if (!live.isGuest()) await globalState.update(LAST_OPEN, undefined);
      live.view(null);
    }
    post();
  }

  const active = () => (activeSlug ? sessions.get(activeSlug) : null);

  async function openDoc() {
    const s = active();
    if (!s) return;
    try { await docio.openBeside(s.docPath, { editor: config().docEditor }); } catch (e) { notice('error', `Could not open the document: ${e.message}`); }
  }

  /** The prompt an out-of-panel command acts on: the open one, else the last one, else a new one. */
  async function sessionForCommand() {
    if (!store) return null;
    if (active()) return active();
    if (live.isGuest()) {
      const first = store.list()[0];
      return first ? openSession(first.slug) : null;
    }
    const last = globalState.get(LAST_OPEN);
    if (last && store.exists(last)) return openSession(last);
    const { slug } = store.create('Untitled');
    return openSession(slug);
  }

  // ------------------------------------------------------------------------------------------
  // Engine sign-in
  // ------------------------------------------------------------------------------------------

  const providerById = (id) => providers.find((p) => p.id === id) || null;

  async function pickProvider(title, filter = () => true) {
    return uiPick({ title, items: providers.filter(filter).map((p) => ({ value: p.id, label: p.label, icon: 'engine' })) });
  }

  // ------------------------------------------------------------------------------------------
  // Project context
  //
  // Two scopes, deliberately different sizes. The picker LISTS several roots — names and paths
  // only, never a file. The brief READS exactly one folder, the one the person chose. Umbrella
  // reading is refused; docs/project-context.md records why, because it will be proposed again.
  // A project on an SSH host is the same one folder, read through ssh under the same rules.
  // ------------------------------------------------------------------------------------------
  const projectCfg = () => {
    const p = effectiveConfig().project || {};
    return {
      roots: Array.isArray(p.roots) ? p.roots : [],
      context: ['off', 'brief', 'brief+lookup'].includes(p.context) ? p.context : 'brief',
      tokenBudget: Number.isFinite(p.tokenBudget) ? p.tokenBudget : 0,
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

  /** { dir, host } for the project the person chose, or null. */
  async function pickProjectDir() {
    const cfg = projectCfg();
    const ws = workspaceDir();
    const items = [];
    if (ws) items.push({ value: ws, label: path.basename(ws), description: 'The folder this window has open', detail: ws, icon: 'root' });
    for (const p of project.discover(cfg.roots, { fs, home: os.homedir() })) {
      if (ws && p.path === ws) continue;
      items.push({ value: p.path, label: p.label, detail: p.path, icon: 'folder' });
    }
    items.push({ value: '\u0000browse', label: 'Browse…', description: 'Pick any folder', icon: 'open' });
    items.push({ value: '\u0000ssh', label: 'A project on another machine, over SSH…', description: 'A Mac mini, a server: anything in ~/.ssh/config', icon: 'remote' });
    items.push({ value: '\u0000roots', label: 'Add a folder to list projects from…', description: 'Its projects show up in this list from then on', icon: 'add' });
    const choice = await uiPick({ title: 'Which project is this prompt for? Only the folder you choose is read.', items, filter: items.length > 7, anchor: 'connect' });
    if (!choice) return null;
    if (choice === '\u0000roots') {
      // The operating system's folder dialog is the one window that is not the panel: there is no
      // other way to point at a folder that is not already listed.
      const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'List projects from this folder' });
      if (!sel || !sel.length) return null;
      await updateSetting('projectRoots', [...new Set([...cfg.roots, sel[0].fsPath])]);
      return pickProjectDir();
    }
    if (choice === '\u0000ssh') return pickRemoteProject();
    if (choice === '\u0000browse') {
      const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Attach this project' });
      return sel && sel.length ? { dir: sel[0].fsPath, host: null } : null;
    }
    return { dir: choice, host: null };
  }

  /** A host from ~/.ssh/config (or typed), then a folder on it. { dir, host } or null. */
  async function pickRemoteProject() {
    const ssh = resolveBin('ssh', {});
    if (!ssh) { notice('error', 'ssh is not on your PATH. Install OpenSSH to attach a project on another machine.'); return null; }
    const extraConfig = String(vscode.workspace.getConfiguration('remote.SSH').get('configFile', '') || '');
    const hosts = remote.sshHosts({ extra: extraConfig ? [storeMod.expandHome(extraConfig)] : [] });
    const items = hosts.map((h) => ({ value: h.host, label: h.host, description: [h.user, h.hostName].filter(Boolean).join('@'), icon: 'remote' }));
    items.push({ value: '\u0000type', label: 'Type a host…', description: 'A name from ~/.ssh/config, or user@address', icon: 'edit' });
    const choice = await uiPick({ title: 'Which machine is the project on?', detail: 'SSH keys or an agent are used; a password prompt cannot be answered from here.', items, filter: items.length > 7, anchor: 'connect' });
    if (!choice) return null;
    let sshHost = choice;
    if (sshHost === '\u0000type') {
      sshHost = String(await uiAsk({ title: 'SSH host', placeholder: 'mac-mini or me@192.168.1.20', pattern: '^[A-Za-z0-9._@-]{1,253}$', patternMessage: 'Letters, digits, dots, dashes, underscores and @ only', okLabel: 'Connect' }) || '').trim();
      if (!sshHost || !remote.validHost(sshHost)) return null;
    }
    notice('info', `Looking for projects on ${sshHost}…`);
    const found = await remote.discoverRemote({ runCli, ssh, host: sshHost });
    if (found.error) notice('warn', `Could not list projects on ${sshHost}: ${found.error}. You can still type a path.`);
    const dirs = found.dirs.map((d) => ({ value: d, label: d, icon: 'folder' }));
    dirs.push({ value: '\u0000type', label: 'Type a path…', icon: 'edit' });
    const dp = await uiPick({ title: `Which folder on ${sshHost}? Only the folder you choose is read.`, items: dirs, filter: dirs.length > 7, anchor: 'connect' });
    if (!dp) return null;
    let dir = dp;
    if (dir === '\u0000type') {
      dir = String(await uiAsk({ title: `Folder on ${sshHost}`, placeholder: '~/projects/my-app', okLabel: 'Attach' }) || '').trim();
      if (!dir) return null;
    }
    return { dir, host: sshHost };
  }

  /** What connecting reads: the one folder, here or over ssh. { files, tree, text, truncated, head? } or { error }. */
  async function collectProject(dir, sshHost) {
    const cfg = projectCfg();
    if (sshHost) {
      const ssh = resolveBin('ssh', {});
      if (!ssh) return { error: 'ssh is not on your PATH' };
      return remote.collectRemote({ runCli, ssh, host: sshHost, dir, maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes });
    }
    return project.collect(dir, { fs, maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes });
  }

  /** The engine's brief: one call with the polish model, made in the background, reused on every merge after. */
  async function describeProject({ label, dir, collected }) {
    const res = await engine.call({
      role: 'polish',
      prompt: project.buildBriefPrompt({ label, dir, collected }),
      timeoutMs: ((config().engine || {}).timeoutSeconds || 240) * 1000,
    });
    if (res.error) return { error: res.error };
    const brief = project.capBrief(res.text);
    if (!brief) return { error: 'The engine returned an empty brief.' };
    return { brief, call: res.call ? { model: res.call.model, in: (res.call.usage || {}).input || 0, out: (res.call.usage || {}).output || 0 } : null };
  }

  const briefs = createBriefs({
    getStore: () => store, collect: collectProject, describe: describeProject, gitHead, log,
    onChange: (slug) => { const sess = sessions.get(slug); if (sess) sess.reread(); post(); },
  });

  // Building a brief is one engine call, which is seconds. Without this the plug looked dead for
  // all of them, so it got clicked again, and every click started another attach.
  const attaching = new Set();

  // Connecting is a read of the project's own files, which takes a moment, never an engine call,
  // which takes half a minute (src/briefs.js). `force` is Rebuild: no reuse, a new engine brief.
  async function attachProject(slug, dir, sshHost = null, { force = false } = {}) {
    if (!store || !slug) return;
    if (attaching.has(slug)) { notice('info', 'Still connecting to that project. One moment.'); return; }
    attaching.add(slug);
    post();   // the panel has to show it started before the call, not after it finishes
    let res;
    try {
      res = await briefs.attach(slug, dir, sshHost, { force, engineReady: engine.selection().ok });
    } finally {
      attaching.delete(slug);
    }
    const sess = sessions.get(slug); if (sess) sess.reread();
    const p = res.record;
    if (res.error) {
      notice('error', `Could not connect ${p.label}: ${res.error}`);
    } else {
      const more = res.reused ? '' : engine.selection().ok ? ' The engine is writing a fuller brief in the background.' : ' Sign in to an engine and rebuild it for a fuller brief.';
      notice('info', `Connected to ${p.label}: read ${p.files.length} file${p.files.length === 1 ? '' : 's'}.${more}`);
    }
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
      const choice = await uiPick({
        title: `The ${p.label} CLI is not on your PATH.`,
        detail: 'Install it and sign in, or use an API key instead.',
        items: [
          ...(p.installUrl ? [{ value: 'install', label: 'Open the install page', description: p.installUrl, icon: 'link' }] : []),
          { value: 'key', label: 'Use an API key instead', description: 'Stored in your OS keychain, never in settings', icon: 'key' },
        ],
      });
      if (choice === 'install' && p.installUrl) await vscode.env.openExternal(vscode.Uri.parse(p.installUrl));
      if (choice === 'key') await setKey(id);
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
    const value = await uiAsk({
      title: `API key for ${p.label}`,
      detail: `${p.keyUrl ? `Get one at ${p.keyUrl}. ` : ''}It is stored in your OS keychain, never in settings, logs or files.`,
      placeholder: 'Paste the key', password: true, okLabel: 'Store key',
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
  // Leaving the tool: variables, attached files, and sending to Claude Code
  // ------------------------------------------------------------------------------------------

  // A variable asked about once and left empty is not asked about again this session: the slot is
  // what the person chose, and a dialog on every copy would be a tax on that choice.
  const askedVars = new Map();

  /** Ask for any {{variable}} with no value. false when the person cancelled. */
  async function fillMissingVars(s) {
    const { names, values } = s.variables();
    const asked = askedVars.get(s.slug) || new Set();
    askedVars.set(s.slug, asked);
    const missing = names.filter((n) => !values[n] && !asked.has(n.toLowerCase()));
    if (!missing.length) return true;
    const next = {};
    for (const n of missing) {
      const v = await uiAsk({ title: `Value for {{${n}}}`, detail: 'Leave it empty to keep the slot as it is. Values are remembered for this prompt and can be changed under it.', placeholder: n, allowEmpty: true, okLabel: 'Use this' });
      if (v === null) return false;
      asked.add(n.toLowerCase());
      if (v) next[n] = v;
    }
    if (Object.keys(next).length) {
      if (live.isGuest()) {
        store.setVars(s.slug, next);
        s.reread();
        await liveAsk('setVars', { slug: s.slug, values: next });
      } else {
        s.setVars(next);
      }
    }
    return true;
  }

  /** After a copy that lists files: a button on the panel's notice bar puts the files on the clipboard. */
  function offerFiles(files) {
    if (!files.length) return;
    notice('info', `Copied. ${files.length} attached file${files.length === 1 ? ' is' : 's are'} listed at the end. Paste the prompt, then copy the files and paste them beside it.`, { label: 'Copy the files', message: { type: 'copyFiles' } });
  }

  async function copyFilesNow(files) {
    if (!files.length) { notice('info', 'This prompt has no attached files.'); return; }
    const r = await clipfiles.copyFiles(files.map((f) => f.path), { runCli, resolveBin });
    if (r.ok) notice('info', `${files.length} file${files.length === 1 ? '' : 's'} on the clipboard. Paste ${files.length === 1 ? 'it' : 'them'} into the conversation.`);
    else notice('error', `Could not put the files on the clipboard: ${r.error}. Their paths are in the copied prompt.`);
  }

  const hasClaudeExtension = () => { try { return Boolean(vscode.extensions && vscode.extensions.getExtension(CLAUDE_EXTENSION)); } catch { return false; } };

  /** Where a send can go for this prompt: its local project (or the open folder), and an SSH project if it has one. */
  function sendPlaces(s) {
    const projs = (store.read(s.slug).projects || []).filter((p) => !p.error);
    const local = projs.find((p) => !p.host);
    const far = projs.find((p) => p.host);
    return { folder: (local && local.path) || workspaceDir(), remote: far ? { host: far.host, dir: far.path } : null };
  }

  const claudeTerminals = () => (vscode.window.terminals || []).filter((t) => /claude/i.test(t.name));

  async function startTerminal({ name, cwd, command, text }) {
    const t = vscode.window.createTerminal({ name, cwd });
    t.show(false);
    t.sendText(command, true);
    // Claude's input only exists once it has booted; a paste before then goes to the shell.
    notice('info', 'Starting Claude in the terminal. The prompt is pasted in as soon as it is ready.');
    await sleep(6000);
    t.sendText(sendMod.pasteSequence(text), false);
    return t;
  }

  const sendSubmits = () => setting('sendSubmit', config().sendSubmit) !== false;

  // Claude reads a paste as it arrives; an Enter in the same write can land before the paste is in.
  const PASTE_SETTLE_MS = 400;
  // The billing guarantee the engine keeps holds here too: a conversation Send starts runs on the
  // Claude login, never on an API key that happens to be in the environment.
  const SUBSCRIPTION_ENV = { ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null };

  // Terminals Send started, by conversation id or remote place, so a Send update goes into the one
  // already running it instead of starting that conversation a second time.
  const launched = new Map();
  const alive = (t) => Boolean(t && !t.exitStatus && (vscode.window.terminals || []).includes(t));

  /** claude to launch directly: the configured path, PATH, then the copy the Claude Code extension ships. */
  function claudeBin() {
    const ext = vscode.extensions && vscode.extensions.getExtension(CLAUDE_EXTENSION);
    const bundled = ext ? path.join(ext.extensionPath, 'resources', 'native-binary', process.platform === 'win32' ? 'claude.exe' : 'claude') : null;
    return sendMod.launchBin([
      resolveBin('claude', { configured: (config().cli || {}).claudePath }),
      bundled && fs.existsSync(bundled) ? bundled : null,
    ]);
  }

  function claudeIcon() {
    const ext = vscode.extensions && vscode.extensions.getExtension(CLAUDE_EXTENSION);
    const svg = ext && path.join(ext.extensionPath, 'resources', 'claude-logo.svg');
    return svg && fs.existsSync(svg) ? vscode.Uri.file(svg) : undefined;
  }

  /** A terminal beside the editor whose process is claude (or ssh) itself, so the prompt is one argument and needs no quoting. */
  function launch({ key, name, cwd, shellPath, shellArgs }) {
    const t = vscode.window.createTerminal({ name, cwd, shellPath, shellArgs, env: SUBSCRIPTION_ENV, iconPath: claudeIcon(), location: { viewColumn: vscode.ViewColumn.Beside } });
    t.show(false);
    if (key) launched.set(key, t);
    return t;
  }

  async function pasteAndEnter(t, text) {
    t.show(false);
    t.sendText(sendMod.pasteSequence(text), false);
    await sleep(PASTE_SETTLE_MS);
    t.sendText('\r', false);
  }

  /**
   * Deliver `text` to `item`. Returns { ran, sessionId?, why? }: ran is whether it was submitted, and
   * why says what stopped a submit the setting asked for (the prompt is still delivered, unsent).
   */
  async function deliver(item, text, { folder = null } = {}) {
    let why = '';
    if (sendSubmits()) {
      const bin = ['session', 'new-panel', 'new-terminal'].includes(item.kind) ? claudeBin() : null;
      const ssh = item.kind === 'remote' ? resolveBin('ssh', {}) : null;
      const cwd = folder || workspaceDir() || undefined;
      switch (item.kind) {
        case 'terminal': {
          const t = claudeTerminals().find((x) => x.name === item.name);
          if (!t) throw new Error(`the terminal "${item.name}" is closed`);
          await pasteAndEnter(t, text);
          return { ran: true };
        }
        case 'session': {
          const open = launched.get(item.id);
          if (alive(open)) { await pasteAndEnter(open, text); return { ran: true }; }
          if (!bin) { why = 'claude was not found to run it'; break; }
          if (!sendMod.fitsArgv(text)) { why = 'it is too long to start a conversation with'; break; }
          launch({ key: item.id, name: `Claude · ${sendMod.oneLine(item.title || item.id, 30)}`, cwd, shellPath: bin, shellArgs: sendMod.claudeArgs({ text, resume: item.id }) });
          return { ran: true };
        }
        case 'new-panel':
        case 'new-terminal': {
          if (!bin) { why = 'claude was not found to run it'; break; }
          if (!sendMod.fitsArgv(text)) { why = 'it is too long to start a conversation with'; break; }
          // Our own id, so the conversation is known at once and a Send update can reach it.
          const sessionId = crypto.randomUUID();
          launch({ key: sessionId, name: `Claude · ${path.basename(item.folder || cwd || '')}`, cwd: item.folder || cwd, shellPath: bin, shellArgs: sendMod.claudeArgs({ text, sessionId }) });
          return { ran: true, sessionId };
        }
        case 'remote': {
          const key = `remote:${item.host}:${item.dir}`;
          const open = launched.get(key);
          if (alive(open)) { await pasteAndEnter(open, text); return { ran: true }; }
          if (!ssh) { why = 'ssh was not found'; break; }
          if (!sendMod.fitsArgv(text)) { why = 'it is too long to start a conversation with'; break; }
          launch({ key, name: `Claude · ${item.host}`, shellPath: ssh, shellArgs: sendMod.remoteLaunchArgs(item.host, item.dir, text) });
          return { ran: true };
        }
        default:
          throw new Error(`nowhere to send "${item.kind}"`);
      }
    }
    switch (item.kind) {
      case 'terminal': {
        const t = claudeTerminals().find((x) => x.name === item.name);
        if (!t) throw new Error(`the terminal "${item.name}" is closed`);
        t.show(false);
        t.sendText(sendMod.pasteSequence(text), false);
        return { ran: false, why };
      }
      case 'session':
        if (!hasClaudeExtension()) throw new Error('the Claude Code extension is not installed');
        await vscode.commands.executeCommand('claude-vscode.editor.open', item.id, text);
        return { ran: false, why };
      case 'new-panel':
        await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, text);
        return { ran: false, why };
      case 'new-terminal':
        await startTerminal({ name: `Claude · ${path.basename(item.folder)}`, cwd: item.folder, command: 'claude', text });
        return { ran: false, why };
      case 'remote':
        await startTerminal({ name: `Claude · ${item.host}`, cwd: undefined, command: sendMod.remoteClaudeCommand(item.host, item.dir), text });
        return { ran: false, why };
      default:
        throw new Error(`nowhere to send "${item.kind}"`);
    }
  }

  /** What the notice says once a prompt is delivered. */
  const deliveredNote = (r, where, what = 'The prompt') => (r.ran
    ? `${what} is running in ${where}.`
    : `${what} is in ${where}. Press Enter there to send it.${r.why ? ` It was not sent for you: ${r.why}.` : ''}`);

  const destLabel = (d) => (d.kind === 'terminal' ? `the terminal "${d.name}"` : d.kind === 'session' ? `the conversation "${d.title || d.id}"` : d.kind === 'remote' ? `Claude on ${d.host}` : 'a new Claude Code conversation');

  // ------------------------------------------------------------------------------------------
  // Send: where the prompt can go is listed in the panel's own floating menu, under the Send
  // button, like the model picker. Nothing here opens a picker at the top of the window; the runtime
  // only works out the choices and delivers the one the panel sends back.
  // ------------------------------------------------------------------------------------------

  // The command palette can ask for the menu before the panel has loaded; it is shown on `ready`.
  let pendingSendMenu = false;

  /** The destinations, worked out fresh: what is open now is what can be offered. */
  function sendPlan(s) {
    const snap = s.snapshot();
    const { folder, remote: far } = sendPlaces(s);
    const terminals = claudeTerminals().map((t) => ({ name: t.name }));
    const sessionsHere = folder ? sendMod.recentSessions(folder) : [];
    let remembered = snap.sent && snap.sent.dest;
    // A send to a new conversation only has an id once the person pressed Enter there. Find it now.
    if (remembered && remembered.kind === 'new-panel') {
      const found = sendMod.findSentSession({ folder: remembered.folder, sentAt: snap.sent.ts, promptStart: remembered.promptStart });
      remembered = found ? { kind: 'session', id: found.id, title: found.title } : null;
    }
    // A conversation that runs on send is resumed by claude itself, so it needs no panel to be offered.
    const items = sendMod.destinations({ folder, terminals, sessions: sessionsHere, hasClaudeExtension: hasClaudeExtension() || sendSubmits(), remembered, remote: far });
    return { snap, items, remembered };
  }

  const sameDest = (a, b) => Boolean(a && b && a.kind === b.kind && (
    a.kind === 'terminal' ? a.name === b.name
      : a.kind === 'session' ? a.id === b.id
        : a.kind === 'remote' ? a.host === b.host && a.dir === b.dir
          : a.folder === b.folder));

  /** The menu's contents, as plain data. The panel draws the icons; nothing here can become a command. */
  function postSendMenu(s, extra = {}) {
    const p = getPanel();
    if (!p || !s) return;
    const { snap, items } = sendPlan(s);
    const { names, values } = s.variables();
    p.webview.postMessage({
      type: 'sendMenu',
      items: items.map(({ kind, label, description, last, name, id, title, folder, host, dir }) => ({ kind, label, description, last: Boolean(last), name, id, title, folder, host, dir })),
      unfilled: names.filter((n) => !values[n]),
      files: snap.files.length,
      submit: sendSubmits(),
      ...extra,
    });
  }

  /** Deliver the whole prompt to the place the person picked in the panel. */
  async function sendTo(s, dest) {
    // The choice is matched against the list as it is now, never trusted as sent: a terminal closed
    // while the menu was open is not somewhere to type into.
    const item = sendPlan(s).items.find((i) => sameDest(i, dest));
    if (!item) { notice('warn', 'That place is no longer there. Pick another.'); postSendMenu(s, { open: true }); return; }
    const text = await s.sendText();
    let r;
    try {
      r = await deliver(item, text, { folder: sendPlaces(s).folder });
    } catch (e) {
      notice('error', `Could not send: ${e.message}`);
      return;
    }
    const { label: _l, description: _d, last: _last, index: _i, ...rest } = item;
    const promptStart = text.split('\n').find((l) => l.trim()) || '';
    // A conversation started with our own id is known now; one opened in the panel only once Enter is pressed there.
    const record = r.sessionId ? { kind: 'session', id: r.sessionId, title: sendMod.oneLine(promptStart) }
      : rest.kind === 'new-panel' ? { kind: 'new-panel', folder: rest.folder, promptStart } : rest;
    await s.markSent(record);
    notice('info', deliveredNote(r, destLabel(item)));
    post();
  }

  /**
   * Send update: only what changed since the last send, to the same place, when that place still
   * exists. When it is gone the menu opens instead, because a new conversation needs the whole prompt.
   */
  async function sendUpdate(s) {
    const { items, remembered } = sendPlan(s);
    const add = await s.sendNewText();
    if (!add) { notice('info', 'Nothing has been merged since your last send.'); return; }
    const live = remembered && items.find((d) => d.last);
    if (live) {
      try {
        const r = await deliver(live, add.text, { folder: sendPlaces(s).folder });
        await s.markSent(remembered);
        notice('info', `${deliveredNote(r, destLabel(remembered), 'What changed')}${add.restyled ? ' The prompt was restyled since, so the whole prompt may read better.' : ''}`);
        post();
        return;
      } catch (e) {
        notice('warn', `Could not reach ${destLabel(remembered)}: ${e.message}. Pick where the whole prompt should go.`);
      }
    } else {
      notice('info', 'Where this was sent last is gone. Pick where the whole prompt should go.');
    }
    postSendMenu(s, { open: true });
  }

  // ------------------------------------------------------------------------------------------
  // Auto-forge (docs/auto-forge.md). A Claude Code chat in this window's folders that turns into a
  // bigger job is offered forging. The plugin's hooks post to a local endpoint, the controller
  // decides, and the forge is an ordinary prompt in this library, merged by the same engine as a
  // typed idea. Phase 1 asks first. A joined live library never runs it: that library is the sharer's.
  // ------------------------------------------------------------------------------------------
  const PLUGIN_SOURCE = path.join(__dirname, '..', 'claude-plugin');
  const PLUGIN_STATE = 'promptForge.autoForgePlugin';
  const EXTENSION_ID = (() => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
      return `${p.publisher}.${p.name}`;
    } catch {
      return 'trifactorscaling.prompt-forge-trifactor';
    }
  })();
  const autoForgeSettings = () => {
    const c = config().autoForge || {};
    return afDetect.settingsFrom({ mode: setting('autoForge', c.mode), minChars: setting('autoForgeMinChars', c.minChars), minPrompts: setting('autoForgeMinPrompts', c.minPrompts) });
  };
  let afAgent = null;
  let afApplying = Promise.resolve();

  /** A person's chat (not a headless run) whose folder is one of this window's. */
  function chatInScope(cwd, entrypoint) {
    if (entrypoint && /sdk/i.test(String(entrypoint))) return false;
    if (!cwd) return false;
    return (vscode.workspace.workspaceFolders || []).some((f) => {
      const rel = path.relative(f.uri.fsPath, cwd);
      return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
    });
  }

  async function waitForEntries(slug, ids, timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (!disposed && Date.now() < until) {
      if (!store || !store.exists(slug)) return null;
      const sc = store.read(slug);
      const mine = sc.entries.filter((e) => ids.includes(e.id));
      if (mine.length === ids.length && mine.every((e) => e.status === 'merged' || e.status === 'failed')) return sc;
      await sleep(400);
    }
    return null;
  }

  /** Merge a chat's long prompts: into a new prompt, or into the one this chat was forged into before. */
  async function forgeFromChat({ sessionId, cwd, texts, slug }) {
    if (!store) return { ok: false, error: 'the prompt library is not open' };
    if (live.isGuest()) return { ok: false, error: "this window is in someone else's live library" };
    const sel = engine.selection();
    if (!sel.ok) return { ok: false, error: sel.reason };
    let created = false;
    if (!slug || !store.exists(slug)) {
      slug = store.create('Untitled').slug;
      store.setOrigin(slug, { kind: 'claude-chat', sessionId, cwd });
      created = true;
    }
    const s = await ensureSession(slug);
    const before = (store.read(slug).snapshots.slice(-1)[0] || {}).id || null;
    const by = { name: 'Claude Code chat', machine: path.basename(cwd || '') };
    const ids = texts.map((t) => s.submitIdea(t, [], { by })).filter(Boolean).map((e) => e.id);
    post();
    const undo = { slug, created, before };
    const sc = await waitForEntries(slug, ids, (((config().engine || {}).timeoutSeconds) || 240) * 1000 + 30000);
    if (!sc) {
      const title = store && store.exists(slug) ? store.read(slug).title : 'Untitled';
      return { ok: true, slug, title, changes: ['Still merging when this card was written: open it in Prompt Forge for the result'], conflicts: [], undo };
    }
    const mine = sc.entries.filter((e) => ids.includes(e.id));
    if (mine.length && mine.every((e) => e.status === 'failed')) {
      if (created) await removePrompt(slug);
      return { ok: false, error: mine[0].error || 'the merge failed' };
    }
    const changes = sc.snapshots.filter((x) => (x.entryIds || []).some((id) => ids.includes(id))).flatMap((x) => x.changes || []);
    return { ok: true, slug, title: sc.title, changes, conflicts: (sc.conflicts || []).filter((c) => !c.answer), undo };
  }

  /** A new forged prompt goes to the trash; a forge into an existing one restores the version before it. */
  async function undoChatForge(u) {
    if (!u || !store || !store.exists(u.slug)) return { ok: false, reason: 'that prompt is no longer in the library' };
    if (u.created) { await removePrompt(u.slug); return { ok: true }; }
    const s = await ensureSession(u.slug);
    const r = await s.restore(u.before);
    post();
    if (r.ok) return { ok: true };
    return { ok: false, reason: r.reason === 'busy' ? 'the engine is still merging that prompt, try again in a moment' : r.reason };
  }

  function onAutoForgeEvent(e) {
    if (e.type === 'forged') notice('info', `Auto-forged ${e.count} prompts from a Claude Code chat into "${e.title}".`, { label: 'Undo', message: { type: 'autoforge.undo', id: e.forgeId } });
    else if (e.type === 'failed') notice('warn', `Auto-forge could not forge ${e.count} prompts from a Claude Code chat: ${e.error}`);
    else if (e.type === 'undone') notice('info', `Undid the auto-forge into "${e.title}". It is in the library's trash, or back to the version before.`);
    else log.info(`auto-forge: ${e.type} in chat ${String(e.sessionId || '').slice(0, 8)}`);
  }

  const autoForge = createAutoForge({
    settings: autoForgeSettings,
    engineReady: () => {
      if (!store) return { ok: false, reason: 'the prompt library is not open' };
      const sel = engine.selection();
      return sel.ok ? { ok: true } : { ok: false, reason: sel.reason };
    },
    inScope: chatInScope,
    forge: forgeFromChat,
    undo: undoChatForge,
    uriFor: (action, id) => `vscode://${EXTENSION_ID}/forge/${action}?id=${id}`,
    onEvent: onAutoForgeEvent,
    log,
  });

  const pluginInstaller = createInstaller({
    runCli,
    sourceDir: PLUGIN_SOURCE,
    log,
    claudeBin: () => resolveBin('claude', { configured: (config().cli || {}).claudePath }) || claudeBin(),
  });

  /** Listen or not, and install or remove the Claude Code plugin, to match the setting. One at a time. */
  function applyAutoForge(reason) {
    afApplying = afApplying.then(() => applyAutoForgeNow(reason)).catch((e) => log.warn(`auto-forge: ${e.stack || e.message}`));
    return afApplying;
  }

  async function applyAutoForgeNow(reason) {
    if (disposed) return;
    const on = autoForgeSettings().mode !== 'off' && Boolean(store) && !live.isGuest();
    if (on) {
      if (!afAgent) {
        afAgent = createAgent({ handle: (event, input) => autoForge.handle(event, input), log });
        await afAgent.start();
      }
      const version = pluginVersion(PLUGIN_SOURCE);
      if (globalState.get(PLUGIN_STATE) === version) return;
      const r = await pluginInstaller.ensure();
      if (!r.ok) { notice('error', `Auto-forge is on, but its Claude Code plugin could not be installed: ${r.error}`); return; }
      await globalState.update(PLUGIN_STATE, version);
      notice('info', "Auto-forge is on. Claude Code chats started from now on, in this window's folders, will offer to forge a bigger job into one prompt here. Chats already open need restarting first.");
      return;
    }
    if (afAgent) { const a = afAgent; afAgent = null; await a.dispose(); }
    // Only a person turning it off removes the plugin; a reload or a closed window must not.
    if (reason === 'setting' && globalState.get(PLUGIN_STATE)) {
      const r = await pluginInstaller.remove();
      await globalState.update(PLUGIN_STATE, undefined);
      notice(r.ok ? 'info' : 'warn', r.ok ? 'Auto-forge is off, and its Claude Code plugin is removed.' : `Auto-forge is off, but its Claude Code plugin could not be removed: ${r.error}`);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Library sync
  // ------------------------------------------------------------------------------------------
  let sync = null;
  let syncTimer = null;
  let syncDebounce = null;
  let gitMissing = false;

  const syncCfg = () => {
    const c = effectiveConfig().sync || {};
    return { remote: String(c.remote || '').trim(), intervalMinutes: Number.isFinite(c.intervalMinutes) ? c.intervalMinutes : 5, auto: c.auto !== false };
  };

  function syncState() {
    const c = syncCfg();
    const last = sync ? sync.last() : null;
    return {
      remote: c.remote, enabled: Boolean(c.remote), auto: c.auto, busy: Boolean(sync && sync.busy()), gitMissing,
      last: last ? { ok: last.ok, at: last.at, error: last.error, pulled: last.pulled, merged: last.merged.length } : null,
    };
  }

  function stopSync() {
    clearInterval(syncTimer);
    clearTimeout(syncDebounce);
    syncTimer = null;
    sync = null;
  }

  function startSync() {
    stopSync();
    const c = syncCfg();
    if (!store || !c.remote) return;
    const git = resolveBin('git', {});
    gitMissing = !git;
    if (!git) { notice('warn', 'Library sync is set up, but git is not on your PATH. Install git to sync prompts between machines.'); return; }
    sync = createSync({ dir: store.dir, runCli, git, log });
    runSync('startup', { setup: c.remote });
    if (c.auto && c.intervalMinutes > 0) syncTimer = setInterval(() => syncSoon('interval'), c.intervalMinutes * 60 * 1000);
  }

  function syncSoon(reason) {
    if (!sync || !syncCfg().auto) return;
    clearTimeout(syncDebounce);
    // A burst of merges is one sync, a little after the last of them.
    syncDebounce = setTimeout(() => runSync(reason), reason === 'change' ? 20000 : 500);
  }

  async function runSync(reason, { setup = null } = {}) {
    if (!sync || disposed) return;
    // Never pull a file out from under a merge that is about to write it.
    if ([...sessions.values()].some((x) => x.busy())) { syncSoon(reason); return; }
    post();
    const r = setup && (!sync.isRepo() || (await sync.remoteUrl()) !== setup) ? await sync.setup(setup) : await sync.syncNow({ reason });
    if (disposed) return;
    if (r.ok && (r.pulled || r.merged.length)) {
      for (const x of sessions.values()) x.reread();
      if (r.merged.length) notice('info', `Synced. Both machines had changed ${r.merged.filter((p) => p.endsWith('.forge.json')).length} prompt(s); their histories were joined and nothing was dropped.`);
    }
    if (!r.ok && (reason === 'manual' || reason === 'setup' || reason === 'startup')) notice('error', `Library sync failed: ${r.error}`);
    else if (r.ok && reason === 'manual') notice('info', r.pulled ? 'Synced: changes from the other machine are in.' : 'Synced: everything here is on the remote.');
    post();
  }

  // ------------------------------------------------------------------------------------------
  // Live library
  //
  // Sharing starts a small server in this window (src/live/host.js). Joining keeps a copy of the
  // sharer's library (src/live/guest.js) and switches the panel to it. In a joined window, everything
  // that changes a prompt is sent to the sharer (guestDispatch below), and everything that only reads
  // it or takes it elsewhere -- copy, send, export, compare -- runs here, on the copy.
  // ------------------------------------------------------------------------------------------

  /** The account this window's engine is signed in to. A live library is shared by account. */
  function engineAccount() {
    const st = engine.state();
    const list = st.providers || [];
    const signedIn = (p) => Boolean(p && p.cli && p.cli.loggedIn && p.cli.account);
    const sel = st.selected ? list.find((p) => p.id === st.selected.provider) : null;
    if (signedIn(sel)) return sel.cli.account;
    const any = list.find(signedIn);
    return any ? any.cli.account : null;
  }

  /** Show another library: a joined one's copy (`dir`), or this window's own again (null). */
  async function switchLibrary(dir) {
    for (const x of sessions.values()) x.dispose();
    sessions.clear();
    for (const d of liveDocs.values()) clearTimeout(d.timer);
    liveDocs.clear();
    activeSlug = null;
    if (dir) {
      stopSync();
      try { store = storeMod.open(dir); bootError = null; } catch (e) { notice('error', `Could not open the copy of the live library: ${e.message}`); }
      post();
      return;
    }
    store = null;
    openStore();
    startSync();
    const last = globalState.get(LAST_OPEN);
    if (store && last && store.exists(last)) {
      try { await openSession(last); return; } catch (e) { log.warn(`could not reopen ${last}: ${e.message}`); }
    }
    post();
  }

  let liveSynced = false;

  function onLiveEvent(e) {
    if (disposed) return;
    switch (e.type) {
      case 'library':
        liveSynced = false;
        switchLibrary(e.dir).catch((err) => log.error(`live: ${err.stack || err.message}`));
        return;
      case 'files': {
        if (!live.isGuest() || !store) return;
        const touched = new Set([...(e.changed || []), ...(e.removed || [])].map(slugOfRel).filter(Boolean));
        for (const slug of touched) {
          const sess = sessions.get(slug);
          if (!sess) continue;
          if (store.read(slug)) { sess.reread(); continue; }
          sess.dispose();
          sessions.delete(slug);
          if (activeSlug === slug) { activeSlug = null; notice('info', 'That prompt was deleted in the live library.'); }
        }
        repaintSoon(30);
        return;
      }
      case 'synced':
        if (!liveSynced && store) {
          liveSynced = true;
          // Joining opens whatever the sharer has open, so it shows the work rather than a list.
          if (!activeSlug) {
            const hostView = (live.state().people.find((p) => p.role === 'host') || {}).slug;
            const pick = hostView && store.exists(hostView) ? hostView : (store.list()[0] || {}).slug;
            if (pick) { openSession(pick).catch((err) => log.warn(`live: ${err.message}`)); return; }
          }
        }
        post();
        return;
      case 'engine': {
        if (e.slug !== activeSlug) return;
        const p = getPanel();
        if (p) p.webview.postMessage({ type: 'progress', slug: e.slug, engine: e.engine });
        if (!e.engine || e.engine.state !== 'busy') repaintSoon(30);
        return;
      }
      case 'refused':
        notice('error', e.error);
        return;
      case 'notice':
        notice(e.level || 'info', e.text);
        return;
      default:
        repaintSoon(30);   // presence, status
    }
  }

  // A document open in an editor in a joined window. What is typed there goes to the sharer; what the
  // sharer's copy becomes goes into the editor; and neither is written over the other while it is
  // still on its way. `base` is the sharer's text the editor last had, which an edit is made against.
  const liveDocs = new Map();   // slug -> { base, pending, dirty, again, deferred, timer }
  function liveDoc(slug) {
    if (!liveDocs.has(slug)) liveDocs.set(slug, { base: null, pending: false, dirty: false, again: false, deferred: false, timer: null });
    return liveDocs.get(slug);
  }

  /** The copy's writer, for a document: through the editor when it is open, so the editor sees it. */
  async function mirrorWrite(abs, text, rel) {
    if (!live.isGuest() || !store) return false;
    const slug = rel.slice(0, -'.md'.length);
    const d = liveDoc(slug);
    if (!docio.isOpen(abs)) { d.base = docm.stripConflictBlock(text); return false; }
    if (d.pending || d.dirty) { d.deferred = true; return true; }
    d.base = docm.stripConflictBlock(text);
    await docio.writeDoc(abs, text);
    return true;
  }

  function mirrorSlugOf(fsPath) {
    if (!live.isGuest() || !store) return null;
    const name = path.basename(fsPath);
    if (!/\.md$/i.test(name) || !docio.same(path.dirname(fsPath), store.dir)) return null;
    const slug = name.slice(0, -3);
    return sessions.has(slug) ? slug : null;
  }

  function guestDocChanged(slug) {
    const d = liveDoc(slug);
    d.dirty = true;
    clearTimeout(d.timer);
    d.timer = setTimeout(() => { sendGuestDoc(slug).catch((e) => log.warn(`live: ${e.message}`)); }, 300);
  }

  async function sendGuestDoc(slug) {
    const d = liveDoc(slug);
    if (d.pending) { d.again = true; return; }
    if (!live.isGuest() || !store) return;
    const abs = store.docPath(slug);
    const raw = await docio.readDoc(abs);
    const text = docm.stripConflictBlock(raw == null ? '' : raw);
    d.dirty = false;
    if (d.base == null) d.base = text;
    let sent = false;
    if (text !== d.base) {
      d.pending = true;
      try {
        const r = await live.command('docEdit', { slug, base: d.base, text });
        d.base = r && typeof r.doc === 'string' ? r.doc : text;
        sent = true;
        if (r && r.clean === false) notice('warn', `${live.hostName()} changed the same section at the same moment. Your wording is in; theirs is kept in the versions list.`);
      } catch (e) {
        notice('error', `That edit did not reach ${live.hostName()}: ${e.message}. It is still in your editor; type again to resend it.`);
      } finally {
        d.pending = false;
      }
    }
    // What arrived while the edit was on its way, and what joining it produced, go into the editor now.
    if ((sent || d.deferred) && !d.dirty) {
      d.deferred = false;
      try {
        const cur = await live.command('docRead', { slug });
        if (!d.dirty && !d.pending && cur && typeof cur.text === 'string') {
          d.base = docm.stripConflictBlock(cur.text);
          await docio.writeDoc(abs, cur.text);
        }
      } catch { /* the next change brings it */ }
    }
    if (d.again) { d.again = false; guestDocChanged(slug); }
  }

  /** Ask the sharing window. undefined, with the reason shown, when it said no or could not be reached. */
  async function liveAsk(cmd, args = {}, bytes = null, { quiet = false } = {}) {
    try {
      return await live.command(cmd, args, bytes);
    } catch (e) {
      if (!quiet) notice('error', `${live.hostName()}’s window did not take that: ${e.message}`);
      return undefined;
    }
  }

  async function sendAttachment(s, { name, bytes, image = false, ext = '' }) {
    if (!bytes || !bytes.length) { notice('error', 'That file is empty.'); return; }
    if (bytes.length > LIMITS.upload) {
      notice('error', `${name || 'That file'} is ${Math.round(bytes.length / 1048576)} MB; attachments are capped at ${Math.round(LIMITS.upload / 1048576)} MB.`);
      return;
    }
    const rec = await liveAsk('attach', { slug: s.slug, name, image, ext }, bytes);
    if (rec) attached({ ...rec, path: store.attachmentPath(s.slug, rec) });
  }

  /** Open a prompt the sharer just made, once its copy has arrived. */
  async function openWhenMirrored(slug) {
    for (let i = 0; i < 100 && !disposed; i += 1) {
      if (store && store.exists(slug) && store.read(slug)) return openSession(slug);
      await sleep(50);
    }
    notice('warn', 'The new prompt has not arrived from the sharing window yet. It appears in the list when it does.');
    return null;
  }

  const personLabel = (p) => `${p.name}${p.machine ? ` (${p.machine})` : ''}`;
  const promptTitle = (slug) => { const r = slug && store ? store.read(slug) : null; return r ? r.title : 'a prompt'; };

  async function copyInvite({ quiet = false } = {}) {
    const text = live.inviteText((vscode.env && vscode.env.uriScheme) || 'vscode');
    if (!text) return false;
    await vscode.env.clipboard.writeText(text);
    if (!quiet) notice('info', 'The invite is on your clipboard. Whoever opens it has to be signed in to the same Claude account.');
    return true;
  }

  async function liveMenu() {
    const st = live.state();
    const others = st.people.filter((p) => !p.me);
    const who = others.map((p) => ({
      value: 'noop', label: personLabel(p), icon: 'person',
      description: p.role === 'host' ? `sharing this library${p.slug ? ` · in ${promptTitle(p.slug)}` : ''}` : p.slug ? `in ${promptTitle(p.slug)}` : 'looking at the list',
    }));
    let title;
    let detail;
    let items;
    if (st.role === 'off') {
      const acct = engineAccount();
      title = 'Work on prompts live with someone';
      detail = acct ? `This window is signed in to Claude as ${acct}. Only windows signed in to that same account can join.` : 'Sign in to Claude first: the account decides who may join.';
      items = [
        { value: 'share', label: 'Share this library live', description: 'Whoever you invite sees every prompt here, and each idea and edit as it happens, and can add their own. Merges run in this window.', icon: 'live' },
        { value: 'join', label: 'Join a live library…', description: 'Paste the invite someone sent you.', icon: 'link' },
      ];
    } else if (st.role === 'host') {
      title = others.length ? `Sharing live with ${others.length} ${others.length === 1 ? 'person' : 'people'}` : 'Sharing live. Nobody has joined yet.';
      detail = `For ${st.host.account}. Reachable at ${st.invite.addrs.join(', ')}, port ${st.invite.port}: the same network, or a tailnet.`;
      items = [
        { value: 'copy', label: 'Copy the invite', description: 'A link that joins in one click, and the account to sign in to', icon: 'link' },
        ...who,
        { value: 'stop', label: 'Stop sharing', description: 'Everyone connected is disconnected, and the invite stops working.', icon: 'disconnect' },
      ];
    } else {
      title = st.status === 'live' ? `Live in ${st.host.name}’s library` : st.status === 'error' ? `Not connected to ${st.host.name}` : `Connecting to ${st.host.name}…`;
      detail = st.error || `Merges run in ${st.host.name}’s window, on the engine signed in there.`;
      items = [
        ...who,
        { value: 'leave', label: `Leave ${st.host.name}’s library`, description: 'Back to your own prompts. The copy of theirs is removed from this computer.', icon: 'disconnect' },
      ];
    }
    const choice = await uiPick({ title, detail, items, anchor: 'live' });
    switch (choice) {
      case 'share': {
        if (!engineAccount()) await engine.detectAll();
        if (!store) return;
        const r = await live.startSharing({ dir: store.dir });
        if (!r.ok) { notice('error', r.error); post(); return; }
        if (activeSlug) live.view(activeSlug);
        await copyInvite({ quiet: true });
        const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'The firewall';
        notice('info', `Sharing live, and the invite is on your clipboard. If ${os} asks whether VS Code may accept connections, allow it on private networks.`);
        post();
        return;
      }
      case 'join':
        await liveJoin(null);
        return;
      case 'copy':
        await copyInvite();
        return;
      case 'stop':
        await live.stopSharing();
        notice('info', 'Stopped sharing. The invite no longer works.');
        post();
        return;
      case 'leave':
        await live.leave();
        notice('info', 'Back in your own library.');
        return;
      default:
    }
  }

  async function liveJoin(code) {
    const text = code ? String(code) : await uiAsk({
      title: 'Join a live library',
      detail: 'Paste the invite: the link, or the whole message it came in. This window has to be signed in to the same Claude account as the person sharing.',
      placeholder: 'vscode://…/join?code=pflive1…', okLabel: 'Join',
    });
    if (!text) return;
    if (live.isHost()) {
      const ok = await uiConfirm({ title: 'Stop sharing your library to join this one?', text: 'Anyone connected to your library is disconnected.', okLabel: 'Stop and join' });
      if (!ok) return;
      await live.stopSharing();
    }
    if (!live.isGuest() && [...sessions.values()].some((x) => x.busy())) { notice('info', 'Wait for the engine to finish in this library before joining another.'); return; }
    if (live.isGuest()) await live.leave();
    if (!engineAccount()) await engine.detectAll();
    const r = await live.join(text);
    if (!r.ok) { notice('error', r.error); post(); return; }
    notice('info', `Joining ${r.host}’s library…`);
  }

  /** In a joined library: send what changes a prompt to the sharer. true when the message was handled. */
  async function guestDispatch(m, s) {
    const slug = s ? s.slug : null;
    const there = live.hostName();
    const needPrompt = () => { if (!s) notice('info', 'Open a prompt first.'); return Boolean(s); };
    switch (m.type) {
      case 'idea':
        if (needPrompt()) await liveAsk('idea', { slug, text: String(m.text || ''), attachments: Array.isArray(m.attachments) ? m.attachments : [] });
        return true;
      case 'addIdea':
        if (m.text != null && String(m.text).trim()) {
          const target = await sessionForCommand();
          if (target) await liveAsk('idea', { slug: target.slug, text: String(m.text) });
        } else {
          panelOnce({ type: 'focus', target: 'idea' });
        }
        return true;
      case 'editIdea':
        if (needPrompt() && (await liveAsk('editIdea', { slug, entryId: m.entryId, text: m.text })) === false) notice('info', 'Nothing changed.');
        return true;
      case 'retry':
        if (s) await liveAsk('retry', { slug, entryId: m.entryId || null });
        return true;
      case 'resolve':
        if (s && m.conflictId && (m.keep === 'new' || m.keep === 'old')) await liveAsk('resolve', { slug, conflictId: m.conflictId, keep: m.keep });
        return true;
      case 'polish':
        if (s) await liveAsk('polish', { slug, full: Boolean(m.full) });
        return true;
      case 'setTarget':
        if (s && m.target) await liveAsk('setTarget', { slug, target: String(m.target) });
        return true;
      case 'rename':
        if (s) await liveAsk('rename', { slug, title: String(m.title || '') });
        return true;
      case 'restore': {
        if (!s) return true;
        const r = await liveAsk('restore', { slug, snapshotId: m.snapshotId });
        if (r && !r.ok) notice('info', r.reason === 'busy' ? `Wait for the engine in ${there}’s window to finish before restoring.` : 'That version is gone.');
        return true;
      }
      case 'suggestion.dismiss':
        if (s && m.text) await liveAsk('dismissSuggestion', { slug, text: String(m.text) });
        return true;
      case 'suggestion.apply': {
        if (!needPrompt() || !m.text) return true;
        const sg = (s.snapshot().suggestions || []).find((x) => x.text === String(m.text));
        const picks = sg ? suggestMod.picksFrom(sg.options, m.picks) : [];
        if (!picks.length) return true;
        await liveAsk('idea', { slug, text: suggestMod.clarificationIdea({ section: sg.section, text: sg.text, picks }) });
        await liveAsk('dismissSuggestion', { slug, text: sg.text });
        return true;
      }
      case 'idea.dismiss':
        if (s && m.text) await liveAsk('dismissIdea', { slug, text: String(m.text) });
        return true;
      case 'vars.set':
        if (s && m.values && typeof m.values === 'object') {
          // Shown here at once; the sharer's copy follows a moment later and says the same.
          store.setVars(slug, m.values);
          s.reread();
          await liveAsk('setVars', { slug, values: m.values });
        }
        return true;
      case 'typing':
        if (s) liveAsk('typing', { slug }, null, { quiet: true });
        return true;
      case 'newPrompt': {
        const r = await liveAsk('create', { title: String(m.title || 'Untitled') });
        if (r && r.slug && (await openWhenMirrored(r.slug))) {
          const p = getPanel();
          if (p) p.webview.postMessage({ type: 'focus', target: 'idea' });
        }
        return true;
      }
      case 'newFromTemplate': {
        const choice = m.id ? String(m.id) : await uiPick({ title: 'Start from which shape?', detail: 'Each one is real text with the unknowns in [brackets].', items: templates.TEMPLATES.map((t) => ({ value: t.id, label: t.label, description: t.blurb, icon: 'template' })) });
        const t = choice ? templates.byId(choice) : null;
        if (!t) return true;
        const r = await liveAsk('create', { title: t.label, body: templates.seedFrom(t.id, t.label) });
        if (r && r.slug) await openWhenMirrored(r.slug);
        return true;
      }
      case 'deletePrompt': {
        const item = store.list().find((x) => x.slug === m.slug);
        if (!item) return true;
        const ok = await uiConfirm({ title: `Delete "${item.title}" for everyone?`, text: `This is ${there}’s library: the prompt moves to the trash there, and disappears for everyone working in it.`, okLabel: 'Delete', danger: true });
        if (ok) await liveAsk('delete', { slug: m.slug });
        return true;
      }
      case 'image.paste':
        if (needPrompt() && m.data) await sendAttachment(s, { name: String(m.name || ''), bytes: Buffer.from(String(m.data), 'base64'), image: true, ext: String(m.ext || 'png') });
        return true;
      case 'file.drop':
        if (needPrompt() && m.data) await sendAttachment(s, { name: String(m.name || 'attachment'), bytes: Buffer.from(String(m.data), 'base64') });
        return true;
      case 'attach.pick': {
        if (!needPrompt()) return true;
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: 'Attach to this idea' });
        for (const uri of picked || []) {
          let bytes;
          try { bytes = fs.readFileSync(uri.fsPath); } catch (e) { notice('error', `${path.basename(uri.fsPath)} could not be read: ${e.message}`); continue; }
          await sendAttachment(s, { name: path.basename(uri.fsPath), bytes });
        }
        return true;
      }
      case 'project.connect':
      case 'project.pick':
      case 'project.remote':
      case 'project.menu':
      case 'project.refresh':
      case 'project.detach':
        notice('info', `Projects are connected from ${there}’s window: the folder is read, and its brief built, on that computer.`);
        return true;
      case 'run':
        notice('info', `Test runs start from ${there}’s window, where this library’s engine is.`);
        return true;
      case 'sync.now':
      case 'sync.setup':
        notice('info', 'Library sync is for your own library, and waits while you are in a live one.');
        return true;
      default:
        return false;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Messages from the webview (and from the cold shell's commands)
  // ------------------------------------------------------------------------------------------

  async function handleMessage(m) {
    if (!m || typeof m !== 'object' || !m.type) return;
    // An answer to an in-panel dialog. Handled before anything else: the flow that asked is waiting.
    if (m.type === 'ui.reply') {
      const waiting = uiPending.get(String(m.id));
      if (waiting) { uiPending.delete(String(m.id)); waiting.resolve(m.value === undefined ? null : m.value); }
      return;
    }
    if (m.type === 'once.done') { onceQueue.delete(String(m.once)); return; }
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

  /** A file the person attached, handed back to the panel as a chip on the idea being typed. */
  function attached(saved) {
    const p = getPanel();
    if (!saved) { notice('error', 'That file could not be read.'); return; }
    if (saved.error) { notice('error', saved.error); return; }
    if (p) p.webview.postMessage({ type: 'attached', attachment: saved });
    if (saved.secret) notice('warn', `${saved.name} looks like a key or credentials file. Its name is referenced; its contents are never sent.`);
  }

  async function dispatch(m) {
    const s = active();
    if (m.type === 'live.menu') { await liveMenu(); return; }
    if (m.type === 'live.join') { await liveJoin(m.code); return; }
    if (live.isGuest() && await guestDispatch(m, s)) return;
    switch (m.type) {
      case 'ready': {
        post();
        if (pendingSendMenu && s) postSendMenu(s, { open: true });
        // Anything asked of a panel that was still loading is shown now.
        const p = getPanel();
        if (p) {
          for (const msg of onceQueue.values()) p.webview.postMessage(msg);
          for (const { msg } of uiPending.values()) p.webview.postMessage(msg);
        }
        return;
      }
      case 'panelOpened':
        post();
        return;
      case 'openPrompt':
        if (m.slug && store.exists(m.slug)) await openSession(m.slug);
        return;
      case 'newFromTemplate': {
        // Deliberately NOT on the + button: creating a prompt stayed one click, and a picker in
        // front of it would tax every new prompt to serve the first one.
        const choice = m.id
          ? String(m.id)
          : await uiPick({ title: 'Start from which shape?', detail: 'Each one is real text with the unknowns in [brackets].', items: templates.TEMPLATES.map((t) => ({ value: t.id, label: t.label, description: t.blurb, icon: 'template' })) });
        if (!choice) return;
        const t = templates.byId(choice);
        if (!t) return;
        const { slug: ts } = store.create(t.label, { body: templates.seedFrom(t.id, t.label) });
        await openSession(ts);
        const tp = getPanel();
        if (tp) tp.webview.postMessage({ type: 'focus', target: 'idea' });
        notice('info', `Started from ${t.label}. Replace the [bracketed] parts — anything you leave is flagged when you copy.`);
        return;
      }
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
        const ok = await uiConfirm({ title: `Delete "${item.title}"?`, text: "It moves to the library's .trash folder, where it can be recovered.", okLabel: 'Delete', danger: true });
        if (!ok) return;
        await removePrompt(m.slug);
        return;
      }
      case 'image.paste': {
        // Saved to disk immediately and referred to by name from here on: a screenshot is hundreds
        // of KB and must never ride along in panel state or in the sidecar JSON.
        if (!s || !m.data) return;
        const saved = store.saveImage(s.slug, { data: String(m.data), ext: String(m.ext || 'png'), name: String(m.name || '') });
        if (!saved) { notice('error', 'That image could not be read.'); return; }
        attached(saved);
        return;
      }
      case 'file.drop':
        if (!s || !m.data) return;
        attached(store.saveFile(s.slug, { data: String(m.data), name: String(m.name || '') }));
        return;
      case 'attach.pick': {
        if (!s) { notice('info', 'Create or open a prompt first.'); return; }
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: 'Attach to this idea' });
        for (const uri of picked || []) attached(store.saveFile(s.slug, { from: uri.fsPath }));
        return;
      }
      case 'image.open':
      case 'attachment.open':
        if (m.path) await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(String(m.path)));
        return;
      case 'typing':
        // The person is writing an idea: start the engine process the merge will use, so its boot
        // is over before they press Enter.
        if (s && engineOptions().prewarm && engine.selection().ok) s.warm();
        return;
      case 'idea':
        if (!s) { notice('info', 'Create or open a prompt first.'); return; }
        if (!engine.selection().ok) { notice('error', engine.selection().reason); return; }
        // While the library is shared, every idea says who sent it; the people who joined see it.
        s.submitIdea(m.text, Array.isArray(m.attachments) ? m.attachments : Array.isArray(m.images) ? m.images : [], live.isHost() ? { by: live.me() } : {});
        return;
      case 'addIdea': {
        const target = await sessionForCommand();
        if (!target) return;
        if (m.text != null && String(m.text).trim()) {
          if (!engine.selection().ok) { notice('error', engine.selection().reason); return; }
          target.submitIdea(String(m.text), [], live.isHost() ? { by: live.me() } : {});
          return;
        }
        // Ideas are typed in the idea box: the panel comes forward with the cursor in it.
        panelOnce({ type: 'focus', target: 'idea' });
        if (!engine.selection().ok) notice('error', engine.selection().reason);
        return;
      }
      case 'addSelection': {
        const target = await sessionForCommand();
        if (!target) return;
        // Into the idea box, with the cursor above the code so a note can go first; Enter sends it.
        panelOnce({ type: 'draft', text: selectionIdea({ note: '', text: m.text, file: m.file, start: m.start, end: m.end, lang: m.lang }) });
        if (!engine.selection().ok) notice('error', engine.selection().reason);
        return;
      }
      case 'idea.dismiss':
        if (s && m.text) s.dismissIdea(String(m.text));
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
        const pick = await pickProjectDir();
        if (pick) await attachProject(s.slug, pick.dir, pick.host);
        return;
      }
      case 'project.remote': {
        const target = s || await sessionForCommand();
        if (!target) return;
        const pick = await pickRemoteProject();
        if (pick) await attachProject(target.slug, pick.dir, pick.host);
        return;
      }
      case 'project.menu': {
        if (!s) return;
        const list = store.read(s.slug).projects || [];
        if (!list.length) { const pick = await pickProjectDir(); if (pick) await attachProject(s.slug, pick.dir, pick.host); return; }
        const items = [];
        for (const p of list) {
          const what = p.error ? `error: ${p.error}` : `${p.files.length} file(s)${p.head ? `, ${p.head}` : ''}`;
          items.push({ value: `view:${p.id}`, label: `View the brief for ${p.label}`, description: what, icon: 'eye' });
          items.push({ value: `refresh:${p.id}`, label: `Rebuild ${p.label}'s brief`, description: p.host ? `${p.host}:${p.path}` : p.path, icon: 'refresh' });
          items.push({ value: `detach:${p.id}`, label: `Disconnect ${p.label}`, icon: 'disconnect' });
        }
        items.push({ value: 'add:', label: 'Connect another project…', description: 'For a prompt that genuinely spans repos, here or on another machine', icon: 'add' });
        const choice = await uiPick({ title: 'Project context for this prompt', items, anchor: 'connect' });
        if (!choice) return;
        const act = choice.slice(0, choice.indexOf(':'));
        const pid = choice.slice(choice.indexOf(':') + 1);
        if (act === 'add') { const got = await pickProjectDir(); if (got) await attachProject(s.slug, got.dir, got.host); return; }
        if (act === 'detach') { detachProject(s.slug, pid); return; }
        if (act === 'view' || act === 'refresh') await handleMessage({ type: `project.${act}`, id: pid });
        return;
      }
      case 'suggestion.dismiss':
        if (s && m.text) s.dismissSuggestion(String(m.text));
        return;
      case 'suggestion.apply': {
        // The ticks are matched against the options this suggestion offers now, never taken as sent.
        if (!s || !m.text) return;
        const sg = (s.snapshot().suggestions || []).find((x) => x.text === String(m.text));
        if (!sg) { notice('info', 'That suggestion has gone; the prompt changed since.'); post(); return; }
        const picks = suggestMod.picksFrom(sg.options, m.picks);
        if (!picks.length) return;
        if (!engine.selection().ok) { notice('error', engine.selection().reason); post(); return; }
        s.submitIdea(suggestMod.clarificationIdea({ section: sg.section, text: sg.text, picks }), [], live.isHost() ? { by: live.me() } : {});
        s.dismissSuggestion(sg.text);
        return;
      }
      case 'setSuggestions':
        await updateSetting('suggestions', m.value !== false);
        post();
        return;
      case 'setAutoForge':
        await updateSetting('autoForge', m.value === 'confirm' ? 'confirm' : 'off');
        await applyAutoForge('setting');
        post();
        return;
      case 'autoforge.undo': {
        const r = await autoForge.undoById(String(m.id || ''));
        if (!r.ok) notice('warn', `Nothing undone: ${r.reason}.`);
        return;
      }
      case 'uri': {
        // A link from an auto-forge card in a Claude Code chat. The panel comes forward so the click
        // visibly did something.
        const id = String((m.query && m.query.id) || '');
        if (!id) return;
        if (m.path === '/forge/undo') {
          panelNow();
          const r = await autoForge.undoById(id);
          if (!r.ok) notice('warn', `Nothing undone: ${r.reason}.`);
          return;
        }
        if (m.path === '/forge/open') {
          const f = autoForge.forgeById(id);
          const slug = f && f.result && f.result.ok ? f.result.slug : null;
          panelNow();
          if (!slug || !store || !store.exists(slug)) { notice('warn', 'That forged prompt is no longer known to this window.'); return; }
          await openSession(slug, { reveal: true });
        }
        return;
      }
      case 'project.detach':
        if (s && m.id) detachProject(s.slug, String(m.id));
        return;
      case 'project.refresh': {
        if (!s || !m.id) return;
        const p = (store.read(s.slug).projects || []).find((x) => x.id === String(m.id));
        if (p) await attachProject(s.slug, p.path, p.host || null, { force: true });
        return;
      }
      case 'project.view': {
        if (!s || !m.id) return;
        const p = (store.read(s.slug).projects || []).find((x) => x.id === String(m.id));
        if (!p) return;
        // Opened untitled rather than written to the library: the brief is a cache, not a document,
        // and a file on disk would be a second copy to keep in step with the sidecar.
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: p.error ? `# ${p.label}\n\nNo brief. ${p.error}\n` : `${p.brief}\n\n---\nRead ${p.files.length} file(s)${p.host ? ` on ${p.host}` : ''}:\n${p.files.map((f) => `- ${f}`).join('\n')}\n` });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'rename':
        if (s) await s.rename(m.title);
        return;
      case 'polish':
        if (!s) return;
        if (!engine.selection().ok) { notice('error', engine.selection().reason); return; }
        s.polish({ full: Boolean(m.full) });
        return;
      case 'run': {
        if (!s) { notice('info', 'Create or open a prompt first.'); return; }
        if (!engine.selection().ok) { notice('error', engine.selection().reason); return; }
        post();
        const r = await s.run();
        if (r && r.error && r.error !== 'disposed') notice('error', `The run failed: ${r.error}`);
        post();
        return;
      }
      case 'version.compare': {
        // Snapshot bodies never ride along in the panel state -- a long prompt times fifty versions
        // would be posted on every repaint -- so the comparison is done here and the result sent.
        if (!s || !m.id) return;
        const sc = store.read(s.slug);
        const snap = (sc.snapshots || []).find((v) => v.id === String(m.id));
        if (!snap) return;
        const raw = await docio.readDoc(s.docPath);
        const now = docm.stripConflictBlock(raw == null ? '' : raw);
        const p3 = getPanel();
        if (p3) p3.webview.postMessage({ type: 'compare', id: snap.id, diff: diffSections(snap.doc, now) });
        return;
      }
      case 'openRun': {
        if (!s) return;
        const runs = store.read(s.slug).runs || [];
        const r = runs.find((x) => x.id === String(m.id)) || runs[runs.length - 1];
        if (!r) return;
        const head = `<!-- ${targets.labelOf(r.target)} prompt, answered by ${r.provider || '?'}/${r.model || '?'} -->\n\n`;
        const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: head + r.text });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'export': {
        if (!s) { notice('info', 'Create or open a prompt first.'); return; }
        const sc = store.read(s.slug);
        const act = m.act ? String(m.act) : await uiPick({
          title: 'Export this prompt as…',
          items: [
            { value: 'md', label: 'Markdown file', description: 'The finished prompt, as you would paste it', icon: 'doc' },
            { value: 'cmd', label: 'Claude Code slash command', description: `.claude/commands/${s.slug}.md in this workspace, then /${s.slug}`, icon: 'terminal' },
            { value: 'json', label: 'Whole prompt as JSON', description: 'Document, every idea, versions and conflicts: the portable form', icon: 'json' },
          ],
        });
        if (!act) return;
        if (!(await fillMissingVars(s))) return;
        const text = await s.copyText();
        const pick = { act };
        if (pick.act === 'cmd') {
          const ws = workspaceDir();
          if (!ws) { notice('error', 'No folder is open, so there is nowhere to put a slash command.'); return; }
          const dest = path.join(ws, '.claude', 'commands', `${s.slug}.md`);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, await s.sendText());
          notice('info', `Written to .claude/commands/${s.slug}.md. Use it with /${s.slug}.`);
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(dest), { preview: true });
          return;
        }
        // The sidecar minus the snapshot bodies: the history of what was decided travels, the fifty
        // copies of the document do not.
        const body = pick.act === 'json'
          ? JSON.stringify({
            version: 1, title: sc.title, target: sc.target, doc: text,
            entries: (sc.entries || []).map(({ id, ts, text: t, status, attachments }) => ({ id, ts, text: t, status, attachments: (attachments || []).map((a) => a.name) })),
            conflicts: sc.conflicts || [], projects: (sc.projects || []).map(({ label, path: p, host: h }) => ({ label, path: p, ...(h ? { host: h } : {}) })),
            versions: (sc.snapshots || []).map(({ id, ts, kind, changes }) => ({ id, ts, kind, changes })),
          }, null, 2)
          : text;
        const doc = await vscode.workspace.openTextDocument({ language: pick.act === 'json' ? 'json' : 'markdown', content: body });
        await vscode.window.showTextDocument(doc, { preview: false });
        notice('info', 'Save it wherever you like — nothing was written to disk.');
        return;
      }
      case 'copyNew': {
        if (!s) return;
        const add = await s.copyNewText();
        if (!add) { notice('info', 'Nothing has been merged since your last copy.'); post(); return; }
        await vscode.env.clipboard.writeText(add.text);
        const p2 = getPanel();
        if (p2) p2.webview.postMessage({ type: 'copiedNew', chars: add.text.length });
        if (add.restyled) notice('info', 'The prompt was restyled since your last copy, so this add-on covers most of it. Copying the whole prompt may read better.');
        log.info(`copied add-on: ${add.added} added, ${add.removed} removed, ${add.text.length} characters`);
        post();
        return;
      }
      case 'copy': {
        if (!s) return;
        if (!(await fillMissingVars(s))) return;
        const text = await s.copyText();
        await vscode.env.clipboard.writeText(text);
        // The button turns into a tick for a moment. A bar the eye has to travel to, to read a
        // number it can already see at the foot of the prompt, is worse than no bar.
        const p = getPanel();
        if (p) p.webview.postMessage({ type: 'copied', chars: text.length });
        post();   // copying moves the mark, so the add-on button's state changes with it
        // Reported after the copy, never instead of it. The text is already on the clipboard; this
        // is the last cheap moment to notice a section nobody filled in.
        const snap = s.snapshot();
        const found = lintPrompt(text, { conflicts: snap.conflicts });
        if (found.length) notice(found.some((f) => f.level === 'warn') ? 'warn' : 'info', `Copied. ${found.map((f) => f.text).join(' ')}`);
        log.info(`copied ${text.length} characters for ${targets.labelOf(snap.target)}`);
        offerFiles(snap.files);
        return;
      }
      case 'copyFiles':
        if (s) await copyFilesNow(s.snapshot().files);
        return;
      case 'roots.edit': {
        const roots = projectCfg().roots;
        const choice = await uiPick({
          title: 'Folders projects are listed from',
          detail: 'Names and paths only: nothing in these folders is read until you attach one of their projects.',
          items: [
            ...roots.map((r) => ({ value: `remove:${r}`, label: r, description: 'Stop listing projects from here', icon: 'trash' })),
            { value: 'add:', label: 'Add a folder…', icon: 'add' },
          ],
        });
        if (!choice) return;
        if (choice === 'add:') {
          const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'List projects from this folder' });
          if (!sel || !sel.length) return;
          await updateSetting('projectRoots', [...new Set([...roots, sel[0].fsPath])]);
        } else {
          await updateSetting('projectRoots', roots.filter((r) => r !== choice.slice('remove:'.length)));
        }
        post();
        return;
      }
      case 'budget.set': {
        const current = projectCfg().tokenBudget;
        const v = await uiAsk({
          title: 'Token budget for one prompt',
          detail: 'The footer turns amber once a prompt has used this many tokens in total. Empty or 0 turns it off. Tokens rather than money: a CLI login draws on a plan.',
          value: current ? String(current) : '', placeholder: 'e.g. 200000', pattern: '^\\d{1,9}$', patternMessage: 'A whole number of tokens', allowEmpty: true, okLabel: 'Save',
        });
        if (v === null) return;
        await updateSetting('tokenBudget', v ? Number(v) : 0);
        post();
        return;
      }
      case 'send.options':
        if (s) postSendMenu(s, { open: Boolean(m.open) });
        return;
      case 'sendMenu.shown':
        pendingSendMenu = false;
        return;
      case 'send':
      case 'sendToClaude': {
        const target = s || await sessionForCommand();
        if (!target) return;
        if (m.dest && typeof m.dest === 'object') { await sendTo(target, m.dest); return; }
        // From the command palette: the panel's own menu opens, as it does from the button.
        pendingSendMenu = true;
        postSendMenu(target, { open: true });
        return;
      }
      case 'sendUpdate':
        if (s) await sendUpdate(s);
        return;
      case 'vars.set':
        if (s && m.values && typeof m.values === 'object') s.setVars(m.values);
        return;
      case 'restore': {
        if (!s) return;
        const r = await s.restore(m.snapshotId);
        if (!r.ok) notice('info', r.reason === 'busy' ? 'Wait for the engine to finish before restoring.' : 'That version is gone.');
        return;
      }
      case 'resolve':
        if (s && m.conflictId && (m.keep === 'new' || m.keep === 'old')) s.resolve(m.conflictId, m.keep, live.isHost() ? { by: live.me() } : {});
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
        if (['off', 'brief', 'brief+lookup'].includes(m.value)) { await updateSetting('projectContext', m.value); post(); }
        return;
      case 'setEngineOption': {
        const allowed = {
          'engine.mergeEffort': ['auto', 'low', 'medium', 'high'],
          'engine.polishEffort': ['auto', 'low', 'medium', 'high', 'xhigh', 'max'],
          'engine.mergeOutput': ['edits', 'document'],
          'engine.prewarm': [true, false],
        };
        if (!allowed[m.key] || !allowed[m.key].includes(m.value)) return;
        await updateSetting(m.key, m.value);
        post();
        return;
      }
      case 'sync.setup': {
        const current = syncCfg().remote;
        const url = await uiAsk({
          title: 'A git remote for the prompt library',
          detail: 'A private repository you own. git must be installed, with credentials that work without a prompt. Leave it empty to turn sync off.',
          placeholder: 'git@github.com:you/prompts.git', value: current, allowEmpty: true, okLabel: 'Save',
        });
        if (url === null) return;
        await updateSetting('sync.remote', url.trim());
        startSync();
        post();
        return;
      }
      case 'sync.now':
        if (!sync) { await handleMessage({ type: 'sync.setup' }); return; }
        await runSync('manual');
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
        const fsPath = e.document && e.document.uri ? e.document.uri.fsPath : null;
        if (!fsPath) return;
        if (s && docio.same(fsPath, s.docPath)) repaintSoon();
        // Typed into a document of a joined library: on its way to the sharer.
        const joinedSlug = mirrorSlugOf(fsPath);
        if (joinedSlug && e.contentChanges && e.contentChanges.length) guestDocChanged(joinedSlug);
      }));
      // The kit watches sourcePath/autoReload; the settings that change behaviour are watched here.
      disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('promptForge.libraryPath') && !live.isGuest()) {
          if (live.isHost()) {
            live.stopSharing();
            notice('info', 'Stopped sharing live: the library folder changed. Share again to invite people to the new one.');
          }
          openStore(); startSync(); post();
        }
        if (e.affectsConfiguration('promptForge.layout') || e.affectsConfiguration('promptForge.layoutStackWidth') || e.affectsConfiguration('promptForge.layoutSplit') || e.affectsConfiguration('promptForge.railCollapsed')) post();
        if (['promptForge.engine', 'promptForge.cli', 'promptForge.compatible'].some((k) => e.affectsConfiguration(k))) {
          engine.detectAll().then(() => { if (!disposed) post(); });
        }
        if (e.affectsConfiguration('promptForge.sync') && !live.isGuest()) { startSync(); post(); }
        if (['promptForge.autoForge', 'promptForge.autoForgeMinChars', 'promptForge.autoForgeMinPrompts'].some((k) => e.affectsConfiguration(k))) {
          applyAutoForge('setting').then(() => { if (!disposed) post(); });
        }
      }));
      // Coming back to the window is when the other machine's changes are most likely waiting.
      if (vscode.window.onDidChangeWindowState) {
        disposables.push(vscode.window.onDidChangeWindowState((w) => { if (w && w.focused) syncSoon('focus'); }));
      }
      if (!store) { post(); return; }
      engine.detectAll().then((sel) => {
        if (disposed) return;
        log.info(sel.ok ? `engine: ${sel.provider}/${sel.mode} merge=${sel.mergeModel} polish=${sel.polishModel}` : `engine: ${sel.reason}`);
        post();
        // Sharing again, or back in the library this window had joined, as it was before the reload.
        // After detection, because both depend on knowing which account this window is signed in to.
        if (store) {
          live.resume({ dir: store.dir })
            .then(() => { if (live.isHost() && activeSlug) live.view(activeSlug); post(); })
            .catch((e) => log.warn(`live: ${e.stack || e.message}`));
        }
      });
      startSync();
      applyAutoForge('start');
      const last = globalState.get(LAST_OPEN);
      if (last && store.exists(last)) {
        openSession(last, { reveal: false }).catch((e) => log.error(`could not reopen ${last}: ${e.message}`));
      } else {
        post();
      }
    },
    dispose() {
      disposed = true;
      // A flow waiting on a dialog ends as if it was cancelled, rather than hanging on a dead runtime.
      for (const { resolve } of uiPending.values()) resolve(null);
      uiPending.clear();
      clearTimeout(repaintTimer);
      live.dispose();
      for (const d of liveDocs.values()) clearTimeout(d.timer);
      stopSync();
      autoForge.dispose();
      if (afAgent) { afAgent.dispose(); afAgent = null; }
      docEditors.dispose();
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
      engine.dispose();
      for (const d of disposables) { try { d.dispose(); } catch { /* already gone */ } }
    },
  };
}

module.exports = { create };
