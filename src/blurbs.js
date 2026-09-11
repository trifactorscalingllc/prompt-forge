'use strict';
// One line per choice, saying what picking it changes. Written for the person tuning their own
// setup, not for a spec sheet: speed, cost, and where the model is worth it.

const ROLE_BLURBS = {
  provider: 'Which account does the work. A login uses your subscription; a key pays per token.',
  merge: 'Runs on every Enter to place each idea and catch contradictions. Speed over polish.',
  polish: 'Runs on Polish and on target changes to rewrite the whole document. Quality over speed.',
  target: 'Who the prompt is written for. Changes the document shape, not which engine runs.',
};

const FALLBACK = 'Custom id, passed through unchanged. Prompt Forge cannot say how it will behave.';

const TABLE = [
  [/fable|mythos/i, 'Best judgment; slowest and heaviest on quota. For Polish, overkill for merges.'],
  [/opus/i, 'Strong judgment, a step below Fable in cost. A good Polish choice.'],
  [/sonnet/i, 'Fast and reliable at structure; light on quota. The default for merges.'],
  [/haiku/i, 'Fastest and cheapest Claude; may misplace subtle ideas. Merges only.'],
  [/flash-lite/i, 'Cheapest Gemini; fine for simple merges, weaker at spotting contradictions.'],
  [/flash/i, 'Quick and cheap Gemini; a good merge model.'],
  [/gemini.*pro|^pro$/i, 'Gemini\'s best; slower. Good for Polish.'],
  [/gpt-5.*nano|^nano/i, 'Cheapest OpenAI model; simple merges only.'],
  [/gpt-5.*mini|^mini/i, 'Fast, cheap OpenAI model; a good merge model.'],
  [/^gpt-5(\.\d+)?$/i, 'OpenAI\'s best general model; slower. Good for Polish.'],
  [/codex/i, 'Tuned for code; fine for merging technical prompts.'],
  [/gpt-4/i, 'Previous OpenAI generation; works, but slower or weaker than GPT-5 for the price.'],
  [/^o\d/i, 'OpenAI reasoning model; slow and pricey per call. Polish only.'],
];

function modelBlurb(id) {
  const s = String(id == null ? '' : id);
  for (const [re, text] of TABLE) if (re.test(s)) return text;
  return FALLBACK;
}

module.exports = { modelBlurb, ROLE_BLURBS, FALLBACK };
