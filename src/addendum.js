'use strict';
// What changed in the prompt since you last copied it, written as something you can paste as the
// NEXT message in the conversation you already pasted the prompt into.
//
// That framing decides the content. The model on the other end already has the prompt, so this
// carries the change and not the context -- it is an addendum, not a second prompt. It is computed
// from the two documents rather than asked of the engine: a follow-up that quietly rewords what you
// wrote would be worse than no feature, and this way it costs nothing and can be explained.
const HEADING = /^(#{1,6}\s+.*|<[a-z_][a-z0-9_]*>)\s*$/i;
// A closing tag is structure, not content. Left in, it becomes a line of the section and an
// addendum reports "</requirements>" as something the person added.
const CLOSER = /^<\/[a-z_][a-z0-9_]*>\s*$/i;

/** [{ heading, lines }] — the document split at its headings, in order. */
function sections(doc) {
  const out = [{ heading: '', lines: [] }];
  for (const raw of String(doc == null ? '' : doc).split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (CLOSER.test(line)) continue;
    if (HEADING.test(line)) out.push({ heading: line.trim(), lines: [] });
    else if (line.trim()) out[out.length - 1].lines.push(line);
  }
  return out.filter((s) => s.heading || s.lines.length);
}

/** A heading matched across a restyle: "## Goal", "<goal>" and "# Task" are not equal as strings. */
const key = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/** Longest common subsequence over lines, so a paragraph that moved is not reported as rewritten. */
function lcs(a, b) {
  const n = a.length;
  const m = b.length;
  const t = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    }
  }
  const keep = new Set();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { keep.add(j); i += 1; j += 1; }
    else if (t[i + 1][j] >= t[i][j + 1]) i += 1;
    else j += 1;
  }
  return keep;
}

/** Same lines in any order, counting duplicates. */
function sameLines(a, b) {
  if (a.length !== b.length) return false;
  const count = new Map();
  for (const l of a) count.set(l, (count.get(l) || 0) + 1);
  for (const l of b) {
    const n = count.get(l);
    if (!n) return false;
    count.set(l, n - 1);
  }
  return true;
}

function diffLines(before, after) {
  const kept = lcs(before, after);
  const added = after.filter((_, j) => !kept.has(j));
  const keptBack = lcs(after, before);
  const removed = before.filter((_, j) => !keptBack.has(j));
  return { added, removed };
}

/**
 * [{ heading, added, removed }] — what moved between two documents, section by section.
 * The same walk buildAddendum does, exposed on its own so a merge can record its diff once at the
 * time it happens rather than every repaint recomputing it.
 */
function diffSections(before, after) {
  const A = sections(before);
  const B = sections(after);
  const byKey = new Map(A.map((s) => [key(s.heading), s]));
  const blocks = [];
  for (const s of B) {
    const was = byKey.get(key(s.heading));
    if (was && sameLines(was.lines, s.lines)) continue;
    const d = diffLines(was ? was.lines : [], s.lines);
    if (d.added.length || d.removed.length) blocks.push({ heading: s.heading, ...d });
  }
  const nowKeys = new Set(B.map((s) => key(s.heading)));
  for (const s of A) {
    if (nowKeys.has(key(s.heading)) || !s.lines.length) continue;
    blocks.push({ heading: s.heading, added: [], removed: s.lines });
  }
  return blocks;
}

/**
 * { text, added, removed, restyled } — `text` is '' when nothing of substance changed.
 * `restyled` means so much moved that an addendum would be noise: send the whole prompt instead.
 */
function buildAddendum(before, after, { restyleRatio = 0.6 } = {}) {
  const A = sections(before);
  const B = sections(after);
  const byKey = new Map(A.map((s) => [key(s.heading), s]));

  const blocks = [];
  let added = 0;
  let removed = 0;
  for (const s of B) {
    const was = byKey.get(key(s.heading));
    // Reordering is not a change worth sending: the content is identical, so LCS would report one
    // line added and one removed and the follow-up would say nothing.
    if (was && sameLines(was.lines, s.lines)) continue;
    const d = diffLines(was ? was.lines : [], s.lines);
    if (!d.added.length && !d.removed.length) continue;
    added += d.added.length;
    removed += d.removed.length;
    blocks.push({ heading: s.heading, ...d });
  }
  // A section that existed and is now gone entirely.
  const nowKeys = new Set(B.map((s) => key(s.heading)));
  for (const s of A) {
    if (nowKeys.has(key(s.heading)) || !s.lines.length) continue;
    removed += s.lines.length;
    blocks.push({ heading: s.heading, added: [], removed: s.lines });
  }

  const beforeLines = A.reduce((n, s) => n + s.lines.length, 0);
  const restyled = beforeLines > 0 && (added + removed) / (beforeLines + added) > restyleRatio;
  if (!blocks.length) return { text: '', added: 0, removed: 0, restyled: false };

  const parts = ['Continuing the prompt I sent earlier. Everything in it still applies; these are the additions and changes since then.', ''];
  for (const b of blocks) {
    if (b.heading) parts.push(b.heading, '');
    if (b.added.length) { parts.push(...b.added, ''); }
    if (b.removed.length) {
      parts.push('No longer applies:', ...b.removed.map((l) => `- ${l.replace(/^[-*]\s*/, '')}`), '');
    }
  }
  return { text: `${parts.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`, added, removed, restyled };
}

module.exports = { buildAddendum, diffSections, sections, diffLines, sameLines, key };
