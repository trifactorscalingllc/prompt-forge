/* eslint-env browser */
// The markdown renderer, shared by the Prompt Forge panel and the built-in document editor.
//
// Why we render markdown ourselves instead of depending on a WYSIWYG extension: a prompt document
// is the product, and the product should look right the moment the extension is installed. A hard
// dependency also fails the whole install wherever the marketplace is unreachable (VSCodium, an
// OpenVSX build, an air-gapped machine), for a feature that is three hundred lines of code.
//
// Two exports matter:
//   blocks(md)  -> [{ kind, start, end, src }] covering EVERY line, blanks included, so a block's
//                  line range can be edited and written back without disturbing its neighbours.
//   render(md)  -> HTML. Every string is escaped before it is placed, so a prompt cannot script
//                  the page no matter what a model wrote into it.
//
// UMD-ish on purpose: the same file is a <script> in two webviews and a require() in the tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  else root.ForgeMD = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const esc = (t) => String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const lines = (md) => String(md == null ? '' : md).replace(/\r\n?/g, '\n').split('\n');

  const RE = {
    heading: /^(#{1,6})\s+(.*)$/,
    fence: /^\s{0,3}(```|~~~)/,
    hr: /^\s{0,3}([-*_])[ \t]*\1[ \t]*\1[-*_ \t]*$/,
    quote: /^\s{0,3}>/,
    item: /^(\s*)([-*+]|\d+[.)])\s+(.*)$/,
    row: /^\s*\|.*\|\s*$/,
    rule: /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/,
    xtag: /^\s*<\/?[a-zA-Z_][\w.-]*(?:\s[^>]*)?\/?>\s*$/,
  };
  /** A line that ends whatever block is running. */
  const starts = (l) => RE.heading.test(l) || RE.fence.test(l) || RE.hr.test(l) || RE.quote.test(l) || RE.xtag.test(l);

  /** Split into blocks. Ranges are contiguous and cover the whole document, blank runs included. */
  function blocks(md) {
    const ls = lines(md);
    const out = [];
    const push = (kind, start, end) => out.push({ kind, start, end, src: ls.slice(start, end).join('\n') });
    let i = 0;
    while (i < ls.length) {
      const line = ls[i];
      if (!line.trim()) { const s = i; while (i < ls.length && !ls[i].trim()) i += 1; push('blank', s, i); continue; }
      if (RE.fence.test(line)) {
        const mark = RE.fence.exec(line)[1];
        const s = i; i += 1;
        while (i < ls.length && !ls[i].trim().startsWith(mark)) i += 1;
        if (i < ls.length) i += 1;                      // the closing fence belongs to the block
        push('fence', s, i); continue;
      }
      if (RE.heading.test(line)) { push('heading', i, i + 1); i += 1; continue; }
      if (RE.hr.test(line)) { push('hr', i, i + 1); i += 1; continue; }
      if (RE.xtag.test(line)) { push('xtag', i, i + 1); i += 1; continue; }
      if (RE.quote.test(line)) {
        const s = i; while (i < ls.length && ls[i].trim() && !RE.fence.test(ls[i])) i += 1;
        push('quote', s, i); continue;
      }
      if (RE.row.test(line) && i + 1 < ls.length && RE.rule.test(ls[i + 1])) {
        const s = i; while (i < ls.length && ls[i].trim() && ls[i].includes('|')) i += 1;
        push('table', s, i); continue;
      }
      if (RE.item.test(line)) {
        const s = i;
        while (i < ls.length && ls[i].trim() && !starts(ls[i])) i += 1;
        push('list', s, i); continue;
      }
      const s = i;
      i += 1;
      while (i < ls.length && ls[i].trim() && !starts(ls[i]) && !RE.item.test(ls[i])) i += 1;
      push('para', s, i);
    }
    return out;
  }

  // ------------------------------------------------------------------------------------------
  // Inline
  // ------------------------------------------------------------------------------------------
  const SENTINEL = String.fromCharCode(0);

  /** Code spans are lifted out first so the bold, italic and link rules cannot reach inside them. */
  function inline(text) {
    const code = [];
    let s = String(text == null ? '' : text).replace(/`([^`]+)`/g, (_m, c) => { code.push(c); return `${SENTINEL}${code.length - 1}${SENTINEL}`; });
    s = esc(s);
    s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label, href) => (/^(https?:|mailto:)/i.test(href) ? `<a href="${href}">${label || href}</a>` : m));
    s = s.replace(/(^|\s)(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g, '$1<a href="$2">$2</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    s = s.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    s = s.replace(/(^|[^*\w])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    s = s.replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>');
    return s.replace(new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g'), (_m, n) => `<code>${esc(code[Number(n)])}</code>`);
  }

  /** Markdown joins wrapped lines with a space; only a hard break (two spaces, or a backslash) breaks. */
  function paragraph(src) {
    const parts = String(src == null ? '' : src).split('\n');
    let html = '';
    parts.forEach((l, idx) => {
      const hard = /(\s\s|\\)$/.test(l);
      html += inline(l.replace(/(\s\s|\\)$/, ''));
      if (idx < parts.length - 1) html += hard ? '<br>' : ' ';
    });
    return html;
  }

  // ------------------------------------------------------------------------------------------
  // Blocks
  // ------------------------------------------------------------------------------------------
  const TASK = /^\[([ xX])\]\s+(.*)$/;

  function item(text) {
    const t = TASK.exec(text);
    if (!t) return inline(text);
    const done = t[1].toLowerCase() === 'x';
    return `<span class="task${done ? ' done' : ''}">${done ? '&#10003;' : '&#9633;'}</span> ${inline(t[2])}`;
  }

  /** Nested lists by indent, with a stack. Continuation lines fold into the item above them. */
  function list(src) {
    const rows = [];
    for (const l of String(src == null ? '' : src).split('\n')) {
      const m = RE.item.exec(l);
      if (m) rows.push({ indent: m[1].replace(/\t/g, '    ').length, ordered: /\d/.test(m[2]), text: m[3] });
      else if (rows.length && l.trim()) rows[rows.length - 1].text += ` ${l.trim()}`;
    }
    if (!rows.length) return '';
    let html = '';
    const stack = [];
    for (const r of rows) {
      while (stack.length > 1 && r.indent < stack[stack.length - 1].indent) html += `</li></${stack.pop().tag}>`;
      const top = stack[stack.length - 1];
      const tag = r.ordered ? 'ol' : 'ul';
      if (!top) { html += `<${tag}>`; stack.push({ indent: r.indent, tag }); }
      else if (r.indent > top.indent) { html += `<${tag}>`; stack.push({ indent: r.indent, tag }); }
      else {
        html += '</li>';
        if (top.tag !== tag) { html += `</${top.tag}><${tag}>`; stack[stack.length - 1] = { indent: top.indent, tag }; }
      }
      html += `<li>${item(r.text)}`;
    }
    while (stack.length) html += `</li></${stack.pop().tag}>`;
    return html;
  }

  const cells = (line) => line.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => c.trim());

  function table(src) {
    const rows = String(src == null ? '' : src).split('\n').filter((l) => l.trim());
    if (rows.length < 2) return `<p>${paragraph(src)}</p>`;
    const align = cells(rows[1]).map((c) => (/^:-+:$/.test(c) ? 'center' : /-+:$/.test(c) ? 'right' : /^:-+/.test(c) ? 'left' : ''));
    const at = (i) => (align[i] ? ` style="text-align:${align[i]}"` : '');
    const head = cells(rows[0]).map((c, i) => `<th${at(i)}>${inline(c)}</th>`).join('');
    const body = rows.slice(2).map((r) => `<tr>${cells(r).map((c, i) => `<td${at(i)}>${inline(c)}</td>`).join('')}</tr>`).join('');
    return `<table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
  }

  function fence(src) {
    const rows = String(src == null ? '' : src).split('\n');
    const lang = (rows[0].trim().replace(/^(```|~~~)/, '').trim().split(/\s+/)[0] || '').replace(/[^\w+-]/g, '');
    const closed = rows.length > 1 && RE.fence.test(rows[rows.length - 1]);
    const body = rows.slice(1, closed ? -1 : undefined).join('\n');
    return `<pre${lang ? ` data-lang="${esc(lang)}"` : ''}><code>${esc(body)}</code></pre>`;
  }

  function quote(src) {
    const inner = String(src == null ? '' : src).split('\n').map((l) => l.replace(/^\s{0,3}>\s?/, '')).join('\n');
    return `<blockquote>${blocks(inner).map(one).join('\n')}</blockquote>`;
  }

  // A tag on its own line is structure. For the model it has to stay a tag; for the person reading the
  // prompt it reads as the heading it stands for: <goal> shows as "Goal", <output_format> as "Output
  // format", and a closing tag -- which means nothing to a reader -- is not shown. The tag itself is
  // in the tooltip, and Source shows the file exactly as it is.
  const XOPEN = /^\s*<([a-zA-Z_][\w.-]*)(?:\s[^>]*)?>\s*$/;
  const XCLOSE = /^\s*<\/([a-zA-Z_][\w.-]*)\s*>\s*$/;
  const tagLabel = (name) => { const s = String(name).replace(/[_-]+/g, ' ').trim(); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };

  /** `depth` is how many tags enclose this one: 0 is a section, anything deeper a label inside one. */
  function xtag(src, depth = 0) {
    const t = String(src).trim();
    if (XCLOSE.test(t)) return `<div class="xtag xclose" title="${esc(t)}"></div>`;
    const open = XOPEN.exec(t);
    if (!open || /\/>$/.test(t)) return `<div class="xtag">${esc(t)}</div>`;
    const label = esc(tagLabel(open[1]));
    return depth === 0
      ? `<h2 class="xsec" title="${esc(t)}">${label}</h2>`
      : `<div class="xtag xsub" title="${esc(t)}">${label}</div>`;
  }

  /** How deep each block sits among the tags around it, so a section reads apart from a label in it. */
  function tagDepths(bs) {
    let depth = 0;
    return bs.map((b) => {
      if (b.kind !== 'xtag') return depth;
      const t = b.src.trim();
      if (XCLOSE.test(t)) { depth = Math.max(0, depth - 1); return depth; }
      if (XOPEN.test(t) && !/\/>$/.test(t)) { depth += 1; return depth - 1; }
      return depth;
    });
  }

  function one(b, depth = 0) {
    switch (b.kind) {
      case 'blank': return '';
      case 'heading': { const m = RE.heading.exec(b.src); const n = m[1].length; return `<h${n}>${inline(m[2])}</h${n}>`; }
      case 'hr': return '<hr>';
      case 'xtag': return xtag(b.src, depth);
      case 'fence': return fence(b.src);
      case 'table': return table(b.src);
      case 'list': return list(b.src);
      case 'quote': return quote(b.src);
      default: return `<p>${paragraph(b.src)}</p>`;
    }
  }

  /**
   * @param md    markdown
   * @param wrap  true to wrap each block in a shell carrying its line range — what the document
   *              editor needs to edit one block, and harmless noise for the read-only preview.
   */
  function render(md, { wrap = false } = {}) {
    const bs = blocks(md);
    const depths = tagDepths(bs);
    if (!wrap) return bs.map((b, i) => one(b, depths[i])).join('\n');
    return bs
      .map((b, i) => (b.kind === 'blank' ? '' : `<div class="blk" data-b="${i}" data-kind="${b.kind}" data-start="${b.start}" data-end="${b.end}" tabindex="0">${one(b, depths[i])}</div>`))
      .join('\n');
  }

  return { blocks, render, inline, esc, paragraph, one };
});
