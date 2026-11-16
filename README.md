# omp-optmem

[OptMem](https://github.com/VictorTaelin/OptMem) permanent memory for [omp](https://github.com/can1357/oh-my-pi). For Pi, see [pi-optmem](https://github.com/luiz0451/pi-optmem).

The agent starts every session with its memory loaded, saves and searches it with the `memo_*` tools, and old memories are compressed in the background.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/VictorTaelin/OptMem/main/install.sh | sh
~/.optmem/memo init
git clone https://github.com/luiz0451/omp-optmem.git ~/omp-optmem
omp plugin link ~/omp-optmem
```

Skip the `## Memory` block OptMem asks you to add to `AGENTS.md`; the plugin does it.

Compression model (optional, `~/.omp/agent/config.yml`; default is `smol`, then the session model):

```yaml
modelRoles:
  optmem: anthropic/claude-haiku-5-5
```

## Use

Nothing to do: the agent handles it. By hand, `/memo` in omp:

```
/memo recall <regex>     search all memories
/memo note "<line>"      save one (max 280 bytes)
/memo zoom 0-15          open a summary
/memo forget 0-15        rebuild a bad summary
/memo nap                pending compressions
```

## Update / remove

```sh
git -C ~/omp-optmem pull                 # then restart omp
omp plugin uninstall omp-optmem          # memory stays in ~/.optmem
```

`OPTMEM_MEMO` and `MEMORY_DIR` override the script and memory paths.

## License

MIT
