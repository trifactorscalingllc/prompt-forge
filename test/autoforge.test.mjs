import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const detect = require('../src/autoforge/detect.js');
const card = require('../src/autoforge/card.js');
const { createAutoForge } = require('../src/autoforge/controller.js');
const { createAgent, urlFilePath } = require('../src/autoforge/agent.js');
const { createInstaller, lastJson, PLUGIN_ID } = require('../src/autoforge/install.js');

const LONG = (n) => `Build the checkout page. ${'It must take Stripe and show the order summary. '.repeat(n)}`;

// ---------------------------------------------------------------------------------------------
// Detection

test('a prompt is counted without its pasted code, stack traces and @-mentions', () => {
  const words = 'Make the retry logic back off exponentially.';
  const pasted = `${words}\n\`\`\`js\n${'x = 1;\n'.repeat(200)}\`\`\`\n    at Object.run (/app/index.js:12:5)\n@src/retry.js`;
  assert.equal(detect.countedLength(pasted), words.length);
});

test('slash commands, hook wrappers and answers to forge questions never count', () => {
  for (const t of ['/clear', '<command-name>/x</command-name>', '<user-prompt-submit-hook>hi', 'Q2: CSV only', '   ']) assert.equal(detect.isCountable(t), false, t);
  assert.equal(detect.isCountable('Add a PayPal button'), true);
});

test('an offer needs enough unused long prompts among the recent ones', () => {
  const p = (length, used = false) => ({ id: String(Math.random()), length, used });
  const s = { minChars: 400, minPrompts: 3 };
  assert.equal(detect.pickOffer([p(500), p(500), p(100)], s), null);
  assert.equal(detect.pickOffer([p(500), p(500), p(500)], s).length, 3);
  assert.equal(detect.pickOffer([p(500, true), p(500), p(500)], s), null, 'a declined prompt does not count again');
  assert.equal(detect.pickOffer([p(500), p(500), ...Array.from({ length: 7 }, () => p(10)), p(500)], s), null, 'only the last 8 prompts are looked at');
});

test('settings are clamped, and anything but confirm is off', () => {
  assert.deepEqual(detect.settingsFrom({ mode: 'auto', minChars: 5, minPrompts: 99 }), { mode: 'off', minChars: 100, minPrompts: 10, window: 8 });
  assert.equal(detect.settingsFrom({ mode: 'confirm' }).minChars, 400);
});

// ---------------------------------------------------------------------------------------------
// Card

test('the confirm question fits AskUserQuestion and its answers are read back, typed ones too', () => {
  const q = card.confirmQuestion(3);
  assert.ok(q.header.length <= 12, 'AskUserQuestion headers are at most 12 characters');
  assert.equal(q.options.length, 3);
  const asked = (value) => ({ questions: [q], answers: { [q.question]: value } });
  assert.equal(card.answerFor(asked('Forge them')), 'forge');
  assert.equal(card.answerFor(asked('Not now')), 'later');
  assert.equal(card.answerFor(asked('Never in this chat')), 'never');
  assert.equal(card.answerFor(asked('yes please')), 'forge');
  assert.equal(card.answerFor(asked('maybe later')), 'later');
  assert.equal(card.answerFor({ questions: [{ header: 'Other', question: 'Which DB?' }], answers: { 'Which DB?': 'Postgres' } }), null, 'someone else\'s question');
  assert.ok(card.askInstruction(3).includes(q.question));
});

test('the card names the prompt, lists changes and the held-back conflict, and cannot be turned into links by the prompt', () => {
  const text = card.cardText({
    title: 'Checkout [redesign] *brief*', count: 3,
    changes: ['Goal: written', 'Requirements: +5', 'a', 'b', 'c', 'd', 'e'],
    conflicts: [{ section: 'Requirements', existing: 'Stripe only', incoming: 'Stripe and PayPal' }],
    undoUrl: 'vscode://x/forge/undo?id=1', openUrl: 'vscode://x/forge/open?id=1',
  });
  assert.ok(text.startsWith('**Prompt Forge** · forged 3 prompts into *Checkout redesign brief*'));
  assert.ok(text.includes('- and 2 more'));
  assert.ok(text.includes('- Held back: 1 conflict (Requirements: "Stripe only" vs "Stripe and PayPal")'));
  assert.ok(text.endsWith('[Undo](vscode://x/forge/undo?id=1) · [Open in Prompt Forge](vscode://x/forge/open?id=1) · or type /unforge'));
  assert.ok(card.cardText({ title: 'T', count: 2, update: true }).includes('added 2 more prompts to *T*'));
});

