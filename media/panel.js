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
  // Project chip
  //
  // Attached or not, and what it read. The chip is the whole surface in the header: the picker and
  // the brief live behind it, because this is a thing you set once per prompt and then forget.
  // ------------------------------------------------------------------------------------------
  function renderConnect(s) {
    const btn = $('connect');
    const a = s.active;
    const off = s.project && s.project.context === 'off';
    const busy = Boolean(s.projectBusy) || connecting;
    btn.classList.toggle('busy', busy);
    btn.disabled = !a || busy;
    if (busy) {
      $('connect-name').textContent = 'connecting\u2026';
      btn.title = 'Connecting to the project and building its brief. One engine call.';
      return;
    }
    const list = (a && a.projects) || [];
    const bad = list.some((p) => p.error);
    btn.classList.toggle('on', list.length > 0 && !bad && !off);
    btn.classList.toggle('bad', bad);
    const name = $('connect-name');
    if (!list.length) {
      // Unconnected is the plug alone: nothing to name, and the header has better uses for the room.
      name.textContent = '';
      btn.title = a
        ? 'Connect this prompt to the folder this window has open, so the engine uses its real names instead of "your framework". Only that folder is read.'
        : 'Open a prompt first.';
      return;
    }
    // Connected shows which project, in the header, because a tooltip is not an answer to "what is
    // this prompt wired to?" — that has to be readable without hovering.
    const names = list.map((p) => p.label).join(', ');
    name.textContent = off ? `${names} (off)` : names;
    const lines = list.map((p) => {
      if (p.error) return `${p.label}: ${p.error}`;
      const when = p.builtAt ? new Date(p.builtAt).toLocaleString() : 'not built';
      return `${p.label} \u2014 ${p.path}\nread ${p.files.length} file(s), built ${when}${p.head ? ` at ${p.head}` : ''}`;
    });
    if (off) lines.push('promptForge.projectContext is off, so this is not being sent.');
    lines.push('Click to view the brief, reconnect or disconnect.');
    btn.title = lines.join('\n');
  }

  // Connected or not decides what a click means: nothing attached connects to the open folder with
  // no picker in the way; something attached opens the menu, which is the only route to detach.
  // Set here and cleared by the next state from the extension. The round trip is short but not
  // free, and a button that does nothing for even a moment gets pressed again.
  let connecting = false;
  $('connect').addEventListener('click', () => {
    const list = (latest && latest.active && latest.active.projects) || [];
    if (list.length) { vscode.postMessage({ type: 'project.menu' }); return; }
    connecting = true;
    if (latest) renderConnect(latest);
    vscode.postMessage({ type: 'project.connect' });
  });

  // ------------------------------------------------------------------------------------------
  // Header
  // ------------------------------------------------------------------------------------------
  function renderHeader(s) {
    const a = s.active;
    $('title').textContent = a ? a.title : 'Prompt Forge';
    $('title').classList.toggle('editable', Boolean(a));
    $('polish').disabled = !a;
    $('copy').disabled = !a;
    renderAddonCopy(s);
    renderConnect(s);

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

    renderStatus(s);
  }

  // ------------------------------------------------------------------------------------------
  // Status: what the engine is doing, and for how long
  //
  // A merge used to read "merging · sonnet" for twenty seconds with nothing moving. The engine now
  // streams, so the line says whether it is starting, thinking or writing a named section, and the
  // seconds count up here -- no message is needed for the clock to move.
  // ------------------------------------------------------------------------------------------
  let statusTimer = null;

  function statusText(ae) {
    const secs = ae.startedAt ? Math.max(0, Math.round((Date.now() - ae.startedAt) / 1000)) : 0;
    const op = ae.op === 'polish' ? 'polishing' : ae.op === 'run' ? 'running' : 'merging';
    const p = ae.progress || {};
    const phase = p.phase === 'thinking' ? 'thinking'
      : p.phase === 'writing' ? (p.section ? `writing ${p.section}` : 'writing')
        : p.phase === 'starting' ? 'starting the engine'
          : p.phase === 'waiting' ? 'engine ready' : '';
    return [op, ae.model, phase, `${secs}s`, ae.queued ? `${ae.queued} queued` : ''].filter(Boolean).join(' · ');
  }

  function renderStatus(s) {
    const st = $('status');
    const a = s.active;
    const ae = a ? a.engine : null;
    clearInterval(statusTimer);
    statusTimer = null;
    st.textContent = '';
    st.className = 'status';
    st.title = '';
    if (!a) return;
    if (ae.state === 'busy') {
      st.classList.add('busy');
      const label = el('span', null, statusText(ae));
      st.append(el('span', 'pulse'), label);
      if (ae.progress && ae.progress.warm) st.title = 'The engine was started while you typed, so this merge skipped its start-up.';
      statusTimer = setInterval(() => {
        if (latest && latest.active && latest.active.engine.state === 'busy') label.textContent = statusText(latest.active.engine);
      }, 1000);
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
    const sections = [['engine', 'Engine'], ['models', 'Models'], ['target', 'Target'], ['project', 'Project'], ['layout', 'Layout'], ['document', 'Document']];
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
        const choose = (v) => {
          describe(v === 'auto' ? cur.defaults[role] : v);
          vscode.postMessage({ type: 'engine.select', provider: cur.id, [key]: v === 'auto' ? 'auto' : v });
        };
        const sel = select(opts, current, (sl) => {
          if (sl.value !== '__custom') { choose(sl.value); return; }
          uiOpen({ kind: 'ask', title: `Model id for ${role} on ${cur.label}`, detail: 'Any id the provider accepts, passed through unchanged.', value: custom || '', placeholder: 'e.g. claude-sonnet-5', okLabel: 'Use this model' }, (typed) => {
            const v = String(typed || '').trim();
            if (!v) { sl.value = current; describe(resolved); return; }
            customModels[`${cur.id}.${role}`] = v;
            save();
            choose(v);
          });
        });
        const c = el('div', 'sctl'); c.append(sel); r.append(c);
      }
    }

    const eo = s.engineOptions || { mergeEffort: 'low', polishEffort: 'auto', prewarm: true, mergeOutput: 'edits' };
    const option = (key) => (sel) => vscode.postMessage({ type: 'setEngineOption', key, value: sel.value });
    row('Merge effort', 'How hard the model thinks on each Enter. Low is fastest: on 33 real merges it cut the average from 20.6 s to 13.3 s and matched what had been accepted as closely as the default. Each vendor receives it in its own terms.',
      select([['low', 'Low (fastest)'], ['medium', 'Medium'], ['high', 'High'], ['auto', 'Provider default']], eo.mergeEffort, option('engine.mergeEffort')));
    row('Polish effort', 'How hard the model thinks on Polish, a test run and a project brief.',
      select([['auto', 'Provider default'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']], eo.polishEffort, option('engine.polishEffort')));
    row('Merge output', eo.mergeOutput === 'edits'
      ? 'Changed sections only. The engine sends back just the sections an idea touched, so a merge costs the change rather than the whole prompt, and a section it did not name cannot drift.'
      : 'Whole document. The engine re-types the prompt on every merge.',
    select([['edits', 'Changed sections only'], ['document', 'Whole document']], eo.mergeOutput, option('engine.mergeOutput')));
    row('Start the engine while you type', eo.prewarm
      ? 'On. The Claude CLI takes about six seconds to start; it starts while you type, so a merge begins the moment you press Enter. An unused engine is stopped after 90 seconds.'
      : 'Off. Every merge starts the engine from cold.',
    small(eo.prewarm ? 'Turn off' : 'Turn on', null, () => vscode.postMessage({ type: 'setEngineOption', key: 'engine.prewarm', value: !eo.prewarm })));

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

    // --- Project ---
    // The brief is text about the person's own code that is sent to a model on every merge, so it
    // has to be readable in one click and correctable by hand. That is a requirement, not a nicety.
    section('project', 'Project');
    const proj = s.project || { context: 'brief', roots: [], maxFiles: 400, maxBytes: 2000000 };
    const attached = (s.active && s.active.projects) || [];
    row('Send project context', 'When a folder is attached, its brief goes to the engine with every merge and polish. Nothing is read until you attach one.',
      select([
        ['brief', 'Send the attached project\u2019s brief'],
        ['brief+lookup', 'Brief, and search the project for each idea'],
        ['off', 'Never send project context'],
      ], proj.context,
        (sel) => vscode.postMessage({ type: 'setProjectContext', value: sel.value })));
    if (proj.context === 'brief+lookup') {
      row('Per-idea search', 'Before each merge the attached project is searched for the words in your idea, and at most three excerpts are attached with their paths. A search, not an embedding: a bad match is visibly a bad match, and finding nothing is a normal, silent outcome. Costs a filesystem scan on every Enter.');
    }
    row('Token budget', budgetDesc(s),
      small('Set a budget', null, () => vscode.postMessage({ type: 'budget.set' })));
    row('Folders to list projects from',
      proj.roots.length
        ? `${proj.roots.join(', ')} \u2014 names and paths only. Nothing in these folders is read unless you attach one of them.`
        : 'Empty. The picker offers the folder this window has open, and Browse. Add roots so you never hunt for a path.',
      small('Edit roots', null, () => vscode.postMessage({ type: 'roots.edit' })));
    if (!s.active) {
      row('Connected project', 'Open a prompt to connect it to a project.', small('Connect\u2026', null, () => vscode.postMessage({ type: 'project.pick' })));
    } else if (!attached.length) {
      row('Connected project', 'Nothing. The engine writes \u201cyour framework\u201d and \u201cthe existing component\u201d because those are the only honest things it can say. The plug in the header connects the folder this window has open.',
        [
          small('Connect a project\u2026', null, () => vscode.postMessage({ type: 'project.pick' })),
          small('Over SSH\u2026', 'A project on another machine, such as a Mac mini, read through ssh without leaving this window', () => vscode.postMessage({ type: 'project.remote' })),
        ]);
    } else {
      for (const p of attached) {
        const when = p.builtAt ? new Date(p.builtAt).toLocaleString() : 'never';
        const desc = p.error
          ? `${p.path} \u2014 no brief: ${p.error}`
          : `${p.path} \u2014 read ${p.files.length} file${p.files.length === 1 ? '' : 's'}, built ${when}${p.head ? `, at ${p.head}` : ''}${p.truncated ? '. The caps stopped it before the whole tree.' : ''}`;
        row(p.label, desc, [
          small('View', 'Open the brief that is sent to the engine', () => vscode.postMessage({ type: 'project.view', id: p.id })),
          small('Refresh', 'Rebuild it from the folder as it is now. One engine call.', () => vscode.postMessage({ type: 'project.refresh', id: p.id })),
          small('Disconnect', null, () => vscode.postMessage({ type: 'project.detach', id: p.id })),
        ]);
      }
      row('Caps', `At most ${proj.maxFiles} files and ${Math.round(proj.maxBytes / 1000).toLocaleString()} KB are read when a brief is built. .env files, keys, anything .gitignore\u2019d, and every build directory are excluded before the search runs, not after.`);
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
    row('Suggestions', (s.suggestions === false)
      ? 'Off. The prompt is shown exactly as it is.'
      : 'On. Where a section is empty or thin, a note in the prompt says what belongs there. They live beside the prompt and never inside it, so a copy never carries one and a hand edit cannot save one into the document.',
      small(s.suggestions === false ? 'Turn on' : 'Turn off', null,
        () => vscode.postMessage({ type: 'setSuggestions', value: s.suggestions === false })));

    row('Prompts list', lay.railCollapsed
      ? 'Collapsed to a strip. The chevron on the strip brings it back, as does Prompt Forge: Toggle the Prompts List.'
      : 'Shown down the left. Collapse it with the chevron next to the heading to give the work the space.',
      small(lay.railCollapsed ? 'Show' : 'Collapse', null,
        () => vscode.postMessage({ type: 'setLayout', railCollapsed: !lay.railCollapsed })));

    // --- Document ---
    section('document', 'Document');
    row('Editor for hand edits', 'Where the pencil opens the prompt file. The built-in one needs nothing installed.',
      select([['forge', 'Prompt Forge editor (formatted, click to edit)'], ['office', 'Office Viewer, if that extension is installed'], ['text', 'Plain text editor']], s.docEditor || 'forge',
        (sel) => vscode.postMessage({ type: 'setDocEditor', value: sel.value })));
    row('Library folder', s.library || '', small('Open folder', null, () => vscode.postMessage({ type: 'openLibrary' })));
    const sy = s.sync || {};
    const syncDesc = sy.gitMissing ? 'git is not installed, so the library cannot sync.'
      : !sy.enabled ? 'Off. Point the library at a private git repository and your prompts follow you between machines. When two machines both changed a prompt, their ideas and versions are merged, not overwritten.'
        : `${sy.remote}${sy.busy ? ' — syncing…' : sy.last ? (sy.last.ok ? ` — synced ${ago(sy.last.at)}` : ` — last sync failed: ${sy.last.error}`) : ''}`;
    row('Library sync', syncDesc, [
      small(sy.enabled ? 'Change remote' : 'Set up', null, () => vscode.postMessage({ type: 'sync.setup' })),
      ...(sy.enabled ? [small('Sync now', null, () => vscode.postMessage({ type: 'sync.now' }))] : []),
    ]);
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
    renderTarget(s);
    renderRunTab(s);
    renderSend(s);
    renderVars(s);
    if (!a) { root.textContent = ''; $('doc-count').textContent = ''; return; }
    const n = (a.doc || '').length;
    $('doc-count').textContent = `${n.toLocaleString()} character${n === 1 ? '' : 's'}`;
    if (a.docBlank) {
      root.textContent = '';
      const ph = el('div', 'placeholder');
      ph.append(el('h3', null, 'Your prompt builds here.'), el('p', null, 'Every idea you send is merged into this document, and sections appear as they are needed. Click the pencil to edit it by hand at any time.'));
      root.append(ph);
      return;
    }
    if (showRun && lastRun(a)) { renderRun(root, a); return; }
    root.innerHTML = renderMarkdown(a.doc || '');
    placeSuggestions(root, s);
    placeIdeas(root, s);
  }

  // ------------------------------------------------------------------------------------------
  // Send to Claude Code, and the update after more ideas
  // ------------------------------------------------------------------------------------------
  const destName = (d) => (!d ? 'where you sent it'
    : d.kind === 'terminal' ? `the terminal "${d.name}"`
      : d.kind === 'session' ? `the conversation "${d.title || d.id}"`
        : d.kind === 'remote' ? `Claude on ${d.host}` : 'the Claude Code conversation you started');

  function renderSend(s) {
    const a = s.active;
    $('send-claude').disabled = !a;
    const btn = $('send-update');
    const n = a && a.newSinceSend;
    btn.hidden = !n;
    if (!n) return;
    $('send-update-count').textContent = String(n.added || n.removed);
    btn.title = n.restyled
      ? 'The prompt was restyled since you sent it, so an update would be most of it again. Send the whole prompt instead.'
      : `Send just what changed (${n.added} new line${n.added === 1 ? '' : 's'}${n.removed ? `, ${n.removed} removed` : ''}) to ${destName(a.sent && a.sent.dest)}, as the next message in that conversation.`;
    btn.classList.toggle('warn', Boolean(n.restyled));
  }

  $('send-update').addEventListener('click', () => vscode.postMessage({ type: 'sendUpdate' }));

  // ------------------------------------------------------------------------------------------
  // Send to: the same floating list as the model picker, anchored under the Send button. Where the
  // prompt goes is chosen here, in the panel; nothing opens a picker at the top of the window.
  // It opens at once with "Looking for Claude…" and fills when the extension has listed the
  // terminals and conversations, so the click never feels dead.
  // ------------------------------------------------------------------------------------------
  const SEND_MARK = {
    terminal: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4"/><path d="m4.6 6.2 2 1.8-2 1.8M8.2 10h3.2"/></svg>',
    session: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.5 3h11v7.5H8l-3.2 2.7v-2.7H2.5z"/></svg>',
    'new-panel': '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    'new-terminal': '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>',
    remote: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="8" rx="1.2"/><path d="M5.5 13.5h5M8 10.5v3"/></svg>',
    last: '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.8 8a5.2 5.2 0 1 0 1.5-3.7"/><path d="M2.5 2.4v2.9h2.9"/><path d="M8 5.3V8l1.8 1.2"/></svg>',
  };

  function closeSendMenu() {
    $('send-menu').hidden = true;
    $('send-claude').setAttribute('aria-expanded', 'false');
  }

  function openSendMenu(data) {
    closeTargetMenu();
    const menu = $('send-menu');
    menu.textContent = '';
    menu.append(el('div', 'fhead', 'Send to Claude Code. It lands in the input box; nothing is sent until you press Enter there.'));
    if (!data) {
      menu.append(el('div', 'fnote', 'Looking for Claude…'));
    } else if (!data.items || !data.items.length) {
      menu.append(el('div', 'fnote', 'Nowhere to send yet: open a folder, attach a project, or start claude in a terminal.'));
    } else {
      for (const it of data.items) {
        const item = el('button', `fitem${it.last ? ' on' : ''}`);
        item.setAttribute('role', 'option');
        const mark = el('span', 'fitem-mark');
        mark.innerHTML = SEND_MARK[it.last ? 'last' : it.kind] || SEND_MARK.terminal;   // a constant above, never data
        const text = el('span', 'fitem-text');
        text.append(el('span', 'fitem-label', it.label));
        if (it.description) text.append(el('span', 'fitem-desc', it.description));
        item.append(mark, text);
        item.addEventListener('click', () => { closeSendMenu(); vscode.postMessage({ type: 'send', dest: it }); });
        menu.append(item);
      }
    }
    if (data && data.unfilled && data.unfilled.length) {
      menu.append(el('div', 'fnote warn', `No value yet for ${data.unfilled.map((n) => `{{${n}}}`).join(', ')}. Fill it in under the prompt, or it goes as a slot.`));
    }
    if (data && data.files) menu.append(el('div', 'fnote', `${data.files} attached file${data.files === 1 ? ' goes' : 's go'} along as @-mentions.`));
    menu.hidden = false;
    $('send-claude').setAttribute('aria-expanded', 'true');
    // Anchored under the button and right-aligned to it, since the button sits at the right edge.
    const r = $('send-claude').getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    const first = menu.querySelector('.fitem.on') || menu.querySelector('.fitem');
    if (first) first.focus();
  }

  $('send-claude').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!$('send-menu').hidden) { closeSendMenu(); return; }
    openSendMenu(null);
    vscode.postMessage({ type: 'send.options' });
  });
  document.addEventListener('click', (e) => {
    if (!$('send-menu').hidden && !$('send-menu').contains(e.target)) closeSendMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('send-menu').hidden) { closeSendMenu(); $('send-claude').focus(); } });
  window.addEventListener('resize', closeSendMenu);

  // ------------------------------------------------------------------------------------------
  // {{variables}}: filled here, never in the document
  //
  // Rebuilt only when the set of names changes, so a repaint never takes the caret out of a value
  // being typed. Values are saved a moment after typing stops.
  // ------------------------------------------------------------------------------------------
  const varTimers = {};

  function renderVars(s) {
    const root = $('vars');
    const a = s.active;
    const names = (a && a.vars && a.vars.names) || [];
    const hide = !names.length || showRun;
    root.hidden = hide;
    if (hide) { root.textContent = ''; delete root.dataset.key; return; }
    const values = a.vars.values || {};
    const key = names.join('\u0001');
    if (root.dataset.key === key) {
      for (const input of root.querySelectorAll('input')) {
        if (document.activeElement !== input) input.value = values[input.dataset.name] || '';
      }
      return;
    }
    root.dataset.key = key;
    root.textContent = '';
    const label = el('span', 'vars-label', 'Fill in');
    label.title = 'Slots in the prompt. The document keeps {{name}}; the copy, the send and a test run get the value.';
    root.append(label);
    for (const n of names) {
      const wrap = el('label', 'var');
      const input = el('input', 'var-input');
      input.type = 'text';
      input.value = values[n] || '';
      input.placeholder = 'value';
      input.dataset.name = n;
      input.addEventListener('input', () => {
        clearTimeout(varTimers[n]);
        varTimers[n] = setTimeout(() => vscode.postMessage({ type: 'vars.set', values: { [n]: input.value } }), 400);
      });
      wrap.append(el('span', 'var-name', `{{${n}}}`), input);
      root.append(wrap);
    }
  }

  // ------------------------------------------------------------------------------------------
  // Ideas to take the prompt further: orange, at the foot of the prompt, never in it
  // ------------------------------------------------------------------------------------------
  function placeIdeas(root, s) {
    const list = (s.active && s.active.ideas) || [];
    if (!list.length || s.suggestions === false) return;
    const box = el('div', 'ideas-box');
    box.append(el('div', 'ideas-title', 'Ideas to take this prompt further'));
    for (const it of list) {
      const card = el('div', 'idea-card');
      const use = el('button', 'ic-use', 'Use');
      use.title = 'Put this in the idea box, to send as it is or change first.';
      use.addEventListener('click', () => {
        idea.value = idea.value.trim() ? `${idea.value.trim()}\n${it.text}` : it.text;
        idea.focus();
        save();
        vscode.postMessage({ type: 'idea.dismiss', text: it.text });
      });
      const x = el('button', 'sg-x', '×');
      x.title = 'Dismiss. It will not come back for this prompt.';
      x.addEventListener('click', () => vscode.postMessage({ type: 'idea.dismiss', text: it.text }));
      card.append(el('span', 'ic-text', it.text), use, x);
      box.append(card);
    }
    root.append(box);
  }

  // ------------------------------------------------------------------------------------------
  // Test run
  //
  // The forge built prompts and never once showed you one working. The answer takes over the
  // Prompt panel rather than opening a fourth surface, and which model actually answered is stated
  // on it -- the engine that is signed in is often not the family the prompt is written for.
  // ------------------------------------------------------------------------------------------
  let showRun = false;
  const lastRun = (a) => (a && a.runs && a.runs.length ? a.runs[a.runs.length - 1] : null);

  function renderRun(root, a) {
    const r = lastRun(a);
    root.textContent = '';
    const bar = el('div', 'runbar');
    const tLabel = (latest.targets.find((t) => t.id === r.target) || {}).label || r.target;
    bar.append(el('span', 'runwho', `${r.provider || '?'} \u00b7 ${r.model || '?'}`));
    const written = el('span', 'runfor', `prompt written for ${tLabel}`);
    if (r.model && tLabel && !String(r.model).toLowerCase().includes(String(tLabel).split(' ')[0].toLowerCase())) {
      written.classList.add('mismatch');
      written.title = 'The engine that answered is not the family this prompt is styled for. Still a useful smoke test, but the styling was not what this model reads best.';
    }
    bar.append(written);
    if (r.usage) bar.append(el('span', 'runmeta', `${k(r.usage.input)} in / ${k(r.usage.output)} out \u00b7 ${(r.ms / 1000).toFixed(1)}s`));
    const open = el('button', 'link', 'open as a document');
    open.addEventListener('click', () => vscode.postMessage({ type: 'openRun', id: r.id }));
    bar.append(open);
    root.append(bar);
    const body = el('div', 'runbody');
    body.innerHTML = renderMarkdown(r.text || '');
    root.append(body);
  }

  function renderRunTab(s) {
    const a = s.active;
    const has = Boolean(lastRun(a));
    $('tab-run').hidden = !has;
    $('run').disabled = !a;
    if (!has) { showRun = false; return; }
    $('tab-run').classList.toggle('on', showRun);
    $('tab-run').textContent = showRun ? 'Prompt' : 'Run';
    $('tab-run').title = showRun ? 'Back to the prompt' : 'Show the last answer';
  }

  $('run').addEventListener('click', () => { showRun = true; vscode.postMessage({ type: 'run' }); });
  $('tab-run').addEventListener('click', () => { showRun = !showRun; if (latest) render(latest); });

  // ------------------------------------------------------------------------------------------
  // Suggestions
  //
  // Advice about the prompt, drawn beside it. They are never part of the document: the engine
  // returns them separately, they are stored in the sidecar, and they are injected into the
  // rendered DOM here. So "a copy must not carry them" is not a strip step that could be got
  // wrong -- there is nothing to strip, because the .md never held one.
  // ------------------------------------------------------------------------------------------
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, '');

  function placeSuggestions(root, s) {
    const list = (s.active && s.active.suggestions) || [];
    if (!list.length || s.suggestions === false) return;
    const heads = [...root.querySelectorAll('h1, h2, h3, h4')];
    for (const sg of list) {
      const card = suggestionCard(sg);
      const want = norm(sg.section);
      // Sections are named differently once polished (<open_questions>, # Task), so match on the
      // squashed text and fall back to the end of the document rather than dropping the advice.
      const head = want && heads.find((h) => {
        const n = norm(h.textContent);
        return n === want || n.includes(want) || want.includes(n);
      });
      if (!head) { root.append(card); continue; }
      let at = head;
      while (at.nextElementSibling && !/^H[1-4]$/.test(at.nextElementSibling.tagName)) at = at.nextElementSibling;
      at.after(card);
    }
  }

  // Colour says whose move it is: red is something the prompt stays worse without, green is
  // background that would help. Conflicts are yellow and ideas orange, so no two kinds share a colour.
  function suggestionCard(sg) {
    const kind = sg.kind === 'action' ? 'action' : 'info';
    const card = el('div', `suggestion ${kind}`);
    const body = el('div', 'sg-body');
    body.append(el('span', 'sg-kind', kind === 'action' ? 'Act on this' : 'Worth adding'));
    if (sg.section) body.append(el('span', 'sg-where', sg.section));
    body.append(el('span', 'sg-text', sg.text));
    const x = el('button', 'sg-x', '\u00d7');
    x.title = 'Dismiss. It will not come back for this prompt.';
    x.addEventListener('click', () => vscode.postMessage({ type: 'suggestion.dismiss', text: sg.text }));
    card.append(body, x);
    return card;
  }

  const budgetDesc = (s) => {
    const b = (s.project && s.project.tokenBudget) || 0;
    const used = s.active ? s.active.usage.input + s.active.usage.output : 0;
    if (!b) return 'Off. The footer counts tokens for this prompt but nothing warns you. Tokens rather than money: a CLI login draws on a plan, so a dollar figure would be wrong for it.';
    return `${k(used)} of ${k(b)} tokens used on this prompt. The footer turns amber past the budget.`;
  };

  // ------------------------------------------------------------------------------------------
  // Conflicts, history, usage
  // ------------------------------------------------------------------------------------------
  function renderConflicts(s) {
    const root = $('conflicts');
    const list = s.active ? s.active.conflicts : [];
    root.hidden = !list.length;
    root.textContent = '';
    if (!list.length) return;
    const title = el('div', 'csec-title');
    title.append(el('span', 'rtag', 'Conflict'), document.createTextNode(` ${list.length} open conflict${list.length === 1 ? '' : 's'}. Nothing was assumed; pick a side or edit the document. Your answer shows in the thread.`));
    root.append(title);
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

  let editing = null;  // entry id being edited inline
  let openDiff = null;    // entry id whose diff is expanded
  let openVersion = null; // snapshot id whose diff is expanded in the versions list
  let compared = null;    // { id, diff } from a "vs now" comparison, computed in the extension

  /** The snapshot immediately before `id`, which is what "undo this merge" restores to. */
  function priorSnapshot(snaps, id) {
    const i = snaps.findIndex((v) => v.id === id);
    return i > 0 ? snaps[i - 1] : null;
  }

  // What the engine actually did, rather than what it said it did. `changes` is the engine's own
  // summary; this is the text.
  function diffBlock(blocks) {
    const root = el('div', 'mdiff');
    for (const b of blocks) {
      if (b.heading) root.append(el('div', 'dsec', b.heading));
      for (const line of b.added) root.append(el('div', 'dline add', line));
      for (const line of b.removed) root.append(el('div', 'dline del', line));
    }
    return root;
  }

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
        if (v.call) row.append(el('span', 'vmeta', `${v.call.provider}/${v.call.model}${v.call.usage ? ` \u00b7 ${k(v.call.usage.input)}/${k(v.call.usage.output)}` : ''}`));
        const n = v.diff ? v.diff.reduce((t, b) => t + b.added.length + b.removed.length, 0) : 0;
        if (n) {
          const db = el('button', 'link', openVersion === v.id ? 'hide' : `\u00b1${n}`);
          db.title = 'What this step changed';
          db.addEventListener('click', () => { openVersion = openVersion === v.id ? null : v.id; compared = null; if (latest) render(latest); });
          row.append(db);
        } else if (v.changes && v.changes.length) {
          row.append(el('span', 'vchanges', v.changes.slice(0, 3).join(' \u00b7 ')));
        }
        if (v.id !== last.id) {
          const cb = el('button', 'link', 'vs now');
          cb.title = 'Everything that has changed between this version and the document as it stands';
          cb.addEventListener('click', () => { openVersion = v.id; compared = null; vscode.postMessage({ type: 'version.compare', id: v.id }); });
          row.append(cb);
          const rb = el('button', 'link', 'restore');
          rb.addEventListener('click', () => vscode.postMessage({ type: 'restore', snapshotId: v.id }));
          row.append(rb);
        }
        vl.append(row);
        if (openVersion === v.id) {
          const blocks = compared && compared.id === v.id ? compared.diff : v.diff;
          if (blocks && blocks.length) {
            const wrap = el('div', 'vdiff');
            if (compared && compared.id === v.id) wrap.append(el('div', 'dsec', 'compared with the document as it stands'));
            wrap.append(diffBlock(blocks));
            vl.append(wrap);
          } else {
            vl.append(el('div', 'vdiff muted', 'No difference.'));
          }
        }
      }
      root.append(vl);
    }

    const resolved = a.resolved || [];
    if (!a.entries.length && !resolved.length && !versionsOpen) {
      const ph = el('div', 'placeholder');
      ph.append(el('h3', null, 'Your ideas go here.'), el('p', null, 'Type one below and press Enter. Rough is fine: each idea is merged into the prompt on the right, never pasted in as a bullet.'));
      // Offered here rather than on the + button: this is where someone is when a starting shape
      // would help, and adding a picker in front of every new prompt would tax all of them.
      const tp = el('p', 'muted');
      tp.append(document.createTextNode('Or start from a shape: '));
      const tb = el('button', 'link', 'Code review, landing copy, research brief\u2026');
      tb.addEventListener('click', () => vscode.postMessage({ type: 'newFromTemplate' }));
      tp.append(tb);
      ph.append(tp);
      root.append(ph);
      return;
    }
    if (!a.entries.length && !resolved.length) return;
    const log = el('div', 'log');
    // Ideas and the answers to the conflicts they raised, in the order they happened.
    const timeline = [...a.entries.map((e) => ({ ts: e.ts, e })), ...resolved.map((r) => ({ ts: r.ts, r }))].sort((x, y) => x.ts - y.ts);
    for (const item of timeline) {
      if (item.r) { log.append(resolutionMsg(item.r)); continue; }
      const e = item.e;
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
        const files = e.attachments || e.images || [];
        if (files.length) {
          const row = el('div', 'mimgs');
          for (const f of files) row.append(fileChip(f, null));
          bubble.append(row);
        }
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
        const snap = a.snapshots.find((v) => v.id === e.snapshotId);
        const before = priorSnapshot(a.snapshots, e.snapshotId);
        if (before) {
          const ub = el('button', 'icon', '↶');
          ub.title = `Undo this merge: put the document back to how it was before this idea (${before.id})`;
          ub.addEventListener('click', () => vscode.postMessage({ type: 'restore', snapshotId: before.id }));
          acts.append(ub);
        }
        const rb = el('button', 'icon', '⟲');
        rb.title = `Put the document back to right after this idea (${e.snapshotId})`;
        rb.addEventListener('click', () => vscode.postMessage({ type: 'restore', snapshotId: e.snapshotId }));
        acts.append(rb);
        if (snap && snap.diff && snap.diff.length) {
          const d = el('button', 'icon', '±');
          d.title = 'What this idea changed in the document';
          d.addEventListener('click', () => { openDiff = openDiff === e.id ? null : e.id; if (latest) render(latest); });
          acts.append(d);
        }
      }
      msg.append(bubble, meta, acts);
      const snapForDiff = e.snapshotId && a.snapshots.find((v) => v.id === e.snapshotId);
      if (openDiff === e.id && snapForDiff && snapForDiff.diff) msg.append(diffBlock(snapForDiff.diff));
      log.append(msg);
    }
    root.append(log);
    root.scrollTop = root.scrollHeight;
  }

  /** A conflict the person answered, in the thread beside the ideas, in the conflict's yellow. */
  function resolutionMsg(r) {
    const msg = el('div', 'msg resolution');
    const bubble = el('div', 'bubble');
    const head = el('div', 'rhead');
    head.append(el('span', 'rtag', 'Conflict'), el('span', 'rwhere', `${r.id}${r.section ? ` · ${r.section}` : ''}`));
    const kept = r.keep === 'new' ? r.incoming : r.existing;
    const dropped = r.keep === 'new' ? r.existing : r.incoming;
    bubble.append(head, el('div', 'mtext', `You kept the ${r.keep === 'new' ? 'new' : 'existing'} side: ${kept}`));
    if (dropped) {
      const d = el('div', 'rdropped', dropped);
      d.title = 'The side you did not keep';
      bubble.append(d);
    }
    msg.append(bubble, el('div', 'mmeta', `${ago(r.ts)} · ${r.by === 'local' ? 'placed at once, no engine call' : 'merged by the engine'}`));
    return msg;
  }

  /** One attached file: its kind, its name (click to open), its size, and a remove button while drafting. */
  function fileChip(f, onRemove) {
    const chip = el('span', 'imgchip');
    const tag = f.kind === 'image' ? 'IMG' : f.kind === 'pdf' ? 'PDF' : f.kind === 'text' ? 'TXT' : 'FILE';
    const open = el('button', 'imgname', f.name);
    open.title = `${f.path}\nClick to open it.`;
    open.addEventListener('click', () => vscode.postMessage({ type: 'attachment.open', path: f.path }));
    chip.append(el('span', 'kindtag', tag), open);
    if (f.bytes) chip.append(el('span', 'imgsize', f.bytes >= 1048576 ? `${(f.bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(f.bytes / 1024))} KB`));
    if (f.secret) { chip.classList.add('secret'); chip.title = 'Looks like a key or credentials file: only its name is ever sent.'; }
    if (onRemove) {
      const x = el('button', 'imgx', '×');
      x.title = 'Remove from this idea. The file stays in the library.';
      x.addEventListener('click', onRemove);
      chip.append(x);
    }
    return chip;
  }

  function renderUsage(s) {
    const root = $('usage');
    const a = s.active;
    if (!a) { root.textContent = ''; root.classList.remove('over'); return; }
    const u = a.usage;
    root.textContent = u.calls ? `${u.calls} call${u.calls === 1 ? '' : 's'} \u00b7 ${k(u.input)} in / ${k(u.output)} out` : '';
    // Tokens, not money. A CLI login draws on a plan, so a dollar figure would be wrong for the way
    // most people run this, and a wrong number is worse than none.
    const budget = (s.project && s.project.tokenBudget) || 0;
    const total = u.input + u.output;
    const over = budget > 0 && total > budget;
    root.classList.toggle('over', over);
    if (over) root.title = `${k(total)} tokens on this prompt, past the ${k(budget)} you set in promptForge.tokenBudget.`;
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
  const LAYOUT_DEFAULTS = { mode: 'auto', stackWidth: 620, split: 52, railCollapsed: false };
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
    const shut = Boolean(layout.railCollapsed);
    $('app').classList.toggle('rail-collapsed', shut);
    const t = $('rail-toggle');
    t.textContent = shut ? '›' : '‹';
    t.title = shut ? 'Show the prompts list' : 'Collapse the prompts list';
    t.setAttribute('aria-expanded', String(!shut));
  }

  // Applied here first and posted after, like the divider: the click has to feel instant, and the
  // extension echoes the same value back on the next state anyway.
  function toggleRail() {
    layout.railCollapsed = !layout.railCollapsed;
    applyLayout();
    vscode.postMessage({ type: 'setLayout', railCollapsed: layout.railCollapsed });
  }
  $('rail-toggle').addEventListener('click', toggleRail);

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
        : 'Type an idea and press Enter. Shift+Enter for a new line. Paste, drop or clip a file to attach it.';
  }

  // ------------------------------------------------------------------------------------------
  // Wiring
  // ------------------------------------------------------------------------------------------
  // ------------------------------------------------------------------------------------------
  // Images
  //
  // Paste a screenshot into the idea box and it is written to disk immediately, then referred to by
  // path. Nothing base64 stays in the page, in the panel state, or in the sidecar: a screenshot is
  // hundreds of KB and the sidecar is rewritten constantly.
  // ------------------------------------------------------------------------------------------
  // Any file, three ways in: the paperclip (a real path, picked in VS Code's own dialog), a paste,
  // or a drop onto the idea box. Pasted and dropped bytes are posted once, written to disk by the
  // extension, and come back as a chip naming the file; nothing base64 stays in the page.
  let pending = [];   // files attached to the idea being typed
  const MAX_UPLOAD = 25 * 1024 * 1024;

  function renderPending() {
    const root = $('attached');
    root.textContent = '';
    root.hidden = !pending.length;
    for (const f of pending) {
      root.append(fileChip(f, () => { pending = pending.filter((p) => p.id !== f.id); renderPending(); }));
    }
  }

  function upload(file, { pasted = false } = {}) {
    if (!file) return;
    if (file.size > MAX_UPLOAD) { showNotice('error', `${file.name || 'That file'} is over 25 MB; attachments are capped there.`); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result || '');
      const comma = url.indexOf(',');
      if (comma < 0) return;
      const data = url.slice(comma + 1);
      // A screenshot from the clipboard has no real name; it goes where screenshots always went.
      if (pasted && file.type.startsWith('image/')) {
        vscode.postMessage({ type: 'image.paste', data, ext: (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg'), name: file.name || '' });
      } else {
        vscode.postMessage({ type: 'file.drop', data, name: file.name || 'attachment' });
      }
    };
    reader.readAsDataURL(file);
  }

  idea.addEventListener('paste', (e) => {
    const files = [...((e.clipboardData && e.clipboardData.items) || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) upload(f, { pasted: true });
  });

  const composeBox = $('compose-box');
  for (const ev of ['dragenter', 'dragover']) {
    composeBox.addEventListener(ev, (e) => {
      if (!e.dataTransfer || ![...e.dataTransfer.types].includes('Files')) return;
      e.preventDefault();
      composeBox.classList.add('dragover');
    });
  }
  composeBox.addEventListener('dragleave', () => composeBox.classList.remove('dragover'));
  composeBox.addEventListener('drop', (e) => {
    composeBox.classList.remove('dragover');
    const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
    if (!files.length) return;
    e.preventDefault();
    for (const f of files) upload(f);
  });
  $('attach').addEventListener('click', () => vscode.postMessage({ type: 'attach.pick' }));

  idea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const text = idea.value.trim();
      if (!text) return;
      vscode.postMessage({ type: 'idea', text, attachments: pending });
      idea.value = '';
      pending = [];
      renderPending();
      save();
    }
  });
  // Typing an idea is the moment to start the engine the merge will use. Throttled: the extension
  // keeps one warm process and refreshes it, so once every fifteen seconds is plenty.
  let lastTyping = 0;
  idea.addEventListener('input', () => {
    save();
    const now = Date.now();
    if (idea.value.trim() && now - lastTyping > 15000) { lastTyping = now; vscode.postMessage({ type: 'typing' }); }
  });
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
  // Alt+click is the way past "nothing has changed since the last polish".
  $('polish').addEventListener('click', (e) => vscode.postMessage({ type: 'polish', full: Boolean(e.altKey) }));
  $('copy').addEventListener('click', () => vscode.postMessage({ type: 'copy' }));
  // ------------------------------------------------------------------------------------------
  // Target: "for <model>" on the Prompt head, where "for" is the divider and the model is the
  // control. A floating list rather than a <select> so each option can carry its one-line blurb;
  // a native select shows the label alone.
  // ------------------------------------------------------------------------------------------
  // Vendor marks, by family. Kept here rather than in the state so the SVG never rides along on
  // every repaint, and in one map so an official asset can replace a drawn one in a single line.
  // The vendors' own marks, not approximations. Hand-drawn ones read as a thin asterisk and a plain
  // hexagon at 13px, which is worse than no logo. Paths lifted verbatim from Simple Icons (CC0,
  // claude + googlegemini) and Bootstrap Icons (MIT, openai); each keeps its source viewBox because
  // rescaling path data by hand is how a mark ends up subtly wrong.
  const MARK = {
    claude: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"/></svg>',
    gemini: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81"/></svg>',
    gpt: '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" aria-hidden="true"><path d="M14.949 6.547a3.94 3.94 0 0 0-.348-3.273 4.11 4.11 0 0 0-4.4-1.934A4.1 4.1 0 0 0 8.423.2 4.15 4.15 0 0 0 6.305.086a4.1 4.1 0 0 0-1.891.948 4.04 4.04 0 0 0-1.158 1.753 4.1 4.1 0 0 0-1.563.679A4 4 0 0 0 .554 4.72a3.99 3.99 0 0 0 .502 4.731 3.94 3.94 0 0 0 .346 3.274 4.11 4.11 0 0 0 4.402 1.933c.382.425.852.764 1.377.995.526.231 1.095.35 1.67.346 1.78.002 3.358-1.132 3.901-2.804a4.1 4.1 0 0 0 1.563-.68 4 4 0 0 0 1.14-1.253 3.99 3.99 0 0 0-.506-4.716m-6.097 8.406a3.05 3.05 0 0 1-1.945-.694l.096-.054 3.23-1.838a.53.53 0 0 0 .265-.455v-4.49l1.366.778q.02.011.025.035v3.722c-.003 1.653-1.361 2.992-3.037 2.996m-6.53-2.75a2.95 2.95 0 0 1-.36-2.01l.095.057L5.29 12.09a.53.53 0 0 0 .527 0l3.949-2.246v1.555a.05.05 0 0 1-.022.041L6.473 13.3c-1.454.826-3.311.335-4.15-1.098m-.85-6.94A3.02 3.02 0 0 1 3.07 3.949v3.785a.51.51 0 0 0 .262.451l3.93 2.237-1.366.779a.05.05 0 0 1-.048 0L2.585 9.342a2.98 2.98 0 0 1-1.113-4.094zm11.216 2.571L8.747 5.576l1.362-.776a.05.05 0 0 1 .048 0l3.265 1.86a3 3 0 0 1 1.173 1.207 2.96 2.96 0 0 1-.27 3.2 3.05 3.05 0 0 1-1.36.997V8.279a.52.52 0 0 0-.276-.445m1.36-2.015-.097-.057-3.226-1.855a.53.53 0 0 0-.53 0L6.249 6.153V4.598a.04.04 0 0 1 .019-.04L9.533 2.7a3.07 3.07 0 0 1 3.257.139c.474.325.843.778 1.066 1.303.223.526.289 1.103.191 1.664zM5.503 8.575 4.139 7.8a.05.05 0 0 1-.026-.037V4.049c0-.57.166-1.127.476-1.607s.752-.864 1.275-1.105a3.08 3.08 0 0 1 3.234.41l-.096.054-3.23 1.838a.53.53 0 0 0-.265.455zm.742-1.577 1.758-1 1.762 1v2l-1.755 1-1.762-1z"/></svg>',
  };

  function markFor(family) {
    const svg = MARK[family];
    const span = el('span', 'fitem-mark');
    if (svg) span.innerHTML = svg;              // a constant in this file, never user text
    return span;
  }

  function renderTarget(s) {
    const a = s.active;
    const btn = $('target-btn');
    btn.disabled = !a;
    if (!a) { $('target-label').textContent = ''; closeTargetMenu(); return; }
    const t = s.targets.find((x) => x.id === a.target);
    $('target-label').textContent = (t && t.label) || a.target;
    const blurbs = s.blurbs || { roles: {}, targets: {} };
    btn.title = blurbs.targets && blurbs.targets[a.target]
      ? `${blurbs.roles.target || ''}\n${blurbs.targets[a.target]}`
      : (blurbs.roles.target || 'The model this prompt is being written for.');
  }

  function closeTargetMenu() {
    const menu = $('target-menu');
    menu.hidden = true;
    $('target-btn').setAttribute('aria-expanded', 'false');
  }

  function openTargetMenu() {
    const s = latest;
    if (!s || !s.active) return;
    closeSendMenu();
    const menu = $('target-menu');
    const blurbs = (s.blurbs && s.blurbs.targets) || {};
    menu.textContent = '';
    for (const t of s.targets) {
      const item = el('button', `fitem${t.id === s.active.target ? ' on' : ''}`);
      item.setAttribute('role', 'option');
      const text = el('span', 'fitem-text');
      text.append(el('span', 'fitem-label', t.label));
      if (blurbs[t.id]) text.append(el('span', 'fitem-desc', blurbs[t.id]));
      item.append(markFor(t.family), text);
      item.addEventListener('click', () => { closeTargetMenu(); vscode.postMessage({ type: 'setTarget', target: t.id }); });
      menu.append(item);
    }
    menu.hidden = false;
    $('target-btn').setAttribute('aria-expanded', 'true');
    // Anchored under the trigger and clamped to the panel, so it never hangs off a narrow window.
    const r = $('target-btn').getBoundingClientRect();
    menu.style.top = `${r.bottom + 4}px`;
    const w = menu.offsetWidth;
    menu.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - w - 8))}px`;
    const first = menu.querySelector('.fitem.on') || menu.querySelector('.fitem');
    if (first) first.focus();
  }

  $('target-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if ($('target-menu').hidden) openTargetMenu(); else closeTargetMenu();
  });
  document.addEventListener('click', (e) => {
    if (!$('target-menu').hidden && !$('target-menu').contains(e.target)) closeTargetMenu();
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('target-menu').hidden) { closeTargetMenu(); $('target-btn').focus(); } });
  window.addEventListener('resize', closeTargetMenu);
  $('engine-summary').addEventListener('click', () => { engineOpen = !engineOpen; save(); if (latest) render(latest); });

  // ------------------------------------------------------------------------------------------
  // Add-on copy
  //
  // Offered only once a prompt has been copied AND something has been merged since. What it copies
  // is the change, not the prompt again: you have already pasted the prompt into a conversation, so
  // this is the next message in it. Using it moves the mark, so the button goes until there is
  // something new again — and that repeats without limit.
  // ------------------------------------------------------------------------------------------
  function renderAddonCopy(s) {
    const btn = $('copy-new');
    const a = s.active;
    const n = a && a.newSinceCopy;
    btn.hidden = !n;
    if (!n) return;
    const bits = [];
    if (n.added) bits.push(`${n.added} new line${n.added === 1 ? '' : ''}`);
    if (n.removed) bits.push(`${n.removed} removed`);
    $('copy-new-count').textContent = String(n.added || n.removed);
    btn.title = n.restyled
      ? `The whole prompt was restyled since you copied it, so an add-on would be most of it again. Copy the full prompt instead.`
      : `Copy just what changed since your last copy (${bits.join(', ')}), ready to paste as the next message in the same conversation.`;
    btn.classList.toggle('warn', Boolean(n.restyled));
  }

  $('copy-new').addEventListener('click', () => vscode.postMessage({ type: 'copyNew' }));

  let copiedTimer = null;
  function flashCopied() {
    const btn = $('copy');
    btn.classList.add('ok');
    clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => btn.classList.remove('ok'), 1400);
  }

  let copiedNewTimer = null;
  function flashCopiedNew() {
    const btn = $('copy-new');
    btn.classList.add('ok');
    clearTimeout(copiedNewTimer);
    copiedNewTimer = setTimeout(() => btn.classList.remove('ok'), 1400);
  }

  let noticeTimer = null;
  /** `action` ({ label, message }) adds a button that posts `message`; a notice with one stays up longer. */
  function showNotice(level, text, sticky = false, action = null) {
    const n = $('notice');
    n.textContent = text;
    n.className = `notice ${level}`;
    if (action && action.label && action.message) {
      const b = el('button', 'btn small notice-act', action.label);
      b.addEventListener('click', () => { n.hidden = true; vscode.postMessage(action.message); });
      n.append(b);
    }
    n.hidden = false;
    clearTimeout(noticeTimer);
    if (!sticky) noticeTimer = setTimeout(() => { n.hidden = true; }, action ? 20000 : level === 'error' ? 12000 : 5000);
  }

  // ------------------------------------------------------------------------------------------
  // In-panel dialogs: pick, ask, confirm
  //
  // Everything the extension needs to ask is asked here, in the floating style of the model picker,
  // never in VS Code's box at the top of the window or a pop-up in the corner. A pick is a list with
  // an icon, a label and a line of description per row (and a filter when the list is long); an ask
  // is one field with OK and Cancel; a confirm is a sentence and two buttons. One shows at a time;
  // any others wait their turn. Escape, Cancel and a click outside all answer "cancelled".
  // ------------------------------------------------------------------------------------------
  const UI_ICON = (() => {
    const svg = (d) => `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    return {
      root: svg('<path d="M1.8 4.2h4.4l1.4 1.5h6.6v7.1H1.8z"/><path d="M8 8.2v2.6M6.7 9.5h2.6"/>'),
      folder: svg('<path d="M1.8 4.2h4.4l1.4 1.5h6.6v7.1H1.8z"/>'),
      open: svg('<path d="M1.8 12.8V4.2h4.4l1.4 1.5h5.2v1.8"/><path d="M1.8 12.8 3.6 7.5h10.6l-1.8 5.3z"/>'),
      remote: svg('<rect x="1.8" y="2.5" width="12.4" height="8" rx="1.2"/><path d="M5.5 13.5h5M8 10.5v3"/>'),
      add: svg('<path d="M8 3v10M3 8h10"/>'),
      edit: svg('<path d="M11.3 2.2 13.8 4.7 5.6 12.9 2.6 13.4l.5-3z"/>'),
      eye: svg('<path d="M1.5 8s2.4-4.3 6.5-4.3S14.5 8 14.5 8 12.1 12.3 8 12.3 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="1.9"/>'),
      refresh: svg('<path d="M13.2 8a5.2 5.2 0 1 1-1.5-3.7"/><path d="M13.5 2.4v2.9h-2.9"/>'),
      disconnect: svg('<path d="M6 1.5v3.5M10 1.5v3.5M4 5h8v2.8a4 4 0 0 1-8 0zM8 11.8v2.7"/><path d="m2 14 12-12"/>'),
      key: svg('<circle cx="5.3" cy="10.7" r="2.8"/><path d="m7.3 8.7 6.2-6.2M11.3 4.7l1.6 1.6M9.6 6.4l1.3 1.3"/>'),
      link: svg('<path d="M6.7 9.3a2.8 2.8 0 0 0 4 0l2.2-2.2a2.8 2.8 0 0 0-4-4L8 4"/><path d="M9.3 6.7a2.8 2.8 0 0 0-4 0L3.1 8.9a2.8 2.8 0 0 0 4 4L8 12"/>'),
      engine: svg('<circle cx="8" cy="8" r="2.3"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6 5 5M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4"/>'),
      template: svg('<rect x="2.5" y="1.8" width="11" height="12.4" rx="1.2"/><path d="M5 5h6M5 8h6M5 11h3.5"/>'),
      doc: svg('<path d="M3.5 1.8h6l3 3v9.4h-9z"/><path d="M9.5 1.8v3h3"/>'),
      terminal: svg('<rect x="1.8" y="2.8" width="12.4" height="10.4" rx="1.4"/><path d="m4.6 6.2 2 1.8-2 1.8M8.2 10h3.2"/>'),
      json: svg('<path d="M5.5 2.5c-1.8 0-1.8 1.2-1.8 2.4s-.6 2.1-1.7 3.1c1.1 1 1.7 1.9 1.7 3.1s0 2.4 1.8 2.4M10.5 2.5c1.8 0 1.8 1.2 1.8 2.4s.6 2.1 1.7 3.1c-1.1 1-1.7 1.9-1.7 3.1s0 2.4-1.8 2.4"/>'),
      trash: svg('<path d="M2.8 4.3h10.4M6.2 4.3V2.6h3.6v1.7M4.2 4.3l.7 9.1h6.2l.7-9.1"/>'),
    };
  })();

  const uiQueue = [];
  let uiCurrent = null;
  const uiSeen = new Set();

  /** Show one dialog; `done(value)` gets the answer, null (false for a confirm) when cancelled. */
  function uiOpen(spec, done) {
    uiQueue.push({ spec, done });
    if (!uiCurrent) uiNext();
  }

  function uiNext() {
    const next = uiQueue.shift();
    if (!next) return;
    uiCurrent = next;
    uiRender(next.spec);
  }

  function uiClose(value) {
    const cur = uiCurrent;
    if (!cur) return;
    uiCurrent = null;
    const layer = $('ui-layer');
    layer.hidden = true;
    layer.textContent = '';
    try { cur.done(value); } finally { uiNext(); }
  }

  const uiCancelValue = () => (uiCurrent && uiCurrent.spec.kind === 'confirm' ? false : null);

  /** Under its anchor when that is on screen, otherwise centred near the top of the panel. */
  function uiPlace(card, anchorId) {
    const a = anchorId ? $(anchorId) : null;
    const w = card.offsetWidth;
    if (a && a.offsetParent !== null) {
      const r = a.getBoundingClientRect();
      card.style.top = `${Math.max(8, Math.min(r.bottom + 4, window.innerHeight - card.offsetHeight - 8))}px`;
      card.style.left = `${Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8))}px`;
    } else {
      card.style.top = '56px';
      card.style.left = `${Math.max(8, Math.round((window.innerWidth - w) / 2))}px`;
    }
  }

  function uiButtons(card, buttons) {
    const row = el('div', 'ui-actions');
    for (const b of buttons) row.append(b);
    card.append(row);
  }

  function uiRender(spec) {
    closeTargetMenu();
    closeSendMenu();
    const layer = $('ui-layer');
    layer.textContent = '';
    const card = el('div', `ui-card ${spec.kind}`);
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    if (spec.title) card.append(el('div', 'ui-title', spec.title));
    if (spec.detail) card.append(el('div', 'ui-detail', spec.detail));
    const cancel = el('button', 'btn small', 'Cancel');
    cancel.addEventListener('click', () => uiClose(uiCancelValue()));
    let focus = cancel;

    if (spec.kind === 'pick') {
      const items = Array.isArray(spec.items) ? spec.items : [];
      const list = el('div', 'ui-list');
      list.setAttribute('role', 'listbox');
      let filter = null;
      if (spec.filter || items.length > 7) {
        filter = el('input', 'ui-input');
        filter.type = 'text';
        filter.placeholder = 'Type to filter';
        filter.spellcheck = false;
        card.append(filter);
      }
      const draw = (q) => {
        list.textContent = '';
        const needle = String(q || '').toLowerCase();
        const shown = items.filter((it) => !needle || `${it.label} ${it.description || ''} ${it.detail || ''}`.toLowerCase().includes(needle));
        if (!shown.length) list.append(el('div', 'fnote', items.length ? 'Nothing matches.' : 'Nothing to choose from.'));
        for (const it of shown) {
          const row = el('button', 'fitem');
          row.setAttribute('role', 'option');
          const mark = el('span', 'fitem-mark');
          if (UI_ICON[it.icon]) mark.innerHTML = UI_ICON[it.icon];   // constants above, never data
          const text = el('span', 'fitem-text');
          text.append(el('span', 'fitem-label', it.label));
          if (it.description) text.append(el('span', 'fitem-desc', it.description));
          if (it.detail) text.append(el('span', 'fitem-desc mono', it.detail));
          row.append(mark, text);
          row.addEventListener('click', () => uiClose(it.value));
          list.append(row);
        }
      };
      draw('');
      card.append(list);
      if (filter) {
        filter.addEventListener('input', () => draw(filter.value));
        filter.addEventListener('keydown', (e) => {
          const first = list.querySelector('.fitem');
          if (e.key === 'Enter' && first) { e.preventDefault(); first.click(); }
          if (e.key === 'ArrowDown' && first) { e.preventDefault(); first.focus(); }
        });
      }
      uiButtons(card, [cancel]);
      focus = filter || list.querySelector('.fitem') || cancel;
    } else if (spec.kind === 'ask') {
      const input = el('input', 'ui-input');
      input.type = spec.password ? 'password' : 'text';
      input.value = spec.value || '';
      input.placeholder = spec.placeholder || '';
      input.spellcheck = false;
      input.autocomplete = 'off';
      const err = el('div', 'ui-error');
      err.hidden = true;
      const ok = el('button', 'btn small primary', spec.okLabel || 'OK');
      const submit = () => {
        const v = input.value.trim();
        if (!v && !spec.allowEmpty) { err.textContent = 'This needs a value.'; err.hidden = false; return; }
        if (v && spec.pattern) {
          let re = null;
          try { re = new RegExp(spec.pattern); } catch { re = null; }
          if (re && !re.test(v)) { err.textContent = spec.patternMessage || 'That is not in the expected form.'; err.hidden = false; return; }
        }
        uiClose(v);
      };
      ok.addEventListener('click', submit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      card.append(input, err);
      uiButtons(card, [cancel, ok]);
      focus = input;
    } else {
      if (spec.text) card.append(el('div', 'ui-detail', spec.text));
      const ok = el('button', `btn small ${spec.danger ? 'danger' : 'primary'}`, spec.okLabel || 'OK');
      ok.addEventListener('click', () => uiClose(true));
      uiButtons(card, [cancel, ok]);
      focus = cancel;   // the safe answer is the default one
    }

    layer.append(card);
    layer.hidden = false;
    uiPlace(card, spec.anchor);
    focus.focus();
    if (focus.select && spec.kind === 'ask') focus.select();
  }

  // A click on the dimmed area outside the card is Cancel.
  $('ui-layer').addEventListener('mousedown', (e) => { if (e.target === $('ui-layer')) uiClose(uiCancelValue()); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && uiCurrent) { e.preventDefault(); e.stopPropagation(); uiClose(uiCancelValue()); return; }
    // Arrow keys move through the rows of whichever list has focus: a dialog, the model or the send list.
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const box = e.target && e.target.closest && e.target.closest('.floating, .ui-card');
    if (!box) return;
    const rows = [...box.querySelectorAll('.fitem')];
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement);
    rows[(i + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length].focus();
  }, true);

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'state') { connecting = false; render(m.data); }
    else if (m.type === 'notice') showNotice(m.level || 'info', m.text || '', false, m.action || null);
    // A question from the extension, answered in the panel. An id already shown (a replay after the
    // panel loaded) is ignored.
    else if (m.type === 'ui.open' && m.id && !uiSeen.has(m.id)) {
      uiSeen.add(m.id);
      uiOpen(m, (value) => vscode.postMessage({ type: 'ui.reply', id: m.id, value }));
    }
    else if (m.type === 'copied') flashCopied();
    else if (m.type === 'copiedNew') flashCopiedNew();
    else if (m.type === 'compare') { compared = { id: m.id, diff: m.diff }; openVersion = m.id; if (latest) render(latest); }
    else if ((m.type === 'attached' && m.attachment) || (m.type === 'imageSaved' && m.image)) { pending.push(m.attachment || m.image); renderPending(); }
    else if (m.type === 'progress' && latest && latest.active && latest.active.slug === m.slug) { latest.active.engine = m.engine; renderStatus(latest); }
    // The Send menu's contents: fills a menu already open, or opens it when the extension asks
    // (the command palette, or a Send update whose last place is gone).
    else if (m.type === 'sendMenu' && (m.open || !$('send-menu').hidden)) { openSendMenu(m); if (m.open) vscode.postMessage({ type: 'sendMenu.shown' }); }
    else if (m.type === 'focus') { if (!m.once || !uiSeen.has(m.once)) { idea.focus(); } if (m.once) { uiSeen.add(m.once); vscode.postMessage({ type: 'once.done', once: m.once }); } }
    // A selection sent from an editor: into the idea box, the cursor on a blank line above it for a note.
    else if (m.type === 'draft' && m.text && !(m.once && uiSeen.has(m.once))) {
      if (m.once) { uiSeen.add(m.once); vscode.postMessage({ type: 'once.done', once: m.once }); }
      const had = idea.value.replace(/\s+$/, '');
      idea.value = had ? `${had}\n\n${m.text}` : `\n\n${m.text}`;
      idea.focus();
      const at = had ? had.length + 1 : 0;
      idea.setSelectionRange(at, at);
      save();
    }
  });
  vscode.postMessage({ type: 'ready' });
}());
