# Changelog

## 0.11.0

Tier 3, and one correction.

- **The add-on copy now carries context.** A changed section is sent **whole** rather than as its new lines alone, so the additions read in place and the model can act on them without working out where the fragments belong — then *What changed since the version you have* lists exactly what is new, so context costs no precision. Unchanged sections are still left out; this is a follow-up, not the prompt again. (This reverses the answer given to that open question in 0.7.0; the finished spec decided otherwise.)
- **Export**: the prompt as markdown, as JSON carrying its ideas, versions and conflicts, or written into `.claude/commands/<slug>.md` so it becomes a `/slash` command in the open workspace. *Prompt Forge: Export This Prompt*.
- **Per-idea project search** (`promptForge.projectContext: brief+lookup`). Before each merge the attached project is searched for the words in your idea and at most three excerpts are attached, with paths and line numbers. A search, not an embedding: a bad match is visibly a bad match, and the excerpt block tells the engine these are search results that may be irrelevant and are never a requirement you made. Off by default — it costs a filesystem scan on every Enter.
- **Token budget** (`promptForge.tokenBudget`). The footer turns amber once a prompt passes it. Tokens rather than money on purpose: a CLI login draws on a plan rather than billing per token, and a confident wrong dollar figure is worse than no figure.

## 0.10.0

- **Paste a screenshot into an idea.** It is written beside the prompt in `<slug>.images/` and given to the merge engine by absolute path, with permission to open it — so “make it look like this” works. Deleting a prompt takes its screenshots to `.trash` with it.
- Only the path is ever recorded. A screenshot is hundreds of kilobytes and the sidecar is rewritten constantly, so the bytes go to disk once and nothing base64 rides along in the page, the panel state or the JSON. A test asserts the sidecar does not contain them.
- Attached images show as named chips you can click to open, on the idea being typed and on ideas already sent. They are named rather than previewed: a thumbnail would mean serving your library folder to the webview, and the name, size and a click that opens the real file answer the same question.
- **The versions list shows real diffs.** Each version has a ± count that expands what that step changed, and *vs now* compares any version against the document as it stands. The comparison is computed in the extension — fifty snapshot bodies must not be posted to the panel on every repaint.
- **Settings adapt at every width**: the section rail narrows before it wraps, wraps to a strip when narrow, and the body is capped for reading and centred rather than pinned beside the rail with a screen of nothing next to it.

### Not yet

Images reach the engine as a path. A CLI engine can open them; an API-key engine cannot, and will say so rather than pretending to have seen the picture. Sending images as content blocks per provider is not built.

## 0.9.2

- The Prompt panel's buttons are pinned right as a **group**, not by an auto margin landing on whichever sibling happens to be first. `:first-of-type` counted every `<button>`, so the model picker claimed it and the icons sat bunched against the model name; a hidden Run pill or add-on button could shift them again. A wrapper survives another button being added.

## 0.9.1

- **The connect plug now says it is working.** Building a project's brief is an engine call taking seconds, and the plug showed nothing for all of them — so it looked broken, got pressed again, and every press started another attach. It now pulses and reads *reading…* the instant you click it, before the round trip to the extension, and a second attach for the same prompt is refused while one is running.
- The plug lost its grey box, matching the gear beside it.

## 0.9.0

- **Run the prompt.** The ▶ button on the Prompt panel sends the finished prompt to a model and shows the answer in place of the document; the **Run** pill switches back. The forge built prompts and had never once shown you one working.
- What answered is stated on the result, not implied — provider, model, tokens, seconds. If the engine that answered is not the family the prompt is styled for (a Claude login answering a prompt written for GPT-5), that is called out in amber: still a useful smoke test, but not a test of the styling. The last five runs are kept; **open as a document** puts one in an editor tab.
- **Templates.** *Prompt Forge: New Prompt from a Template*, or the link in the empty Ideas panel: code review, landing page copy, research brief, bug to fix, extract structured data.
- A template is **real content with its unknowns in `[brackets]`**, never a stack of empty headings — empty headings fight the way this document is built and would ship a lint warning with every new prompt. The brackets close a loop instead: the copy-time check now catches any bracketed text that is not a markdown link, so whatever you did not fill in is flagged as the prompt leaves. A test asserts every template raises that warning and nothing else.
- `+ New` is still one click. Putting a picker in front of every new prompt would tax all of them to serve the first.

## 0.8.0

Tier 1: see what the engine did, take it back, and get a last look before it leaves.

- **Every merged idea can show what it actually changed.** The ± button under an idea opens the added and removed lines, in green and red, section by section. `changes` was always the engine's own account of itself; this is the text. The diff is computed once when the merge lands and stored on the snapshot, so showing it costs nothing.
- **Undo a merge.** ↶ puts the document back to how it was *before* that idea, next to the existing ⟲ which puts it back to just *after*. Both were reachable only by opening the versions list before.
- **A last look at copy time.** Copying reports open conflicts, sections that are present but empty, and placeholders (`TBD`, `TODO`, `???`, `[your audience here]`) still sitting in the text. It never blocks the copy — the text is on the clipboard first, and you usually know why a section is empty.
- The lint only says things that are textually true. A “short prompt” check was written and then deleted: it fired on prompts that were simply finished, and a rule whose own message has to end “fine if it is meant to be” is not a finding.

