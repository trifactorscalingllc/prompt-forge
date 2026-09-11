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
    while (i < ops.length && ops[i].kind === 'polish') { last = ops[i]; i++; }
    return { batch: { ...last }, rest: ops.slice(i) };
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