// ---------------------------------------------------------------------------------------------
// Controller

function harness(over = {}) {
  const calls = { forge: [], undo: [], events: [] };
  let settle;
  const forgeResult = over.forgeResult || { ok: true, slug: 'checkout', title: 'Checkout brief', changes: ['Goal: written'], conflicts: [], undo: { slug: 'checkout', created: true } };
  const af = createAutoForge({
    settings: () => ({ mode: 'confirm', minChars: 100, minPrompts: 3, ...(over.settings || {}) }),
    engineReady: over.engineReady || (() => ({ ok: true })),
    inScope: over.inScope || (() => true),
    forge: async (args) => { calls.forge.push(args); if (over.slowForge) await new Promise((r) => { settle = r; }); return forgeResult; },
    undo: async (u) => { calls.undo.push(u); return { ok: true }; },
    uriFor: (action, id) => `vscode://pf/forge/${action}?id=${id}`,
    onEvent: (e) => calls.events.push(e),
    cardWaitMs: over.cardWaitMs || 2000,
  });
  const sid = 'chat-1';
  const base = { session_id: sid, cwd: '/work/app' };
  const prompt = (text) => af.handle('prompt', { ...base, prompt: text, prompt_id: String(Math.random()) });
  const stop = () => af.handle('stop', { ...base, stop_hook_active: false });
  const answer = (value) => {
    const q = card.confirmQuestion(3);
    return af.handle('ask', { ...base, tool_name: 'AskUserQuestion', tool_input: { questions: [q], answers: { [q.question]: value } } });
  };
  return { af, calls, prompt, stop, answer, release: () => settle && settle() };
}

const ctx = (r) => (r && r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) || '';

test('confirm first: offer, ask, forge, card, then /unforge undoes it', async () => {
  const h = harness();
  assert.deepEqual(await h.prompt(LONG(3)), {});
  assert.deepEqual(await h.prompt('short'), {});
  assert.deepEqual(await h.stop(), {}, 'nothing to say before the threshold');
  await h.prompt(LONG(3));
  const offered = await h.prompt(LONG(3));
  assert.match(offered.systemMessage, /bigger job \(3 long prompts\)/);
  assert.match(ctx(await h.stop()), /call AskUserQuestion once/);
  assert.match(ctx(await h.answer('Forge them')), /forging those prompts now/);
  assert.equal(h.calls.forge.length, 1);
  assert.equal(h.calls.forge[0].texts.length, 3);
  assert.equal(h.calls.forge[0].slug, null, 'the first forge creates a prompt');
  const cardReply = ctx(await h.stop());
  assert.match(cardReply, /forged 3 prompts into \*Checkout brief\*/);
  assert.match(cardReply, /\[Undo\]\(vscode:\/\/pf\/forge\/undo\?id=[0-9a-f]+\)/);
  assert.deepEqual(await h.stop(), {}, 'the card is posted once');
  const undone = await h.prompt('/unforge');
  assert.match(undone.systemMessage, /undid the forge of 3 prompts/);
  assert.match(ctx(undone), /Prompt Forge handled \/unforge/);
  assert.deepEqual(h.calls.undo, [{ slug: 'checkout', created: true }]);
  assert.match((await h.prompt('/prompt-forge:unforge')).systemMessage, /nothing undone/, 'namespaced, and nothing left to undo');
});

test('a second batch of long prompts updates the same prompt', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await h.prompt(LONG(3));
  await h.stop(); await h.answer('Forge them'); await h.stop();
  for (let i = 0; i < 3; i++) await h.prompt(LONG(3));
  await h.stop(); await h.answer('Forge them');
  assert.equal(h.calls.forge[1].slug, 'checkout');
  assert.match(ctx(await h.stop()), /added 3 more prompts to/);
});

