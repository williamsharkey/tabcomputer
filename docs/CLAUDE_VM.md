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
| `Bun.Terminal` | 2 | background tasks in a pty | it already falls back ("Bun.Terminal unavailable (running under Node?)") |
| `Bun.version`, `.main`, `.isStandaloneExecutable` | 1 each | runtime checks | values |
| `Bun.unsafe.setJITPolicy`, `Bun.gc`, `Bun.generateHeapSnapshot` | 4, 1, 1 | JIT hints, diagnostics | no-ops |
| `Bun.JSONL?.parseChunk`, `Bun.FetchSession` | 1, 1 | optional (`?.`, `typeof` checks) | leave undefined |
| `Bun.Image`, `Bun.WebView`, `Bun.SQL`, `Bun.Transpiler` | 2, 1, 1, 1 | images, a browser view, `claude gateway`, TS config files | later, or throw |
| `Bun.ant.getPeerPid/getPeerUid/memoryPressureLevel/setDumpable` | 1 each | Anthropic's Bun fork: sockets' peers, memory pressure | optional; check each call site |
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
| `sockets.ts` | `listen`, `connect` | the process's `net`: Bun's handlers (open, data as a Buffer, drain, end, close, error, timeout, connectError), `write` returning the bytes taken, `readyState`; a refused connect rejects with "Failed to connect" and the system's code. On node-compat a listener's port is known when `listen`/`serve` returns, as in Bun |

Not yet: `serve`, `listen`, `connect`; `CellSegmenter` and the loader are agent-clis'.

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
  and the xclip builtin is text only.
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

## Not done yet

- The page's memory: ~1.2 GB renderer RSS at the prompt.
- Sign-in against claude.ai (the OAuth callback server runs on
  `Bun.serve`; the browser's redirect to it is untried), background tasks (`Bun.Terminal`).
- Voice input end to end: the microphone is there, but the voice stream is a
  `ws` WebSocket to `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream`
  with an `Authorization: Bearer` header, and `--vm`'s `ws` is the page's
  WebSocket, which can't send headers. It needs a `ws` over the TCP relay
  (node-compat's tls) or a server route that adds the header.
- Image paste: the xclip builtin answers image targets with an error.
