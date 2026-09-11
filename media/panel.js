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
    $('polish').disabled = !a;
    $('copy').disabled = !a;

    const e = s.engine;
    const summary = $('engine-summary');
    if (e.selected) {
      const p = e.providers.find((x) => x.id === e.selected.provider) || {};
      const who = e.selected.mode === 'cli' ? (p.cli && p.cli.account ? p.cli.account : 'CLI login') : 'API key';
      const plan = e.selected.mode === 'cli' && p.cli && p.cli.plan ? ` · ${p.cli.plan}` : '';
      summary.textContent = `Engine: ${p.label || e.selected.provider} · ${who}${plan} · merge ${e.selected.mergeModel} · polish ${e.selected.polishModel}`;
      summary.classList.remove('bad');
    } else {
      summary.textContent = `No engine: ${e.reason || 'sign in'}`;
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
    root.textContent = '';
    if (!engineOpen) return;
    const e = s.engine;
    const head = el('div', 'esec-head');
    head.append(el('span', 'esec-title', 'Engine'), el('span', 'muted', 'Which account does the work. Independent of the target model.'));
    const detect = el('button', 'btn small', 'Detect again');
    detect.addEventListener('click', () => vscode.postMessage({ type: 'engine.detect' }));
    head.append(detect);
    root.append(head);

    for (const p of e.providers) {
      const card = el('div', `card${e.selected && e.selected.provider === p.id ? ' selected' : ''}`);
      const top = el('div', 'card-top');
      top.append(el('span', 'card-title', p.label));
      if (e.selected && e.selected.provider === p.id) top.append(el('span', 'tag', `in use · ${e.selected.mode === 'cli' ? 'login' : 'key'}`));
      card.append(top);

      if (p.modes.includes('cli')) {
        const line = el('div', 'line');
        if (!p.cli.found) {
          line.append(el('span', 'muted', 'CLI not found on PATH.'));
          if (p.installUrl) {
            const inst = el('button', 'link', 'Install');
            inst.addEventListener('click', () => vscode.postMessage({ type: 'openUrl', url: p.installUrl }));
            line.append(inst);
          }
        } else if (p.cli.loggedIn) {
          line.append(el('span', null, `CLI ${p.cli.version || ''} · signed in${p.cli.account ? ` as ${p.cli.account}` : ''}${p.cli.plan ? ` · ${p.cli.plan}` : ''}`));
        } else {
          line.append(el('span', 'muted', `CLI ${p.cli.version || ''} · not signed in`));
          const btn = el('button', 'btn small', 'Sign in');
          btn.addEventListener('click', () => vscode.postMessage({ type: 'engine.signIn', provider: p.id, mode: 'cli' }));
          line.append(btn);
        }
        if (p.cli.note) line.append(el('span', 'note', p.cli.note));
        card.append(line);
      }

      const keyLine = el('div', 'line');
      if (p.id === 'compatible') {
        keyLine.append(el('span', p.apiKey.stored ? null : 'muted', p.note || ''));
        const kb = el('button', 'btn small', 'Set key');
        kb.addEventListener('click', () => vscode.postMessage({ type: 'engine.setKey', provider: p.id }));
        keyLine.append(kb);
      } else if (p.apiKey.stored) {
        keyLine.append(el('span', null, 'API key stored in your keychain.'));
        const fb = el('button', 'link', 'Forget key');
        fb.addEventListener('click', () => vscode.postMessage({ type: 'engine.forgetKey', provider: p.id }));
        keyLine.append(fb);
      } else {
        keyLine.append(el('span', 'muted', 'No API key.'));
        const kb = el('button', 'btn small', 'Set key');
        kb.addEventListener('click', () => vscode.postMessage({ type: 'engine.setKey', provider: p.id }));
        keyLine.append(kb);
      }
      card.append(keyLine);

      const usable = p.cli.loggedIn || p.apiKey.stored;
      if (usable) {
        const models = el('div', 'models');
        const mk = (role, current) => {
          const wrap = el('label', 'lbl', `${role} `);
          const sel = el('select');
          const ids = p.models.map((m) => m.id);
          const custom = customModels[`${p.id}.${role}`];
          const opts = [['auto', `auto (${p.defaults[role === 'merge' ? 'merge' : 'polish'] || '?'})`], ...p.models.map((m) => [m.id, m.label || m.id]), ['__custom', 'type a model id…']];
          if (custom && !ids.includes(custom)) opts.splice(opts.length - 1, 0, [custom, custom]);
          for (const [v, label] of opts) { const o = el('option', null, label); o.value = v; if (v === (current || 'auto')) o.selected = true; sel.append(o); }
          sel.addEventListener('change', () => {
            let v = sel.value;
            if (v === '__custom') {
              v = window.prompt(`Model id for ${role} on ${p.label}:`, custom || '') || '';
              v = v.trim();
              if (!v) { sel.value = current || 'auto'; return; }
              customModels[`${p.id}.${role}`] = v;
              save();
            }
            vscode.postMessage({ type: 'engine.select', provider: p.id, [role === 'merge' ? 'mergeModel' : 'polishModel']: v === 'auto' ? 'auto' : v });
          });
          wrap.append(sel);
          return wrap;
        };
        const inUse = e.selected && e.selected.provider === p.id;
        models.append(mk('merge', inUse ? s.engineCfg && s.engineCfg.mergeModel : 'auto'), mk('polish', inUse ? s.engineCfg && s.engineCfg.polishModel : 'auto'));
        if (!inUse) {
          const use = el('button', 'btn small', 'Use this engine');
          use.addEventListener('click', () => vscode.postMessage({ type: 'engine.select', provider: p.id }));
          models.append(use);
        }
        card.append(models);
      }
      root.append(card);
    }
    const foot = el('div', 'muted small-text', 'Keys live in your OS keychain through VS Code SecretStorage. Prompts go only to the provider you pick. Subscription quota is not exposed by any vendor; the footer shows per-call tokens instead.');
    root.append(foot);
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

  function renderHistory(s) {
    const root = $('history');
    root.textContent = '';
    const a = s.active;
    if (!a) return;
    const entries = a.entries.slice().reverse();
    const head = el('div', 'hsec-head');
    head.append(el('span', 'hsec-title', `Ideas (${a.entries.length})`));
    const vt = el('button', 'link', versionsOpen ? 'hide versions' : `versions (${a.snapshots.length})`);
    vt.addEventListener('click', () => { versionsOpen = !versionsOpen; save(); if (latest) render(latest); });
    head.append(vt);
    root.append(head);

    if (versionsOpen) {
      const vl = el('div', 'versions');
      for (const v of a.snapshots.slice().reverse()) {
        const row = el('div', 'vrow');
        row.append(el('span', `vkind ${v.kind}`, v.kind), el('span', 'vwhen', ago(v.ts)));
        if (v.call) row.append(el('span', 'vmeta', `${v.call.provider}/${v.call.model}${v.call.usage ? ` · ${k(v.call.usage.input)}/${k(v.call.usage.output)}` : ''}`));
        if (v.changes && v.changes.length) row.append(el('span', 'vchanges', v.changes.slice(0, 3).join(' · ')));
        const last = a.snapshots[a.snapshots.length - 1];
        if (v.id !== last.id) {
          const rb = el('button', 'link', 'restore');
          rb.addEventListener('click', () => vscode.postMessage({ type: 'restore', snapshotId: v.id }));
          row.append(rb);
        }
        vl.append(row);
      }
      root.append(vl);
    }

    if (!entries.length) { root.append(el('p', 'muted', 'No ideas yet. Type one above and press Enter.')); return; }
    for (const e of entries) {
      const row = el('div', `entry ${e.status}`);
      row.append(el('span', `dot ${e.status}`));
      const body = el('div', 'ebody');
      body.append(el('div', 'etext', e.text));
      const meta = el('div', 'emeta');
      meta.append(el('span', null, `${e.id} · ${ago(e.ts)} · ${e.status}`));
      if (e.status === 'failed') {
        meta.append(el('span', 'bad', e.error || ''));
        const rb = el('button', 'btn small', 'Retry');
        rb.addEventListener('click', () => vscode.postMessage({ type: 'retry', entryId: e.id }));
        meta.append(rb);
      } else if (e.status === 'merged' && e.snapshotId) {
        const rb = el('button', 'link', 'restore to here');
        rb.title = `Put the document back to the version right after this idea (${e.snapshotId})`;
        rb.addEventListener('click', () => vscode.postMessage({ type: 'restore', snapshotId: e.snapshotId }));
        meta.append(rb);
      }
      body.append(meta);
      row.append(body);
      root.append(row);
    }
  }

  function renderUsage(s) {
    const root = $('usage');
    const a = s.active;
    if (!a) { root.textContent = ''; return; }
    const u = a.usage;
    root.textContent = u.calls
      ? `This prompt: ${u.calls} call${u.calls === 1 ? '' : 's'} · ${k(u.input)} tokens in / ${k(u.output)} out · library ${s.library}`
      : `Library ${s.library}`;
  }

  function renderEmpty(s) {
    const root = $('empty');
    const a = s.active;
    root.hidden = Boolean(a);
    $('compose').hidden = !a;
    if (a) return;
    root.textContent = '';
    root.append(el('h2', null, 'Build one clear prompt from many rough ideas.'));
    root.append(el('p', null, 'Create a prompt, then type ideas one at a time. Each Enter merges the idea into a structured document beside this panel. Contradictions are flagged, never guessed away. Polish rewrites the whole thing for the model you are sending it to.'));
    const b = el('button', 'btn primary', 'New prompt');
    b.addEventListener('click', () => vscode.postMessage({ type: 'newPrompt' }));
    root.append(b);
    if (!s.engine.selected) {
      root.append(el('p', 'muted', `Engine: ${s.engine.reason || 'none yet'}.`));
      const eb = el('button', 'btn', 'Set up an engine');
      eb.addEventListener('click', () => { engineOpen = true; save(); if (latest) render(latest); });
      root.append(eb);
    }
  }

  function render(s) {
    latest = s;
    renderRail(s);
    renderHeader(s);
    renderEngine(s);
    renderConflicts(s);
    renderEmpty(s);
    renderHistory(s);
    renderUsage(s);
    idea.disabled = !s.active || !s.engine.selected;
    idea.placeholder = !s.active ? 'Create or open a prompt first.'
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
  $('open-library').addEventListener('click', () => vscode.postMessage({ type: 'openLibrary' }));
  $('open-doc').addEventListener('click', () => vscode.postMessage({ type: 'openDoc' }));
  $('polish').addEventListener('click', () => vscode.postMessage({ type: 'polish' }));
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  $('target').addEventListener('change', (e) => vscode.postMessage({ type: 'setTarget', target: e.target.value }));
  $('engine-summary').addEventListener('click', () => { engineOpen = !engineOpen; save(); if (latest) render(latest); });

  let noticeTimer = null;
  function showNotice(level, text) {
    const n = $('notice');
    n.textContent = text;
    n.className = `notice ${level}`;
    n.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { n.hidden = true; }, level === 'error' ? 12000 : 5000);
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
