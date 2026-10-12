# GUI app launch time: corpus, baseline, profile

How long Debian GUI apps take from a dock click to a usable window, where
the time goes, and what was done about it. The goal is a window in under
2 seconds for apps like Geany and GIMP. Snapshots of started apps, the one
route that gets there, are in [research/GUI_SNAPSHOTS.md](research/GUI_SNAPSHOTS.md).

## Measuring

```sh
npx vite build && PORT=5391 STATIC_DIR=$PWD/dist node server.mjs &
node tests/browser/gui-launch-bench.mjs http://localhost:5391/ --json out.json --md out.md [APP...]
node tests/browser/gui-launch-bench.mjs http://localhost:5391/ --engine-profile DIR geany   # + the engine's profile
node scripts/gui/launch-profile.mjs DIR --debuginfod                                       # by library and function
node tests/browser/gui-launch-bench.mjs --render out.json                                  # the table again
```

`tests/browser/gui-launch-bench.mjs` gives each app a fresh browser profile
and opens it the way a dock click does (`desktop.openApp`), three times:
**cold** (install, then the first start), **warm** (after quitting it, a
second start in the same page) and **reload** (after reloading the page, a
third). A whole run of the corpus takes about 10 minutes; one small app
under a minute. `--passes warm,reload`, `--env K=V,...` (variables for the
app, e.g. `BLINK_WJIT_THRESHOLD=50`) and `--set key=value` (localStorage
before boot, for settings) make an A/B a pair of runs.

Per launch it records, in ms from the click:

- **install**: packages fetched, decoded and written, and their bytes;
- **process**: the x86-64 process exists (on the first launch in a page the
  D-Bus session bus starts first);
- **linked**: glibc's `LD_DEBUG=statistics` line, printed when ld.so hands
  over to the program, and how many shared objects it opened;
- **X connection**, **first window** mapped, and **usable**: the first
  window that isn't a splash screen has drawn something (GIMP: its main
  window, by title; Inkscape: its welcome dialog);
- **quit → gone**: after the title bar's close button, until the app's
  processes are gone, and whether a zombie was left.

The kernel profiler (`src/kernel/profiler.ts`) is attached for the launch:
system calls by kind (the top 15 with their kernel CPU and wall time), bytes
read from files (a library's mapping is a `pread64`), every path opened,
processes and threads started, and the main thread's time in the kernel
against outside it. The page's requests are counted by kind (`.deb`s,
overlays). With `--engine-profile DIR` a fourth launch runs under
`SHIRO_BLINK_PROFILE` (docs/X86_ENGINES.md, items 64 to 74): time in compiled
code against the interpreter, the JIT's compiles, instructions per compiled
region and the engine lock. `scripts/gui/launch-profile.mjs` buckets those
instructions by library and function, from glibc's `LD_DEBUG=files` bases
and the libraries' symbols (`--debuginfod` fetches Debian's debug files by
build id, so static functions get their names).

The corpus is thirteen apps from `public/gui/apps.json`: bare X11 (xeyes,
xclock, xterm), FLTK (dillo), small GTK 3 (l3afpad, galculator, geany,
mousepad), GTK 2 (gpicview), Qt 5 (featherpad, qterminal) and two heavy ones
(gimp, GTK 2; inkscape, GTK 3 with gtkmm). The manifest has no SDL app.

## Baseline (Build 1007)

Measured on 2026-10-12: an Apple M3 (8 cores), headless Chrome 155 through
playwright-core, local `server.mjs` with its `.deb` cache warm. Times in
seconds from the click.