test('not now waits for new long prompts; never in this chat stops watching', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await h.prompt(LONG(3));
  await h.stop();
  assert.deepEqual(await h.answer('Not now'), {});
  assert.deepEqual(await h.prompt(LONG(3)), {}, 'the declined three do not count again');
  await h.prompt(LONG(3));
  assert.match((await h.prompt(LONG(3))).systemMessage, /bigger job/);
  await h.stop();
  await h.answer('Never in this chat');
  for (let i = 0; i < 5; i++) assert.deepEqual(await h.prompt(LONG(3)), {});
  assert.equal(h.calls.forge.length, 0);
});

test('a question Claude never asked is treated as not now, not a stuck chat', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await h.prompt(LONG(3));
  await h.stop();
  for (let i = 0; i < 2; i++) assert.deepEqual(await h.prompt(LONG(3)), {});
  assert.match((await h.prompt(LONG(3))).systemMessage, /bigger job/);
});

test('a slow forge lets Claude stop, and the card goes out at the next stop', async () => {
  const h = harness({ slowForge: true, cardWaitMs: 30 });
  for (let i = 0; i < 3; i++) await h.prompt(LONG(3));
  await h.stop(); await h.answer('Forge them');
  assert.deepEqual(await h.stop(), {}, 'did not wait past cardWaitMs');
  h.release();
  await new Promise((r) => setTimeout(r, 10));
  assert.match(ctx(await h.stop()), /forged 3 prompts/);
});

test('a failed forge says why and changes nothing; no engine means one warning, no offer', async () => {
  const h = harness({ forgeResult: { ok: false, error: 'engine timed out' } });
  for (let i = 0; i < 3; i++) await h.prompt(LONG(3));
  await h.stop(); await h.answer('yes');
  assert.match(ctx(await h.stop()), /could not forge the last 3 prompts: engine timed out\. Nothing was changed\./);
  assert.match((await h.prompt('/unforge')).systemMessage, /nothing undone/);

  const n = harness({ engineReady: () => ({ ok: false, reason: 'sign in first' }) });
  for (let i = 0; i < 2; i++) await n.prompt(LONG(3));
  assert.match((await n.prompt(LONG(3))).systemMessage, /could not offer to forge this chat: sign in first/);
  assert.deepEqual(await n.prompt(LONG(3)), {}, 'said once');
  assert.deepEqual(await n.stop(), {});
});

test('off, out of scope, or malformed: every hook is told to carry on', async () => {
  const off = harness({ settings: { mode: 'off' } });
  for (let i = 0; i < 4; i++) assert.deepEqual(await off.prompt(LONG(3)), {});
  const out = harness({ inScope: () => false });
  for (let i = 0; i < 4; i++) assert.deepEqual(await out.prompt(LONG(3)), {});
  const h = harness();
  assert.deepEqual(await h.af.handle('prompt', null), {});
  assert.deepEqual(await h.af.handle('prompt', { prompt: 'no session id' }), {});
  assert.deepEqual(await h.af.handle('ask', { session_id: 'x', tool_name: 'Bash' }), {});
});

test('a card link undoes by id', async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) await h.prompt(LONG(3));
  await h.stop(); await h.answer('Forge them');
  const id = /id=([0-9a-f]+)/.exec(ctx(await h.stop()))[1];
  assert.equal((await h.af.undoById(id)).ok, true);
  assert.equal((await h.af.undoById(id)).ok, false, 'twice is refused');
  assert.equal((await h.af.undoById('nope')).ok, false);
});

// ---------------------------------------------------------------------------------------------
// Endpoint

async function post(url, body, headers = {}) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  return { status: r.status, json: r.status === 200 ? await r.json() : null };
}

test('the endpoint writes its private URL, answers only its token, passes the entry point on, and cleans up after itself', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-agent-'));
  const seen = [];
  const agent = createAgent({ home, handle: async (event, input) => { seen.push({ event, input }); return { systemMessage: 'hi' }; } });
  const url = await agent.start();
  const file = urlFilePath(home);
  assert.equal(fs.readFileSync(file, 'utf8'), url);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'only the owner can read the token');
  assert.ok(/^http:\/\/127\.0\.0\.1:\d+\/h\/[0-9a-f]{36}$/.test(url));
  assert.deepEqual((await post(`${url}/prompt`, '{"session_id":"s","prompt":"x"}', { 'x-claude-entrypoint': 'claude-vscode' })).json, { systemMessage: 'hi' });
  assert.equal(seen[0].input.entrypoint, 'claude-vscode');
  assert.deepEqual((await post(`${url}/prompt`, 'not json')).json, {}, 'a bad body is told to carry on');
  assert.equal((await post(url.replace(/[0-9a-f]{36}$/, 'f'.repeat(36)) + '/prompt', '{}')).status, 404);
  assert.equal((await post(`${url}/delete-everything`, '{}')).status, 404);
  assert.ok(agent.owns());
  await agent.dispose();
  assert.equal(fs.existsSync(file), false);

  const other = createAgent({ home, handle: async () => ({}) });
  await other.start();
  fs.writeFileSync(file, 'http://127.0.0.1:1/h/someone-else');
  await other.dispose();
  assert.equal(fs.readFileSync(file, 'utf8'), 'http://127.0.0.1:1/h/someone-else', 'another window\'s URL is left alone');
});

