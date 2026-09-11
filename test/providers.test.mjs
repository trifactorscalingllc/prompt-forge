import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const claude = require('../src/providers/claude.js');
const gemini = require('../src/providers/gemini.js');
const openai = require('../src/providers/openai.js');
const compatible = require('../src/providers/compatible.js');
const registry = require('../src/providers/index.js');

// ---- fakes -----------------------------------------------------------------------------------
const ok = (stdout, extra = {}) => ({ ok: true, stdout, stderr: '', code: 0, ms: 1, collected: null, ...extra });
const fail = (stderr, code = 1) => ({ ok: false, stdout: '', stderr, code, ms: 1, error: stderr, collected: null });
const fakeRun = (script) => {
  const calls = [];
  const run = async (req) => { calls.push(req); return script(req, calls.length); };
  run.calls = calls;
  return run;
};
const fakeFetch = (script) => {
  const calls = [];
  const f = async (url, init) => {
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ url, init, body });
    const [status, payload] = script(url, init, body);
    return { ok: status < 300, status, headers: { get: () => 'application/json' }, text: async () => JSON.stringify(payload) };
  };
  f.calls = calls;
  return f;
};
const secretsWith = (map) => ({ get: async (k) => map[k] });
const noSecrets = secretsWith({});
const cfg = (over = {}) => ({ cli: { claudePath: '', geminiPath: '', codexPath: '' }, compatible: { baseUrl: '' }, engine: { timeoutSeconds: 10 }, ...over });
const norm = (p) => String(p).replace(/\\/g, '/');
const fsWith = (present) => ({
  existsSync: (p) => present.includes(norm(p)),
  readFileSync: (p) => (present.includes(norm(p)) ? (present.content || {})[norm(p)] || '' : (() => { throw new Error('ENOENT'); })()),
});

// ---- claude ----------------------------------------------------------------------------------
test('claude.detect: version + auth status from the CLI; a stored key is reported as a boolean only', async () => {
  const run = fakeRun((req) => (req.args[0] === '--version'
    ? ok('2.1.251 (Claude Code)\n')
    : ok(JSON.stringify({ loggedIn: true, email: 'me@x', subscriptionType: 'max' }))));
  const p = claude.create({ runCli: run, resolveBin: () => '/bin/claude', fetch: null, fs: fsWith([]), home: '/h' });
  const d = await p.detect({ cfg: cfg(), secrets: secretsWith({ 'promptForge.apiKey.claude': 'sk-secret' }) });
  assert.equal(d.cli.found, true);
  assert.equal(d.cli.path, '/bin/claude');
  assert.equal(d.cli.version, '2.1.251');
  assert.equal(d.cli.loggedIn, true);
  assert.equal(d.cli.account, 'me@x');
  assert.equal(d.cli.plan, 'max');
  assert.deepEqual(d.apiKey, { stored: true });
  assert.ok(!JSON.stringify(d).includes('sk-secret'));
});

test('claude.detect: no binary means found false and loggedIn false, with an install hint', async () => {
  const p = claude.create({ runCli: fakeRun(() => fail('never called')), resolveBin: () => null, fetch: null, fs: fsWith([]), home: '/h' });
  const d = await p.detect({ cfg: cfg(), secrets: noSecrets });
  assert.equal(d.cli.found, false);
  assert.equal(d.cli.loggedIn, false);
  assert.ok(p.installUrl.startsWith('https://'));
  assert.deepEqual(p.signIn.cli, { command: 'claude', args: ['auth', 'login'] });
});

