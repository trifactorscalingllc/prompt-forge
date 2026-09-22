'use strict';
// Claude: the `claude` CLI (your Claude subscription) or an Anthropic API key.
//
// The CLI path streams. The prompt goes in as one stream-json message -- so images and PDFs ride as
// real content blocks -- and the reply comes back event by event, which is what lets the panel say
// "thinking" and then "writing Requirements" instead of a pulse for twenty seconds. When a process
// has been started ahead of time (warm), the call skips the CLI's ~6 s boot entirely.
//
// A CLI too old for any of that falls back to the one-shot JSON call this file has always made.
const crypto = require('node:crypto');
const nodePath = require('node:path');
const { catalog, secretKey, firstMatching, detectCli, cliError, extractJson, num, runPruned } = require('./base');
const { jsonRequest } = require('./http');

const KEY = secretKey('claude');
const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
// Billing switches. Their absence IS the subscription path: a stray key in the host environment
// would silently move every merge onto the paid API.
const BILLING = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
// Claude Code's default system prompt is ~8k tokens and is sent (mostly as a cache read) on every
// call. Replacing it with this line was measured at 585 input tokens for a one-word call instead
// of 9,142. Everything the engine must know is in the message itself.
const SYSTEM = 'You are the engine inside Prompt Forge, a tool that builds one prompt from many ideas. Follow the instructions in the message exactly and output only what they ask for.';
// Bare-call flags as groups, so a flag an older CLI rejects can be dropped as a unit.
const BARE = [
  ['--system-prompt', SYSTEM],
  ['--output-format', 'json'],
  ['--setting-sources', ''],
  ['--exclude-dynamic-system-prompt-sections'],
  ['--strict-mcp-config'],
  ['--mcp-config', '{"mcpServers":{}}'],
  ['--tools', 'none'],
];
// A warm process nobody used is a few hundred MB doing nothing. Long enough to cover typing an idea.
const WARM_TTL_MS = 90 * 1000;
const STALE_CLI = /unknown (?:option|argument)|input-format|stream-json|system-prompt-file|include-partial-messages|--verbose/i;

/** The streaming invocation. The system prompt goes in a file: argv is capped on Windows and a style guide is long. */
function streamArgs({ model, effort, system }) {
  return (dir) => {
    const file = nodePath.join(dir, 'system.txt');
    require('node:fs').writeFileSync(file, system || SYSTEM);
    const args = ['-p', '--model', model,
      '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
      '--system-prompt-file', file,
      '--setting-sources', '', '--exclude-dynamic-system-prompt-sections', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', 'none'];
    if (effort) args.push('--effort', effort);
    return args;
  };
}

/** Content blocks for one user turn: files first, then the text, as the vendor recommends. */
function contentBlocks(prompt, blocks = []) {
  const files = blocks.map((b) => (b.type === 'pdf'
    ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b.data }, title: b.name }
    : { type: 'image', source: { type: 'base64', media_type: b.mime, data: b.data } }));
  return [...files, { type: 'text', text: prompt }];
}

/** Fold one stream-json line into the running state. Returns true when progress moved. Pure. */
function readStreamLine(st, line) {
  let ev;
  try { ev = JSON.parse(line); } catch { return false; }
  if (!ev || typeof ev !== 'object') return false;
  if (ev.type === 'stream_event' && ev.event) {
    const e = ev.event;
    if (e.type === 'content_block_start' && e.content_block) {
      const t = e.content_block.type;
      if (t === 'thinking' || t === 'redacted_thinking') { st.phase = 'thinking'; return true; }
      if (t === 'text') { st.phase = 'writing'; return true; }
      return false;
    }
    if (e.type === 'content_block_delta' && e.delta) {
      if (e.delta.type === 'text_delta') {
        st.text += e.delta.text || '';
        st.phase = 'writing';
        // Which section the reply is on, read from the edits as they stream. Cheap, and a guess the
        // panel only ever shows as "writing <name>".
        const all = [...st.text.matchAll(/"section"\s*:\s*"([^"\\]{1,60})"/g)];
        if (all.length) st.section = all[all.length - 1][1];
        return true;
      }
      if (e.delta.type === 'thinking_delta') { st.phase = 'thinking'; return true; }
    }
    return false;
  }
  if (ev.type === 'assistant' && ev.message && Array.isArray(ev.message.content)) {
    const t = ev.message.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('');
    if (t) st.assistantText = t;
    return false;
  }
  if (ev.type === 'result') { st.result = ev; return false; }
  return false;
}

