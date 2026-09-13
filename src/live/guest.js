'use strict';
// The joining side of a live library. It keeps a copy of the sharer's library in a folder of its
// own and keeps that copy current: everything on connect, then each change as it is pushed. The
// window reads prompts from the copy exactly as it reads its own library, and anything that changes
// a prompt is sent to the sharer, whose window does it and pushes the result back to everyone.
//
// A dropped connection is retried with a growing pause, and every reconnect starts by comparing
// versions, so nothing that changed while it was away is missed.
const nodeFs = require('node:fs');
const nodeHttp = require('node:http');
const nodePath = require('node:path');
const W = require('./wire');
const F = require('./files');

const VERSIONS = '.live-versions.json';
const MAX_RESPONSE = 64 * 1024 * 1024;
const noop = () => {};

function createLiveGuest({
  invite, mirrorDir, me, log = { info: noop, warn: noop, error: noop, debug: noop },
  fs = nodeFs, http = nodeHttp, writeHook = null, onEvent = noop, onStatus = noop,
  backoff = [1000, 2000, 4000, 8000, 15000], helloTimeoutMs = 5000, staleMs = 45000,
}) {
  const key = W.keyOf(invite.secret);
  const tag = W.authTag(key);
  let addr = null;
  let stopped = false;
  let connId = 0;
  let attempt = 0;
  let retryTimer = null;
  let staleTimer = null;
  let stream = null;
  let lastData = 0;
  let viewSlug = null;
  let chain = Promise.resolve();
  let versions = {};
  try { versions = JSON.parse(fs.readFileSync(nodePath.join(mirrorDir, VERSIONS), 'utf8')) || {}; } catch { versions = {}; }

  const saveVersions = () => {
    try {
      const p = nodePath.join(mirrorDir, VERSIONS);
      fs.writeFileSync(`${p}.tmp`, JSON.stringify(versions));
      fs.renameSync(`${p}.tmp`, p);
    } catch (e) { log.warn(`live: could not record versions: ${e.message}`); }
  };

  const enqueue = (fn) => {
    chain = chain.then(fn).catch((e) => log.warn(`live: ${e.stack || e.message}`));
    return chain;
  };

  const status = (s, error = null) => { try { onStatus(s, error); } catch { /* the runtime's problem */ } };

  const stamp = () => ({ ts: Date.now(), nonce: W.nonce(), id: me.id, name: me.name, machine: me.machine, account: me.account });

  function request({ host, path: p, body = null, method = 'POST', timeoutMs = 20000 }) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        host, port: invite.port, path: p, method, agent: false, timeout: timeoutMs,
        headers: body ? { 'content-type': 'application/octet-stream', 'content-length': body.length, 'x-pf-auth': tag } : { 'x-pf-auth': tag },
      }, (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (c) => {
          size += c.length;
          if (size > MAX_RESPONSE) { req.destroy(new Error('the answer was too large')); return; }
          chunks.push(c);
        });
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('timed out')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function call(host, route, obj = {}, bytes = null, opts = {}) {
    const r = await request({ host, path: route, body: W.seal(key, { ...stamp(), ...obj }, bytes), ...opts });
    const got = r.body.length ? W.unseal(key, r.body) : null;
    if (!got) {
      const e = new Error(r.status === 401 ? 'The invite was not accepted. Sharing may have been stopped and started again, which makes a new invite.' : `the sharing window answered ${r.status}`);
      e.code = r.status === 401 ? 'refused' : 'http';
      throw e;
    }
    return { host, status: r.status, obj: got.obj, bytes: got.bytes };
  }

  // ----------------------------------------------------------------------------------------------
  // The copy on disk
  // ----------------------------------------------------------------------------------------------
  async function writeLocal(rel, buf, v) {
    const abs = F.absOf(mirrorDir, rel);
    if (!abs) return false;
    if (writeHook && rel.endsWith('.md') && !rel.includes('/')) {
      // An open document is written through the editor, or the editor would not see it.
      if (await writeHook(abs, buf.toString('utf8'), rel)) { versions[rel] = v; return true; }
    }
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(`${abs}.tmp`, buf);
    fs.renameSync(`${abs}.tmp`, abs);
    versions[rel] = v;
    return true;
  }

  function removeLocal(rel) {
    const abs = F.absOf(mirrorDir, rel);
    delete versions[rel];
    if (!abs) return;
    try { fs.unlinkSync(abs); } catch { /* already gone */ }
    if (rel.includes('/')) { try { fs.rmdirSync(nodePath.dirname(abs)); } catch { /* not empty */ } }
  }

  async function fetchFile(rel) {
    const r = await call(addr, '/pf/file', { path: rel });
    if (!r.obj.ok) {
      if (r.obj.error === 'gone') { removeLocal(rel); return false; }
      throw new Error(r.obj.error || 'the file could not be read');
    }
    return writeLocal(rel, r.bytes, { size: r.obj.size, mtimeMs: r.obj.mtimeMs });
  }

  const haveCurrent = (rel, v) => F.sameVersion(versions[rel], v) && Boolean(F.absOf(mirrorDir, rel)) && fs.existsSync(F.absOf(mirrorDir, rel));

  /** Make the copy match the sharer's manifest: fetch what differs, remove what is gone. */
  async function catchUp(manifest) {
    const changed = [];
    const removed = [];
    const want = Object.entries(manifest || {}).filter(([rel]) => F.isLibraryFile(rel));
    const todo = want.filter(([rel, v]) => !haveCurrent(rel, v)).map(([rel]) => rel);
    // Sidecars first, so a prompt never appears in the list before its history does.
    todo.sort((a, b) => Number(b.endsWith('.forge.json')) - Number(a.endsWith('.forge.json')));
    let next = 0;
    const worker = async () => {
      while (next < todo.length && !stopped) {
        const rel = todo[next++];
        try { if (await fetchFile(rel)) changed.push(rel); } catch (e) { log.warn(`live: could not fetch ${rel}: ${e.message}`); }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    const keep = new Set(want.map(([rel]) => rel));
    for (const rel of F.scan(mirrorDir, fs).keys()) {
      if (!keep.has(rel)) { removeLocal(rel); removed.push(rel); }
    }
    saveVersions();
    if (changed.length || removed.length) onEvent({ type: 'files', changed, removed });
  }

  async function applyFiles(evt) {
    const changed = [];
    for (const f of Array.isArray(evt.files) ? evt.files : []) {
      if (!f || !F.isLibraryFile(f.path)) continue;
      const v = { size: f.size, mtimeMs: f.mtimeMs };
      if (haveCurrent(f.path, v)) continue;
      try {
        const ok = typeof f.text === 'string' ? await writeLocal(f.path, Buffer.from(f.text, 'utf8'), v) : await fetchFile(f.path);
        if (ok) changed.push(f.path);
      } catch (e) { log.warn(`live: could not update ${f.path}: ${e.message}`); }
    }
    const removed = [];
    for (const rel of Array.isArray(evt.removed) ? evt.removed : []) {
      if (!F.isLibraryFile(rel)) continue;
      removeLocal(rel);
      removed.push(rel);
    }
    saveVersions();
    if (changed.length || removed.length) onEvent({ type: 'files', changed, removed });
  }

  // ----------------------------------------------------------------------------------------------
  // The connection
  // ----------------------------------------------------------------------------------------------
  async function hello() {
    // Every address the invite lists, at once; the first to answer is the one used.
    const tries = invite.addrs.map((a) => call(a, '/pf/hello', {}, null, { timeoutMs: helloTimeoutMs }));
    try {
      return await Promise.any(tries);
    } catch (agg) {
      const errs = (agg && agg.errors) || [];
      const refused = errs.find((e) => e && e.code === 'refused');
      if (refused) throw refused;
      const e = new Error(`Could not reach ${invite.host} at ${invite.addrs.join(', ')} (port ${invite.port}). Both computers need to be on the same network or tailnet, with ${invite.host}’s Prompt Forge sharing and its firewall letting VS Code accept connections.`);
      e.code = 'unreachable';
      throw e;
    }
  }

  function scheduleRetry(my, err) {
    if (stopped || my !== connId) return;
    connId += 1;
    if (stream) { try { stream.destroy(); } catch { /* gone */ } stream = null; }
    clearInterval(staleTimer);
    const wait = backoff[Math.min(attempt, backoff.length - 1)];
    attempt += 1;
    status('reconnecting', err ? err.message : null);
    retryTimer = setTimeout(connect, wait);
  }

  async function connect() {
    if (stopped) return;
    const my = ++connId;
    status(attempt ? 'reconnecting' : 'connecting');
    let h;
    try { h = await hello(); } catch (e) {
      if (e.code === 'refused') { stopped = true; status('error', e.message); onEvent({ type: 'refused', error: e.message }); return; }
      scheduleRetry(my, e);
      return;
    }
    if (stopped || my !== connId) return;
    if (!h.obj.ok) {
      stopped = true;
      const msg = h.obj.error === 'account'
        ? `${invite.host}’s library is shared for ${h.obj.account}. Sign in to Claude as ${h.obj.account} to join it.`
        : h.obj.error || 'The sharing window turned the connection down.';
      status('error', msg);
      onEvent({ type: 'refused', error: msg });
      return;
    }
    addr = h.host;
    onEvent({ type: 'hello', host: h.obj.host, people: h.obj.people || [], engines: h.obj.engines || {} });
    await enqueue(() => catchUp(h.obj.manifest));
    if (stopped || my !== connId) return;
    onEvent({ type: 'synced' });
    openStream(my);
  }

  function openStream(my) {
    const a = W.b64u(W.seal(key, stamp()));
    const req = http.request({ host: addr, port: invite.port, path: `/pf/events?a=${a}`, method: 'GET', agent: false, headers: { accept: 'text/event-stream', 'x-pf-auth': tag } }, (res) => {
      if (res.statusCode !== 200) { res.resume(); scheduleRetry(my, new Error(`the sharing window answered ${res.statusCode}`)); return; }
      attempt = 0;
      lastData = Date.now();
      status('live');
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        lastData = Date.now();
        buf += chunk;
        let i = buf.indexOf('\n\n');
        while (i >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('');
          if (data) {
            const got = W.unseal(key, W.unb64u(data));
            if (got) handleEvent(got.obj, my);
          }
          i = buf.indexOf('\n\n');
        }
      });
      res.on('end', () => scheduleRetry(my, new Error(`${invite.host} closed the connection`)));
      res.on('error', (e) => scheduleRetry(my, e));
      // Anything that changed between the hello and this stream opening is caught here.
      enqueue(async () => {
        if (stopped || my !== connId) return;
        const again = await call(addr, '/pf/hello', {});
        if (again.obj.ok) await catchUp(again.obj.manifest);
        if (viewSlug) await call(addr, '/pf/cmd', { cmd: 'view', args: { slug: viewSlug } }).catch(noop);
      });
    });
    req.on('error', (e) => scheduleRetry(my, e));
    req.end();
    stream = req;
    clearInterval(staleTimer);
    // The sharer pings every fifteen seconds. Silence for three of those is a dead connection that
    // has not noticed yet (a laptop lid, a network change).
    staleTimer = setInterval(() => { if (Date.now() - lastData > staleMs) scheduleRetry(my, new Error('the connection went quiet')); }, 5000);
  }

  function handleEvent(evt, my) {
    if (!evt || typeof evt !== 'object' || my !== connId) return;
    enqueue(async () => {
      if (evt.type === 'files') await applyFiles(evt);
      else if (evt.type === 'presence' || evt.type === 'engine' || evt.type === 'hello' || evt.type === 'notice') onEvent(evt);
    });
  }

  return {
    start() { connect(); },
    /** Ask the sharing window to do something. Resolves with its result; rejects with its reason. */
    async command(cmd, args = {}, bytes = null) {
      if (!addr) throw new Error(`not connected to ${invite.host} yet`);
      const r = await call(addr, '/pf/cmd', { cmd, args }, bytes);
      if (!r.obj.ok) throw new Error(r.obj.error || 'refused');
      return r.obj.result;
    },
    view(slug) {
      viewSlug = slug || null;
      if (addr) call(addr, '/pf/cmd', { cmd: 'view', args: { slug: viewSlug } }).catch(noop);
    },
    connected: () => Boolean(addr) && !stopped,
    idle: () => chain,
    leave() {
      stopped = true;
      connId += 1;
      clearTimeout(retryTimer);
      clearInterval(staleTimer);
      if (stream) { try { stream.destroy(); } catch { /* gone */ } stream = null; }
    },
  };
}

module.exports = { createLiveGuest, VERSIONS };
