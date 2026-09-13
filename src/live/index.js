'use strict';
// A live library: this window shares its prompt library with someone signed in to the same account,
// or joins the library someone else is sharing. One of the two is the sharer, and its window is where
// merges run; everyone else sees every prompt, every idea, every edit and the engine at work as it
// happens, and can add to any of it.
//
// There is no service in the middle. The sharer's window listens; the invite says where and carries
// the key the channel is sealed with. Which account a window is signed in to decides whether it may
// join: the invite names the account, the joining window checks it before it connects, and the
// sharer checks it again on every request.
const nodeCrypto = require('node:crypto');
const nodeFs = require('node:fs');
const nodeHttp = require('node:http');
const nodeOs = require('node:os');
const nodePath = require('node:path');
const W = require('./wire');
const { createLiveHost } = require('./host');
const { createLiveGuest } = require('./guest');

const HOST_ON = 'promptForge.live.sharing';
const HOST_SECRET = 'promptForge.live.hostSecret';
const GUEST_INVITE = 'promptForge.live.invite';
const EXTENSION_ID = 'trifactorscaling.prompt-forge-trifactor';
const noop = () => {};

function whoAmI(os) {
  let name = '';
  try { name = os.userInfo().username; } catch { name = ''; }
  return { name: name || 'someone', machine: String(os.hostname() || '').replace(/\.local$/i, '') };
}

