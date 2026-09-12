'use strict';
// A last look at the prompt at the moment it leaves the tool.
//
// It never blocks a copy. The copy always happens and the findings are reported after, because a
// tool that refuses to give you your own text is worse than one that lets a thin prompt through --
// and the person often knows exactly why a section is empty.
//
// Every check is a textual fact about the document, not a judgement of the writing: "Examples has
// no content" is checkable, "the goal is vague" is not, and a lint that guesses gets ignored.
const { sections } = require('./addendum');

// \b has to sit inside the word alternatives, not in front of the group: a space followed by "?"
// is not a word boundary, so a leading \b silently made "???" unmatchable. And the trailing \b is
// what keeps "todos" and "fixtures" from reading as TODO and FIXME.
const PLACEHOLDER = /(\b(?:TBD|TODO|FIXME|XXX)\b|\?{3,}|<insert[^>]*>|\[[^\]]*\b(?:fill|placeholder|your [a-z]+ here)\b[^\]]*\])/i;

/** Headings whose emptiness is worth mentioning, and why each one matters to a model. */
const WHY = {
  outputformat: 'the model has to invent a shape for its answer',
  requirements: 'there is nothing concrete for the model to satisfy',
  goal: 'the model cannot tell what finished looks like',
  task: 'the model cannot tell what finished looks like',
  constraints: null,
  context: null,
  examples: null,
  openquestions: null,
};

const key = (h) => String(h || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * [{ level, text }] — `warn` is worth reading before you paste, `note` is a nudge.
 * An empty array means nothing textual is wrong with it.
 */
function lintPrompt(doc, { conflicts = [] } = {}) {
  const out = [];
  const body = String(doc == null ? '' : doc);
  const secs = sections(body).filter((s) => s.heading && !/^#\s/.test(s.heading));

  if (conflicts.length) {
    out.push({ level: 'warn', text: `${conflicts.length} open conflict${conflicts.length === 1 ? '' : 's'} — the prompt contains one side of a contradiction and not the other.` });
  }

  const empty = secs.filter((s) => !s.lines.length);
  if (empty.length) {
    const named = empty.map((s) => s.heading.replace(/^#+\s*/, '').replace(/^<|>$/g, '').replace(/_/g, ' '));
    const reasons = empty.map((s) => WHY[key(s.heading)]).filter(Boolean);
    out.push({
      level: reasons.length ? 'warn' : 'note',
      text: `Empty: ${named.join(', ')}${reasons.length ? ` — ${reasons[0]}` : ''}.`,
    });
  }

  const hit = PLACEHOLDER.exec(body);
  if (hit) out.push({ level: 'warn', text: `A placeholder is still in the prompt: "${hit[0]}".` });

  const heads = new Set(secs.map((s) => key(s.heading)));
  if (secs.length && !heads.has('outputformat')) {
    out.push({ level: 'note', text: 'No output format section, so the shape of the answer is up to the model.' });
  }

  // There was a "short prompt" check here. It fired on prompts that were simply done, and a rule
  // whose own message has to end "fine if it is meant to be" is not a finding. Length is a choice.

  return out;
}

module.exports = { lintPrompt, PLACEHOLDER };
