'use strict';
// The two engine prompts, as pure string builders. Nothing here touches the network or the disk;
// the style guide arrives as text so this file is testable and the guides stay editable.
const { SECTIONS } = require('../doc');
const { contextBlock } = require('../project');

const OUTPUT_CONTRACT = [
  'Output: one JSON object and nothing else. No code fence, no commentary before or after it.',
  '{"doc": "<the complete document as one JSON string>", "conflicts": [{"id": "C1", "section": "Requirements", "existing": "...", "incoming": "..."}], "changes": ["one short line per change you made"]}',
  '"doc" must be a string with newlines escaped as \\n. "conflicts" and "changes" must be arrays; empty arrays are fine.',
].join('\n');

const iso = (ts) => { try { return new Date(ts).toISOString(); } catch { return String(ts); } };
const block = (s) => (String(s == null ? "" : s).endsWith("\n") ? String(s) : `${s}\n`);
const q = (s) => `"${String(s == null ? '' : s).replace(/\s+/g, ' ').trim()}"`;

function buildMergePrompt({ doc, ideas = [], resolutions = [], revisions = [], conflicts = [], recent = [], target, projects = [], needsTitle = false, sections = SECTIONS, sectionNames = [], mergedTotal = null }) {
  const label = (target && target.label) || 'the target model';
  const merged = recent.length
    ? recent.map((e) => `- [${iso(e.ts)}] ${String(e.text || '').replace(/\s+/g, ' ').trim()}`).join('\n')
    : '(none yet)';
  const total = Number.isFinite(mergedTotal) ? mergedTotal : recent.length;
  const partial = total > recent.length;
  const aliases = sectionNames.length
    ? sectionNames.map((x) => `- ${x.canonical} → ${x.name}`).join('\n')
    : '';
  const ideaLines = ideas.length ? ideas.map((it, i) => `${i + 1}. ${String(it.text || '').trim()}`).join('\n') : '(none)';
  const revLines = revisions.length
    ? revisions.map((r) => `- ${r.id}: was ${q(r.before)} -> now ${q(r.after)}`).join('\n')
    : '(none)';
  const resLines = resolutions.length
    ? resolutions.map((r) => {
      const c = conflicts.find((x) => x.id === r.conflictId) || {};
      return `- ${r.conflictId}: keep ${r.keep}. existing: ${q(c.existing)} / incoming: ${q(c.incoming)}`;
    }).join('\n')
    : '(none)';

  return `You are the merge engine inside Prompt Forge, a workbench where a person builds one complicated prompt for ${label} by adding ideas one at a time. You edit the working document; you never answer the prompt yourself.

${contextBlock(projects)}<document>
${block(doc)}</document>

The document is the source of truth. The person may have edited it by hand since the last merge, and every word of it is deliberate: keep hand edits, keep the section order and headings as they are (whatever style they are in), and keep the wording of anything you are not changing.

<already-merged${partial ? ` showing="${recent.length}" of="${total}"` : ''}>
${merged}
</already-merged>
Those ideas are already reflected in the document. Do not add them again.${partial ? `
This list is the ${recent.length} most recent of ${total}; the earlier ${total - recent.length} are not shown. The DOCUMENT is the complete record of what has been merged, so check it, not this list, before deciding an idea is new.` : ''}

<open-conflicts>
${JSON.stringify(conflicts, null, 2)}
</open-conflicts>

<new-ideas>
${ideaLines}
</new-ideas>

<resolutions>
${resLines}
</resolutions>

<revisions>
${revLines}
</revisions>
A revision is an earlier idea the person rewrote. Update the document so it reflects the new wording and no longer reflects the old one; do not keep both.

Rules:
1. Merge every new idea into the section it belongs to. The document's own sections are the structure; the canonical set is ${sections.join(', ')}.${aliases ? ` This document has been polished for ${label}, so those sections appear under these names — they are the same sections, and a heading below is never a reason to add a second one:
${aliases}
   Keep whatever naming the document already uses.` : ''} Never append an idea as a loose bullet at the end and never invent a "Notes" or "Misc" section. If nothing fits, the closest section takes it; add a section only when the idea is clearly a new kind of thing.
2. Fold duplicates: if an idea restates something already present, strengthen the existing line instead of adding a second one.
3. Never resolve a contradiction silently. If a new idea contradicts the document (including a hand edit), leave the EXISTING text in place, keep the incoming text OUT of the body, and report it in "conflicts" with a stable id (C1, C2, ... continuing after the highest id in <open-conflicts>), the section, the existing text verbatim and the incoming text verbatim. Open conflicts stay open unless a resolution closes them.
4. If the existing text of an open conflict is no longer in the document, the person resolved it by hand: leave it out of "conflicts".
5. Apply each resolution exactly: keep new replaces the existing text with the incoming text; keep old leaves the body as it is. Either way the conflict is closed and must not appear in "conflicts".
6. Do not write an "Open conflicts" section into "doc"; Prompt Forge renders that itself.
7. Structure only. Do not restyle the document for ${label} now; polishing is a separate step.
8. Return the COMPLETE document, not a diff, and not a summary of it.
9. Write clearly enough that a model reading the finished prompt has nothing to assume: prefer a concrete statement over a vague one, and put anything the person left undecided under Open questions rather than guessing.
10. Add nothing of your own. Every line you write must come from a new idea, a resolution, or text already in the document. Do not invent requirements, constraints, examples, names, numbers or file paths the person has not given, and do not fill a section to make it look complete — a section with no material is left out. Rule 9 asks you to state the person's material precisely; it is not permission to supply material they did not.

${OUTPUT_CONTRACT}${needsTitle ? `
Also return "title": a name for this prompt of AT MOST FIVE WORDS, describing what the finished prompt is for. Name the subject, not the act of asking: "Collapsible prompt sidebar", not "Oh idea" or "User wants changes". No trailing punctuation, no quotes.` : ''}
`;
}

function buildPolishPrompt({ doc, conflicts = [], target, styleGuide, projects = [] }) {
  const label = (target && target.label) || 'the target model';
  const family = (target && target.family) || 'claude';
  const ctx = contextBlock(projects);
  return `You are the polish engine inside Prompt Forge. Rewrite the working document below into the final prompt for ${label}, following the style guide exactly. Change form, not substance: every goal, requirement, constraint, example and open question must survive with the same meaning. Add nothing the document does not say; drop nothing it does.

${ctx}${ctx ? 'You may name real paths and files from the context above where the document already refers to them vaguely; that is a change of form, not substance. Do not introduce a path the document does not already imply.\n\n' : ''}<style-guide family="${family}">
${styleGuide}
</style-guide>

<document>
${block(doc)}</document>

<open-conflicts>
${JSON.stringify(conflicts, null, 2)}
</open-conflicts>
Open conflicts are unresolved contradictions. Do not resolve them and do not mention them in the body; return "conflicts" exactly as given (same ids and texts).

The person will keep adding ideas after this, so the result must stay a document the merge engine can extend: keep sections that map to ${SECTIONS.join(', ')}, named and formatted as the style guide says. Put any XML or HTML tag on its own line with a blank line before and after it; the document is read in a formatted editor, which shows a tag on its own line as structure and an inline one as literal text mid-sentence.

${OUTPUT_CONTRACT}
`;
}

module.exports = { buildMergePrompt, buildPolishPrompt, OUTPUT_CONTRACT };
