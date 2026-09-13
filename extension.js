'use strict';
// Prompt Forge, the COLD shell.
//
// Registers only what VS Code will not let us re-register: the commands, the status bar item, and
// the panel. Every behaviour lives in src/ and is re-required on reload, so shipping a change does
// NOT restart the extension host (which would also kill any AI coding session running in it).
//
// If you are editing THIS file to change behaviour, the behaviour is in the wrong file.
const vscode = require('vscode');
const path = require('node:path');
const { createHotHost } = require('./src/hot/hot');

const PANEL_ID = 'promptForge.panel';
const DOC_EDITOR_ID = 'promptForge.markdown';   // must match contributes.customEditors

let log;
let statusItem;
let panel = null;
let hot = null;
let ctx = null;
const docEditors = new Set();   // { document, panel } for every open built-in document editor

function readConfig() {
  const c = vscode.workspace.getConfiguration('promptForge');
  return {
    libraryPath: c.get('libraryPath', '~/.prompt-forge/prompts'),
    engine: {
      provider: c.get('engine.provider', 'auto'),
      mergeModel: c.get('engine.mergeModel', 'auto'),
      polishModel: c.get('engine.polishModel', 'auto'),
      timeoutSeconds: c.get('engine.timeoutSeconds', 240),
      recentEntries: c.get('engine.recentEntries', 12),
      mergeEffort: c.get('engine.mergeEffort', 'low'),
      polishEffort: c.get('engine.polishEffort', 'auto'),
      mergeOutput: c.get('engine.mergeOutput', 'edits'),
      prewarm: c.get('engine.prewarm', true),
    },
    sync: {
      remote: c.get('sync.remote', ''),
      intervalMinutes: c.get('sync.intervalMinutes', 5),
      auto: c.get('sync.auto', true),
    },
    cli: {
      claudePath: c.get('cli.claudePath', ''),
      geminiPath: c.get('cli.geminiPath', ''),
      codexPath: c.get('cli.codexPath', ''),
    },
    compatible: { baseUrl: c.get('compatible.baseUrl', '') },
    layout: {
      mode: c.get('layout', 'auto'),
      stackWidth: c.get('layoutStackWidth', 620),
      split: c.get('layoutSplit', 52),
      railCollapsed: c.get('railCollapsed', false),
    },
    project: {
      roots: c.get('projectRoots', []),
      context: c.get('projectContext', 'brief'),
      tokenBudget: c.get('tokenBudget', 0),
      attachDefault: c.get('projectDefault', 'none'),
      maxFiles: c.get('projectMaxFiles', 400),
      maxBytes: c.get('projectMaxBytes', 2000000),
    },
    suggestions: c.get('suggestions', true),
    keepVersionBodies: c.get('keepVersionBodies', 20),
    docEditor: c.get('docEditor', 'forge'),
    sourcePath: c.get('sourcePath', ''),
    autoReload: c.get('autoReload', true),
  };
}

/** Every directory the webview may load media from: the working copy and the installed copy. */
function mediaRoots(root) {
  const roots = [path.join(root, 'media')];
  const installed = path.join(ctx.extensionPath, 'media');
  if (!roots.includes(installed)) roots.push(installed);
  return roots;
}

function paint(runtime) {
  if (!panel || !runtime) return;
  panel.webview.html = runtime.html({
    vscode,
    webview: panel.webview,
    mediaRoots: mediaRoots(hot.root()),
    stamp: `${hot.generation()}-${Date.now()}`,
  });
  runtime.replay();
}

/**
 * The built-in markdown editor. Registered here because a custom editor provider cannot be
 * re-registered on the fly; what happens INSIDE one is the hot runtime's business, and every live
 * editor is handed to the new runtime after a reload (see afterBoot).
 */
function registerDocEditor() {
  return vscode.window.registerCustomEditorProvider(DOC_EDITOR_ID, {
    async resolveCustomTextEditor(document, webviewPanel) {
      const entry = { document, panel: webviewPanel };
      webviewPanel.iconPath = vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'icon.png'));
      docEditors.add(entry);
      webviewPanel.onDidDispose(() => {
        docEditors.delete(entry);
        const rt = hot.current();
        if (rt) rt.detachDoc(webviewPanel);
      });
      const rt = hot.current();
      if (rt) await rt.attachDoc(document, webviewPanel, hot.generation());
    },
  }, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false });
}

/** Hand every open document editor to a freshly booted runtime, or it keeps running the old code. */
function repaintDocEditors(runtime, generation) {
  for (const entry of [...docEditors]) {
    // A disposed webview throws on first touch, sync or async depending on where it is noticed.
    const drop = (e) => { docEditors.delete(entry); log.debug(`dropped a closed document editor: ${e.message}`); };
    try {
      const done = runtime.attachDoc(entry.document, entry.panel, generation);
      if (done && typeof done.catch === 'function') done.catch(drop);
    } catch (e) { drop(e); }
  }
}

/** Create the Prompt Forge window if it is not open, and reveal it. */
function ensurePanel() {
  if (panel) { panel.reveal(vscode.ViewColumn.One); return panel; }
  panel = vscode.window.createWebviewPanel(PANEL_ID, 'Prompt Forge', vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: mediaRoots(hot.root()).map((r) => vscode.Uri.file(r)),
  });
  // The Marketplace icon, so the tab shows the same anvil people installed.
  panel.iconPath = vscode.Uri.file(path.join(ctx.extensionPath, 'media', 'icon.png'));
  panel.onDidDispose(() => { panel = null; }, null, ctx.subscriptions);
  panel.webview.onDidReceiveMessage((m) => {
    const rt = hot.current();
    if (rt) rt.handleMessage(m).catch((e) => log.error(`message failed: ${e.stack || e.message}`));
  }, null, ctx.subscriptions);
  paint(hot.current());
  const rt = hot.current();
  if (rt) rt.handleMessage({ type: 'panelOpened' }).catch((e) => log.error(`panelOpened failed: ${e.message}`));
  return panel;
}

