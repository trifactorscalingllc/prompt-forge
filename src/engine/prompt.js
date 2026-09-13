'use strict';
// The engine prompts, as pure string builders. Nothing here touches the network or the disk; the
// style guide arrives as text so this file is testable and the guides stay editable.
//
// Every builder returns { system, prompt }. The system half is the same bytes on every call of its
// kind -- no target name, no flags, nothing about this document -- so a provider can cache it and
// a CLI can take it from a file. Everything that varies is in `prompt`, stable parts first.
const { SECTIONS } = require('../doc');
const { contextBlock, excerptBlock } = require('../project');

const OUTPUT_CONTRACT = [
  'Output: one JSON object and nothing else. No code fence, no commentary before or after it.',
  '{"doc": "<the complete document as one JSON string>", "conflicts": [{"id": "C1", "section": "Requirements", "existing": "...", "incoming": "..."}], "changes": ["one short line per change you made"]}',
  '"doc" must be a string with newlines escaped as \\n. "conflicts" and "changes" must be arrays; empty arrays are fine.',
].join('\n');

const EDITS_CONTRACT = [
  'Output: one JSON object and nothing else. No code fence, no commentary before or after it.',
  '{"edits": [{"section": "Requirements", "op": "append", "text": "- One new requirement."}], "conflicts": [{"id": "C1", "section": "Requirements", "existing": "...", "incoming": "..."}], "changes": ["one short line per change you made"]}',
  '- "section": the section\'s name as it appears in the document, without "#" or angle brackets; "(preamble)" for the text before the first section.',
  '- "op": "append" adds lines to the end of an existing section; "replace" gives an existing section\'s complete new content; "create" adds a new section, which Prompt Forge places in the standard order; "delete" removes a section left with no material.',
  '- Prefer "append" when you only add lines. Use "replace" when existing lines must change: folding a duplicate, applying a resolution, applying a revision.',
  '- "text" never includes the section\'s heading or tags. It is a JSON string with newlines escaped as \\n.',
  '- An empty "edits" list is a valid answer, for example when every new idea is already covered. "conflicts" and "changes" must be arrays; empty arrays are fine.',
].join('\n');

const iso = (ts) => { try { return new Date(ts).toISOString(); } catch { return String(ts); } };
const block = (s) => (String(s == null ? '' : s).endsWith('\n') ? String(s) : `${s}\n`);
const q = (s) => `"${String(s == null ? '' : s).replace(/\s+/g, ' ').trim()}"`;
const oneLine = (s, max = 400) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };

function mergeRules(mode) {
  return `Rules:
1. Merge every new idea into the section it belongs to. The document's own sections are the structure; the canonical set is ${SECTIONS.join(', ')}. When the message carries <section-names>, the document has been polished for the target model, so those sections appear under those names — they are the same sections, and a heading below is never a reason to add a second one. Keep whatever naming the document already uses. Never append an idea as a loose bullet at the end and never invent a "Notes" or "Misc" section. If nothing fits, the closest section takes it; add a section only when the idea is clearly a new kind of thing.
2. Fold duplicates: if an idea restates something already present, strengthen the existing line instead of adding a second one.
3. Never resolve a contradiction silently. If a new idea contradicts the document (including a hand edit), leave the EXISTING text in place, keep the incoming text OUT of the body, and report it in "conflicts" with a stable id (C1, C2, ... continuing after the highest id in <open-conflicts>), the section, the existing text verbatim and the incoming text verbatim. Open conflicts stay open unless a resolution closes them.
4. If the existing text of an open conflict is no longer in the document, the person resolved it by hand: leave it out of "conflicts".
5. Apply each resolution exactly: keep new replaces the existing text with the incoming text; keep old leaves the body as it is. Either way the conflict is closed and must not appear in "conflicts".
6. Do not write an "Open conflicts" section into the document; Prompt Forge renders that itself.
7. Structure only. Do not restyle the document for the target model now; polishing is a separate step.
8. ${mode === 'document'
    ? 'Return the COMPLETE document, not a diff, and not a summary of it.'
    : 'Change only what the new ideas, resolutions and revisions require, and report it as edits to named sections. A section you do not name is kept exactly as it is, so never re-send a section you are not changing.'}
9. Write clearly enough that a model reading the finished prompt has nothing to assume: prefer a concrete statement over a vague one, and put anything the person left undecided under Open questions rather than guessing.
10. Add nothing of your own. Every line you write must come from a new idea, a resolution, or text already in the document. Do not invent requirements, constraints, examples, names, numbers or file paths the person has not given, and do not fill a section to make it look complete — a section with no material is left out. Rule 9 asks you to state the person's material precisely; it is not permission to supply material they did not.
11. An idea may come with attached files: images and PDFs arrive with this message, text files inline in <attachment> blocks, and anything unreadable by name only. Fold in the material the idea points at — what the screenshot shows, the fields in the file, the requirement in the brief — in your own words and in the section it belongs to; never paste a whole file. Where the finished prompt needs the file itself, refer to it by its file name exactly as given ("match the layout in homepage.png"), because the person sends that file along with the prompt.
12. Keep any {{variable}} exactly as written. It is a slot the person fills in when the prompt is copied.`;
}

