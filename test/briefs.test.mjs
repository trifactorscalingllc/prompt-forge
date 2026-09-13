// Connecting a project: at once with a brief from the files, the engine's brief later and only once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const storeMod = require('../src/store.js');
const { createBriefs } = require('../src/briefs.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'forge-briefs-'));
const flush = async () => { for (let i = 0; i < 5; i += 1) await new Promise((r) => setImmediate(r)); };
const COLLECTED = { files: ['README.md'], tree: ['README.md', 'index.js'], text: '--- README.md ---\n# Web\n\nBookings for salons.\n', truncated: false };

/** An engine whose answer arrives only when the test says so. */
function slowEngine(brief = '## Project: web (written by the engine)') {
  const calls = [];
  const waiting = [];
  const describe = ({ label }) => {
    calls.push(label);
    return new Promise((resolve) => waiting.push(() => resolve({ brief, call: { model: 'fable', in: 10, out: 5 } })));
  };
  return { calls, describe, answer: async () => { while (waiting.length) waiting.shift()(); await flush(); } };
}

test('connecting attaches a brief from the files at once; the engine\'s replaces it in the background; the next prompt on the same commit reuses it with no call', async () => {
  const s = storeMod.open(tmp());
  const a = s.create('A').slug;
  const b = s.create('B').slug;
  const engine = slowEngine();
  const changed = [];
  const briefs = createBriefs({ getStore: () => s, collect: async () => COLLECTED, describe: engine.describe, gitHead: () => 'abc1234', onChange: (slug) => changed.push(slug) });

  const t0 = Date.now();
  const first = await briefs.attach(a, '/w/web');
  assert.ok(Date.now() - t0 < 500, 'connected without waiting for the engine');
  assert.equal(first.error, null);
  let p = s.read(a).projects[0];
  assert.equal(p.briefKind, 'quick');
  assert.match(p.brief, /^## Project: web {2}\(\/w\/web\)\nStack: JavaScript\nPurpose: Bookings for salons\./);
  assert.equal(p.head, 'abc1234');
  assert.deepEqual(p.files, ['README.md']);
  assert.ok(briefs.refining('/w/web'), 'the engine is writing the fuller one');
  await flush();
  assert.equal(engine.calls.length, 1);

  await engine.answer();
  p = s.read(a).projects[0];
  assert.equal(p.briefKind, 'engine');
  assert.equal(p.brief, '## Project: web (written by the engine)');
  assert.deepEqual(p.call, { model: 'fable', in: 10, out: 5 });
  assert.ok(!briefs.refining('/w/web'));
  assert.ok(changed.includes(a), 'the panel is told');

  const second = await briefs.attach(b, '/w/web');
  assert.equal(second.reused, true);
  assert.equal(s.read(b).projects[0].briefKind, 'engine');
  await flush();
  assert.equal(engine.calls.length, 1, 'the same project at the same commit costs no second call');

  await briefs.attach(b, '/w/web', null, { force: true });
  assert.equal(s.read(b).projects[0].briefKind, 'quick', 'Rebuild starts again');
  await flush();
  assert.equal(engine.calls.length, 2);
  await engine.answer();
  assert.equal(s.read(b).projects.length, 1, 'reconnecting replaces the record rather than adding one');
});

test('a new commit gets a new brief; one engine call serves every prompt waiting on it; a brief landing after a disconnect is dropped', async () => {
  const s = storeMod.open(tmp());
  const a = s.create('A').slug;
  const b = s.create('B').slug;
  const engine = slowEngine();
  let head = 'abc1234';
  const briefs = createBriefs({ getStore: () => s, collect: async () => COLLECTED, describe: engine.describe, gitHead: () => head });

  await briefs.attach(a, '/w/web');
  await briefs.attach(b, '/w/web');
  await flush();
  assert.equal(engine.calls.length, 1, 'two prompts, one project, one call');
  s.setProjects(a, []);   // disconnected before the engine answered
  await engine.answer();
  assert.deepEqual(s.read(a).projects, [], 'not brought back by a late answer');
  assert.equal(s.read(b).projects[0].briefKind, 'engine');

  head = 'def5678';
  const moved = await briefs.attach(a, '/w/web');
  assert.equal(moved.reused, false, 'the code changed since that brief was written');
  await flush();
  assert.equal(engine.calls.length, 2);
  await engine.answer();
});

test('an unreadable folder is an error on the project; with no engine the quick brief stands and nothing is called; an engine failure keeps it', async () => {
  const s = storeMod.open(tmp());
  const slug = s.create('A').slug;
  const engine = slowEngine();
  const briefs = createBriefs({ getStore: () => s, collect: async (dir) => (dir === '/empty' ? { files: [], tree: [], text: '' } : COLLECTED), describe: engine.describe });

  const empty = await briefs.attach(slug, '/empty');
  assert.match(empty.error, /Nothing readable in \/empty/);
  assert.equal(s.read(slug).projects[0].error, empty.error);

  const offline = await briefs.attach(slug, '/w/web', null, { engineReady: false });
  assert.equal(offline.error, null);
  assert.equal(s.read(slug).projects.find((p) => p.path === '/w/web').briefKind, 'quick');
  await flush();
  assert.equal(engine.calls.length, 0);

  const warned = [];
  const failing = createBriefs({ getStore: () => s, collect: async () => COLLECTED, describe: async () => ({ error: 'rate limited' }), log: { warn: (m) => warned.push(m) } });
  await failing.attach(slug, '/w/other');
  await flush();
  const p = s.read(slug).projects.find((x) => x.path === '/w/other');
  assert.equal(p.briefKind, 'quick');
  assert.equal(p.error, null, 'a failed refinement is not a broken connection');
  assert.match(warned[0], /rate limited/);

  const ssh = createBriefs({ getStore: () => s, collect: async () => ({ ...COLLECTED, head: 'fedcba9' }), describe: engine.describe });
  const remote = await ssh.attach(slug, '/home/me/app', 'mac-mini', { engineReady: false });
  assert.equal(remote.record.label, 'mac-mini:app');
  assert.equal(remote.record.head, 'fedcba9');
  assert.match(remote.record.brief, /^## Project: mac-mini:app {2}\(mac-mini:\/home\/me\/app\)/);
});
