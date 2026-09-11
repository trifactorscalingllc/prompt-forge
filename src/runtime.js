'use strict';
// The HOT entry point. Everything here is disposed and re-required on reload. It holds no
// registration VS Code will not let us redo: the panel, the secrets and the settings come in
// through the host object, owned by extension.js.
//
// create() must touch nothing but `host` (the shell test builds it with a vscode that throws on
// any access); every VS Code side effect lives in start() or a message handler.
const fs = require('node:fs');
const os = require('node:os');
const view = require('./view');
const storeMod = require('./store');
const { createDocio } = require('./docio');
const { createSession } = require('./session');
const { createEngine } = require('./engine/engine');
const { createProviders, secretKey } = require('./providers');
const { runCli, resolveBin } = require('./providers/spawn');
const targets = require('./targets');

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
  const providers = createProviders({ runCli, resolveBin, fetch: globalThis.fetch, fs, home: os.homedir() });
  const engine = createEngine({ providers, config, secrets, log });

  // ------------------------------------------------------------------------------------------
  // Talking to the webview
  // ------------------------------------------------------------------------------------------

  function buildState() {
    if (!store) {
      if (!bootError) return null;
      return { bootError, library: config().libraryPath, prompts: [], active: null, engine: engine.state(), targets: targets.TARGETS, docEditor: config().docEditor, engineCfg: config().engine || {} };
    }
    const session = activeSlug ? sessions.get(activeSlug) : null;
    return {
      library: store.dir,
      prompts: store.list(),
      active: session ? session.snapshot() : null,
      engine: engine.state(),
      targets: targets.TARGETS,
      docEditor: config().docEditor,
      engineCfg: config().engine || {},
    };
  }

  function post() {
    const p = getPanel();
    const data = buildState();
    if (!p || !data) return;
    p.webview.postMessage({ type: 'state', data });
  }

  function notice(level, text) {
    const p = getPanel();
    if (p) p.webview.postMessage({ type: 'notice', level, text });
    if (level === 'error') log.error(text); else log.info(text);
  }

  // ------------------------------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------------------------------

  async function openSession(slug, { reveal = true } = {}) {
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
        if (s) await openDoc();
        return;
      case 'openPrompt':
        if (m.slug && store.exists(m.slug)) await openSession(m.slug);
        return;
      case 'newPrompt': {
        const title = (m.title || await vscode.window.showInputBox({ prompt: 'Name the prompt', placeHolder: 'e.g. Landing page rewrite brief', ignoreFocusOut: true }) || '').trim();
        if (!title) return;
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
      case 'polish':
        if (!s) return;
        if (!engine.selection().ok) { notice('error', engine.selection().reason); return; }
        s.polish();
        return;
      case 'copy': {
        if (!s) return;
        const text = await s.copyText();
        await vscode.env.clipboard.writeText(text);
        notice('info', `Copied ${text.length.toLocaleString()} characters for ${targets.labelOf(s.snapshot().target)}.`);
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
      case 'openDoc':
        await openDoc();
        return;
      case 'openLibrary':
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(store.dir));
        return;
      case 'openUrl':
        if (m.url && /^https:\/\//.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
        return;
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
    handleMessage,
    replay() { post(); },
    start() {
      openStore();
      disposables.push(vscode.workspace.onDidSaveTextDocument((d) => { if (d && d.uri) docio.noteSaved(d.uri.fsPath); }));
      // The kit watches sourcePath/autoReload; the settings that change behaviour are watched here.
      disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('promptForge.libraryPath')) { openStore(); post(); }
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
      for (const s of sessions.values()) s.dispose();
      sessions.clear();
      for (const d of disposables) { try { d.dispose(); } catch { /* already gone */ } }
    },
  };
}

module.exports = { create };
