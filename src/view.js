'use strict';
// The pages: the Prompt Forge panel, and the built-in document editor. HOT: changes here land
// without a host restart.
const path = require('node:path');
const fs = require('node:fs');

/**
 * `stamp` busts the asset cache. Without it a reload refreshes the extension's logic while the
 * webview keeps the media/panel.js it already loaded: new backend, stale UI.
 */
function assets({ vscode, webview, mediaRoots, stamp }) {
  return (f) => {
    const root = mediaRoots.find((r) => fs.existsSync(path.join(r, f))) || mediaRoots[0];
    return `${webview.asWebviewUri(vscode.Uri.file(path.join(root, f)))}?v=${stamp}`;
  };
}

const nonceOf = () => String(Math.random()).slice(2) + String(Date.now());

function html({ vscode, webview, mediaRoots, stamp }) {
  const asset = assets({ vscode, webview, mediaRoots, stamp });
  const nonce = nonceOf();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('panel.css')}" rel="stylesheet">
<title>Prompt Forge</title>
</head>
<body>
<div id="app">
  <aside id="rail">
    <div class="rail-head">
      <button id="rail-toggle" class="icon-btn" title="Collapse the prompts list" aria-expanded="true" aria-controls="prompts">‹</button>
      <span class="rail-title">Prompts</span>
      <button id="new" class="btn small" title="New prompt">+ New</button>
    </div>
    <div id="prompts"></div>
    <button id="open-library" class="link">Open library folder</button>
  </aside>
  <main id="main">
    <div id="empty" class="empty" hidden></div>
    <section id="work" class="work" hidden>
      <header id="head">
        <div class="head-row">
          <h1 id="title" title="Click to rename">Prompt Forge</h1>
          <input id="title-edit" class="title-edit" type="text" spellcheck="false" autocomplete="off" hidden>
          <div class="head-actions">
            <button id="connect" class="iconbtn named" title="Connect this prompt to the folder this window has open">${ICON.plug}<span id="connect-name"></span></button>
            <label class="lbl">Target
              <select id="target" title="The model this prompt is being written for"></select>
            </label>
            <button id="settings" class="iconbtn" title="Engine, models, target and document settings">${ICON.gear}</button>
          </div>
        </div>
        <div class="head-row sub">
          <button id="engine-summary" class="link engine" title="Which account runs the engine. Click to change."></button>
          <span id="status" class="status"></span>
        </div>
      </header>
      <section id="engine" class="settings" hidden></section>
      <div id="columns" class="columns">
        <section id="ideas" class="col">
          <div class="col-head">
            <span class="col-title">Ideas</span>
            <span id="ideas-meta" class="muted small-text"></span>
            <button id="versions" class="link small-text"></button>
          </div>
          <section id="conflicts" class="conflicts" hidden></section>
          <section id="history" class="chat"></section>
          <section id="compose">
            <div class="compose-head">
              <span class="hint">Enter merges the idea into the prompt. Hover a sent idea to edit it.</span>
              <span id="usage" class="usage" title="Tokens the engine read and wrote for this prompt, summed over every call. Counts toward your plan's rate limits."></span>
            </div>
            <textarea id="idea" rows="3" placeholder="Type an idea and press Enter. Shift+Enter for a new line." spellcheck="true"></textarea>
          </section>
        </section>
        <div id="split" class="split" role="separator" tabindex="0" aria-label="Resize the panels" title="Drag to resize. Double-click to even them up."></div>
        <section id="preview" class="col">
          <div class="col-head">
            <span class="col-title">Prompt</span>
            <span id="preview-meta" class="muted small-text"></span>
            <button id="polish" class="iconbtn" title="Rewrite the whole document in the target model&#39;s preferred style">${ICON.hammer}</button>
            <button id="copy" class="iconbtn swap" title="Copy the final prompt to the clipboard"><span class="i-off">${ICON.copy}</span><span class="i-on">${ICON.check}</span></button>
            <button id="open-doc" class="iconbtn" title="Edit the document by hand in the editor">${ICON.pencil}</button>
          </div>
          <div id="doc" class="doc"></div>
          <div class="col-foot">
            <div id="notice" class="notice" hidden></div>
            <span id="doc-count" class="muted small-text"></span>
          </div>
        </section>
      </div>
    </section>
  </main>
</div>
<script nonce="${nonce}" src="${asset('md.js')}"></script>
<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
}

// Inline SVG rather than a codicon font: the webview would have to ship and load the font, and
// these inherit currentColor, so they follow the VS Code theme on their own.
const ICON = {
  plug: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 1.5v3.5M10 1.5v3.5"/><path d="M4 5h8v2.8a4 4 0 0 1-8 0z"/><path d="M8 11.8v2.7"/></svg>',
  hammer: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M10.8 1.7 14.3 5.2 12 7.5 8.5 4z"/><path d="M8.8 5.7 2.9 11.6a1.45 1.45 0 1 0 2 2l5.9-5.9"/></svg>',
  copy: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.6" y="5.6" width="8" height="8.8" rx="1.1"/><path d="M10.6 2.6H3.5a1 1 0 0 0-1 1v7.1"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.4 6.4 11.8 13 4.6"/></svg>',
  gear: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.2"/><path d="M8 1.4v1.9M8 12.7v1.9M14.6 8h-1.9M3.3 8H1.4M12.66 3.34l-1.35 1.35M4.69 11.31l-1.35 1.35M12.66 12.66l-1.35-1.35M4.69 4.69 3.34 3.34"/></svg>',
  pencil: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.2 13.8 4.7 5.6 12.9 2.6 13.4l.5-3z"/></svg>',
};

/** The built-in document editor, shown by the `promptForge.markdown` custom editor. */
function docHtml({ vscode, webview, mediaRoots, stamp, title = 'Prompt' }) {
  const asset = assets({ vscode, webview, mediaRoots, stamp });
  const nonce = nonceOf();
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; img-src ${webview.cspSource};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${asset('doc.css')}" rel="stylesheet">
<title>${esc(title)}</title>
</head>
<body>
<div id="bar">
  <span id="name">${esc(title)}</span>
  <span id="hint"></span>
  <span class="sp"></span>
  <span class="segs">
    <button class="seg" data-mode="formatted" title="The document, formatted. Click any part to edit it.">Formatted</button>
    <button class="seg" data-mode="source" title="The raw markdown">Source</button>
  </span>
  <button id="copy" class="btn" title="Copy the whole document">Copy</button>
  <button id="panel" class="btn" title="Open the Prompt Forge panel">Panel</button>
  <button id="text" class="btn" title="Reopen this file in the plain text editor">Text</button>
</div>
<div id="notice" class="notice" hidden></div>
<div id="view"></div>
<textarea id="source" spellcheck="false" hidden></textarea>
<script nonce="${nonce}" src="${asset('md.js')}"></script>
<script nonce="${nonce}" src="${asset('doc.js')}"></script>
</body>
</html>`;
}

module.exports = { html, docHtml };
