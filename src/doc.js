'use strict';
// Pure helpers for the prompt document. No vscode, no filesystem: the session decides where the
// text comes from and goes to; this file only knows what the text looks like.
//
// The document on disk is `body + open-conflicts block`. Snapshots store the body alone, and the
// block is rebuilt from the sidecar's conflict list every time the file is written, so the block is
// never the source of truth for anything.

const SECTIONS = ['Goal', 'Context', 'Requirements', 'Constraints', 'Output format', 'Examples', 'Open questions'];
const CONFLICT_OPEN = '<!-- forge:conflicts -->';
const CONFLICT_CLOSE = '<!-- /forge:conflicts -->';
const CONFLICT_HEADING = '## Open conflicts';

/** A new prompt is only its title. Sections are added by the engine as ideas land, so the document never shows empty headings. */
function seed(title) {
  return `# ${title}\n`;
}

// Words a name cannot end on. A five-word cut through "Sidebar with a plug and a hammer" leaves
// "Sidebar with a plug and", which is not a name; the cut backs up to a word that can end a phrase.
const DANGLING = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'nor', 'of', 'for', 'to', 'with', 'without', 'in', 'on', 'at', 'by', 'from', 'into', 'onto', 'about', 'as', 'than', 'that', 'which', 'who', 'vs', 'via', 'per', '&', 'is', 'are', 'my', 'your', 'our', 'its', 'their']);

/** At most five words, trimmed of punctuation and quoting, never ending on a word left hanging, capitalised. */
function capTitle(text, max = 5) {
  const words = String(text == null ? '' : text)
    .replace(/[`"'*_#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, max);
  const bare = (w) => w.toLowerCase().replace(/[.,;:!?\-]+$/, '');
  while (words.length > 1 && DANGLING.has(bare(words[words.length - 1]))) words.pop();
  const out = words.join(' ').replace(/[.,;:!?\-]+$/, '');
  if (!out) return '';
  return out.charAt(0).toUpperCase() + out.slice(1);
}

const squashWord = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, '');
const SECTION_KEYS = new Set([...SECTIONS.map(squashWord), 'task']);

/** The document's title: its first line when that is a "# " heading and not a section ("# Task"), else null. */
function titleOf(doc) {
  const line = String(doc == null ? '' : doc).split('\n').find((l) => l.trim());
  const m = line ? /^#\s+(.+?)\s*$/.exec(line) : null;
  return m && !SECTION_KEYS.has(squashWord(m[1])) ? m[1] : null;
}

/**
 * The document with `title` as its first line. A polish that opens with the style guide's framing
 * sentence tends to drop the "# Title" line, or reword it; this puts back the title the document had
 * and changes nothing else. A first line that is a section heading ("# Task") is not a title, so the
 * title goes above it.
 */
function ensureTitle(doc, title) {
  const t = String(title == null ? '' : title).trim();
  const s = String(doc == null ? '' : doc);
  if (!t) return s;
  const lines = s.split('\n');
  const i = lines.findIndex((l) => l.trim());
  if (i >= 0 && titleOf(lines[i]) !== null) {
    lines[i] = `# ${t}`;
    return lines.join('\n');
  }
  return `# ${t}\n\n${s.replace(/^\n+/, '')}`;
}

/** The fallback when the engine offers no title: first line, first five words, capitalised. */
function titleFrom(text) {
  const line = String(text == null ? '' : text).split('\n').map((l) => l.replace(/^[\s#>*-]+/, '').trim()).find(Boolean) || '';
  return capTitle(line) || 'Untitled';
}

/** The document with its first H1 replaced (or an H1 added). */
function setTitle(doc, title) {
  const s = String(doc == null ? '' : doc);
  if (/^# .*$/m.test(s)) return s.replace(/^# .*$/m, `# ${title}`);
  return `# ${title}\n\n${s.replace(/^\n+/, '')}`;
}

/** True when the document has nothing but its title (or nothing at all). */
function isBlank(doc) {
  const body = stripConflictBlock(doc).split('\n').filter((l) => l.trim() && !/^# /.test(l));
  return body.length === 0;
}

const oneLine = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/** The block itself, with no surrounding blank lines and no trailing newline. */
function renderConflictBlock(conflicts) {
  if (!Array.isArray(conflicts) || !conflicts.length) return '';
  const lines = conflicts.map((c) =>
    `- **${c.id}** (${oneLine(c.section) || 'unplaced'}): existing "${oneLine(c.existing)}" vs incoming "${oneLine(c.incoming)}"`);
  return [
    CONFLICT_OPEN,
    CONFLICT_HEADING,
    '',
    'These contradict each other. Resolve them in Prompt Forge (keep new / keep old) or edit the document by hand. This block is left out of the copied prompt.',
    '',
    ...lines,
    CONFLICT_CLOSE,
  ].join('\n');
}

/** Join two halves of a document around a removed block, leaving exactly one blank line between them. */
function join(left, right) {
  if (!left) return right;
  if (!right) return `${left}\n`;
  return `${left}\n\n${right}`;
}

function stripFenced(s) {
  const parts = s.split(/<!-- forge:conflicts -->[\s\S]*?<!-- \/forge:conflicts -->/);
  if (parts.length === 1) return s;
  let out = parts[0].replace(/\n+$/, '');
  for (let i = 1; i < parts.length; i++) {
    const right = parts[i].replace(/^\n+/, '');
    out = join(out, right).replace(/\n+$/, (m) => (i === parts.length - 1 ? m : ''));
  }
  return out;
}

/** An engine that ignored rule 6 writes the heading itself, unfenced. Remove it up to the next heading. */
function stripUnfenced(s) {
  const lines = s.split('\n');
  const i = lines.findIndex((l) => l.trim() === CONFLICT_HEADING);
  if (i < 0) return s;
  let j = i + 1;
  while (j < lines.length && !/^#{1,2} /.test(lines[j])) j++;
  const left = lines.slice(0, i).join('\n').replace(/\n+$/, '');
  const right = lines.slice(j).join('\n').replace(/^\n+/, '');
  return join(left, right);
}

function stripConflictBlock(doc) {
  let s = String(doc == null ? '' : doc);
  s = stripFenced(s);
  s = stripUnfenced(s);
  return s;
}

/** body + block. The block goes right after the H1 so it is the first thing a reader sees. */
function withConflictBlock(body, conflicts) {
  const clean = stripConflictBlock(body);
  const core = renderConflictBlock(conflicts);
  if (!core) return clean;
  const lines = clean.split('\n');
  const h = lines.findIndex((l) => /^# /.test(l));
  if (h < 0) return `${core}\n\n${clean.replace(/^\n+/, '')}`;
  const head = lines.slice(0, h + 1).join('\n');
  const rest = lines.slice(h + 1).join('\n').replace(/^\n+/, '');
  return `${head}\n\n${core}\n\n${rest}`;
}

/** What goes on the clipboard: the body with no conflict block and no forge comments. */
function stripForCopy(doc) {
  let s = stripConflictBlock(doc);
  s = s.replace(/^[ \t]*<!-- forge:[\s\S]*?-->[ \t]*\n?/gm, '');
  return `${s.trim()}\n`;
}

module.exports = {
  SECTIONS, CONFLICT_OPEN, CONFLICT_CLOSE, CONFLICT_HEADING,
  seed, isBlank, titleFrom, capTitle, setTitle, titleOf, ensureTitle, renderConflictBlock, withConflictBlock, stripConflictBlock, stripForCopy,
};
