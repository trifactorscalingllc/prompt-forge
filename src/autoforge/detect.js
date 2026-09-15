'use strict';
// Auto-forge detection: which prompts in a Claude Code chat count, how long each one is, and when
// enough long ones have arrived to offer forging. Pure.

const DEFAULTS = { mode: 'off', minChars: 400, minPrompts: 3, window: 8 };

const clamp = (v, lo, hi, fallback) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : fallback);

/** The settings as the controller uses them, whatever was typed into settings.json. */
function settingsFrom(raw = {}) {
  return {
    mode: raw.mode === 'confirm' ? 'confirm' : 'off',
    minChars: clamp(raw.minChars, 100, 5000, DEFAULTS.minChars),
    minPrompts: clamp(raw.minPrompts, 2, 10, DEFAULTS.minPrompts),
    window: DEFAULTS.window,
  };
}

// What Claude Code puts in a prompt that nobody typed: slash-command expansions, hook output, reminders.
const WRAPPER = /^\s*<(command-|local-command|user-prompt-submit-hook|system-reminder|bash-)/;

/**
 * A prompt's length for detection: pasted code, stack traces and @-mentions do not make a prompt
 * "bigger", so they are left out before counting.
 */
function countedLength(text) {
  let t = String(text == null ? '' : text);
  t = t.replace(/```[\s\S]*?(```|$)/g, ' ');
  t = t.split('\n').filter((l) => !/^\s+at\s.+[(:]\d+/.test(l) && !/^\s*File ".+", line \d+/.test(l) && !/^\s*Traceback \(most recent call last\)/.test(l)).join('\n');
  t = t.replace(/(^|\s)@\S+/g, ' ');
  return t.replace(/\s+/g, ' ').trim().length;
}

/** Whether a prompt counts at all: not a slash command, not a wrapper, not an answer to a forge question. */
function isCountable(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t.startsWith('/') || WRAPPER.test(t)) return false;
  return !/^Q\d+\s*[:.)]/i.test(t);
}

/** The long prompts to offer forging, or null: at least minPrompts unused long ones among the last `window` prompts. */
function pickOffer(prompts, settings) {
  const { minChars, minPrompts, window } = settingsFrom(settings && settings.mode ? settings : { ...settings, mode: 'confirm' });
  const recent = (Array.isArray(prompts) ? prompts : []).slice(-window);
  const long = recent.filter((p) => !p.used && p.length >= minChars);
  return long.length >= minPrompts ? long : null;
}

module.exports = { DEFAULTS, settingsFrom, countedLength, isCountable, pickOffer };
