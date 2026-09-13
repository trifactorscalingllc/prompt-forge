// A live library: the sealed channel, what may travel, two edits at once, and a sharing window and a
// joined window talking over a real socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const W = require('../src/live/wire.js');
const F = require('../src/live/files.js');
const { mergeDocs } = require('../src/live/mergedoc.js');
const { createLiveHost } = require('../src/live/host.js');
const { createLiveGuest } = require('../src/live/guest.js');
const { createLive } = require('../src/live/index.js');
const { createHostCommands } = require('../src/live/commands.js');
const storeMod = require('../src/store.js');
const { createSession } = require('../src/session.js');

const silent = { info() {}, warn() {}, error() {}, debug() {} };
const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  throw new Error('timed out waiting');
}
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

// ---- the channel ---------------------------------------------------------------------------------

test('a sealed message opens only under its own key, not at all once changed, and carries nothing readable', () => {
  const k = W.keyOf(W.newSecret());
  const box = W.seal(k, { idea: 'book discovery calls' }, Buffer.from('attached bytes'));
  const got = W.unseal(k, box);
  assert.deepEqual(got.obj, { idea: 'book discovery calls' });
  assert.equal(got.bytes.toString(), 'attached bytes');
  assert.equal(W.unseal(W.keyOf(W.newSecret()), box), null, 'another invite cannot open it');
  const bad = Buffer.from(box);
  bad[bad.length - 1] ^= 1;
  assert.equal(W.unseal(k, bad), null, 'a changed byte and it does not open');
  assert.equal(W.unseal(k, Buffer.alloc(3)), null);
  assert.ok(!box.includes(Buffer.from('discovery')) && !box.includes(Buffer.from('attached')), 'nothing readable on the wire');
});

test('an invite survives being pasted as a code, a link or a whole message; junk is not an invite', () => {
  const secret = W.newSecret();
  const code = W.encodeInvite({ addrs: ['192.168.1.20', 'mac-mini'], port: 47830, secret, host: 'alex', machine: 'MINI', account: 'first-last+team@example.com' });
  for (const text of [code, `vscode://trifactorscaling.prompt-forge-trifactor/join?code=${code}`, `Join me:\n${code}\nthanks`]) {
    const inv = W.decodeInvite(text);
    assert.equal(inv.secret, secret);
    assert.deepEqual(inv.addrs, ['192.168.1.20', 'mac-mini']);
    assert.equal(inv.port, 47830);
    assert.equal(inv.account, 'first-last+team@example.com', 'punctuation in an account survives');
    assert.equal(inv.host, 'alex');
  }
  const forge = (o) => `pflive1.${Buffer.from(JSON.stringify(o)).toString('base64url')}`;
  assert.equal(W.decodeInvite('hello'), null);
  assert.equal(W.decodeInvite(forge({ a: ['10.0.0.2'], p: 0, k: secret })), null, 'no port');
  assert.equal(W.decodeInvite(forge({ a: ['a b', '../x'], p: 1, k: secret })), null, 'no usable address');
  assert.equal(W.decodeInvite(forge({ a: ['10.0.0.2'], p: 1, k: 'short' })), null, 'no real secret');
  assert.ok(W.sameAccount(' team@example.com', 'TEAM@example.com '));
  assert.ok(!W.sameAccount('', ''), 'two windows signed in to nothing are not the same account');
  assert.ok(!W.sameAccount('a@example.com', 'b@example.com'));
  assert.notEqual(W.shareId(secret), W.shareId(W.newSecret()));
});

test('addresses: the local network first, then a tailnet, never loopback; a replayed or stale request is refused', () => {
  const ifaces = {
    lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    ts: [{ address: '100.101.1.2', family: 'IPv4', internal: false }],
    wifi: [{ address: '192.168.1.5', family: 'IPv4', internal: false }, { address: 'fe80::1', family: 'IPv6', internal: false }],
    ll: [{ address: '169.254.3.3', family: 'IPv4', internal: false }],
  };
  assert.deepEqual(W.lanAddresses(ifaces), ['192.168.1.5', '100.101.1.2']);
  const t = 1_000_000_000;
  const guard = W.createReplayGuard({ now: () => t });
  const n = W.nonce();
  assert.equal(guard(t, n), null);
  assert.equal(guard(t, n), 'replay');
  assert.equal(guard(t - 11 * 60 * 1000, W.nonce()), 'clock');
});

