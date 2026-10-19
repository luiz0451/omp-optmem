# omptmem

[OptMem](https://github.com/VictorTaelin/OptMem) permanent memory, built into [omp](https://github.com/can1357/oh-my-pi).

OptMem's `memo` script stays the single source of truth. Every read and write goes through it, so agents in other harnesses (Claude Code, Codex, pi) that use the same `~/.optmem/memory` share one memory with omp.

## What it changes compared with the pasted `## Memory` block

| OptMem prompt rule | omptmem |
|---|---|
| "Run `memo wake` before any other tool call" | Wake runs automatically at session start, after `/new`/resume, and after compaction. All parts are read at one snapshot `T` and added to the system prompt. Startup takes no tool call. |
| `memo note` / `recall` / `zoom` / `forget` through bash | Native tools: `memo_note`, `memo_recall`, `memo_zoom`, `memo_forget`, each with a typed schema and an approval tier (read or write). Compact one-line TUI rendering; expand for full output. |
| "If `note` asks a compression: do it before your next action" | Compressions never reach the main agent. A background worker answers every pending `memo nap` with the `optmem` model role, falling back to `smol`, then the session model. When wake is blocked because it needs a summary that isn't built yet, the worker builds it before the first prompt. |
| — | On compaction, the summarizer is told that OptMem holds the durable facts and which memories this session recorded, so the summary doesn't repeat them. Memory is re-read into the system prompt afterwards. |
| "A subagent must never run `memo`" | Subagents get no `memo_*` tools. Their `bash`/`eval` calls that invoke `memo` are blocked. |
| — | Status line: `mem <count>`, plus `napping <n>` while compressing and `nap failed` on error (details in a notification). |
| — | `/memo <command> [args]` runs any memo command from the prompt, e.g. `/memo recall bun`, `/memo config WAKE_LINES=200`. |

## Install

1. Install OptMem itself (it provides `~/.optmem/memo`):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh
   ```

   Do **not** paste its `## Memory` block into `AGENTS.md`; this plugin replaces it.

2. Load the extension, using one of these:

   ```sh
   omp plugin link ~/git/github/omptmem      # installed plugin (package.json omp.extensions)
   omp -e ~/git/github/omptmem/src/index.ts  # one session
   ```

   or in `~/.omp/agent/config.yml`:

   ```yaml
   extensions:
     - ~/git/github/omptmem
   ```

## Configuration

Compression model: set a custom `optmem` role in `~/.omp/agent/config.yml` (or in `/model` → Roles):

```yaml
modelRoles:
  optmem: anthropic/claude-haiku-5-5
```

Unset or unavailable → `smol` → the active session model. Compressions run with reasoning disabled and temperature 0. Each request is a few hundred tokens, with no conversation context. A reply over the byte limit is retried once.

| Env var | Default | Meaning |
|---|---|---|
| `OPTMEM_MEMO` | `~/.optmem/memo` | Path to the memo script |
| `MEMORY_DIR` | `~/.optmem/memory` | OptMem's own variable, passed through to memo |

You can tune wake size with `/memo config WAKE_LINES=<n>`. To disable the plugin without uninstalling it, add `extension-module:index` (or the linked package name) under `disabledExtensions`.

## Develop

```sh
bun install
bun run check   # tsc --noEmit
```
