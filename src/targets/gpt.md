# Style guide: prompts for OpenAI models (GPT-5, GPT-5 mini)

GPT models do best with a prompt that is organised like a developer message: markdown headings, numbered rules, an explicit output specification, and clear success criteria. Keep the document's meaning exactly; change only its shape.

## Shape

Use these markdown headings, in this order. Include only the sections the document has material for; a section with nothing in it is left out, never filled with "None provided" or "Not yet specified".

# Task
One or two sentences: what to produce and for whom. State the outcome, not the process.

# Context
Background the model needs: audience, existing material, vocabulary, what has already been tried.

# Requirements
Numbered rules. One per line, each testable ("includes a title under 60 characters", not "has a good title").

# Constraints
Numbered limits and prohibitions. If two can conflict, say which wins.

# Output format
Exact shape of the response. For structured output, give a JSON schema or a filled example in a fenced block and say "return only this, nothing else". For prose, give length and sections.

# Examples
Short examples in fenced blocks, labelled. Include one example of a wrong answer only if the failure mode is common and non-obvious.

# Open questions
What is undecided. Instruct the model to either ask before starting or to state each assumption in one line at the top of its answer.

## Wording

- Numbered lists over paragraphs for anything the model must obey.
- Success criteria over step-by-step procedures: reasoning models plan their own steps; tell them what a correct result looks like and let them get there. Do not add "think step by step".
- Be literal about quantities, names and formats. Say "exactly three" when you mean exactly three.
- Put the output specification and the hard constraints where they cannot be missed: near the end is fine for GPT-5, which reads the whole prompt, but never bury a hard rule mid-paragraph.
- No XML or HTML tags in the body; markdown headings and fenced blocks carry the structure.
- Each instruction appears once, in one section. Repeating a rule does not make it stronger.
