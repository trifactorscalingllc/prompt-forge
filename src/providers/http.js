'use strict';
// One JSON request with a timeout, returning a result object either way. Providers build on this so
// a network failure, a 401 and a hung socket all come back as the same shape with a readable line.

async function jsonRequest(fetchImpl, url, { method = 'GET', headers = {}, body, timeoutMs = 60000 } = {}) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const init = { method, headers: { ...headers }, signal: ctl.signal };
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!init.headers['content-type']) init.headers['content-type'] = 'application/json';
  }
  try {
    const r = await fetchImpl(url, init);
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    if (!(r.status >= 200 && r.status < 300)) {
      let msg = json && ((json.error && (json.error.message || json.error)) || json.message);
      if (msg && typeof msg !== 'string') msg = JSON.stringify(msg);
      if (!msg) msg = text.replace(/\s+/g, ' ').trim().slice(0, 200);
      return { ok: false, status: r.status, json, text, error: `HTTP ${r.status}: ${msg}` };
    }
    return { ok: true, status: r.status, json, text, error: null };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    return { ok: false, status: 0, json: null, text: '', error: timedOut ? `timed out after ${timeoutMs}ms` : (e && e.message) || String(e) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { jsonRequest };
