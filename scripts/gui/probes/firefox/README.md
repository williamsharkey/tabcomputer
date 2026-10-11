# Firefox ESR probes (docs/GUI_SCORE.md, Firefox known failures)

Browser-driven scripts against a local build (`NODE_USE_ENV_PROXY=1 PORT=5299 STATIC_DIR=$PWD/dist node server.mjs`;
without NODE_USE_ENV_PROXY the server can't reach the Debian mirror through the proxy). Screenshots go to `$OUT` (default `.`).
Each installs firefox-esr in a fresh browser profile; Firefox's window takes ~4.5–5 min.

- `ff-env.mjs URL 'ENV=1 …' 'firefox args' 'prep shell cmd'`: starts Firefox from the shell with that environment
  (sandbox off: `MOZ_DISABLE_CONTENT_SANDBOX=1 …`; `LANG=C`), types `file:///home/user/t.html` into the address bar,
  then prints dmesg, Firefox's processes and the end of its log.
- `ff-ps.mjs URL`: the same, polling Firefox's processes every 2 s; a child still showing the parent's argv (it never
  exec'd: the "husk" the parent SIGKILLs) gets its /proc status, wchan and tasks dumped 8 s after it appears.
- `ff-noshm.mjs [--keep-overlay] [--app thunderbird]` (env `FFARGS`, `TYPEURL`): through `gui firefox-esr`, with or
  without the old font-list overlay.
- `ff-url.mjs URL 'ENV' 'args URL' ['prep']` (env `SHOT`, `AUTOCONFIG=1`): a URL on the command line; notes when
  Firefox exits before a window and appends `firefox exit status N` to /tmp/ff.log. `AUTOCONFIG=1` installs
  `autoconfig/` (Firefox's enterprise autoconfig: `defaults/pref/autoconfig.js` loads `probe.cfg` as chrome JS), which
  logs the command line at `command-line-startup` and wraps BrowserContentHandler's `handle` methods so every
  `nsICommandLine` call is a `PROBE` line in the log. Add `user_pref("devtools.console.stdout.chrome", true)` to the
  profile's user.js (with `-profile DIR` and a prep command) to see the chrome console too.
- `pagesh.mjs 'cmd' …`: shell commands in a fresh page, output printed.
- `runprobe.mjs BINARY`: copies a static x86-64 binary into the page and runs it.
- `forkexec.c`, `forkexec2.c` (`gcc -static [-pthread]`): fork/vfork/clone/posix_spawn then exec, from the main
  thread and from a second thread of a threaded parent; the pid must survive exec (it does in Blink, as natively).
