import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { jsonRequest } = require('../src/providers/http.js');

const res = (status, body, headers = { 'content-type': 'application/json' }) => ({
  ok: status >= 200 && status < 300, status,
  headers: { get: (k) => headers[k.toLowerCase()] || null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});

test('jsonRequest: a 2xx JSON body is ok with the parsed json and the request is sent as given', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return res(200, { hello: 1 }); };
  const r = await jsonRequest(fetchImpl, 'https://x/y', { method: 'POST', headers: { 'x-k': 'v' }, body: { a: 1 }, timeoutMs: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { hello: 1 });
  assert.equal(calls[0].url, 'https://x/y');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['x-k'], 'v');
  assert.equal(calls[0].init.headers['content-type'], 'application/json');
  assert.equal(calls[0].init.body, '{"a":1}');
});

test('jsonRequest: a non-2xx carries the parsed error body and a readable error line', async () => {
  const r = await jsonRequest(async () => res(401, { error: { message: 'bad key' } }), 'https://x', {});
  assert.equal(r.ok, false);
  assert.equal(r.status, 401);
  assert.deepEqual(r.json, { error: { message: 'bad key' } });
  assert.match(r.error, /401/);
  assert.match(r.error, /bad key/);
});

test('jsonRequest: a thrown fetch is an error result, not a rejection', async () => {
  const r = await jsonRequest(async () => { throw new Error('ECONNREFUSED'); }, 'https://x', {});
  assert.equal(r.ok, false);
  assert.match(r.error, /ECONNREFUSED/);
});

test('jsonRequest: a hung fetch is aborted at the timeout', async () => {
  const fetchImpl = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  });
  const t0 = Date.now();
  const r = await jsonRequest(fetchImpl, 'https://x', { timeoutMs: 200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.ok(Date.now() - t0 < 2000);
});

test('jsonRequest: a non-JSON body is kept as text', async () => {
  const r = await jsonRequest(async () => res(502, '<html>gateway</html>', { 'content-type': 'text/html' }), 'https://x', {});
  assert.equal(r.ok, false);
  assert.equal(r.json, null);
  assert.match(r.text, /gateway/);
});
