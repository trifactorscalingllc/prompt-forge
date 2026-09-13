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
      <button id="new" class="btn small" title="New prompt"><span class="plus">+</span><span class="new-label">New</span></button>
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
            <button id="connect" class="iconbtn ghost named" title="Connect this prompt to the folder this window has open">${ICON.plug}<span id="connect-name"></span></button>
            <button id="settings" class="iconbtn ghost" title="Engine, models, target and document settings">${ICON.gear}</button>
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
              <span id="usage" class="usage" title="Tokens the engine read and wrote for this prompt, summed over every call. Counts toward your plan's rate limits."></span>
            </div>
            <div id="attached" class="attached" hidden></div>
            <div id="compose-box" class="compose-box">
              <textarea id="idea" rows="3" placeholder="Type an idea and press Enter to merge it into the prompt. Shift+Enter for a new line. Paste, drop or clip a screenshot or a file to attach it. Hover a sent idea to edit it." spellcheck="true"></textarea>
              <button id="attach" class="iconbtn ghost clip" title="Attach files or images to this idea. The engine reads what it can, the prompt refers to them by name, and they travel with it when you copy or send.">${ICON.clip}</button>
            </div>
          </section>
        </section>
        <div id="split" class="split" role="separator" tabindex="0" aria-label="Resize the panels" title="Drag to resize. Double-click to even them up."></div>
        <section id="preview" class="col">
          <div class="col-head">
            <span class="col-title">Prompt</span>
            <button id="tab-run" class="tabpill" hidden>Run</button>
            <button id="target-btn" class="targetpick" aria-haspopup="listbox" aria-expanded="false" title="The model this prompt is being written for. Click to change it."><span id="target-label"></span>${ICON.caret}</button>
            <div class="col-actions">
              <button id="polish" class="iconbtn" title="Rewrite the document in the target model&#39;s preferred style. After the first polish only what changed is rewritten; Alt+click rewrites all of it.">${ICON.hammer}</button>
              <button id="run" class="iconbtn" title="Send this prompt to a model and show the answer. Costs one call.">${ICON.send}</button>
              <button id="send-claude" class="iconbtn" aria-haspopup="listbox" aria-expanded="false" title="Send to Claude Code: a terminal running Claude, a conversation in this project, or a new one. It lands in the input box; nothing is submitted until you press Enter there.">${ICON.terminal}</button>
              <button id="send-update" class="iconbtn addon" hidden>${ICON.terminal}<span id="send-update-count"></span></button>
              <button id="copy-new" class="iconbtn swap addon" hidden><span class="i-off">${ICON.copyPlus}</span><span class="i-on">${ICON.check}</span><span id="copy-new-count"></span></button>
              <button id="copy" class="iconbtn swap" title="Copy the final prompt to the clipboard"><span class="i-off">${ICON.copy}</span><span class="i-on">${ICON.check}</span></button>
              <button id="open-doc" class="iconbtn" title="Edit the document by hand in the editor">${ICON.pencil}</button>
            </div>
          </div>
          <div id="doc" class="doc"></div>
          <div id="vars" class="vars" hidden></div>
          <div id="target-menu" class="floating" role="listbox" hidden></div>
          <div id="send-menu" class="floating send-menu" role="listbox" hidden></div>
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
  // A send dart, not a play triangle: this hands the prompt to a model, it does not start a process.
  // Filled rather than stroked — a 14px outline of this shape reads as an arbitrary polygon, and the
  // fold line is what makes it a paper plane rather than a kite.
  send: '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M14.9 1.1a.5.5 0 0 0-.54-.11L1.5 6.2a.45.45 0 0 0 .02.84l5.1 1.85 1.85 5.1a.45.45 0 0 0 .84.02L15.01 1.65a.5.5 0 0 0-.11-.55z"/><path fill="none" stroke="var(--vscode-sideBar-background)" stroke-width="1.1" stroke-linecap="round" d="M14.6 1.4 6.85 8.85"/></svg>',
  copyPlus: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="5.6" y="5.6" width="8" height="8.8" rx="1.1"/><path d="M10.6 2.6H3.5a1 1 0 0 0-1 1v7.1"/><path d="M9.6 10h4M11.6 8v4"/></svg>',
  check: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 8.4 6.4 11.8 13 4.6"/></svg>',
  gear: '<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" fill-rule="evenodd"><path d="M6.55 1h2.9l.26 1.72c.35.12.68.26.99.45l1.4-1.03 2.05 2.05-1.03 1.4c.19.31.33.64.45.99L15.29 6.9v2.9l-1.72.26c-.12.35-.26.68-.45.99l1.03 1.4-2.05 2.05-1.4-1.03c-.31.19-.64.33-.99.45L9.45 15.7h-2.9l-.26-1.72a4.9 4.9 0 0 1-.99-.45l-1.4 1.03-2.05-2.05 1.03-1.4a4.9 4.9 0 0 1-.45-.99L.71 9.86V6.96l1.72-.26c.12-.35.26-.68.45-.99L1.85 4.31 3.9 2.26l1.4 1.03c.31-.19.64-.33.99-.45zM8 5.6a2.4 2.4 0 1 0 0 4.8 2.4 2.4 0 0 0 0-4.8z"/></svg>',
  caret: '<svg viewBox="0 0 16 16" width="10" height="10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m4 6.5 4 4 4-4"/></svg>',
  pencil: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M11.3 2.2 13.8 4.7 5.6 12.9 2.6 13.4l.5-3z"/></svg>',
  clip: '<svg viewBox="0 0 16 16" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M13.4 7.4 8 12.8a3.3 3.3 0 0 1-4.7-4.7l5.8-5.8a2.2 2.2 0 0 1 3.1 3.1L6.4 11.2a1.1 1.1 0 0 1-1.6-1.6l5.2-5.2"/></svg>',
  // A terminal prompt: this puts the prompt into Claude Code, where the work happens.
  terminal: '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4"/><path d="m4.6 6.2 2 1.8-2 1.8M8.2 10h3.2"/></svg>',
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