test('only prompt files travel: never .git, the trash, a temp file, or a path that climbs out', () => {
  for (const ok of ['a.md', 'a.forge.json', 'a.images/img1.png', 'a.files/f1-notes.md']) assert.ok(F.isLibraryFile(ok), ok);
  for (const bad of ['.git/config', '.trash/a.md', 'a.forge.json.tmp', '../a.md', 'a.images/../../x.md', '/etc/passwd', 'a.images/sub/x.png', 'C:\\x.md', 'notes.txt', '.live-versions.json']) {
    assert.ok(!F.isLibraryFile(bad), bad);
  }
  const dir = tmp('forge-files-');
  assert.equal(F.absOf(dir, '../x.md'), null);
  fs.writeFileSync(path.join(dir, 'p.md'), '# P\n');
  fs.mkdirSync(path.join(dir, '.git'));
  fs.writeFileSync(path.join(dir, '.git', 'HEAD'), 'x');
  fs.mkdirSync(path.join(dir, 'p.images'));
  fs.writeFileSync(path.join(dir, 'p.images', 'i.png'), 'png');
  const m = F.scan(dir, fs);
  assert.deepEqual([...m.keys()].sort(), ['p.images/i.png', 'p.md']);
  assert.equal(F.slugOfRel('p.images/i.png'), 'p');
  const next = new Map(m);
  next.delete('p.md');
  next.set('q.md', { size: 1, mtimeMs: 1 });
  assert.deepEqual(F.diffManifest(m, next), { changed: ['q.md'], removed: ['p.md'] });
});

test('two edits at once: a section one side touched takes that side; a section both changed takes the incoming edit and says so', () => {
  const base = '# T\n\n## Goal\n\nShip.\n\n## Context\n\nC.\n';
  const ours = '# T\n\n## Goal\n\nShip by Friday.\n\n## Context\n\nC.\n';
  const theirs = '# T\n\n## Goal\n\nShip.\n\n## Context\n\nC, for plumbers.\n';
  assert.deepEqual(mergeDocs(base, ours, theirs), { doc: '# T\n\n## Goal\n\nShip by Friday.\n\n## Context\n\nC, for plumbers.\n', clean: true });
  const both = mergeDocs(base, ours, '# T\n\n## Goal\n\nShip Monday.\n\n## Context\n\nC.\n');
  assert.equal(both.clean, false);
  assert.equal(both.doc, '# T\n\n## Goal\n\nShip Monday.\n\n## Context\n\nC.\n');
  const added = mergeDocs(base, `${base}\n## Constraints\n\nNo ads.\n`, '# T\n\n## Goal\n\nShip.\n');
  assert.equal(added.doc, '# T\n\n## Goal\n\nShip.\n\n## Constraints\n\nNo ads.\n', 'added here is kept; removed there and untouched here is gone');
  assert.deepEqual(mergeDocs(base, base, theirs), { doc: theirs, clean: true });
  assert.deepEqual(mergeDocs(base, ours, base), { doc: ours, clean: true });
  const xml = mergeDocs('<goal>\n\nA\n\n</goal>\n', '<goal>\n\nA\n\n</goal>\n\n<context>\n\nB\n\n</context>\n', '<goal>\n\nA2\n\n</goal>\n');
  assert.equal(xml.doc, '<goal>\n\nA2\n\n</goal>\n\n<context>\n\nB\n\n</context>\n', 'tagged sections join the same way');
});

// ---- a sharing window and a joined window, over a real socket -----------------------------------

