'use strict';
// What travels between two Prompt Forge windows sharing a library live, and how it is protected.
//
// There is no server in the middle: one window listens, the other connects to it directly, over the
// local network or a tailnet. So the channel protects itself. The invite carries a random secret;
// every request, response and pushed event is sealed with AES-256-GCM under a key derived from it.
// Nothing readable crosses the wire, a tampered message fails to open, and a request is refused
// unless it opens -- which only something holding the invite can make happen. The secret itself is
// never sent. Pure: node:crypto only.
const crypto = require('node:crypto');

const PREFIX = 'pflive1.';
const DEFAULT_PORT = 47830;

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => Buffer.from(String(s == null ? '' : s), 'base64url');

const newSecret = () => b64u(crypto.randomBytes(32));
const nonce = () => b64u(crypto.randomBytes(16));

/** The AES key for a secret. Domain-separated so the same secret could never key anything else. */
function keyOf(secret) {
  return crypto.createHash('sha256').update('prompt-forge live v1\u0000').update(String(secret)).digest();
}

/** A short, stable, non-reversible name for a share: where a joined library is kept on disk. */
const shareId = (secret) => crypto.createHash('sha256').update('prompt-forge live id\u0000').update(String(secret)).digest('hex').slice(0, 16);

function sealBytes(key, plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]);
}

/** The plaintext, or null for anything that was not sealed under this key or was changed on the way. */
function openBytes(key, box) {
  try {
    const b = Buffer.from(box);
    if (b.length < 28) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]);
  } catch {
    return null;
  }
}

/** A JSON header and optional raw bytes (a file), in one buffer: [4-byte length][header][bytes]. */
function frame(obj, bytes = null) {
  const head = Buffer.from(JSON.stringify(obj == null ? {} : obj), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length, 0);
  return Buffer.concat([len, head, bytes ? Buffer.from(bytes) : Buffer.alloc(0)]);
}

function unframe(buf) {
  if (!buf || buf.length < 4) return null;
  const n = buf.readUInt32BE(0);
  if (n > buf.length - 4) return null;
  try {
    const obj = JSON.parse(buf.subarray(4, 4 + n).toString('utf8'));
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? { obj, bytes: buf.subarray(4 + n) } : null;
  } catch {
    return null;
  }
}

const seal = (key, obj, bytes = null) => sealBytes(key, frame(obj, bytes));
const unseal = (key, box) => unframe(openBytes(key, box));

/**
 * A header value both sides derive from the key. A request without it is turned away before its
 * body is read, so a stranger cannot make the sharing window buffer large uploads. It proves nothing
 * on its own: the body still has to open.
 */
const authTag = (key) => crypto.createHmac('sha256', key).update('prompt-forge live auth').digest('base64url').slice(0, 32);

function sameTag(a, b) {
  const x = Buffer.from(String(a == null ? '' : a));
  const y = Buffer.from(String(b == null ? '' : b));
  return x.length > 0 && x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ------------------------------------------------------------------------------------------------
// The invite
// ------------------------------------------------------------------------------------------------

const HOSTISH = /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/;
const clip = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f]/g, '').slice(0, max);

/** One line of text: everything a window needs to find the sharer and prove it was invited. */
function encodeInvite({ addrs, port, secret, host, machine, account }) {
  const body = { a: (addrs || []).slice(0, 8), p: port, k: secret, h: clip(host, 80), m: clip(machine, 80), u: clip(account, 200) };
  return PREFIX + b64u(Buffer.from(JSON.stringify(body), 'utf8'));
}

/**
 * The invite in `text`, which may be the bare code, a link with it in the query, or a whole message
 * someone pasted. null for anything that is not a well-formed invite.
 */
function decodeInvite(text) {
  const m = /pflive1\.[A-Za-z0-9_-]{20,4000}/.exec(String(text == null ? '' : text));
  if (!m) return null;
  let o;
  try { o = JSON.parse(unb64u(m[0].slice(PREFIX.length)).toString('utf8')); } catch { return null; }
  if (!o || typeof o !== 'object') return null;
  const addrs = (Array.isArray(o.a) ? o.a : []).map(String).filter((a) => HOSTISH.test(a)).slice(0, 8);
  const port = Number(o.p);
  if (!addrs.length || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof o.k !== 'string' || !/^[A-Za-z0-9_-]{40,100}$/.test(o.k)) return null;
  return { code: m[0], addrs, port, secret: o.k, host: clip(o.h, 80) || 'someone', machine: clip(o.m, 80), account: clip(o.u, 200) };
}

/** Two account names are the same account: trimmed, case-insensitive, and neither empty. */
function sameAccount(a, b) {
  const x = String(a == null ? '' : a).trim().toLowerCase();
  const y = String(b == null ? '' : b).trim().toLowerCase();
  return Boolean(x) && x === y;
}

/**
 * Addresses another machine could reach this one on, most likely first: the local network, then a
 * tailnet (100.64.0.0/10), then anything else. IPv4 only; loopback and link-local never.
 */
function lanAddresses(ifaces) {
  const rank = (ip) => {
    if (/^(192\.168\.|10\.)/.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return 0;
    const m = /^100\.(\d+)\./.exec(ip);
    if (m && Number(m[1]) >= 64 && Number(m[1]) <= 127) return 1;
    return 2;
  };
  const out = [];
  for (const list of Object.values(ifaces || {})) {
    for (const a of list || []) {
      if (!a || a.internal || (a.family !== 'IPv4' && a.family !== 4)) continue;
      if (/^(127\.|169\.254\.)/.test(a.address) || out.includes(a.address)) continue;
      out.push(a.address);
    }
  }
  return out.sort((x, y) => rank(x) - rank(y)).slice(0, 6);
}

/**
 * Refuses a request seen before, or stamped too far from now. The channel is sealed, but a sealed
 * request captured on the network could otherwise be sent again -- the same idea merged twice.
 * Returns null when fine, 'clock' or 'replay' when not.
 */
function createReplayGuard({ windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const seen = new Map();
  return (ts, n) => {
    const t = now();
    for (const [k, exp] of seen) if (exp < t) seen.delete(k);
    if (!Number.isFinite(ts) || Math.abs(t - ts) > windowMs) return 'clock';
    if (typeof n !== 'string' || n.length < 16 || seen.has(n)) return 'replay';
    seen.set(n, t + windowMs * 2);
    return null;
  };
}

module.exports = {
  PREFIX, DEFAULT_PORT, b64u, unb64u, newSecret, nonce, keyOf, shareId,
  sealBytes, openBytes, frame, unframe, seal, unseal, authTag, sameTag,
  encodeInvite, decodeInvite, sameAccount, lanAddresses, createReplayGuard,
};
