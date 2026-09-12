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

/** At most five words, trimmed of punctuation and quoting, capitalised. */
function capTitle(text, max = 5) {
  const words = String(text == null ? '' : text)
    .replace(/[`"'*_#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, max)
    .join(' ')
    .replace(/[.,;:!?\-]+$/, '');
  if (!words) return '';
  return words.charAt(0).toUpperCase() + words.slice(1);
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
  seed, isBlank, titleFrom, capTitle, setTitle, renderConflictBlock, withConflictBlock, stripConflictBlock, stripForCopy,
};
