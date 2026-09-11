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
      cli: { claudePath: '', geminiPath: '', codexPath: '' }, compatible: { baseUrl: '' }, docEditor: 'office',
      sourcePath: '', autoReload: true,
    }),
    getPanel: () => null,
    ensurePanel: noop,
    globalState: { get: () => undefined, update: async () => {} },
    secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} },
    extensionPath: ROOT,
  };
}

test('the hot runtime builds from its host alone and exposes the kit contract', () => {
  const mod = require('../src/runtime.js');
  assert.equal(typeof mod.create, 'function');
  const rt = mod.create(fakeHost());
  for (const k of ['html', 'handleMessage', 'replay', 'start', 'dispose']) assert.equal(typeof rt[k], 'function', k);
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