async function pair({ account = 'team@example.com', guestAccount = account, onCommand = async () => null } = {}) {
  const lib = tmp('forge-live-lib-');
  const mirror = tmp('forge-live-mirror-');
  const s = storeMod.open(lib);
  const { slug } = s.create('Cold emails');
  const secret = W.newSecret();
  const host = createLiveHost({ dir: lib, secret, account, me: { name: 'alex', machine: 'MINI' }, port: 0, bindHost: '127.0.0.1', log: silent, onCommand, scanMs: 200 });
  const { port } = await host.start();
  const invite = W.decodeInvite(W.encodeInvite({ addrs: ['127.0.0.1'], port, secret, host: 'alex', machine: 'MINI', account }));
  const events = [];
  const statuses = [];
  const guest = createLiveGuest({
    invite, mirrorDir: mirror, me: { id: 'guest-id-123', name: 'sam', machine: 'LAPTOP', account: guestAccount }, log: silent,
    onEvent: (e) => events.push(e), onStatus: (st, err) => statuses.push([st, err]),
  });
  return { lib, mirror, s, slug, host, guest, events, statuses, port, secret, done: () => { guest.leave(); host.stop(); } };
}

function rawPost(port, route, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', agent: false, headers: { 'content-length': body.length, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('a joined window gets the whole library, then each change as it happens: a new prompt, an idea, a deletion', async () => {
  const p = await pair();
  try {
    p.guest.start();
    await until(() => p.statuses.some(([st]) => st === 'live'));
    await p.guest.idle();
    assert.equal(fs.readFileSync(path.join(p.mirror, `${p.slug}.md`), 'utf8'), fs.readFileSync(path.join(p.lib, `${p.slug}.md`), 'utf8'));
    assert.ok(readJson(path.join(p.mirror, `${p.slug}.forge.json`)));

    const t0 = Date.now();
    const { slug: second } = p.s.create('Landing page');
    await until(() => fs.existsSync(path.join(p.mirror, `${second}.forge.json`)) && fs.existsSync(path.join(p.mirror, `${second}.md`)));
    assert.ok(Date.now() - t0 < 2000, `a new prompt showed up in ${Date.now() - t0} ms`);

    p.s.appendEntry(p.slug, 'add a breakup email');
    await until(() => (readJson(path.join(p.mirror, `${p.slug}.forge.json`)) || { entries: [] }).entries.length === 1);

    p.s.remove(second);
    await until(() => !fs.existsSync(path.join(p.mirror, `${second}.md`)) && !fs.existsSync(path.join(p.mirror, `${second}.forge.json`)));
    assert.ok(!fs.existsSync(path.join(p.mirror, '.trash')), 'the trash does not travel');
    await until(() => p.host.people().length === 2);
    assert.deepEqual(p.host.people().map((x) => x.name), ['alex', 'sam']);
    assert.ok(p.events.some((e) => e.type === 'files'));
  } finally { p.done(); }
});

