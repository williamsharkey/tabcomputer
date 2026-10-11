# Releases

One line per build shipped to tabcomputer.com (the `deploy` branch of
williamsharkey/tabcomputer). Git tags would be the usual record, but the
session git proxy refuses tag pushes, so this file is the log. Newest first.

| Build | Commit (main = deploy) | Date (UTC) | What shipped |
|---|---|---|---|
| 972 | see `git log --grep "^Build 972"` | 2026-10-11 | shell: `2>&1` keeps stdout/stderr order (#30), programs get only real env variables; agent-clis: quiet native launch (#40), `gh api --input` (#45); hot-swap: swap registry commands, reload resolves imports (#47), `hotswap push` defaults to tabcomputer; perf-fs-shell: main-thread stalls in grep/rg/tar/gzip/zip (#19), clone null-pack message (#43); kernel: byte-exact binary stdin (#49, field tester); docs: tabcomputer is the source repo |
| 971 | 573f0a64 | 2026-10-11 | Blink 0521 (POSIX timer signal queued once); last build before the repo move |
