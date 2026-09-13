'use strict';
// Two people editing one prompt at the same moment. The edit arrives with the text it was made
// against (`base`); if the document has moved since, the two changes are joined section by section
// rather than one replacing the other. A section only one side touched takes that side. A section
// both sides changed differently takes the incoming edit -- the most recent -- and the result says
// it was not clean, so the caller can keep the other text as a version. Pure.
const S = require('../engine/sections');

function partsOf(doc) {
  const st = S.parse(doc);
  const parts = [];
  const seen = new Map();
  const push = (key, text) => {
    const n = seen.get(key) || 0;
    seen.set(key, n + 1);
    parts.push({ key: n ? `${key}#${n}` : key, text });
  };
  push('(title)', st.title || '');
  push('(preamble)', S.trimBlank(st.preamble).join('\n'));
  for (const s of st.sections) {
    const text = S.serialize({ title: null, preamble: [], sections: [s] }).replace(/\n+$/, '');
    push(s.kind === 'loose' ? '(loose)' : `s:${S.keyOf(s.name)}`, text);
  }
  return parts;
}

/** { doc, clean }: `theirs` (the incoming edit) and `ours` (the document now), joined over `base`. */
function mergeDocs(base, ours, theirs) {
  const b = String(base == null ? '' : base);
  const o = String(ours == null ? '' : ours);
  const t = String(theirs == null ? '' : theirs);
  if (o === t || b === o) return { doc: t, clean: true };
  if (b === t) return { doc: o, clean: true };

  const B = new Map(partsOf(b).map((p) => [p.key, p.text]));
  const O = partsOf(o);
  const Omap = new Map(O.map((p) => [p.key, p.text]));
  const T = partsOf(t);
  const Tkeys = new Set(T.map((p) => p.key));
  let clean = true;
  const out = [];

  for (const p of T) {
    const was = B.get(p.key);
    if (!Omap.has(p.key)) {
      // Not in the document now. Deleted here and untouched in the edit: stays deleted.
      if (was !== undefined && was === p.text) continue;
      if (was !== undefined) clean = false;   // deleted here, changed in the edit: the words are kept
      out.push(p);
      continue;
    }
    const now = Omap.get(p.key);
    if (now === p.text || was === now) out.push(p);
    else if (was === p.text) out.push({ key: p.key, text: now });
    else { out.push(p); clean = false; }
  }

  // Sections the document has and the edit does not: added here, or removed by the edit.
  O.forEach((p, i) => {
    if (Tkeys.has(p.key)) return;
    const was = B.get(p.key);
    if (was !== undefined && was === p.text) return;       // the edit removed it and nothing here changed it
    if (was !== undefined) clean = false;                   // removed there, changed here: kept
    // After the nearest earlier section both have, so it lands where it was written.
    let at = out.length;
    for (let j = i - 1; j >= 0; j -= 1) {
      const k = out.findIndex((x) => x.key === O[j].key);
      if (k >= 0) { at = k + 1; break; }
    }
    if (i === 0 || O.slice(0, i).every((q) => q.key === '(title)' || q.key === '(preamble)')) {
      const k = out.findIndex((x) => x.key !== '(title)' && x.key !== '(preamble)');
      at = k < 0 ? out.length : k;
    }
    out.splice(at, 0, p);
  });

  const text = out.map((p) => p.text).filter((x) => x.trim()).join('\n\n');
  return { doc: text ? `${text}\n` : '', clean };
}

module.exports = { mergeDocs, partsOf };
