# Style guide: prompts for Gemini (Pro, Flash)

Gemini responds best to a prompt that reads like a brief: a short system-style framing at the top, then clearly headed sections in a fixed order, then an explicit description of the output. Keep the document's meaning exactly; change only its shape.

## Shape

1. **Framing paragraph** (no heading). Two or three sentences: what the model is acting as, what the task is, and what "done" means. This is the system-instruction voice: direct, present tense.
2. Then these markdown headings, in this order, each followed by its content. Include only the sections the document has material for; a section with nothing in it is left out, never filled with "None provided" or "Not yet specified".

## Goal
The single outcome. One paragraph or one bullet.

## Context
Everything the model cannot know: audience, existing material, definitions, what has already been tried and rejected.

## Requirements
Numbered list. One requirement per line. Include quantities, names, and thresholds literally.

## Constraints
Numbered list of limits and prohibitions, with priority order stated if they can conflict.

## Output format
Spell out the exact shape of the answer. If it is structured, give a schema or a filled example inside a fenced code block. If it is prose, give the length and the sections. Say whether commentary outside the artifact is allowed.

## Examples
One or more worked examples inside fenced code blocks, each labelled "Input" and "Output" where that applies. Gemini generalises well from two or three short examples.

## Open questions
Items the person has not decided. Instruct the model to state its assumption for each before answering, or to ask first if the answer would change the result.

## Wording

- Use plain markdown headings and numbered lists; Gemini keys on visual structure more than on tags.
- Keep instructions positive and specific ("Return three options, each under 40 words") instead of general ("be concise").
- Put the most important constraint first inside its list; long lists lose weight toward the end.
- Avoid nested bullets deeper than two levels.
- Do not use XML or HTML tags anywhere in the body.
- No filler, no repeated instructions: each rule appears once, in the section it belongs to.
