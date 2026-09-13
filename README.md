# Prompt Forge

Build one clear prompt from many rough ideas, inside VS Code.

You type ideas one at a time into a box. Every Enter sends the idea to an engine that **merges** it into a structured prompt document (Goal, Context, Requirements, Constraints, Output format, Examples, Open questions), never as a loose bullet at the end. Contradictions are **flagged as open conflicts** instead of being guessed away. When the document is ready, **Polish** rewrites it in the shape the model you are sending it to reads best, and **Copy** puts it on the clipboard — or **Send** puts it straight into Claude Code.

The document is a real markdown file that opens beside the panel. Hand-edit it whenever you like; the engine always reads the current text before merging.

## Why

Complicated prompts written in a chat box drift: you repeat yourself, contradict an earlier line, or leave something vague enough that the model fills the gap with an assumption. Prompt Forge keeps every idea, keeps the structure, and keeps the contradictions visible until you decide.

## Engines: it runs on your account

Prompt Forge has no model of its own and no server. It uses whatever you already have, in this order of preference:

| Provider | Subscription login (CLI) | API key |
|---|---|---|
| Claude | `claude` CLI, signed in with `claude auth login` | Anthropic API key |
| Gemini | `gemini` CLI, signed in with Google | Google AI Studio key |
| OpenAI | `codex` CLI, signed in with `codex login` | OpenAI API key |
| OpenAI-compatible | — | Any base URL (Ollama, LM Studio, OpenRouter, a company gateway), key optional |

**Sign-in rides on the vendor's own CLI.** No vendor lets a third-party extension log into a chat subscription directly, so Prompt Forge detects the CLI, reads its login state, and opens the vendor's login in a terminal when you click Sign in. API keys are stored in VS Code SecretStorage (your OS keychain), never in settings, logs or files.

Two models are chosen per provider: a fast one for every merge and the best one for Polish. `auto` picks sensible defaults from the models your account can reach; you can pick others or type any model id.

The **target model** (what the prompt is written for) is independent of the engine. Build a GPT-5 prompt on your Claude subscription, or the other way round.

**What you cannot see:** subscription quota. No vendor exposes it to third parties. The footer shows per-call token counts instead.

## Using it

1. Run **Prompt Forge: Open Prompt Forge** (or click `Forge` in the status bar).
2. Click the engine line at the top and sign in to one provider, or store a key.
3. **+ New**, name the prompt. The document opens beside the panel.
4. Type an idea, press Enter. Repeat. Shift+Enter inserts a newline. The paperclip, a paste or a drop attaches a file to the idea.
5. If a conflict strip appears, click **keep old** or **keep new**, or edit the document by hand. Your answer shows in the thread.
6. Pick the target model, click **Polish**, then **Copy** or **Send**.

From any editor, select code and press **Ctrl+Alt+Shift+I** (Cmd on macOS), or right-click → *Send Selection as an Idea*, to send it with its file and lines. With nothing selected the same key asks for an idea.

Every idea is written to disk before the engine is called, so nothing is lost if a call fails: failed ideas show a **Retry**. Every version of the document is kept; **restore** any of them from the history.

## How fast a merge is

Measured by replaying 33 merges from a real library through the `claude` CLI on a subscription:

| | Mean | Median |
|---|---|---|
| 0.12.3 defaults | 20.6 s | 18.3 s |
| Low merge effort (0.13 default) | 13.3 s | 12.8 s |

Low effort matched the merge that had been accepted as closely as the default did (line overlap 0.700 vs 0.704). On top of that, the engine process starts while you type — the CLI's boot is about six seconds of every cold call — and a merge returns only the sections it changed, so its output grows with the idea rather than with the prompt. The status line shows what the engine is doing while it works.

## Attached files

An idea can carry files. Images and PDFs go to the engine as content blocks where the provider accepts them, text files go inline, and anything else goes by name with a note saying why. A file that looks like a key or credentials is never read. The prompt refers to a file by its name, so when you **Copy**, the files are listed at the end with the idea each came from and its path, and the notification offers **Copy the files** so you can paste them beside the prompt. When you **Send** to Claude Code they go as `@`-mentions, which Claude Code opens itself.

## Send to Claude Code

**Send** (the terminal icon on the Prompt panel, or *Prompt Forge: Send This Prompt to Claude Code*) lists where the prompt can go:

