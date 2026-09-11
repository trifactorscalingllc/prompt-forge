'use strict';
// The three things that touch a TextDocument: read it, write it, open it beside the panel.
// `vscode` is injected so this can be exercised with a fake.
//
// Why writes go through a WorkspaceEdit and not the filesystem: Office Viewer's markdown editor is a
// CustomTextEditorProvider. It re-renders when the TextDocument changes and does NOT watch the file
// on disk, so a disk write while the document is open is invisible and then collides with the
// editor's own dirty model on its next save. It also ignores document changes for ~800 ms after its
// own Cmd+S, hence the echo window below.
const fs = require('node:fs');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function createDocio(vscode, { echoMs = 900, log = null } = {}) {
  const saves = new Map();      // key -> ts of the last save the editor made itself
  const selfSaving = new Set(); // keys whose next save event is ours, not the editor's
  // VS Code lowercases the drive letter in Uri.fsPath; os.homedir() does not. Windows paths are
  // case-insensitive anyway, so compare them that way.
  const key = (p) => (process.platform === 'win32' ? String(p).toLowerCase() : String(p));

  const find = (fsPath) => (vscode.workspace.textDocuments || []).find((d) => d.uri && key(d.uri.fsPath) === key(fsPath)) || null;

  function noteSaved(fsPath, ts = Date.now()) {
    if (selfSaving.has(key(fsPath))) return;
    saves.set(key(fsPath), ts);
  }

  async function readDoc(fsPath) {
    const d = find(fsPath);
    if (d) return d.getText();
    try { return fs.readFileSync(fsPath, 'utf8'); } catch { return null; }
  }

  async function writeDoc(fsPath, text) {
    const d = find(fsPath);
    if (!d) { fs.writeFileSync(fsPath, text); return 'disk'; }
    if (d.getText() === text) return 'none';
    const wait = echoMs - (Date.now() - (saves.get(key(fsPath)) || 0));
    if (wait > 0) await sleep(wait);
    const edit = new vscode.WorkspaceEdit();
    edit.replace(d.uri, new vscode.Range(0, 0, d.lineCount, 0), text);
    const ok = await vscode.workspace.applyEdit(edit);
    if (!ok) {
      if (log) log.warn(`applyEdit refused for ${fsPath}; writing to disk instead`);
      fs.writeFileSync(fsPath, text);
      return 'disk-fallback';
    }
    selfSaving.add(key(fsPath));
    try { await d.save(); } finally { setTimeout(() => selfSaving.delete(key(fsPath)), 50); }
    return 'edit';
  }

  async function openBeside(fsPath, { editor = 'office' } = {}) {
    const uri = vscode.Uri.file(fsPath);
    const office = editor === 'office' && vscode.extensions && vscode.extensions.getExtension('cweijan.vscode-office');
    if (office) {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'cweijan.markdownViewer', { viewColumn: vscode.ViewColumn.Two, preserveFocus: true, preview: false });
      return 'office';
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Two, preserveFocus: true, preview: false });
    return 'text';
  }

  return { readDoc, writeDoc, openBeside, noteSaved, isOpen: (p) => Boolean(find(p)), same: (a, b) => key(a) === key(b) };
}

module.exports = { createDocio };
