'use strict';
// {{variables}}: slots in a prompt that are filled when it leaves the tool, so one prompt serves
// every client, repo or audience it is written for. The document keeps the slot; only the copy, the
// send and the run see the value. Pure.

const VAR = /\{\{\s*([A-Za-z][A-Za-z0-9_ .-]{0,40}?)\s*\}\}/g;
const nameOf = (raw) => String(raw || '').trim().replace(/\s+/g, ' ');

/** Every variable name in the text, first appearance first, each once. Code fences included on purpose. */
function findVars(text) {
  const seen = new Set();
  const out = [];
  for (const m of String(text == null ? '' : text).matchAll(VAR)) {
    const n = nameOf(m[1]);
    if (!seen.has(n.toLowerCase())) { seen.add(n.toLowerCase()); out.push(n); }
  }
  return out;
}

/** { text, missing } -- a variable with no value stays a visible slot rather than an empty gap. */
function fillVars(text, values = {}) {
  const lookup = new Map(Object.entries(values || {}).map(([k, v]) => [nameOf(k).toLowerCase(), String(v == null ? '' : v)]));
  const missing = new Set();
  const out = String(text == null ? '' : text).replace(VAR, (whole, raw) => {
    const v = lookup.get(nameOf(raw).toLowerCase());
    if (v == null || v === '') { missing.add(nameOf(raw)); return whole; }
    return v;
  });
  return { text: out, missing: [...missing] };
}

module.exports = { findVars, fillVars, VAR };
