'use strict';
// The formatter: what "consistently formatted" means, enforced in code after every merge and every
// polish instead of asked of the model.
//
// The prompts have always REQUESTED this shape -- tags on their own lines, one bullet style, the
// family's section names in the standard order. A request is honoured most of the time; a pass over
// the text is honoured every time. Same principle as the five-word title: an instruction about
// length is a request, a slice is a guarantee.
//
// Two modes. Merge (no family): tidy only -- whitespace, glued or unclosed tags, bullet markers,
// duplicate sections -- and never rename or reorder, because the person's headings are theirs.
// Polish (a family): also rename every section to the family's heading and put them in order.
// Fenced code is never touched in either mode; it is example text, not structure.
const S = require('./sections');
const { SECTION_NAMES, FAMILIES } = require('../targets');

const SECTION_TAGS = [...new Set(Object.values(SECTION_NAMES.claude).map((n) => n.replace(/^<|>$/g, '')).concat(['task', 'example']))];
const T = SECTION_TAGS.join('|');
const GLUED_BOTH = new RegExp(`^\\s*<(${T})>\\s*(\\S.*?)\\s*</\\1>\\s*$`, 'i');
const GLUED_OPEN = new RegExp(`^\\s*<(${T})>\\s*(\\S.*)$`, 'i');
const GLUED_CLOSE = new RegExp(`^(.*\\S)\\s*</(${T})>\\s*$`, 'i');
const LONE_TAG = new RegExp(`^\\s+(</?(?:${T})>)\\s*$`, 'i');
const HR = /^\s{0,3}([-*_])[ \t]*\1[ \t]*\1[-*_ \t]*$/;

/** Whitespace, bullet markers and tags glued to text. Line-local, and blind inside fences. */
function tidyLines(doc) {
  const src = S.toLines(doc);
  const fenced = S.fencedLines(src);
  const out = [];
  let blanks = 0;
  for (let i = 0; i < src.length; i += 1) {
    if (fenced[i]) { out.push(src[i]); blanks = 0; continue; }
    let line = src[i].replace(/\s+$/, '');
    if (!line) { blanks += 1; if (blanks === 1) out.push(''); continue; }
    blanks = 0;
    if (!HR.test(line)) line = line.replace(/^(\s*)[*+•](\s+)(?=\S)/, '$1- ');
    let m;
    if ((m = GLUED_BOTH.exec(line))) out.push(`<${m[1].toLowerCase()}>`, m[2], `</${m[1].toLowerCase()}>`);
    else if ((m = GLUED_OPEN.exec(line))) out.push(`<${m[1].toLowerCase()}>`, m[2]);
    else if ((m = GLUED_CLOSE.exec(line))) out.push(m[1], `</${m[2].toLowerCase()}>`);
    else if ((m = LONE_TAG.exec(line))) out.push(m[1].toLowerCase());
    else out.push(line);
  }
  return out;
}

const isSectionTag = (name) => Boolean(S.canonicalOf(name));

/**
 * A recognised section tag that never closes is closed before the next section starts, and a
 * closing tag that closes nothing is dropped. Both are how a model's reply usually goes wrong, and
 * both would otherwise leave the rest of the document inside the wrong section.
 */
function repairTags(input) {
  let lines = input.slice();
  // Stray closers first, so an unmatched one cannot be taken for the end of a real section.
  {
    const fenced = S.fencedLines(lines);
    const depth = new Map();
    const keep = [];
    for (let i = 0; i < lines.length; i += 1) {
      const o = !fenced[i] && S.OPEN.exec(lines[i]);
      const c = !fenced[i] && S.CLOSE.exec(lines[i]);
      if (o && isSectionTag(o[1])) depth.set(o[1].toLowerCase(), (depth.get(o[1].toLowerCase()) || 0) + 1);
      if (c && isSectionTag(c[1])) {
        const t = c[1].toLowerCase();
        if (!depth.get(t)) continue;
        depth.set(t, depth.get(t) - 1);
      }
      keep.push(lines[i]);
    }
    lines = keep;
  }
  for (let guard = 0; guard < 50; guard += 1) {
    const fenced = S.fencedLines(lines);
    let fixed = false;
    for (let i = 0; i < lines.length; i += 1) {
      if (fenced[i]) continue;
      const o = S.OPEN.exec(lines[i]);
      if (!o || !isSectionTag(o[1]) || S.findClose(lines, fenced, i, o[1]) >= 0) continue;
      let j = i + 1;
      while (j < lines.length) {
        if (!fenced[j]) {
          const next = S.OPEN.exec(lines[j]);
          const h = S.HEADING.exec(lines[j]);
          if ((next && isSectionTag(next[1])) || (h && isSectionTag(h[2]))) break;
        }
        j += 1;
      }
      while (j > i + 1 && !lines[j - 1].trim()) j -= 1;
      lines.splice(j, 0, `</${o[1].toLowerCase()}>`);
      fixed = true;
      break;
    }
    if (!fixed) break;
  }
  return lines;
}

