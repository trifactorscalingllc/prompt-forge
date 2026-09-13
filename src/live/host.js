'use strict';
// The sharing side of a live library: a small HTTP server in this window that others connect to.
//
//   POST /pf/hello    who is connecting; answers with every library file's version, who is here,
//                     and what each prompt's engine is doing
//   POST /pf/file     one library file's bytes
//   POST /pf/cmd      do something to a prompt (add an idea, answer a conflict, edit the document)
//   GET  /pf/events   a stream of what changed, pushed the moment it changes
//
// Every body is sealed (see wire.js); anything that does not open is answered with a bare 401 and
// nothing else. The library folder is watched, and a change to any library file is pushed to every
// connected window within a few tens of milliseconds -- the text of a prompt or its history inline,
// an attached file by name, to be fetched. This window stays the one place merges run, so two people
// adding ideas at once still produce one queue and one document.
const nodeFs = require('node:fs');
const nodeHttp = require('node:http');
const nodePath = require('node:path');
const W = require('./wire');
const F = require('./files');
const { LIMITS } = require('../attachments');

const MAX_BODY = LIMITS.upload + 1024 * 1024;
const INLINE_MAX = 2 * 1024 * 1024;
const noop = () => {};

function readBody(req, limit) {
  return new Promise((resolve) => {
    const chunks = [];
    let n = 0;
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { finish(null); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
    req.on('aborted', () => finish(null));
  });
}

function listen(server, port, bindHost) {
  return new Promise((resolve, reject) => {
    const onErr = (e) => { server.removeListener('listening', onOk); reject(e); };
    const onOk = () => { server.removeListener('error', onErr); resolve(server.address().port); };
    server.once('error', onErr);
    server.once('listening', onOk);
    server.listen(port, bindHost);
  });
}

const cleanName = (v, fallback) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 80) || fallback;