| App | Toolkit | Pass | Install | Process | Linked (libs) | X connection | First window | Usable | Quit → gone | Syscalls | File bytes read | Procs / threads |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| xeyes | x11 | cold | 0.7 (10 MB) | 1.0 | 1.1 (21) | 1.1 | 1.2 | **1.3** | 0.0 (1 zombie) | 992 | 11 MB | 2 / 1 |
| xeyes | x11 | warm | — | 0.0 | 0.1 (21) | 0.1 | 0.1 | **0.2** | 0.0 (1 zombie) | 1053 | 11 MB | 1 / 1 |
| xeyes | x11 | reload | — | 0.2 | 0.3 (21) | 0.3 | 0.4 | **0.4** | 0.0 (1 zombie) | 1085 | 11 MB | 2 / 1 |
| xclock | x11 | cold | 1.0 (11 MB) | 1.3 | 1.4 (27) | 1.4 | 1.8 | **1.9** | 0.0 (1 zombie) | 1832 | 17 MB | 2 / 1 |
| xclock | x11 | warm | — | 0.0 | 0.1 (27) | 0.1 | 0.3 | **0.4** | 0.0 (1 zombie) | 1785 | 17 MB | 1 / 1 |
| xclock | x11 | reload | — | 0.2 | 0.3 (27) | 0.4 | 0.7 | **0.7** | 0.0 (1 zombie) | 1780 | 17 MB | 2 / 1 |
| xterm | x11 | cold | 0.8 (12 MB) | 1.2 | 1.3 (29) | 1.4 | 1.9 | **1.9** | 0.0 (1 zombie) | 2934 | 22 MB | 4 / 3 |
| xterm | x11 | warm | — | 0.0 | 0.1 (29) | 0.1 | 0.5 | **0.5** | 0.0 (1 zombie) | 2934 | 22 MB | 3 / 3 |
| xterm | x11 | reload | — | 0.2 | 0.3 (29) | 0.3 | 0.8 | **0.8** | 0.0 (1 zombie) | 2934 | 22 MB | 4 / 3 |
| dillo | fltk | cold | 0.7 (14 MB) | 1.1 | 1.2 (27) | 1.3 | 2.4 | **2.4** | 0.0 (1 zombie) | 4209 | 24 MB | 2 / 1 |
| dillo | fltk | warm | — | 0.0 | 0.1 (27) | 0.2 | 1.1 | **1.2** | 0.0 (1 zombie) | 4152 | 24 MB | 1 / 1 |
| dillo | fltk | reload | — | 0.2 | 0.4 (27) | 0.4 | 1.4 | **1.5** | 0.0 (1 zombie) | 4152 | 24 MB | 2 / 1 |
| l3afpad | gtk3 | cold | 4.1 (46 MB) | 4.4 | 4.6 (69) | 4.6 | 6.9 | **7.1** | 0.0 (2 zombies) | 3433 | 82 MB | 3 / 6 |
| l3afpad | gtk3 | warm | — | 0.0 | 0.4 (69) | 0.4 | 2.7 | **2.9** | 0.0 (1 zombie) | 2938 | 65 MB | 1 / 6 |
| l3afpad | gtk3 | reload | — | 0.2 | 0.6 (69) | 0.6 | 3.0 | **3.2** | 0.0 (1 zombie) | 2929 | 65 MB | 2 / 5 |
| galculator | gtk3 | cold | 3.0 (46 MB) | 3.2 | 3.3 (70) | 3.4 | 6.2 | **7.2** | 0.1 (2 zombies) | 8175 | 83 MB | 3 / 5 |
| galculator | gtk3 | warm | — | 0.0 | 0.2 (70) | 0.2 | 3.0 | **4.0** | 0.1 (1 zombie) | 7671 | 67 MB | 1 / 4 |
| galculator | gtk3 | reload | — | 0.1 | 0.3 (70) | 0.4 | 2.9 | **3.8** | 0.1 (1 zombie) | 7674 | 67 MB | 2 / 4 |
| geany | gtk3 | cold | 2.8 (50 MB) | 2.9 | 3.1 (73) | 3.2 | 9.4 | **10** | 0.8 (2 zombies) | 4963 | 95 MB | 3 / 5 |
| geany | gtk3 | warm | — | 0.0 | 0.2 (73) | 0.3 | 6.2 | **6.9** | 0.8 (1 zombie) | 4471 | 79 MB | 1 / 5 |
| geany | gtk3 | reload | — | 0.2 | 0.5 (73) | 0.6 | 6.7 | **7.4** | 0.7 (1 zombie) | 4467 | 79 MB | 2 / 4 |
| mousepad | gtk3 | cold | 4.9 (48 MB) | 5.3 | 5.7 (77) | 6.1 | 14 | **15** | 1.0 (2 zombies) | 5154 | 158 MB | 3 / 6 |
| mousepad | gtk3 | warm | — | 0.0 | 0.5 (77) | 0.9 | 11 | **11** | 1.1 (1 zombie) | 4621 | 142 MB | 1 / 5 |
| mousepad | gtk3 | reload | — | 0.5 | 1.8 (77) | 2.5 | 13 | **13** | 1.4 (1 zombie) | 4671 | 142 MB | 2 / 5 |
| gpicview | gtk2 | cold | 3.4 (41 MB) | 3.9 | 4.2 (51) | 4.4 | 5.1 | **5.3** | 0.1 (1 zombie) | 1812 | 43 MB | 2 / 1 |
| gpicview | gtk2 | warm | — | 0.0 | 0.2 (51) | 0.3 | 0.8 | **0.9** | 0.0 (1 zombie) | 1813 | 43 MB | 1 / 1 |
| gpicview | gtk2 | reload | — | 0.2 | 0.5 (51) | 0.7 | 1.2 | **1.3** | 0.0 (1 zombie) | 1815 | 43 MB | 2 / 1 |
| featherpad | qt5 | cold | 2.9 (35 MB) | 3.4 | 3.7 (86) | 3.9 | 6.1 | **6.7** | 0.1 (1 zombie) | 3739 | 160 MB | 2 / 3 |
| featherpad | qt5 | warm | — | 0.0 | 0.3 (87) | 0.4 | 2.1 | **2.5** | 0.1 (1 zombie) | 3714 | 161 MB | 1 / 3 |
| featherpad | qt5 | reload | — | 0.2 | 0.6 (86) | 0.7 | 2.7 | **3.1** | 0.1 (1 zombie) | 3703 | 160 MB | 2 / 3 |
| qterminal | qt5 | cold | 2.8 (35 MB) | 3.1 | 3.3 (83) | 3.5 | 5.8 | **6.1** | not gone (qterminal, sh) | 4694 | 156 MB | 3 / 4 |
| qterminal | qt5 | warm | — | 0.0 | 0.3 (84) | 0.4 | 1.6 | **1.8** | not gone (qterminal, sh) | 4641 | 156 MB | 2 / 4 |
| qterminal | qt5 | reload | — | 0.1 | 0.4 (83) | 0.6 | 2.0 | **2.2** | not gone (qterminal, sh) | 4620 | 156 MB | 3 / 4 |
| gimp | gtk2 | cold | 4.8 (68 MB) | 5.4 | 6.7 (169) | 10 | 20 | **105** | 5.8 (1 zombie) | 221253 | 6726 MB | 115 / 120 |
| gimp | gtk2 | warm | — | 0.0 | 0.6 (169) | 3.9 | 8.4 | **31** | 6.5 (1 zombie) | 39244 | 558 MB | 8 / 15 |
| gimp | gtk2 | reload | — | 0.5 | 1.1 (169) | 4.4 | 9.6 | **29** | 6.5 (1 zombie) | 39251 | 558 MB | 9 / 14 |
| inkscape | gtk3 | cold | 9.3 (83 MB) | 9.6 | 11 (142) | 11 | 31 | **32** | 0.2 (2 zombies) | 11542 | 305 MB | 3 / 6 |
| inkscape | gtk3 | warm | — | 0.0 | 1.2 (139) | 1.4 | 21 | **21** | 0.1 (1 zombie) | 10927 | 289 MB | 1 / 5 |
| inkscape | gtk3 | reload | — | 0.2 | 1.6 (139) | 1.7 | 21 | **22** | 0.1 (1 zombie) | 10933 | 289 MB | 2 / 5 |