function send(m) {
  ensurePanel();
  const rt = hot.current();
  if (rt) rt.handleMessage(m).catch((e) => log.error(`${m.type} failed: ${e.stack || e.message}`));
}

/** The selection is read here, before anything can move focus away from the editor it is in. */
function selectionMessage() {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.selection.isEmpty) return { type: 'addIdea' };
  const sel = ed.selection;
  // A selection ending at column 0 of the next line is "these lines", not "and one character more".
  const end = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  return {
    type: 'addSelection',
    text: ed.document.getText(sel),
    file: vscode.workspace.asRelativePath(ed.document.uri),
    start: sel.start.line + 1,
    end,
    lang: ed.document.languageId,
  };
}

function activate(context) {
  ctx = context;
  // A LogOutputChannel, not console.log: in a remote extension host, console output reaches nobody.
  log = vscode.window.createOutputChannel('Prompt Forge', { log: true });
  context.subscriptions.push(log);

  statusItem = vscode.window.createStatusBarItem('promptForge.status', vscode.StatusBarAlignment.Right, 90);
  statusItem.name = 'Prompt Forge';
  statusItem.text = '$(tools) Forge';
  statusItem.tooltip = 'Open Prompt Forge';
  statusItem.command = 'promptForge.open';
  statusItem.show();
  context.subscriptions.push(statusItem);

  hot = createHotHost({
    vscode,
    context,
    log,
    section: 'promptForge',
    runtimeRel: 'src/runtime.js',
    hostApi: () => ({
      log,
      vscode,
      config: readConfig,
      getPanel: () => panel,
      ensurePanel,
      globalState: context.globalState,
      secrets: context.secrets,
      extensionPath: context.extensionPath,
      mediaRoots: () => mediaRoots(hot.root()),
    }),
    // Rebuild the pages too, or the logic reloads behind the media/*.js the webviews already have.
    afterBoot: (runtime, _from, generation) => { paint(runtime); repaintDocEditors(runtime, generation); },
  });

  context.subscriptions.push(
    registerDocEditor(),
    vscode.commands.registerCommand('promptForge.open', () => ensurePanel()),
    vscode.commands.registerCommand('promptForge.newPrompt', () => send({ type: 'newPrompt' })),
    vscode.commands.registerCommand('promptForge.polish', () => send({ type: 'polish' })),
    vscode.commands.registerCommand('promptForge.copy', () => send({ type: 'copy' })),
    vscode.commands.registerCommand('promptForge.signIn', () => send({ type: 'engine.signIn' })),
    vscode.commands.registerCommand('promptForge.setApiKey', () => send({ type: 'engine.setKey' })),
    vscode.commands.registerCommand('promptForge.forgetApiKey', () => send({ type: 'engine.forgetKey' })),
    vscode.commands.registerCommand('promptForge.toggleRail', () => send({ type: 'setLayout', toggleRail: true })),
    vscode.commands.registerCommand('promptForge.attachProject', () => send({ type: 'project.pick' })),
    vscode.commands.registerCommand('promptForge.newFromTemplate', () => send({ type: 'newFromTemplate' })),
    vscode.commands.registerCommand('promptForge.export', () => send({ type: 'export' })),
    // Every command that asks something opens the panel: the questions are asked there, not in VS Code's
    // box at the top of the window. The selection is read before the panel can take focus.
    vscode.commands.registerCommand('promptForge.addIdea', () => send({ type: 'addIdea' })),
    vscode.commands.registerCommand('promptForge.addSelection', () => send(selectionMessage())),
    // Opens the panel: where to send is chosen in its own menu, not in a picker at the top of the window.
    vscode.commands.registerCommand('promptForge.sendToClaude', () => send({ type: 'sendToClaude' })),
    vscode.commands.registerCommand('promptForge.attachRemoteProject', () => send({ type: 'project.remote' })),
    vscode.commands.registerCommand('promptForge.syncNow', () => send({ type: 'sync.now' })),
    vscode.commands.registerCommand('promptForge.setUpSync', () => send({ type: 'sync.setup' })),
    vscode.commands.registerCommand('promptForge.live', () => send({ type: 'live.menu' })),
    // An invite link, vscode://trifactorscaling.prompt-forge-trifactor/join?code=…, joins a live library.
    vscode.window.registerUriHandler({
      handleUri(uri) {
        if (String(uri.path || '').replace(/\/+$/, '') !== '/join') return;
        const code = new URLSearchParams(uri.query || '').get('code');
        if (code) send({ type: 'live.join', code });
      },
    }),
  );
  // NOTE: the kit registers `promptForge.reload` and its own configuration watcher for
  // sourcePath / autoReload. Anything else that must react to a settings change belongs in the
  // runtime, which reads config() fresh on every call.

  hot.boot('activate');
  hot.watch();
  log.info('activated');
}

function deactivate() {
  // The kit registered its own disposable on context.subscriptions; nothing to undo here.
}

module.exports = { activate, deactivate };
