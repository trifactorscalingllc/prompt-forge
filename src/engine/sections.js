'use strict';
// The document as structure: an optional title, a preamble, and named sections, in either of the two
// shapes a prompt takes here -- markdown headings (`## Goal`, `# Task`) or block XML tags (`<goal>`
// ... `</goal>`). Pure and shared: the edit applier and the formatter both read and write through
// it, so "which lines belong to Requirements" is decided in exactly one place.
const { SECTIONS } = require('../doc');

const squash = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const CANON = new Map(SECTIONS.map((name) => [squash(name), name]));
CANON.set('task', 'Goal');   // the GPT guide writes Goal as "# Task"

/** 'Output format' for "<output_format>", "## Output Format" or "output-format"; null for anything else. */
const canonicalOf = (name) => CANON.get(squash(String(name == null ? '' : name).replace(/^#+\s*|^<\/?|>$/g, ''))) || null;
const orderOf = (name) => { const c = canonicalOf(name); return c ? SECTIONS.indexOf(c) : -1; };
/** The identity two headings share when they are the same section under different names. */
const keyOf = (name) => { const c = canonicalOf(name); return c ? squash(c) : squash(String(name).replace(/^#+\s*|^<\/?|>$/g, '')); };
const sameSection = (a, b) => keyOf(a) === keyOf(b);
/** The XML tag a section name becomes: "Output format" -> output_format. */
const tagOf = (name) => (canonicalOf(name) || String(name)).replace(/^#+\s*|^<\/?|>$/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'section';
/** A heading's words: "<open_questions>" -> "Open questions". */
const labelOf = (name) => {
  const s = String(name == null ? '' : name).replace(/^#+\s*|^<\/?|>$/g, '').replace(/_/g, ' ').trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Section';
};

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const OPEN = /^<([a-z][a-z0-9_]*)>\s*$/i;
const CLOSE = /^<\/([a-z][a-z0-9_]*)>\s*$/i;
const ITEM = /^\s*([-*+]|\d+[.)])\s+/;

const toLines = (doc) => String(doc == null ? '' : doc).replace(/\r\n?/g, '\n').split('\n');

/** Which lines sit inside a fenced code block. A heading or a tag in there is example text, not structure. */
function fencedLines(lines) {
  const inside = new Array(lines.length).fill(false);
  let mark = null;
  for (let i = 0; i < lines.length; i += 1) {
    const m = FENCE.exec(lines[i]);
    if (mark) {
      inside[i] = true;
      if (m && lines[i].trim().startsWith(mark)) mark = null;
      continue;
    }
    if (m) { mark = m[1]; inside[i] = true; }
  }
  return inside;
}

/** The line closing the tag opened at `from`, counting same-name nesting; -1 when it never closes. */
function findClose(lines, fenced, from, tag) {
  const t = tag.toLowerCase();
  let depth = 0;
  for (let k = from + 1; k < lines.length; k += 1) {
    if (fenced[k]) continue;
    const o = OPEN.exec(lines[k]);
    const c = CLOSE.exec(lines[k]);
    if (o && o[1].toLowerCase() === t) depth += 1;
    else if (c && c[1].toLowerCase() === t) { if (!depth) return k; depth -= 1; }
  }
  return -1;
}

const trimBlank = (ls) => {
  let a = 0;
  let b = ls.length;
  while (a < b && !ls[a].trim()) a += 1;
  while (b > a && !ls[b - 1].trim()) b -= 1;
  return ls.slice(a, b);
};

/**
 * { title, preamble, sections, style, level }
 *   title     the first line when it is an H1, else null
 *   preamble  lines between the title and the first section
 *   sections  [{ kind: 'md'|'xml'|'loose', name, level, heading, body, close }] in document order;
 *             'loose' holds text sitting between an XML section and whatever follows it
 *   style     'xml' or 'md' by majority, null when there are no sections
 *   level     the markdown heading level that starts a section
 */
function parse(doc) {
  const lines = toLines(doc);
  const fenced = fencedLines(lines);
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  let title = null;
  if (i < lines.length && !fenced[i] && /^# \S/.test(lines[i])) { title = lines[i].replace(/\s+$/, ''); i += 1; }

  // The section level is the one the recognised sections use, so a "### Detail" inside Requirements
  // stays inside it. With nothing recognised, the shallowest heading present.
  const heads = [];
  for (let k = i; k < lines.length; k += 1) {
    if (fenced[k]) continue;
    const m = HEADING.exec(lines[k]);
    if (m) heads.push({ level: m[1].length, name: m[2] });
  }
  const known = heads.filter((h) => canonicalOf(h.name));
  const pool = known.length ? known : heads;
  const level = pool.length ? Math.min(...pool.map((h) => h.level)) : null;

  const preamble = [];
  const sections = [];
  let cur = null;
  let loose = null;
  while (i < lines.length) {
    const line = lines[i];
    if (!fenced[i]) {
      const o = OPEN.exec(line);
      // A tag inside a markdown section is that section's content (<example> under ## Examples);
      // only a recognised section tag breaks out of one.
      if (o && (!cur || canonicalOf(o[1]))) {
        const end = findClose(lines, fenced, i, o[1]);
        if (end > 0) {
          sections.push({ kind: 'xml', name: o[1], level: null, heading: line.trim(), body: lines.slice(i + 1, end), close: lines[end].trim() });
          cur = null;
          loose = null;
          i = end + 1;
          continue;
        }
      }
      const h = HEADING.exec(line);
      if (h && level != null && h[1].length <= level) {
        cur = { kind: 'md', name: h[2], level: h[1].length, heading: line.replace(/\s+$/, ''), body: [], close: null };
        sections.push(cur);
        loose = null;
        i += 1;
        continue;
      }
    }
    if (cur) cur.body.push(line);
    else if (sections.length) {
      // Blank lines between two tagged sections are spacing, not a block of their own.
      if (!loose && !line.trim()) { i += 1; continue; }
      if (!loose) { loose = { kind: 'loose', name: '', level: null, heading: '', body: [], close: null }; sections.push(loose); }
      loose.body.push(line);
    } else preamble.push(line);
    i += 1;
  }
  const xml = sections.filter((s) => s.kind === 'xml').length;
  const md = sections.filter((s) => s.kind === 'md').length;
  return { title, preamble, sections, style: xml || md ? (xml > md ? 'xml' : 'md') : null, level };
}

/** Back to text. Blank lines between parts are normalised to exactly one; nothing else is touched. */
function serialize({ title, preamble, sections }) {
  const parts = [];
  if (title) parts.push(title);
  const pre = trimBlank(preamble || []);
  if (pre.length) parts.push(pre.join('\n'));
  for (const s of sections) {
    const body = trimBlank(s.body || []);
    if (s.kind === 'loose') { if (body.length) parts.push(body.join('\n')); continue; }
    if (s.kind === 'xml') parts.push((body.length ? [s.heading, '', ...body, '', s.close] : [s.heading, s.close]).join('\n'));
    else parts.push((body.length ? [s.heading, '', ...body] : [s.heading]).join('\n'));
  }
  return parts.length ? `${parts.join('\n\n')}\n` : '';
}

module.exports = {
  parse, serialize, fencedLines, findClose, trimBlank, toLines,
  canonicalOf, orderOf, keyOf, sameSection, tagOf, labelOf, squash,
  FENCE, HEADING, OPEN, CLOSE, ITEM,
};