Read against the goal: only the Xlib and FLTK apps and GPicView are under
2 s once installed. The small GTK 3 apps take 3 to 13 s, Qt 5 2 to 3 s,
Inkscape 21 s and GIMP 30 s, and a first launch adds the install (0.7 to
9 s) and, for GIMP, 75 s of plug-in queries.

The numbers move with the machine's load: Geany's warm launch was 5.2 s in
a run by itself and 6.9 s in this one (after 25 minutes of launches the
machine runs hot). Compare runs made back to back.

Two things the quit column found: every app left a zombie (#118, fixed:
"What changed" below), and QTerminal stays when its window is closed. That
one is its own doing: it asks "Are you sure you want to exit?" while its
shell runs, and the benchmark doesn't answer.

## Where the time goes

Nearly all of it is the guest computing: the toolkit's own start-up work,
run by the x86-64 engine. The kernel and the filesystem are about 1% of a
launch.

| App | Usable: cold / warm / reload (s) | Kernel CPU, warm | Guest ran | in compiled code | of it compiling (regions) | interpreting | Instructions: compiled / interpreted | Compiled code, M instructions/s | Waiting for the engine lock | Threads ever |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| xeyes | 1.3 / 0.2 / 0.4 | 4 ms | 0.2 s | 0.2 s | 0.03 s (140) | 0.0 s | 7 M / 1.2 M | 48 | 0.00 s | 1 |
| xclock | 1.9 / 0.4 / 0.7 | 8 ms | 0.5 s | 0.4 s | 0.09 s (391) | 0.1 s | 29 M / 2.7 M | 110 | 0.00 s | 1 |
| xterm | 1.9 / 0.5 / 0.8 | 10 ms | 0.6 s | 0.4 s | 0.10 s (404) | 0.2 s | 84 M / 2.6 M | 307 | 0.01 s | 4 |
| dillo | 2.4 / 1.2 / 1.5 | 18 ms | 1.4 s | 0.9 s | 0.26 s (1008) | 0.5 s | 114 M / 6.4 M | 172 | 0.00 s | 1 |
| l3afpad | 7.1 / 2.9 / 3.2 | 27 ms | 2.4 s | 1.7 s | 0.34 s (1965) | 0.7 s | 231 M / 14.2 M | 173 | 0.21 s | 13 |
| galculator | 7.2 / 4.0 / 3.8 | 23 ms | 5.1 s | 4.0 s | 0.77 s (3751) | 1.1 s | 392 M / 23.2 M | 121 | 0.49 s | 17 |
| geany | 10.0 / 6.9 / 7.4 | 34 ms | 8.1 s | 6.1 s | 1.05 s (5441) | 2.0 s | 958 M / 36.5 M | 188 | 0.82 s | 33 |
| mousepad | 14.7 / 11.0 / 13.0 | 110 ms | 12.5 s | 10.4 s | 1.68 s (4179) | 2.1 s | 807 M / 26.1 M | 92 | 1.02 s | 14 |
| gpicview | 5.3 / 0.9 / 1.3 | 27 ms | 1.1 s | 1.0 s | 0.20 s (741) | 0.0 s | 50 M / 5.3 M | 60 | 0.00 s | 1 |
| featherpad | 6.7 / 2.5 / 3.1 | 29 ms | 3.1 s | 1.8 s | 0.53 s (2788) | 1.3 s | 99 M / 24.3 M | 77 | 0.06 s | 3 |
| qterminal | 6.1 / 1.8 / 2.2 | 29 ms | (no profile) | | | | | | | |
| gimp | 105.3 / 30.6 / 29.3 | 466 ms | 36.3 s | 30.0 s | 4.07 s (14098) | 6.3 s | 6858 M / 105.5 M | 264 | 1.15 s | 43 |
| inkscape | 31.5 / 21.3 / 22.1 | 182 ms | 22.5 s | 17.8 s | 2.70 s (9219) | 4.8 s | 2913 M / 52.4 M | 193 | 1.83 s | 34 |

