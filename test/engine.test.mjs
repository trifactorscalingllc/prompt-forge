import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { resolveEngine, createEngine } = require('../src/engine/engine.js');

const det = (id, { loggedIn = false, stored = false, found = loggedIn } = {}) => ({
  id, label: id,
  cli: { found, loggedIn, path: found ? `/bin/${id}` : null, version: found ? '1.0' : null, account: loggedIn ? `${id}@x` : null },
  apiKey: { stored },
  models: [{ id: `${id}-fast`, tier: 'fast' }, { id: `${id}-best`, tier: 'best' }],
  defaults: { merge: `${id}-fast`, polish: `${id}-best` },
});
const cfg = (over = {}) => ({ engine: { provider: 'auto', mergeModel: 'auto', polishModel: 'auto', ...over } });

test('auto picks the first CLI login, then the first stored key', () => {
  const a = resolveEngine({ cfg: cfg(), detections: [det('claude', { stored: true }), det('gemini', { loggedIn: true })] });
  assert.deepEqual(a, { ok: true, provider: 'gemini', mode: 'cli', mergeModel: 'gemini-fast', polishModel: 'gemini-best' });
  const b = resolveEngine({ cfg: cfg(), detections: [det('claude'), det('openai', { stored: true })] });
  assert.equal(b.provider, 'openai');
  assert.equal(b.mode, 'apiKey');
});

test('nothing signed in is a clear reason, not a throw', () => {
  const r = resolveEngine({ cfg: cfg(), detections: [det('claude'), det('gemini')] });
  assert.equal(r.ok, false);
  assert.match(r.reason, /sign in/i);
});

test('an explicit provider is honoured; CLI login beats a stored key; neither is a reason', () => {
  const both = resolveEngine({ cfg: cfg({ provider: 'claude' }), detections: [det('claude', { loggedIn: true, stored: true }), det('gemini', { loggedIn: true })] });
  assert.equal(both.provider, 'claude');
  assert.equal(both.mode, 'cli');
  const none = resolveEngine({ cfg: cfg({ provider: 'openai' }), detections: [det('claude', { loggedIn: true }), det('openai')] });
  assert.equal(none.ok, false);
  assert.match(none.reason, /openai/i);
  const unknown = resolveEngine({ cfg: cfg({ provider: 'nope' }), detections: [det('claude', { loggedIn: true })] });
  assert.equal(unknown.ok, false);
});

test('explicit models override the provider defaults', () => {
  const r = resolveEngine({ cfg: cfg({ mergeModel: 'm1', polishModel: 'p1' }), detections: [det('claude', { loggedIn: true })] });
  assert.equal(r.mergeModel, 'm1');
  assert.equal(r.polishModel, 'p1');
});

test('createEngine routes a call to the resolved provider with the role model and records the call meta; the key never leaves the provider', async () => {
  const seen = [];
  const provider = {
    id: 'claude', label: 'Claude', modes: ['cli', 'apiKey'],
    detect: async () => ({ cli: { found: true, loggedIn: true, path: '/bin/claude', version: '1', account: 'me' }, apiKey: { stored: false } }),
    listModels: async () => [{ id: 'sonnet', tier: 'fast' }, { id: 'fable', tier: 'best' }],
    defaults: () => ({ merge: 'sonnet', polish: 'fable' }),
    complete: async (req) => { seen.push(req); return { text: 'OK', usage: { input: 10, output: 2 }, error: null }; },
  };
  const engine = createEngine({ providers: [provider], config: () => cfg(), secrets: { get: async () => undefined }, log: { info() {}, warn() {}, error() {} } });
  await engine.detectAll();
  const sel = engine.selection();
  assert.equal(sel.ok, true);
  const r = await engine.call({ role: 'merge', prompt: 'hi', timeoutMs: 1000 });
  assert.equal(r.text, 'OK');
  assert.equal(r.call.model, 'sonnet');
  assert.equal(r.call.provider, 'claude');
  assert.equal(r.call.mode, 'cli');
  assert.ok(r.call.ms >= 0);
  const p = await engine.call({ role: 'polish', prompt: 'hi', timeoutMs: 1000 });
  assert.equal(p.call.model, 'fable');
  assert.equal(seen[0].prompt, 'hi');
  assert.ok(!('secrets' in r) && !('secrets' in r.call));
});

test('createEngine.call with no engine returns an error, never throws', async () => {
  const engine = createEngine({ providers: [], config: () => cfg(), secrets: { get: async () => undefined }, log: { info() {}, warn() {}, error() {} } });
  await engine.detectAll();
  const r = await engine.call({ role: 'merge', prompt: 'x', timeoutMs: 100 });
  assert.ok(r.error);
  assert.equal(r.text, '');
});

test('createEngine.state summarises providers for the panel without leaking anything but booleans about keys', async () => {
  const provider = {
    id: 'openai', label: 'OpenAI', modes: ['cli', 'apiKey'],
    detect: async () => ({ cli: { found: false, loggedIn: false }, apiKey: { stored: true } }),
    listModels: async () => [{ id: 'gpt-5-mini', tier: 'fast' }, { id: 'gpt-5', tier: 'best' }],
    defaults: () => ({ merge: 'gpt-5-mini', polish: 'gpt-5' }),
    complete: async () => ({ text: '', usage: null, error: 'unused' }),
  };
  const engine = createEngine({ providers: [provider], config: () => cfg(), secrets: { get: async () => 'sk-secret' }, log: { info() {}, warn() {}, error() {} } });
  await engine.detectAll();
  const s = engine.state();
  assert.equal(s.providers[0].apiKey.stored, true);
  assert.ok(!JSON.stringify(s).includes('sk-secret'));
  assert.equal(s.selected.provider, 'openai');
  assert.equal(s.selected.mode, 'apiKey');
});
