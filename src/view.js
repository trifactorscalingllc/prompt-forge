'use strict';
// The page. HOT: changes here land without a host restart.
const path = require('node:path');
const fs = require('node:fs');

/**
 * `stamp` busts the asset cache. Without it a reload refreshes the extension's logic while the
 * webview keeps the media/panel.js it already loaded: new backend, stale UI.
 */
function html({ vscode, webview, mediaRoots, stamp }) {
  const asset = (f) => {
    const root = mediaRoots.find((r) => fs.existsSync(path.join(r, f))) || mediaRoots[0];
    return `${webview.asWebviewUri(vscode.Uri.file(path.join(root, f)))}?v=${stamp}`;
  };
  const nonce = String(Math.random()).slice(2) + String(Date.now());
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
      <span class="rail-title">Prompts</span>
      <button id="new" class="btn small" title="New prompt">+ New</button>
    </div>
    <div id="prompts"></div>
    <button id="open-library" class="link">Open library folder</button>
  </aside>
  <main id="main">
    <header id="head">
      <div class="head-row">
        <h1 id="title">Prompt Forge</h1>
        <div class="head-actions">
          <label class="lbl">Target
            <select id="target" title="The model this prompt is being written for"></select>
          </label>
          <button id="polish" class="btn" title="Rewrite the whole document in the target model's preferred style">Polish</button>
          <button id="copy" class="btn primary" title="Copy the final prompt to the clipboard">Copy</button>
        </div>
      </div>
      <div class="head-row sub">
        <button id="engine-summary" class="link engine" title="Which account runs the engine. Click to change."></button>
        <span id="status" class="status"></span>
      </div>
      <div id="notice" class="notice" hidden></div>
    </header>
    <div id="empty" class="empty" hidden></div>
    <section id="engine" class="engine-section" hidden></section>
    <section id="conflicts" class="conflicts" hidden></section>
    <section id="compose">
      <textarea id="idea" rows="3" placeholder="Type an idea and press Enter. Shift+Enter for a new line." spellcheck="true"></textarea>
      <div class="compose-foot">
        <span class="hint">Enter merges the idea into the document beside this panel. Nothing is ever added as a loose bullet.</span>
        <button id="open-doc" class="link">Open document</button>
      </div>
    </section>
    <section id="history"></section>
    <footer id="usage" class="usage"></footer>
  </main>
</div>
<script nonce="${nonce}" src="${asset('panel.js')}"></script>
</body>
</html>`;
}

module.exports = { html };