test('a request runs in the sharing window with its file; a wrong path, a plain request, another account and another invite are turned away', async () => {
  const seen = [];
  const p = await pair({
    onCommand: async (who, cmd, args, bytes) => {
      seen.push({ who, cmd, args, bytes: bytes && bytes.toString() });
      if (cmd === 'boom') throw new Error('No engine yet.');
      return { entryId: 'e1' };
    },
  });
  try {
    p.guest.start();
    await until(() => p.statuses.some(([st]) => st === 'live'));
    assert.deepEqual(await p.guest.command('idea', { slug: p.slug, text: 'hi' }, Buffer.from('file bytes')), { entryId: 'e1' });
    assert.deepEqual(seen[0], { who: { id: 'guest-id-123', name: 'sam', machine: 'LAPTOP' }, cmd: 'idea', args: { slug: p.slug, text: 'hi' }, bytes: 'file bytes' });
    await assert.rejects(p.guest.command('boom'), /No engine yet/);

    const key = W.keyOf(p.secret);
    const stamp = () => ({ ts: Date.now(), nonce: W.nonce(), id: 'guest-id-123', name: 'sam', machine: 'LAPTOP', account: 'team@example.com' });
    const auth = { 'x-pf-auth': W.authTag(key) };
    const climb = await rawPost(p.port, '/pf/file', W.seal(key, { ...stamp(), path: '../../etc/passwd' }), auth);
    assert.equal(climb.status, 400);
    assert.equal(W.unseal(key, climb.body).obj.ok, false);
    const plain = await rawPost(p.port, '/pf/cmd', Buffer.from(JSON.stringify({ cmd: 'idea', args: { slug: p.slug, text: 'x' } })));
    assert.equal(plain.status, 401);
    assert.equal(plain.body.length, 0, 'a caller without the invite is told nothing');
    const noHeader = await rawPost(p.port, '/pf/cmd', W.seal(key, { ...stamp(), cmd: 'idea', args: { slug: p.slug, text: 'x' } }));
    assert.equal(noHeader.status, 401, 'refused before the body is read');
    const replay = W.seal(key, { ...stamp(), cmd: 'idea', args: { slug: p.slug, text: 'twice' } });
    await rawPost(p.port, '/pf/cmd', replay, auth);
    const again = await rawPost(p.port, '/pf/cmd', replay, auth);
    assert.equal(again.status, 403, 'the same sealed request sent twice is refused the second time');
    assert.equal(seen.filter((x) => x.args.text === 'twice').length, 1);
  } finally { p.done(); }

  const other = await pair({ guestAccount: 'someone@else.com' });
  try {
    other.guest.start();
    const refused = await until(() => other.events.find((e) => e.type === 'refused'));
    assert.match(refused.error, /team@example\.com/);
  } finally { other.done(); }

  const wrong = await pair();
  try {
    const events = [];
    const stranger = createLiveGuest({
      invite: W.decodeInvite(W.encodeInvite({ addrs: ['127.0.0.1'], port: wrong.port, secret: W.newSecret(), host: 'alex', account: 'team@example.com' })),
      mirrorDir: tmp('forge-live-stranger-'), me: { id: 'stranger-0001', name: 'x', machine: 'y', account: 'team@example.com' }, log: silent,
      onEvent: (e) => events.push(e),
    });
    stranger.start();
    const refused = await until(() => events.find((e) => e.type === 'refused'));
    assert.match(refused.error, /not accepted/);
    stranger.leave();
  } finally { wrong.done(); }
});

// ---- the commands a joined window may send ---------------------------------------------------------

function hostSide({ body, engineOk = true } = {}) {
  const lib = tmp('forge-cmd-');
  const s = storeMod.open(lib);
  const { slug } = s.create('T', body ? { body } : {});
  const docio = {
    readDoc: async (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } },
    writeDoc: async (p, t) => { fs.writeFileSync(p, t); },
    isOpen: () => false,
  };
  const engine = {
    call: async (req) => {
      const doc = /<document>\n([\s\S]*?)<\/document>/.exec(req.prompt)[1];
      return { text: JSON.stringify({ doc: `${doc.replace(/\n+$/, '')}\n\n## Goal\n\nBook calls.\n`, conflicts: [], changes: ['goal'] }), usage: null, error: null, call: { provider: 'fake', mode: 'cli', model: 'fast', role: req.role, ms: 1 } };
    },
  };
  const sessions = new Map();
  const ensureSession = async (sl) => {
    if (!sessions.has(sl)) {
      const x = createSession({ slug: sl, store: s, docio, engine, cfg: () => ({ engine: { mergeOutput: 'document' } }), log: silent, settleMs: 0 });
      sessions.set(sl, x);
      await x.load();
    }
    return sessions.get(sl);
  };
  const commands = createHostCommands({
    getStore: () => s, ensureSession, removePrompt: async (sl) => { s.remove(sl); }, docio,
    engineSelection: () => (engineOk ? { ok: true } : { ok: false, reason: 'No engine yet.' }),
  });
  return { lib, s, slug, docio, ensureSession, commands };
}

