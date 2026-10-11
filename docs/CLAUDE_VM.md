# Claude Code's JavaScript on the page's engine (`claude --vm`)

Native Claude Code is a Bun single-file executable: Bun (with JavaScriptCore)
plus Claude Code's bundled JavaScript. Under Blink, the whole of Bun and JSC
runs as emulated x86-64 code. `claude --vm` takes the
JavaScript out of the binary the user installed and runs it on tabcomputer's
Node runtime in the page's own JS engine, the way `claude --npm` runs the
pinned 2.1.112 npm build, with a shim for the Bun APIs it uses.

The extracted code is Anthropic's. It is extracted on the user's machine from
the binary they installed (`claude install`, sha256-checked against
Anthropic's manifest) and cached there, keyed by the binary's sha256.
tabcomputer never serves it.

Everything below was read from 2.1.296 (linux-x64-musl, sha256 `94a1ccc6…417f`).

**Default since Build 985:** plain `claude` on tabcomputer runs `--vm`; `claude --x86`
(or `--native`, or `CLAUDE_X86=1`) runs the binary in the emulator instead. A build whose
JavaScript can't be read still falls back to the emulator.

## Where the bundle is

Bun keeps a compiled program's files (its "standalone module graph") in an
ELF section named `.bun`. In 2.1.296 it is at file offset `0x4f06000`, size
`0xa018037` (168 MB of the 251 MB binary). Find it by name from the section
headers; don't hard-code the offset.

```
.bun section:
  u64 payload length                     (0x0a01802f)
  payload:
    file data, module table, ...         (offsets below are from the payload start)
    Offsets (32 bytes, little-endian):
      u64 byte_count                     (0x0a017fff)
      u32 modules.offset, u32 modules.length     (167714446, 134628)
      u32 entry_point_id                 (6)
      u32 exec_argv.offset, u32 exec_argv.length (empty)
      u32 flags                          (0x1fff)
    "\n---- Bun! ----\n"                 (the trailer; the section ends here)
```

The module table is 2589 records of 52 bytes: six string pointers
(u32 offset, u32 length; offsets from the payload start), then four bytes.

| field | meaning |
|---|---|
| name | `/$bunfs/root/<file>`, the path the code sees |
| contents | the file's bytes |
| sourcemap | empty for every module |
| bytecode | JSC bytecode for the module (2343 modules) |
| module_info, bytecode_origin_path | unused here |
| encoding, loader, module_format, side | u8 each |

Loaders seen: 1 = js (2345 modules, ESM), 5 = file (143 assets), 13 = text
(99 assets), 10 = napi (2 addons).

## What's in it

- **The source is there.** Every JS module's `contents` is its plain
  JavaScript source (it starts `// @bun @bytecode` and Anthropic's license
  header); the bytecode is beside it, not instead of it. No source maps.
  45 MB of JS in 2345 modules. The entry point is `/$bunfs/root/cli` (24 KB),
  which imports `chunk-*.js` by absolute `"/$bunfs/root/chunk-….js"`
  specifiers, statically and with `import()`.
- **Assets:** 138 zstd-compressed files (`*.md.zst`, `*.txt.zst`, also
  `mermaid.min.js`, which is zstd data despite its name), read back with
  `Bun.zstdDecompress(Sync)`; markdown and text files (skills, READMEs); two
  fonts (`*.woff2.asset`).
- **Native addons:** `clipboard-napi.node` and `audio-capture.node` (voice
  input); `--vm` loads browser-backed stand-ins (below). No wasm, no embedded ripgrep module (the native build runs itself as
  `rg`; tabcomputer's launch already points its search at the builtin `rg`).
- **Syntax:** `using` declarations (explicit resource management), which
  Chromium's V8 runs; the page needs no lowering, a Node 22 host does.
- **`import.meta`:** `.require` (488 uses, Bun's CommonJS `require` from ESM),
  `.dirname` (143), `.dir` (7, Bun's name for dirname), `.url` (6).
- **Bare imports:** Node builtins (`path`, `fs`, `fs/promises`, `crypto`, `os`,
  `child_process`, `net`, `http(s)`, `stream`, `zlib`, `vm`, `tls`, `http2`,
  `dns`, `readline`, `async_hooks`, `worker_threads`), plus `ws` (built into Bun,
  not in the bundle), `bun:jsc` and `bun:ffi`.

## The Bun APIs it uses

Counts are textual uses in the 45 MB of JS.

| API | uses | what for | plan |
|---|---:|---|---|
| `Bun.ant.CellSegmenter` | 3 | the renderer's cell grid: splits styled text into terminal cells (graphemes, widths, SGR styles, links) into Int32Arrays | **required**; a JS implementation, reverse-engineered from its consumer |
| `Bun.stringWidth`, `Bun.stripANSI`, `Bun.sliceAnsi`, `Bun.wrapAnsi` | 3, 1, 5, 3 | text layout | JS (string-width / slice-ansi / wrap-ansi semantics) |
| `Bun.hash.crc32` | 15 | gzip/zip framing, checksums | JS |
| `Bun.semver.order`, `.satisfies` | 2 | version checks | JS |
| `Bun.deepEquals` | 2 | settings comparison | JS |
| `Bun.YAML.parse/stringify`, `Bun.TOML.parse` | 2, 1 | frontmatter, config | JS (or the YAML package node-compat has) |
| `Bun.zstdDecompress(Sync)` | 2 | embedded assets | zstd in JS/wasm, or decompress at extraction |
| `Bun.which` | 3 | finding programs | PATH lookup on the tab's fs |
| `Bun.spawn` | 6 | subprocesses (with `argv0`, stdio as `Bun.file(fd)`) | onto tabcomputer's `child_process` |
| `Bun.stdin.stream()` | 3 | piped input (hooks, editors) | `process.stdin` as a ReadableStream |
| `Bun.file` | 1 | a socket path as a spawn's stdio | with `Bun.spawn` |
| `Bun.sleepSync` | 1 | a short poll loop | Atomics.wait / busy wait |
| `Bun.serve`, `Bun.listen`, `Bun.connect` | 4, 2, 2 | local servers (sign-in callback, previews), proxies, reachability probes | onto `http`/`net`; check which matter |
| `Bun.Terminal`, `Bun.spawn({ terminal })` | 2 | background sessions (`claude --bg`, `claude agents`): each runs under a pty host (`claude --bg-pty-host SOCK COLS ROWS -- CMD...`) that makes a terminal, starts Claude on it, and serves it to clients over a Unix socket | kernel ptys (`terminal.ts`) |
| `Bun.version`, `.main`, `.isStandaloneExecutable` | 1 each | runtime checks | values |
| `Bun.unsafe.setJITPolicy`, `Bun.gc`, `Bun.generateHeapSnapshot` | 4, 1, 1 | JIT hints, diagnostics | no-ops |
| `Bun.JSONL?.parseChunk`, `Bun.FetchSession` | 1, 1 | transcript reading; mTLS fetch sessions | left undefined: optional (`?.`, `typeof` checks); Claude Code splits lines itself and uses agents |
| `Bun.Image` | 2 | shrinking images before sending them (the Read tool, pasted images, clipboard BMPs, upload previews), sharp-like | `image.ts` |
| `Bun.WebView` | 1 | `Bun.WebView.closeAll()` behind `'WebView' in Bun` | left undefined (the browser tool that opens one isn't in this build) |
| `Bun.SQL` | 1 | `claude gateway`'s Postgres | refuses with what to do instead (`claude --x86 gateway`) |
| `Bun.Transpiler` | 1 | a mod's hooks module in TypeScript or JSX (`transformSync`, classic `@jsx h` pragmas) | `transpiler.ts` |
| `Bun.ant.getPeerPid/getPeerUid` | 1, 1 | the daemon's socket peers (from a socket's `_handle.fd`) | left undefined: node-compat's sockets have no fd, so the lookups are skipped (uid check: allowed; replies across socket directories: not offered) |
| `Bun.ant.memoryPressureLevel`, `.setDumpable` | 1, 1 | low-memory check (macOS only), prctl(PR_SET_DUMPABLE, 0) | `'normal'`; `true` |
| `bun:ffi` | 7 | dlopen of libc/libSystem/ntdll for ttyname, openat, login_tty… | every use is in try/catch with a fallback: a module that throws |
| `bun:jsc` | 2 | `edenGC()`, `heapStats()` | optional: no-ops |

`Bun.ant` is Anthropic's own Bun build ("Run Claude Code on the
@anthropic-ai/bun-internal version pinned in package.json"), so its
`CellSegmenter` has no public documentation; its contract comes from the
renderer that calls it.

## The shim (`src/claude-vm/bun/`)

`createBun({ fs, process, childProcess, Buffer })` (`index.ts`) makes the
`Bun` object for one process from that process's own Node modules; it is
given to the bundle's module scope, never set as a page global. Each area is
a module, tested against what Bun 1.4.2 returns for the same calls
(`tests/tests/shiro-vitest/claude-vm-bun-*.test.ts`):

| module | APIs | how |
|---|---|---|
| `text.ts` | `stringWidth`, `stripANSI`, `sliceAnsi`, `wrapAnsi` | string-width, strip-ansi, slice-ansi, wrap-ansi; printable ASCII skips them. `sliceAnsi` keeps a wide character that starts before `end`, as Bun does |
| `hash.ts` | `hash.crc32(data, seed)` | a table CRC-32 |
| `semver.ts` | `semver.order`, `semver.satisfies` | node-semver (loose) |
| `deep-equals.ts` | `deepEquals(a, b, strict)` | toEqual / toStrictEqual rules |
| `formats.ts` | `YAML.parse/stringify`, `TOML.parse` | yaml (several documents: an array); Bun's own emitter style; smol-toml with dates as text objects |
| `zstd.ts` | `zstdDecompress(Sync)` | fzstd (decode only) |
| `which.ts`, `sleep.ts` | `which`, `sleepSync` | PATH on the process's fs (a regular file counts: the tab's files rarely carry execute bits); Atomics.wait, or a spin on the page's main thread |
| `spawn.ts` | `spawn`, `file`, `stdin` | child_process: Bun's stdio defaults, web streams, FileSink stdin, `exited`/`exitCode`/`signalCode`/`kill`/`onExit`, ENOENT thrown at once, `Bun.file(fd\|path)` as stdio |
| `serve.ts` | `serve` | the process's `http`: `fetch(req, server)` and `routes` (exact, `:param`, `*`, per method), `error()`, a thrown handler a 500; `port`, `url`, `stop()` (a promise), `reload`, `fetch` without the network, `requestIP` |
| `terminal.ts` | `Terminal`, `spawn({ terminal })` | a kernel pty from the process's `child_process` (node-worker/pty.ts as a kernel guest: /dev/ptmx and /dev/pts/N through syscalls; node-compat/pty-page.ts in the page). Options cols/rows/data/exit; `write` (bytes taken), `resize`, `setRawMode`, the termios flags, `ref`/`unref`, `close` (then `exit`), `await using`. A program starts in a session of its own with the slave as fds 0-2 and its controlling tty (the kernel's `ctty` spawn option), so ^C written to the terminal is SIGINT to it; its stdio on the Subprocess are null and `proc.terminal` is the terminal. The pty stays open after its programs exit, until `close()`, as Bun's |
| `image.ts` | `Image` | size and format from the file's header (PNG, JPEG, GIF, WebP, BMP); resize (inside, fill, cover), rotate, jpeg/png/webp as one encode by the browser (createImageBitmap and OffscreenCanvas, in the page and the node worker); the error codes Claude Code tells apart (`ERR_IMAGE_UNKNOWN_FORMAT`, `_DECODE_FAILED`, `_TOO_MANY_PIXELS`, `_FORMAT_UNSUPPORTED`) |
| `transpiler.ts` | `Transpiler` | as a kernel guest, the page's esbuild while the guest waits (`SYS_shiro_transform`, node-worker/host.ts); in the page, node-compat's own type stripping and JSX (which miss some syntax), with the pragmas' factory |
| `self-exec.ts` | `process.execPath` | Claude Code runs itself again through its execPath (the pty host, the daemon, `/restart`, `claude plugin test`): `claude` beside vm-main.mjs, a `#!/usr/bin/env node` script that imports the launcher, padded past 64 KiB (Claude Code takes a smaller file there for an npm stub) |
| `sockets.ts` | `listen`, `connect` | the process's `net`: Bun's handlers (open, data as a Buffer, drain, end, close, error, timeout, connectError), `write` returning the bytes taken, `readyState`; a refused connect rejects with "Failed to connect" and the system's code. On node-compat a listener's port is known when `listen`/`serve` returns, as in Bun |
| `image.ts` | `Image` | node-compat's browser sharp (`shims/browser-sharp.ts`: createImageBitmap and a canvas, in the page or a Worker); `maxPixels` makes a larger image fail to decode (`claude-vm-bun-image.test.ts`) |

## How `claude --vm` runs it

- **Extraction** (`src/claude-vm/extract.ts`), on the user's machine from the
  binary `claude install` put in place, under
  `~/.cache/tabcomputer/claude-vm/<sha256>/`:
  - `cjs/`, once per Claude Code version: every file of the graph
    (`bun-graph.ts`). ES modules get Bun's paths and `import.meta` made
    node's (`adaptModule`), then become CommonJS with the page's esbuild
    (`toCommonJS`), so imports read their module's current exports where
    they are used: Bun's chunks assign exports inside lazy initializers and
    import each other in cycles, which node-compat's own ES module transform
    (a copy of each import, made once) left `undefined`. zstd assets are
    stored decompressed.
  - `nc-<build>/`, once per tabcomputer build: what runs, with node-compat's
    transforms done ahead and marked `PRETRANSFORMED` (they cost ~4 s a start
    on 64 MB of code otherwise).
- **The launcher** (`vm-main.mjs`) gives the process its `Bun`
  (`src/claude-vm/bun/`, through the `tabcomputer:claude-vm` builtin;
  `process-global.ts` keeps `Bun` process-local, so other programs' `typeof
  Bun` checks are unaffected), then loads `cli.js`. `bun:ffi` and `bun:jsc`
  are node-compat builtins (stand-ins), and `ws` a client over the page's
  WebSocket.
- **The compiled bundle** (`src/claude-vm/code-cache.ts`, `sw-host.ts`,
  `public/vm-sw.js`): node-compat compiles a module with `new Function`,
  which V8 never caches, so every start parsed bundle.js (~40 MB) again
  (~1.35 s) after reading it through the kernel (~0.9 s). V8 does keep the
  code for a script a service worker serves from CacheStorage, from its third
  load on and on a new page too (not for `importScripts` in a dedicated
  worker, nor for a Response the worker makes up). So:
  - the first `claude --vm` registers `/vm-sw.js` at scope `/` and waits
    for it to take the page (`clients.claim()` takes running workers too);
    pages that never run `claude --vm` get no service worker;
  - the launcher puts bundle.js into the `tabcomputer-vm` cache once, as an
    ES module whose default export takes node-compat's module parameters
    (the same list as `require.ts`; a test parses it), at
    `/__vm/<claude sha256>/nc-<tabcomputer build>/bundle.mjs`, removing any
    other layout's, and imports it from there;
  - `vm-sw.js` answers `/__vm/probe.mjs` and `/__vm/*` from that cache and
    nothing else: a static route (`addRoutes`) sends every other request
    straight to the network where the browser has them, and its fetch
    handler returns without answering anything outside `/__vm/` where not;
  - the launcher requires bundle.js as before when the worker isn't there
    or doesn't control its node worker yet (the probe, a new URL each time,
    fails), when registration fails or times out (5 s), when the import
    fails (the entry gone), or with `TABCOMPUTER_VM_CODECACHE=0`.

  **Off switch**: deploy `public/vm-sw.js` with `const ENABLED = false;` (or
  delete it). Each `claude --vm` reads `/vm-sw.js` first; switched off or
  gone, the page unregisters the worker and deletes the cache, and that
  launch requires bundle.js. A browser that updates the worker gets one
  that unregisters itself and empties the cache when it activates. Until a
  page reloads, the worker it had keeps answering `/__vm/` for it, but
  nothing new is stored and launches don't use it.

  Tests: `claude-vm-codecache.test.ts` (the worker's routing with and
  without static routes, the off switch, every fallback),
  `tests/browser/claude-vm-codecache.mjs` (the real app with a synthetic
  Bun executable: first launch, reload, the off switch, a worker that takes
  the page mid-launch), and `tests/browser/with-vm-sw.mjs`, which runs any
  browser test with the worker in every page.
- **`Bun.ant.CellSegmenter`** (`bun/cell-segmenter.ts`) is written from the
  renderer that calls it: segment styled text into graphemes, widths, SGR
  style runs (with their close codes) and OSC 8 links, and paint them into
  the screen's `[char id, word]` cells.

- **Network traffic**: `--vm` starts with the same `DISABLE_ERROR_REPORTING=1`
  and `DISABLE_TELEMETRY=1` defaults as native (its Remote Control cost and how
  to turn telemetry back on: docs/COMPAT.md, "Network traffic"). node-compat's
  fetch already drops the Datadog, Sentry and event-logging hosts; the switch
  also stops the feature-flag fetches and the API probes it doesn't.

## Native addons (`src/claude-vm/addons/`)

The bundle requires each addon by its embedded path (`import.meta.require`,
loader napi); `Bun.__require` gives a stand-in with the same exports instead,
one per process (`addons/index.ts`). Their browser work runs in the page: from
node's Worker a call goes there as a message (`node-guest-page-call`, answered
by `node-guest-page-reply`, with `node-guest-page-ev` events; `bridge.ts`,
`node-worker/host.ts`, `guest.ts`), and node in the page calls it directly.
What 2.1.296 calls, from its own code:

- **clipboard-napi.node**, on Linux only when `DISPLAY` or `WAYLAND_DISPLAY`
  is set and none of wl-copy, xclip and xsel is on PATH (tabcomputer's xclip
  and xsel builtins are, so this is the fallback for a PATH without them):
  `setLinuxClipboardText(text)` → true (false makes Claude Code stop using
  the addon) and `getLinuxClipboardText(primary, timeoutMs)`
  → a promise of the text or null. Both use `utils/clipboard.ts`: a write the
  browser refuses is kept, read back, and written on focus, so it returns
  true; the browser has no PRIMARY selection. Image paste doesn't use the
  addon: Claude Code runs `xclip -t TARGETS` / `-t image/png` (or wl-paste),
  which the xclip builtin answers from `navigator.clipboard.read()` (Parity, 5).
- **audio-capture.node**, used on Linux when it loads and `/proc/asound/cards`
  names a card, else arecord, else SoX's rec. `/proc/asound/cards` lists the
  page's microphone when it has getUserMedia (no `/dev/snd`).
  `startRecording(onData, onEnd)` → true at once; `onData` gets signed 16-bit
  little-endian PCM, 16 kHz, mono, in 2048-byte chunks (getUserMedia, an
  AudioWorklet or ScriptProcessor, resampled in `mic.ts`). The browser's
  permission prompt answers later: a refusal ends the recording and is
  remembered, and a start with the permission already denied returns false,
  which `/voice` reports as "Microphone access is denied". `stopRecording`,
  `isRecording`, `microphoneAuthorizationStatus` (macOS numbers; unused on
  Linux). Playback (`startPlayback`, `writePlaybackData`, ...) has no caller in
  2.1.296 and returns false. A recording stops with its process.

Tests: `claude-vm-addons.test.ts`.

## Results

Local Chromium, `bench/claude-tui.mjs` (2 runs × 30 keys; `--vm` warm, after
extraction):

| | prompt | key echo median (p90) |
|---|---:|---:|
| `--vm` 2.1.296 | 3.1 s | 27 ms (30) |
| native 2.1.296 in Blink | 45 s | 200 ms (457) |
| npm 2.1.112 | 2.2 s | 22 ms (24) |

The next session's start (a reload, then `claude --vm`), local Chromium, 2
runs: 4.0 s and 509 MiB renderer RSS at the prompt requiring bundle.js;
2.3 s and 430 MiB with the compiled bundle from the cache.

Extraction: ~40 s once per version (both stages); a new tabcomputer build
redoes only the second. `tests/browser/claude-restore.mjs` with
`CLAUDE_BUILD=vm TOOL=1`: a model turn (a local stand-in for the Messages
API), a Bash tool call, and the session resumed after a reload.

## Sign-in

Claude Code's own sign-in works under `--vm` as it does for the other builds;
nothing in it is `--vm`-specific. What 2.1.296 does:

- `claude` signed out (after the theme picker, "Select login method"), `/login`
  in a session, and `claude auth login` (`claude login`, `loginArgs` in
  `claude.ts`) run the same flow. It makes a PKCE verifier and a state,
  starts a callback server with node's `http.createServer` on `127.0.0.1:0`
  (not `Bun.serve`), and builds two authorize URLs with the same state and
  challenge: the manual one (redirect
  `https://platform.claude.com/oauth/code/callback`), which it prints, and the
  automatic one (redirect `http://localhost:PORT/callback`), which it opens.
  Both carry `code=true`. The claude.ai URL is
  `https://claude.com/cai/oauth/authorize`.
- Opening is `$BROWSER URL` (or the `browser` setting), else `xdg-open URL`,
  through `child_process` (execa). On Linux with neither `DISPLAY` nor
  `WAYLAND_DISPLAY` and no `$BROWSER` it opens nothing. tabcomputer's shell
  sets `BROWSER=xdg-open` (`main.ts`) and `--vm` passes the shell's
  environment, so the builtin `xdg-open` (`open-url.ts`) gets the automatic
  URL, rewrites it to the manual redirect and opens it in a new tab, or offers
  an Open card when the browser blocks the tab.
- `auth login` reads `code#state` lines from stdin (readline); a session's
  `/login` has its "Paste code here if prompted >" box. A pasted code ends the
  wait without the callback, and the token exchange (`POST
  https://platform.claude.com/v1/oauth/token`, axios) names the manual
  redirect. node-compat's fetch sends it through the server's `/api/platform/`
  proxy. Then come the profile, roles and bootstrap calls (`/api/anthropic/`),
  and the tokens go to `~/.claude/.credentials.json`.

`tests/browser/claude-vm-signin.mjs` runs all of it in Chromium on the real
binary, with a stand-in for the account (a front proxy answers the token
exchange and the account calls): `auth login` (the opened URL, the exchange's
redirect, code, state and verifier, the saved tokens, `auth status`),
`BLOCK=1` (the Open card carries the same URL), and `LOGIN=session` (the
first run's `/login`, then the session's input box and a resize).

What only a real account can confirm: the platform's code page for this
client and redirect, the real token exchange through `/api/platform/` (the
stand-in replaces exactly that hop), the Console (API key) method, which mints
a key with `create_api_key`, and a subscription's profile in the session.

## Parity

How `--vm` differs from the native build on Linux, read from 2.1.296's module
graph (its Node builtin imports, `Bun.*`, `bun:*`, `process.execPath` spawns)
and checked in Chromium where noted. Most user-visible first.

| # | Gap | Impact | Status |
|---|---|---|---|
| 1 | Terminal resize and resume after Ctrl-Z: node in a Worker (the default on a cross-origin isolated page, so every `--vm` session) never got `SIGWINCH` or `SIGCONT`, so stdout's `'resize'` and `process.on('SIGWINCH'/'SIGCONT')` never fired and Claude Code kept its old width | high | **fixed**: the guest catches both once a listener asks (`node-worker/guest.ts`, `node-compat/process.ts`); `execSync`'s wait restarts after a caught signal (`node-worker/child.ts`). `node-worker.test.ts`, and the resize step of `claude-vm-signin.mjs` |
| 2 | Sign-in | high | **works**, above |
| 3 | `fetch` of a site without CORS headers from node in a Worker (WebFetch, remote HTTP/SSE MCP servers, any script) failed with "Failed to fetch". In the page, node-compat retries such a request over the TCP relay; the guest had no relay | high | **fixed**: the retry goes over the guest's own kernel sockets (`relay-fetch.ts`, `GuestNet`); checked against example.com through a local relay. `relay-fetch-guest.test.ts` |
| 4 | `Bun.Image` missing: an image that had to be resized or converted (a large screenshot given to Read, a pasted image, compression to the API's limits, attachment previews) failed with "Unable to resize image" | medium-high | **fixed**: `bun/image.ts`; browser sharp's `rotate()` now turns by quarter turns |
| 5 | Image paste. Cmd+V (a Mac's paste) goes through the browser's paste event, and xterm.js pastes only its text, so an image alone pasted nothing. Ctrl+V (Claude Code's own image paste) runs `xclip -t TARGETS -o \| grep image/...` and `xclip -t image/png -o > file` through a shell, and node-compat's child_process answered every command starting with `xclip` as a clipboard write without running it: exit 0, no output, no file | medium | **fixed**. A pasted or dropped image is saved to `/tmp/paste-<time>.png` (`drop-<time>-<name>` for a drop, its type kept) and its path pasted, bracketed when the program asked (`terminal-file-paste.ts`), for every program: Claude Code attaches a pasted absolute path to a .png/.jpg/.gif/.webp as [Image #N] (2.1.296's paste handler; it reads the clipboard itself on an empty paste only on macOS and WSL). A paste with real text stays text. Only plain clipboard writes skip running now (`isClipboardWrite`), so Ctrl+V's reads reach the xclip builtin, which reads `navigator.clipboard.read()` (Chrome asks for clipboard permission the first time; refused, Claude Code finds no image). `terminal-image-paste.test.ts`, `claude-image-paste.test.ts` (both node modes), `tests/browser/image-paste.mjs` (Chrome: the paste event, a drop, and the xclip calls from a Worker guest on the real clipboard). Untested live: a real Cmd+V/Ctrl+V into a signed-in session |
| 6 | Self re-exec: `process.execPath` was `/usr/local/bin/node` while `Bun.isStandaloneExecutable` is true, so `[execPath, ...args]` ran node without the launcher: background sessions (`--bg-pty-host`, `--bg-spare`), agent-team teammates in tmux, `claude plugin eval`, the self-hosted runner, function-hook builds, `CLAUDE_CODE_EXECPATH` in the Bash tool | medium | **fixed** (Build 986): a `claude` file beside `vm-main.mjs` (`bun/self-exec.ts`) |
| 7 | `Bun.Terminal` (the background sessions' pty host) | medium | **implemented** (Build 986) on kernel ptys (`bun/terminal.ts`), with Unix sockets in `net`; the whole `claude --bg` chain is untried live |
| 8 | Git worktrees (`--worktree`, EnterWorktree): `git worktree add` | medium-low | open, not `--vm`-specific: the builtin git has only `worktree list` (`git-route.ts`) and refuses linked worktrees; Debian's git (`debian install`) has them |
| 9 | OAuth for remote MCP servers: the callback is `localhost:PORT/callback` in the tab, which the user's browser can't reach | low-medium | open, not `--vm`-specific; Claude Code's own fallback (paste the redirect URL in `/mcp`) works |
| 10 | Node builtins node-compat lacked, so they were auto-stubbed (they exist and do nothing; a `*Sync` returns `''`) | low-medium | **fixed**: `fs.ftruncateSync` (the in-place write fallback kept the old tail), `fchmodSync`, `mkdtempSync` (returned `''`), `statfs(Sync)`, `fs/promises` `lutimes`/`statfs`, `os.getPriority`/`setPriority`, `url.domainToASCII`, `v8.getHeapSpaceStatistics`, `tls.checkServerIdentity`. **Open**: `crypto.createCipheriv`/`createDecipheriv` (AES-256-GCM: the claude.ai MCP connectors' discovery cache), `generateKeyPairSync`/`sign`/`verify` (Cowork remote device keys, DPoP), `X509Certificate` (custom CA and gateway checks), `zlib.createZstdDecompress` (the native updater, which tabcomputer's `claude update` replaces), `http2.Http2ServerRequest`, `child_process.ChildProcess`. `claude-vm-node-builtins.test.ts` checks every builtin member the bundle imports |
| 11 | `new WebSocket(url, { protocols, headers, ... })` (Bun's options form): the MCP `ws` transport, remote-io, the agent proxy; the browser's WebSocket takes no options and sends no headers | low | open |
| 12 | Plugin function hooks: `new Worker(hooks-worker.js)`, `Bun.Transpiler` for `.ts`, and a self re-exec (6) | low | open |
| 13 | Voice input, the native clipboard addon, `claude gateway` (`Bun.SQL`), `Bun.WebView` | low | the two addons are browser-backed stand-ins (Build 986, `claude-vm/addons/`): the microphone works, the voice stream doesn't (its `ws` needs an `Authorization` header the page's WebSocket can't send); `claude gateway` runs under `--x86`; `Bun.WebView` is unused |
| 14 | Telemetry, error reports, feature flags, Remote Control | by design | off unless `TABCOMPUTER_CLAUDE_TELEMETRY=1` (`quietEnv`), as for native |
| 15 | The npm build's tabcomputer defaults (`node-compat/process.ts`: `ANTHROPIC_MODEL`, background tasks off, tool concurrency 4) key on a `claude-code` script path | by design | `--vm` keeps Claude Code's own defaults, as native does, so background Bash tasks are on: untested live |
| 16 | `bun:ffi` (ttyname, `*at` directory streams, `login_tty`), `bun:jsc` | none seen | every use falls back when `dlopen` throws; `bun:jsc`'s are no-ops |
| 17 | IDE integration | n/a | the IDE runs the WebSocket server and writes `~/.claude/ide/*.lock`; nothing in a tab does |
| 18 | The page's memory | — | measured, below: ~150-230 MB for Claude Code's Worker at the prompt |

Expected to work, not run live yet: hooks and the status line (`sh -c`
children with JSON on stdin), MCP stdio servers (`spawn` with pipes), the
claude.ai MCP proxy (`/api/mcp-proxy/`), subagents (in-process). `/resume` is
covered by `claude-restore.mjs` with `CLAUDE_BUILD=vm`.

## Not done yet

- The page's memory. Measured on perf2 (Build 985, measureUserAgentSpecificMemory):
  at the prompt Claude Code's Worker is ~150-230 MB and the page's JS ~60 MB, over
  the page's own ~325 MB of SharedArrayBuffers (performance.memory counts those
  too: its ~1.2 GB was mostly them). The first run's extraction leaves ~250 MB of
  garbage in the page's JS that V8 collects within a minute or so. An exited
  claude's Worker (~150 MB) stays pooled for the next node, warm, for 2 minutes.
- Voice input end to end: the microphone is there, but the voice stream is a
  `ws` WebSocket to `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`
  with an `Authorization: Bearer` header, and `--vm`'s `ws` is the page's
  WebSocket, which can't send headers. It needs a `ws` over the TCP relay
  (node-compat's tls) or a server route that adds the header.
- Background sessions in a real tab: their pieces work in the tests (the pty
  host's terminal, its Unix socket, Claude Code started again through
  execPath), the whole chain (`claude --bg`, its daemon, attaching) is
  untried, and Claude Code only offers it when its agents gate is on.
