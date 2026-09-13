'use strict';
// A selection in any editor, sent to the forge as an idea: the note the person typed, then where the
// code came from, then the code. Pure.

const MAX = 20000;

function selectionIdea({ note = '', text = '', file = '', start = 1, end = start, lang = '', max = MAX }) {
  let code = String(text == null ? '' : text).replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  const cut = code.length > max;
  if (cut) code = code.slice(0, max);
  // A selection that already contains a fence gets the other fence, or it would close itself.
  const fence = code.includes('```') ? '~~~' : '```';
  const where = `${file}:${start}${end > start ? `-${end}` : ''}`;
  const head = String(note || '').trim();
  return `${head ? `${head}\n\n` : ''}From ${where}${cut ? ' (cut to fit)' : ''}:\n${fence}${String(lang || '').replace(/[^\w+-]/g, '')}\n${code}\n${fence}`;
}

module.exports = { selectionIdea, MAX };
