/* eslint-env browser */
// The built-in document editor. Vanilla DOM, no build step, no third-party editor: the formatted
// view IS the editor. Click any block to edit that block's markdown, or switch to Source for the
// whole file.
//
// The one rule that keeps it honest: the extension owns the text. This page never holds a private
// copy it later flushes — every commit is sent, and the next `doc` message is the truth.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const MD = window.ForgeMD;
  const $ = (id) => document.getElementById(id);

  const view = $('view');
  const source = $('source');
  const hint = $('hint');
  const notice = $('notice');

  const saved = vscode.getState() || {};
  let mode = saved.mode === 'source' ? 'source' : 'formatted';
  let text = '';
  let blocks = [];
  let editing = null;     // { index, start, end, base, el }
  let pending = null;     // a doc update that arrived while a block was open
  let noticeTimer = null;
  let sourceTimer = null;

  const saveState = () => vscode.setState({ mode });

  function say(level, msg) {
    notice.textContent = msg;
    notice.className = `notice ${level}`;
    notice.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { notice.hidden = true; }, level === 'error' ? 7000 : 2500);
  }

  // ------------------------------------------------------------------------------------------
  // Rendering
  // ------------------------------------------------------------------------------------------
  function render() {
    if (mode === 'source') {
      view.hidden = true;
      source.hidden = false;
      if (document.activeElement !== source) source.value = text;
      hint.textContent = 'Raw markdown. Changes save as you stop typing.';
      return;
    }
    source.hidden = true;
    view.hidden = false;
    const top = view.scrollTop;
    blocks = MD.blocks(text);
    if (!text.trim()) {
      view.innerHTML = '<div class="blank"><p>This prompt is empty.</p><p class="muted">Add ideas in the Prompt Forge panel, or click below to write straight into the document.</p></div>';
    } else {
      view.innerHTML = MD.render(text, { wrap: true });
    }
    const add = document.createElement('button');
    add.className = 'add';
    add.textContent = '+ Add a paragraph';
    add.addEventListener('click', openAppend);
    view.appendChild(add);
    view.scrollTop = top;
    hint.textContent = 'Click any part of the document to edit it.';
  }

  // ------------------------------------------------------------------------------------------
  // Editing one block
  // ------------------------------------------------------------------------------------------
  function autosize(ta) {
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(ta.scrollHeight, 28)}px`;
  }

  function box(value) {
    const ta = document.createElement('textarea');
    ta.className = 'blkedit';
    ta.spellcheck = true;
    ta.value = value;
    ta.addEventListener('input', () => autosize(ta));
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); cancel(); return; }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); commit(ta); }
    });
    ta.addEventListener('blur', () => { if (editing && editing.el === ta) commit(ta); });
    return ta;
  }

  function openBlock(el) {
    if (editing) return;
    const i = Number(el.dataset.b);
    const b = blocks[i];
    if (!b) return;
    const ta = box(b.src);
    editing = { index: i, start: b.start, end: b.end, base: b.src, el: ta, append: false };
    el.replaceWith(ta);
    autosize(ta);
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
    hint.textContent = 'Enter adds a line. Cmd/Ctrl+Enter or click away saves. Esc cancels.';
  }

  function openAppend() {
    if (editing) return;
    const ta = box('');
    editing = { append: true, el: ta };
    view.insertBefore(ta, view.lastChild);
    autosize(ta);
    ta.focus();
    hint.textContent = 'Enter adds a line. Cmd/Ctrl+Enter or click away saves. Esc cancels.';
  }

  function done() {
    editing = null;
    if (pending != null) { text = pending; pending = null; }
    render();
  }

  function cancel() { done(); }

  function commit(ta) {
    if (!editing || editing.el !== ta) return;
    const next = ta.value;
    const { append, base, start, end } = editing;
    editing = null;
    if (append) {
      if (next.trim()) vscode.postMessage({ type: 'append', text: next });
    } else if (next !== base) {
      vscode.postMessage({ type: 'edit', start, end, base, next });
    }
    done();
  }

  view.addEventListener('click', (e) => {
    const link = e.target.closest('a[href]');
    if (link) { e.preventDefault(); vscode.postMessage({ type: 'openUrl', url: link.getAttribute('href') }); return; }
    if (editing) return;
    const blk = e.target.closest('.blk');
    if (blk) openBlock(blk);
  });
  view.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || editing) return;
    const blk = e.target.closest && e.target.closest('.blk');
    if (blk) { e.preventDefault(); openBlock(blk); }
  });

  // ------------------------------------------------------------------------------------------
  // Source mode
  // ------------------------------------------------------------------------------------------
  source.addEventListener('input', () => {
    clearTimeout(sourceTimer);
    sourceTimer = setTimeout(() => vscode.postMessage({ type: 'replaceAll', text: source.value }), 500);
  });
  source.addEventListener('blur', () => {
    clearTimeout(sourceTimer);
    vscode.postMessage({ type: 'replaceAll', text: source.value });
  });

  function setMode(next) {
    if (editing) { editing = null; }
    mode = next;
    saveState();
    for (const b of document.querySelectorAll('.seg')) b.classList.toggle('on', b.dataset.mode === mode);
    render();
  }

  for (const b of document.querySelectorAll('.seg')) {
    b.classList.toggle('on', b.dataset.mode === mode);
    b.addEventListener('click', () => setMode(b.dataset.mode));
  }
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  $('panel').addEventListener('click', () => vscode.postMessage({ type: 'openPanel' }));
  $('text').addEventListener('click', () => vscode.postMessage({ type: 'openText' }));

  // ------------------------------------------------------------------------------------------
  window.addEventListener('message', (e) => {
    const m = e.data || {};
    if (m.type === 'doc') {
      // A merge landing mid-edit must not yank the box out from under the cursor: hold it.
      if (editing) { pending = m.text; say('info', 'The document changed. Your edit is still open.'); return; }
      text = m.text == null ? '' : m.text;
      if (m.name) $('name').textContent = m.name;
      render();
      return;
    }
    if (m.type === 'notice') say(m.level || 'info', m.text);
  });

  vscode.postMessage({ type: 'ready' });
}());
