'use strict';
// Shared pieces every provider uses. A provider module exports create(deps) -> provider, where deps
// are injected (runCli, resolveBin, fetch, fs, home) so the tests run with fakes and no network.
const path = require('node:path');
const catalog = require('./catalog.json');
const { extractJson } = require('../engine/output');

const secretKey = (id) => `promptForge.apiKey.${id}`;

function parseVersion(s) {
  const m = /(\d+\.\d+(?:\.\d+)?)/.exec(String(s || ''));
  if (m) return m[1];
  const first = String(s || '').trim().split(/\r?\n/)[0];
  return first || null;
}

/** First model matching each regex in order, else a positional fallback. */
function firstMatching(models, regexes, fallback) {
  for (const re of regexes) {
    const m = models.find((x) => re.test(x.id));
    if (m) return m.id;
  }
  return fallback ? fallback.id : undefined;
}

function pickDefaults(models) {
  if (!models || !models.length) return {};
  const fast = models.find((m) => m.tier === 'fast') || models[0];
  const best = models.find((m) => m.tier === 'best') || models[models.length - 1];
  return { merge: fast.id, polish: best.id };
}

/** Find the binary and read its version. Never throws. */
async function detectCli({ name, runCli, resolveBin, configured }) {
  const bin = resolveBin(name, { configured, fresh: true });
  if (!bin) return { found: false, path: null, version: null, loggedIn: false, account: null, plan: null, note: null };
  const v = await runCli({ bin, args: ['--version'], timeoutMs: 20000 });
  return { found: true, path: bin, version: v.ok ? parseVersion(v.stdout) : null, loggedIn: false, account: null, plan: null, note: v.ok ? null : `\`${name} --version\` failed: ${v.error}` };
}

function readJsonFile(fs, p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

/** The readable error from a failed CLI run: a JSON error object if the CLI printed one, else stderr. */
function cliError(res) {
  const j = extractJson(res.stderr) || extractJson(res.stdout);
  const msg = j && j.error && (j.error.message || j.error);
  if (msg) return String(typeof msg === 'string' ? msg : JSON.stringify(msg)).trim();
  return (res.error || res.stderr || `exit ${res.code}`).toString().trim().slice(0, 800);
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

/**
 * Run a CLI with a fixed `head` plus prunable flag `groups`. When the CLI rejects a flag an older
 * version does not know, that group is dropped and the call retried. Returns the last run result.
 */
async function runPruned({ runCli, bin, head, groups, stdin, timeoutMs, scrub }) {
  let flags = groups.slice();
  for (let attempt = 0; attempt <= groups.length; attempt++) {
    const res = await runCli({ bin, args: [...head, ...flags.flat()], stdin, timeoutMs, scrub });
    if (res.ok) return res;
    const m = /unknown (?:option|argument)s?:?\s*'?(?:--?)?([\w-]+)/i.exec(`${res.stderr || ''}\n${res.error || ''}`);
    const i = m ? flags.findIndex((g) => String(g[0]).replace(/^-+/, '') === m[1]) : -1;
    if (i < 0) return res;
    flags = flags.filter((_, k) => k !== i);
  }
  return { ok: false, stdout: '', stderr: '', code: null, error: 'the CLI rejected every flag combination', ms: 0, collected: null };
}

module.exports = { catalog, secretKey, parseVersion, firstMatching, pickDefaults, detectCli, readJsonFile, cliError, extractJson, num, path, runPruned };
