'use strict';
// Turning whatever the engine said into a validated {doc, conflicts, changes}, or a clear error.
// Never throws: a bad engine reply is an ordinary outcome the panel shows with a Retry.
const { stripConflictBlock } = require('../doc');
const { applyEdits } = require('./edits');

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

/** The first JSON object in `text`: bare, fenced, or wrapped in prose. */
function extractJson(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  let s = text.trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
  if (fence) s = fence[1].trim();
  let v = tryParse(s);
  if (v) return v;
  const start = s.indexOf('{');
  if (start < 0) return null;
  let end = s.lastIndexOf('}');
  while (end > start) {
    v = tryParse(s.slice(start, end + 1));
    if (v) return v;
    end = s.lastIndexOf('}', end - 1);
  }
  return null;
}

const str = (v) => String(v == null ? '' : v).replace(/\r/g, '');

function coerceConflicts(raw) {
  const list = Array.isArray(raw) ? raw.filter((c) => c && typeof c === 'object') : [];
  let max = 0;
  for (const c of list) {
    const m = typeof c.id === 'string' && /^C(\d+)$/.exec(c.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  const seen = new Set();
  const out = [];
  for (const c of list) {
    let id = typeof c.id === 'string' && /^C\d+$/.test(c.id) ? c.id : null;
    if (id && seen.has(id)) continue;
    if (!id) { max += 1; id = `C${max}`; }
    seen.add(id);
    out.push({ id, section: str(c.section), existing: str(c.existing), incoming: str(c.incoming) });
  }
  return out;
}

/**
 * Advice, typed so the panel can say which is which: "action" is something the prompt stays worse
 * without, "info" is background that would help. Requirements and Context are pinned whatever the
 * engine said, because the person reads the colour as a promise about the section.
 */
function suggestionKind(section, kind) {
  const key = String(section || '').toLowerCase().replace(/[^a-z]/g, '');
  if (key === 'requirements') return 'action';
  if (key === 'context') return 'info';
  return kind === 'action' ? 'action' : 'info';
}

/**
 * { ok, doc, conflicts, changes, title, suggestions, ideas, edited } or { ok: false, error, retryWithDocument }.
 * A reply may carry the whole document ("doc") or edits to named sections ("edits"); edits are
 * applied to `inputDoc`. `retryWithDocument` says a second call asking for the whole document is
 * worth making: the engine answered, but not in a form that can be placed without guessing.
 */
function parseEngineOutput(text, { kind = 'merge', inputDoc = '' } = {}) {
  const obj = extractJson(text);
  if (!obj) {
    const preview = String(text == null ? '' : text).trim().slice(0, 160).replace(/\s+/g, ' ');
    return { ok: false, error: `engine did not return JSON${preview ? `: ${preview}` : ''}` };
  }
  let doc;
  let edited = false;
  if (Array.isArray(obj.edits) && !(typeof obj.doc === 'string' && obj.doc.trim())) {
    const r = applyEdits(stripConflictBlock(String(inputDoc || '')), obj.edits);
    if (!r.ok) return { ok: false, error: r.error, retryWithDocument: true };
    doc = r.doc;
    edited = true;
  } else if (typeof obj.doc === 'string' && obj.doc.trim()) {
    doc = obj.doc;
  } else {
    return { ok: false, error: 'engine returned an empty document', retryWithDocument: kind === 'merge' };
  }
  doc = stripConflictBlock(doc.replace(/\r/g, ''));
  doc = `${doc.replace(/\n+$/, '')}\n`;
  if (kind === 'merge' && inputDoc && doc.length < 0.4 * inputDoc.length) {
    return { ok: false, error: `engine returned a much shorter document (${doc.length} vs ${inputDoc.length} chars); refused to overwrite`, retryWithDocument: edited };
  }
  return {
    ok: true,
    doc,
    edited,
    conflicts: coerceConflicts(obj.conflicts),
    changes: Array.isArray(obj.changes) ? obj.changes.map((c) => str(c)).filter(Boolean) : [],
    title: typeof obj.title === 'string' ? str(obj.title).trim() : '',
    // Advice about the document, never part of it. Capped here so a chatty engine cannot turn the
    // prompt panel into a lecture.
    suggestions: Array.isArray(obj.suggestions)
      ? obj.suggestions
        .filter((x) => x && typeof x === 'object' && String(x.text || '').trim())
        .slice(0, 3)
        .map((x) => {
          const section = str(x.section).trim().slice(0, 60);
          return { section, kind: suggestionKind(section, x.kind), text: str(x.text).replace(/\s+/g, ' ').trim().slice(0, 400) };
        })
      : [],
    ideas: Array.isArray(obj.ideas)
      ? obj.ideas
        .map((x) => (typeof x === 'string' ? x : x && typeof x === 'object' ? x.text : ''))
        .map((t) => str(t).replace(/\s+/g, ' ').trim().slice(0, 300))
        .filter(Boolean)
        .slice(0, 3)
        .map((t) => ({ text: t }))
      : [],
  };
}

module.exports = { extractJson, parseEngineOutput, suggestionKind };
