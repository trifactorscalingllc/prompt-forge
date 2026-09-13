'use strict';
// Any OpenAI-compatible endpoint: Ollama, LM Studio, OpenRouter, a company gateway. A base URL is
// required; a key is optional (local servers usually have none).
const { secretKey, pickDefaults, num } = require('./base');
const { jsonRequest } = require('./http');

const KEY = secretKey('compatible');

function create({ fetch }) {
  const base = (cfg) => String((cfg.compatible && cfg.compatible.baseUrl) || '').trim().replace(/\/+$/, '');
  const headers = async (secrets) => {
    const key = await secrets.get(KEY);
    return key ? { authorization: `Bearer ${key}` } : {};
  };

  async function detect({ cfg, secrets }) {
    const url = base(cfg);
    const key = Boolean(await secrets.get(KEY));
    return {
      cli: { found: false, loggedIn: false, path: null, version: null, account: null, plan: null, note: null },
      apiKey: { stored: Boolean(url) },
      note: url ? `${url.replace(/\?.*$/, '')}${key ? ' (key stored)' : ' (no key; fine for local servers)'}` : 'Set promptForge.compatible.baseUrl to use a local or compatible server.',
    };
  }

  async function listModels(mode, { cfg, secrets }) {
    const url = base(cfg);
    if (!url) return [];
    const r = await jsonRequest(fetch, `${url}/models`, { headers: await headers(secrets), timeoutMs: 20000 });
    if (!r.ok) throw new Error(r.error);
    return ((r.json && r.json.data) || []).map((m) => ({ id: String(m.id), label: String(m.id), tier: 'other' }));
  }

  async function complete({ model, system = '', prompt, timeoutMs, cfg, secrets }) {
    const url = base(cfg);
    if (!url) return { text: '', usage: null, error: 'promptForge.compatible.baseUrl is not set' };
    const messages = [{ role: 'user', content: prompt }];
    if (system) messages.unshift({ role: 'system', content: system });
    const r = await jsonRequest(fetch, `${url}/chat/completions`, {
      method: 'POST',
      headers: await headers(secrets),
      body: { model, messages },
      timeoutMs,
    });
    if (!r.ok) return { text: '', usage: null, error: r.error };
    const j = r.json || {};
    const u = j.usage || {};
    const choice = (j.choices || [])[0];
    const content = choice && choice.message && choice.message.content;
    const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => c.text || '').join('') : '';
    return { text, usage: { input: num(u.prompt_tokens), output: num(u.completion_tokens) }, error: null };
  }

  return {
    id: 'compatible', label: 'OpenAI-compatible', modes: ['apiKey'],
    installUrl: null, keyUrl: null, signIn: null,
    // A local server may or may not be serving a vision model, and asking a text model for an image
    // is an error rather than a shrug. Files go by name here.
    detect, listModels, defaults: pickDefaults, complete,
    capabilities: () => ({ image: false, pdf: false }),
  };
}

module.exports = { create, KEY };