(The profiled launch runs slower than the others, and the profile's
"compiled code" time includes its own bookkeeping; the instruction counts
are exact.)

- **System calls are not the cost.** Geany's warm launch makes 4,471 calls
  that take 34 ms of kernel CPU in all. Its main thread spends 62 ms in
  kernel calls (waits apart) and 6.9 s outside them. The 77 MB of library
  mappings arrive in 348 `pread64` calls taking 19 ms: the files are in
  the tab's filesystem after the install, so a launch fetches nothing.
- **Dynamic linking is quick.** Geany's 73 shared objects are open and
  relocated 0.2 s after the process starts (16,403 symbol relocations,
  32,380 relative ones). Lazy binding goes on afterwards: `do_lookup_x` is
  2 to 4% of a GTK 3 app's instructions, 10 to 16% of the smallest apps'
  (GPicView, xeyes, FeatherPad).
- **Then the toolkit starts.** Geany's X connection is up at 0.3 s and its
  window is mapped at 6.2 s. In between it runs 994 M guest instructions:
  GObject 29%, GLib 21%, GTK 20%, libc 15%. The largest single function is
  GObject's interface check (`type_node_check_conformities_UorL` 10.6%, with
  `g_type_check_instance_is_a` and `_cast` 19% together), then `strcmp`,
  hash table lookups, malloc and free, GTK's CSS (`_gtk_css_value_compute`,
  the selector tree) and GMarkup (GtkBuilder reading `geany.glade`). None of
  it is a cache being rebuilt: it is what GTK 3 does to build a window with
  a few hundred widgets (a native CPU runs a billion instructions in a
  fraction of a second).
