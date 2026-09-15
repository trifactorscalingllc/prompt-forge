'use strict';
// Auto-forge, phase 1 (confirm first): what happens in each Claude Code chat as its hooks report in.
//
//   UserPromptSubmit  count the prompt; at the threshold, show "this looks like a bigger job"
//   Stop              ask the one confirm question, or post the card once the forge has landed
//   PostToolUse       read the confirm answer: forge, not now, or never in this chat
//   /unforge          undo this chat's last forge
//
// Every reply is a plain hook-output object and {} means "carry on". Nothing here touches VS Code:
// the runtime supplies forge/undo and the settings, so the whole flow runs under node --test.
// Each chat's state is one-shot per step, which is what keeps a Stop hook from looping; the
// stop_hook_active flag cannot be used for that, because the card legitimately follows the question
// in the same turn.
const crypto = require('node:crypto');
const detect = require('./detect');
const card = require('./card');

const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

function createAutoForge({
  settings,                 // () => raw settings { mode, minChars, minPrompts }
  engineReady = () => ({ ok: true }),
  inScope = () => true,     // (cwd, entrypoint) => whether this chat is one to watch
  forge,                    // async ({ sessionId, cwd, texts, slug }) => { ok, slug, title, changes, conflicts, error, undo }
  undo,                     // async (undoInfo) => { ok, reason }
  uriFor = () => '',        // (action, forgeId) => vscode:// link
  onEvent = () => {},       // ({ type, ... }) for the panel's notices
  log = { info() {}, warn() {} },
  cardWaitMs = 20000,
  maxSessions = 50,
}) {
  const sessions = new Map();
  let disposed = false;

  function sessionFor(input) {
    const id = String((input && input.session_id) || '');
    if (!id) return null;
    let s = sessions.get(id);
    if (!s) {
      s = { id, cwd: String(input.cwd || ''), prompts: [], phase: 'watching', offer: [], forges: [], warned: false, seq: 0 };
      sessions.set(id, s);
      // Old chats fall off the end; a chat that comes back simply starts counting again.
      if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value);
    }
    return s;
  }

  const cfg = () => detect.settingsFrom(settings() || {});
  const latestForge = (s) => [...s.forges].reverse().find((f) => !f.undone) || null;

  async function onPrompt(s, input) {
    const text = String(input.prompt == null ? '' : input.prompt);
    // A plugin command can arrive namespaced, as /prompt-forge:unforge.
    if (/^\s*\/(?:prompt-forge:)?unforge\b/.test(text)) {
      const r = await undoLatest(s);
      const said = r.ok ? `Prompt Forge: undid the forge of ${r.count} prompt${r.count === 1 ? '' : 's'}. It is in Prompt Forge's trash.` : `Prompt Forge: nothing undone, ${r.reason}.`;
      return { systemMessage: said, ...context('UserPromptSubmit', `Prompt Forge handled /unforge: ${said}`) };
    }
    if (s.phase === 'never' || !detect.isCountable(text)) return {};
    // Asked, but Claude never put the question: treat it as not now rather than waiting forever.
    if (s.phase === 'asked' || s.phase === 'offered') declineOffer(s);
    const length = detect.countedLength(text);
    s.prompts.push({ id: String(input.prompt_id || `p${++s.seq}`), text, length, used: false, ts: Date.now() });
    if (s.prompts.length > 40) s.prompts.splice(0, s.prompts.length - 40);
    const picks = detect.pickOffer(s.prompts, cfg());
    if (!picks) return {};
    const ready = engineReady();
    if (!ready.ok) {
      if (s.warned) return {};
      s.warned = true;
      return { systemMessage: `Prompt Forge could not offer to forge this chat: ${ready.reason || 'no engine is signed in'}.` };
    }
    s.phase = 'offered';
    s.offer = picks.map((p) => p.id);
    onEvent({ type: 'offered', sessionId: s.id, count: picks.length });
    return { systemMessage: `Prompt Forge: this looks like a bigger job (${picks.length} long prompts). Claude will ask whether to forge them.` };
  }

  function declineOffer(s) {
    for (const p of s.prompts) if (s.offer.includes(p.id)) p.used = true;
    s.offer = [];
    s.phase = 'watching';
  }

  async function onStop(s) {
    if (s.phase === 'offered') {
      s.phase = 'asked';
      return context('Stop', card.askInstruction(s.offer.length));
    }
    const f = latestForge(s);
    if (!f || f.cardShown) return {};
    if (!f.result) {
      let timer;
      await Promise.race([f.done, new Promise((r) => { timer = setTimeout(r, cardWaitMs); })]);
      clearTimeout(timer);
      // Still merging: Claude stops now, and the card goes out at the next stop instead.
      if (!f.result || disposed) return {};
    }
    if (f.undone) return {};
    f.cardShown = true;
    const r = f.result;
    const text = r.ok
      ? card.cardText({ title: r.title, count: f.count, update: f.update, changes: r.changes, conflicts: r.conflicts, undoUrl: uriFor('undo', f.id), openUrl: uriFor('open', f.id) })
      : card.failedText({ count: f.count, error: r.error });
    return context('Stop', card.cardInstruction(text));
  }

  function onAsk(s, input) {
    if (s.phase !== 'asked') return {};
    const answer = card.answerFor(input.tool_input);
    if (!answer) return {};
    if (answer === 'never') { declineOffer(s); s.phase = 'never'; onEvent({ type: 'never', sessionId: s.id }); return {}; }
    if (answer === 'later') { declineOffer(s); return {}; }
    startForge(s);
    return context('PostToolUse', card.forgingInstruction());
  }

  function startForge(s) {
    const picked = s.prompts.filter((p) => s.offer.includes(p.id));
    for (const p of picked) p.used = true;
    s.offer = [];
    s.phase = 'watching';
    const previous = latestForge(s);
    const slug = previous && previous.result && previous.result.ok ? previous.result.slug : null;
    const f = { id: crypto.randomBytes(9).toString('hex'), count: picked.length, update: Boolean(slug), result: null, cardShown: false, undone: false };
    f.done = Promise.resolve()
      .then(() => forge({ sessionId: s.id, cwd: s.cwd, texts: picked.map((p) => p.text), slug }))
      .then((r) => r || { ok: false, error: 'no result' }, (e) => ({ ok: false, error: e && e.message ? e.message : String(e) }))
      .then((r) => { f.result = r; onEvent({ type: r.ok ? 'forged' : 'failed', sessionId: s.id, forgeId: f.id, count: f.count, slug: r.slug, title: r.title, error: r.error }); return r; });
    s.forges.push(f);
    onEvent({ type: 'forging', sessionId: s.id, forgeId: f.id, count: f.count });
    return f;
  }

  async function undoForge(s, f) {
    if (!f) return { ok: false, reason: 'this chat has no forge to undo' };
    const r = f.result || await f.done;
    if (f.undone) return { ok: false, reason: 'that forge was already undone' };
    if (!r.ok) return { ok: false, reason: 'that forge had failed, so nothing was changed' };
    const u = await undo(r.undo);
    if (!u || !u.ok) return { ok: false, reason: (u && u.reason) || 'the undo failed' };
    f.undone = true;
    f.cardShown = true;
    onEvent({ type: 'undone', sessionId: s.id, forgeId: f.id, count: f.count, title: r.title });
    return { ok: true, count: f.count, title: r.title };
  }

  const undoLatest = (s) => undoForge(s, latestForge(s));

  return {
    /** One hook event. Never throws: a failure is logged and the chat carries on. */
    async handle(event, input) {
      try {
        if (disposed || cfg().mode === 'off' || !input || typeof input !== 'object') return {};
        if (!inScope(String(input.cwd || ''), input.entrypoint)) return {};
        const s = sessionFor(input);
        if (!s) return {};
        if (event === 'prompt') return await onPrompt(s, input);
        if (event === 'stop') return await onStop(s, input);
        if (event === 'ask') return input.tool_name === 'AskUserQuestion' ? onAsk(s, input) : {};
        return {};
      } catch (e) {
        log.warn(`auto-forge: ${event} failed: ${e.stack || e.message}`);
        return {};
      }
    },
    /** From a card link or the panel. */
    async undoById(forgeId) {
      for (const s of sessions.values()) {
        const f = s.forges.find((x) => x.id === forgeId);
        if (f) return undoForge(s, f);
      }
      return { ok: false, reason: 'that forge is no longer known to this window' };
    },
    forgeById(forgeId) {
      for (const s of sessions.values()) {
        const f = s.forges.find((x) => x.id === forgeId);
        if (f) return { ...f, sessionId: s.id };
      }
      return null;
    },
    state: () => [...sessions.values()].map((s) => ({ id: s.id, phase: s.phase, prompts: s.prompts.length, forges: s.forges.length })),
    dispose() { disposed = true; sessions.clear(); },
  };
}

module.exports = { createAutoForge };
