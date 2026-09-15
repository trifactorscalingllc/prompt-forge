'use strict';
// Installing and removing the Claude Code plugin that auto-forge needs, through the claude CLI.
//
// Measured on 2.1.272 in an isolated CLAUDE_CONFIG_DIR: `plugin marketplace add <dir>` and
// `plugin install <id> --json` are both safe to repeat (an existing one is reported with exit 0),
// `marketplace add` has no --json, and an installed plugin is a copy under the config's
// plugins/cache. The source is copied first to ~/.prompt-forge/claude-plugin, a folder the
// extension's own updates never move, so the marketplace path stays valid across versions.
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MARKETPLACE = 'prompt-forge-local';
const PLUGIN_ID = `prompt-forge@${MARKETPLACE}`;
const BILLING = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];

function pluginVersion(root, fs = nodeFs) {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(root, 'prompt-forge', '.claude-plugin', 'plugin.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
}

/** The last JSON object a --json run printed, or null. */
function lastJson(stdout) {
  const lines = String(stdout || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('{'));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* not this one */ }
  }
  return null;
}

function createInstaller({ runCli, claudeBin, sourceDir, home = os.homedir(), fs = nodeFs, log = { info() {}, warn() {} } }) {
  const dest = path.join(home, '.prompt-forge', 'claude-plugin');

  async function claude(args, timeoutMs = 90000) {
    const bin = claudeBin();
    if (!bin) return { ok: false, error: 'the claude command was not found' };
    const r = await runCli({ bin, args, timeoutMs, scrub: BILLING });
    const text = `${r.stdout || ''}\n${r.stderr || ''}`.trim();
    return { ok: r.code === 0 && !r.error, json: lastJson(r.stdout), text, error: r.error || (r.code === 0 ? '' : (text.split('\n').pop() || `exit ${r.code}`)) };
  }

  /** Copy the plugin to its stable folder. true when the copy there changed. */
  function stage() {
    const want = pluginVersion(sourceDir, fs);
    if (!want) throw new Error(`no plugin found in ${sourceDir}`);
    if (pluginVersion(dest, fs) === want) return false;
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(sourceDir, dest, { recursive: true });
    return true;
  }

  return {
    dest,
    /** Make sure the plugin is installed at this extension's version. { ok, version, changed, error }. */
    async ensure() {
      let changed;
      try { changed = stage(); } catch (e) { return { ok: false, error: e.message }; }
      const version = pluginVersion(dest, fs);
      const add = await claude(['plugin', 'marketplace', 'add', dest]);
      if (!add.ok) return { ok: false, error: `could not add the plugin's marketplace: ${add.error}` };
      if (changed) await claude(['plugin', 'marketplace', 'update', MARKETPLACE]);
      const inst = await claude(['plugin', 'install', PLUGIN_ID, '--scope', 'user', '--json']);
      if (!inst.ok || !inst.json || inst.json.outcome !== 'ok') {
        return { ok: false, error: `could not install the plugin: ${(inst.json && inst.json.message) || inst.error}` };
      }
      // Installed before, from an older copy: bring it to this version.
      if (changed && /already installed/i.test(String(inst.json.message || ''))) {
        const up = await claude(['plugin', 'update', PLUGIN_ID]);
        if (!up.ok) log.warn(`auto-forge: plugin update said: ${up.error}`);
      }
      log.info(`auto-forge: Claude Code plugin ${PLUGIN_ID} ${version} installed`);
      return { ok: true, version, changed };
    },
    /** Remove the plugin and its marketplace. Safe when neither is there. */
    async remove() {
      const un = await claude(['plugin', 'uninstall', PLUGIN_ID, '--json']);
      const gone = un.ok || (un.json && un.json.failureCode === 'not_installed');
      await claude(['plugin', 'marketplace', 'remove', MARKETPLACE]);
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch { /* best effort */ }
      return gone ? { ok: true } : { ok: false, error: `could not uninstall the plugin: ${(un.json && un.json.message) || un.error}` };
    },
  };
}

module.exports = { createInstaller, pluginVersion, lastJson, MARKETPLACE, PLUGIN_ID };
