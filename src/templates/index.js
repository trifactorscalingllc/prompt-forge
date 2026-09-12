'use strict';
// Starting shapes.
//
// A template does NOT seed empty headings. The document is built so that sections appear as ideas
// need them, and an empty heading is exactly what the copy-time lint warns about -- a template that
// created five of them would ship the warning with the prompt.
//
// So every template is real content with the unknowns marked in [brackets]. That is deliberate and
// it closes a loop: the lint's placeholder check catches any bracket you forget to replace, at the
// moment the prompt leaves the tool.

const TEMPLATES = [
  {
    id: 'code-review',
    label: 'Code review',
    blurb: 'Review a diff or a file for correctness and clarity.',
    body: `## Goal

Review [the change / the file] and report what is wrong with it, ordered by how much it matters.

## Context

[Language and framework]. [What this code is part of, and what it is supposed to do.]

## Requirements

- Report correctness bugs first: wrong logic, unhandled cases, race conditions, silent failures.
- For each finding, give the file and line, what breaks, and concrete inputs that would break it.
- Then note clarity and reuse issues, clearly separated from the bugs.
- Say when something is a matter of taste rather than a defect.

## Constraints

- Do not restyle code that works. [Add any convention this codebase follows.]
- If a finding is uncertain, say so rather than asserting it.

## Output format

One finding per entry: severity, file:line, what breaks, and the failing case. No summary preamble.
`,
  },
  {
    id: 'landing-copy',
    label: 'Landing page copy',
    blurb: 'Write page copy that sells one specific thing.',
    body: `## Goal

Write the copy for a landing page that gets [audience] to [the one action you want].

## Context

The product is [what it is, in one sentence]. The people reading are [who they are and what they already believe]. They currently [what they do instead today].

## Requirements

- Lead with the outcome the reader gets, not the product's features.
- [Number] sections: [hero, proof, objections, call to action].
- Use the words the audience uses. [List any terms they actually say.]
- One call to action, repeated, in the same words each time.

## Constraints

- No superlatives that cannot be checked ("best", "revolutionary").
- Do not invent statistics, testimonials or customer names.

## Output format

The copy itself, section by section, with each section's heading. No commentary about the choices.
`,
  },
  {
    id: 'research-brief',
    label: 'Research brief',
    blurb: 'Answer a question from sources, with the uncertainty kept.',
    body: `## Goal

Answer this question: [the question]. Say what is known, what is contested, and what is unknown.

## Context

This is for [who will act on it] who will use it to [the decision it feeds].

## Requirements

- Cite a source for every factual claim, with enough detail to find it again.
- Separate what the sources establish from what you are inferring.
- Where sources disagree, say whether the disagreement is about the facts or about the definitions.
- Give each conclusion a confidence, and say what would change your mind.

## Constraints

- Do not resolve a genuine disagreement by picking a side silently.
- No source, no claim.

## Output format

The answer first, in [length]. Then the evidence, then the open questions.
`,
  },
  {
    id: 'bug-to-fix',
    label: 'Bug to fix',
    blurb: 'Turn a symptom into a diagnosis and a patch.',
    body: `## Goal

Find the cause of [the symptom] and fix it.

## Context

[What you observed, exactly.] It happens when [the trigger], and does not happen when [the contrast]. [Version, environment, anything that changed recently.]

## Requirements

- Explain the cause before the fix, and say how the cause produces this exact symptom.
- The fix must address the cause, not mask the symptom.
- Say what else the fix could affect.
- Add a test that would have caught this.

## Constraints

- [Anything that must not change.]
- If the evidence does not identify a single cause, say which candidates remain and what would distinguish them.

## Output format

Cause, then the patch as a diff, then the test, then the blast radius.
`,
  },
  {
    id: 'extract-structured',
    label: 'Extract structured data',
    blurb: 'Pull fields out of messy text, reliably.',
    body: `## Goal

Extract [the fields] from [the kind of document] and return them as [JSON / CSV].

## Context

The input looks like [describe the shape and how much it varies]. It comes from [source].

## Requirements

- Every field is either the value found or null. Never guess a value to fill a slot.
- [Field]: [what counts as that field, and the format it must be in.]
- When a field appears more than once, take [which one] and say why the rule is that.
- Preserve the source's own wording for free-text fields.

## Constraints

- Return only the data. No explanation, no preamble, no code fence.
- If the input is not [the kind of document], return an empty result rather than a best effort.

## Output format

[Paste the exact schema, or one filled example.]
`,
  },
];

const byId = (id) => TEMPLATES.find((t) => t.id === id) || null;

/** Title from the label, and the body with the document's H1 on top. */
function seedFrom(id, title) {
  const t = byId(id);
  if (!t) return null;
  return `# ${title || t.label}\n\n${t.body}`;
}

module.exports = { TEMPLATES, byId, seedFrom };