- **The engine runs them at 100 to 250 M instructions a second** in compiled
  code. GObject code is short functions calling each other: Geany enters a
  compiled region 44 million times for 958 M instructions, 22 instructions
  per entry, and 38.5 M of those entries are calls that go through the
  engine's C helper (`WjCall`). That per-call cost, not the instructions
  themselves, sets the rate (X86_ENGINES.md "The wasm JIT").
- **Interpreting and compiling come on top.** 2 to 6% of the instructions
  (FeatherPad: 20%) run in the interpreter (code below the compile
  threshold of 200 runs, and the instructions after it up to the next
  branch), which takes 17 to 42% of the guest's time; compiling takes another 11 to 19% (Geany: 5,441
  regions, 1.05 s).

### What the apps have in common, ranked

By how much of a warm launch it is, across the corpus:

1. **Toolkit start-up computed at 100 to 250 M instructions/s**: 40 to 70%
   of every GTK and Qt launch (Geany 62%, GIMP 71%). Not specific to any app.
2. **Warm-up in the interpreter**: 17 to 42% (FeatherPad 1.3 s of 3.1 s,
   Geany 2.0 of 8.1, Inkscape 4.8 of 22.5).
3. **JIT compiles**: 11 to 19%. This is the ceiling for a translated-code
   cache kept across page loads, and V8 already keeps the modules' machine
   code within a page (`keptCompiledModules`, 6 MiB): a warm launch is 0.3
   to 0.6 s faster than the same launch after a reload.
4. **Thread churn** (GTK 3 only): Geany starts 33 threads to end up with
   4, Inkscape 34, GLib's pool workers that run one task each. Every one
   is a Worker with its own table of compiled code. Geany's 31 short-lived
   ones run 15 ms each, 0.5 s in all, holding the engine lock; its threads
   wait 0.8 s for the lock in total, Inkscape's 1.8 s.
5. **ld.so symbol lookups**: 2 to 16%.
6. **fontconfig reading its configuration**: every app that draws text
   through Xft, Pango or Qt parses `/etc/fonts/fonts.conf` and conf.d with
   expat, 20 to 30 M instructions, 0.1 to 0.25 s: 62% of xclock's launch,
   19% of FeatherPad's and Dillo's, 9% of L3afpad's, 3% of Geany's. The
   font caches themselves are used (no directory scan).
7. **Xlib reading the Compose file** (Xlib, Xt and FLTK apps): Dillo and
   xterm spend 25 to 35% of their launch in `parsestringfile`, `nexttoken`,
   `nextch` and `getc`: Xlib's input method parsing the locale's Compose
   file.
