# Claude Code's JavaScript on the page's engine (`claude --vm`)

Native Claude Code is a Bun single-file executable: Bun (with JavaScriptCore)
plus Claude Code's bundled JavaScript. Under Blink, the whole of Bun and JSC
runs as emulated x86-64 code. `claude --vm` (in progress) takes the
JavaScript out of the binary the user installed and runs it on tabcomputer's
Node runtime in the page's own JS engine, the way `claude --npm` runs the
pinned 2.1.112 npm build, with a shim for the Bun APIs it uses.

The extracted code is Anthropic's. It is extracted on the user's machine from
the binary they installed (`claude install`, sha256-checked against
Anthropic's manifest) and cached there, keyed by the binary's sha256.
tabcomputer never serves it.

Everything below was read from 2.1.296 (linux-x64-musl, sha256 `94a1ccc6…417f`).

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
  input). No wasm, no embedded ripgrep module (the native build runs itself as
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

## First results

- On the host, Node 22 with a near-empty `Bun` object (`version`, `main`,
  `isStandaloneExecutable`), `import.meta.require`/`.dir` rewritten, and
  `/$bunfs/root/` mapped to the extracted directory: `cli --version` prints
  `2.1.296 (Claude Code)`. An interactive start then needs `using` lowered
  (host only) and `ws`.

## Plan

1. Extract at `claude --vm` time (in the page): find `.bun` by name, parse the
   graph, write the modules to `~/.cache/tabcomputer/claude-vm/<sha256>/`
   with `/$bunfs/root/` mapped to that directory, assets decompressed. Keyed
   by the binary's sha256; done once per version.
2. Load it with node-compat's ESM loader (as `--npm`), with `Bun`, `bun:*`,
   `ws` and `import.meta.require/dir` provided.
3. Shim pieces, by priority: CellSegmenter and the text helpers (nothing
   renders without them), then spawn/stdin/which, zstd, then the servers.
4. Measure with bench's claude suite against native-in-Blink and npm 2.1.112.
5. Anything `--vm` can't run yet falls back to native-in-Blink.
