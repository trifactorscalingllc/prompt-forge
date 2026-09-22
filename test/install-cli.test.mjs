import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const install = require('../src/install-cli.js');

test('the install command is the official one for this platform, and needs no admin rights', () => {
  for (const platform of ['darwin', 'linux']) {
    const plan = install.installPlan('claude', { platform });
    assert.equal(plan.command, 'curl -fsSL https://claude.ai/install.sh | bash');
    assert.equal(plan.shell, 'posix');
    assert.equal(plan.where, '~/.local/bin');
  }
  const win = install.installPlan('claude', { platform: 'win32' });
  assert.equal(win.command, 'irm https://claude.ai/install.ps1 | iex');
  assert.equal(win.shell, 'powershell');
  assert.equal(win.where, '%USERPROFILE%\\.local\\bin');
  for (const plan of [install.installPlan('claude', { platform: 'darwin' }), win]) {
    assert.ok(!/\bsudo\b/.test(plan.command), 'never sudo');
    assert.ok(plan.docsUrl.startsWith('https://'));
  }
});

test('Prompt Forge offers to install nothing it has no official command for', () => {
  for (const name of ['gemini', 'codex', 'git']) assert.equal(install.installPlan(name), null, name);
  assert.equal(install.installPlan('claude', { platform: 'aix' }), null, 'an unknown platform is left alone');
  assert.deepEqual(install.knownPaths('gemini'), []);
});

test('a CLI installed a minute ago is found where the installer put it, not only on PATH', () => {
  const home = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'forge-install-cli-'));
  assert.deepEqual(install.knownPaths('claude', { platform: 'win32', home }), [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude.cmd'),
  ]);
  assert.equal(install.installedPath('claude', { platform: 'darwin', home }), null);
  const bin = path.join(home, '.local', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\n');
  assert.equal(install.installedPath('claude', { platform: 'darwin', home }), path.join(bin, 'claude'));
  assert.equal(install.installedPath('claude', { platform: 'darwin', home, fs: { existsSync() { throw new Error('unreadable'); } } }), null, 'an unreadable path is not an install');
});

test('a missing CLI is offered as an install, not as a docs link to go and read', () => {
  const runtime = fs.readFileSync(path.join(ROOT, 'src/runtime.js'), 'utf8');
  assert.ok(/case 'engine\.installCli':/.test(runtime));
  const flow = runtime.slice(runtime.indexOf('async function installEngineCli'), runtime.indexOf('async function setKey'));
  assert.ok(/uiConfirm\(\{/.test(flow) && /\$\{plan\.command\}/.test(flow), 'the exact command is shown before anything runs');
  assert.ok(/createTerminal\(\{ name: `Prompt Forge: install/.test(flow), 'in a terminal the person can watch');
  assert.ok(/await waitForCli\(/.test(flow) && /label: 'Sign in'/.test(flow), 'it waits for the CLI, then offers the sign-in');
  assert.ok(/resolveBin: resolveEngineBin/.test(runtime), 'the engine resolves a freshly installed CLI without a window reload');
  assert.ok(/await engine\.detectAll\(\)/.test(runtime.slice(runtime.indexOf('async function waitForCli'))), 're-detects while it waits');

  const panel = fs.readFileSync(path.join(ROOT, 'media/panel.js'), 'utf8');
  assert.ok(/type: 'engine\.installCli', provider: p\.id/.test(panel));
  assert.ok(/p\.installable \? 'Not installed\. Prompt Forge can install it for you\.'/.test(panel));

  const claude = fs.readFileSync(path.join(ROOT, 'src/providers/claude.js'), 'utf8');
  assert.ok(/installable: true/.test(claude));
  const engine = fs.readFileSync(path.join(ROOT, 'src/engine/engine.js'), 'utf8');
  assert.ok(/installable: Boolean\(p\.installable\)/.test(engine), 'read off the provider when detecting');
  assert.ok(/installable: d\.installable/.test(engine), 'and passed on to the panel');
  assert.match(require('../src/engine/engine.js').NO_ENGINE, /install the Claude CLI for you/);
});
