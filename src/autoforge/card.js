'use strict';
// The words auto-forge puts into a Claude Code chat. Measured in the day-1 test: whatever a Stop hook
// hands Claude is printed in full in a terminal chat, so every instruction here is as short as it
// can be and asks for nothing the person could have ruled out. Pure.

const CONFIRM_HEADER = 'Prompt Forge';
const LABELS = { forge: 'Forge them', later: 'Not now', never: 'Never in this chat' };

const oneLine = (s, max) => {
  const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
// A card is markdown Claude reposts; brackets and stars from the prompt must not turn into links or bold.
const plain = (s, max) => oneLine(s, max).replace(/[[\]*_`]/g, '');

function confirmQuestion(count) {
  return {
    question: `Forge your last ${count} long prompts into one prompt in Prompt Forge?`,
    header: CONFIRM_HEADER,
    options: [
      { label: LABELS.forge, description: 'Merge them into a prompt document and show what merged' },
      { label: LABELS.later, description: 'Ask again after more long prompts' },
      { label: LABELS.never, description: 'Stop watching this chat' },
    ],
  };
}

/** Stop hook context: ask the one question. */
function askInstruction(count) {
  const q = confirmQuestion(count);
  const opts = q.options.map((o) => `"${o.label}" (description "${o.description}")`).join(', ');
  return `Prompt Forge, which the user switched on in VS Code, noticed ${count} long prompts in this chat. Before you stop, call AskUserQuestion once with one question: question "${q.question}", header "${q.header}", options ${opts}. Then stop.`;
}

/** Which confirm answer came back, from a PostToolUse AskUserQuestion input; null when the question was not ours. */
function answerFor(toolInput) {
  const input = toolInput && typeof toolInput === 'object' ? toolInput : {};
  const answers = input.answers && typeof input.answers === 'object' ? input.answers : {};
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const ours = questions.find((q) => q && q.header === CONFIRM_HEADER)
    || questions.find((q) => q && /prompt forge/i.test(String(q.question || '')));
  if (!ours) return null;
  const value = String(answers[ours.question] == null ? '' : answers[ours.question]).trim();
  if (!value) return null;
  if (value.toLowerCase().startsWith(LABELS.forge.toLowerCase())) return 'forge';
  if (value.toLowerCase().startsWith(LABELS.never.toLowerCase())) return 'never';
  if (value.toLowerCase().startsWith(LABELS.later.toLowerCase())) return 'later';
  // A typed answer.
  if (/\bnever\b/i.test(value)) return 'never';
  if (/^(y|yes|yep|sure|ok|okay|do it|go)\b/i.test(value) || /\bforge\b/i.test(value)) return 'forge';
  return 'later';
}

/** The summary card, as markdown. */
function cardText({ title = '', count = 0, update = false, changes = [], conflicts = [], undoUrl = '', openUrl = '' }) {
  const name = plain(title || 'Untitled', 80);
  const lines = [update
    ? `**Prompt Forge** · added ${count} more prompt${count === 1 ? '' : 's'} to *${name}*`
    : `**Prompt Forge** · forged ${count} prompt${count === 1 ? '' : 's'} into *${name}*`];
  const shown = (Array.isArray(changes) ? changes : []).map((c) => plain(c, 100)).filter(Boolean);
  for (const c of shown.slice(0, 5)) lines.push(`- ${c}`);
  if (shown.length > 5) lines.push(`- and ${shown.length - 5} more`);
  const open = Array.isArray(conflicts) ? conflicts : [];
  if (open.length) {
    const c = open[0];
    const more = open.length > 1 ? ` and ${open.length - 1} more` : '';
    lines.push(`- Held back: ${open.length} conflict${open.length === 1 ? '' : 's'} (${plain(c.section || 'document', 40)}: "${plain(c.existing, 60)}" vs "${plain(c.incoming, 60)}"${more})`);
  }
  const links = [];
  if (undoUrl) links.push(`[Undo](${undoUrl})`);
  if (openUrl) links.push(`[Open in Prompt Forge](${openUrl})`);
  links.push('or type /unforge');
  lines.push('', links.join(' · '));
  return lines.join('\n');
}

function failedText({ count = 0, error = '' }) {
  return `**Prompt Forge** could not forge the last ${count} prompt${count === 1 ? '' : 's'}: ${plain(error || 'unknown error', 160)}. Nothing was changed.`;
}

/** Stop hook context: post the card. */
const cardInstruction = (card) => `Prompt Forge finished. Post this card as a short message of its own, exactly as written, then stop:\n\n${card}`;

/** PostToolUse context once the person said Forge them. */
const forgingInstruction = () => 'Prompt Forge is forging those prompts now. Acknowledge in one short line; its card follows.';

module.exports = { CONFIRM_HEADER, LABELS, confirmQuestion, askInstruction, answerFor, cardText, failedText, cardInstruction, forgingInstruction };