test('host commands: a hand edit against an older copy is joined rather than written over, and nothing outside the prompt is reachable', async () => {
  const start = '# T\n\n## Goal\n\nShip.\n\n## Context\n\nC.\n';
  const h = hostSide({ body: start, engineOk: false });
  const who = { id: 'g', name: 'sam', machine: 'LAPTOP' };
  fs.writeFileSync(h.s.docPath(h.slug), '# T\n\n## Goal\n\nShip by Friday.\n\n## Context\n\nC.\n');
  const r = await h.commands.run(who, 'docEdit', { slug: h.slug, base: start, text: '# T\n\n## Goal\n\nShip.\n\n## Context\n\nC, for plumbers.\n' });
  assert.equal(r.clean, true);
  assert.equal(fs.readFileSync(h.s.docPath(h.slug), 'utf8'), '# T\n\n## Goal\n\nShip by Friday.\n\n## Context\n\nC, for plumbers.\n');

  const r2 = await h.commands.run(who, 'docEdit', { slug: h.slug, base: start, text: '# T\n\n## Goal\n\nShip Monday.\n\n## Context\n\nC, for plumbers.\n' });
  assert.equal(r2.clean, false);
  assert.ok(fs.readFileSync(h.s.docPath(h.slug), 'utf8').includes('Ship Monday.'));
  assert.ok(h.s.read(h.slug).snapshots.some((v) => v.kind === 'hand-edit' && String(v.doc).includes('Ship by Friday.')), 'the text it replaced is kept as a version');

  await assert.rejects(h.commands.run(who, 'idea', { slug: h.slug, text: 'x' }), /No engine yet/, 'no engine in the sharing window is said plainly');
  await assert.rejects(h.commands.run(who, 'rename', { slug: '../evil', title: 'x' }), /not in the library/);
  await assert.rejects(h.commands.run(who, 'resolve', { slug: h.slug, conflictId: 'C1', keep: 'both' }), /Keep old or keep new/);
  await assert.rejects(h.commands.run(who, 'nope', {}), /does not know "nope"/);

  const rec = await h.commands.run(who, 'attach', { slug: h.slug, name: 'notes.md' }, Buffer.from('# notes'));
  assert.ok(rec.file && rec.dir === 'files' && !rec.path, 'no machine-local path goes back');
  assert.ok(fs.existsSync(h.s.attachmentPath(h.slug, rec)));

  const c = await h.commands.run(who, 'create', { title: '  Landing   page ' });
  assert.equal(h.s.read(c.slug).title, 'Landing page');
  await h.commands.run(who, 'delete', { slug: c.slug });
  assert.equal(h.s.exists(c.slug), false);
});

test('host commands: an idea from the joined window is merged here, signed with who wrote it, and a forged file record is dropped', async () => {
  const h = hostSide();
  const who = { id: 'g', name: 'sam', machine: 'LAPTOP' };
  const rec = await h.commands.run(who, 'attach', { slug: h.slug, name: 'shot.png', image: true, ext: 'png' }, Buffer.from('png bytes'));
  const out = await h.commands.run(who, 'idea', {
    slug: h.slug, text: 'cold emails that book calls',
    attachments: [rec, { file: '../../secrets.txt', dir: 'files', name: 'x' }, { file: 'never-saved.png', dir: 'images', name: 'y' }],
  });
  await (await h.ensureSession(h.slug)).idle();
  const sc = h.s.read(h.slug);
  const e = sc.entries.find((x) => x.id === out.entryId);
  assert.equal(e.status, 'merged');
  assert.deepEqual(e.by, { name: 'sam', machine: 'LAPTOP' });
  assert.deepEqual(e.attachments.map((a) => a.file), [rec.file], 'only the file this library saved');
  assert.ok(fs.readFileSync(h.s.docPath(h.slug), 'utf8').includes('Book calls.'));
});

// ---- the whole thing, as the runtime uses it ----------------------------------------------------

const memSecrets = () => { const m = new Map(); return { get: async (k) => m.get(k), store: async (k, v) => { m.set(k, v); }, delete: async (k) => { m.delete(k); }, m }; };
const memState = () => { const m = new Map(); return { get: (k) => m.get(k), update: async (k, v) => { m.set(k, v); }, m }; };

