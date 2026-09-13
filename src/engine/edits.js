'use strict';
// Applying an engine's edits to the document.
//
// The engine names the sections it changed and sends only their new text; every section it did not
// name is carried over from the document as it stands. That is what makes a merge cost the change
// rather than the whole prompt -- and it is a stronger guarantee than the old "keep hand edits" rule
// ever was, because an unnamed section cannot drift: the model never re-typed it.
//
// Refusal is part of the contract. An edit that cannot be placed without guessing (two sections with
// the same name, an op nobody defined) fails the whole reply, and the caller asks again for a full
// document rather than landing a half-applied change.
const { SECTIONS } = require('../doc');
const S = require('./sections');

const OPS = new Set(['replace', 'append', 'create', 'delete']);
const PREAMBLE = /^\(?\s*(preamble|opening|intro|introduction)\s*\)?$/i;

function textLines(text) {
  const s = String(text == null ? '' : text).replace(/\r\n?/g, '\n');
  return S.trimBlank(s.split('\n'));
}

/** The edit's text without the heading or tags the model was told not to repeat, but sometimes does. */
function clean(text, name) {
  let ls = textLines(text);
  if (!ls.length) return ls;
  const first = ls[0].trim();
  const h = S.HEADING.exec(first);
  const o = S.OPEN.exec(first);
  if ((h && S.sameSection(h[2], name)) || (o && S.sameSection(o[1], name))) ls = ls.slice(1);
  const last = ls.length ? S.CLOSE.exec(ls[ls.length - 1].trim()) : null;
  if (last && S.sameSection(last[1], name)) ls = ls.slice(0, -1);
  return S.trimBlank(ls);
}

/** A new section in the document's own shape: a tag in a tagged document, a heading otherwise. */
function newSection(name, st) {
  if (st.style === 'xml') {
    const tag = S.tagOf(name);
    return { kind: 'xml', name: tag, level: null, heading: `<${tag}>`, body: [], close: `</${tag}>` };
  }
  const level = st.level || 2;
  const label = S.canonicalOf(name) && S.squash(name) !== 'task' ? S.canonicalOf(name) : S.labelOf(name);
  return { kind: 'md', name: label, level, heading: `${'#'.repeat(level)} ${label}`, body: [], close: null };
}

/** Where a new section goes: the standard order, and an unknown kind of section before Open questions. */
function insertIndex(sections, name) {
  const known = S.orderOf(name);
  const rank = known >= 0 ? known : SECTIONS.indexOf('Open questions') - 0.5;
  for (let k = 0; k < sections.length; k += 1) {
    const o = S.orderOf(sections[k].name);
    if (sections[k].kind !== 'loose' && o >= 0 && o > rank) return k;
  }
  return sections.length;
}

function appendLines(body, lines) {
  const have = S.trimBlank(body);
  if (!have.length) return lines;
  // A bullet added to a list joins the list; anything else is its own paragraph.
  const tight = S.ITEM.test(have[have.length - 1]) && S.ITEM.test(lines[0]);
  return [...have, ...(tight ? [] : ['']), ...lines];
}

/**
 * { ok, doc, applied } or { ok: false, error }.
 * edits: [{ section, op: 'replace'|'append'|'create'|'delete', text }]
 */
function applyEdits(doc, edits) {
  if (!Array.isArray(edits)) return { ok: false, error: 'engine returned edits that are not a list' };
  const st = S.parse(doc);
  const applied = [];
  for (const raw of edits) {
    if (!raw || typeof raw !== 'object') continue;
    const op = String(raw.op || 'replace').trim().toLowerCase();
    const name = String(raw.section == null ? '' : raw.section).trim();
    if (!OPS.has(op)) return { ok: false, error: `engine returned an edit with an unknown op "${op}"` };
    if (!name) return { ok: false, error: 'engine returned an edit that names no section' };

    if (PREAMBLE.test(name)) {
      const lines = textLines(raw.text);
      if (op === 'delete') st.preamble = [];
      else if (op === 'replace') st.preamble = lines;
      else if (lines.length) st.preamble = appendLines(st.preamble, lines);
      applied.push({ section: '(preamble)', op });
      continue;
    }

    const hits = st.sections.filter((s) => s.kind !== 'loose' && S.sameSection(s.name, name));
    if (hits.length > 1) return { ok: false, error: `the document has ${hits.length} sections that match "${name}", so the edit cannot be placed without guessing` };
    const hit = hits[0] || null;
    const lines = clean(raw.text, name);

    // Replacing a section with nothing is removing it: rule 10 leaves out a section with no material,
    // and an empty heading is exactly what the copy-time lint warns about.
    if (op === 'delete' || (op === 'replace' && !lines.length)) {
      if (hit) { st.sections.splice(st.sections.indexOf(hit), 1); applied.push({ section: hit.name, op: 'delete' }); }
      continue;
    }
    if (!hit) {
      if (!lines.length) continue;
      const sec = newSection(name, st);
      sec.body = lines;
      st.sections.splice(insertIndex(st.sections, name), 0, sec);
      if (!st.style) st.style = sec.kind;
      if (!st.level && sec.level) st.level = sec.level;
      applied.push({ section: sec.name, op: 'create' });
      continue;
    }
    if (op === 'replace') hit.body = lines;
    // "create" on a section that already exists adds to it: the other reading loses what is there.
    else if (lines.length) hit.body = appendLines(hit.body, lines);
    applied.push({ section: hit.name, op: op === 'create' ? 'append' : op });
  }
  return { ok: true, doc: S.serialize(st), applied };
}

module.exports = { applyEdits, clean, OPS };
