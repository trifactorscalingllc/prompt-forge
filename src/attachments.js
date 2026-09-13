'use strict';
// Files attached to an idea: what each one is, and what of it an engine may be given.
//
// The bytes live on disk beside the prompt, never in the sidecar or the panel state; this module is
// the only place they are read back, and only at the moment of the merge that needs them. What an
// engine receives depends on what it can take:
//   images and PDFs  as content blocks, where the provider accepts them
//   text             inline in the message, capped
//   anything else    by name, with a note saying it could not be read -- never a silent drop
const nodePath = require('node:path');
const { DENY_FILE } = require('./project');

const IMAGE = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const TEXT = /\.(txt|md|markdown|mdx|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|less|js|mjs|cjs|ts|tsx|jsx|vue|svelte|py|rb|go|rs|java|kt|swift|php|cs|c|h|cc|cpp|hpp|m|sql|sh|bash|zsh|ps1|bat|ini|cfg|conf|log|rst|tex|srt|vtt|graphql|proto|tf|dockerfile|makefile)$/i;

const LIMITS = {
  upload: 25 * 1024 * 1024,     // what the paperclip accepts at all
  image: 5 * 1024 * 1024,       // the largest image the vendors accept as a block
  pdf: 20 * 1024 * 1024,
  textChars: 60000,             // one text file, inline
  totalTextChars: 150000,       // every text file in one merge
};

/** { kind: 'image'|'pdf'|'text'|'other', mime, secret } from the name, and the first bytes when there are any. */
function classify(name, head = null) {
  const base = nodePath.basename(String(name || ''));
  const ext = nodePath.extname(base).toLowerCase();
  // Attaching is a deliberate act, but a key file still does not go to a model: its name does.
  if (DENY_FILE.test(base)) return { kind: 'other', mime: 'application/octet-stream', secret: true };
  if (IMAGE[ext]) return { kind: 'image', mime: IMAGE[ext], secret: false };
  if (ext === '.pdf') return { kind: 'pdf', mime: 'application/pdf', secret: false };
  if (TEXT.test(base) || /^(dockerfile|makefile|readme|license)$/i.test(base)) return { kind: 'text', mime: 'text/plain', secret: false };
  if (head && head.length && !head.subarray(0, 8192).includes(0)) return { kind: 'text', mime: 'text/plain', secret: false };
  return { kind: 'other', mime: 'application/octet-stream', secret: false };
}

const sizeLabel = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/**
 * Everything one merge sends about its attachments.
 *   blocks  [{ type: 'image'|'pdf', mime, data (base64), name }]   for providers that take them
 *   texts   [{ name, text, truncated }]                            inline in the message
 *   notes   [{ name, note }]                                       named, with the reason
 * `caps` says what the running provider accepts: { image, pdf }.
 */
function forEngine(attachments, { fs, caps = { image: false, pdf: false } } = {}) {
  const blocks = [];
  const texts = [];
  const notes = [];
  let textBudget = LIMITS.totalTextChars;
  for (const a of Array.isArray(attachments) ? attachments : []) {
    const name = a.name || nodePath.basename(a.path || '') || 'attachment';
    if (a.secret) { notes.push({ name, note: 'looks like a key or credentials file, so only its name is sent' }); continue; }
    let buf;
    try { buf = fs.readFileSync(a.path); } catch { notes.push({ name, note: 'the file is no longer on disk' }); continue; }
    const kind = a.kind || classify(name, buf).kind;
    if (kind === 'image' || kind === 'pdf') {
      const cap = kind === 'image' ? LIMITS.image : LIMITS.pdf;
      if (!caps[kind]) { notes.push({ name, note: `this engine cannot read ${kind === 'image' ? 'images' : 'PDFs'}, so only its name is sent` }); continue; }
      if (buf.length > cap) { notes.push({ name, note: `${sizeLabel(buf.length)} is over the ${sizeLabel(cap)} an engine accepts` }); continue; }
      blocks.push({ type: kind, mime: a.mime || classify(name).mime, data: buf.toString('base64'), name });
      continue;
    }
    if (kind === 'text') {
      let text = buf.toString('utf8');
      if (text.slice(0, 8192).includes('\u0000')) { notes.push({ name, note: 'binary content, so only its name is sent' }); continue; }
      const cap = Math.min(LIMITS.textChars, textBudget);
      if (cap <= 0) { notes.push({ name, note: 'the text budget for this merge is used up, so only its name is sent' }); continue; }
      const truncated = text.length > cap;
      if (truncated) text = text.slice(0, cap);
      textBudget -= text.length;
      texts.push({ name, text, truncated });
      continue;
    }
    notes.push({ name, note: 'not a format an engine can read, so only its name is sent' });
  }
  return { blocks, texts, notes };
}

module.exports = { classify, forEngine, LIMITS, IMAGE, sizeLabel };
