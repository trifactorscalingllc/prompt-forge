'use strict';
// Which account runs the engine, and with which model for which role. Providers are interchangeable
// here: this file never names a vendor.

const NO_ENGINE = 'No engine yet. Sign in to Claude, Gemini or OpenAI, or add an API key.';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const modeFor = (d) => (d.cli && d.cli.loggedIn ? 'cli' : d.apiKey && d.apiKey.stored ? 'apiKey' : null);

function resolveEngine({ cfg, detections }) {
  const engine = (cfg && cfg.engine) || {};
  const want = engine.provider || 'auto';
  let d = null;
  let mode = null;
  if (want === 'auto') {
    d = detections.find((x) => x.cli && x.cli.loggedIn);
    if (d) mode = 'cli';
    else {
      d = detections.find((x) => x.apiKey && x.apiKey.stored);
      if (d) mode = 'apiKey';
    }
    if (!d) return { ok: false, reason: NO_ENGINE };
  } else {
    d = detections.find((x) => x.id === want);
    if (!d) return { ok: false, reason: `Unknown engine provider "${want}". Check promptForge.engine.provider.` };
    mode = modeFor(d);
    if (!mode) return { ok: false, reason: `${d.label || want} is selected but not signed in. Sign in to its CLI or add an API key, or set the provider back to auto.` };
  }
  const defaults = d.defaults || {};
  const pick = (v, def) => (v && v !== 'auto' ? v : def);
  const mergeModel = pick(engine.mergeModel, defaults.merge);
  const polishModel = pick(engine.polishModel, defaults.polish);
  if (!mergeModel || !polishModel) {
    return { ok: false, reason: `${d.label || d.id} lists no models. Set promptForge.engine.mergeModel and promptForge.engine.polishModel by hand.` };
  }
  return { ok: true, provider: d.id, mode, mergeModel, polishModel };
}

/**
 * How hard the model thinks, per role. A merge is a structured edit and defaults to low: replaying
 * 33 recorded merges at low against the shipped default cut the mean from 20.6 s to 13.3 s with the
 * same agreement with what the person had accepted (line overlap 0.700 vs 0.704). Polish and runs
 * keep the vendor's default unless the person sets one. null means "send nothing".
 */
function effortFor(role, cfg) {
  const e = (cfg && cfg.engine) || {};
  const v = role === 'merge' ? (e.mergeEffort == null ? 'low' : e.mergeEffort) : role === 'polish' ? e.polishEffort : null;
  return EFFORTS.includes(v) ? v : null;
}

function createEngine({ providers, config, secrets, log }) {
  let detections = [];
  let selection = { ok: false, reason: 'Detecting engines…' };
  let detecting = null;

  async function detectOne(p, cfg) {
    let d;
    try {
      d = await p.detect({ cfg, secrets });
    } catch (e) {
      log.warn(`${p.id}: detect failed: ${e.message}`);
      d = { cli: { found: false, loggedIn: false }, apiKey: { stored: false }, note: e.message };
    }
    const cli = { found: false, loggedIn: false, path: null, version: null, account: null, plan: null, ...(d.cli || {}) };
    const apiKey = { stored: Boolean(d.apiKey && d.apiKey.stored) };
    const mode = cli.loggedIn ? 'cli' : apiKey.stored ? 'apiKey' : null;
    let models = [];
    if (mode) {
      try { models = (await p.listModels(mode, { cfg, secrets })) || []; } catch (e) { log.warn(`${p.id}: listModels failed: ${e.message}`); }
    }
    const defaults = models.length ? p.defaults(models) : {};
    return {
      id: p.id, label: p.label, modes: p.modes || [], cli, apiKey, note: d.note || null,
      models, defaults, installUrl: p.installUrl || null, signIn: p.signIn || null,
    };
  }

  async function detectAll() {
    if (detecting) return detecting;
    detecting = (async () => {
      const cfg = config();
      detections = await Promise.all(providers.map((p) => detectOne(p, cfg)));
      selection = resolveEngine({ cfg, detections });
      return selection;
    })();
    try { return await detecting; } finally { detecting = null; }
  }

  const selected = () => (selection.ok ? providers.find((x) => x.id === selection.provider) || null : null);
  const modelFor = (role) => (role === 'polish' || role === 'run' ? selection.polishModel : selection.mergeModel);

  async function call({ role, system = '', prompt, blocks = [], timeoutMs, onProgress = null }) {
    if (!selection.ok) return { text: '', usage: null, error: selection.reason, call: null };
    const p = providers.find((x) => x.id === selection.provider);
    if (!p) return { text: '', usage: null, error: `provider ${selection.provider} vanished`, call: null };
    // A test run is the prompt itself being answered, so it gets the good model like polish does.
    const model = role === 'polish' || role === 'run' ? selection.polishModel : selection.mergeModel;
    const cfg = config();
    const effort = effortFor(role, cfg);
    const t0 = Date.now();
    let res;
    try {
      res = await p.complete({ mode: selection.mode, model, system, prompt, blocks, effort, timeoutMs, cfg, secrets, onProgress });
    } catch (e) {
      res = { text: '', usage: null, error: e.message };
    }
    const meta = { provider: p.id, mode: selection.mode, model, role, effort, warm: Boolean(res.warm), ms: Date.now() - t0, usage: res.usage || null };
    const u = res.usage ? ` ${res.usage.input || 0}in/${res.usage.output || 0}out${res.usage.cacheRead ? ` (${res.usage.cacheRead} cached)` : ''}` : '';
    log.info(`${p.id}/${selection.mode} ${model} ${role}${effort ? ` effort=${effort}` : ''}${res.warm ? ' warm' : ''}: ${meta.ms}ms${u}${res.error ? ` error: ${res.error}` : ''}`);
    return { text: res.text || '', usage: res.usage || null, error: res.error || null, call: meta };
  }

  /** Start the process the next call of this role will use, where the provider can. Never throws. */
  function warm({ role = 'merge', system = '' } = {}) {
    const p = selected();
    if (!p || typeof p.warm !== 'function') return false;
    try {
      return p.warm({ mode: selection.mode, model: modelFor(role), effort: effortFor(role, config()), system, cfg: config() });
    } catch (e) {
      log.warn(`${p.id}: warm failed: ${e.message}`);
      return false;
    }
  }

  /** What the running provider accepts besides text. */
  function capabilities() {
    const p = selected();
    return p && typeof p.capabilities === 'function' ? p.capabilities(selection.mode) : { image: false, pdf: false };
  }

  function state() {
    return {
      providers: detections.map((d) => ({
        id: d.id, label: d.label, modes: d.modes, cli: d.cli, apiKey: { stored: d.apiKey.stored }, note: d.note,
        models: d.models, defaults: d.defaults, installUrl: d.installUrl, signIn: d.signIn,
      })),
      selected: selection.ok ? { provider: selection.provider, mode: selection.mode, mergeModel: selection.mergeModel, polishModel: selection.polishModel } : null,
      reason: selection.ok ? null : selection.reason,
    };
  }

  function dispose() {
    for (const p of providers) { try { if (typeof p.dispose === 'function') p.dispose(); } catch { /* best effort */ } }
  }

  return { detectAll, refresh: detectAll, call, warm, capabilities, state, dispose, selection: () => selection, detections: () => detections };
}

module.exports = { resolveEngine, createEngine, effortFor, NO_ENGINE, EFFORTS };
