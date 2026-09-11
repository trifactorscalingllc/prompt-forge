# Prompt Forge — a public, provider-agnostic prompt-building extension for VS Code

## Context

Evan (2026-09-11) wants a VS Code extension for complicated prompts where the chat box is not enough: ideas get repeated, contradict each other, or stay vague enough that the model fills gaps with assumptions. A window in VS Code holds an idea box; every Enter sends one rough idea to an engine that **merges** it into a structured prompt document (never a loose bullet), keeps a chronological history, surfaces contradictions instead of resolving them silently, and rewrites the whole document in the style the chosen **target model** reads best. The document is a real `.md` opened beside the panel (in Office Viewer's WYSIWYG "pencil" editor when installed, else the plain editor) so it can be hand-edited any time. Copy puts the final prompt on the clipboard.

Revised scope (Evan, same day):
- **Public.** Its own GitHub repo and a Marketplace listing anyone can install. Not a TOM-internal tool.
- **No predetermined engine model.** The engine adapts to what the user signs in with: a Claude subscription, Gemini, ChatGPT/OpenAI, or a local/compatible endpoint. Available models are discovered from that account; the user picks (or accepts defaults) per role.
- **Secrets stay with the user.** Sign-in state and API keys live in the user's VS Code profile (SecretStorage, keychain-backed). The published extension contains nothing account-specific.

Two hard truths to design around (stated to Evan):
1. **No vendor lets a third-party extension OAuth into a chat subscription.** Claude, Gemini and ChatGPT subscription access is only reachable through each vendor's own CLI login (`claude auth login`, `gemini` OAuth, `codex login`). So "sign in with your Claude account" = Prompt Forge detects the vendor CLI, reads its login state, and opens that CLI's login when needed. API keys are the second path for every provider.
2. **No vendor exposes subscription quota/usage to third parties.** Prompt Forge shows per-call token usage (all providers return it) and a cost estimate in API-key mode. It cannot show "you have 40% of your Max plan left".

Engine provider and target model are **independent**: build a GPT-5 prompt using a Claude subscription as the engine.

## Decisions (assumptions Evan can veto on approval)

| Decision | Choice | Why |
|---|---|---|
| Repo | `/Users/tfs/prompt-forge/` (standalone), pushed to `github.com/trifactorscalingllc/prompt-forge` (public) | `gh` on the mini is logged in as the `trifactorscalingllc` account (a user account; `orgs/…` 404s). Same home as `workspace-frameworks`. |
| License | MIT | Standard for VS Code extensions; the vendored hot-reload kit gets a header noting origin and MIT. |
| Marketplace publisher | `trifactorscaling` on VS Code Marketplace + Open VSX (Cursor/VSCodium users) | Publisher creation + PAT is a **one-time human step for Evan**; CI is wired to publish once `VSCE_PAT`/`OVSX_PAT` repo secrets exist. Until then releases ship a `.vsix` asset on GitHub Releases. |
| DOE framework | Not applied; repo carries a `.no-doe` file | DOE scaffolding (directives/, execution/, TFS CLAUDE.md, launchd, venv) is TFS-internal and must not ship in a public OSS repo. `.no-doe` is the sanctioned decline marker for the SessionStart guard. |
| Hot-reload kit | Vendored **in source** at `src/hot/` (committed), not copied at build time | External contributors have no `_shared/`. Still "built on the kit": cold `extension.js`, hot `src/` + `media/`, `sourcePath`/`autoReload` machine-scoped, `afterBoot` repaints. |
| Build | `npx @vscode/vsce package` (devDependency only); runtime dependencies **zero**; vanilla DOM; Node built-ins + global `fetch` | Public users get a normal vsix; no bundler needed for plain CommonJS. |
| Library folder | setting `promptForge.libraryPath`, default `~/.prompt-forge/prompts/`, `~` expanded | Visible, hand-editable `.md` files; not tied to any one vendor. |
| Engine defaults | `promptForge.engine.provider: "auto"` (first signed-in provider), `mergeModel: "auto"`, `polishModel: "auto"` (provider's fast/best pair) | No hardcoded model; the pair is derived from what the account can reach. |
| Doc editor | Office Viewer (`cweijan.markdownViewer`) when installed, else built-in text editor | Optional dependency; README recommends it for WYSIWYG. |
| Telemetry | None. Prompts go only to the provider the user chose. | Privacy statement in README. |

## Verified facts that shape the design

| Fact | Consequence |
|---|---|
| `claude auth status` prints JSON `{loggedIn, authMethod, email, subscriptionType, …}` (CLI 2.1.251) | Claude sign-in detection is one read-only call; shows "Signed in as <email> · max" |
| `claude -p` supports `--output-format json`, `--tools`, `--setting-sources`, `--strict-mcp-config`, `--exclude-dynamic-system-prompt-sections`, `--model` aliases `sonnet`/`opus`/`fable` | Engine call: prompt on stdin, empty temp cwd (no CLAUDE.md pickup), no tools, JSON out. Probe flags at detect time and drop any the installed version rejects |
| `gemini` CLI 0.49.0 supports `-p`, `--output-format json`, `-m`; OAuth login is interactive | Gemini CLI mode works; sign-in = a terminal running `gemini` |
| `codex` is not installed on the mini | OpenAI CLI mode is written to the public Codex CLI contract (`codex exec --json -m … --skip-git-repo-check`, `codex login`) and marked "untested here" until installed; API-key mode is fully testable |
| Office Viewer's markdown editor is a `CustomTextEditorProvider`: it re-renders on `onDidChangeTextDocument`; hand edits are written with a 400 ms debounce; it ignores document changes for 800 ms after its own Cmd+S | Write the doc via `WorkspaceEdit` + `applyEdit` + `save()` on the open `TextDocument`; settle 450 ms before reading; wait out the echo window before writing |
| `openTextDocument(uri)` returns the live (dirty) model when open | "Prefer the open document over disk" in one call |
| Vditor preserves block-level HTML/XML, may escape inline tags | Claude style guide: every tag on its own line, blank lines around |
| `npx @vscode/vsce` 3.9.2 works on the mini; `gh` logged in as `trifactorscalingllc` with `repo`,`workflow` scopes | Can create the repo and CI from here; publishing needs Evan's PAT |

## File layout

```
/Users/tfs/prompt-forge/
  package.json                 COLD manifest; devDependency @vscode/vsce only
  extension.js                 COLD shell: log channel, hot host, WebviewPanel owner, commands, secrets bridge
  README.md                    what/how, providers + sign-in, privacy, dev (hot reload), build
  LICENSE                      MIT
  CHANGELOG.md
  .no-doe                      public OSS repo: TFS workspace scaffolding does not apply
  .vscodeignore                excludes test/, .github/, .no-doe, docs/
  .github/workflows/ci.yml     node --test on ubuntu/windows/macos
  .github/workflows/release.yml  on tag v*: vsce package → GitHub Release asset; publish to Marketplace/Open VSX if PATs exist
  docs/design.md               this plan, as the spec
  media/forge.svg              panel icon (gold #D4AF37 brand mark; UI itself uses theme colors)
  media/panel.css              VS Code theme variables
  media/panel.js               vanilla DOM renderer + message client
  src/hot/hot.js, reload.js    vendored kit (header: origin + MIT)
  src/runtime.js               HOT entry: create(host) -> { html, handleMessage, replay, start, dispose }
  src/view.js                  html({vscode, webview, mediaRoots, stamp}); serialise(state)
  src/session.js               per-prompt controller: queue + store + doc + engine
  src/queue.js                 pure FIFO with batching
  src/store.js                 library folder, sidecar (atomic write), slugify, list, trash
  src/doc.js                   pure markdown helpers: seed, conflict block render/strip, stripForCopy
  src/docio.js                 readDoc / writeDoc / openBeside (vscode injected)
  src/engine/prompt.js         pure: buildMergePrompt, buildPolishPrompt, OUTPUT_CONTRACT
  src/engine/output.js         pure: extractJson, parseEngineOutput
  src/engine/engine.js         picks provider+model per role, calls provider.complete, records usage
  src/providers/index.js       registry + detectAll() + auto-selection
  src/providers/spawn.js       cross-platform child spawn: resolve CLI path (which/where), empty temp cwd, stdin prompt, env scrub, timeout kill (process group on POSIX), never rejects
  src/providers/claude.js      CLI mode (claude auth status / claude -p) + API-key mode (api.anthropic.com)
  src/providers/gemini.js      CLI mode (gemini -p) + API-key mode (generativelanguage.googleapis.com)
  src/providers/openai.js      CLI mode (codex exec) + API-key mode (api.openai.com)
  src/providers/compatible.js  OpenAI-compatible endpoint (Ollama, LM Studio, OpenRouter…): base URL + optional key
  src/providers/catalog.json   static model catalogs for CLI modes (no list endpoint), with lastVerified date
  src/targets/index.js         TARGETS (what the prompt is FOR) + styleGuide(family)
  src/targets/claude.md        XML-tagged sections, explicit instructions, examples in tags, block-level tags only
  src/targets/gemini.md        headed sections, system-instruction framing, explicit output schema
  src/targets/gpt.md           markdown headers, role/developer framing, numbered requirements
  test/*.test.mjs              doc, queue, store, prompt, output, spawn (fake child), providers (fake fetch/spawn), shell (kit invariants), package (manifest sanity)
```

Targets: `fable-5.1`, `opus-5`, `sonnet-5`, `haiku-4.5` → `claude`; `gemini-pro`, `gemini-flash` → `gemini`; `gpt-5`, `gpt-5-mini` → `gpt`; plus `custom` (free text, family picked by the user). Default `fable-5.1`.

## Provider contract (`src/providers/*`)

Every provider module exports the same shape; `engine.js` and the panel never special-case a vendor.

```js
{
  id: 'claude', label: 'Claude', modes: ['cli', 'apiKey'],
  detect({ secrets, cfg })      -> { cli: { found, path, version, loggedIn, account, note }, apiKey: { stored } },
  signIn(mode, { vscode })      -> opens a VS Code terminal running the vendor login (cli) | showInputBox(password) -> secrets (apiKey),
  listModels(mode, { secrets, cfg }) -> [{ id, label, tier: 'fast'|'best'|'other' }]   // live from the API in apiKey mode; catalog.json in cli mode; user may type any id
  defaults(models)              -> { merge: <fast>, polish: <best> },
  complete({ mode, model, prompt, timeoutMs, secrets, cfg }) -> { text, usage: { input, output }, error }   // never rejects
}
```

| Provider | CLI mode | API-key mode |
|---|---|---|
| Claude | detect: `claude --version` + `claude auth status` (JSON). call: `claude -p --output-format json --tools none --setting-sources '' --strict-mcp-config --mcp-config '{"mcpServers":{}}' --exclude-dynamic-system-prompt-sections --model <m>`, prompt on stdin, empty temp cwd, `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` scrubbed so the subscription is billed, not a stray key. sign-in: terminal `claude auth login`. catalog: fable/opus/sonnet/haiku aliases. defaults sonnet/fable | `GET /v1/models` to list; `POST /v1/messages`; defaults newest sonnet / newest fable-or-opus by id |
| Gemini | detect: `gemini --version`; logged-in hint = `~/.gemini/oauth_creds.json` exists (verify exact path at implementation). call: `gemini -p - --output-format json -m <m>` (stdin; confirm stdin support, else argv). sign-in: terminal `gemini`. defaults flash/pro | `GET /v1beta/models?key=`; `POST …:generateContent`; defaults flash/pro |
| OpenAI | detect: `codex --version`; logged-in hint = `~/.codex/auth.json`. call: `codex exec --json -m <m> --skip-git-repo-check --sandbox read-only` stdin. sign-in: terminal `codex login`. defaults gpt-5-mini/gpt-5. **Untested on the mini (codex absent); README says so** | `GET /v1/models`; `POST /v1/responses`; defaults gpt-5-mini/gpt-5 |
| Compatible | — | settings `promptForge.compatible.baseUrl` (+ optional key in secrets); `GET /v1/models`; `POST /v1/chat/completions`; defaults = first two models |

`spawn.js` rules: resolve the binary once per detect (`which`/`where`, honouring `promptForge.cli.<provider>Path`); prepend `/opt/homebrew/bin:/usr/local/bin:~/.local/bin` on POSIX; scrub `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, `VSCODE_INSPECTOR_OPTIONS`; on win32 spawn the resolved `.cmd` through `cmd.exe /d /s /c` with flag-only argv (prompt never in argv); `detached` process group kill on timeout (POSIX) / `taskkill /T` (win32); resolve `{text, error}` — never reject; capture stderr for the error text.

Secrets: `context.secrets` keys `promptForge.apiKey.<provider>`. The runtime receives `secrets` via `hostApi` and only ever reports `{stored: bool}` to the webview. Keys never appear in settings, state, logs, or the sidecar. "Forget key" deletes.

## Engine selection (`src/engine/engine.js`)

- `resolve(cfg, detections)`: provider = `cfg.engine.provider` or, for `auto`, the first provider whose CLI is logged in, else the first with a stored key. mode = cli if logged in else apiKey. Models: `cfg.engine.mergeModel`/`polishModel`, `auto` → `provider.defaults(listModels())`.
- Header shows `Engine: Claude · max · merge sonnet · polish fable` and `Target: GPT-5`. Nothing signed in → the header shows "No engine — sign in" and Enter is disabled with the Engine section opened.
- Every call records `{provider, mode, model, role, ms, usage}` in the sidecar; the panel sums tokens per prompt ("this prompt: 11 calls · 42k in / 9k out"); a cost estimate appears only in apiKey mode from `src/providers/prices.json` labelled "estimate".

## Cold shell (`extension.js`)

- `log = createOutputChannel('Prompt Forge', {log:true})`; `readConfig()`; `mediaRoots(root)` (working copy + installed); `paint(runtime)` = rebuild HTML with `?v=${generation}-${Date.now()}` then `runtime.replay()`.
- `ensurePanel()`: `createWebviewPanel('promptForge.panel', 'Prompt Forge', ViewColumn.One, {enableScripts, retainContextWhenHidden:true, localResourceRoots})`; `onDidReceiveMessage → hot.current().handleMessage(m).catch(log.error)`.
- Commands: `promptForge.open`, `promptForge.newPrompt`, `promptForge.polish`, `promptForge.copy`, `promptForge.signIn`, `promptForge.setApiKey`, `promptForge.forgetApiKey`; `promptForge.reload` from the kit. Status bar `$(tools) Forge`.
- `createHotHost({ vscode, context, log, section:'promptForge', hostApi: () => ({ log, vscode, config: readConfig, getPanel, ensurePanel, globalState: context.globalState, secrets: context.secrets, extensionPath: context.extensionPath }), afterBoot: paint })`. No second `onDidChangeConfiguration` handler.
- `create(host)` touches only `host`; VS Code side effects live in `start()`/handlers (keeps the kit smoke invariants testable with a stub).

## Message protocol

Webview → extension: `ready` · `openPrompt{slug}` · `newPrompt{title}` · `deletePrompt{slug}` · `idea{text}` · `setTarget{target}` · `polish` · `copy` · `restore{snapshotId}` · `resolve{conflictId, keep}` · `retry{entryId}` · `openDoc` · `openLibrary` · `engine.detect` · `engine.signIn{provider, mode}` · `engine.setKey{provider}` · `engine.forgetKey{provider}` · `engine.select{provider, mode, mergeModel, polishModel}`.

Extension → webview: `state{data}` · `notice{level,text}` · `focus{target}`.

State adds: `engine: { providers:[{id,label,cli:{found,version,loggedIn,account},apiKey:{stored},models:[…]}], selected:{provider,mode,mergeModel,polishModel}, state:'idle'|'busy'|'error'|'none', op, queued, error, usage:{calls,input,output,estimate} }`.

Panel layout: prompt rail · header (title · Engine summary [click → Engine section] · Target select · Polish · Copy · status) · Engine section (provider cards: status line, Sign in / Set key / Forget, merge+polish model selects with a free-text option) · conflict strip with keep-new/keep-old chips · idea textarea (Enter submits, Shift+Enter newline, draft kept in `vscode.setState`) · history (Restore per snapshot, Retry per failed entry, usage footer).

## Engine prompts, sidecar, session rules (unchanged from v1, summarised)

- **Merge** (fast model): document is the source of truth (hand edits, headings, section order, untouched wording kept; canonical sections Goal / Context / Requirements / Constraints / Output format / Examples / Open questions, but the document's current sections in whatever style rule); `<already-merged>` (last N), `<open-conflicts>`, `<new-ideas>`, `<resolutions>`; rules: merge into the right section (never a loose bullet, never Notes/Misc), fold duplicates, **never resolve a contradiction silently** (existing stays, incoming reported in `conflicts` with stable ids), hand-resolved conflicts drop, resolutions applied exactly, no conflict section in `doc`, structure only, return the COMPLETE document.
- **Polish** (best model): `<style-guide family=…>` + `<document>` + `<open-conflicts>` (returned unchanged); change form not substance; keep sections the merge can extend; block-level tags only.
- **OUTPUT_CONTRACT**: one JSON object `{"doc","conflicts":[{id,section,existing,incoming}],"changes":[]}`, no fence. `parseEngineOutput` strips fences, tries shrinking `{…}` spans, coerces, strips any stray conflict section, merge-shrink guard (< 40% of input → error), never throws.
- **Sidecar** `<slug>.forge.json` v1: `title, target, entries[{id,ts,text,status,snapshotId,error}], snapshots[{id,ts,kind,entryIds,doc,conflicts,changes,target,call:{provider,mode,model,ms,usage}}], conflicts[], resolved[]`. The `.md` = body + fenced `<!-- forge:conflicts -->` block under `## Open conflicts`.
- **Session**: log the entry before the call; one call in flight, queued ideas/resolutions batch into one merge; settle 450 ms, read the live doc, `hand-edit` snapshot if it drifted; re-read after the call and re-run once if the doc changed mid-call; failures mark entries `failed` with Retry (text never lost; `pending` at load → `failed: interrupted`); `setTarget` queues polish; restore refused while busy; copy strips the conflict block and forge comments; `writeDoc` uses `WorkspaceEdit`+`save()` when open (after the echo window), `fs.writeFile` otherwise; `openBeside` prefers `vscode.openWith … cweijan.markdownViewer` in column Two when that extension exists.

## package.json essentials

`name` prompt-forge · `displayName` Prompt Forge · `publisher` trifactorscaling · `version` 0.1.0 · `license` MIT · `repository` github · `engines.vscode ^1.94.0` · `extensionKind ["workspace"]` · `categories ["AI","Other"]` · `keywords` · `activationEvents ["onStartupFinished"]` · `capabilities`: untrustedWorkspaces `limited` (restricted: `libraryPath`, `cli.*Path`, `compatible.baseUrl`), virtualWorkspaces `false`.

Configuration: `libraryPath` (`~/.prompt-forge/prompts`, machine-overridable) · `engine.provider` (enum auto/claude/gemini/openai/compatible, default auto) · `engine.mergeModel` / `engine.polishModel` (string, default `auto`) · `engine.timeoutSeconds` (240) · `engine.recentEntries` (12) · `cli.claudePath` / `cli.geminiPath` / `cli.codexPath` (machine) · `compatible.baseUrl` (machine) · `docEditor` (office/text) · `sourcePath` + `autoReload` (machine, from `settingsFor`, documented as developer settings).

## Ordered tasks

0. `mkdir /Users/tfs/prompt-forge && git init`; `.no-doe` with a one-line reason; LICENSE (MIT); copy this plan to `docs/design.md`; first commit. Save a project memory: Prompt Forge is public/provider-agnostic, lives outside tom, secrets in SecretStorage.
1. `package.json`, `.vscodeignore`, `README.md` skeleton, `media/forge.svg`; vendor `src/hot/` with an origin header.
2. Pure modules + tests (TDD): `doc.js`, `targets/` + 3 style guides, `queue.js`, `store.js`, `engine/prompt.js`, `engine/output.js`, `providers/spawn.js` (fake child), `providers/{claude,gemini,openai,compatible}.js` (fake fetch/spawn; catalog.json), `engine/engine.js` (resolution logic with fake detections). `node --test test/*.test.mjs` green.
3. `test/shell.test.mjs` (kit invariants: extension.js requires `./src/hot/hot`, never `./src/runtime`; `sourcePath`/`autoReload` machine-scoped; `create(fakeHost)` returns a disposable) + `test/package.test.mjs` (every command in `contributes` is registered; every setting read in `readConfig` exists).
4. `docio.js`, `session.js`, `view.js`, `runtime.js`; `media/panel.js`, `media/panel.css`; `extension.js`.
5. CI: `.github/workflows/ci.yml` (matrix ubuntu/windows/macos, `npm test`), `release.yml` (tag → `vsce package` → release asset; publish steps `if: secrets.VSCE_PAT`/`OVSX_PAT`).
6. `npx @vscode/vsce package` → install on the mini via `~/.vscode-server/cli/servers/Stable-*/server/bin/remote-cli/code --install-extension`; add Machine settings `promptForge.sourcePath`/`autoReload`; restart the extension host **in a window with no live Claude sessions**; run the verify checklist.
7. `gh repo create trifactorscalingllc/prompt-forge --public --source . --push`; confirm CI green; tag `v0.1.0`; confirm the release asset. Hand Evan the two-step publisher setup (create publisher `trifactorscaling` at marketplace.visualstudio.com/manage, PAT → repo secret `VSCE_PAT`; same for Open VSX → `OVSX_PAT`).

## Verification checklist

1. Fresh profile, no CLI on PATH, no keys → panel shows "No engine — sign in"; Enter disabled; Engine section lists all four providers with Install / Set key actions.
2. On the mini (Claude CLI logged in as Max): Engine auto-resolves to Claude · cli · sonnet/fable; header shows the email and plan.
3. New Prompt "test" → `~/.prompt-forge/prompts/test.md` + `test.forge.json`; `.md` opens beside in Office Viewer.
4. Enter an idea → `busy · merge · sonnet`; viewer re-renders in place; the idea sits inside a section; sidecar entry `pending` → `merged` with a `call` record; usage footer updates.
5. Hand-edit a line (unsaved), Enter a contradicting idea → conflict chip + `## Open conflicts` block; hand edit survives; keep-old clears it.
6. Three fast Enters → `queued 2`; one batch of three in the log.
7. Switch target to GPT-5 → `busy · polish · fable`; doc restyles with markdown headers; Copy → paste is clean.
8. Engine → Gemini (cli, signed in on the mini) → merges run through `gemini -p`; usage recorded with `provider: gemini`.
9. Set an OpenAI API key (input box, masked) → `{stored:true}` only in state; key absent from settings, logs, sidecar; models listed live from `/v1/models`; Forget key → gone from SecretStorage.
10. Kill the CLI path (`cli.claudePath: /nonexistent`) → `error` with Retry; text still in the sidecar; fix; Retry → merged.
11. Windows (Evan's laptop, remote to the mini and local): CLI resolution through `where`, a merge completes, temp dirs cleaned.
12. Edit `media/panel.css` → repaint without losing the draft; `Prompt Forge: Reload Prompt Forge Code` → `generation N+1`.
13. `npx @vscode/vsce package` produces a vsix with no `test/`, `.github/`, `.no-doe`; `npm test` passes on all three CI OSes.

## Risks

- **Vendor CLI contracts drift** (flags, JSON shape, login-state files). Mitigation: probe flags at detect time, catalog.json carries `lastVerified`, free-text model id always allowed, every call error surfaces stderr verbatim with Retry.
- **Codex CLI mode is untested on the mini.** API-key mode covers OpenAI users until a codex install verifies it; README labels it.
- **Subscription quota is invisible**; only per-call tokens are shown. Stated in README.
- **Vditor may escape inline XML** after a Claude-style polish; block-level-only rule + text-editor fallback.
- **Windows spawn** of `.cmd` shims and process-tree kill; covered by the CI matrix and checklist item 11.
- **Marketplace publishing is gated on Evan's PAT**; until then the GitHub Release vsix is the install path.
