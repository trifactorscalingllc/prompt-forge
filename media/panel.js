/* eslint-env browser */
// The panel. Vanilla DOM: this file ships inside a vsix with no build step. Lists are rebuilt on
// every state message (they are small); the idea box is static so a repaint never eats a draft.
(function () {
  'use strict';
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

  const idea = $('idea');
  const saved = vscode.getState() || {};
  let latest = null;
  let engineOpen = Boolean(saved.engineOpen);
  let versionsOpen = Boolean(saved.versionsOpen);
  const customModels = saved.customModels || {};
  if (saved.draft) idea.value = saved.draft;

  function save() {
    vscode.setState({ draft: idea.value, engineOpen, versionsOpen, customModels });
  }

  const ago = (ts) => {
    if (!ts) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return new Date(ts).toLocaleDateString();
  };
  const k = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));

  // ------------------------------------------------------------------------------------------
  // Rail
  // ------------------------------------------------------------------------------------------
  function renderRail(s) {
    const root = $('prompts');
    root.textContent = '';
    if (!s.prompts.length) { root.append(el('p', 'muted', 'No prompts yet.')); return; }
    for (const p of s.prompts) {
      const row = el('div', `prow${s.active && s.active.slug === p.slug ? ' selected' : ''}`);
      row.tabIndex = 0;
      const name = el('span', 'pname', p.title);
      const meta = el('span', 'pmeta', `${p.entries} idea${p.entries === 1 ? '' : 's'}${p.openConflicts ? ` · ${p.openConflicts} open` : ''}`);
      const del = el('button', 'x', '×');
      del.title = 'Delete this prompt';
      del.addEventListener('click', (e) => { e.stopPropagation(); vscode.postMessage({ type: 'deletePrompt', slug: p.slug }); });
      row.append(name, meta, del);
      row.addEventListener('click', () => vscode.postMessage({ type: 'openPrompt', slug: p.slug }));
      row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); row.click(); } });
      root.append(row);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Header
  // ------------------------------------------------------------------------------------------
  function renderHeader(s) {
    const a = s.active;
    $('title').textContent = a ? a.title : 'Prompt Forge';
    $('title').classList.toggle('editable', Boolean(a));
    const sel = $('target');
    const want = a ? a.target : '';
    sel.textContent = '';
    let known = false;
    for (const t of s.targets) {
      const o = el('option', null, t.label);
      o.value = t.id;
      if (t.id === want) { o.selected = true; known = true; }
      sel.append(o);
    }
    if (want && !known) { const o = el('option', null, want); o.value = want; o.selected = true; sel.append(o); }
    sel.disabled = !a;
    sel.title = (s.blurbs && s.blurbs.targets && s.blurbs.targets[want]) ? `${s.blurbs.roles.target}\n${s.blurbs.targets[want]}` : (s.blurbs && s.blurbs.roles.target) || '';
    $('polish').disabled = !a;
    $('copy').disabled = !a;

    const e = s.engine;
    const summary = $('engine-summary');
    summary.textContent = '';
    const blurbs = s.blurbs || { roles: {}, models: {}, targets: {} };
    const part = (text, tip) => { const sp = el('span', 'epart', text); if (tip) sp.title = tip; summary.append(sp); };
    if (e.selected) {
      const p = e.providers.find((x) => x.id === e.selected.provider) || {};
      const who = e.selected.mode === 'cli' ? (p.cli && p.cli.account ? p.cli.account : 'CLI login') : 'API key';
      const plan = e.selected.mode === 'cli' && p.cli && p.cli.plan ? ` · ${p.cli.plan}` : '';
      part(`Engine: ${p.label || e.selected.provider} · ${who}${plan}`, blurbs.roles.provider);
      part(` · merge ${e.selected.mergeModel}`, `${blurbs.roles.merge || ''}\n${blurbs.models[e.selected.mergeModel] || ''}`);
      part(` · polish ${e.selected.polishModel}`, `${blurbs.roles.polish || ''}\n${blurbs.models[e.selected.polishModel] || ''}`);
      part(' · change', 'Open Settings');
      summary.classList.remove('bad');
    } else {
      part(`No engine: ${e.reason || 'sign in'}`, 'Open Settings to sign in or add a key');
      summary.classList.add('bad');
    }

    const st = $('status');
    const ae = a ? a.engine : null;
    st.textContent = '';
    st.className = 'status';
    if (!a) return;
    if (ae.state === 'busy') {
      st.classList.add('busy');
      st.append(el('span', 'pulse'), el('span', null, `${ae.op === 'polish' ? 'polishing' : 'merging'}${ae.model ? ` · ${ae.model}` : ''}${ae.queued ? ` · ${ae.queued} queued` : ''}`));
    } else if (ae.state === 'error') {
      st.classList.add('bad');
      st.append(el('span', null, `error: ${ae.error}`));
      const retry = el('button', 'btn small', 'Retry');
      retry.addEventListener('click', () => vscode.postMessage({ type: 'retry' }));
      st.append(retry);
    } else {
      st.append(el('span', 'muted', ae.queued ? `${ae.queued} queued` : 'idle'));
    }
  }

  // ------------------------------------------------------------------------------------------
  // Engine section
  // ------------------------------------------------------------------------------------------
  function renderEngine(s) {
    const root = $('engine');
    root.hidden = !engineOpen;
    $('columns').hidden = engineOpen;
    root.textContent = '';
    $('settings').classList.toggle('active', engineOpen);
    if (!engineOpen) return;
    const e = s.engine;
    const blurbs = s.blurbs || { roles: {}, models: {}, targets: {} };
    const blurbFor = (id) => blurbs.models[id] || 'Custom id, passed through unchanged.';
    const cur = e.selected ? e.providers.find((x) => x.id === e.selected.provider) : null;

    // Left: sections. Right: rows. Each row is title, one line, control.
    const nav = el('nav', 'snav');
    const body = el('div', 'sbody');
    const sections = [['engine', 'Engine'], ['models', 'Models'], ['target', 'Target'], ['layout', 'Layout'], ['document', 'Document']];
    const anchors = {};
    for (const [id, label] of sections) {
      const b = el('button', 'snav-item', label);
      b.addEventListener('click', () => { if (anchors[id]) anchors[id].scrollIntoView({ block: 'start', behavior: 'smooth' }); });
      nav.append(b);
    }
    const back = el('button', 'btn small', 'Done');
    back.addEventListener('click', () => { engineOpen = false; save(); if (latest) render(latest); });
    nav.append(el('div', 'snav-spacer'), back);

    const section = (id, title, extra) => { const h = el('h3', 'shead', title); anchors[id] = h; if (extra) h.append(extra); body.append(h); };
    const row = (title, desc, control) => {
      const r = el('div', 'srow');
      r.append(el('div', 'stitle', title));
      if (desc) r.append(el('div', 'sdesc', desc));
      if (control) { const c = el('div', 'sctl'); c.append(...[].concat(control)); r.append(c); }
      body.append(r);
      return r;
    };
    const select = (options, value, onChange) => {
      const sel = el('select');
      for (const [v, label] of options) { const o = el('option', null, label); o.value = v; if (v === value) o.selected = true; sel.append(o); }
      sel.addEventListener('change', () => onChange(sel));
      return sel;
    };
    const small = (label, tip, onClick) => { const b = el('button', 'btn small', label); if (tip) b.title = tip; b.addEventListener('click', onClick); return b; };

    // --- Engine ---
    const detect = el('button', 'link small-text', 'detect again');
    detect.addEventListener('click', () => vscode.postMessage({ type: 'engine.detect' }));
    section('engine', 'Engine', detect);
    const autoLabel = e.selected && (s.engineCfg.provider || 'auto') === 'auto' ? `auto (${cur ? cur.label : e.selected.provider})` : 'auto';
    row('Engine', blurbs.roles.provider,
      select([['auto', autoLabel], ...e.providers.map((p) => [p.id, p.label])], s.engineCfg.provider || 'auto',
        (sel) => vscode.postMessage({ type: 'engine.select', provider: sel.value, mergeModel: 'auto', polishModel: 'auto' })));
    for (const p of e.providers) {
      const controls = [];
      let status;
      if (p.id === 'compatible') {
        status = p.apiKey.stored ? p.note : 'Not set. Add the base URL under All settings; the key is optional.';
        controls.push(small('Set key', 'Optional. Stored in your OS keychain.', () => vscode.postMessage({ type: 'engine.setKey', provider: p.id })));
      } else {
        if (!p.cli.found) {
          status = 'CLI not installed.';
          if (p.installUrl) controls.push(small('Install', null, () => vscode.postMessage({ type: 'openUrl', url: p.installUrl })));
        } else if (p.cli.loggedIn) {
          status = `Signed in${p.cli.account ? ` as ${p.cli.account}` : ''}${p.cli.plan ? ` · ${p.cli.plan}` : ''} · CLI ${p.cli.version || ''}`;
        } else {
          status = `CLI ${p.cli.version || ''} installed, not signed in.`;
          controls.push(small('Sign in', 'Opens the vendor login in a terminal.', () => vscode.postMessage({ type: 'engine.signIn', provider: p.id, mode: 'cli' })));
        }
        if (p.apiKey.stored) {
          status += ' · API key stored';
          controls.push(small('Forget key', null, () => vscode.postMessage({ type: 'engine.forgetKey', provider: p.id })));
        } else {
          controls.push(small('Set key', 'Pay per token instead of a login. Stored in your OS keychain.', () => vscode.postMessage({ type: 'engine.setKey', provider: p.id })));
        }
      }
      const r = row(p.label + (cur && cur.id === p.id ? '  ·  in use' : ''), status, controls);
      if (cur && cur.id === p.id) r.classList.add('inuse');
    }

    // --- Models ---
    section('models', 'Models');
    if (!cur) {
      row('Merge and polish models', 'Sign in to an engine first.');
    } else {
      for (const role of ['merge', 'polish']) {
        const key = role === 'merge' ? 'mergeModel' : 'polishModel';
        const current = (s.engineCfg && s.engineCfg[key]) || 'auto';
        const resolved = e.selected[key];
        const ids = cur.models.map((m) => m.id);
        const custom = customModels[`${cur.id}.${role}`];
        const opts = [['auto', `auto (${cur.defaults[role] || '?'})`], ...cur.models.map((m) => [m.id, m.label || m.id]), ['__custom', 'type a model id…']];
        if (custom && !ids.includes(custom)) opts.splice(opts.length - 1, 0, [custom, custom]);
        if (current !== 'auto' && !ids.includes(current) && current !== custom) opts.splice(opts.length - 1, 0, [current, current]);
        const r = row(`${role === 'merge' ? 'Merge' : 'Polish'} model`, '', null);
        const desc = r.querySelector('.sdesc') || r.appendChild(el('div', 'sdesc'));
        const describe = (v) => { desc.textContent = `${blurbs.roles[role] || ''} ${v}: ${blurbFor(v)}`; };
        describe(resolved);
        const sel = select(opts, current, (sl) => {
          let v = sl.value;
          if (v === '__custom') {
            v = (window.prompt(`Model id for ${role} on ${cur.label}:`, custom || '') || '').trim();
            if (!v) { sl.value = current; describe(resolved); return; }
            customModels[`${cur.id}.${role}`] = v;
            save();
          }
          describe(v === 'auto' ? cur.defaults[role] : v);
          vscode.postMessage({ type: 'engine.select', provider: cur.id, [key]: v === 'auto' ? 'auto' : v });
        });
        const c = el('div', 'sctl'); c.append(sel); r.append(c);
      }
    }

    // --- Target ---
    section('target', 'Target');
    const a = s.active;
    if (!a) {
      row('Target model', `${blurbs.roles.target || ''} Open a prompt to set its target; each prompt remembers its own.`);
    } else {
      const r = row('Target model', '', null);
      const desc = r.querySelector('.sdesc') || r.appendChild(el('div', 'sdesc'));
      const describe = (v) => { desc.textContent = blurbs.targets[v] || 'Custom target, polished with the Claude style guide.'; };
      describe(a.target);
      const opts = s.targets.map((t) => [t.id, t.label]);
      if (!s.targets.some((t) => t.id === a.target)) opts.push([a.target, a.target]);
      const sel = select(opts, a.target, (sl) => { describe(sl.value); vscode.postMessage({ type: 'setTarget', target: sl.value }); });
      const c = el('div', 'sctl'); c.append(sel); r.append(c);
    }

    // --- Layout ---
    section('layout', 'Layout');
    const lay = withDefaults(s.layout);
    row('Panels', 'How Ideas and Prompt sit next to each other.',
      select([['auto', 'Side by side, stacking when narrow'], ['columns', 'Always side by side'], ['rows', 'Always stacked']], lay.mode,
        (sel) => vscode.postMessage({ type: 'setLayout', mode: sel.value })));
    if (lay.mode === 'auto') {
      row('Stack below', 'Width of the working area, in pixels, at which the panels stack. 0 never stacks.',
        select([[0, 'Never stack'], [480, '480px'], [560, '560px'], [620, '620px (default)'], [720, '720px'], [860, '860px']].map(([v, l]) => [String(v), l]), String(lay.stackWidth),
          (sel) => vscode.postMessage({ type: 'setLayout', stackWidth: Number(sel.value) })));
    }
    row('Split', `Ideas gets ${lay.split}% of the space. Drag the divider between the panels, or double-click it to even them up.`,
      small('Even split', null, () => vscode.postMessage({ type: 'setLayout', split: 50 })));

    // --- Document ---
    section('document', 'Document');
    row('Editor for hand edits', 'Where the pencil opens the prompt file. The built-in one needs nothing installed.',
      select([['forge', 'Prompt Forge editor (formatted, click to edit)'], ['office', 'Office Viewer, if that extension is installed'], ['text', 'Plain text editor']], s.docEditor || 'forge',
        (sel) => vscode.postMessage({ type: 'setDocEditor', value: sel.value })));
    row('Library folder', s.library || '', small('Open folder', null, () => vscode.postMessage({ type: 'openLibrary' })));
    const all = el('button', 'link small-text', 'All settings in VS Code');
    all.addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));
    body.append(all);

    root.append(nav, body);
  }

  // ------------------------------------------------------------------------------------------
  // Prompt panel: the document, rendered by the shared renderer in media/md.js — the same one the
  // built-in document editor uses, so the preview and the editor never disagree about the markdown.
  // Text is escaped there before it is placed, so a prompt cannot script the page.
  // ------------------------------------------------------------------------------------------
  const renderMarkdown = (md) => window.ForgeMD.render(md);

  function renderPreview(s) {
    const a = s.active;
    const root = $('doc');
    const meta = $('preview-meta');
    if (!a) { root.textContent = ''; meta.textContent = ''; return; }
    const tLabel = (s.targets.find((t) => t.id === a.target) || {}).label || a.target;
    meta.textContent = `for ${tLabel}`;
    if (a.docBlank) {
      root.textContent = '';
      const ph = el('div', 'placeholder');
      ph.append(el('h3', null, 'Your prompt builds here.'), el('p', null, 'Every idea you send is merged into this document, and sections appear as they are needed. Click the pencil to edit it by hand at any time.'));
      root.append(ph);
      return;
    }
    root.innerHTML = renderMarkdown(a.doc || '');
  }

  // ------------------------------------------------------------------------------------------
  // Conflicts, history, usage
  // ------------------------------------------------------------------------------------------
  function renderConflicts(s) {
    const root = $('conflicts');
    const list = s.active ? s.active.conflicts : [];
    root.hidden = !list.length;
    root.textContent = '';
    if (!list.length) return;
    root.append(el('div', 'csec-title', `${list.length} open conflict${list.length === 1 ? '' : 's'}. Nothing was assumed; pick a side or edit the document.`));
    for (const c of list) {
      const row = el('div', 'conflict');
      row.append(el('div', 'cwhere', `${c.id} · ${c.section || 'unplaced'}`));
      const pair = el('div', 'cpair');
      const oldB = el('button', 'chip', ''); oldB.append(el('b', null, 'keep old: '), el('span', null, c.existing));
      const newB = el('button', 'chip', ''); newB.append(el('b', null, 'keep new: '), el('span', null, c.incoming));
      oldB.addEventListener('click', () => vscode.postMessage({ type: 'resolve', conflictId: c.id, keep: 'old' }));
      newB.addEventListener('click', () => vscode.postMessage({ type: 'resolve', conflictId: c.id, keep: 'new' }));
      pair.append(oldB, newB);
      row.append(pair);
      root.append(row);
    }
  }

  let editing = null; // entry id being edited inline

  function renderHistory(s) {
    const root = $('history');
    root.textContent = '';
    const a = s.active;
    if (!a) return;
    $('ideas-meta').textContent = a.entries.length ? `${a.entries.length} sent` : '';
    const vt = $('versions');
    vt.textContent = versionsOpen ? 'hide versions' : `versions (${a.snapshots.length})`;
    vt.onclick = () => { versionsOpen = !versionsOpen; save(); if (latest) render(latest); };

    if (versionsOpen) {
      const vl = el('div', 'versions');
      const last = a.snapshots[a.snapshots.length - 1];
      for (const v of a.snapshots.slice().reverse()) {
        const row = el('div', 'vrow');
        row.append(el('span', `vkind ${v.kind}`, v.kind), el('span', 'vwhen', ago(v.ts)));
        if (v.call) row.append(el('span', 'vmeta', `${v.call.provider}/${v.call.model}${v.call.usage ? ` · ${k(v.call.usage.input)}/${k(v.call.usage.output)}` : ''}`));
        if (v.changes && v.changes.length) row.append(el('span', 'vchanges', v.changes.slice(0, 3).join(' · ')));
        if (v.id !== last.id) {
          const rb = el('button', 'link', 'restore');
          rb.addEventListener('click', () => vscode.postMessage({ type: 'restore', snapshotId: v.id }));
          row.append(rb);
        }
        vl.append(row);
      }
      root.append(vl);
    }

    if (!a.entries.length && !versionsOpen) {
      const ph = el('div', 'placeholder');
      ph.append(el('h3', null, 'Your ideas go here.'), el('p', null, 'Type one below and press Enter. Rough is fine: each idea is merged into the prompt on the right, never pasted in as a bullet.'));
      root.append(ph);
      return;
    }
    if (!a.entries.length) return;
    const log = el('div', 'log');
    for (const e of a.entries) {
      const msg = el('div', `msg ${e.status}`);
      msg.dataset.id = e.id;
      const bubble = el('div', 'bubble');
      if (editing === e.id) {
        const ta = el('textarea', 'edit-box');
        ta.value = e.text;
        ta.rows = Math.min(8, Math.max(2, e.text.split('\n').length + 1));
        const acts = el('div', 'edit-actions');
        const ok = el('button', 'btn small primary', 'Re-merge');
        const cancel = el('button', 'btn small', 'Cancel');
        const submit = () => { const t = ta.value.trim(); editing = null; if (t && t !== e.text) vscode.postMessage({ type: 'editIdea', entryId: e.id, text: t }); else if (latest) render(latest); };
        ok.addEventListener('click', submit);
        cancel.addEventListener('click', () => { editing = null; if (latest) render(latest); });
        ta.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) { ev.preventDefault(); submit(); }
          if (ev.key === 'Escape') { ev.preventDefault(); editing = null; if (latest) render(latest); }
        });
        acts.append(ok, cancel);
        bubble.append(ta, acts);
        setTimeout(() => ta.focus(), 0);
      } else {
        bubble.append(el('div', 'mtext', e.text));
      }
      const meta = el('div', 'mmeta');
      const stateText = e.status === 'pending' ? 'merging…' : e.status === 'failed' ? `failed: ${e.error || ''}` : (e.edits && e.edits.length ? `merged · edited ${e.edits.length}×` : 'merged');
      meta.append(el('span', e.status === 'failed' ? 'bad' : null, `${ago(e.ts)} · ${stateText}`));
      const acts = el('div', 'macts');
      if (editing !== e.id && e.status !== 'pending') {
        const edit = el('button', 'icon', '✎');
        edit.title = 'Edit this idea and re-merge the document';
        edit.addEventListener('click', () => { editing = e.id; if (latest) render(latest); });
        acts.append(edit);
      }
      if (e.status === 'failed') {
        const rb = el('button', 'icon', '↻');
        rb.title = 'Retry';
        rb.addEventListener('click', () => vscode.postMessage({ type: 'retry', entryId: e.id }));
        acts.append(rb);
      } else if (e.status === 'merged' && e.snapshotId) {
        const rb = el('button', 'icon', '⟲');
        rb.title = `Put the document back to right after this idea (${e.snapshotId})`;
        rb.addEventListener('click', () => vscode.postMessage({ type: 'restore', snapshotId: e.snapshotId }));
        acts.append(rb);
      }
      msg.append(bubble, meta, acts);
      log.append(msg);
    }
    root.append(log);
    root.scrollTop = root.scrollHeight;
  }

  function renderUsage(s) {
    const root = $('usage');
    const a = s.active;
    if (!a) { root.textContent = ''; return; }
    const u = a.usage;
    root.textContent = u.calls ? `${u.calls} call${u.calls === 1 ? '' : 's'} · ${k(u.input)} in / ${k(u.output)} out` : '';
  }

  function renderEmpty(s) {
    const root = $('empty');
    const a = s.active;
    root.hidden = Boolean(a) || engineOpen;
    $('work').hidden = !a && !engineOpen;
    if (a || engineOpen) return;
    root.textContent = '';
    const box = el('div', 'welcome');
    box.append(el('h2', null, 'Build one clear prompt from many rough ideas.'));
    box.append(el('p', null, 'Create a prompt, then type ideas one at a time. Each Enter merges the idea into a structured document beside this panel. Contradictions are flagged, never guessed away. Polish rewrites the whole thing for the model you are sending it to.'));
    const row = el('div', 'welcome-actions');
    const b = el('button', 'btn primary', 'New prompt');
    b.addEventListener('click', () => vscode.postMessage({ type: 'newPrompt' }));
    row.append(b);
    const eb = el('button', 'btn', s.engine.selected ? 'Settings' : 'Set up an engine');
    eb.addEventListener('click', () => { engineOpen = true; save(); if (latest) render(latest); });
    row.append(eb);
    box.append(row);
    if (s.engine.selected) {
      const p = s.engine.providers.find((x) => x.id === s.engine.selected.provider) || {};
      box.append(el('p', 'muted', `Engine ready: ${p.label || s.engine.selected.provider}${p.cli && p.cli.account ? ` · ${p.cli.account}` : ''} · merge ${s.engine.selected.mergeModel} · polish ${s.engine.selected.polishModel}`));
    } else {
      box.append(el('p', 'muted', `No engine yet: ${s.engine.reason || 'sign in or add a key'}.`));
    }
    root.append(box);
  }

  // ------------------------------------------------------------------------------------------
  // Layout: side by side, stacked, or side by side until there is no room. The class is decided
  // here rather than by a CSS container query so the breakpoint can be a setting, and so the
  // divider can write a share back.
  // ------------------------------------------------------------------------------------------
  const LAYOUT_DEFAULTS = { mode: 'auto', stackWidth: 620, split: 52 };
  // Spreading a state object straight over the defaults is wrong: an older extension host sends
  // `{ mode: undefined }` for a setting its manifest does not carry, and undefined would win.
  const withDefaults = (v) => {
    const out = { ...LAYOUT_DEFAULTS };
    for (const [k, val] of Object.entries(v || {})) if (val !== undefined && val !== null) out[k] = val;
    return out;
  };
  let layout = { ...LAYOUT_DEFAULTS };

  function applyLayout() {
    const cols = $('columns');
    const stacked = layout.mode === 'rows'
      || (layout.mode === 'auto' && layout.stackWidth > 0 && $('main').clientWidth < layout.stackWidth);
    cols.classList.toggle('stacked', stacked);
    cols.style.setProperty('--split', `${layout.split}%`);
    $('split').setAttribute('aria-orientation', stacked ? 'horizontal' : 'vertical');
  }

  function renderLayout(s) {
    const next = withDefaults(s.layout);
    if (dragging) { layout = { ...next, split: layout.split }; return; }   // never fight a live drag
    layout = next;
    applyLayout();
  }

  // The share is only ever committed on drop: writing a setting on every mouse move would round-trip
  // the whole state through the extension sixty times a second.
  let dragging = null;
  function startDrag(e) {
    const cols = $('columns');
    const stacked = cols.classList.contains('stacked');
    const box = cols.getBoundingClientRect();
    dragging = { stacked, box };
    $('split').classList.add('dragging');
    $('split').setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function moveDrag(e) {
    if (!dragging) return;
    const { stacked, box } = dragging;
    const pct = stacked
      ? ((e.clientY - box.top) / box.height) * 100
      : ((e.clientX - box.left) / box.width) * 100;
    layout.split = Math.max(20, Math.min(80, Math.round(pct)));
    $('columns').style.setProperty('--split', `${layout.split}%`);
  }
  function endDrag(e) {
    if (!dragging) return;
    dragging = null;
    $('split').classList.remove('dragging');
    try { $('split').releasePointerCapture(e.pointerId); } catch { /* already released */ }
    vscode.postMessage({ type: 'setLayout', split: layout.split });
  }
  $('split').addEventListener('pointerdown', startDrag);
  $('split').addEventListener('pointermove', moveDrag);
  $('split').addEventListener('pointerup', endDrag);
  $('split').addEventListener('pointercancel', endDrag);
  $('split').addEventListener('dblclick', () => { layout.split = 50; applyLayout(); vscode.postMessage({ type: 'setLayout', split: 50 }); });
  $('split').addEventListener('keydown', (e) => {
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -2 : e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 2 : 0;
    if (!step) return;
    e.preventDefault();
    layout.split = Math.max(20, Math.min(80, layout.split + step));
    applyLayout();
    vscode.postMessage({ type: 'setLayout', split: layout.split });
  });
  // `auto` has to react to the tab being dragged wider or narrower, not only to a new state message.
  if (window.ResizeObserver) new ResizeObserver(() => applyLayout()).observe($('main'));

  function render(s) {
    latest = s;
    if (s.bootError) {
      showNotice('error', `Cannot open the prompt library: ${s.bootError}. Fix promptForge.libraryPath in Settings.`, true);
    }
    renderLayout(s);
    renderRail(s);
    renderHeader(s);
    renderEngine(s);
    renderConflicts(s);
    renderEmpty(s);
    renderHistory(s);
    renderPreview(s);
    renderUsage(s);
    if (!s.active) editing = null;
    idea.disabled = Boolean(s.bootError) || !s.active || !s.engine.selected;
    idea.placeholder = s.bootError ? 'The prompt library cannot be opened. See the message above.'
      : !s.active ? 'Create or open a prompt first.'
      : !s.engine.selected ? 'Sign in to an engine (click the engine line above) to start merging ideas.'
        : 'Type an idea and press Enter. Shift+Enter for a new line.';
  }

  // ------------------------------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------------------------------
  idea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = idea.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'idea', text });
      idea.value = '';
      save();
    }
  });
  idea.addEventListener('input', save);
  $('new').addEventListener('click', () => vscode.postMessage({ type: 'newPrompt' }));
  // Rename: click the title, type, Enter. Escape puts the old name back.
  const titleEl = $('title');
  const titleEdit = $('title-edit');
  titleEl.addEventListener('click', () => {
    if (!latest || !latest.active) return;
    titleEdit.value = latest.active.title;
    titleEl.hidden = true;
    titleEdit.hidden = false;
    titleEdit.focus();
    titleEdit.select();
  });
  const endRename = (commit) => {
    const t = titleEdit.value.trim();
    titleEdit.hidden = true;
    titleEl.hidden = false;
    if (commit && t && latest && latest.active && t !== latest.active.title) vscode.postMessage({ type: 'rename', title: t });
  };
  titleEdit.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); endRename(true); }
    if (ev.key === 'Escape') { ev.preventDefault(); endRename(false); }
  });
  titleEdit.addEventListener('blur', () => { if (!titleEdit.hidden) endRename(true); });
  $('settings').addEventListener('click', () => { engineOpen = !engineOpen; save(); if (latest) render(latest); });
  $('open-library').addEventListener('click', () => vscode.postMessage({ type: 'openLibrary' }));
  $('open-doc').addEventListener('click', () => vscode.postMessage({ type: 'openDoc' }));
  // A webview cannot follow a link itself; hand it to the extension, which opens it in the browser.
  $('doc').addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    vscode.postMessage({ type: 'openUrl', url: a.getAttribute('href') });
  });
  $('polish').addEventListener('click', () => vscode.postMessage({ type: 'polish' }));
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  $('target').addEventListener('change', (e) => vscode.postMessage({ type: 'setTarget', target: e.target.value }));
  $('engine-summary').addEventListener('click', () => { engineOpen = !engineOpen; save(); if (latest) render(latest); });

  let noticeTimer = null;
  function showNotice(level, text, sticky = false) {
    const n = $('notice');
    n.textContent = text;
    n.className = `notice ${level}`;
    n.hidden = false;
    clearTimeout(noticeTimer);
    if (!sticky) noticeTimer = setTimeout(() => { n.hidden = true; }, level === 'error' ? 12000 : 5000);
  }

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'state') render(m.data);
    else if (m.type === 'notice') showNotice(m.level || 'info', m.text || '');
    else if (m.type === 'focus') idea.focus();
  });
  vscode.postMessage({ type: 'ready' });
}());
