import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runCli, engineEnv, spawnSpec, resolveBin } = require('../src/providers/spawn.js');
const node = process.execPath;

test('runCli pipes stdin to the child and returns stdout, stderr and the exit code', async () => {
  const r = await runCli({
    bin: node,
    args: ['-e', 'process.stdin.on("data",d=>process.stdout.write(d));process.stdin.on("end",()=>process.stderr.write("done"))'],
    stdin: 'hello',
    timeoutMs: 10000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.stderr, 'done');
  assert.equal(r.code, 0);
  assert.ok(r.ms >= 0);
});

test('runCli runs the child in an empty temp directory that is gone afterwards', async () => {
  const r = await runCli({ bin: node, args: ['-e', 'console.log(process.cwd()+"|"+require("fs").readdirSync(".").length)'], timeoutMs: 10000 });
  const [cwd, count] = r.stdout.trim().split('|');
  assert.equal(count, '0');
  assert.ok(!fs.existsSync(cwd), 'temp cwd removed');
});

test('runCli kills a hung child at the timeout and says so', async () => {
  const t0 = Date.now();
  const r = await runCli({ bin: node, args: ['-e', 'setTimeout(()=>{}, 20000)'], timeoutMs: 400 });
  assert.equal(r.ok, false);
  assert.match(r.error, /timed out/);
  assert.ok(Date.now() - t0 < 5000);
});

test('runCli never rejects: a missing binary is an error result', async () => {
  const r = await runCli({ bin: '/definitely/not/here', args: [], timeoutMs: 1000 });
  assert.equal(r.ok, false);
  assert.match(r.error, /ENOENT|not found/i);
});

test('runCli reports a non-zero exit with stderr as the error text', async () => {
  const r = await runCli({ bin: node, args: ['-e', 'process.stderr.write("bad flag");process.exit(3)'], timeoutMs: 10000 });
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.match(r.error, /bad flag/);
});

test('engineEnv drops the extension-host variables and anything in scrub, and prepends the usual bins on POSIX', () => {
  const base = { PATH: '/bin', NODE_OPTIONS: '--inspect', ELECTRON_RUN_AS_NODE: '1', VSCODE_INSPECTOR_OPTIONS: 'x', ANTHROPIC_API_KEY: 'sk', KEEP: '1' };
  const env = engineEnv({ base, platform: 'darwin', home: '/h', scrub: ['ANTHROPIC_API_KEY'] });
  assert.ok(!('NODE_OPTIONS' in env) && !('ELECTRON_RUN_AS_NODE' in env) && !('VSCODE_INSPECTOR_OPTIONS' in env));
  assert.ok(!('ANTHROPIC_API_KEY' in env));
  assert.equal(env.KEEP, '1');
  assert.equal(env.PATH, '/opt/homebrew/bin:/usr/local/bin:/h/.local/bin:/bin');
  const win = engineEnv({ base: { Path: 'C:\\x' }, platform: 'win32', home: 'C:\\u' });
  assert.equal(win.Path, 'C:\\x');
});

test('engineEnv scrubs case-insensitively and does not mutate the base', () => {
  const base = { anthropic_api_key: 'sk' };
  const env = engineEnv({ base, platform: 'linux', home: '/h', scrub: ['ANTHROPIC_API_KEY'] });
  assert.ok(!Object.keys(env).some((k) => k.toLowerCase() === 'anthropic_api_key'));
  assert.equal(base.anthropic_api_key, 'sk');
});

test('spawnSpec wraps a Windows .cmd shim in cmd.exe with a quoted command line; POSIX is a direct spawn', () => {
  const w = spawnSpec({ bin: 'C:\\x\\claude.cmd', args: ['-p', '--model', 'x y'], platform: 'win32', env: { ComSpec: 'C:\\W\\cmd.exe' } });
  assert.equal(w.command, 'C:\\W\\cmd.exe');
  assert.deepEqual(w.args, ['/d', '/s', '/c', '""C:\\x\\claude.cmd" -p --model "x y""']);
  assert.equal(w.options.windowsVerbatimArguments, true);
  const p = spawnSpec({ bin: '/x/claude', args: ['-p'], platform: 'darwin' });
  assert.deepEqual(p, { command: '/x/claude', args: ['-p'], options: {} });
});

test('resolveBin prefers a configured path that exists, else the PATH lookup, else null', () => {
  const which = (n) => (n === 'claude' ? '/x/claude' : null);
  const exists = (p) => p === '/cfg/claude';
  assert.equal(resolveBin('claude', { configured: '/cfg/claude', which, exists }), '/cfg/claude');
  assert.equal(resolveBin('claude', { configured: '/missing', which, exists }), null);
  assert.equal(resolveBin('claude', { configured: '', which, exists }), '/x/claude');
  assert.equal(resolveBin('codex', { configured: '', which, exists }), null);
});

test('the default PATH lookup finds node itself', () => {
  assert.ok(resolveBin('node', {}));
});

test('runCli accepts args as a function of the temp cwd and a collect hook that reads from it before cleanup', async () => {
  const r = await runCli({
    bin: node,
    args: (dir) => ['-e', 'require("fs").writeFileSync(process.argv[1], "from child")', `${dir}/out.txt`],
    collect: (dir) => fs.readFileSync(`${dir}/out.txt`, 'utf8'),
    timeoutMs: 10000,
  });
  assert.equal(r.ok, true);
  assert.equal(r.collected, 'from child');
});

test('spawnSpec: the cmd.exe command line is wrapped in one more pair of quotes, as cmd /s requires', () => {
  const w = spawnSpec({ bin: 'C:\\x\\claude.cmd', args: ['--mcp-config', '{"a":1}'], platform: 'win32', env: { ComSpec: 'cmd.exe' } });
  const line = w.args[3];
  assert.ok(line.startsWith('"') && line.endsWith('"'), 'outer quotes present');
  assert.equal(line, '""C:\\x\\claude.cmd" --mcp-config "{\\"a\\":1}""');
});

test('pickBin prefers a runnable Windows extension over the extensionless npm shim', () => {
  const { pickBin } = require('../src/providers/spawn.js');
  const lines = ['C:\\Users\\me\\AppData\\Roaming\\npm\\claude', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.ps1'];
  assert.equal(pickBin(lines, 'win32'), 'C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(pickBin(['C:\\a\\x.exe', 'C:\\b\\x.cmd'], 'win32'), 'C:\\a\\x.exe');
  assert.equal(pickBin(['C:\\only\\shim'], 'win32'), 'C:\\only\\shim');
  assert.equal(pickBin(['/usr/local/bin/claude', '/opt/x/claude'], 'darwin'), '/usr/local/bin/claude');
});

test('runCli still scrubs when an explicit env is passed', async () => {
  const r = await runCli({
    bin: node,
    args: ['-e', 'process.stdout.write(String(process.env.FORGE_SECRET || "") + "|" + String(process.env.FORGE_KEEP || ""))'],
    env: { ...process.env, FORGE_SECRET: 'leak', FORGE_KEEP: 'kept' },
    scrub: ['FORGE_SECRET'],
    timeoutMs: 10000,
  });
  assert.equal(r.stdout, '|kept');
});

test('resolveBin caches the PATH lookup until asked for a fresh one', () => {
  let n = 0;
  const which = () => { n += 1; return '/x/claude'; };
  const { clearBinCache } = require('../src/providers/spawn.js');
  clearBinCache();
  resolveBin('claude', { configured: '', which, exists: () => true });
  resolveBin('claude', { configured: '', which, exists: () => true });
  assert.equal(n, 1, 'second lookup served from the cache');
  resolveBin('claude', { configured: '', which, exists: () => true, fresh: true });
  assert.equal(n, 2, 'fresh forces a lookup');
  clearBinCache();
});
