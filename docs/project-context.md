# Project context, design

Status: **phase 1 is built** (0.4.0) — settings, picker, sidecar, brief builder, merge and polish wiring, the chip and the Settings section. Phases 2–4 (staleness refresh, per-idea lookup, multi-project citations) are still design.

## Problem

A prompt written with no knowledge of the codebase it is for comes out general. The merge engine writes "your framework", "the nav component", "the existing auth flow", because those are the only honest things it can say. The person then spends the first two exchanges of the real conversation explaining what the model could have been told once.

The fix is to let a prompt name the project it belongs to, and to give the engine a small, accurate description of that project on every merge.

## The scope split

The instinct to point the forge at everything is right about ergonomics and wrong about reach. Two different things are being asked for, and they get two different scopes:

| Concern | Scope | What it holds |
|---|---|---|
| **Discovery** — "don't make me hunt for a path" | Umbrella: several roots, e.g. `~`, `~/work` | Project **names and paths only**. Never file contents. |
| **Reading** — "know this codebase" | Exactly one project (occasionally a named few) | The brief, and later the per-idea excerpts |

Umbrella *reading* is refused, and it is worth writing down why, because it will be proposed again:

- It re-creates the problem. "The nav dropdown" across forty repos is more ambiguous than it was with no context at all.
- It cannot be costed. One repo's brief is a fixed ~600 tokens per merge. Forty repos is either one useless line each or a context window.
- The blast radius is the whole home directory: `.env` files, tokens, client data, `~/.claude`. A feature whose job is to read files and send them to a model must have a scope a person can hold in their head.
- It cannot be refreshed honestly. A brief pinned to one repo's HEAD can say "this is stale". An umbrella brief is stale the moment anything anywhere changes.

Where prompts themselves live does not change: `~/.prompt-forge/prompts/`, user-level, independent of any project. That was already right.

## Data model

### Settings

| Setting | Default | Meaning |
|---|---|---|
| `promptForge.projectRoots` | `[]` | Folders the forge may **list**. Immediate children that look like projects become the picker's contents. Empty means the picker offers the open workspace and Browse only. |
| `promptForge.projectContext` | `brief` | `off`, `brief` (a cached description on every merge), `brief+lookup` (also attach excerpts per idea) |
| `promptForge.projectMaxFiles` | `400` | Hard cap on files considered when building a brief |
| `promptForge.projectMaxBytes` | `2000000` | Hard cap on bytes read when building a brief |
| `promptForge.projectDefault` | `workspace` | What a new prompt attaches: `workspace` (the folder VS Code has open), `none`, or a path |

`projectRoots` is `scope: machine`, like the CLI paths: a workspace must not be able to nominate folders for the forge to enumerate.

### Sidecar

Per prompt, in `<slug>.forge.json`:

```jsonc
{
  "projects": [
    {
      "id": "p1",
      "label": "web",                       // short, used in citations
      "path": "/Users/tfs/acme-web",
      "brief": "…40 lines of markdown…",
      "builtAt": 1757600000000,
      "head": "a1b2c3d",                    // git HEAD when built, null if not a repo
      "files": ["README.md", "package.json", "app/layout.tsx", "…"],
      "call": { "model": "…", "in": 18234, "out": 612 }
    }
  ]
}
```

One entry is the normal case. Two or three are allowed for a prompt that genuinely spans repos (a frontend and its API), each with a label, so a citation is never ambiguous. This is an allow-list, written by the user, one path at a time.

`files` is kept deliberately: the answer to "what did you read?" must be a list, not a promise.

### On disk

Nothing is copied into the library. The brief is text in the sidecar; the project stays where it is and is only ever read.

## Building the brief

One pass, on attach, with the **polish** model (the good one) — it happens rarely and its output is reused on every merge.

**What it reads**, in priority order, stopping at the caps:

1. `README*`, `CONTRIBUTING*`, `docs/*.md` (first 2 levels)
2. The manifest: `package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml`, `Gemfile`, `*.csproj`
3. `AGENTS.md`, `CLAUDE.md`, `.cursorrules` — a project that already describes itself to an AI has done this work
4. The directory tree to depth 3, names only
5. Entry points named by the manifest, first ~100 lines each
6. `tsconfig.json`, `.eslintrc*`, `ruff.toml`, CI workflow names — convention signals

**What it never reads**, regardless of the caps, and this list is enforced before any glob is expanded:

- Anything `.gitignore`d
- `.env*`, `*.pem`, `*.key`, `id_rsa*`, `*.p12`, `credentials*`, `secrets*`, `.npmrc`, `.netrc`
- `.git/`, `node_modules/`, `venv/`, `dist/`, `build/`, `.next/`, `target/`
- Anything over 256 KB, and anything that fails a UTF-8 sniff

**What it writes** — a fixed shape, so the merge prompt can rely on it:

