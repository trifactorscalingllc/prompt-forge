# Changelog

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
