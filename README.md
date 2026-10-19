# omptmem

[OptMem](https://github.com/VictorTaelin/OptMem) permanent memory for [omp](https://github.com/can1357/oh-my-pi). Memory is loaded into the system prompt at session start, the agent gets native `memo_*` tools, and compressions run in the background. Every read and write goes through OptMem's `memo` script, so other agents using `~/.optmem/memory` share the same memory.

## Install

1. Install OptMem (do not paste its `## Memory` block into `AGENTS.md`; this plugin replaces it):

   ```sh
   curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh
   ```

2. Link the plugin:

   ```sh
   omp plugin link /path/to/omptmem
   ```

## Usage

The agent records and searches memory on its own with `memo_note`, `memo_recall`, `memo_zoom` and `memo_forget`. The status line shows the memory count.

From the prompt, `/memo <command> [args]` runs any memo command, with autocomplete:

```
/memo recall bun
/memo zoom 0-15
/memo config WAKE_LINES=200
```

Compressions use the `optmem` model role, falling back to `smol`, then the session model:

```yaml
# ~/.omp/agent/config.yml
modelRoles:
  optmem: anthropic/claude-haiku-5-5
```

`OPTMEM_MEMO` (default `~/.optmem/memo`) and `MEMORY_DIR` (default `~/.optmem/memory`) override the script and memory paths.