function createLive({
  log = { info: noop, warn: noop, error: noop, debug: noop }, secrets, globalState, accountOf, onCommand, onEvent = noop,
  writeDoc = null, fs = nodeFs, http = nodeHttp, os = nodeOs, homeDir = null, port = W.DEFAULT_PORT, bindHost = '0.0.0.0',
  extraAddrs = [], identity = null,
}) {
  const me = { id: nodeCrypto.randomBytes(12).toString('base64url'), ...(identity || whoAmI(os)) };
  const home = homeDir || os.homedir();
  let host = null;
  let guest = null;
  let share = null;     // { secret, account, port, addrs, dir, code }
  let joined = null;    // { host, machine, account, mirror, code }
  let status = 'off';
  let error = null;
  let people = [];
  const remoteEngines = new Map();

  const emit = (e) => { try { onEvent(e); } catch (err) { log.warn(`live: ${err.stack || err.message}`); } };
  const role = () => (host ? 'host' : guest ? 'guest' : 'off');

  async function startSharing({ dir, resume = false } = {}) {
    if (host) return { ok: true, code: share.code };
    if (guest) return { ok: false, error: `Leave ${joined.host}’s library before sharing your own.` };
    const account = accountOf();
    if (!account) return { ok: false, error: 'Sign in to Claude first. Sharing admits people signed in to the same account, so it needs to know which account this window uses.' };
    let saved = null;
    if (resume) { try { saved = JSON.parse((await secrets.get(HOST_SECRET)) || 'null'); } catch { saved = null; } }
    const secret = saved && typeof saved.secret === 'string' ? saved.secret : W.newSecret();
    const h = createLiveHost({
      dir, secret, account, me, port: (saved && saved.port) || port, bindHost, log, fs, http, onCommand,
      retryPortMs: saved && saved.port ? 4000 : 0,
      onPresence: (list) => { people = list; emit({ type: 'presence' }); },
    });
    let bound;
    try { bound = await h.start(); } catch (e) {
      h.stop();
      return { ok: false, error: `Could not start sharing: ${e.message}` };
    }
    host = h;
    status = 'live';
    error = null;
    people = h.people();
    const addrs = [...extraAddrs, ...W.lanAddresses(os.networkInterfaces())];
    const hn = String(os.hostname() || '');
    if (/^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(hn) && !addrs.includes(hn)) addrs.push(hn);
    share = { secret, account, port: bound.port, addrs, dir, code: W.encodeInvite({ addrs, port: bound.port, secret, host: me.name, machine: me.machine, account }) };
    try {
      await secrets.store(HOST_SECRET, JSON.stringify({ secret, port: bound.port }));
      await globalState.update(HOST_ON, true);
    } catch (e) { log.warn(`live: could not remember the share: ${e.message}`); }
    emit({ type: 'status' });
    return { ok: true, code: share.code };
  }

  async function stopSharing() {
    if (!host) return;
    host.stop();
    host = null;
    share = null;
    people = [];
    status = 'off';
    try {
      await secrets.delete(HOST_SECRET);
      await globalState.update(HOST_ON, false);
    } catch (e) { log.warn(`live: could not forget the share: ${e.message}`); }
    emit({ type: 'status' });
  }

  function guestEvent(e) {
    switch (e.type) {
      case 'hello':
        if (Array.isArray(e.people)) people = e.people;
        if (e.engines && typeof e.engines === 'object') {
          remoteEngines.clear();
          for (const [slug, eng] of Object.entries(e.engines)) remoteEngines.set(slug, eng);
        }
        emit({ type: 'presence' });
        return;
      case 'presence':
        people = Array.isArray(e.people) ? e.people : [];
        emit({ type: 'presence' });
        return;
      case 'engine':
        if (e.slug && e.engine) { remoteEngines.set(e.slug, e.engine); emit({ type: 'engine', slug: e.slug, engine: e.engine }); }
        return;
      case 'files':
      case 'synced':
        emit(e);
        return;
      case 'refused': {
        const msg = e.error;
        leave().then(() => emit({ type: 'refused', error: msg }));
        return;
      }
      default:
    }
  }

  async function join(text) {
    const inv = W.decodeInvite(text);
    if (!inv) return { ok: false, error: 'That is not a Prompt Forge invite. Paste the whole link or message the person sharing sent you.' };
    if (host) return { ok: false, error: 'Stop sharing your own library before joining someone else’s.' };
    const account = accountOf();
    if (!account) return { ok: false, error: `Sign in to Claude as ${inv.account} first. ${inv.host}’s library is shared with people signed in to that account.` };
    if (!W.sameAccount(account, inv.account)) {
      return { ok: false, error: `${inv.host}’s library is shared for ${inv.account}, and this window is signed in as ${account}. Sign in to Claude as ${inv.account} to join it.` };
    }
    if (guest) { guest.leave(); guest = null; }
    const mirror = nodePath.join(home, '.prompt-forge', 'live', W.shareId(inv.secret));
    fs.mkdirSync(mirror, { recursive: true });
    joined = { host: inv.host, machine: inv.machine, account: inv.account, mirror, code: inv.code };
    remoteEngines.clear();
    people = [];
    status = 'connecting';
    error = null;
    guest = createLiveGuest({
      invite: inv, mirrorDir: mirror, me: { ...me, account }, log, fs, http, writeHook: writeDoc,
      onEvent: guestEvent,
      onStatus: (s, err) => { status = s; error = err || null; emit({ type: 'status' }); },
    });
    try { await secrets.store(GUEST_INVITE, inv.code); } catch (e) { log.warn(`live: could not remember the invite: ${e.message}`); }
    // The copy from last time shows at once; what changed since arrives as soon as the connection is up.
    emit({ type: 'library', dir: mirror });
    guest.start();
    return { ok: true, host: inv.host };
  }

  async function leave() {
    if (!guest) return;
    const mirror = joined && joined.mirror;
    guest.leave();
    guest = null;
    joined = null;
    people = [];
    remoteEngines.clear();
    status = 'off';
    error = null;
    try { await secrets.delete(GUEST_INVITE); } catch { /* nothing stored */ }
    emit({ type: 'library', dir: null });
    // The copy was only ever a view of someone else's library. Leaving means it goes.
    if (mirror && nodePath.dirname(mirror) === nodePath.join(home, '.prompt-forge', 'live')) {
      try { fs.rmSync(mirror, { recursive: true, force: true }); } catch (e) { log.warn(`live: could not remove ${mirror}: ${e.message}`); }
    }
  }

  /** Pick up where the last window left off: sharing again, or back in the library it had joined. */
  async function resume({ dir }) {
    let sharing = false;
    try { sharing = Boolean(globalState.get(HOST_ON)); } catch { sharing = false; }
    if (sharing) {
      const r = await startSharing({ dir, resume: true });
      if (!r.ok) emit({ type: 'notice', level: 'warn', text: `Live sharing did not restart: ${r.error}` });
      return;
    }
    let code = null;
    try { code = await secrets.get(GUEST_INVITE); } catch { code = null; }
    if (!code) return;
    const r = await join(code);
    if (!r.ok) emit({ type: 'notice', level: 'warn', text: `Could not rejoin the live library: ${r.error}` });
  }

  function state() {
    const r = role();
    const mine = r === 'host' ? 'host' : me.id;
    return {
      role: r,
      status: r === 'off' ? 'off' : status,
      error,
      me: { name: me.name, machine: me.machine },
      people: people.map((p) => ({ name: p.name, machine: p.machine, slug: p.slug || null, role: p.role, me: p.id === mine })),
      host: r === 'guest' ? { name: joined.host, machine: joined.machine, account: joined.account }
        : r === 'host' ? { name: me.name, machine: me.machine, account: share.account } : null,
      invite: r === 'host' ? { addrs: share.addrs, port: share.port } : null,
    };
  }

  /** The message to send someone: the account to sign in to, and a link that joins in one click. */
  function inviteText(uriScheme = 'vscode') {
    if (!share) return '';
    return `Join my Prompt Forge library live. Sign in to Claude as ${share.account}, then open this link (or paste this whole message into Prompt Forge: the people button, then Join):\n${uriScheme}://${EXTENSION_ID}/join?code=${share.code}\n`;
  }

  return {
    role,
    isHost: () => Boolean(host),
    isGuest: () => Boolean(guest),
    me: () => ({ name: me.name, machine: me.machine }),
    state, startSharing, stopSharing, join, leave, resume, inviteText,
    command: (cmd, args = {}, bytes = null) => (guest ? guest.command(cmd, args, bytes) : Promise.reject(new Error('not in a live library'))),
    view(slug) { if (host) host.setView(slug); else if (guest) guest.view(slug); },
    engine(slug, eng) { if (host) host.setEngine(slug, eng); },
    engineFor: (slug) => (guest ? remoteEngines.get(slug) || null : null),
    hostName: () => (joined ? joined.host : me.name),
    mirrorDir: () => (joined ? joined.mirror : null),
    code: () => (share ? share.code : null),
    rescan: () => (host ? host.rescan() : null),
    idle: () => (guest ? guest.idle() : Promise.resolve()),
    dispose() {
      if (host) host.stop();
      if (guest) guest.leave();
      host = null;
      guest = null;
    },
  };
}

module.exports = { createLive, EXTENSION_ID, HOST_ON, HOST_SECRET, GUEST_INVITE };
