# Branches

`main` is the trunk; `deploy` is what tabcomputer.com runs (pushed from main,
see AGENTS.md and docs/RELEASES.md). Work branches are `unix/<topic>`, and a
release's merge branch is `coord/build-<N>`; both are merged into main and can
be deleted afterwards.

## Archived work (`archive/*`)

Work that is not merged as these commits, kept on origin so anyone can pick it
up. Tidied on 2026-11-02: every feature below except the WIP and design rows
reached main in another form (a "refreshed" or "-v2" branch, or a rewrite), so
these are for reference, not for merging as they are.

    git fetch origin 'refs/heads/archive/*:refs/remotes/origin/archive/*'
    git log --oneline origin/main..origin/archive/<name>    # what it has that main doesn't
    git switch -c unix/<topic> origin/archive/<name>        # to work on it

| Branch | What it holds | Status |
|---|---|---|
| `archive/unix/kernel`, `archive/unix/x86-engine` | Blink patch 0055: syslog(2) to the kernel log, `dmesg -S` | in main (Build 979) |
| `archive/unix/perf-kernel-wip` | prompt orphan reaping, decaying load averages, real fd targets; `kill $$` | in main |
| `archive/unix/perf-blink-fin`, `archive/unix/perf-blink-direct-wip` | Blink direct kernel channels in their own SharedArrayBuffers; fork shares only its own file maps | in main (89bb1483, renumbered patches) |
| `archive/unix/perf-blink-wip-direct4` | WIP: direct channels 0130-0132, hosted fork children 0133, engine rebuilds | WIP, never validated (an x86-engine test hung); main took the finished version (89bb1483) |
| `archive/unix/native-claude-startup` | native claude without self-install, updater or marketplace clone at start (#40) | in main; plain `claude` runs `--vm` since then |
| `archive/unix/tab-batch-verified` | a batch of tab fixes: net.BlockList, symlink chains (#65), npm lockfiles, storage-lost, cc | in main (their tests are there) |
| `archive/unix/tab-crypto-random` | randomBytes of any size (#46) | in main (c8d6afdc) |
| `archive/unix/tab-getaddrinfo-family` | getaddrinfo address-family tests | archived 2026-10-11 |
| `archive/unix/tab-git-clone-size` | large clones go to the full git (#43) | in main (87e0cf85) |
| `archive/unix/tab-grep-wrappers` | `claude --native` Grep/Glob without re-execs | superseded by `--vm` Grep/Glob (Build 994) |
| `archive/unix/tab-hotswap-commands` | hotswap bundles keep `import.meta.url` | in main (46aeaea0) |
| `archive/unix/tab-net-blocklist` | net.BlockList, net.SocketAddress | in main |
| `archive/unix/tab-node-parseargs` | util.parseArgs as node's | in main (the -v2 branch) |
| `archive/unix/tab-node-stdin-blocking` | blocking stdin reads in the worker (#66) | in main (Build 982) |
| `archive/unix/tab-rg-binary`, `archive/unix/tab-rg-version` | rg binary-stream and version tests (#57) | in main |
| `archive/unix/tab-symlink-chain` | symlink chains followed hop by hop (#65) | in main (1822aad0) |
| `archive/unix/tab-top-batch` | `top -b` test fixes | archived 2026-10-11 |
| `archive/unix/tab-vi-ex` | ex commands without a terminal (#62) | in main (8137872f) |
| `archive/unix/tab-wasm-shim-preopens` | wasi-libc preopens of /usr etc. | in main (the -v2 branch) |
| `archive/unix/tab-zip-flags` | zip `-qr` and quiet flags (#60) | in main (2b352481) |
| `archive/unix/rg-hang` | temporary logging used to find the ripgrep stall (#157) | the fix is Build 1036 |
| `archive/selftest-fixes` | `kill %N` and other shell fixes from a self-test run | in main |
| `archive/unix/gl-wip` | GL work in progress | WIP, not merged |
| `archive/design/dock-icons` | dock icon studies (12 sets, light and dark) | design reference |
| `archive/hotswap/dock-groups-logo-glyphs` | dock groups and logo glyphs, with DEV-TOOLS notes | what shipped is in main; the rest is reference |