/** The static half of a merge. `mode` is 'edits' (the default) or 'document' (the fallback). */
function mergeSystem(mode = 'edits') {
  return `You are the merge engine inside Prompt Forge, a workbench where a person builds one complicated prompt for a target model by adding ideas one at a time. You edit the working document; you never answer the prompt yourself. The message gives you the target model, the document, the ideas already merged, the open conflicts, the new ideas, and any resolutions and revisions.

The document is the source of truth. The person may have edited it by hand since the last merge, and every word of it is deliberate: keep hand edits, keep the section order and headings as they are (whatever style they are in), and keep the wording of anything you are not changing.

Ideas in <already-merged> are already reflected in the document. Do not add them again.

A revision is an earlier idea the person rewrote. Update the document so it reflects the new wording and no longer reflects the old one; do not keep both.

${mergeRules(mode)}

${mode === 'document' ? OUTPUT_CONTRACT : EDITS_CONTRACT}
When the message asks for suggestions, ideas or a title, add those keys to the same object, exactly as it describes.
`;
}

/** What each attached file is to the engine, on the idea's own line. */
function attachedLine(att) {
  if (!att) return '';
  const parts = [
    ...(att.blocks || []).map((b) => `${b.name} (${b.type === 'pdf' ? 'PDF' : 'image'}, sent with this message)`),
    ...(att.texts || []).map((t) => `${t.name} (text, in an <attachment> block below${t.truncated ? ', cut to fit' : ''})`),
    ...(att.notes || []).map((n) => `${n.name} (name only: ${n.note})`),
  ];
  return parts.length ? `\n   Attached: ${parts.join('; ')}` : '';
}

function attachmentBlocks(ideas) {
  const out = [];
  ideas.forEach((it, i) => {
    for (const t of (it.attached && it.attached.texts) || []) {
      out.push(`<attachment name=${JSON.stringify(t.name)} idea="${i + 1}"${t.truncated ? ' truncated="true"' : ''}>\n${block(t.text)}</attachment>`);
    }
  });
  return out.length ? `\n${out.join('\n\n')}\n` : '';
}

const SUGGEST = `
Also return "suggestions": up to three objects {"section": "<section name>", "kind": "action" or "info", "text": "<one or two sentences>"}. Each names a section of THIS document that is empty, thin, or missing something a model would have to guess at, and says concretely what belongs there — drawn from what the document and the ideas already establish. "kind" is "action" when the prompt stays worse until the person supplies it (a missing requirement, an unstated output format) and "info" when it is background that would help but is not required (audience, history, an example). Write them as advice to the person, addressed to them ("Name the three formats you accept here"), never as text to paste in. Nothing to say is an empty array; do not manufacture three. Suggestions are advice only and must never appear in the document.
Also return "ideas": up to three objects {"text": "<one sentence>"}, each a concrete way to take this prompt further that its own context makes natural — an angle, a case or a deliverable the person has not asked for yet — phrased so it could be sent as their next idea ("Add a follow-up email for leads who open but never reply"). Draw only on what the document establishes; no generic advice. Nothing worth proposing is an empty array. Ideas are advice only and must never appear in the document.`;

const TITLE = `
Also return "title": a name for this prompt of AT MOST FIVE WORDS, describing what the finished prompt is for. Name the subject, not the act of asking: "Collapsible prompt sidebar", not "Oh idea" or "User wants changes". It must be a complete, grammatical noun phrase in sentence case, spelled correctly, and not a sentence cut short: "Cold email sequence for plumbers", never "Emails that book calls for". No trailing punctuation, no quotes.`;

/**
 * { system, prompt } for one merge.
 * ideas: [{ text, attached?: { blocks, texts, notes } }]   -- attached comes from attachments.forEngine
 */
