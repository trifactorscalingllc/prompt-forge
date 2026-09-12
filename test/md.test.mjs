// The shared markdown renderer. Two things matter beyond "it renders": block ranges must cover the
// document exactly (the editor writes back by line range), and nothing a model wrote may become
// live HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const md = require('../media/md.js');

const DOC = `# Goal

Ship **one** prompt.

## Requirements

- first
  - nested
- second with \`code\`
- [ ] open task
- [x] done task

1. one
2. two

| Setting | Default |
|---|--:|
| a | 1 |

> quoted
> still quoted

---

\`\`\`js
const x = 1 < 2;
\`\`\`

<instructions>

Read https://example.com and [the docs](https://docs.example.com).
`;

test('blocks cover every line exactly once, in order', () => {
  const bs = md.blocks(DOC);
  const lines = DOC.replace(/\r\n?/g, '\n').split('\n');
  let at = 0;
  for (const b of bs) {
    assert.equal(b.start, at, `block ${b.kind} starts where the last one ended`);
    assert.ok(b.end > b.start, 'no empty block');
    assert.equal(b.src, lines.slice(b.start, b.end).join('\n'));
    at = b.end;
  }
  assert.equal(at, lines.length, 'the last block reaches the end of the document');
});

test('every block kind is recognised', () => {
  const kinds = md.blocks(DOC).map((b) => b.kind);
  for (const k of ['heading', 'para', 'list', 'table', 'quote', 'hr', 'fence', 'xtag']) {
    assert.ok(kinds.includes(k), `${k} recognised`);
  }
});

test('structure renders: headings, nesting, ordered lists, tasks, tables, quotes, fences', () => {
  const html = md.render(DOC);
  assert.match(html, /<h1>Goal<\/h1>/);
  assert.match(html, /<strong>one<\/strong>/);
  assert.match(html, /<ul><li>first<ul><li>nested<\/li><\/ul><\/li>/);
  assert.match(html, /<ol><li>one<\/li><li>two<\/li><\/ol>/);
  assert.match(html, /class="task"/);
  assert.match(html, /class="task done"/);
  assert.match(html, /<th>Setting<\/th>/);
  assert.match(html, /<td style="text-align:right">1<\/td>/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<pre data-lang="js">/);
  assert.match(html, /<div class="xtag">&lt;instructions&gt;<\/div>/);
});

test('a fence keeps its body verbatim and escaped', () => {
  const html = md.render(DOC);
  assert.match(html, /<code>const x = 1 &lt; 2;<\/code>/);
});

test('markup inside the document cannot become live HTML', () => {
  const html = md.render('Hi <img src=x onerror="alert(1)"> **b**\n\n<script>alert(2)</script>\n');
  assert.ok(!html.includes('<img'), 'no raw img');
  assert.ok(!html.includes('<script'), 'no raw script');
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /<strong>b<\/strong>/);
});

test('a link title cannot smuggle a tag, and only http and mailto become links', () => {
  const html = md.render('[<b>x</b>](https://e.com) and [bad](javascript:alert(1))');
  assert.match(html, /<a href="https:\/\/e.com">&lt;b&gt;x&lt;\/b&gt;<\/a>/);
  // A scheme we do not trust is left as the literal text it was, never turned into an anchor.
  assert.ok(!/<a [^>]*javascript:/i.test(html), 'no javascript: anchor');
  assert.match(html, /\[bad\]\(javascript:alert\(1\)\)/);
});

test('emphasis rules do not reach inside code spans', () => {
  const html = md.render('use `a * b * c` and *this*');
  assert.match(html, /<code>a \* b \* c<\/code>/);
  assert.match(html, /<em>this<\/em>/);
});

test('wrapped lines join with a space; two trailing spaces break the line', () => {
  assert.equal(md.render('one\ntwo'), '<p>one two</p>');
  assert.equal(md.render('one  \ntwo'), '<p>one<br>two</p>');
});

test('wrap mode carries the line range of every non-blank block', () => {
  const html = md.render('# A\n\nbody\n', { wrap: true });
  assert.match(html, /<div class="blk" data-b="0" data-kind="heading" data-start="0" data-end="1"/);
  assert.match(html, /data-kind="para" data-start="2" data-end="3"/);
});

test('empty, blank and CRLF input do not throw', () => {
  for (const v of ['', null, undefined, '\n\n\n', 'a\r\nb\r\n']) {
    assert.equal(typeof md.render(v), 'string');
    assert.ok(Array.isArray(md.blocks(v)));
  }
});

test('an unclosed fence still renders as code rather than swallowing the page', () => {
  const html = md.render('```\nunclosed\n');
  assert.match(html, /<pre><code>unclosed/);
});