test('claude.complete cli: prompt on stdin, no tools, JSON out, model flag, subscription billing vars scrubbed', async () => {
  const run = fakeRun(() => ok(JSON.stringify({ result: 'merged', usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 }, is_error: false })));
  const p = claude.create({ runCli: run, resolveBin: () => '/bin/claude', fetch: null, fs: fsWith([]), home: '/h' });
  const r = await p.complete({ mode: 'cli', model: 'sonnet', prompt: 'THE PROMPT', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.equal(r.error, null);
  assert.equal(r.text, 'merged');
  assert.deepEqual(r.usage, { input: 105, output: 20 });
  const call = run.calls[0];
  assert.equal(call.bin, '/bin/claude');
  assert.equal(call.stdin, 'THE PROMPT');
  assert.ok(!call.args.includes('THE PROMPT'));
  assert.ok(call.args.includes('-p'));
  const pair = (k) => call.args[call.args.indexOf(k) + 1];
  assert.equal(pair('--model'), 'sonnet');
  assert.equal(pair('--tools'), 'none');
  assert.equal(pair('--output-format'), 'json');
  assert.deepEqual(call.scrub, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);
});

test('claude.complete cli: an is_error payload and a non-JSON stdout both become errors', async () => {
  const p1 = claude.create({ runCli: fakeRun(() => ok(JSON.stringify({ result: 'rate limited', is_error: true }))), resolveBin: () => '/bin/claude', fetch: null, fs: fsWith([]), home: '/h' });
  const r1 = await p1.complete({ mode: 'cli', model: 'sonnet', prompt: 'x', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.match(r1.error, /rate limited/);
  const p2 = claude.create({ runCli: fakeRun(() => fail('Not logged in', 1)), resolveBin: () => '/bin/claude', fetch: null, fs: fsWith([]), home: '/h' });
  const r2 = await p2.complete({ mode: 'cli', model: 'sonnet', prompt: 'x', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.match(r2.error, /Not logged in/);
  assert.equal(r2.text, '');
});

test('claude.complete cli: a flag an older CLI rejects is dropped and the call retried once', async () => {
  const run = fakeRun((req, n) => (n === 1
    ? fail("error: unknown option '--strict-mcp-config'")
    : ok(JSON.stringify({ result: 'fine', usage: { input_tokens: 1, output_tokens: 1 } }))));
  const p = claude.create({ runCli: run, resolveBin: () => '/bin/claude', fetch: null, fs: fsWith([]), home: '/h' });
  const r = await p.complete({ mode: 'cli', model: 'sonnet', prompt: 'x', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.equal(r.text, 'fine');
  assert.equal(run.calls.length, 2);
  assert.ok(run.calls[0].args.includes('--strict-mcp-config'));
  assert.ok(!run.calls[1].args.includes('--strict-mcp-config'));
});

test('claude.complete apiKey: posts to /v1/messages with the key, joins text blocks, maps usage', async () => {
  const f = fakeFetch(() => [200, { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }], usage: { input_tokens: 5, output_tokens: 2 }, stop_reason: 'end_turn' }]);
  const p = claude.create({ runCli: null, resolveBin: () => null, fetch: f, fs: fsWith([]), home: '/h' });
  const r = await p.complete({ mode: 'apiKey', model: 'claude-sonnet-5', prompt: 'P', timeoutMs: 5000, cfg: cfg(), secrets: secretsWith({ 'promptForge.apiKey.claude': 'sk-test' }) });
  assert.equal(r.text, 'AB');
  assert.deepEqual(r.usage, { input: 5, output: 2 });
  const c = f.calls[0];
  assert.equal(c.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(c.init.headers['x-api-key'], 'sk-test');
  assert.ok(c.init.headers['anthropic-version']);
  assert.equal(c.body.model, 'claude-sonnet-5');
  assert.deepEqual(c.body.messages, [{ role: 'user', content: 'P' }]);
  assert.ok(c.body.max_tokens >= 8000);
});

test('claude.complete apiKey: refusal, http errors and a missing key are errors', async () => {
  const refuse = claude.create({ runCli: null, resolveBin: () => null, fetch: fakeFetch(() => [200, { content: [], stop_reason: 'refusal', stop_details: { category: 'x' } }]), fs: fsWith([]), home: '/h' });
  const r1 = await refuse.complete({ mode: 'apiKey', model: 'm', prompt: 'P', timeoutMs: 5000, cfg: cfg(), secrets: secretsWith({ 'promptForge.apiKey.claude': 'k' }) });
  assert.match(r1.error, /refus/i);
  const denied = claude.create({ runCli: null, resolveBin: () => null, fetch: fakeFetch(() => [401, { type: 'error', error: { message: 'invalid x-api-key' } }]), fs: fsWith([]), home: '/h' });
  const r2 = await denied.complete({ mode: 'apiKey', model: 'm', prompt: 'P', timeoutMs: 5000, cfg: cfg(), secrets: secretsWith({ 'promptForge.apiKey.claude': 'k' }) });
  assert.match(r2.error, /401/);
  assert.match(r2.error, /invalid x-api-key/);
  const nokey = await denied.complete({ mode: 'apiKey', model: 'm', prompt: 'P', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.match(nokey.error, /API key/i);
});

test('claude.listModels: apiKey lists /v1/models with tiers and defaults; cli uses the catalog', async () => {
  const f = fakeFetch(() => [200, { data: [{ id: 'claude-fable-5-1', display_name: 'Claude Fable 5.1' }, { id: 'claude-opus-5', display_name: 'Claude Opus 5' }, { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' }, { id: 'claude-haiku-4-5', display_name: 'Claude Haiku 4.5' }] }]);
  const p = claude.create({ runCli: null, resolveBin: () => null, fetch: f, fs: fsWith([]), home: '/h' });
  const models = await p.listModels('apiKey', { cfg: cfg(), secrets: secretsWith({ 'promptForge.apiKey.claude': 'k' }) });
  assert.deepEqual(models.map((m) => m.id), ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
  assert.equal(f.calls[0].init.headers['x-api-key'], 'k');
  assert.deepEqual(p.defaults(models), { merge: 'claude-sonnet-5', polish: 'claude-fable-5-1' });
  const cli = await p.listModels('cli', { cfg: cfg(), secrets: noSecrets });
  assert.ok(cli.some((m) => m.id === 'sonnet') && cli.some((m) => m.id === 'fable'));
  assert.deepEqual(p.defaults(cli), { merge: 'sonnet', polish: 'fable' });
});

// ---- gemini ----------------------------------------------------------------------------------
test('gemini.detect: version from the CLI, login from the oauth file, account from google_accounts.json', async () => {
  const fs = fsWith(Object.assign(['/h/.gemini/oauth_creds.json', '/h/.gemini/google_accounts.json'], { content: { '/h/.gemini/google_accounts.json': '{"active":"me@g","old":[]}' } }));
  const p = gemini.create({ runCli: fakeRun(() => ok('0.49.0\n')), resolveBin: () => '/bin/gemini', fetch: null, fs, home: '/h' });
  const d = await p.detect({ cfg: cfg(), secrets: noSecrets });
  assert.equal(d.cli.found, true);
  assert.equal(d.cli.version, '0.49.0');
  assert.equal(d.cli.loggedIn, true);
  assert.equal(d.cli.account, 'me@g');
  assert.equal(d.apiKey.stored, false);
  assert.deepEqual(p.signIn.cli, { command: 'gemini', args: [] });
});

test('gemini.complete cli: prompt on stdin with a short -p pointer, JSON output, model flag; parses response and stats', async () => {
  const run = fakeRun(() => ok(JSON.stringify({ response: 'OK', stats: { models: { 'gemini-2.5-flash': { tokens: { prompt: 12, candidates: 3 } } } } })));
  const p = gemini.create({ runCli: run, resolveBin: () => '/bin/gemini', fetch: null, fs: fsWith([]), home: '/h' });
  const r = await p.complete({ mode: 'cli', model: 'gemini-2.5-flash', prompt: 'THE PROMPT', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.equal(r.error, null);
  assert.equal(r.text, 'OK');
  assert.deepEqual(r.usage, { input: 12, output: 3 });
  const c = run.calls[0];
  assert.equal(c.stdin, 'THE PROMPT');
  const pair = (k) => c.args[c.args.indexOf(k) + 1];
  assert.equal(pair('-m'), 'gemini-2.5-flash');
  assert.equal(pair('-o'), 'json');
  assert.ok(c.args.includes('-p') && !c.args.includes('THE PROMPT'));
});

test('gemini apiKey: lists generateContent models with the key header; completes via generateContent', async () => {
  const f = fakeFetch((url) => (url.includes(':generateContent')
    ? [200, { candidates: [{ content: { parts: [{ text: 'Hi ' }, { text: 'there' }] } }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2 } }]
    : [200, { models: [
      { name: 'models/gemini-2.5-pro', displayName: 'Gemini 2.5 Pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/embedding-001', displayName: 'Embedding', supportedGenerationMethods: ['embedContent'] },
    ] }]));
  const p = gemini.create({ runCli: null, resolveBin: () => null, fetch: f, fs: fsWith([]), home: '/h' });
  const secrets = secretsWith({ 'promptForge.apiKey.gemini': 'g-key' });
  const models = await p.listModels('apiKey', { cfg: cfg(), secrets });
  assert.deepEqual(models.map((m) => m.id), ['gemini-2.5-pro', 'gemini-2.5-flash']);
  assert.deepEqual(p.defaults(models), { merge: 'gemini-2.5-flash', polish: 'gemini-2.5-pro' });
  assert.equal(f.calls[0].init.headers['x-goog-api-key'], 'g-key');
  assert.ok(!f.calls[0].url.includes('g-key'), 'the key never rides the URL');
  const r = await p.complete({ mode: 'apiKey', model: 'gemini-2.5-flash', prompt: 'P', timeoutMs: 5000, cfg: cfg(), secrets });
  assert.equal(r.text, 'Hi there');
  assert.deepEqual(r.usage, { input: 7, output: 2 });
  assert.ok(f.calls[1].url.endsWith('/models/gemini-2.5-flash:generateContent'));
  assert.deepEqual(f.calls[1].body.contents, [{ role: 'user', parts: [{ text: 'P' }] }]);
});

// ---- openai ----------------------------------------------------------------------------------
test('openai.detect: codex version and auth file; sign-in is codex login', async () => {
  const p = openai.create({ runCli: fakeRun(() => ok('codex-cli 0.40.0\n')), resolveBin: () => '/bin/codex', fetch: null, fs: fsWith(['/h/.codex/auth.json']), home: '/h' });
  const d = await p.detect({ cfg: cfg(), secrets: noSecrets });
  assert.equal(d.cli.found, true);
  assert.equal(d.cli.version, '0.40.0');
  assert.equal(d.cli.loggedIn, true);
  assert.deepEqual(p.signIn.cli, { command: 'codex', args: ['login'] });
});

test('openai.complete cli: codex exec with stdin prompt, read-only sandbox, last message collected from the temp cwd', async () => {
  const run = fakeRun((req) => { const argv = req.args('/tmpdir'); assert.ok(argv.some((a) => a.endsWith('last-message.md'))); return ok('{"type":"turn.completed","usage":{"input_tokens":9,"output_tokens":4}}\n', { collected: 'FINAL' }); });
  const p = openai.create({ runCli: run, resolveBin: () => '/bin/codex', fetch: null, fs: fsWith([]), home: '/h' });
  const r = await p.complete({ mode: 'cli', model: 'gpt-5', prompt: 'THE PROMPT', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.equal(r.text, 'FINAL');
  assert.deepEqual(r.usage, { input: 9, output: 4 });
  const c = run.calls[0];
  assert.equal(c.stdin, 'THE PROMPT');
  const argv = c.args('/tmpdir');
  assert.equal(argv[0], 'exec');
  assert.ok(argv.includes('--skip-git-repo-check'));
  assert.equal(argv[argv.indexOf('-m') + 1], 'gpt-5');
  assert.equal(argv[argv.indexOf('-s') + 1], 'read-only');
  assert.equal(argv[argv.length - 1], '-');
});

test('openai.complete cli: without a collected file the last agent_message in the JSONL is the answer', async () => {
  const jsonl = [
    '{"type":"item.completed","item":{"type":"reasoning","text":"..."}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"type":"agent_message","text":"LAST"}}',
    '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}',
  ].join('\n');
  const p = openai.create({ runCli: fakeRun(() => ok(jsonl)), resolveBin: () => '/bin/codex', fetch: null, fs: fsWith([]), home: '/h' });
  const r = await p.complete({ mode: 'cli', model: 'gpt-5', prompt: 'x', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.equal(r.text, 'LAST');
});

test('openai apiKey: lists chat-capable models with Bearer auth; completes via /v1/responses', async () => {
  const f = fakeFetch((url) => (url.endsWith('/v1/responses')
    ? [200, { output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: 'Yes' }] }], usage: { input_tokens: 3, output_tokens: 1 } }]
    : [200, { data: [{ id: 'gpt-5' }, { id: 'gpt-5-mini' }, { id: 'whisper-1' }, { id: 'text-embedding-3-small' }, { id: 'gpt-4o' }] }]));
  const p = openai.create({ runCli: null, resolveBin: () => null, fetch: f, fs: fsWith([]), home: '/h' });
  const secrets = secretsWith({ 'promptForge.apiKey.openai': 'sk-o' });
  const models = await p.listModels('apiKey', { cfg: cfg(), secrets });
  assert.deepEqual(models.map((m) => m.id).sort(), ['gpt-4o', 'gpt-5', 'gpt-5-mini']);
  assert.deepEqual(p.defaults(models), { merge: 'gpt-5-mini', polish: 'gpt-5' });
  assert.equal(f.calls[0].init.headers.authorization, 'Bearer sk-o');
  const r = await p.complete({ mode: 'apiKey', model: 'gpt-5', prompt: 'P', timeoutMs: 5000, cfg: cfg(), secrets });
  assert.equal(r.text, 'Yes');
  assert.deepEqual(r.usage, { input: 3, output: 1 });
  assert.equal(f.calls[1].body.model, 'gpt-5');
  assert.equal(f.calls[1].body.input, 'P');
});

// ---- compatible ------------------------------------------------------------------------------
test('compatible: needs a base URL; lists /models and completes via /chat/completions, with or without a key', async () => {
  const f = fakeFetch((url) => (url.endsWith('/chat/completions')
    ? [200, { choices: [{ message: { content: 'local answer' } }], usage: { prompt_tokens: 8, completion_tokens: 3 } }]
    : [200, { data: [{ id: 'llama3' }, { id: 'qwen' }] }]));
  const p = compatible.create({ runCli: null, resolveBin: () => null, fetch: f, fs: fsWith([]), home: '/h' });
  const off = await p.detect({ cfg: cfg(), secrets: noSecrets });
  assert.equal(off.apiKey.stored, false);
  const c = cfg({ compatible: { baseUrl: 'http://localhost:11434/v1/' } });
  const on = await p.detect({ cfg: c, secrets: noSecrets });
  assert.equal(on.apiKey.stored, true);
  assert.equal(on.cli.found, false);
  const models = await p.listModels('apiKey', { cfg: c, secrets: noSecrets });
  assert.deepEqual(models.map((m) => m.id), ['llama3', 'qwen']);
  assert.deepEqual(p.defaults(models), { merge: 'llama3', polish: 'qwen' });
  assert.equal(f.calls[0].url, 'http://localhost:11434/v1/models');
  assert.ok(!('authorization' in f.calls[0].init.headers));
  const r = await p.complete({ mode: 'apiKey', model: 'qwen', prompt: 'P', timeoutMs: 5000, cfg: c, secrets: secretsWith({ 'promptForge.apiKey.compatible': 'k2' }) });
  assert.equal(r.text, 'local answer');
  assert.deepEqual(r.usage, { input: 8, output: 3 });
  assert.equal(f.calls[1].init.headers.authorization, 'Bearer k2');
  assert.deepEqual(f.calls[1].body.messages, [{ role: 'user', content: 'P' }]);
});

// ---- registry --------------------------------------------------------------------------------
test('the registry builds all four providers in a stable order with the shared deps', () => {
  const list = registry.createProviders({ runCli: null, resolveBin: () => null, fetch: null, fs: fsWith([]), home: '/h' });
  assert.deepEqual(list.map((p) => p.id), ['claude', 'gemini', 'openai', 'compatible']);
  for (const p of list) {
    assert.equal(typeof p.detect, 'function');
    assert.equal(typeof p.listModels, 'function');
    assert.equal(typeof p.complete, 'function');
    assert.equal(typeof p.defaults, 'function');
    assert.equal(registry.secretKey(p.id), `promptForge.apiKey.${p.id}`);
  }
});

test('gemini.complete cli: runs in read-only plan mode, and drops the flag if an older CLI rejects it', async () => {
  const run = fakeRun((req, n) => (n === 1 && req.args.includes('--approval-mode')
    ? fail('Unknown argument: approval-mode')
    : ok(JSON.stringify({ response: 'OK', stats: {} }))));
  const p = gemini.create({ runCli: run, resolveBin: () => '/bin/gemini', fetch: null, fs: fsWith([]), home: '/h' });
  const r = await p.complete({ mode: 'cli', model: 'gemini-2.5-flash', prompt: 'x', timeoutMs: 5000, cfg: cfg(), secrets: noSecrets });
  assert.equal(r.text, 'OK');
  assert.equal(run.calls.length, 2);
  assert.equal(run.calls[0].args[run.calls[0].args.indexOf('--approval-mode') + 1], 'plan');
  assert.ok(!run.calls[1].args.includes('--approval-mode'));
});

test('claude apiKey: a reply cut off at max_tokens is a clear error, and the cap follows the model', async () => {
  const f = fakeFetch(() => [200, { content: [{ type: 'text', text: '{"doc": "# cut' }], usage: { input_tokens: 1, output_tokens: 16000 }, stop_reason: 'max_tokens' }]);
  const p = claude.create({ runCli: null, resolveBin: () => null, fetch: f, fs: fsWith([]), home: '/h' });
  const secrets = secretsWith({ 'promptForge.apiKey.claude': 'k' });
  const r = await p.complete({ mode: 'apiKey', model: 'claude-sonnet-5', prompt: 'P', timeoutMs: 5000, cfg: cfg(), secrets });
  assert.match(r.error, /cut off/i);
  assert.equal(f.calls[0].body.max_tokens, 16000);
  await p.complete({ mode: 'apiKey', model: 'claude-haiku-4-5', prompt: 'P', timeoutMs: 5000, cfg: cfg(), secrets });
  assert.equal(f.calls[1].body.max_tokens, 8192);
});

test('compatible.detect never echoes a query string from the base URL', async () => {
  const p = compatible.create({ runCli: null, resolveBin: () => null, fetch: null, fs: fsWith([]), home: '/h' });
  const d = await p.detect({ cfg: cfg({ compatible: { baseUrl: 'https://gw.example/v1?api-key=SECRET' } }), secrets: noSecrets });
  assert.ok(!JSON.stringify(d).includes('SECRET'));
});
