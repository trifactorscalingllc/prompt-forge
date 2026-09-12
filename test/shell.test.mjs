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

test('the header is a plug and a gear; Polish, Copy and Edit live on the Prompt panel', () => {
  const whole = fs.readFileSync(path.join(ROOT, 'src/view.js'), 'utf8');
  // Only the panel page. docHtml is a second, separate document with its own notice bar.
  const view = whole.slice(0, whole.indexOf('The built-in document editor'));
  const head = view.slice(view.indexOf('<div class="head-actions">'), view.indexOf('</div>', view.indexOf('<div class="head-actions">')));
  assert.ok(/id="connect"/.test(head), 'the plug is in the header');
  assert.ok(/id="settings"[^>]*class="iconbtn ghost"/.test(head), 'settings is a ghost icon button, no box until you reach for it');
  // Target, then the plug, then settings.
  assert.ok(head.indexOf('id="target"') < head.indexOf('id="connect"'), 'the plug sits right of Target');
  assert.ok(head.indexOf('id="connect"') < head.indexOf('id="settings"'));
  // A gear has teeth. Eight lines radiating from a circle is a sun.
  assert.ok(/gear: '<svg[^']*fill="currentColor"[^']*fill-rule="evenodd"/.test(whole), 'the gear is a filled toothed shape');
  assert.ok(!/id="polish"/.test(head) && !/id="copy"/.test(head), 'Polish and Copy left the header');
  assert.ok(!/id="project"/.test(whole), 'the old Project chip is gone');

  const preview = view.slice(view.indexOf('<section id="preview"'), view.indexOf('</section>', view.indexOf('<div class="col-foot">')));
  for (const id of ['polish', 'copy', 'open-doc']) assert.ok(new RegExp(`id="${id}"`).test(preview), `${id} is on the Prompt panel`);
  assert.ok(preview.indexOf('id="polish"') < preview.indexOf('id="open-doc"'), 'Polish sits beside Edit');
  assert.ok(preview.indexOf('id="copy"') < preview.indexOf('id="open-doc"'), 'Copy sits beside Edit');

  // The count is always visible and the notice bar moved out of the header to sit under the prompt.
  const foot = view.slice(view.indexOf('<div class="col-foot">'));
  assert.ok(/id="notice"/.test(foot) && /id="doc-count"/.test(foot), 'both live in the Prompt foot');
  assert.equal((view.match(/id="notice"/g) || []).length, 1, 'one notice bar, not two');

  const panel = fs.readFileSync(path.join(ROOT, 'media/panel.js'), 'utf8');
  assert.ok(/doc-count'\)\.textContent = `\$\{n\.toLocaleString\(\)\}/.test(panel), 'the count is rendered, not decorative');
  // Nothing connected means connect straight to the open folder; the picker is not in the way.
  assert.ok(/type: list\.length \? 'project\.menu' : 'project\.connect'/.test(panel));
  const runtime = fs.readFileSync(path.join(ROOT, 'src/runtime.js'), 'utf8');
  assert.ok(/case 'project\.connect'/.test(runtime) && /const ws = workspaceDir\(\);/.test(runtime));

  // Copy confirms on the button. Both glyphs are in the DOM so nothing is rebuilt from a string.
  assert.ok(/type: 'copied'/.test(runtime), 'the extension tells the panel, rather than raising a notice');
  assert.ok(/function flashCopied/.test(panel) && /classList\.add\('ok'\)/.test(panel));
  assert.ok(/class="iconbtn swap"/.test(view) && /i-off/.test(view) && /i-on/.test(view));
  const css = fs.readFileSync(path.join(ROOT, 'media/panel.css'), 'utf8');
  assert.ok(/\.iconbtn\.swap \.i-on \{ display: none/.test(css) && /\.iconbtn\.swap\.ok \.i-off \{ display: none/.test(css));
});

test('the compose hint lives in the box, and a collapsed rail still starts a prompt', () => {
  const view = fs.readFileSync(path.join(ROOT, 'src/view.js'), 'utf8');
  assert.ok(!/class="hint"/.test(view), 'the line above the box is gone');
  const ta = /<textarea id="idea"[^>]*placeholder="([^"]+)"/.exec(view);
  assert.ok(ta, 'the idea box has a placeholder');
  for (const phrase of ['press Enter', 'Shift+Enter', 'Hover a sent idea']) {
    assert.ok(ta[1].includes(phrase), `the placeholder carries "${phrase}"`);
  }
  // Collapsed hides the word, never the button: a strip with only a chevron is a dead strip.
  const css = fs.readFileSync(path.join(ROOT, 'media/panel.css'), 'utf8');
  assert.ok(/#app\.rail-collapsed \.new-label/.test(css), 'the label collapses');
  assert.ok(!/#app\.rail-collapsed #new,|#app\.rail-collapsed #new \{ display: none/.test(css), '+ stays');
  assert.ok(/class="plus"/.test(view) && /class="new-label"/.test(view));
});

test('a prompt is named by the engine in five words, not by slicing what was typed', () => {
  const prompt = fs.readFileSync(path.join(ROOT, 'src/engine/prompt.js'), 'utf8');
  assert.ok(/needsTitle/.test(prompt), 'the merge prompt asks only when there is no title yet');
  assert.ok(/AT MOST FIVE WORDS/.test(prompt));
  assert.ok(/Name the subject, not the act of asking/.test(prompt), 'the failure mode it must avoid is named');
  const out = fs.readFileSync(path.join(ROOT, 'src/engine/output.js'), 'utf8');
  assert.ok(/title: typeof obj\.title === 'string'/.test(out), 'the parser passes a title through');
  const session = fs.readFileSync(path.join(ROOT, 'src/session.js'), 'utf8');
  assert.ok(/docm\.capTitle\(out\.title\) \|\| docm\.titleFrom/.test(session), 'engine first, slice as the fallback');
});

test('the prompts rail collapses from both the chevron and the command, and survives a reload', () => {
  const props = pkg.contributes.configuration.properties;
  assert.equal(props['promptForge.railCollapsed'].type, 'boolean');
  assert.equal(props['promptForge.railCollapsed'].default, false);
  assert.equal(props['promptForge.railCollapsed'].scope, 'window', 'a workspace must not collapse the rail for every window');

  const shell = fs.readFileSync(path.join(ROOT, 'extension.js'), 'utf8');
  assert.ok(/c\.get\('railCollapsed', false\)/.test(shell), 'the cold shell reads it');

  // The command cannot know the current value, so it asks for a flip rather than sending one.
  assert.ok(/toggleRail: true/.test(shell), 'the command sends a flip, not a value');
  const runtime = fs.readFileSync(path.join(ROOT, 'src/runtime.js'), 'utf8');
  assert.ok(/if \(m\.toggleRail\)/.test(runtime), 'the runtime resolves the flip against its own state');
  assert.ok(!/\.update\('railCollapsed'/.test(runtime), 'railCollapsed is written through updateSetting');
  assert.ok(/railCollapsed: false/.test(runtime), 'the default does not come from the running manifest');

  const view = fs.readFileSync(path.join(ROOT, 'src/view.js'), 'utf8');
  assert.ok(/id="rail-toggle"/.test(view), 'the chevron is in the markup');
  const panel = fs.readFileSync(path.join(ROOT, 'media/panel.js'), 'utf8');
  assert.ok(/rail-collapsed/.test(panel) && /railCollapsed: layout\.railCollapsed/.test(panel), 'the panel toggles the class and reports the value');

  // Collapsed must take width when side by side and height when stacked, or a narrow window ends up
  // with a 30px-wide strip above the work instead of a thin bar.
  const css = fs.readFileSync(path.join(ROOT, 'media/panel.css'), 'utf8');
  assert.ok(/#app\.rail-collapsed #rail \{[^}]*width: 30px/.test(css), 'side by side, it narrows');
  const narrow = css.slice(css.indexOf('@media (max-width: 620px)'));
  assert.ok(/#app\.rail-collapsed #rail \{[^}]*width: auto/.test(narrow), 'stacked, it does not');
});

test('a setting the running host cannot register is kept for the session instead of thrown at the user', () => {
  const runtime = fs.readFileSync(path.join(ROOT, 'src/runtime.js'), 'utf8');
  assert.ok(/async function updateSetting/.test(runtime));
  // Settings added by a vsix do not exist until the window reloads; those writes must not be raw.
  for (const key of ['layout', 'layoutStackWidth', 'layoutSplit', 'docEditor']) {
    assert.ok(!new RegExp(`\\.update\\('${key}'`).test(runtime), `${key} is written through updateSetting`);
  }
  assert.ok(/const LAYOUT = \{ mode: 'auto'/.test(runtime), 'the defaults do not come from the running manifest');
  const panel = fs.readFileSync(path.join(ROOT, 'media/panel.js'), 'utf8');
  assert.ok(/val !== undefined/.test(panel), 'an undefined from an older host never beats a default');
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