function buildMergePrompt({ doc, ideas = [], resolutions = [], revisions = [], conflicts = [], recent = [], target, projects = [], excerpts = [], needsTitle = false, suggest = false, sectionNames = [], mergedTotal = null, mode = 'edits' }) {
  const label = (target && target.label) || 'the target model';
  const merged = recent.length
    ? recent.map((e) => `- [${iso(e.ts)}] ${oneLine(e.text)}`).join('\n')
    : '(none yet)';
  const total = Number.isFinite(mergedTotal) ? mergedTotal : recent.length;
  const partial = total > recent.length;
  const aliases = sectionNames.length
    ? `<section-names>\n${sectionNames.map((x) => `- ${x.canonical} → ${x.name}`).join('\n')}\n</section-names>\nThis document has been polished for ${label}; those are the names its sections go by.\n\n`
    : '';
  const ideaLines = ideas.length
    ? ideas.map((it, i) => `${i + 1}. ${String(it.text || '').trim()}${attachedLine(it.attached)}`).join('\n')
    : '(none)';
  const revLines = revisions.length
    ? revisions.map((r) => `- ${r.id}: was ${q(r.before)} -> now ${q(r.after)}`).join('\n')
    : '(none)';
  const resLines = resolutions.length
    ? resolutions.map((r) => {
      const c = conflicts.find((x) => x.id === r.conflictId) || {};
      return `- ${r.conflictId}: keep ${r.keep}. existing: ${q(c.existing)} / incoming: ${q(c.incoming)}`;
    }).join('\n')
    : '(none)';

  const prompt = `${contextBlock(projects)}<target-model>${label}</target-model>

${aliases}<document>
${block(doc)}</document>

<already-merged${partial ? ` showing="${recent.length}" of="${total}"` : ''}>
${merged}
</already-merged>${partial ? `
This list is the ${recent.length} most recent of ${total}; the earlier ${total - recent.length} are not shown. The DOCUMENT is the complete record of what has been merged, so check it, not this list, before deciding an idea is new.` : ''}

<open-conflicts>
${JSON.stringify(conflicts, null, 2)}
</open-conflicts>

${excerptBlock(excerpts)}<new-ideas>
${ideaLines}
</new-ideas>
${attachmentBlocks(ideas)}
<resolutions>
${resLines}
</resolutions>

<revisions>
${revLines}
</revisions>
${suggest ? SUGGEST : ''}${needsTitle ? TITLE : ''}
`;
  return { system: mergeSystem(mode), prompt };
}

/** The static half of a polish: the rules and the family's style guide. */
function polishSystem(family, styleGuide) {
  return `You are the polish engine inside Prompt Forge. Rewrite the working document in the message into the final prompt for the target model it names, following the style guide below exactly. Change form, not substance: every goal, requirement, constraint, example and open question must survive with the same meaning. Add nothing the document does not say; drop nothing it does. The document's first line is the prompt's title, a "# " heading: keep it as the first line, word for word, above any opening sentence the style guide asks for.

Where the message carries <project-context>, you may name real paths and files from it where the document already refers to them vaguely; that is a change of form, not substance. Do not introduce a path the document does not already imply.

Open conflicts are unresolved contradictions. Do not resolve them and do not mention them in the body.

The person will keep adding ideas after this, so the result must stay a document the merge engine can extend: every section maps to one of ${SECTIONS.join(', ')}, named and formatted as the style guide says. Keep only the sections the document has material for. Never add a section to make the shape look complete, and never write placeholder text such as "None provided", "Not yet specified" or "No examples yet": a section with nothing in it is left out, not filled. Put any XML or HTML tag on its own line with a blank line before and after it; the document is read in a formatted editor, which shows a tag on its own line as structure and an inline one as literal text mid-sentence. Keep any {{variable}} exactly as written, and keep every reference to an attached file by its file name.

<style-guide family="${family}">
${block(styleGuide)}</style-guide>

Output: one JSON object and nothing else. No code fence, no commentary before or after it.
When the message carries <rewrite-only>, rewrite only the sections it lists and return {"edits": [{"section": "<the name as it appears in the document>", "op": "replace", "text": "<the section's complete new content, without its heading or tags>"}], "changes": ["one short line per change you made"]}. Every other section is already polished and stays as it is.
Otherwise return {"doc": "<the complete document as one JSON string>", "changes": ["one short line per change you made"]}.
"doc" and "text" are JSON strings with newlines escaped as \\n. "changes" must be an array.
When the message asks for suggestions or ideas, add those keys to the same object, exactly as it describes.
`;
}

/**
 * { system, prompt } for one polish. `only` lists the section names to rewrite; empty means the
 * whole document.
 */
function buildPolishPrompt({ doc, conflicts = [], target, styleGuide, projects = [], only = [], suggest = false, previousTarget = null }) {
  const label = (target && target.label) || 'the target model';
  const family = (target && target.family) || 'claude';
  const rewrite = only.length
    ? `\n<rewrite-only>\n${only.map((n) => `- ${n}`).join('\n')}\n</rewrite-only>\nThese sections changed since the document was last polished for ${label}. Rewrite them in the style guide's shape and leave every other section exactly as it is.\n`
    : '';
  // Switching the target is the moment a document that names its model goes stale: say which name to replace.
  const prev = previousTarget && previousTarget.label && previousTarget.label !== label ? previousTarget.label : null;
  const retarget = prev
    ? `\nThis prompt was written for ${prev} and is now for ${label}. Wherever the document names ${prev} as the model it is written for, name ${label} instead.\n`
    : '';
  const prompt = `${contextBlock(projects)}<target-model>${label}</target-model>

<document>
${block(doc)}</document>

<open-conflicts>
${JSON.stringify(conflicts, null, 2)}
</open-conflicts>
${rewrite}${retarget}${suggest ? `${SUGGEST}\n` : ''}`;
  return { system: polishSystem(family, styleGuide), prompt };
}

module.exports = { buildMergePrompt, buildPolishPrompt, mergeSystem, polishSystem, OUTPUT_CONTRACT, EDITS_CONTRACT };
