# Prompt Forge

Build one clear prompt from many rough ideas, inside VS Code.

You type ideas one at a time into a box. Every Enter sends the idea to an engine that **merges** it into a structured prompt document (Goal, Context, Requirements, Constraints, Output format, Examples, Open questions), never as a loose bullet at the end. Contradictions are **flagged as open conflicts** instead of being guessed away. When the document is ready, **Polish** rewrites it in the shape the model you are sending it to reads best, and **Copy** puts it on the clipboard.

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
4. Type an idea, press Enter. Repeat. Shift+Enter inserts a newline.
5. If a conflict strip appears, click **keep old** or **keep new**, or edit the document by hand.
6. Pick the target model, click **Polish**, then **Copy**.

Every idea is written to disk before the engine is called, so nothing is lost if a call fails: failed ideas show a **Retry**. Every version of the document is kept; **restore** any of them from the history.

## The document beside the panel

If the [Office Viewer](https://marketplace.visualstudio.com/items?itemName=cweijan.vscode-office) extension is installed, the document opens in its WYSIWYG markdown editor and updates in place. Otherwise it opens in the normal text editor. Set `promptForge.docEditor` to `text` to always use the text editor.

## Files

Prompts live in `~/.prompt-forge/prompts/` (setting `promptForge.libraryPath`): one `<name>.md` you can edit, and one `<name>.forge.json` holding the ideas, every version of the document, open conflicts and per-call usage. Deleted prompts move to `.trash/` inside that folder.

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `promptForge.libraryPath` | `~/.prompt-forge/prompts` | Where prompts live |
| `promptForge.engine.provider` | `auto` | `auto`, `claude`, `gemini`, `openai`, `compatible` |
| `promptForge.engine.mergeModel` | `auto` | Model for every Enter |
| `promptForge.engine.polishModel` | `auto` | Model for Polish and target changes |
| `promptForge.engine.timeoutSeconds` | `240` | Hard limit per engine call |
| `promptForge.engine.recentEntries` | `12` | Already-merged ideas shown to the engine as context |
| `promptForge.cli.claudePath` / `geminiPath` / `codexPath` | `""` | Binary paths; empty searches PATH |
| `promptForge.compatible.baseUrl` | `""` | OpenAI-compatible base URL |
| `promptForge.docEditor` | `office` | `office` or `text` |

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

Zero runtime dependencies, plain CommonJS, vanilla DOM in the webview.

```bash
npm test                      # node --test, no VS Code needed
npx @vscode/vsce package --no-dependencies  # -> prompt-forge-<version>.vsix
code --install-extension prompt-forge-*.vsix
```

The extension is built on a cold/hot split: `extension.js` registers commands and the panel (cold); everything under `src/` and `media/` reloads without restarting the extension host. Set `promptForge.sourcePath` to your working copy and edits are picked up on save (`Prompt Forge: Reload Prompt Forge Code` forces one). Only `package.json` changes need a restart.

## License

MIT.