function joinBodies(a, b) {
  const have = S.trimBlank(a);
  const add = S.trimBlank(b);
  if (!add.length) return have;
  if (!have.length) return add;
  const tight = S.ITEM.test(have[have.length - 1]) && S.ITEM.test(add[0]);
  return [...have, ...(tight ? [] : ['']), ...add];
}

/** Two sections that are the same section become one, in the position of the first. */
function mergeDuplicates(sections) {
  const first = new Map();
  const out = [];
  for (const s of sections) {
    const c = s.kind === 'loose' ? null : S.canonicalOf(s.name);
    if (c && first.has(c)) { const f = first.get(c); f.body = joinBodies(f.body, s.body); continue; }
    if (c) first.set(c, s);
    out.push(s);
  }
  return out;
}

/** Headings inside a section, where the family does not want them there. */
function demoteHeadings(body, family, level) {
  const fenced = S.fencedLines(body);
  return body.map((line, i) => {
    if (fenced[i]) return line;
    const h = S.HEADING.exec(line);
    if (!h) return line;
    // Claude's tags are the headings, so a heading inside one becomes a bold line.
    if (family === 'claude') return `**${h[2]}**`;
    return h[1].length <= level ? `${'#'.repeat(level + 1)} ${h[2]}` : line;
  });
}

/** One section in the family's shape: the guide's own heading for a known section, its words otherwise. */
function reshape(s, family) {
  if (s.kind === 'loose') return s;
  const canon = S.canonicalOf(s.name);
  const named = canon ? SECTION_NAMES[family][canon] : null;
  if (family === 'claude') {
    const tag = named ? named.replace(/^<|>$/g, '') : S.tagOf(s.name);
    return { kind: 'xml', name: tag, level: null, heading: `<${tag}>`, body: demoteHeadings(s.body, family, 0), close: `</${tag}>` };
  }
  const level = family === 'gpt' ? 1 : 2;
  const heading = named || `${'#'.repeat(level)} ${S.labelOf(s.name)}`;
  return { kind: 'md', name: S.HEADING.exec(heading)[2], level, heading, body: demoteHeadings(s.body, family, level), close: null };
}

// What a model writes into a section it has nothing for. Whole lines only, and deliberately narrow:
// "None of the emails may exceed 120 words" is a requirement, not filler, and must survive.
const FILLER = /^(?:[-*]\s+)?(?:none(?:\s+(?:provided|given|specified|recorded|listed|identified))?|n\/a|tbd|not\s+(?:yet\s+)?(?:specified|provided|recorded|given|defined|decided)|no\s+\w+(?:\s+\w+)?\s+(?:provided|given|specified|recorded|listed))(?:\s+(?:in|for)\s+(?:the\s+)?(?:working\s+)?document)?(?:\s+(?:yet|so\s+far))?\s*\.?$/i;

/** A recognised section with nothing real in it: empty, or only lines like "None provided." Pure. */
function isEmptySection(s) {
  if (s.kind === 'loose' || !S.canonicalOf(s.name)) return false;
  return S.trimBlank(s.body).map((l) => l.trim()).filter(Boolean).every((l) => FILLER.test(l));
}

/** The standard order. A section with no standard place keeps the one it had after its neighbour. */
function order(sections) {
  let last = -1;
  return sections
    .map((s, i) => {
      const o = s.kind === 'loose' ? -1 : S.orderOf(s.name);
      const rank = o >= 0 ? o : last + 0.5;
      if (o >= 0) last = o;
      return { s, rank, i };
    })
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((r) => r.s);
}

/**
 * The document, formatted. `family` ('claude' | 'gemini' | 'gpt') switches on polish mode.
 * Idempotent: formatting a formatted document returns it unchanged.
 */
function formatDoc(doc, { family = null } = {}) {
  const lines = repairTags(tidyLines(doc));
  const st = S.parse(lines.join('\n'));
  st.sections = mergeDuplicates(st.sections);
  if (family && FAMILIES.includes(family) && st.sections.some((s) => s.kind !== 'loose')) {
    // A polish that padded the shape with empty sections is corrected here: a section with no material
    // is left out, as the merge leaves it out. Only in polish mode -- an empty heading the person typed
    // is theirs.
    st.sections = order(st.sections.filter((s) => !isEmptySection(s)).map((s) => reshape(s, family)));
  }
  return S.serialize(st);
}

module.exports = { formatDoc, tidyLines, repairTags, isEmptySection, SECTION_TAGS, FILLER };