1. where you sent it last, if that is still open
2. a terminal in this window running Claude
3. a recent Claude Code conversation in the project folder
4. a new Claude Code conversation (a terminal running `claude` if the Claude Code extension is not installed)
5. Claude on the SSH host of an attached remote project

The prompt lands in the input box and nothing is submitted: pressing Enter is yours. After more ideas, **Send update** carries only what changed to the same place. If that place is gone, the whole prompt goes to the new one.

## Variables

Write `{{client}}` (or any name) in an idea or the document. The slot stays in the document; fill it in the strip under the prompt, or when you copy. Copy, Send and a test run get the value, so one prompt serves every client, repo or audience it is written for.

## The document beside the panel

The document opens in Prompt Forge's own editor: the prompt **formatted**, not raw markdown, and editable in place. Click any heading, paragraph, list, table or code block to edit just that part; **Cmd/Ctrl+Enter** or clicking away saves, **Esc** cancels. **Source** in the toolbar switches to the raw markdown for the whole file.

Nothing to install — the editor ships inside the extension, and Prompt Forge has no extension dependencies at all. It follows the document live, so an idea you merge in the panel appears in the editor as it lands (and if a merge arrives while you are editing a block, your box stays open and the update waits).

Two alternatives are a setting away (`promptForge.docEditor`): `office` uses [Office Viewer](https://marketplace.visualstudio.com/items?itemName=cweijan.vscode-office)'s WYSIWYG editor if you happen to have it, and `text` always uses the plain text editor. Any `.md` file can be opened this way — right-click, *Reopen Editor With…*, *Prompt Forge* — but Prompt Forge never takes over markdown files it was not asked to open.

## Files

## Project context

A prompt written with no knowledge of the codebase it is for comes out general — "your framework", "the nav component". Attach a folder with the **+ Project** chip in the header and the engine gets a short, accurate description of that project with every merge and polish, so it uses real names, paths and vocabulary instead.

Two scopes, deliberately different sizes:

| | Scope | What it holds |
|---|---|---|
| **Finding** a project | `promptForge.projectRoots` — several folders | Names and paths only. Never file contents. |
| **Reading** a project | Exactly the one you attach | The brief, built once, reused every merge |

Umbrella *reading* is refused on purpose — it would re-create the ambiguity the feature removes, cannot be costed, and would put every `.env` on the machine inside the blast radius. [docs/project-context.md](docs/project-context.md) has the full reasoning.

Nothing is read until you attach a folder. `.env*`, keys, credentials, anything `.gitignore`d and every build directory are excluded *before* the search runs. The brief is capped at 40 lines, and **View** shows you the exact text being sent plus the list of files it came from. Set `promptForge.projectContext` to `off` to stop sending it without detaching.

**A project on another machine** — a Mac mini, a server — attaches from a local window without opening a remote one: *Prompt Forge: Attach a Project over SSH*, or *Over SSH…* in the picker. Hosts come from `~/.ssh/config`. The folder is listed first and the same deny-list runs on that listing on this machine, so only the files that survive it are read. SSH runs in batch mode: it needs a key or an agent, and never waits on a password prompt.

## The library on more than one machine

The library is a folder of plain text files, so pointing `promptForge.libraryPath` at a synced folder (iCloud, Dropbox, Syncthing) works with no further setup:

```json
"promptForge.libraryPath": "~/Library/Mobile Documents/com~apple~CloudDocs/prompt-forge"
```

Two things that used to break this are fixed. **No absolute path is stored**: an attached project is recorded relative to your home directory and an attached image by filename alone, both resolved against wherever the library actually is when it is read. And **old version bodies are pruned** (`promptForge.keepVersionBodies`, default 20) — a full copy of the document was kept for every merge, which is most of a prompt's size and the part that made syncing heavy. Older versions keep their record and their diff but not their text, and say so rather than restoring an empty document.

A sync service still cannot handle **two machines editing one prompt**: the sidecar is rewritten on every change, so it produces a conflicted copy and neither file is obviously right. **Git-backed sync** does handle it. Set `promptForge.sync.remote` to a private repository you own (*Prompt Forge: Set Up Library Sync*), with `git` installed and credentials that work without a prompt. The library commits here and pulls there, after a merge lands, every few minutes, and when the window regains focus. When both machines changed a prompt, their ideas and versions are joined and colliding ids renumbered; the document follows the side that changed last, and the other side's text is kept as a version you can restore. Two different prompts that happen to share a name are both kept.

Prompts live in `~/.prompt-forge/prompts/` (setting `promptForge.libraryPath`): one `<name>.md` you can edit, and one `<name>.forge.json` holding the ideas, every version of the document, open conflicts and per-call usage. Deleted prompts move to `.trash/` inside that folder.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `promptForge.libraryPath` | `~/.prompt-forge/prompts` | Where prompts live |
| `promptForge.engine.provider` | `auto` | `auto`, `claude`, `gemini`, `openai`, `compatible` |
| `promptForge.engine.mergeModel` | `auto` | Model for every Enter |
| `promptForge.engine.polishModel` | `auto` | Model for Polish and target changes |
| `promptForge.engine.mergeEffort` | `low` | How hard the model thinks on each merge: `low`, `medium`, `high`, `auto` |
| `promptForge.engine.polishEffort` | `auto` | The same for Polish, runs and project briefs |
| `promptForge.engine.mergeOutput` | `edits` | `edits` (changed sections only) or `document` |
| `promptForge.engine.prewarm` | `true` | Start the engine process while you type |
| `promptForge.sync.remote` | `""` | Git remote the library syncs with; empty is off |
| `promptForge.sync.intervalMinutes` | `5` | Background sync interval; `0` syncs only on events |
| `promptForge.engine.timeoutSeconds` | `240` | Hard limit per engine call |
| `promptForge.engine.recentEntries` | `12` | Already-merged ideas shown to the engine as context |
| `promptForge.cli.claudePath` / `geminiPath` / `codexPath` | `""` | Binary paths; empty searches PATH |
| `promptForge.compatible.baseUrl` | `""` | OpenAI-compatible base URL |
| `promptForge.layout` | `auto` | `auto` (stack when narrow), `columns`, or `rows` |
| `promptForge.layoutStackWidth` | `620` | Width at which `auto` stacks the panels; `0` never stacks |
| `promptForge.layoutSplit` | `52` | Share of the space given to Ideas, as a percentage |
| `promptForge.docEditor` | `forge` | `forge` (built in), `office` (Office Viewer), or `text` |

## Privacy

No telemetry. Prompts go only to the provider you chose, through its CLI or its API. Keys never leave SecretStorage. Nothing is sent anywhere else.

## Status of each engine mode

| Mode | Status |
|---|---|
| Claude CLI, Claude API key | Tested |
| Gemini API key | Tested against the API contract |
| Gemini CLI | Written to `gemini -p … -o json`; works when the CLI is signed in with Google or has `GEMINI_API_KEY` set |
| OpenAI API key | Tested against the API contract |
| OpenAI Codex CLI | Written to the documented `codex exec` contract; not yet exercised on a machine with Codex installed. Use the API-key mode if it misbehaves, and please open an issue |
| OpenAI-compatible | Tested against the API contract |

## Developing

Zero runtime dependencies, no extension dependencies, plain CommonJS, vanilla DOM in the webviews. The markdown renderer in [media/md.js](media/md.js) is shared by the panel preview and the document editor, and is exercised directly by the tests.

```bash
npm test                      # node --test, no VS Code needed
npx @vscode/vsce package --no-dependencies  # -> prompt-forge-trifactor-<version>.vsix
code --install-extension prompt-forge-trifactor-*.vsix
```

### Releasing

Bump `version` in `package.json`, commit, then push a matching tag. [`.github/workflows/release.yml`](.github/workflows/release.yml) runs the tests, packages the vsix, attaches it to a GitHub release, and publishes to the VS Code Marketplace and Open VSX — each of those two only when its token is present as a repository secret (`VSCE_PAT`, `OVSX_PAT`). Without them the tag still produces an installable GitHub release.

```bash
git tag v0.3.3 && git push origin v0.3.3
```

The extension is built on a cold/hot split: `extension.js` registers commands and the panel (cold); everything under `src/` and `media/` reloads without restarting the extension host. Set `promptForge.sourcePath` to your working copy and edits are picked up on save (`Prompt Forge: Reload Prompt Forge Code` forces one). Only `package.json` changes need a restart.

## License

MIT.
