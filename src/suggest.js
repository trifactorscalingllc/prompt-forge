'use strict';
// A suggestion that asks the person to choose ("Name the formats you accept, e.g. CSV, JSON or XML")
// carries its likely answers as options, drawn as buttons to tick. Adding the ticked ones sends a
// single idea naming the choices and the suggestion they answer, so the merge writes them into
// that section like anything typed.

const MAX_OPTIONS = 6;
const MAX_LEN = 60;

const tidy = (x) => String(typeof x === 'string' ? x : x && typeof x === 'object' ? x.label || x.text || '' : '')
  .replace(/\s+/g, ' ').trim()
  .replace(/^["'“‘]+|["'”’]+$/g, '')
  .replace(/[.;,]+$/, '')
  .trim();

/** Short, distinct strings, in the order given. */
function distinct(list, max = MAX_OPTIONS) {
  const seen = new Set();
  const out = [];
  for (const x of Array.isArray(list) ? list : []) {
    const t = tidy(x);
    if (!t || t.length > MAX_LEN || /^etc$/i.test(t)) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length === max) break;
  }
  return out;
}

/** Options as the engine gave them: 2 to 6 short distinct answers, or none at all. One is not a choice. */
function cleanOptions(list) {
  const out = distinct(list);
  return out.length >= 2 ? out : [];
}

/**
 * Examples written into the advice itself, for a suggestion the engine gave no options: "e.g. A, B
 * or C", "such as A, B, and C", "for example A or B", or a parenthesised list. A clause that splits
 * into long pieces is prose, not a list of choices, and gives none.
 */
function exampleOptions(text) {
  const s = String(text || '');
  const m = /(?:\be\.g\.,?|\bfor example,?|\bsuch as|\bincluding)\s+([^;:!?()]+?)(?:[.;:!?()]|$)/i.exec(s) || /\(([^()]+)\)/.exec(s);
  if (!m) return [];
  const parts = m[1].split(/\s*,\s*|\s+(?:and\/or|or|and)\s+/i).map((p) => p.replace(/^(?:and\/or|or|and)\s+/i, ''));
  if (parts.some((p) => tidy(p).split(/\s+/).length > 5)) return [];
  return cleanOptions(parts);
}

/** The options a suggestion offers: the engine's own, else the examples in its text. */
const optionsFor = (sg) => {
  const own = cleanOptions(sg && sg.options);
  return own.length ? own : exampleOptions(sg && sg.text);
};

/** What the panel sent, kept only where it is one of the options offered, in the order offered. */
function picksFrom(options, picks) {
  const want = new Set((Array.isArray(picks) ? picks : []).map((p) => String(p)));
  return (Array.isArray(options) ? options : []).filter((o) => want.has(o));
}

const joinList = (xs) => (xs.length <= 1 ? (xs[0] || '') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** The idea a set of ticked options becomes. */
function clarificationIdea({ section = '', text = '', picks = [] } = {}) {
  const chosen = distinct(picks, 20);
  const where = String(section || '').trim() || 'Requirements';
  const advice = String(text || '').replace(/\s+/g, ' ').trim();
  return `${where}: ${joinList(chosen)}.${advice ? ` This answers the suggestion "${advice}"` : ''}`;
}

module.exports = { cleanOptions, exampleOptions, optionsFor, picksFrom, clarificationIdea, MAX_OPTIONS };
