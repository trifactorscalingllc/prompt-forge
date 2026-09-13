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
const { runCli, openCli, resolveBin } = require('./providers/spawn');
const targets = require('./targets');
const docm = require('./doc');
const { modelBlurb, ROLE_BLURBS } = require('./blurbs');
const project = require('./project');
const remote = require('./remote');
const sendMod = require('./send');
const clipfiles = require('./clipfiles');
const { selectionIdea } = require('./selection');
const { createSync } = require('./sync');
const { lintPrompt } = require('./lint');
const { diffSections } = require('./addendum');
const templates = require('./templates');

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
    return {
      library: store.dir,
      prompts: store.list(),
      active: session ? session.snapshot() : null,
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
  function repaintSoon() {
    clearTimeout(repaintTimer);
    repaintTimer = setTimeout(() => { if (!disposed) post(); }, 300);
  }

  function notice(level, text) {
    const p = getPanel();
    if (p) p.webview.postMessage({ type: 'notice', level, text });
    if (level === 'error') log.error(text); else if (level === 'warn') log.warn(text); else log.info(text);
  }

  // ------------------------------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------------------------------

  async function openSession(slug, { reveal = false } = {}) {
    let s = sessions.get(slug);
    if (!s) {
      s = createSession({
        slug, store, docio, engine, cfg: effectiveConfig, log,
        publish: (why) => {
          if (why === 'progress') { postProgress(slug); return; }
          if (why.startsWith('notice:')) notice('info', why.slice('notice:'.length));
          if (why === 'landed') syncSoon('change');
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

  /** The prompt an out-of-panel command acts on: the open one, else the last one, else a new one. */
  async function sessionForCommand() {
    if (!store) return null;
    if (active()) return active();
    const last = globalState.get(LAST_OPEN);
    if (last && store.exists(last)) return openSession(last);
    const { slug } = store.create('Untitled');
    return openSession(slug);
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
    if (ws) items.push({ label: `$(root-folder) ${path.basename(ws)}`, description: ws, detail: 'The folder this window has open', dir: ws });
    for (const p of project.discover(cfg.roots, { fs, home: os.homedir() })) {
      if (ws && p.path === ws) continue;
      items.push({ label: `$(folder) ${p.label}`, description: p.path, dir: p.path });
    }
    items.push({ label: '$(folder-opened) Browse…', detail: 'Pick any folder', dir: '\u0000browse' });
    items.push({ label: '$(remote) A project on another machine, over SSH…', detail: 'A Mac mini, a server: anything in ~/.ssh/config. Nothing leaves this window.', dir: '\u0000ssh' });
    if (!cfg.roots.length) items.push({ label: '$(gear) Add folders to list projects from…', detail: 'Sets promptForge.projectRoots, so you never hunt for a path again', dir: '\u0000roots' });
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: 'Which project is this prompt for? Only the folder you choose is read.',
      matchOnDescription: true,
    });
    if (!pick) return null;
    if (pick.dir === '\u0000roots') {
      await vscode.commands.executeCommand('workbench.action.openSettings', 'promptForge.projectRoots');
      return null;
    }
    if (pick.dir === '\u0000ssh') return pickRemoteProject();
    if (pick.dir === '\u0000browse') {
      const sel = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Attach this project' });
      return sel && sel.length ? { dir: sel[0].fsPath, host: null } : null;
    }
    return { dir: pick.dir, host: null };
  }

  /** A host from ~/.ssh/config (or typed), then a folder on it. { dir, host } or null. */
  async function pickRemoteProject() {
    const ssh = resolveBin('ssh', {});
    if (!ssh) { notice('error', 'ssh is not on your PATH. Install OpenSSH to attach a project on another machine.'); return null; }
    const extraConfig = String(vscode.workspace.getConfiguration('remote.SSH').get('configFile', '') || '');
    const hosts = remote.sshHosts({ extra: extraConfig ? [storeMod.expandHome(extraConfig)] : [] });
    const items = hosts.map((h) => ({ label: `$(remote) ${h.host}`, description: [h.user, h.hostName].filter(Boolean).join('@') || undefined, host: h.host }));
    items.push({ label: '$(edit) Type a host…', detail: 'A name from ~/.ssh/config, or user@address', host: '\u0000type' });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Which machine is the project on? SSH keys or an agent are used; a password prompt cannot be answered from here.' });
    if (!pick) return null;
    let sshHost = pick.host;
    if (sshHost === '\u0000type') {
      sshHost = String(await vscode.window.showInputBox({
        prompt: 'SSH host', placeHolder: 'mac-mini or me@192.168.1.20', ignoreFocusOut: true,
        validateInput: (v) => (remote.validHost(String(v).trim()) ? null : 'Letters, digits, dots, dashes, underscores and @ only'),
      }) || '').trim();
      if (!sshHost) return null;
    }
    const found = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Looking for projects on ${sshHost}…`, cancellable: false },
      () => remote.discoverRemote({ runCli, ssh, host: sshHost }),
    );
    if (found.error) notice('warn', `Could not list projects on ${sshHost}: ${found.error}. You can still type a path.`);
    const dirs = found.dirs.map((d) => ({ label: `$(folder) ${d}`, dir: d }));
    dirs.push({ label: '$(edit) Type a path…', dir: '\u0000type' });
    const dp = await vscode.window.showQuickPick(dirs, { placeHolder: `Which folder on ${sshHost}? Only the folder you choose is read.` });
    if (!dp) return null;
    let dir = dp.dir;
    if (dir === '\u0000type') {
      dir = String(await vscode.window.showInputBox({ prompt: `Folder on ${sshHost}`, placeHolder: '~/projects/my-app', ignoreFocusOut: true }) || '').trim();
      if (!dir) return null;
    }
    return { dir, host: sshHost };
  }

  /** One call, on attach, with the polish model. Its output is reused on every merge after. */
  async function buildBrief(dir, label, sshHost) {
    const cfg = projectCfg();
    let collected;
    if (sshHost) {
      const ssh = resolveBin('ssh', {});
      if (!ssh) return { error: 'ssh is not on your PATH' };
      collected = await remote.collectRemote({ runCli, ssh, host: sshHost, dir, maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes });
      if (collected.error) return { error: collected.error };
    } else {
      try { collected = project.collect(dir, { fs, maxFiles: cfg.maxFiles, maxBytes: cfg.maxBytes }); } catch (e) { return { error: e.message }; }
    }
    const where = sshHost ? `${sshHost}:${dir}` : dir;
    if (!collected.files.length) return { error: `Nothing readable in ${where}. A project needs a README or a manifest to describe itself.` };
    const res = await engine.call({
      role: 'polish',
      prompt: project.buildBriefPrompt({ label, dir: where, collected }),
      timeoutMs: ((config().engine || {}).timeoutSeconds || 240) * 1000,
    });
    if (res.error) return { error: res.error };
    const brief = project.capBrief(res.text);
    if (!brief) return { error: 'The engine returned an empty brief.' };
    return { brief, files: collected.files, truncated: collected.truncated, call: res.call, head: collected.head || null };
  }

  // Building a brief is one engine call, which is seconds. Without this the plug looked dead for
  // all of them, so it got clicked again, and every click started another attach.
  const attaching = new Set();

  async function attachProject(slug, dir, sshHost = null) {
    if (!store || !slug) return;
    if (attaching.has(slug)) { notice('info', 'Still connecting to that project. One moment.'); return; }
    const label = sshHost ? `${sshHost}:${path.posix.basename(dir.replace(/\/+$/, '')) || dir}` : (path.basename(dir) || dir);
    const same = (p) => p.path === dir && (p.host || null) === (sshHost || null);
    if (!engine.selection().ok) {
      // Attaching without an engine is allowed: the folder is recorded and the brief builds later.
      const list = (store.read(slug).projects || []).filter((p) => !same(p));
      list.push({ id: `p${list.length + 1}`, label, path: dir, host: sshHost || undefined, brief: '', builtAt: 0, head: sshHost ? null : gitHead(dir), files: [], error: engine.selection().reason });
      store.setProjects(slug, list);
      const sess = sessions.get(slug); if (sess) sess.reread();
      notice('info', `${label} attached. Its brief will build once an engine is signed in.`);
      post();
      return;
    }
    attaching.add(slug);
    post();   // the panel has to show it started before the call, not after it finishes
    let built;
    try {
      built = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Connecting to ${label}…`, cancellable: false },
        () => buildBrief(dir, label, sshHost),
      );
    } finally {
      attaching.delete(slug);
    }
    const list = (store.read(slug).projects || []).filter((p) => !same(p));
    const id = `p${Date.now().toString(36)}`;
    const base = { id, label, path: dir, ...(sshHost ? { host: sshHost } : {}) };
    if (built.error) {
      list.push({ ...base, brief: '', builtAt: 0, head: sshHost ? null : gitHead(dir), files: [], error: built.error });
      notice('error', `Could not describe ${label}: ${built.error}`);
    } else {
      list.push({
        ...base, brief: built.brief, builtAt: Date.now(), head: sshHost ? built.head : gitHead(dir),
        files: built.files, truncated: built.truncated,
        call: built.call ? { model: built.call.model, in: (built.call.usage || {}).input || 0, out: (built.call.usage || {}).output || 0 } : null,
        error: null,
      });
      notice('info', `${label} attached — read ${built.files.length} file${built.files.length === 1 ? '' : 's'}.`);
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
      const v = await vscode.window.showInputBox({ prompt: `Value for {{${n}}}`, placeHolder: 'Leave empty to keep the slot as it is. Values are remembered for this prompt.', ignoreFocusOut: true });
      if (v === undefined) return false;
      asked.add(n.toLowerCase());
      if (v) next[n] = v;
    }
    if (Object.keys(next).length) s.setVars(next);
    return true;
  }

  /** After a copy that lists files: the files themselves, onto the clipboard, when asked. */
  async function offerFiles(files) {
    if (!files.length) return;
    const choice = await vscode.window.showInformationMessage(
      `Copied. ${files.length} attached file${files.length === 1 ? ' is' : 's are'} listed at the end with ${files.length === 1 ? 'its' : 'their'} path${files.length === 1 ? '' : 's'}. Paste the prompt, then copy the files and paste them beside it.`,
      'Copy the files',
    );
    if (choice !== 'Copy the files') return;
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
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting Claude…', cancellable: false }, () => sleep(6000));
    t.sendText(sendMod.pasteSequence(text), false);
    return t;
  }

  async function deliver(item, text) {
    switch (item.kind) {
      case 'terminal': {
        const t = claudeTerminals().find((x) => x.name === item.name);
        if (!t) throw new Error(`the terminal "${item.name}" is closed`);
        t.show(false);
        t.sendText(sendMod.pasteSequence(text), false);
        return;
      }
      case 'session':
        await vscode.commands.executeCommand('claude-vscode.editor.open', item.id, text);
        return;
      case 'new-panel':
        await vscode.commands.executeCommand('claude-vscode.editor.open', undefined, text);
        return;
      case 'new-terminal':
        await startTerminal({ name: `Claude · ${path.basename(item.folder)}`, cwd: item.folder, command: 'claude', text });
        return;
      case 'remote':
        await startTerminal({ name: `Claude · ${item.host}`, cwd: undefined, command: sendMod.remoteClaudeCommand(item.host, item.dir), text });
        return;
      default:
        throw new Error(`nowhere to send "${item.kind}"`);
    }
  }

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
    const items = sendMod.destinations({ folder, terminals, sessions: sessionsHere, hasClaudeExtension: hasClaudeExtension(), remembered, remote: far });
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
    try {
      await deliver(item, text);
    } catch (e) {
      notice('error', `Could not send: ${e.message}`);
      return;
    }
    const { label: _l, description: _d, last: _last, index: _i, ...rest } = item;
    const record = rest.kind === 'new-panel' ? { kind: 'new-panel', folder: rest.folder, promptStart: text.split('\n').find((l) => l.trim()) || '' } : rest;
    await s.markSent(record);
    notice('info', `The prompt is in ${destLabel(item)}. Press Enter there to send it.`);
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
        await deliver(live, add.text);
        await s.markSent(remembered);
        notice('info', `What changed is in ${destLabel(remembered)}. Press Enter there to send it.${add.restyled ? ' The prompt was restyled since, so the whole prompt may read better.' : ''}`);
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
    switch (m.type) {
      case 'ready':
        post();
        if (pendingSendMenu && s) postSendMenu(s, { open: true });
        return;
      case 'panelOpened':
        post();
        return;
      case 'openPrompt':
        if (m.slug && store.exists(m.slug)) await openSession(m.slug);
        return;
      case 'newFromTemplate': {
        // Deliberately NOT on the + button: creating a prompt stayed one click, and a picker in
        // front of it would tax every new prompt to serve the first one.
        const items = templates.TEMPLATES.map((t) => ({ label: t.label, detail: t.blurb, id: t.id }));
        const pick = m.id
          ? { id: String(m.id) }
          : await vscode.window.showQuickPick(items, { placeHolder: 'Start from which shape? Each one is real text with the unknowns in [brackets].' });
        if (!pick) return;
        const t = templates.byId(pick.id);
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
        const ok = await vscode.window.showWarningMessage(`Delete "${item.title}"? It moves to the library's .trash folder.`, { modal: true }, 'Delete');
        if (ok !== 'Delete') return;
        const sess = sessions.get(m.slug);
        if (sess) { sess.dispose(); sessions.delete(m.slug); }
        store.remove(m.slug);
        if (activeSlug === m.slug) { activeSlug = null; await globalState.update(LAST_OPEN, undefined); }
        post();
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
        s.submitIdea(m.text, Array.isArray(m.attachments) ? m.attachments : Array.isArray(m.images) ? m.images : []);
        return;
      case 'addIdea': {
        const target = await sessionForCommand();
        if (!target) return;
        if (!engine.selection().ok) { notice('error', engine.selection().reason); vscode.window.showWarningMessage(`Prompt Forge: ${engine.selection().reason}`); return; }
        const text = m.text != null ? String(m.text) : await vscode.window.showInputBox({ prompt: `An idea for "${target.snapshot().title}"`, placeHolder: 'It is merged into the prompt when you press Enter.', ignoreFocusOut: true });
        if (!text || !text.trim()) return;
        target.submitIdea(text);
        vscode.window.setStatusBarMessage(`$(check) Idea sent to ${target.snapshot().title}`, 4000);
        return;
      }
      case 'addSelection': {
        const target = await sessionForCommand();
        if (!target) return;
        if (!engine.selection().ok) { vscode.window.showWarningMessage(`Prompt Forge: ${engine.selection().reason}`); return; }
        const lines = Math.max(1, Number(m.end || 1) - Number(m.start || 1) + 1);
        const note = await vscode.window.showInputBox({
          prompt: `What about these ${lines} line${lines === 1 ? '' : 's'} of ${m.file || 'code'}? Optional.`,
          placeHolder: 'e.g. this should validate the email before it saves. Enter to send as it is.',
          ignoreFocusOut: true,
        });
        if (note === undefined) return;
        target.submitIdea(selectionIdea({ note, text: m.text, file: m.file, start: m.start, end: m.end, lang: m.lang }));
        vscode.window.setStatusBarMessage(`$(check) Selection sent to ${target.snapshot().title}`, 4000);
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
          items.push({ label: `$(eye) View the brief for ${p.label}`, description: what, act: 'view', id: p.id });
          items.push({ label: `$(refresh) Rebuild ${p.label}'s brief`, description: p.host ? `${p.host}:${p.path}` : p.path, act: 'refresh', id: p.id });
          items.push({ label: `$(debug-disconnect) Disconnect ${p.label}`, act: 'detach', id: p.id });
        }
        items.push({ label: '$(add) Connect another project…', detail: 'For a prompt that genuinely spans repos, here or on another machine', act: 'add' });
        const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Project context for this prompt' });
        if (!pick) return;
        if (pick.act === 'add') { const got = await pickProjectDir(); if (got) await attachProject(s.slug, got.dir, got.host); return; }
        if (pick.act === 'detach') { detachProject(s.slug, pick.id); return; }
        await handleMessage({ type: `project.${pick.act}`, id: pick.id });
        return;
      }
      case 'suggestion.dismiss':
        if (s && m.text) s.dismissSuggestion(String(m.text));
        return;
      case 'setSuggestions':
        await updateSetting('suggestions', m.value !== false);
        post();
        return;
      case 'project.detach':
        if (s && m.id) detachProject(s.slug, String(m.id));
        return;
      case 'project.refresh': {
        if (!s || !m.id) return;
        const p = (store.read(s.slug).projects || []).find((x) => x.id === String(m.id));
        if (p) await attachProject(s.slug, p.path, p.host || null);
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
        if (!(await fillMissingVars(s))) return;
        const text = await s.copyText();
        const items = [
          { label: '$(markdown) Markdown file', detail: 'The finished prompt, as you would paste it', act: 'md' },
          { label: '$(terminal) Claude Code slash command', detail: `.claude/commands/${s.slug}.md in this workspace — then /${s.slug}`, act: 'cmd' },
          { label: '$(json) Whole prompt as JSON', detail: 'Document, every idea, versions and conflicts — the portable form', act: 'json' },
        ];
        const pick = m.act ? { act: String(m.act) } : await vscode.window.showQuickPick(items, { placeHolder: 'Export this prompt as…' });
        if (!pick) return;
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
        offerFiles(snap.files).catch((e) => log.warn(`copy files: ${e.message}`));
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
        const url = await vscode.window.showInputBox({
          prompt: 'A git remote for the prompt library: a private repository you own',
          placeHolder: 'git@github.com:you/prompts.git',
          value: current, ignoreFocusOut: true,
        });
        if (url === undefined) return;
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
        if (s && e.document && e.document.uri && docio.same(e.document.uri.fsPath, s.docPath)) repaintSoon();
      }));
      // The kit watches sourcePath/autoReload; the settings that change behaviour are watched here.
      disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('promptForge.libraryPath')) { openStore(); startSync(); post(); }
        if (e.affectsConfiguration('promptForge.layout') || e.affectsConfiguration('promptForge.layoutStackWidth') || e.affectsConfiguration('promptForge.layoutSplit') || e.affectsConfiguration('promptForge.railCollapsed')) post();
        if (['promptForge.engine', 'promptForge.cli', 'promptForge.compatible'].some((k) => e.affectsConfiguration(k))) {
          engine.detectAll().then(() => { if (!disposed) post(); });
        }
        if (e.affectsConfiguration('promptForge.sync')) { startSync(); post(); }
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
      });
      startSync();
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
      stopSync();
      docEditors.dispose();
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
      engine.dispose();
      for (const d of disposables) { try { d.dispose(); } catch { /* already gone */ } }
    },
  };
}

module.exports = { create };
