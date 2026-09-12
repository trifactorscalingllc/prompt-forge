// The cold/hot invariants the hot-reload kit relies on, plus manifest sanity. No real `vscode`:
// the runtime must build from its host object alone, and the cold shell is only read as text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const shell = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');

function fakeHost() {
  const noop = () => {};
  return {
    log: { info: noop, warn: noop, error: noop, debug: noop, trace: noop, show: noop },
    vscode: new Proxy({}, { get: () => { throw new Error('create() must not touch vscode'); } }),
    config: () => ({
      libraryPath: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'forge-shell-')),
      engine: { provider: 'auto', mergeModel: 'auto', polishModel: 'auto', timeoutSeconds: 240, recentEntries: 12 },
      cli: { claudePath: '', geminiPath: '', codexPath: '' }, compatible: { baseUrl: '' }, docEditor: 'forge',
      sourcePath: '', autoReload: true,
    }),
    getPanel: () => null,
    ensurePanel: noop,
    globalState: { get: () => undefined, update: async () => {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    extensionPath: ROOT,
    mediaRoots: () => [path.join(ROOT, 'media')],
  };
}

test('the hot runtime builds from its host alone and exposes the kit contract', () => {
  const mod = require('../src/runtime.js');
  assert.equal(typeof mod.create, 'function');
  const rt = mod.create(fakeHost());
  for (const k of ['html', 'handleMessage', 'replay', 'start', 'dispose', 'attachDoc', 'detachDoc']) assert.equal(typeof rt[k], 'function', k);
  rt.dispose();
});

test('the cold shell uses the vendored kit and never requires the hot runtime directly', () => {
  assert.ok(shell.includes("require('./src/hot/hot')"));
  assert.ok(!/require\('\.\/src\/runtime'\)/.test(shell));
  assert.ok(!/onDidChangeConfiguration/.test(shell), 'the kit owns the sourcePath/autoReload watcher');
});

test('the manifest declares the reload command and machine-scoped developer settings', () => {
  const ids = pkg.contributes.commands.map((c) => c.command);
  assert.ok(ids.includes('promptForge.reload'));
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['promptForge.sourcePath'].scope, 'machine');
  assert.equal(props['promptForge.autoReload'].scope, 'machine');
});

test('every contributed command except the kit reload is registered by the cold shell', () => {
  for (const { command } of pkg.contributes.commands) {
    if (command === 'promptForge.reload') continue;
    assert.ok(shell.includes(`'${command}'`), `${command} registered`);
  }
});

test('every setting the cold shell reads is declared in the manifest, and vice versa', () => {
  const props = Object.keys(pkg.contributes.configuration.properties).map((k) => k.replace(/^promptForge\./, ''));
  const read = [...shell.matchAll(/c\.get\('([^']+)'/g)].map((m) => m[1]);
  for (const k of read) assert.ok(props.includes(k), `${k} is declared`);
  for (const k of props) assert.ok(read.includes(k), `${k} is read`);
});

test('the built-in document editor is contributed, registered cold, and opened by that exact id', () => {
  const [ce] = pkg.contributes.customEditors;
  assert.equal(ce.viewType, 'promptForge.markdown');
  assert.equal(ce.priority, 'option', 'never steals .md files from the default editor');
  assert.ok(shell.includes('registerCustomEditorProvider'), 'a provider cannot be re-registered hot');
  assert.ok(shell.includes(`'${ce.viewType}'`));
  const docio = fs.readFileSync(path.join(ROOT, 'src/docio.js'), 'utf8');
  assert.ok(docio.includes(`'${ce.viewType}'`), 'docio opens the id the manifest declares');
  // Nothing in the extension may require another extension to be installed.
  assert.ok(!pkg.extensionDependencies, 'no hard dependency on a third-party extension');
  const props = pkg.contributes.configuration.properties['promptForge.docEditor'];
  assert.equal(props.default, 'forge');
  assert.deepEqual(props.enum, ['forge', 'office', 'text']);
  assert.equal(props.enum.length, props.enumDescriptions.length);
});

test('every media file the pages load is in the vsix and parses', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src/view.js'), 'utf8');
  const wanted = [...view.matchAll(/asset\('([^']+)'\)/g)].map((m) => m[1]);
  assert.ok(wanted.includes('md.js') && wanted.includes('doc.js') && wanted.includes('doc.css'));
  for (const f of new Set(wanted)) {
    assert.ok(fs.existsSync(path.join(ROOT, 'media', f)), `media/${f} exists`);
    if (!f.endsWith('.js')) continue;
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, 'media', f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `media/${f}: ${r.stderr}`);
  }
});

test('the layout settings are declared, bounded, and the panel clamps to the same bounds', () => {
  const props = pkg.contributes.configuration.properties;
  assert.deepEqual(props['promptForge.layout'].enum, ['auto', 'columns', 'rows']);
  assert.equal(props['promptForge.layoutSplit'].minimum, 20);
  assert.equal(props['promptForge.layoutSplit'].maximum, 80);
  const runtime = fs.readFileSync(path.join(ROOT, 'src/runtime.js'), 'utf8');
  assert.ok(/Math\.max\(20, Math\.min\(80/.test(runtime), 'the runtime clamps what the webview sends');
  const panel = fs.readFileSync(path.join(ROOT, 'media/panel.js'), 'utf8');
  assert.ok(/Math\.max\(20, Math\.min\(80/.test(panel), 'the divider clamps too');
  // The shell must never scroll as a whole, or the prompt list scrolls away with the document.
  const css = fs.readFileSync(path.join(ROOT, 'media/panel.css'), 'utf8');
  assert.ok(/#app \{[^}]*height: 100vh[^}]*overflow: hidden/.test(css), '#app is the window, and does not scroll');
  assert.ok(/#rail \{[^}]*height: 100%/.test(css), 'the rail is full height');
});

test('the cold shell and the hot entry parse', () => {
  for (const f of ['extension.js', 'src/runtime.js']) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, f)], { encoding: 'utf8' });
    assert.equal(r.status, 0, `${f}: ${r.stderr}`);
  }
});

test('the vsix excludes tests, CI and the workspace marker', () => {
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  for (const p of ['test/**', '.github/**', '.no-doe']) assert.ok(ignore.includes(p), p);
});
