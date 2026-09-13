'use strict';
// One engine call in flight per prompt, and everything that arrives while it runs becomes ONE
// batch when it finishes. Ideas and conflict resolutions fold together into a single merge;
// consecutive polish requests collapse to one. Pure apart from calling `run`.

function nextBatch(ops) {
  if (!ops.length) return { batch: null, rest: [] };
  const first = ops[0];
  if (first.kind === 'polish') {
    let i = 0;
    let last = first;
    let full = false;
    let from = null;
    while (i < ops.length && ops[i].kind === 'polish') {
      last = ops[i];
      full = full || Boolean(ops[i].full);
      // Several target switches in a row: the document was last written for the FIRST one's old target.
      if (!from && ops[i].from) from = ops[i].from;
      i++;
    }
    // Collapsing must not lose a request to rewrite everything: any one of them asked, so the batch does.
    return { batch: { ...last, ...(full ? { full: true } : {}), ...(from ? { from } : {}) }, rest: ops.slice(i) };
  }
  const entryIds = [];
  const resolutions = [];
  const revisions = [];
  let i = 0;
  while (i < ops.length && ['idea', 'resolve', 'revise'].includes(ops[i].kind)) {
    const op = ops[i];
    if (op.kind === 'idea') entryIds.push(op.entryId);
    else if (op.kind === 'revise') revisions.push({ entryId: op.entryId, before: op.before });
    else resolutions.push({ conflictId: op.conflictId, keep: op.keep });
    i++;
  }
  if (i === 0) return { batch: { ...first }, rest: ops.slice(1) };
  return { batch: { kind: 'merge', entryIds, resolutions, revisions }, rest: ops.slice(i) };
}

function createQueue({ run, onChange = () => {}, onError = () => {} }) {
  let ops = [];
  let busy = false;

  async function drain() {
    if (busy) return;
    busy = true;
    onChange();
    try {
      while (ops.length) {
        const { batch, rest } = nextBatch(ops);
        ops = rest;
        onChange();
        try { await run(batch); } catch (e) { onError(e); }
      }
    } finally {
      busy = false;
      onChange();
    }
  }

  return {
    push(op) { ops.push(op); onChange(); drain(); },
    size: () => ops.length,
    busy: () => busy,
    pending: () => ops.slice(),
    clear() { ops = []; onChange(); },
    drain,
  };
}

module.exports = { createQueue, nextBatch };