// ---------------------------------------------------------------------------------------------
// The Claude Code plugin

test('every plugin hook is silent when Prompt Forge is not running, and gives up before Claude Code does', () => {
  const hooks = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-plugin/prompt-forge/hooks/hooks.json'), 'utf8')).hooks;
  assert.deepEqual(Object.keys(hooks).sort(), ['PostToolUse', 'Stop', 'UserPromptSubmit']);
  assert.equal(hooks.PostToolUse[0].matcher, 'AskUserQuestion');
  for (const [event, groups] of Object.entries(hooks)) {
    for (const h of groups.flatMap((g) => g.hooks)) {
      assert.equal(h.type, 'command', `${event}: a command hook, because an http hook prints an error when nothing answers`);
      assert.ok(h.command.trim().endsWith('|| true'), `${event}: failure is swallowed`);
      assert.ok(h.command.includes('$HOME/.prompt-forge/autoforge-url'), `${event}: the URL is read at call time`);
      const maxTime = Number(/-m (\d+)/.exec(h.command)[1]);
      assert.ok(maxTime < h.timeout, `${event}: curl stops before the hook times out`);
    }
  }
  assert.ok(/-m 2\d/.test(hooks.Stop[0].hooks[0].command), 'the Stop hook can wait for a forge to land');
});

test('the plugin and its marketplace agree, ship in the vsix, and carry /unforge', () => {
  const market = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-plugin/.claude-plugin/marketplace.json'), 'utf8'));
  const plugin = JSON.parse(fs.readFileSync(path.join(ROOT, 'claude-plugin/prompt-forge/.claude-plugin/plugin.json'), 'utf8'));
  assert.equal(`${plugin.name}@${market.name}`, PLUGIN_ID);
  assert.equal(market.plugins[0].version, plugin.version);
  assert.ok(fs.existsSync(path.join(ROOT, 'claude-plugin/prompt-forge/commands/unforge.md')));
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  assert.ok(!/claude-plugin/.test(ignore));
});

test('the installer stages the plugin, adds, installs and removes it, reporting what the CLI said', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-install-'));
  const ran = [];
  const runCli = async ({ args }) => {
    ran.push(args.join(' '));
    if (args[1] === 'install') return { code: 0, stdout: '{"command":"install","outcome":"ok","message":"Successfully installed"}\n' };
    if (args[1] === 'uninstall') return { code: 1, stdout: '{"outcome":"failed","failureCode":"not_installed"}' };
    return { code: 0, stdout: 'ok' };
  };
  const inst = createInstaller({ runCli, claudeBin: () => '/bin/claude', sourceDir: path.join(ROOT, 'claude-plugin'), home });
  const r = await inst.ensure();
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(home, '.prompt-forge/claude-plugin/prompt-forge/hooks/hooks.json')));
  assert.deepEqual(ran, [`plugin marketplace add ${inst.dest}`, 'plugin marketplace update prompt-forge-local', `plugin install ${PLUGIN_ID} --scope user --json`]);
  ran.length = 0;
  await inst.ensure();
  assert.ok(!ran.some((a) => a.includes('update')), 'the same version is not re-staged');
  assert.equal((await inst.remove()).ok, true, 'not installed counts as removed');
  assert.equal(fs.existsSync(inst.dest), false);
  const none = createInstaller({ runCli, claudeBin: () => null, sourceDir: path.join(ROOT, 'claude-plugin'), home });
  assert.match((await none.ensure()).error, /claude command was not found/);
  assert.deepEqual(lastJson('noise\n{"a":1}\n{"b":2}\n'), { b: 2 });
});
