'use strict';
// OpenAI: the `codex` CLI (ChatGPT login) or an OpenAI API key.
// The CLI mode is written to the documented `codex exec` contract; see README for its test status.
const { catalog, secretKey, firstMatching, detectCli, readJsonFile, cliError, num, path } = require('./base');
const { jsonRequest } = require('./http');

const KEY = secretKey('openai');
const API = 'https://api.openai.com/v1';
const SKIP = /whisper|tts|embedding|dall-e|realtime|audio|transcribe|image|moderation|search|instruct|babbage|davinci|-\d{4}-\d{2}-\d{2}$/;

function jwtEmail(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return payload.email || payload['https://api.openai.com/profile']?.email || null;
  } catch {
    return null;
  }
}

function create({ runCli, resolveBin, fetch, fs, home }) {
  const bin = (cfg) => resolveBin('codex', { configured: cfg.cli && cfg.cli.codexPath });

  async function detect({ cfg, secrets }) {
    const cli = await detectCli({ name: 'codex', runCli, resolveBin, configured: cfg.cli && cfg.cli.codexPath });
    if (cli.found) {
      const authPath = path.join(home, '.codex', 'auth.json');
      cli.loggedIn = fs.existsSync(authPath);
      if (cli.loggedIn) {
        const auth = readJsonFile(fs, authPath);
        const idToken = auth && auth.tokens && auth.tokens.id_token;
        cli.account = (idToken && jwtEmail(idToken)) || (auth && auth.OPENAI_API_KEY ? 'API key via codex' : null);
      } else {
        cli.note = 'Not signed in. Run `codex login`.';
      }
    }
    return { cli, apiKey: { stored: Boolean(await secrets.get(KEY)) } };
  }

  async function completeCli({ model, system = '', prompt, effort = null, timeoutMs, cfg }) {
    const b = bin(cfg);
    if (!b) return { text: '', usage: null, error: 'codex CLI not found on PATH' };
    const out = (dir) => path.join(dir, 'last-message.md');
    const tune = effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
    const res = await runCli({
      bin: b,
      args: (dir) => ['exec', '--json', '-m', model, ...tune, '-s', 'read-only', '--skip-git-repo-check', '-o', out(dir), '-'],
      stdin: system ? `${system}\n\n${prompt}` : prompt,
      timeoutMs,
      collect: (dir) => fs.readFileSync(out(dir), 'utf8'),
    });
    if (!res.ok) return { text: '', usage: null, error: cliError(res) };
    let text = typeof res.collected === 'string' ? res.collected.trim() : '';
    let usage = null;
    let lastMessage = '';
    for (const line of String(res.stdout || '').split(/\r?\n/)) {
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'item.completed' && ev.item && ev.item.type === 'agent_message' && ev.item.text) lastMessage = String(ev.item.text).trim();
      if (ev.type === 'turn.completed' && ev.usage) usage = { input: num(ev.usage.input_tokens), output: num(ev.usage.output_tokens) };
    }
    // The collected file wins; then the LAST agent message in the event stream.
    if (!text) text = lastMessage;
    if (!text) return { text: '', usage, error: `unexpected output from codex: ${String(res.stdout).trim().slice(0, 200)}` };
    return { text, usage, error: null };
  }

  async function completeApi({ model, system = '', prompt, blocks = [], effort = null, timeoutMs, secrets }) {
    const key = await secrets.get(KEY);
    if (!key) return { text: '', usage: null, error: 'No OpenAI API key stored. Run "Prompt Forge: Set an API Key".' };
    const body = { model };
    body.input = blocks.length
      ? [{
        role: 'user',
        content: [
          ...blocks.map((b) => (b.type === 'image'
            ? { type: 'input_image', image_url: `data:${b.mime};base64,${b.data}` }
            : { type: 'input_file', filename: b.name, file_data: `data:${b.mime};base64,${b.data}` })),
          { type: 'input_text', text: prompt },
        ],
      }]
      : prompt;
    // Instructions first and unchanged between calls: the API caches a stable prefix on its own.
    if (system) body.instructions = system;
    if (effort && /^(gpt-5|o\d)/.test(model)) body.reasoning = { effort };
    const r = await jsonRequest(fetch, `${API}/responses`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body,
      timeoutMs,
    });
    if (!r.ok) return { text: '', usage: null, error: r.error };
    const j = r.json || {};
    const u = j.usage || {};
    const usage = { input: num(u.input_tokens), output: num(u.output_tokens) };
    let text = typeof j.output_text === 'string' ? j.output_text : '';
    if (!text) {
      text = (j.output || []).filter((o) => o && o.type === 'message').flatMap((o) => o.content || [])
        .filter((c) => c && c.type === 'output_text').map((c) => c.text).join('');
    }
    if (!text && j.status && j.status !== 'completed') return { text: '', usage, error: `response ${j.status}${j.incomplete_details ? `: ${j.incomplete_details.reason}` : ''}` };
    return { text, usage, error: null };
  }

  async function listModels(mode, { secrets }) {
    if (mode === 'cli') return catalog.openai.map((m) => ({ ...m }));
    const key = await secrets.get(KEY);
    if (!key) return [];
    const r = await jsonRequest(fetch, `${API}/models`, { headers: { authorization: `Bearer ${key}` }, timeoutMs: 20000 });
    if (!r.ok) throw new Error(r.error);
    return ((r.json && r.json.data) || [])
      .map((m) => String(m.id))
      .filter((id) => /^(gpt-|o\d)/.test(id) && !SKIP.test(id))
      .sort()
      .map((id) => ({ id, label: id, tier: /mini|nano/.test(id) ? 'fast' : /^gpt-5(\.\d+)?$/.test(id) ? 'best' : 'other' }));
  }

  function defaults(models) {
    if (!models || !models.length) return {};
    return {
      merge: firstMatching(models, [/^gpt-5(\.\d+)?-mini$/, /mini/, /nano/], models[0]),
      polish: firstMatching(models, [/^gpt-5(\.\d+)?$/, /^gpt-5/], models[models.length - 1]),
    };
  }

  return {
    id: 'openai', label: 'OpenAI', modes: ['cli', 'apiKey'],
    installUrl: 'https://github.com/openai/codex',
    keyUrl: 'https://platform.openai.com/api-keys',
    signIn: { cli: { command: 'codex', args: ['login'] } },
    detect, listModels, defaults,
    capabilities: (mode) => (mode === 'apiKey' ? { image: true, pdf: true } : { image: false, pdf: false }),
    complete: (req) => (req.mode === 'cli' ? completeCli(req) : completeApi(req)),
  };
}

module.exports = { create, KEY };
