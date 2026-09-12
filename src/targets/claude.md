# Style guide: prompts for Claude (Fable, Opus, Sonnet, Haiku)

Claude reads structure best when each part of the prompt sits inside a clearly named XML tag. Use the tags below as the section names. Keep the document's meaning exactly; change only its shape.

## Shape

- Open with one or two plain sentences that say what the task is and what a finished result looks like. No role-play preamble ("You are a world-class..."); state the job.
- Then one block per section, in this order, each as an XML tag ON ITS OWN LINE with a blank line before and after it:

<goal>
What must be true when the work is done. One outcome, stated concretely.
</goal>

<context>
Background the model cannot infer: who this is for, what exists already, what has been tried, definitions of any local terms.
</context>

<requirements>
What the result must include or do. Short lines, one requirement each. Quantities and names spelled out.
</requirements>

<constraints>
What must not happen, hard limits, things that are off the table, and the order of priority when two constraints collide.
</constraints>

<output_format>
Exactly what to return: format, length, sections, file names, code language. If the answer should be only the artifact, say "return only the artifact, no commentary".
</output_format>

<examples>
Concrete examples of good output (and, if useful, one bad one labelled as bad). Put each example inside its own tag:

<example>
...
</example>
</examples>

<open_questions>
Anything the person has not decided. Tell Claude to ask about these, or to state its assumption explicitly before proceeding, rather than guess.
</open_questions>

## Wording

- Every tag on its own line. Never put a tag inline inside a sentence: the document is read in a formatted editor, which shows a tag on its own line as structure and an inline one as literal text in the middle of a sentence.
- Say what to do, not what not to do, wherever a positive form exists. Keep genuine prohibitions in constraints.
- Be explicit and literal. Claude follows instructions closely, so a vague line becomes a vague result and an over-specified line becomes a rigid one. State the outcome and the limits; do not script the steps unless the order itself matters.
- Tell Claude how to handle uncertainty: "If a requirement is ambiguous, say which reading you chose and why" beats letting it pick silently.
- Keep the content of each section as bullet lists or short paragraphs. No markdown headings inside the tags; the tags are the headings.
- Drop filler: no "please", no "make sure to", no repeated instructions. Once, clearly, in the right section.