```markdown
## Project: web  (/Users/tfs/acme-web)
Stack: Next.js 15 app router, TypeScript, Tailwind, Supabase
Purpose: marketing site and booking flow for …
Entry points: app/layout.tsx, app/(marketing)/page.tsx, lib/db.ts
Conventions: server components by default; …
Vocabulary: "offer" = a pricing tier; "consult" = a booked call
Do not assume: there is no test runner configured; …
```

Budget: ~40 lines, hard-capped at 800 tokens. If it will not fit, the model is told to cut *Vocabulary* and *Conventions* last — those are the parts that stop the generalizing.

**Staleness.** `head` is recorded. When the panel notices `git rev-parse HEAD` has moved, the project chip shows a dot and the tooltip offers *Refresh*. Never automatic: a silent rebuild is a surprise API call.

## How it reaches the engine

**Merge.** The brief is prepended as a labelled block, before the ideas and the current document, with one instruction:

> The person is writing this prompt for the project below. Use its real names, paths and stack instead of general phrases. Do not invent files or APIs that the brief does not mention; if an idea needs something the brief does not cover, say so in Open questions rather than guessing.

That last clause matters. Context should reduce assumptions, not license new ones.

**Polish.** Same block, plus permission to cite paths in the finished prompt.

**Cost.** Fixed and visible. The footer already counts tokens per call; the brief adds a constant per merge, and the settings row states it.

## Per-idea lookup (phase 2)

`brief+lookup` only. Before a merge, take the nouns from the idea, run a ripgrep-style scan of the attached project, and attach at most three excerpts of at most 40 lines each, with their paths.

- Deterministic and explainable: it is a search, not an embedding. The panel shows which files were attached under the merged idea.
- Skipped silently when nothing scores well enough. A bad excerpt is worse than none.
- It costs latency on every Enter, which is the whole reason it is opt-in and off by default.

## UI

**The header.** A project chip next to the target selector: `web ▾` when attached, `+ Project` when not. Clicking opens the picker. A stale project shows a dot.

**The picker.** A quick pick: the open workspace first, then projects discovered under `projectRoots`, then *Browse…*, then *Detach*. Discovery is names and paths — it never opens a file to build this list.

**Settings.** A `Project` section, mirroring Layout and Document:

- Project — attach / detach, and the label
- Context — off / brief / brief + lookup, each with its one-line cost
- Roots — the folders the picker lists, with *Add folder*
- Brief — *View* (opens it as a document), *Refresh*, and "read 38 files, 612 tokens, built 2 days ago"

The brief being viewable and editable is a requirement, not a nicety: it is text about the user's code that gets sent to a model on every merge, so it must be readable in one click and correctable by hand.

## Failure modes

| Case | Behaviour |
|---|---|
| Project folder moved or deleted | Chip turns red, merges continue without the brief, one notice |
| Not a git repo | Fine. `head` is null and staleness is time-based instead (offer a refresh after 14 days) |
| Brief build fails or times out | The prompt keeps working with no context; the error is on the chip, with *Retry* |
| Repo is huge | The caps bite, `files` shows what was reached, and the brief says which parts of the tree it did not see |
| No engine signed in | Attaching is allowed; the brief builds on the next successful call |
| Same project on two prompts | Each prompt holds its own brief. Simpler than a shared cache, and a stale copy in one prompt cannot surprise another |

## Privacy

Off until a folder is attached. Attaching names one folder, and only that folder is read. The file list and the brief are both visible. Content goes to the provider already chosen for the engine and nowhere else, and the deny-list above is applied before any glob is expanded, not after. No telemetry, unchanged.

## Phases

1. **Attach and brief.** Settings, picker, sidecar fields, brief builder, merge and polish wiring, the chip, the settings section. This is the 90% — it is what stops the generalizing.
2. **Staleness and refresh.** HEAD tracking, the dot, manual refresh.
3. **Per-idea lookup.** Opt-in retrieval, shown per merged idea.
4. **Multi-project.** Two or three labelled projects on one prompt, with labelled citations.

## Decided

**A brief is per prompt, not shared between prompts on the same path.** Isolation was the weaker argument. The deciding one is that the brief is *hand-editable*: if briefs were shared, correcting one by hand would silently rewrite the context of every other prompt pointed at that folder — action at a distance on text that is sent to a model on every merge. A rebuild is one call; a surprise edit is a bad prompt nobody can trace. The saving is available without the coupling: attaching a folder another prompt already describes can offer to *copy* that brief, once, rather than link to it. (The copy offer is not built yet.)

**`projectRoots` stays empty by default.** The cost is nearly nil, because the picker already offers the folder the window has open — which is the right project the large majority of the time — and Browse. A default that enumerates a home directory is precisely what this design exists to avoid. The list should fill by consent: after someone Browses to a folder, offer once to add its parent as a root. (Not built yet; today the picker links to the setting.)