test('end to end: the joined window checks the account, sees the library, adds an idea and a prompt, and leaving removes its copy', async () => {
  const h = hostSide();
  const home = tmp('forge-live-home-');
  const hostSecrets = memSecrets();
  const hostState = memState();
  const hostLive = createLive({
    log: silent, secrets: hostSecrets, globalState: hostState, accountOf: () => 'team@example.com',
    onCommand: (who, cmd, args, bytes) => h.commands.run(who, cmd, args, bytes),
    port: 0, bindHost: '127.0.0.1', extraAddrs: ['127.0.0.1'], identity: { name: 'alex', machine: 'MINI' }, homeDir: home,
  });
  assert.equal((await createLive({ log: silent, secrets: memSecrets(), globalState: memState(), accountOf: () => null, port: 0 }).startSharing({ dir: h.lib })).ok, false, 'sharing needs to know the account');
  const shared = await hostLive.startSharing({ dir: h.lib });
  assert.ok(shared.ok, shared.error);
  assert.equal(hostState.m.get('promptForge.live.sharing'), true, 'sharing resumes after a reload');

  const wrongAccount = createLive({ log: silent, secrets: memSecrets(), globalState: memState(), accountOf: () => 'me@elsewhere.com', port: 0, homeDir: home });
  const refused = await wrongAccount.join(hostLive.inviteText('vscode'));
  assert.equal(refused.ok, false);
  assert.match(refused.error, /Sign in to Claude as team@example\.com/);

  const events = [];
  const guestSecrets = memSecrets();
  const guestLive = createLive({
    log: silent, secrets: guestSecrets, globalState: memState(), accountOf: () => 'TEAM@example.com', onEvent: (e) => events.push(e),
    port: 0, identity: { name: 'sam', machine: 'LAPTOP' }, homeDir: home,
  });
  try {
    assert.deepEqual(await guestLive.join(`hey, use this:\n${hostLive.inviteText('vscode')}`), { ok: true, host: 'alex' });
    const mirror = guestLive.mirrorDir();
    assert.deepEqual(events[0], { type: 'library', dir: mirror }, 'the window switches to the copy at once');
    await until(() => guestLive.state().status === 'live');
    await until(() => fs.existsSync(path.join(mirror, `${h.slug}.forge.json`)));

    const r = await guestLive.command('idea', { slug: h.slug, text: 'cold emails that book calls' });
    await until(() => { const sc = readJson(path.join(mirror, `${h.slug}.forge.json`)); return sc && sc.entries[0] && sc.entries[0].status === 'merged'; });
    const sc = readJson(path.join(mirror, `${h.slug}.forge.json`));
    assert.equal(sc.entries[0].id, r.entryId);
    assert.deepEqual(sc.entries[0].by, { name: 'sam', machine: 'LAPTOP' });
    await until(() => fs.readFileSync(path.join(mirror, `${h.slug}.md`), 'utf8').includes('Book calls.'));

    const created = await guestLive.command('create', { title: 'Landing page' });
    await until(() => fs.existsSync(path.join(mirror, `${created.slug}.forge.json`)));

    guestLive.view(h.slug);
    await until(() => hostLive.state().people.some((x) => x.name === 'sam' && x.slug === h.slug));
    assert.deepEqual(hostLive.state().people.map((x) => [x.name, x.me]), [['alex', true], ['sam', false]]);
    assert.equal(guestLive.state().host.name, 'alex');
    assert.ok(guestLive.state().people.some((x) => x.name === 'sam' && x.me));
    assert.ok(guestSecrets.m.has('promptForge.live.invite'), 'rejoins after a reload');

    await guestLive.leave();
    assert.ok(!fs.existsSync(mirror), 'leaving removes the copy');
    assert.ok(!guestSecrets.m.has('promptForge.live.invite'));
    assert.deepEqual(events[events.length - 1], { type: 'library', dir: null }, 'and the window goes back to its own library');
    await hostLive.stopSharing();
    assert.equal(hostState.m.get('promptForge.live.sharing'), false);
    assert.equal(hostLive.state().role, 'off');
  } finally {
    guestLive.dispose();
    hostLive.dispose();
  }
});
