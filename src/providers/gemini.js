'use strict';
// Gemini: the `gemini` CLI (Google login) or a Google AI Studio API key.
const { catalog, secretKey, firstMatching, detectCli, readJsonFile, cliError, extractJson, num, path, runPruned } = require('./base');
const { jsonRequest } = require('./http');

const KEY = secretKey('gemini');
const API = 'https://generativelanguage.googleapis.com/v1beta';
// The prompt itself goes on stdin (no argv limits); -p is required for headless mode and the CLI
// appends it after stdin, so it is a pointer back up, nothing more.
const POINTER = 'Follow the instructions above exactly and produce the output they specify.';
// The CLI is a tool-capable agent that loads the user's own settings, hooks and MCP servers; the
// document it is handed is user-pasted text. Plan mode makes it read-only. Dropped on a CLI too
// old to know the flag.
const SAFE = [['--approval-mode', 'plan']];

/** Low effort, in each generation's own terms. Unknown models get nothing rather than a 400. */
function thinkingFor(model, effort) {
  if (effort !== 'low') return null;
  const id = String(model);
  if (/gemini-3/.test(id)) return { thinkingLevel: 'low' };
  if (/2\.5-flash/.test(id)) return { thinkingBudget: 0 };
  if (/2\.5-pro/.test(id)) return { thinkingBudget: 128 };   // the smallest budget Pro accepts
  return null;
}

function create({ runCli, resolveBin, fetch, fs, home, env = process.env }) {
  const bin = (cfg) => resolveBin('gemini', { configured: cfg.cli && cfg.cli.geminiPath });
  const dot = (f) => path.join(home, '.gemini', f);

  async function detect({ cfg, secrets }) {
    const cli = await detectCli({ name: 'gemini', runCli, resolveBin, configured: cfg.cli && cfg.cli.geminiPath });
    if (cli.found) {
      const settings = readJsonFile(fs, dot('settings.json')) || {};
      const authType = (settings.security && settings.security.auth && settings.security.auth.selectedType) || settings.selectedAuthType || null;
      if (authType === 'gemini-api-key' || authType === 'vertex-ai') {
        cli.loggedIn = Boolean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY);
        cli.note = cli.loggedIn ? 'gemini CLI is using the API key from your environment.' : 'gemini CLI is set to API-key auth but GEMINI_API_KEY is not set. Run `gemini` and pick "Login with Google", or store a key here.';
      } else {
        cli.loggedIn = fs.existsSync(dot('oauth_creds.json'));
        if (!cli.loggedIn) cli.note = 'Not signed in. Run `gemini` once and log in with Google.';
      }
      const accounts = readJsonFile(fs, dot('google_accounts.json'));
      if (cli.loggedIn && accounts && accounts.active) cli.account = accounts.active;
    }
    return { cli, apiKey: { stored: Boolean(await secrets.get(KEY)) } };
  }

  async function completeCli({ model, system = '', prompt, timeoutMs, cfg }) {
    const b = bin(cfg);
    if (!b) return { text: '', usage: null, error: 'gemini CLI not found on PATH' };
    const stdin = system ? `${system}\n\n${prompt}` : prompt;
    const res = await runPruned({ runCli, bin: b, head: ['-p', POINTER, '-o', 'json', '-m', model], groups: SAFE, stdin, timeoutMs, scrub: [] });
    if (!res.ok) return { text: '', usage: null, error: cliError(res) };
    const j = extractJson(res.stdout);
    if (!j || typeof j.response !== 'string') return { text: '', usage: null, error: `unexpected output from gemini: ${res.stdout.trim().slice(0, 200)}` };
    let input = 0;
    let output = 0;
    const models = (j.stats && j.stats.models) || {};
    for (const m of Object.values(models)) {
      const t = (m && m.tokens) || {};
      input += num(t.prompt) + num(t.input);
      output += num(t.candidates) + num(t.output);
    }
    return { text: j.response.trim(), usage: { input, output }, error: null };
  }

  async function completeApi({ model, system = '', prompt, blocks = [], effort = null, timeoutMs, secrets }) {
    const key = await secrets.get(KEY);
    if (!key) return { text: '', usage: null, error: 'No Gemini API key stored. Run "Prompt Forge: Set an API Key".' };
    const body = {
      contents: [{ role: 'user', parts: [...blocks.map((b) => ({ inlineData: { mimeType: b.mime, data: b.data } })), { text: prompt }] }],
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const thinking = thinkingFor(model, effort);
    if (thinking) body.generationConfig = { thinkingConfig: thinking };
    const r = await jsonRequest(fetch, `${API}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': key },
      body,
      timeoutMs,
    });
    if (!r.ok) return { text: '', usage: null, error: r.error };
    const j = r.json || {};
    const u = j.usageMetadata || {};
    const usage = { input: num(u.promptTokenCount), output: num(u.candidatesTokenCount) + num(u.thoughtsTokenCount) };
    const cand = (j.candidates || [])[0];
    if (!cand) return { text: '', usage, error: j.promptFeedback && j.promptFeedback.blockReason ? `blocked: ${j.promptFeedback.blockReason}` : 'no candidates returned' };
    if (cand.finishReason && !['STOP', 'MAX_TOKENS'].includes(cand.finishReason)) return { text: '', usage, error: `finished with ${cand.finishReason}` };
    const text = ((cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    return { text, usage, error: null };
  }

  async function listModels(mode, { secrets }) {
    if (mode === 'cli') return catalog.gemini.map((m) => ({ ...m }));
    const key = await secrets.get(KEY);
    if (!key) return [];
    const r = await jsonRequest(fetch, `${API}/models?pageSize=100`, { headers: { 'x-goog-api-key': key }, timeoutMs: 20000 });
    if (!r.ok) throw new Error(r.error);
    return ((r.json && r.json.models) || [])
      .filter((m) => String(m.name || '').startsWith('models/gemini') && (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => {
        const id = String(m.name).slice('models/'.length);
        return { id, label: m.displayName || id, tier: /flash/.test(id) ? 'fast' : /pro/.test(id) ? 'best' : 'other' };
      });
  }

  function defaults(models) {
    if (!models || !models.length) return {};
    return {
      merge: firstMatching(models, [/flash(?!-lite)/, /flash/], models[0]),
      polish: firstMatching(models, [/pro/], models[models.length - 1]),
    };
  }

  return {
    id: 'gemini', label: 'Gemini', modes: ['cli', 'apiKey'],
    installUrl: 'https://github.com/google-gemini/gemini-cli',
    keyUrl: 'https://aistudio.google.com/apikey',
    signIn: { cli: { command: 'gemini', args: [] } },
    detect, listModels, defaults,
    capabilities: (mode) => (mode === 'apiKey' ? { image: true, pdf: true } : { image: false, pdf: false }),
    complete: (req) => (req.mode === 'cli' ? completeCli(req) : completeApi(req)),
  };
}

module.exports = { create, KEY, POINTER, thinkingFor };
