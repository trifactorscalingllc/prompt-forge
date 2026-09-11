'use strict';
// Turning whatever the engine said into a validated {doc, conflicts, changes}, or a clear error.
// Never throws: a bad engine reply is an ordinary outcome the panel shows with a Retry.
const { stripConflictBlock } = require('../doc');

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

function parseEngineOutput(text, { kind = 'merge', inputDoc = '' } = {}) {
  const obj = extractJson(text);
  if (!obj) {
    const preview = String(text == null ? '' : text).trim().slice(0, 160).replace(/\s+/g, ' ');
    return { ok: false, error: `engine did not return JSON${preview ? `: ${preview}` : ''}` };
  }
  if (typeof obj.doc !== 'string' || !obj.doc.trim()) {
    return { ok: false, error: 'engine returned an empty document' };
  }
  let doc = stripConflictBlock(obj.doc.replace(/\r/g, ''));
  doc = `${doc.replace(/\n+$/, '')}\n`;
  if (kind === 'merge' && inputDoc && doc.length < 0.4 * inputDoc.length) {
    return { ok: false, error: `engine returned a much shorter document (${doc.length} vs ${inputDoc.length} chars); refused to overwrite` };
  }
  return {
    ok: true,
    doc,
    conflicts: coerceConflicts(obj.conflicts),
    changes: Array.isArray(obj.changes) ? obj.changes.map((c) => str(c)).filter(Boolean) : [],
  };
}

module.exports = { extractJson, parseEngineOutput };
