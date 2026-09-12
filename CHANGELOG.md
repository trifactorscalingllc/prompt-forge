# Changelog

## 0.4.1

- **A plug replaces the Project button.** Click it and the prompt connects to the folder this window already has open — no picker, no path to find. Once connected the plug **shows the project's name**, because a tooltip is not an answer to “what is this prompt wired to?”. Clicking a connected plug opens view / rebuild / disconnect. The picker still exists behind *Prompt Forge: Attach a Project Folder*, for a prompt about a repo this window does not have open.
- **Polish and Copy moved onto the Prompt panel**, next to Edit, as a hammer and a copy icon. They act on that document, so they belong on it rather than in the window header. Settings is now a gear.
- **Copy confirms on itself.** The button turns into a tick for a moment instead of raising a bar. Both glyphs sit in the DOM and a class picks one, so nothing is rebuilt from a string.
- **The character count is always at the foot of the Prompt panel**, and the notice bar moved there too — out of the header, under the thing it is about.
- Icons are inline SVG inheriting `currentColor`, so they follow the theme without the webview shipping a font.

## 0.4.0

- **Attach a project folder to a prompt.** The **+ Project** chip in the header opens a picker; the engine then gets a short description of that codebase with every merge and polish, and writes real names, paths and vocabulary instead of “your framework” and “the existing component”. The brief is built once, on attach, with the polish model, and reused after that.
- **Two scopes, deliberately different sizes.** `promptForge.projectRoots` is the umbrella the picker may **list** — names and paths only, never a file, and `scope: machine` so a workspace cannot nominate folders for the forge to enumerate. **Reading** is exactly the one project you attach. Umbrella reading is refused; [docs/project-context.md](docs/project-context.md) records the four reasons, because it will be proposed again.
- **The deny-list runs before the search, not after.** `.env*`, `*.pem`, `*.key`, `id_rsa*`, `credentials*`, `secrets*`, `.npmrc`, `.netrc`, every build and dependency directory, anything over 256 KB and anything that fails a UTF-8 sniff. A rule applied to results is a rule that has already read the file it meant to skip.
- **What it read is a list, not a promise.** **View** opens the exact brief being sent plus every file it came from. **Refresh** rebuilds it, **Detach** removes it, and `promptForge.projectContext: off` stops sending it without detaching.
- The context block tells the model to use the project’s real names *and* not to invent files the brief does not mention — anything an idea needs that the context does not cover goes to Open questions. Context is there to reduce assumptions, not to license new ones.
- Attaching works with no engine signed in: the folder is recorded and the brief builds on the next successful call.
- A brief is per prompt rather than shared between prompts on the same path, because it is hand-editable and a shared one would rewrite other prompts' context silently. `projectRoots` defaults to empty, because the picker already offers the open workspace.

## 0.3.6

- **The Prompts list collapses.** The chevron next to the heading shuts it to a 30px strip and gives the space to the work; the chevron brings it back. Also *Prompt Forge: Toggle the Prompts List* in the command palette, and a row in Settings → Layout. The choice is remembered (`promptForge.railCollapsed`).
- Collapsed takes width when the panels are side by side and height when they are stacked, so a narrow window gets a thin bar rather than a tall sliver.
- The list is hidden, not unmounted, so reopening it costs no rebuild. The command sends a *flip* rather than a value, so it cannot disagree with a panel that has been open a while.

## 0.3.5

