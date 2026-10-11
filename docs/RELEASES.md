# Releases

One line per build shipped to tabcomputer.com (the `deploy` branch of
williamsharkey/tabcomputer). Git tags would be the usual record, but the
session git proxy refuses tag pushes, so this file is the log. Newest first.

| Build | Commit (main = deploy) | Date (UTC) | What shipped |
|---|---|---|---|
| 975 | see `git log --grep "^Build 975"` | 2026-10-11 | Blink: direct kernel channels by default (syscall 114→2.3 µs, pipe 275→50 µs, vim −27%) and 0522 fchmodat2 AT_EMPTY_PATH (#54, systemd/apt); timeout stops background jobs, redirected output streams (#53), timeout < fifo, $SECONDS; node stdin is Buffers (#55), ps -o, GNU text-tool fixes, worker testTimeout; hotswap watch/test --changed, live map trimmed; live profiler (watchdog profile, shiro-mcp profile); kernel profiler + strace -c, /dev/tty flags; FS keeps inode/nlink after eviction (cp in mkinitramfs); GUI C.utf8 locale; GL XGetImage reads frames on demand; claude install from tabcomputer.com (/claude-releases/); bench claude suite; README/About rewrite, DEVELOP_IN_TAB.md |
| 974 | see `git log --grep "^Build 974"` | 2026-10-11 | GL: the glshiro executor in a Worker, frames straight into GL surfaces (glxgears 46 → 104 fps in the page); hotswap checkout defaults to ~/tabcomputer; shiro-mcp monitor.mjs (read-only freeze monitor); debian-score names the command in page errors; docs: RELEASES index, known issues for #19/#32/#35/#50/#53 |
| 973 | see `git log --grep "^Build 973"` | 2026-10-11 | rg: `--null`, `--json`, `-U`/`--multiline-dotall`, `-m`, binaries skipped early (#44); a pipeline whose head wrote nothing gives EOF, fixing `time { … } \| tail` (#48); node crypto randomBytes/randomFillSync past 64 KiB, randomFill, randomInt (#46); relay on tabcomputer.com: 16 MiB/s per IP, 128 MiB burst, 2 MiB window (#51); deploy README for the repo model |
| 972 | see `git log --grep "^Build 972"` | 2026-10-11 | shell: `2>&1` keeps stdout/stderr order (#30), programs get only real env variables; agent-clis: quiet native launch (#40), `gh api --input` (#45); hot-swap: swap registry commands, reload resolves imports (#47), `hotswap push` defaults to tabcomputer; perf-fs-shell: main-thread stalls in grep/rg/tar/gzip/zip (#19), clone null-pack message (#43); kernel: byte-exact binary stdin (#49, field tester); docs: tabcomputer is the source repo |
| 971 | 573f0a64 | 2026-10-11 | Blink 0521 (POSIX timer signal queued once); last build before the repo move |
