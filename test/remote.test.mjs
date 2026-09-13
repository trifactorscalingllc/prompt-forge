import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const remote = require('../src/remote.js');

test('ssh config hosts: concrete names only, with HostName and User', () => {
  const fs = { readFileSync: () => 'Host mini mac-mini\n  HostName 192.168.1.20\n  User tfs\n\nHost *.corp\n  User x\nHost -oProxyCommand=evil\n' };
  const hosts = remote.sshHosts({ home: '/h', fs });
  assert.deepEqual(hosts.map((h) => h.host), ['mini', 'mac-mini']);
  assert.equal(hosts[0].hostName, '192.168.1.20');
  assert.equal(hosts[0].user, 'tfs');
  assert.equal(remote.validHost('-oProxyCommand=x'), false, 'a host cannot smuggle an ssh option');
  assert.equal(remote.validHost('a b'), false);
  assert.equal(remote.validHost('tfs@mini.local'), true);
});

test('the far folder is quoted for its own shell, and ~ is expanded there, not here', () => {
  assert.equal(remote.remoteCd('~/code/it\'s'), 'cd "$HOME"/\'code/it\'\\\'\'s\'');
  assert.equal(remote.remoteCd('/opt/app'), "cd '/opt/app'");
  assert.equal(remote.remoteCd('~'), 'cd "$HOME"');
});

test('the deny-list runs on the listing, before any file is read', () => {
  const listing = remote.parseListing([
    '__HEAD__ 3f2a9c1d0000',
    'F ./README.md', 'F ./.env', 'F ./package.json', 'D ./docs', 'F ./docs/arch.md', 'F ./credentials.json',
    'F ./CLAUDE.md', 'D ./src', 'F ./src/index.ts',
  ].join('\n'));
  assert.equal(listing.head, '3f2a9c1d0000');
  const chosen = remote.choose(listing);
  assert.deepEqual(chosen, ['README.md', 'docs/arch.md', 'package.json', 'CLAUDE.md']);
  const script = remote.readScript('~/app', chosen);
  assert.ok(!script.includes('.env') && !script.includes('credentials'), 'the read script never names a denied file');
});

test('collectRemote: two ssh round trips in batch mode, binary files skipped, the brief shape of a local collect', async () => {
  const calls = [];
  const runCli = async (req) => {
    calls.push(req);
    if (calls.length === 1) return { ok: true, stdout: 'F ./README.md\nF ./package.json\nF ./logo.png\nD ./src\nF ./src/a.ts\n__HEAD__ ref: refs/heads/main\n', stderr: '' };
    return { ok: true, stdout: `\n__FORGE_FILE__ README.md\n# App\nIt does things.\n__FORGE_FILE__ package.json\n{"name":"app"}\n__FORGE_FILE__ bin.dat\nab\u0000cd`, stderr: '' };
  };
  const r = await remote.collectRemote({ runCli, ssh: 'ssh', host: 'mini', dir: '~/app' });
  assert.deepEqual(r.files, ['README.md', 'package.json']);
  assert.ok(r.text.includes('--- README.md ---\n# App'));
  assert.ok(r.tree.includes('src/') && r.tree.includes('src/a.ts'));
  assert.equal(r.head, null, 'a symbolic ref is not a commit');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args.slice(0, 6), ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new']);
  assert.equal(calls[0].args[6], 'mini');
  assert.equal(calls[0].args[7], 'sh -s', 'the script goes on stdin, so nothing is quoted twice');
});

test('collectRemote: a missing folder and a refused key are plain sentences', async () => {
  const missing = await remote.collectRemote({ runCli: async () => ({ ok: false, stdout: '__NO_DIR__\n', stderr: '' }), ssh: 'ssh', host: 'mini', dir: '~/nope' });
  assert.match(missing.error, /does not exist on mini/);
  const denied = await remote.collectRemote({ runCli: async () => ({ ok: false, stdout: '', stderr: 'tfs@mini: Permission denied (publickey).' }), ssh: 'ssh', host: 'mini', dir: '~/app' });
  assert.match(denied.error, /needs a key or a running agent/);
});
