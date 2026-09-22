'use strict';
// Installing the vendor CLI the engine needs, instead of telling someone to go and read a page.
//
// Read off the Claude Code setup docs (code.claude.com/docs/en/setup): the native installer needs no
// admin rights, puts a launcher in ~/.local/bin (%USERPROFILE%\.local\bin on Windows) and puts that
// on PATH itself. The extension host's PATH is whatever it inherited when the window opened, so a
// CLI installed a minute ago is found by looking straight at those paths rather than by asking the
// person to reload VS Code.
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CLAUDE_DOCS = 'https://code.claude.com/docs/en/setup';

// One command per platform, each the official one, and none of them needs sudo.
const PLANS = {
  darwin: { shell: 'posix', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
  linux: { shell: 'posix', command: 'curl -fsSL https://claude.ai/install.sh | bash' },
  win32: { shell: 'powershell', command: 'irm https://claude.ai/install.ps1 | iex' },
};

/** How to install this CLI here, or null when Prompt Forge has no business trying. */
function installPlan(name, { platform = process.platform } = {}) {
  if (name !== 'claude') return null;
  const plan = PLANS[platform];
  if (!plan) return null;
  return {
    name,
    ...plan,
    where: platform === 'win32' ? '%USERPROFILE%\\.local\\bin' : '~/.local/bin',
    docsUrl: CLAUDE_DOCS,
  };
}

/** Where the official installer leaves it, newest-first by how likely it is. */
function knownPaths(name, { platform = process.platform, home = os.homedir() } = {}) {
  if (name !== 'claude') return [];
  if (platform === 'win32') {
    return [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude.cmd')];
  }
  return [path.join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'];
}

/** The first of those that exists, or null. */
function installedPath(name, { platform = process.platform, home = os.homedir(), fs = nodeFs } = {}) {
  for (const p of knownPaths(name, { platform, home })) {
    try { if (fs.existsSync(p)) return p; } catch { /* unreadable is not installed */ }
  }
  return null;
}

module.exports = { installPlan, knownPaths, installedPath, CLAUDE_DOCS };
