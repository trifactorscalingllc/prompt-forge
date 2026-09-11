'use strict';
// Claude: the `claude` CLI (your Claude subscription) or an Anthropic API key.
const { catalog, secretKey, firstMatching, detectCli, cliError, extractJson, num } = require('./base');
const { jsonRequest } = require('./http');

const KEY = secretKey('claude');
const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
// Billing switches. Their absence IS the subscription path: a stray key in the host environment
// would silently move every merge onto the paid API.
const BILLING = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
// Bare-call flags as groups, so a flag an older CLI rejects can be dropped as a unit.
const BARE = [
  ['--output-format', 'json'],
  ['--setting-sources', ''],
  ['--exclude-dynamic-system-prompt-sections'],
  ['--strict-mcp-config'],
  ['--mcp-config', '{"mcpServers":{}}'],
  ['--tools', 'none'],
];

function create({ runCli, resolveBin, fetch, fs, home }) {
  const bin = (cfg) => resolveBin('claude', { configured: cfg.cli && cfg.cli.claudePath });

  async function detect({ cfg, secrets }) {
    const cli = await detectCli({ name: 'claude', runCli, resolveBin, configured: cfg.cli && cfg.cli.claudePath });
    if (cli.found) {
      const a = await runCli({ bin: cli.path, args: ['auth', 'status'], timeoutMs: 20000, scrub: BILLING });
      const j = a.ok ? extractJson(a.stdout) : null;
      if (j && j.loggedIn) {
        cli.loggedIn = true;
        cli.account = j.email || j.orgName || null;
        cli.plan = j.subscriptionType || null;
      } else {
        cli.note = j ? 'Not signed in. Run `claude auth login`.' : `\`claude auth status\` failed: ${a.error || 'no JSON'}`;
      }
    }
    return { cli, apiKey: { stored: Boolean(await secrets.get(KEY)) } };
  }

  async function completeCli({ model, prompt, timeoutMs, cfg }) {
    const b = bin(cfg);
    if (!b) return { text: '', usage: null, error: 'claude CLI not found on PATH' };
    let flags = BARE.slice();
    for (let attempt = 0; attempt < BARE.length + 1; attempt++) {
      const args = ['-p', '--model', model, ...flags.flat()];
      const res = await runCli({ bin: b, args, stdin: prompt, timeoutMs, scrub: BILLING });
      if (!res.ok) {
        const m = /unknown option '([^']+)'/i.exec(res.stderr || res.error || '');
        const i = m ? flags.findIndex((g) => g[0] === m[1]) : -1;
        if (i >= 0) { flags = flags.filter((_, k) => k !== i); continue; }
        return { text: '', usage: null, error: cliError(res) };
      }
      const j = extractJson(res.stdout);
      if (!j) return { text: '', usage: null, error: `unexpected output from claude: ${res.stdout.trim().slice(0, 200)}` };
      const u = j.usage || {};
      const usage = { input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), output: num(u.output_tokens) };
      if (j.is_error) return { text: '', usage, error: String(j.result || 'claude reported an error').slice(0, 800) };
      return { text: String(j.result || '').trim(), usage, error: null };
    }
    return { text: '', usage: null, error: 'claude rejected every flag combination' };
  }

  async function completeApi({ model, prompt, timeoutMs, secrets }) {
    const key = await secrets.get(KEY);
    if (!key) return { text: '', usage: null, error: 'No Anthropic API key stored. Run "Prompt Forge: Set an API Key".' };
    const r = await jsonRequest(fetch, `${API}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': VERSION },
      body: { model, max_tokens: 16000, messages: [{ role: 'user', content: prompt }] },
      timeoutMs,
    });
    if (!r.ok) return { text: '', usage: null, error: r.error };
    const j = r.json || {};
    const u = j.usage || {};
    const usage = { input: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens), output: num(u.output_tokens) };
    if (j.stop_reason === 'refusal') {
      const cat = j.stop_details && j.stop_details.category;
      return { text: '', usage, error: `the model refused this request${cat ? ` (${cat})` : ''}` };
    }
    const text = (j.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('');
    return { text, usage, error: null };
  }

  async function listModels(mode, { secrets }) {
    if (mode === 'cli') return catalog.claude.map((m) => ({ ...m }));
    const key = await secrets.get(KEY);
    if (!key) return [];
    const r = await jsonRequest(fetch, `${API}/models?limit=100`, { headers: { 'x-api-key': key, 'anthropic-version': VERSION }, timeoutMs: 20000 });
    if (!r.ok) throw new Error(r.error);
    return ((r.json && r.json.data) || []).map((m) => ({
      id: m.id,
      label: m.display_name || m.id,
      tier: /sonnet/.test(m.id) ? 'fast' : /fable|mythos/.test(m.id) ? 'best' : 'other',
    }));
  }

  function defaults(models) {
    if (!models || !models.length) return {};
    return {
      merge: firstMatching(models, [/sonnet/, /haiku/], models[0]),
      polish: firstMatching(models, [/fable/, /opus/], models[models.length - 1]),
    };
  }

  return {
    id: 'claude', label: 'Claude', modes: ['cli', 'apiKey'],
    installUrl: 'https://code.claude.com/docs/en/overview',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    signIn: { cli: { command: 'claude', args: ['auth', 'login'] } },
    detect, listModels, defaults,
    complete: (req) => (req.mode === 'cli' ? completeCli(req) : completeApi(req)),
  };
}

module.exports = { create, KEY, BARE, BILLING };