function usageOf(u) {
  const out = {
    input: num(u && u.input_tokens) + num(u && u.cache_creation_input_tokens) + num(u && u.cache_read_input_tokens),
    output: num(u && u.output_tokens),
  };
  // Named only when the cache actually served something, so a miss reads as plainly as it is.
  if (num(u && u.cache_read_input_tokens)) out.cacheRead = num(u.cache_read_input_tokens);
  return out;
}

// Output caps differ by generation; the document comes back inside a JSON string every call.
const maxTokensFor = (model) => (/haiku|claude-3/.test(String(model)) ? 8192 : 16000);
// `output_config.effort` is rejected by Haiku 4.5 and older generations.
const takesEffort = (model) => /(fable|mythos|opus-5|opus-4-[5-9]|sonnet-5|sonnet-4-6)/.test(String(model)) && !/haiku/.test(String(model));
const hash = (s) => crypto.createHash('sha1').update(String(s || '')).digest('hex').slice(0, 12);

function create({ runCli, openCli = null, resolveBin, fetch, fs, home }) {
  const bin = (cfg) => resolveBin('claude', { configured: cfg.cli && cfg.cli.claudePath });
  let warm = null;   // { key, handle, timer }

  function dropWarm() {
    if (!warm) return;
    clearTimeout(warm.timer);
    try { warm.handle.kill(); } catch { /* already gone */ }
    warm = null;
  }

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

  /** The one-shot JSON call, for a CLI that does not stream. Files cannot ride along here. */
  async function completeLegacy({ b, model, system, prompt, effort, timeoutMs }) {
    const groups = effort ? [...BARE, ['--effort', effort]] : BARE;
    const stdin = system ? `${system}\n\n${prompt}` : prompt;
    const res = await runPruned({ runCli, bin: b, head: ['-p', '--model', model], groups, stdin, timeoutMs, scrub: BILLING });
    if (!res.ok) return { text: '', usage: null, error: cliError(res) };
    const j = extractJson(res.stdout);
    if (!j) return { text: '', usage: null, error: `unexpected output from claude: ${res.stdout.trim().slice(0, 200)}` };
    const usage = usageOf(j.usage);
    if (j.is_error) return { text: '', usage, error: String(j.result || 'claude reported an error').slice(0, 800) };
    return { text: String(j.result || '').trim(), usage, error: null };
  }

  function spawnStream({ b, model, effort, system }) {
    return openCli({ bin: b, args: streamArgs({ model, effort, system }), scrub: BILLING });
  }

  async function completeCli({ model, system = '', prompt, blocks = [], effort = null, timeoutMs, cfg, onProgress = null }) {
    const b = bin(cfg);
    if (!b) return { text: '', usage: null, error: 'claude CLI not found on PATH' };
    if (!openCli) return completeLegacy({ b, model, system, prompt, effort, timeoutMs });

    const key = `${b}|${model}|${effort || ''}|${hash(system || SYSTEM)}`;
    let handle = null;
    let warmed = false;
    if (warm && warm.key === key && warm.handle.alive()) {
      handle = warm.handle;
      warmed = true;
      clearTimeout(warm.timer);
      warm = null;
    } else {
      dropWarm();
      handle = spawnStream({ b, model, effort, system });
    }
    const st = { text: '', phase: 'starting', section: null, result: null, assistantText: '' };
    const message = { type: 'user', message: { role: 'user', content: contentBlocks(prompt, blocks) } };
    if (onProgress) { try { onProgress({ phase: warmed ? 'waiting' : 'starting', warm: warmed }); } catch { /* ignore */ } }
    const res = await handle.send(`${JSON.stringify(message)}\n`, {
      timeoutMs,
      onLine: (line) => {
        if (readStreamLine(st, line) && onProgress) {
          try { onProgress({ phase: st.phase, chars: st.text.length, section: st.section, warm: warmed }); } catch { /* ignore */ }
        }
      },
    });
    const r = st.result;
    if (!r) {
      if (!res.ok && STALE_CLI.test(`${res.stderr || ''}\n${res.error || ''}`)) return completeLegacy({ b, model, system, prompt, effort, timeoutMs });
      return { text: '', usage: null, error: res.ok ? 'claude ended without a result' : cliError(res), warm: warmed };
    }
    const usage = usageOf(r.usage);
    if (r.is_error) return { text: '', usage, error: String(r.result || (Array.isArray(r.errors) && r.errors.join('; ')) || 'claude reported an error').slice(0, 800), warm: warmed };
    return { text: String(r.result || st.assistantText || st.text || '').trim(), usage, error: null, warm: warmed };
  }

  async function completeApi({ model, system = '', prompt, blocks = [], effort = null, timeoutMs, secrets }) {
    const key = await secrets.get(KEY);
    if (!key) return { text: '', usage: null, error: 'No Anthropic API key stored. Run "Prompt Forge: Set an API Key".' };
    const body = {
      model,
      max_tokens: maxTokensFor(model),
      messages: [{ role: 'user', content: blocks.length ? contentBlocks(prompt, blocks) : prompt }],
    };
    // The system half never varies between calls of a kind, which is exactly what a cache wants.
    if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (effort && takesEffort(model)) body.output_config = { effort };
    const r = await jsonRequest(fetch, `${API}/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': VERSION },
      body,
      timeoutMs,
    });
    if (!r.ok) return { text: '', usage: null, error: r.error };
    const j = r.json || {};
    const usage = usageOf(j.usage);
    if (j.stop_reason === 'max_tokens') {
      return { text: '', usage, error: `the reply was cut off at ${maxTokensFor(model)} output tokens: the document is too long for ${model}'s output limit. Shorten it or pick a model with a larger output cap.` };
    }
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

  /**
   * Start the process the next call of this shape will use. Idempotent for the same shape; a
   * different shape (another model, effort or system prompt) replaces it.
   */
  function prewarm({ mode, model, effort = null, system = '', cfg }) {
    if (mode !== 'cli' || !openCli) return false;
    const b = bin(cfg);
    if (!b) return false;
    const key = `${b}|${model}|${effort || ''}|${hash(system || SYSTEM)}`;
    if (warm && warm.key === key && warm.handle.alive()) {
      clearTimeout(warm.timer);
      warm.timer = setTimeout(dropWarm, WARM_TTL_MS);
      return true;
    }
    dropWarm();
    warm = { key, handle: spawnStream({ b, model, effort, system }), timer: setTimeout(dropWarm, WARM_TTL_MS) };
    return true;
  }

  return {
    id: 'claude', label: 'Claude', modes: ['cli', 'apiKey'],
    installUrl: 'https://code.claude.com/docs/en/setup',
    installable: true,
    keyUrl: 'https://console.anthropic.com/settings/keys',
    signIn: { cli: { command: 'claude', args: ['auth', 'login'] } },
    detect, listModels, defaults,
    capabilities: (mode) => (mode === 'cli' && !openCli ? { image: false, pdf: false } : { image: true, pdf: true }),
    complete: (req) => (req.mode === 'cli' ? completeCli(req) : completeApi(req)),
    warm: prewarm,
    isWarm: () => Boolean(warm && warm.handle.alive()),
    dispose: dropWarm,
  };
}

module.exports = { create, KEY, BARE, BILLING, SYSTEM, readStreamLine, contentBlocks, streamArgs, takesEffort, WARM_TTL_MS };
