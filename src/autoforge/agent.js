'use strict';
// The local endpoint the Claude Code plugin's hooks post to.
//
// It listens on 127.0.0.1 on a free port, behind a random token in the path, and writes its URL to
// ~/.prompt-forge/autoforge-url. The hooks read that file on every call, so no port or token is ever
// baked into the plugin, and when no window is running auto-forge the file is gone, curl fails, and
// `|| true` keeps the chat silent (measured in the day-1 test: an http hook printed an error instead).
//
// Several VS Code windows: the newest one writes the file; the others notice it has gone when that
// window closes, and take over.
const crypto = require('node:crypto');
const http = require('node:http');
const nodeFs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const EVENTS = new Set(['prompt', 'stop', 'ask']);
const MAX_BODY = 2 * 1024 * 1024;

function urlFilePath(home = os.homedir()) {
  return path.join(home, '.prompt-forge', 'autoforge-url');
}

function createAgent({ handle, log = { info() {}, warn() {} }, home = os.homedir(), fs = nodeFs, reclaimMs = 30000 }) {
  const token = crypto.randomBytes(18).toString('hex');
  const file = urlFilePath(home);
  let server = null;
  let url = '';
  let timer = null;

  const reply = (res, obj) => {
    const body = JSON.stringify(obj || {});
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };

  function onRequest(req, res) {
    const parts = String(req.url || '').split('?')[0].split('/').filter(Boolean);
    if (req.method !== 'POST' || parts.length !== 3 || parts[0] !== 'h' || parts[1] !== token || !EVENTS.has(parts[2])) {
      res.writeHead(404); res.end(); return;
    }
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', async () => {
      let input = null;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { reply(res, {}); return; }
      const entrypoint = req.headers['x-claude-entrypoint'];
      if (input && typeof input === 'object' && entrypoint && !input.entrypoint) input.entrypoint = String(entrypoint);
      let out = {};
      try { out = await handle(parts[2], input); } catch (e) { log.warn(`auto-forge: ${parts[2]} failed: ${e.message}`); }
      reply(res, out);
    });
  }

  function writeUrl() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, url, { mode: 0o600 });
      fs.renameSync(tmp, file);
      return true;
    } catch (e) {
      log.warn(`auto-forge: cannot write ${file}: ${e.message}`);
      return false;
    }
  }

  const current = () => { try { return fs.readFileSync(file, 'utf8').trim(); } catch { return ''; } };

  return {
    async start() {
      if (server) return url;
      server = http.createServer(onRequest);
      // A Stop hook waits for a forge to land; the socket must outlive that wait.
      server.requestTimeout = 60000;
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
      });
      url = `http://127.0.0.1:${server.address().port}/h/${token}`;
      writeUrl();
      timer = setInterval(() => { if (!current()) writeUrl(); }, reclaimMs);
      if (timer.unref) timer.unref();
      log.info('auto-forge: listening for Claude Code hooks');
      return url;
    },
    url: () => url,
    /** Whether this window is the one the hooks reach. */
    owns: () => Boolean(url) && current() === url,
    async dispose() {
      clearInterval(timer);
      timer = null;
      if (url && current() === url) { try { fs.unlinkSync(file); } catch { /* already gone */ } }
      const s = server;
      server = null;
      url = '';
      if (s) await new Promise((r) => { s.close(() => r()); if (s.closeAllConnections) s.closeAllConnections(); });
    },
  };
}

module.exports = { createAgent, urlFilePath };