8. **The first launch in a page**: 0.2 to 0.5 s more, for the D-Bus session
   bus and the engine's own start.
9. **Install** (cold only): 0.7 s (xeyes, 10 MB) to 9.3 s (Inkscape,
   83 MB), almost all of it waiting for packages to be fetched and decoded.
10. **GIMP's first start**: 115 processes and 6.7 GB of file reads to query
    every plug-in, 75 s of its 105.

Per app, what stands out beyond the common part:

| App | Instructions | By library | Notable |
|---|---:|---|---|
| xeyes | 8 M | libX11 39%, libc 30%, ld.so 16% | `resolve_name` (the locale tables) 30% |
| xclock | 32 M | expat 34%, fontconfig 28%, libc 18% | fontconfig's configuration is the launch |
| xterm | 86 M | libX11 43%, libc 25% | Compose 26%, `getc` 9.5% |
| dillo | 120 M | libX11 30%, libc 25%, fontconfig 10%, expat 9%, Xft 8% | Compose 18%, `getc` 7%, glyph rendering 7% |
| gpicview | 55 M | GLib 27%, libc 27%, ld.so 16% | symbol lookups 10% |
| l3afpad | 246 M | GLib 27%, libc 22%, GTK 16%, ld.so 9%, GObject 8% | fontconfig + expat 9% |
| galculator | 416 M | GLib 22%, GTK 18%, libc 18%, GObject 16% | cairo 4% (its buttons) |
| geany | 994 M | GObject 29%, GLib 21%, GTK 20%, libc 15% | interface checks 19% |
| mousepad | 833 M | GObject 31%, GLib 27%, libc 17%, GTK 9%, libxml2 4% | GtkSourceView's language files; its compiled code runs at 92 M/s, the slowest of the corpus |
| featherpad | 124 M | libc 17%, ld.so 15%, fontconfig 10%, QtGui 10%, expat 9% | 20% of its instructions interpreted |
| inkscape | 2,965 M | GLib 25%, libc 20%, librsvg 7%, GTK 7%, libxml2 7%, ld.so 6% | UTF-8 normalization 10% (`_g_utf8_normalize_wc`, `g_unicode_canonical_ordering`, `combine`), SVG icons rendered at start |
| gimp (warm) | 6,964 M in 8 processes | GLib 24%, GObject 16%, libc 13%, libX11 9%, zlib 7%, babl 6%, GDK 5.5%, libpng 4% | client-side image work: `composite_0888`, `_XPutPixel32`/`_XGetPixel32`, babl's lookup tables, PNG decoding |

### The candidates, against these numbers

| Candidate | Finding |
|---|---|
| Prebuilt caches (fontconfig, icon themes, MIME, GSettings schemas, gdk-pixbuf loaders) | Already in place and used: no directory scan, no cache write in any launch (the installer ships or builds them: docs/GUI.md). What remains is reading configuration, items 6 and 7. `ld.so.cache` is missing, and it doesn't matter: all of Geany's opens, the failed ones of the library search included, are within its 34 ms of kernel CPU. |
| GIMP's plug-in registry (`pluginrc`) | Worth 75 s of the first start. See "What changed". |
| Recorded read-ahead of file chunks | Nothing to read ahead. Outside Debian mode the packages are unpacked into the tab's filesystem, and a launch reads its 65 to 290 MB of mappings in a few ms. |
| A translated-code cache across page loads | Bounded by item 3: at most 11 to 19% of a launch, less the code generation that would still run. Not built. |
| Session services kept warm | The bus is started once per page, and costs the first launch 0.2 s. No app in the corpus waits on a probe that cannot succeed (the accessibility bus is off: `NO_AT_BRIDGE`, `GTK_A11Y=none`). |
| A slow system call, a polling sleep, per-file round trips | None: item 1's 1%. |

So the launch is compute, and the engine is the lever: fewer instructions
per window (items 6, 7 and what a toolkit can be told to skip), a faster
engine (items 1 to 4, the engine owners' work), or not running the start-up
at all: a snapshot of the started process.

## What changed

Each change is measured against the corpus, before and after, back to back.