## 0.7.0

- **Add-on copy.** Copy a prompt, paste it somewhere, then keep adding ideas to the same prompt — a second copy button appears carrying **only what changed since your last copy**, ready to paste as the next message in the conversation you already started. Prompts on one topic stay one prompt instead of becoming five.
- It appears only once you have copied at least once **and** something has been merged since; it shows how many lines are new; using it advances the mark, so it goes away until there is something new again. That round repeats without limit.
- The addendum is **computed from the two documents, not written by the engine**. No extra call, nothing reworded behind your back, and it can be explained line by line. Unchanged sections are left out, a section that gained lines is named so the follow-up lands in the right place, and lines you deleted are listed under *No longer applies* — a follow-up that only ever adds would quietly be wrong.
- Reordering is not a change. Headings are matched across a restyle, so `<requirements>` and `## Requirements` are the same section. If a polish moved most of the document, it says so rather than handing you the whole prompt again dressed as an addendum.

## 0.6.0

- **Prompt suggestions.** Where a section is empty or thin, a soft-yellow note appears in the prompt saying what belongs there, drawn from what the document and your ideas already establish — the empty *Output format* and *Constraints* headings that sit there for a reason and never get filled. Dismiss one with × and it stays gone for that prompt.
- **They cannot be copied, because they were never in the prompt.** The engine returns them as a separate field, they are stored in the sidecar, and they are injected into the rendered panel. There is no strip-on-copy step to get wrong: the `.md` has never held one, so the document on disk, every snapshot, and the clipboard are all clean by construction. Three assertions cover exactly that.
- They cost no extra call — the merge is already reading the whole document, so it returns the advice alongside the merged text. At most three, never padded to a quota, and phrased as advice to you rather than text to paste in. Off with `promptForge.suggestions` or the Settings → Project row.
- Fixed: Polish, Copy and Edit drifted left against the title on the Prompt panel. `.col-head .iconbtn:first-of-type` never matched, because the target button is a `<button>` too and took `:first-of-type` for itself.

## 0.5.1

- Restores eight tests in `test/prompt.test.mjs` that 0.5.0 destroyed: the new cases were written into a file that already existed rather than appended to it. The suite is 181, and nothing about 0.5.0's three fixes changes — the older cases pass against them unaltered, which is the useful part of finding it.

## 0.5.0

Three faults in the engine prompts, found by reading them against each other rather than by a bug report.

- **Polish renames the sections; the next merge was never told.** The Claude guide turns *Goal* into `<goal>`, and the GPT guide turns it into `# Task` — so a polished document has headings the merge prompt's “canonical set” does not contain, and polish→merge→polish is the normal loop. The mapping is now written down once (`targets.SECTION_NAMES`), handed to every merge, and **a test asserts each name actually appears in that family's style guide**, so editing a guide without the table fails the build instead of quietly producing duplicate sections.
- **Merge had no rule against inventing.** Polish has always carried *“add nothing the document does not say”*; merge carried only *“prefer a concrete statement over a vague one”*, which under pressure manufactures specifics — most visibly in *Examples*, a section nobody dictates. Merge now has rule 10: every line must come from an idea, a resolution, or text already there; no inventing names, numbers or file paths; a section with no material is left out rather than filled. It disclaims rule 9 by name, or the two read as contradictory.
- **“Already merged” was a silent window of 12.** The engine was shown the last twelve merged ideas and told *“do not add them again”*, with nothing to say the other twenty-eight existed — so the duplicate-folding rule could not fire on anything older. The block now declares `showing="12" of="40"` and points at the document as the complete record.

Also: the vendor's mark sits next to each model in the target list, the word “for” is gone (“Prompt … Claude Fable 5.1” reads without it), and the brief inside the idea box is smaller and fainter — it is guidance, and should never compete with what you are typing.

## 0.4.3

- **The target moved out of the window header and onto the Prompt panel**, where it reads as a sentence: *Prompt — for **Claude Fable 5.1***. The word “for” is a divider, not part of the control; the model name is the button.
- It opens a **floating list rather than a `<select>`**, so every option can carry its one-line description of what that model wants from a prompt. A native select shows the label and nothing else, which is the one thing worth knowing when you are choosing between nine of them.
- The list closes on Escape, on a click outside, and on a resize — a fixed-position popup that survives a resize ends up detached from the button it belongs to. It is `position: fixed` so the panel's own scrolling cannot clip it.

## 0.4.2

- **A prompt is named by the engine, in at most five words.** It had been the first eight words of whatever you typed, which is how a prompt ended up called “Oh idea”. The merge that first fills an empty prompt now also returns a title, and is told to name the subject rather than the act of asking. Five words is enforced in code as well as asked for: an instruction about length is a request, a slice is a guarantee.
- The hint above the idea box is gone; the box's own placeholder now carries all of it — Enter to merge, Shift+Enter for a line, hover a sent idea to edit.
- The plug moved to the right of Target. The gear lost its box and is now an actual gear; the old one was eight lines radiating from a circle, which at 14px is a sun.
- **A collapsed Prompts rail keeps its `+`.** Only the word collapses. A strip with nothing on it but a chevron gives you no way to start a prompt.

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