- **Published to the VS Code Marketplace** as `trifactorscaling.prompt-forge-trifactor`, shown as *Prompt Forge for VS Code*.
- The id and the display name both had to move, and the Marketplace explains neither. It checks the extension `name` **globally**, not as a `publisher.name` pair, and it applies the same rule to `displayName` — so a name held by any other publisher, including by extensions that do not appear in Marketplace search, is unusable. `prompt-forge`, `promptforge` and `prompt-forge-vscode` were each rejected with the same message naming only the id, which is why this took four attempts to read correctly (microsoft/vsmarketplace#378, microsoft/vscode-vsce#671). A publisher-qualified id went through first try.
- `~/.prompt-forge/prompts` is unrelated to the Marketplace id and is unchanged. Existing prompt libraries are untouched.

## 0.3.4

- **The extension id is now `trifactorscaling.promptforge`** (was `prompt-forge`). The name it shows in VS Code is unchanged. The VS Code Marketplace enforces globally unique extension *names*, not unique `publisher.name` pairs, so an unrelated `drendog.prompt-forge` made the old id unpublishable under any publisher — 0.3.3 failed on exactly that. Only one line of code referred to the id (the *Open Settings* command's `@ext:` filter); the `~/.prompt-forge/prompts` library path is a different thing and is untouched.

## 0.3.3

- **First release to the VS Code Marketplace.** No change to the extension itself since 0.3.2. Every previous release *could not* have published: both marketplace steps in the release workflow were gated on `env.VSCE_PAT != ''` while defining `VSCE_PAT` in that same step's own `env:` block, and a step's `if` is evaluated before that block exists — so the gate read empty and was always false, secret or not. Moved to job level, where the gate and the publish see the same value.
- `docs/project-context.md` records the design for attaching a project folder to a prompt: umbrella scope for *finding* a project, exactly one project for *reading* it, and the reasons umbrella read access is refused.

## 0.3.2

- Dragging the divider before reloading the window failed with *"promptForge.layoutSplit is not a registered configuration"*. A setting only exists once the extension host has read the manifest, and the manifest is read at host start — while `src/` and `media/` hot-reload immediately, so the new divider was running against the old manifest. Settings that cannot be written yet are now kept for the session, with one line saying a reload will make them permanent.
- Layout defaults no longer depend on the running manifest: an older host returning nothing for a new setting used to overwrite the default with `undefined`.
## 0.3.1

- The window no longer scrolls as a whole. The prompt list on the left is fixed and full height; the Ideas log, the prompt document and the settings body each scroll inside their own panel. Scrolling a long prompt no longer carries the prompt list away with it.
- **Layout** section in Settings: side by side, always stacked, or side by side until the working area is narrower than a width you choose (default 620px, was a fixed 760px).
- The divider between Ideas and Prompt is draggable — double-click to even them up, arrow keys to nudge — and the share is remembered.
## 0.3.0

- **The formatted editor is built in.** The prompt document opens in Prompt Forge's own editor — the prompt formatted rather than raw markdown, with headings, lists, tables, quotes and code blocks — and no second extension has to be installed for it. Office Viewer is still supported for anyone who prefers it (`promptForge.docEditor: office`), and is now purely optional.
- Edit in place: click any block to edit that block's markdown, Cmd/Ctrl+Enter or click away to save, Esc to cancel. `+ Add a paragraph` writes straight into the document. **Source** switches to the raw markdown for the whole file.
- An edit is placed by its text, not blindly by line number: if the engine rewrote the document while you were typing, the block is found by what it said, and if that has become ambiguous the edit is refused rather than guessed. A merge landing mid-edit no longer yanks the box away — it waits.
- One markdown renderer now serves both the panel preview and the editor, with tables, blockquotes, task lists, nested lists, horizontal rules, links, strikethrough and fenced code with a language label.


## 0.2.4

- Window constraints: no sideways scrolling at any width. Below about 760px the Ideas and Prompt panels stack; below 640px the prompt list moves to a strip across the top. Settings folds its nav into a row when narrow.

## 0.2.3

- Claude CLI calls replace Claude Code's default system prompt with a short one: measured 585 input tokens for a one-word call instead of 9,142. Merges now cost a fraction of the quota they did.
- Panel: equal-height column bars; the hint and token lines sit above the idea box.

## 0.2.2

- New prompt opens the panels immediately; no naming step. The prompt names itself from the first idea, and the title can be clicked to rename.

## 0.2.1

- Settings is now a compact page in the VS Code style: a short nav (Engine, Models, Target, Document) and one-line rows.
- A new prompt opens two panels inside the window, Ideas and Prompt, each with a short description centred in it until content arrives. The prompt panel renders the document live; the pencil opens it in the editor for hand edits.
- A new prompt starts as its title only; sections appear as ideas land.

## 0.2.0

- New layout: the welcome text is centred until a prompt exists; then the window shows the Prompts rail and a chat-style log of the ideas you sent, with the composer at the bottom. The formatted document opens to the right, in the pencil editor when installed.
- Hover a sent idea to edit it (pencil). Editing re-merges the document so it follows the new wording; the old wording is kept in the idea's history.
- Retry and restore are hover actions on each idea; versions stay one click away.

## 0.1.3

- Prompts are named inside the panel, not in the VS Code input box.
- A Settings module (header button) with three parts: Engine (which account), Models (merge and polish, per engine), Target (what the prompt is for).
- One-line explanations for every choice: each role, each model, each target, and tooltips on the engine line.

## 0.1.2

- Hidden sections (engine, conflicts, compose) no longer render as empty boxes; the welcome text sits under the header.

## 0.1.1

- Windows: the CLI command line is quoted the way `cmd /s` expects, and the `.cmd` shim is preferred over the extensionless npm shim.
- Polish never changes the open-conflict list; only a merge can close a conflict.
- Switching engine provider resets the merge and polish models to `auto`.
- Settings changes (library path, engine, CLI paths, compatible URL) take effect without a reload.
- A library folder that cannot be opened is shown in the panel instead of a stuck "starting" state.
- Gemini CLI calls run in read-only plan mode; Claude API-key mode reports a cut-off reply clearly and sizes `max_tokens` by model.
- Binary lookups are cached between detections; the prompt list is re-read only when a sidecar changed.

## 0.1.0

- First release: idea box, merge engine, open conflicts, polish for a target model, copy.
- Providers: Claude (CLI login or API key), Gemini (CLI login or API key), OpenAI (Codex CLI login or API key), and any OpenAI-compatible endpoint.
