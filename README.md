# pi-optmem

Permanent memory for [omp](https://github.com/can1357/oh-my-pi), backed by [OptMem](https://github.com/VictorTaelin/OptMem).

- Every session starts with your memory already loaded into the agent's system prompt.
- The agent saves and searches memories on its own with the `memo_note`, `memo_recall`, `memo_zoom` and `memo_forget` tools.
- Old memories are compressed into summaries in the background, with a cheap model.
- All reads and writes go through OptMem's `memo` script, so any other agent that uses `~/.optmem/memory` shares the same memory.

## Install

You need `omp`, `git` and `curl`.

1. Install OptMem:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh
   ```

   OptMem's instructions tell you to paste a `## Memory` block into `AGENTS.md`. Skip that: this plugin does it for you.

2. Get this plugin:

   ```sh
   git clone https://github.com/luiz0451/pi-optmem.git ~/git/forgejo/pi-optmem
   ```

3. Link it into omp:

   ```sh
   omp plugin link ~/git/forgejo/pi-optmem
   ```

4. Create the memory (once per machine):

   ```sh
   ~/.optmem/memo init
   ```

5. Pick the model that compresses memories. A small, fast one is enough. Add to `~/.omp/agent/config.yml`:

   ```yaml
   modelRoles:
     optmem: anthropic/claude-haiku-5-5
   ```

   Without it, the `smol` role is used, then the session's model.

6. Start `omp`. The status line shows the memory icon and how many memories you have, `+N` for the ones saved this session, and `napping N` while compressions run.

## Use

You don't have to do anything: the agent records what is worth keeping and reads it back in later sessions.

To look at or change the memory by hand, type `/memo` in omp (Tab completes the commands and block ids):

| Command | What it does |
|---|---|
| `/memo recall bun` | Search every memory ever recorded (regex, case-insensitive) |
| `/memo note "prefers tabs"` | Save one memory yourself (one line, at most 280 bytes) |
| `/memo zoom 0-15` | Open a summary into the two halves it was built from |
| `/memo forget 0-15` | Drop a bad summary; it is rebuilt in the background |
| `/memo nap` | Show the compressions still waiting |
| `/memo config` | Show the memory's sizes; `/memo config WAKE_LINES=200` changes one |

## Update

```sh
git -C ~/git/forgejo/pi-optmem pull
```

Restart `omp` afterwards; the link always points at this folder.

## Troubleshooting

- **"no memory at ~/.optmem/memory"**: run step 4.
- **The status line shows `nap failed`**: the compression model returned an error (usually auth or rate limits). The failed compression stays queued and is retried at the next session start or the next saved memory. `/memo nap` shows what is waiting.
- **Plugin not loading**: `omp plugin list` should show `pi-optmem`; `omp plugin doctor --fix` repairs a broken link.

A compression has to fit in a fixed number of bytes. Models miscount bytes, so the plugin asks for less than the limit and tells the model how far over it went. After 4 tries it cuts the shortest answer at a word boundary, so one stubborn summary never blocks the rest.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `OPTMEM_MEMO` | `~/.optmem/memo` | Path to OptMem's `memo` script |
| `MEMORY_DIR` | `~/.optmem/memory` | Where the memory lives |

## Uninstall

```sh
omp plugin uninstall pi-optmem
```

The memory in `~/.optmem/memory` is left untouched.
