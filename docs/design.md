# Prompt Forge, design

## Problem

Complicated prompts written in a chat box drift. Ideas get repeated, an earlier line gets contradicted, something stays vague enough that the model fills the gap with an assumption. Prompt Forge is a VS Code window with an idea box: every Enter sends one rough idea to an engine that merges it into a structured prompt document, keeps a chronological history, flags contradictions instead of resolving them silently, and rewrites the whole document for the target model on request.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Engine | Whatever the user already has: a vendor CLI login (Claude, Gemini, Codex) or an API key (Anthropic, Google AI Studio, OpenAI, any OpenAI-compatible endpoint) | No model of our own, no server, no telemetry. No vendor lets a third-party extension log into a chat subscription, so sign-in rides on the vendor CLI. |
| Two models per provider | A fast one for every merge, the best one for Polish; `auto` derives both from the account's model list | Merges must feel instant; Polish is worth the wait. |
| Target vs engine | Independent | Build a GPT-5 prompt on a Claude subscription, or the reverse. |
| Document | A real `.md` opened beside the panel, hand-editable at any time | The file is the truth; the engine reads the live text before every merge. |
| Conflicts | Never resolved by the engine. The existing text stays, the incoming text is kept out of the body and listed under "Open conflicts" with keep-old / keep-new chips | A silently resolved contradiction is exactly the assumption the tool exists to prevent. |
| Persistence | `<slug>.md` plus `<slug>.forge.json` per prompt, plain files, atomic writes | Readable, portable, no database. |
| Secrets | VS Code SecretStorage only | Never in settings, logs, state, or the sidecar. |
| Runtime | Zero dependencies, CommonJS, vanilla DOM | A normal vsix with no build step. |
| Hot reload | `extension.js` registers (cold); `src/` and `media/` reload without an extension-host restart when `promptForge.sourcePath` points at a working copy | An extension-host restart kills every AI coding session running in that window. |

## Layout

```
extension.js            cold shell: commands, status bar, the WebviewPanel, the hot host
src/hot/                vendored hot-reload kit
src/runtime.js          hot entry: create(host) -> { html, handleMessage, replay, start, dispose }
src/view.js             the page (CSP, cache-busting stamp)
src/session.js          per-prompt controller: queue + store + document + engine
src/queue.js            one call in flight; queued ideas/resolutions fold into one merge
src/store.js            library folder, sidecar read/write, slugs, trash
src/doc.js              markdown helpers: seed, conflict block, copy text
src/docio.js            read/write/open the TextDocument (vscode injected)
src/engine/prompt.js    merge and polish prompt builders (pure)
src/engine/output.js    engine JSON extraction and validation (pure)
src/engine/engine.js    provider + model selection per role, call logging
src/providers/*.js      claude, gemini, openai, compatible; spawn.js and http.js underneath
src/targets/            target list and the three style guides
media/                  panel.js, panel.css, icons
test/                   node --test, no VS Code needed
```

## Provider contract

Every provider exports `create(deps)` returning the same shape, so the engine and the panel never special-case a vendor:

```
detect({cfg, secrets})            -> { cli: {found, path, version, loggedIn, account, plan, note}, apiKey: {stored} }
listModels(mode, {cfg, secrets})  -> [{ id, label, tier: 'fast' | 'best' | 'other' }]
defaults(models)                  -> { merge, polish }
complete({mode, model, prompt, timeoutMs, cfg, secrets}) -> { text, usage: {input, output}, error }
signIn                            -> { cli: { command, args } } or null
```

CLI calls run in an empty temporary directory (no project instruction files get picked up), with the prompt on stdin (no command-line length limits), with the extension host's Node variables scrubbed, and with a process-group kill on timeout. In Claude CLI mode the billing variables are also scrubbed so the subscription pays, not a stray key.

## The engine prompts

**Merge** (fast model). Input: the document body, the new ideas (numbered), the recently merged ideas, the open conflicts, and any resolutions. Rules: merge each idea into the section it belongs to, never as a loose bullet; fold duplicates; never resolve a contradiction silently (report it in `conflicts` with a stable id); apply resolutions exactly; do not restyle; return the complete document.

**Polish** (best model). Input: the document body, the open conflicts, and the target family's style guide. Rules: change form, not substance; return conflicts unchanged; keep sections the merge engine can extend; put every XML/HTML tag on its own line (the WYSIWYG editor preserves block-level tags, not inline ones).

Both return one JSON object: `{ "doc", "conflicts": [{id, section, existing, incoming}], "changes": [] }`. The parser tolerates fences and prose, assigns missing ids, drops duplicates, strips any stray conflict section, and refuses a merge result that is less than 40% of the input's length.

## Session rules

1. An idea is written to the sidecar as `pending` before the engine is called. A failure marks it `failed` with the error and offers Retry; the text is never lost. An entry still `pending` when the extension loads is marked `failed: interrupted`.
2. One engine call in flight per prompt. Ideas and resolutions that arrive meanwhile become one follow-up merge; repeated Polish requests collapse to one.
3. Before each call the live document is read. If it differs from the last snapshot, a `hand-edit` snapshot is recorded first, and the engine sees the edited text.
4. After the call the document is read again. If it changed during the call, the merge runs once more on the new text instead of overwriting it.
5. Every landed result is a snapshot with the call's provider, model, duration and token usage. Restore rewrites the document from any snapshot and is itself recorded.
6. Copy strips the conflict block and any forge comments.
7. Writes to an open document go through a WorkspaceEdit followed by a save, after waiting out the WYSIWYG editor's post-save echo window; writes to a closed document go to disk.

## Sidecar (`<slug>.forge.json`, version 1)

```json
{
  "version": 1, "slug": "…", "title": "…", "target": "fable-5.1", "createdAt": 0, "updatedAt": 0,
  "entries":   [{ "id": "e1", "ts": 0, "text": "…", "status": "pending|merged|failed", "snapshotId": "s2", "error": null }],
  "snapshots": [{ "id": "s1", "ts": 0, "kind": "seed|merge|polish|resolve|restore|hand-edit", "entryIds": [], "doc": "…", "conflicts": [], "changes": [], "target": "…", "call": { "provider": "…", "mode": "…", "model": "…", "ms": 0, "usage": { "input": 0, "output": 0 } }, "from": null }],
  "conflicts": [{ "id": "C1", "section": "…", "existing": "…", "incoming": "…", "raisedAt": 0, "entryId": "e3" }],
  "resolved":  [{ "id": "C1", "keep": "new|old", "ts": 0 }]
}
```

## Panel protocol

Webview to extension: `ready`, `panelOpened`, `openPrompt`, `newPrompt`, `deletePrompt`, `idea`, `setTarget`, `polish`, `copy`, `restore`, `resolve`, `retry`, `openDoc`, `openLibrary`, `openUrl`, `engine.detect`, `engine.signIn`, `engine.setKey`, `engine.forgetKey`, `engine.select`.

Extension to webview: `state` (the whole state on every change), `notice`, `focus`.

## Known limits

- Subscription quota is not visible to third parties; the panel shows per-call tokens only.
- Vendor CLI contracts drift. Flags rejected by an older Claude CLI are dropped and the call retried; model catalogs for CLI modes carry a `lastVerified` date and any id can be typed.
- The Codex CLI mode is written to its documented contract and not yet exercised on a machine with Codex installed.
- The Claude style guide uses block-level XML tags because the WYSIWYG editor may escape inline ones; the plain text editor is a setting away.