function createLiveHost({
  dir, secret, account, me, port = W.DEFAULT_PORT, bindHost = '0.0.0.0',
  log = { info: noop, warn: noop, error: noop, debug: noop }, fs = nodeFs, http = nodeHttp,
  onCommand = async () => null, onPresence = noop, scanMs = 1500, heartbeatMs = 15000, retryPortMs = 0,
}) {
  const key = W.keyOf(secret);
  const tag = W.authTag(key);
  const guard = W.createReplayGuard();
  let server = null;
  let watcher = null;
  let scanTimer = null;
  let beatTimer = null;
  let debounce = null;
  let manifest = new Map();
  let seq = 0;
  let hostSlug = null;
  let stopped = false;
  const guests = new Map();     // id -> { id, name, machine, slug, streams: Set<res> }
  const engines = new Map();    // slug -> the engine state the panel draws
  const sockets = new Set();

  const people = () => [
    { id: 'host', name: me.name, machine: me.machine, slug: hostSlug, role: 'host' },
    ...[...guests.values()].filter((g) => g.streams.size).map((g) => ({ id: g.id, name: g.name, machine: g.machine, slug: g.slug, role: 'guest' })),
  ];

  function write(res, evt) {
    try { res.write(`data: ${W.b64u(W.seal(key, evt))}\n\n`); } catch { /* the stream closed; its close handler tidies up */ }
  }

  function broadcast(evt) {
    seq += 1;
    const e = { ...evt, seq };
    for (const g of guests.values()) for (const res of g.streams) write(res, e);
  }

  function presenceChanged() {
    const list = people();
    broadcast({ type: 'presence', people: list });
    try { onPresence(list); } catch (e) { log.warn(`live: presence handler failed: ${e.message}`); }
  }

  function reply(res, status, obj, bytes = null) {
    const body = W.seal(key, obj, bytes);
    res.writeHead(status, { 'content-type': 'application/octet-stream', 'content-length': body.length, 'cache-control': 'no-store' });
    res.end(body);
  }

  // Deliberately says nothing: a caller without the invite learns only that the door is shut.
  const refuse = (res, status = 401) => { res.writeHead(status, { 'content-length': 0 }); res.end(); };

  function admit(obj) {
    const why = guard(obj.ts, obj.nonce);
    if (why === 'clock') return { error: 'The two computers’ clocks are more than ten minutes apart. Set both to the right time and try again.' };
    if (why) return { error: 'That request was already received once.' };
    if (!W.sameAccount(obj.account, account)) return { error: 'account', account };
    if (typeof obj.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(obj.id)) return { error: 'The joining window did not say who it is.' };
    return null;
  }

  function guestFor(obj) {
    let g = guests.get(obj.id);
    if (!g) { g = { id: obj.id, name: '', machine: '', slug: null, streams: new Set() }; guests.set(obj.id, g); }
    g.name = cleanName(obj.name, 'someone');
    g.machine = cleanName(obj.machine, '');
    return g;
  }

  // ----------------------------------------------------------------------------------------------
  // Watching the library
  // ----------------------------------------------------------------------------------------------
  function rescan() {
    if (stopped) return manifest;
    const next = F.scan(dir, fs);
    const { changed, removed } = F.diffManifest(manifest, next);
    manifest = next;
    if (changed.length || removed.length) {
      const files = changed.map((rel) => {
        const v = next.get(rel);
        const f = { path: rel, size: v.size, mtimeMs: v.mtimeMs };
        // A prompt and its history go inline, so the other window shows the change without another
        // round trip. Attached files are only named; they are fetched when needed.
        if (!rel.includes('/') && v.size <= INLINE_MAX) {
          try { f.text = fs.readFileSync(nodePath.join(dir, rel), 'utf8'); } catch { /* gone again; the next scan says so */ }
        }
        return f;
      });
      broadcast({ type: 'files', files, removed });
    }
    return manifest;
  }

  const rescanSoon = () => { clearTimeout(debounce); debounce = setTimeout(rescan, 40); };

  // ----------------------------------------------------------------------------------------------
  // Requests
  // ----------------------------------------------------------------------------------------------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!W.sameTag(req.headers['x-pf-auth'], tag)) { req.resume(); return refuse(res); }

    if (req.method === 'GET' && url.pathname === '/pf/events') {
      const got = W.unseal(key, W.unb64u(url.searchParams.get('a') || ''));
      if (!got) return refuse(res);
      const bad = admit(got.obj);
      if (bad) return reply(res, 403, { ok: false, ...bad });
      const g = guestFor(got.obj);
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      req.socket.setTimeout(0);
      req.socket.setNoDelay(true);
      req.socket.setKeepAlive(true, 15000);
      g.streams.add(res);
      res.write(': open\n\n');
      write(res, { type: 'hello', seq, people: people(), engines: Object.fromEntries(engines) });
      presenceChanged();
      const close = () => {
        if (!g.streams.delete(res)) return;
        if (!g.streams.size) g.slug = null;
        presenceChanged();
      };
      req.on('close', close);
      res.on('close', close);
      return undefined;
    }

    if (req.method !== 'POST' || !['/pf/hello', '/pf/file', '/pf/cmd'].includes(url.pathname)) return refuse(res, 404);
    const body = await readBody(req, MAX_BODY);
    if (!body) return refuse(res, 413);
    const got = W.unseal(key, body);
    if (!got) return refuse(res);
    const bad = admit(got.obj);
    if (bad) return reply(res, 403, { ok: false, ...bad });
    const g = guestFor(got.obj);

    if (url.pathname === '/pf/hello') {
      return reply(res, 200, {
        ok: true,
        host: { name: me.name, machine: me.machine, account },
        manifest: Object.fromEntries(rescan()),
        engines: Object.fromEntries(engines),
        people: people(),
      });
    }

    if (url.pathname === '/pf/file') {
      const abs = F.absOf(dir, got.obj.path);
      if (!abs) return reply(res, 400, { ok: false, error: 'That is not a file in the library.' });
      let st;
      let buf;
      try { st = fs.statSync(abs); buf = fs.readFileSync(abs); } catch { return reply(res, 404, { ok: false, error: 'gone' }); }
      return reply(res, 200, { ok: true, path: got.obj.path, size: st.size, mtimeMs: Math.round(st.mtimeMs) }, buf);
    }

    const cmd = String(got.obj.cmd || '');
    const args = got.obj.args && typeof got.obj.args === 'object' ? got.obj.args : {};
    if (cmd === 'view') {
      g.slug = typeof args.slug === 'string' && args.slug ? args.slug.slice(0, 200) : null;
      presenceChanged();
      return reply(res, 200, { ok: true, result: null });
    }
    try {
      const result = await onCommand({ id: g.id, name: g.name, machine: g.machine }, cmd, args, got.bytes && got.bytes.length ? got.bytes : null);
      // Whatever the command wrote is pushed now, not at the next watcher tick, so the answer and the
      // change arrive together.
      rescan();
      return reply(res, 200, { ok: true, result: result === undefined ? null : result });
    } catch (e) {
      return reply(res, 200, { ok: false, error: e && e.message ? e.message : String(e) });
    }
  }

  async function start() {
    manifest = F.scan(dir, fs);
    server = http.createServer((req, res) => {
      handle(req, res).catch((e) => {
        log.warn(`live: request failed: ${e.stack || e.message}`);
        try { refuse(res, 500); } catch { /* already answered */ }
      });
    });
    server.requestTimeout = 120000;
    server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
    let bound = null;
    // Resuming after a reload: the invites people hold name this port, and the window that held it a
    // moment ago may still be letting go. Wait for it before settling for another.
    const until = Date.now() + retryPortMs;
    while (port && bound == null && Date.now() < until) {
      try { bound = await listen(server, port, bindHost); } catch (e) {
        if (e.code !== 'EADDRINUSE') throw e;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
    const tries = bound != null ? [] : port ? [port, ...Array.from({ length: 9 }, (_, i) => port + i + 1), 0] : [0];
    for (const p of tries) {
      try { bound = await listen(server, p, bindHost); break; } catch (e) {
        if (e.code !== 'EADDRINUSE' && e.code !== 'EACCES') throw e;
      }
    }
    if (bound == null) throw new Error('no free port');
    try {
      watcher = fs.watch(dir, { recursive: true }, (_e, file) => {
        if (file && /^(\.git|\.trash)([\\/]|$)/.test(String(file))) return;
        rescanSoon();
      });
      watcher.on('error', (e) => { log.warn(`live: watching the library stopped (${e.message}); still checking every ${scanMs} ms`); });
    } catch (e) {
      watcher = null;
      log.warn(`live: cannot watch the library (${e.message}); checking every ${scanMs} ms`);
    }
    // The watcher is the fast path. The timer is what makes a missed event a short delay, not a loss.
    scanTimer = setInterval(rescan, scanMs);
    beatTimer = setInterval(() => {
      for (const g of guests.values()) for (const res of g.streams) { try { res.write(': ping\n\n'); } catch { /* closing */ } }
    }, heartbeatMs);
    log.info(`live: sharing ${dir} on port ${bound}`);
    return { port: bound };
  }

  function stop() {
    stopped = true;
    clearTimeout(debounce);
    clearInterval(scanTimer);
    clearInterval(beatTimer);
    if (watcher) { try { watcher.close(); } catch { /* already closed */ } watcher = null; }
    for (const g of guests.values()) for (const res of g.streams) { try { res.end(); } catch { /* gone */ } }
    guests.clear();
    if (server) {
      try { server.close(); } catch { /* not listening */ }
      for (const s of sockets) { try { s.destroy(); } catch { /* gone */ } }
      server = null;
    }
  }

  return {
    start,
    stop,
    people,
    /** What a prompt's engine is doing, for everyone watching it. */
    setEngine(slug, engine) {
      if (!slug || !engine) return;
      engines.set(slug, engine);
      broadcast({ type: 'engine', slug, engine });
    },
    /** Which prompt this window has open, so the others can see where everyone is. */
    setView(slug) {
      if (hostSlug === (slug || null)) return;
      hostSlug = slug || null;
      presenceChanged();
    },
    notify: (evt) => broadcast(evt),
    rescan,
  };
}

module.exports = { createLiveHost, MAX_BODY };
