'use strict';
// The built-in document editor: a formatted view of the prompt that is also editable, with no
// third-party extension involved. HOT — changes here land without a host restart.
//
// The webview is created by VS Code for the `promptForge.markdown` custom editor and handed to us
// by the cold shell, which also re-attaches every live one after a reload. Writes go back through
// docio, the same path the engine uses, so the panel, the editor and the file never disagree.
const path = require('node:path');

const norm = (t) => String(t == null ? '' : t).replace(/\r\n?/g, '\n');

/**
 * Put `next` in place of the lines [start, end) that held `base`.
 *
 * The block ranges the webview quotes come from the text it last rendered, and the engine may have
 * rewritten the document since. So the range is a hint: it is used only when the lines there are
 * still exactly `base`. Otherwise the block is found by its text, and only if that text appears
 * once — anything less certain is refused rather than guessed, which is the whole premise of the
 * extension.
 *
 * @returns {{ok: true, text: string} | {ok: false, reason: 'drift'|'gone'}}
 */
function replaceBlock(text, { start, end, base, next }) {
  const src = norm(text);
  const want = norm(base);
  const put = norm(next);
  const lines = src.split('\n');
  const drop = put.trim() === '';

  const splice = (from, to) => {
    const copy = lines.slice();
    if (drop) {
      let last = to;
      if (last < copy.length && !String(copy[last]).trim()) last += 1;   // take the blank line with it
      copy.splice(from, last - from);
    } else {
      copy.splice(from, to - from, ...put.split('\n'));
    }
    return copy.join('\n');
  };

  if (Number.isInteger(start) && Number.isInteger(end) && start >= 0 && end <= lines.length && lines.slice(start, end).join('\n') === want) {
    return { ok: true, text: splice(start, end) };
  }
  if (!want) return { ok: false, reason: 'gone' };
  const at = src.indexOf(want);
  if (at === -1) return { ok: false, reason: 'gone' };
  if (src.indexOf(want, at + want.length) !== -1) return { ok: false, reason: 'drift' };
  const before = src.slice(0, at);
  const from = before.split('\n').length - 1;
  return { ok: true, text: splice(from, from + want.split('\n').length) };
}

/** Put `text` at the end of the document, one blank line clear of whatever is already there. */
function appendBlock(text, next) {
  const body = norm(text).replace(/\s+$/, '');
  const add = norm(next).trim();
  if (!add) return norm(text);
  return body ? `${body}\n\n${add}\n` : `${add}\n`;
}

function createDocEditors({ vscode, docio, log, docHtml, mediaRoots }) {
  const live = new Map();   // panel -> dispose()

  async function attach(document, panel, gen) {
    detach(panel);
    const subs = [];
    const uri = document.uri;
    const key = uri.toString();

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: mediaRoots().map((r) => vscode.Uri.file(r)),
    };
    panel.webview.html = docHtml({
      vscode,
      webview: panel.webview,
      mediaRoots: mediaRoots(),
      stamp: `${gen}-${Date.now()}`,
      title: path.basename(uri.fsPath),
    });

    let timer = null;
    const post = () => panel.webview.postMessage({
      type: 'doc',
      text: document.getText(),
      name: path.basename(uri.fsPath),
      dirty: document.isDirty === true,
    });
    const postSoon = () => { clearTimeout(timer); timer = setTimeout(post, 60); };
    const notice = (level, text) => panel.webview.postMessage({ type: 'notice', level, text });

    subs.push(vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document && e.document.uri && e.document.uri.toString() === key) postSoon();
    }));

    subs.push(panel.webview.onDidReceiveMessage(async (m) => {
      if (!m || !m.type) return;
      try {
        switch (m.type) {
          case 'ready':
            post();
            return;
          case 'edit': {
            const r = replaceBlock(document.getText(), m);
            if (!r.ok) {
              notice('error', r.reason === 'drift'
                ? 'That text now appears more than once, so nothing was changed. Edit it in Source view.'
                : 'That block is gone — the document changed underneath you. Nothing was changed.');
              post();
              return;
            }
            await docio.writeDoc(uri.fsPath, r.text);
            return;
          }
          case 'append': {
            if (typeof m.text !== 'string' || !m.text.trim()) return;
            await docio.writeDoc(uri.fsPath, appendBlock(document.getText(), m.text));
            return;
          }
          case 'replaceAll':
            if (typeof m.text !== 'string') return;
            if (norm(m.text) === norm(document.getText())) return;
            await docio.writeDoc(uri.fsPath, norm(m.text));
            return;
          case 'copy':
            await vscode.env.clipboard.writeText(document.getText());
            notice('info', 'Copied the whole document.');
            return;
          case 'openText':
            await vscode.commands.executeCommand('vscode.openWith', uri, 'default');
            return;
          case 'openPanel':
            await vscode.commands.executeCommand('promptForge.open');
            return;
          case 'openUrl':
            if (typeof m.url === 'string' && /^(https?|mailto):/i.test(m.url)) await vscode.env.openExternal(vscode.Uri.parse(m.url));
            return;
          default:
            return;
        }
      } catch (e) {
        log.error(`doc editor ${m.type} failed: ${e.stack || e.message}`);
        notice('error', `${m.type} failed: ${e.message || e}`);
      }
    }));

    live.set(panel, () => { clearTimeout(timer); for (const s of subs) { try { s.dispose(); } catch { /* already gone */ } } });
    post();
  }

  function detach(panel) {
    const off = live.get(panel);
    if (off) { off(); live.delete(panel); }
  }

  return {
    attach,
    detach,
    count: () => live.size,
    dispose() { for (const off of live.values()) off(); live.clear(); },
  };
}

module.exports = { createDocEditors, replaceBlock, appendBlock };
