// Vendored from TriFactor Scaling's shared VS Code hot-reload kit (MIT). Do not edit here;
// the cold shell (extension.js) registers, everything under src/ and media/ reloads live.

'use strict';
// createHotHost — the cold/hot split, packaged so every extension gets it the same way.
//
// The problem it solves, in one line: on this mini a Claude Code session started from VS Code is a
// CHILD of the extension host process, so "Reload Window" and "Restart Extension Host" both kill
// every running Claude chat in the window. An extension that needs either one to ship a change costs
// the user their sessions every single time.
//
// The split:
//   COLD  extension.js + package.json   registrations VS Code will not let you redo; needs a restart
//   HOT   src/** and media/**           disposed and re-required on demand; costs nothing
//
// The rule that keeps it working: if you are editing extension.js to change BEHAVIOUR, the behaviour
// is in the wrong file. extension.js should only ever register things and delegate.
const path = require('node:path');
const fs = require('node:fs');
const { bustCache, resolveRoot } = require('./reload');

/**
 * Wire up hot reloading for one extension.
 *
 * @param vscode        the vscode module (passed in, never required here — this file is unit-tested)
 * @param context       the ExtensionContext
 * @param log           a LogOutputChannel
 * @param section       settings section / command prefix, e.g. 'claudeTasks'
 * @param runtimeRel    module exporting create(hostApi), relative to the source root
 * @param hostApi       () => object handed to the runtime's create(); everything that must SURVIVE a
 *                      reload lives in here (the webview, the status bar item, config readers)
 * @param afterBoot     (runtime, root) => void; e.g. regenerate the webview HTML
 * @param onError       (error) => void
 */
function createHotHost({
  vscode,
  context,
  log,
  section,
  runtimeRel = 'src/runtime.js',
  hostApi = () => ({}),
  afterBoot = () => {},
  onError = null,
}) {
  let runtime = null;
  let watcher = null;
  let debounce = null;
  let generation = 0;

  const cfg = () => vscode.workspace.getConfiguration(section);
  const root = () => resolveRoot({
    sourcePath: cfg().get('sourcePath', ''),
    extensionPath: context.extensionPath,
    probeFile: runtimeRel,
  });

  function boot(why) {
    const from = root();
    try {
      if (runtime && typeof runtime.dispose === 'function') runtime.dispose();
      runtime = null;

      const dropped = bustCache(from);
      generation += 1;

      const mod = require(path.join(from, ...runtimeRel.split('/')));
      runtime = mod.create(hostApi());
      afterBoot(runtime, from, generation);
      if (typeof runtime.start === 'function') runtime.start();

      log.info(`reloaded (${why}) from ${from} — ${dropped} module${dropped === 1 ? '' : 's'} re-read, generation ${generation}`);
      return true;
    } catch (e) {
      // A broken edit must not take the extension down silently. The old runtime is already gone, so
      // say so loudly rather than sitting there looking alive with a dead view.
      log.error(`reload failed (${why}): ${e.stack || e.message}`);
      if (onError) onError(e);
      else vscode.window.showErrorMessage(`${section} reload failed: ${e.message}`);
      return false;
    }
  }

  /** Watch a working copy and reload on save, so shipping a change costs nothing at all. */
  function watch() {
    if (watcher) { watcher.close(); watcher = null; }
    const from = root();
    // Nothing to watch in an installed copy: it only changes when a new vsix is installed, and that
    // needs a host restart regardless.
    if (!cfg().get('autoReload', true) || from === context.extensionPath) return;
    try {
      watcher = fs.watch(from, { recursive: true }, (_e, file) => {
        if (!file || !/\.(js|css|html)$/.test(file)) return;
        clearTimeout(debounce);
        debounce = setTimeout(() => boot(`source changed: ${file}`), 250);   // editors write in bursts
      });
      watcher.on('error', (e) => log.warn(`source watch stopped: ${e.message}`));
      log.info(`auto-reloading on changes under ${from}`);
    } catch (e) {
      log.warn(`could not watch ${from}: ${e.message}`);
    }
  }

  context.subscriptions.push(
    vscode.commands.registerCommand(`${section}.reload`, () => {
      if (boot('command')) vscode.window.showInformationMessage(`${section} reloaded (generation ${generation}).`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(section)) return;
      if (e.affectsConfiguration(`${section}.sourcePath`) || e.affectsConfiguration(`${section}.autoReload`)) {
        watch();
        boot('source path changed');
      }
    }),
    { dispose() { if (watcher) watcher.close(); clearTimeout(debounce); if (runtime && runtime.dispose) runtime.dispose(); } },
  );

  return {
    boot,
    watch,
    current: () => runtime,
    root,
    generation: () => generation,
  };
}

/** The two settings every hot extension contributes. Spread into package.json properties. */
function settingsFor(section, workingCopyHint = '/path/to/working/copy') {
  return {
    [`${section}.sourcePath`]: {
      type: 'string',
      default: '',
      scope: 'machine',
      markdownDescription: `Absolute path to a working copy of this extension (e.g. \`${workingCopyHint}\`). When set, \`${section}.reload\` re-reads its code from there, so changes apply without reinstalling or restarting the extension host. Machine-scoped on purpose: a workspace-scoped setting would let any repo you open nominate code for this extension to execute.`,
    },
    [`${section}.autoReload`]: {
      type: 'boolean',
      default: true,
      scope: 'machine',
      description: 'When a source path is set, reload automatically as its files change. Has no effect on the installed copy.',
    },
  };
}

module.exports = { createHotHost, settingsFor, bustCache, resolveRoot };
