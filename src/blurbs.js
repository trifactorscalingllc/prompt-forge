'use strict';
// One line per choice, saying what picking it changes. Written for the person tuning their own
// setup, not for a spec sheet: speed, cost, and where the model is worth it.

const ROLE_BLURBS = {
  provider: 'The account that does the work and pays for it. A CLI login uses your subscription; a key pays per token.',
  merge: 'Runs on every Enter. Decides where each idea lands and spots contradictions, so speed matters more than polish here.',
  polish: 'Runs when you click Polish or change the target. Rewrites the whole document in the target style, so quality matters most here.',
  target: 'The model this prompt is being written FOR. Changes the shape of the document, never which engine does the work.',
};

const FALLBACK = 'Custom id, passed through unchanged. Prompt Forge cannot say how it will behave.';

const TABLE = [
  [/fable|mythos/i, 'Highest quality and judgment; slowest and heaviest on quota. Best for Polish, overkill for merges.'],
  [/opus/i, 'Strong judgment a step below Fable in quality and cost. A good Polish choice.'],
  [/sonnet/i, 'Fast and reliable at structure. The default for merges: a few seconds per idea, light on quota.'],
  [/haiku/i, 'Fastest and cheapest Claude; may misplace subtle ideas. Use for merges when speed beats care.'],
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
