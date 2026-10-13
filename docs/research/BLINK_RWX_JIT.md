# Blink: compiling the code other JITs generate

2026-10-13, branch unix/blink-rwx-jit, Blink patch 0553. For tabcomputer#52
and the third recommendation of [JAVA_SPEED.md](JAVA_SPEED.md).

x86-64 programs run in the Blink emulator, whose JIT (`blink/wjit.c`,
[X86_ENGINES.md](../X86_ENGINES.md) "The wasm JIT") turns hot guest code
into WebAssembly. It compiled only from pages that are not writable. A
runtime that generates code keeps it in memory it can write, so that code
ran in Blink's interpreter, one instruction at a time. With patch 0553 the
JIT compiles code in writable pages too, and drops what it compiled when
the bytes it came from are written.

**Result.** Code that computes inside a JIT's output is about ten times
faster in the JVM and three times faster in node; a cold `javac` is a third
faster; programs that generate no code are unchanged. The switch is ON
(`BLINK_WJIT_RWX`, default 1): every check below passes on it, and the
cost to a program without generated code is under what could be measured.

| | Build 1014 | patch 0553 |
|---|---:|---:|
| `java Sieve` | 15.5 s | **1.6 s** |
| `node loop.js` (Debian's node 20) | 25.6 s | **9.0 s** |
| `javac Hello.java`, the real javac, cold | 20.9 s | **12.7 s** |
| `jshell`, to the answer of `1+1` | 70 s | **45 s** |
| `java Hello` | 0.99 s | 1.02 s |
| `luajit loop.lua` | 3.35 s | 3.35 s |
| `gcc -O2` of jitfuzz.c | 16.7 s | 16.7 s |
| Debian's `python3`, a loop | 3.07 s | 3.16 s |
| `go build` of a small program | 3.5–6.1 s | 3.5–6.0 s |

Medians; "Before and after" has the method, the ranges and the load.

## What the JIT did before

- `CodePage()` in wjit.c gave the JIT a code page only if its page table
  entry was user, executable and not writable (and not copy-on-write).
  A block on any other page failed to compile, and its entry was marked
  failed for good ("compile failed before" in `SHIRO_BLINK_PROFILE`).
- Compiled regions are kept per thread in a hash table from guest pc to a
  slot of that thread's wasm function table. They were dropped all at once:
  munmap or mprotect of an executable page (and a copy-on-write break of
  one) bumps a global epoch, and each thread clears its table at its next
  entry into compiled code.
- Nothing watched writes. It didn't have to: a page that could be written
  was never compiled, and the interpreter decodes from the bytes each time
  (its decoded-instruction cache compares them).
- Patches 0134–0145 are about how fast compiled code runs once it exists:
  0134 compiles small callees into their caller's region and enlarged the
  translation caches, 0138 hands the GIL over when a compiled loop spins,
  0139–0142 and 0145 translate more instructions inline (scalar SSE,
  movnt, andps/orps, bswap, locked read-modify-writes), 0143–0144 are a
  profile option and an interpreter flag fix. None of them changed which
  pages are compiled.

The claim, measured with `SHIRO_BLINK_PROFILE` on Build 1014's engine
(guest instructions; this Mac, headless Chrome, a local build):

| Program | interpreted | of them on a page that failed to compile | in compiled code |
|---|---:|---:|---:|
| `java Sieve` (a sieve to 3 million and a 30-million-step loop; C1, serial GC) | 629 M | 618 M | 34 M |
| `node loop.js` (Debian's node 20: the same two loops in JavaScript) | 941 M | 911 M | 404 M |
| `javac Hello.java` (the real javac, cold) | 385 M | 292 M | 1,328 M |

So the claim holds for code that computes: 95% of the sieve's instructions
and 70% of node's ran interpreted. A cold javac is mostly libjvm's own code,
which was compiled all along; "Why a cold javac gains less" below.
LuaJIT is not in the table: it makes its code read-and-execute before it
runs it, so the JIT compiled it already (0 regions from writable pages with
the patch, and the same 3.4 s).

## The choices

1. **Write tracking in the soft MMU**: a store to a page that holds
   compiled code is noticed and drops that code. Exact, and nothing is
   paid by a program without such pages if the test rides on a branch the
   store path already has.
2. **A checksum of the code at each entry.** A region is entered tens of
   millions of times in a start of Claude Code or javac (73 M and 54 M:
   #52, the profile below), and a region is up to 640 instructions, so the
   check would cost more than the code it guards. It also notices a change
   only at the next entry, not inside a loop that patches itself.
3. **Compile only pages that have been stable for a while, deoptimize on a
   write.** This still needs (1) to see the write. As a rule for *when* to
   compile it is already there in another form: a block is compiled after
   200 executions, and a page that is written more than it is run is given
   back to the interpreter (below).

Picked: (1), with the page as the unit that is marked and 64 bytes as the
unit that is invalidated, plus the back-off of (3).

## The design

The rules are also at the top of the section "code on writable pages" in
wjit.c.

**The mark.** A writable page that code is compiled from gets a bit in its
page table entry, `PAGE_WJC`. Only a private anonymous page of the process
is taken (not a shared mapping, a page still shared with a forked child, a
file's page, or an object shared with another instance): nothing else can
write it behind the emulator's back.

**No write goes around it.** Compiled code stores through a per-thread
cache of write translations (guest page to host page), with no call. A
marked page is never put in that cache, and when a page is marked the other
threads are told to drop their caches before their next lookup or region
entry. So a store to a marked page from compiled code misses, the region
exits *before* the instruction (the mechanism that already handled faults
and page-crossing accesses), and the interpreter runs it. Every interpreter
access goes through one function, `LookupAddress2`; it is now
`LookupAddressFor`, which takes what the caller will do through the
pointer: only read, write n bytes, or unknown. A lookup that may write a
marked page calls `WjWrote` first. Callers that only read say so (`Load`,
pops, `ReserveAddress` for reading, `CopyFromUser`, `SchlepR`, `LoadStr`,
a read's iovecs, the source of `movs`, an aligned SSE source operand);
any caller that says nothing counts as a write to the whole page, so a path
that was not looked at is safe and at worst drops too much. System calls
resolve their buffers the same way (`read()` into a code page is reported
before the kernel fills it), and `MADV_DONTNEED`, which zeroes pages
without a lookup, reports it itself.

**What is dropped.** Each region records, per marked page, which 64-byte
pieces it was decoded from: its instructions, and the instructions the flag
crawler read past its exits (the region's flag handling depends on them).
A page's code map is one 64-bit word, the union over all threads. A write
that touches a compiled piece goes in a log; every thread reads the log
before it next enters compiled code and drops the regions that depend on
those pieces, and the writer leaves the regions it is in right after the
instruction (`m->attention`, which the code after every handler call and
`WjCall`'s loop already test). A write that touches no compiled piece only
costs the slow path. So HotSpot installing a method next to a running one,
or patching a call site in code that is not hot yet, drops nothing.

**Back-off.** A marked page makes every store to it slow, and a dropped
region costs a compile. A page that takes 2048 slow writes within a second
(a write that hits code counts as 64) is given up: its regions are
dropped, the mark is cleared, writes are fast again, and it is not taken
again for 0.5 s, doubling each time up to 32 s. A page left alone for a
minute starts over. When no compiled piece is left in a page (a code
buffer that is being refilled) the mark is cleared at the next write. The
worst a page of mixed code and data costs is therefore bounded, and
otherwise it runs as it did before: interpreted.

**Code that is patched in place often.** An inline cache or a HotSpot call
site is patched a few times and then left alone; each patch drops the
regions over those 64 bytes, and the block is compiled again after another
200 executions. Code that is patched forever ends in the back-off.

**Code and data on one page.** Data in another 64-byte piece: every write
is slow, nothing is dropped, and the back-off decides. Data in the same
piece as the code: every write drops the region, and the back-off decides
sooner.

**Instructions and writes across pages.** An instruction that continues on
the next page marks both pages and depends on pieces of both. A store
across two pages is two lookups, each with its own length.

**Threads.** One guest thread runs at a time (the GIL), and each thread has
its own regions.
- The writer holds the GIL, so no other thread is in a region. Each reads
  the log before its next entry.
- A thread inside a system call runs without the GIL. It has resolved its
  buffers already and holds their pages locked: a locked page is not
  compiled from (the compile is tried again later). When such a thread
  resolves a buffer in a marked page, the whole page's regions are dropped,
  and a region whose compile was under way at that moment is not entered.
- A thread can also let the GIL go in the middle of an instruction (a page
  fault's kernel call, a shared object's lease) while it holds an address
  it resolved earlier. While any thread is in that state, no writable page
  is compiled from.
- With `BLINK_GIL=0` writable pages stay with the interpreter.

**mprotect as a signal.** A W^X JIT (LuaJIT, older V8) makes its code
read-and-execute before running it, so the JIT compiled it before this
patch too; every flip to writable dropped every region of every thread, and
still does. The patch does not use mprotect as a hint. See "What remains".

**The switch.** `BLINK_WJIT_RWX=0` in the program's environment leaves
writable pages to the interpreter. The lookup changes are compiled in
either way; with no marked page they do nothing.

## What it costs a program that never generates code

By construction:
- a store in compiled code: nothing (the inline path is unchanged; a miss
  of the translation cache tests one more bit of an entry it has loaded);
- a store in the interpreter: nothing (the test of `PAGE_WJC` is the
  copy-on-write test's branch with a wider mask);
- an entry into compiled code: nothing (the same compare of one epoch).

Measured:

- In Node, where runs repeat within 1–2% (vitest's kernel, the fixtures
  built with clang and musl; each engine run 4 times, alternating, 4 runs
  each time; the fastest run, ms). `stores.c` writes bytes, words and
  unaligned words, calls a function 400,000 times a round, copies and
  clears a megabyte and walks a linked list writing each node. Nothing
  here is slower:

  | | Build 1014 | patch 0553 |
  |---|---:|---:|
  | `stores` 150 rounds, compiled | 1723 | 1706 |
  | `stores` 6 rounds, `BLINK_WJIT=0` | 1269 | 1266 |
  | `jitfuzz 300000`, compiled | 2471 | 2443 |
  | `jitfuzz 6000`, `BLINK_WJIT=0` | 1721 | 1666 |

  The first build of the patch was 1–3% slower in the two interpreter
  rows: `LookupAddress2` had become a call into the new function, and this
  build has no tail calls. The lookup is now inlined into each of its
  entry points.
- Native Claude Code's signed-out `claude -p hi` in Node, four runs per
  engine, alternating: 10.76 s and 10.83 s (medians; 10.70–11.15 and
  10.53–10.92).
- In the tab (the table under "Before and after"): gcc, Debian's python3,
  `go build`, native Claude Code, and jitfuzz built by gcc show no
  difference that survives a second round or a quieter harness. Their profiles say why:
  0 pages marked, 0 regions compiled from writable pages, and the same
  number of compiled blocks run and instructions interpreted on both
  engines (python3: 502,302 and 502,275 blocks, 6.73 M instructions both).

So the cost is below what either harness can resolve, and well under the
3% that would have kept the switch off.

## The fixtures

`tests/tests/shiro-vitest/fixtures/x86/smcjit.c`, run by `x86-smc.test.ts`.
Each case checks itself. All pass with the defaults, with
`BLINK_WJIT_RWX=0` and with `BLINK_WJIT=0`; `BLINK_WJIT_RWX=3` compiles
writable pages and ignores the writes (`=4` ignores mprotect and munmap
too), and there each case fails, which is what shows it can catch a
missing invalidation.

| Case | What it does | What it catches |
|---|---|---|
| `overwrite` | a hot function in an RWX page is rewritten 12 times, then only its immediate, a byte at a time | a store from compiled code to a compiled piece |
| `patchimm` | a hot loop in an RWX page calls a C function every 1024 passes, which adds one to the loop's own immediate | the region that is running being rewritten by its callee (`WjCall` unwinding, the same region compiled again and again) |
| `codedata` | a function adds to a counter on its own page: far from the code, then 4 bytes behind it; the code is rewritten twice | writes beside the code (slow, nothing dropped, the back-off) and writes into the code's own 64 bytes |
| `straddle` | an instruction whose immediate crosses a page boundary, patched by one 4-byte store across it; a function in the second page rewritten by an 8-byte store that starts in the first; code that falls from one page into the next | per-page lengths of a crossing store, dependencies on two pages |
| `wx` | RW → RX → RW twelve times, and RWX → RX → RWX with a rewrite | mprotect dropping regions; a marked page that stops being writable and becomes writable again |
| `refill` | 96 small functions in a 16 KiB buffer, run, the buffer filled again with others at other offsets (byte stores, then memcpy), eight times | bulk writes through libc and string instructions, clearing the mark when no code is left |
| `thread` | one thread calls a function in a loop; another rewrites it 20 times with the first parked, then patches its immediate 200 times while it runs | the log reaching another thread's regions before it runs them again |
| `sysread` | `read()` from a pipe and `pread()` from a file put new code in the page | a write by the kernel through a system call's buffer |
| `madvise` | `MADV_DONTNEED` zeroes a page of compiled code, which then runs as 2048 `add %al,(%rax)` into the next page | a page whose content changes without a store |
| `fuzz` | 48 functions sharing 64-byte pieces with their neighbours; 6000 random calls, immediates rewritten, functions moved, bytes around them written; a model says what each call returns | everything together; the checksum is the same with and without the JIT |

A case for a JIT that writes its code through a second mapping of a memfd
was written and dropped: executing from a `MAP_SHARED` mapping of a memfd
segfaults on Build 1014's engine too, with the JIT off as well, so there is
nothing to compare.

## Checks

On the engine of this branch (built from the series with emsdk 6.0.11), a
Mac, 2026-10-13. The C fixtures were built for x86-64 Linux with clang and
musl, since there is no Linux gcc on a Mac; x86-engine.test.ts skips 24
cases there for want of a build.

| Check | Result |
|---|---|
| `x86-smc.test.ts` (the fixtures above, 23 tests) | pass |
| `x86-engine.test.ts` | 140 pass, 14 fail; the same 14 fail on Build 1014's engine with these musl builds |
| `gdb.test.ts`, with Debian's gdb and gcc from the `c` layer | 17 pass |
| `toolchain-layers.test.ts`: `toolchain install c`, `gcc hello.c && ./a.out` | 12 pass |
| `x86-exec-threads`, `x86-phase3`, `blink-crash`, `blink-embryo`, `blink-wjkeep` | pass (2, 14, 7, 3, 3) |
| `tests/browser/java-fast.mjs` (headless Chrome) | 9 steps ok |
| `tests/browser/gui-quit.mjs` (xeyes, Geany three ways) | 4 ok |
| `npx tsc --noEmit -p .` | the 5 known errors |

`scripts/java/test.sh` compares the warm compiler with javac on the host's
JDK; it doesn't run the engine and was not run.

## Before and after

An Apple M3 (8 cores), system Chrome 155 headless, a local build of Build
1015 served by `server.mjs` with the toolchain layers copied from the
mirror; the same build with Build 1014's engine files for "before". Each
row is one shell line in a terminal-less fork of the page's shell, timed in
the page, as `tests/browser/java-fast.mjs` does. One fresh browser profile
per page; the two engines take turns at going first.

The machine was shared with other work the whole time (load 2–7 during the
runs below, 10–27 at other times, which are left out: a page started only
when the one-minute load was under 5). Even so a burst of other work shows
as a run of slow samples, so each row gives the fastest, the median and the
slowest of all samples, and how many.

| | Build 1014 | | | patch 0553 | | | samples |
|---|---:|---:|---:|---:|---:|---:|---|
| | fastest | median | slowest | fastest | median | slowest | |
| `java Sieve` | 15.03 | 15.48 | 24.07 | 1.34 | **1.57** | 2.06 | 12, 4 pages |
| `javac Hello.java` (`TABCOMPUTER_JAVAC=jvm`), cold | 20.66 | 20.93 | 28.02 | 12.18 | **12.74** | 16.36 | 8, 4 pages |
| `java Hello` | 0.97 | 0.99 | 1.06 | 0.94 | 1.02 | 1.33 | 9, 3 pages |
| `jshell`: `printf '1+1\n/exit\n' \| jshell`, to the end | | 69.8 | | | **45.1** | | 1 |
| `node loop.js` (Debian's node 20.19) | 25.20 | 25.63 | 25.97 | 8.93 | **8.95** | 8.98 | 3, 1 page |
| `luajit loop.lua` (LuaJIT 2.1) | 3.33 | 3.35 | 3.36 | 3.31 | 3.35 | 3.42 | 3, 1 page |
| `gcc -O2 -o jf jitfuzz.c` (Debian's gcc) | 16.21 | 16.74 | 23.39 | 15.99 | 16.66 | 22.38 | 16, 4 pages |
| `./jf 30000` (what gcc built) | 0.56 | 0.60 | 0.66 | 0.55 | 0.62 | 0.74 | 16, 4 pages |
| Debian's `python3.13 bench.py` | 3.00 | 3.07 | 3.21 | 3.02 | 3.16 | 3.49 | 10, 2 pages |
| `go build hello.go` after an edit (Go 1.24) | 3.51 | 3.99 / 4.70 | 6.12 | 3.53 | 4.52 / 4.01 | 5.99 | 88, 9 pages |
| `claude --x86 --version` (native Claude Code 2.1.296) | 0.52 | 0.53 | 0.82 | 0.53 | 0.53 | 0.74 | 4, 1 page |
| `claude --x86 -p hi`, signed out, to "Not logged in" | 11.36 | 11.86 | 13.87 | 12.13 | 13.47 | 14.38 | 6, 2 pages |
| the same in Node (vitest's kernel), engines alternating | 10.70 | 10.76 | 11.15 | 10.53 | 10.83 | 10.92 | 4 |
| the binary with `BUN_JSC_useJIT=1`, `-p hi` | 17.39 | 17.54 | 17.69 | 17.68 | 18.58 | 19.48 | 2, 1 page |

- `Sieve` is the class in JAVA_SPEED.md; `loop.js` is the same sieve and
  loop in JavaScript; `loop.lua` a 100-million-step loop and a table walk;
  `bench.py` a million-step loop, 300,000 dictionary inserts and a sort.
  `java` runs with the options tabcomputer gives it (C1 only, serial GC).
- `go build` has two medians: the samples come from two sets of pages, and
  the engine that was behind in one (40 builds each) was ahead in the other
  (48 each). A page of 25 builds in a row shows stretches of five or six
  slow builds on either engine. The fastest builds are the same.
- Python's 3% is one of its two pages (3.12 and 3.12 in the other); gcc's
  slowest page was the new engine's and its fastest too.
- Claude Code's `-p hi` generates no code (`claude --x86` runs Bun with its
  JIT off: 0 pages marked) and was 7–13% slower on the new engine in both
  of its pages in the tab. The same command in Node, where a run repeats
  within 2%, is the same on both engines (10.76 and 10.83 s), so that is
  taken as the pages' share of the machine's noise, like gcc's and Go's.
- With JavaScriptCore's JIT on, Claude Code's start is no faster than
  before, and still slower than with it off: 80 M instructions interpreted
  where there were 143 M, 753 regions compiled from 223 marked pages, 316
  of them dropped again, and the time is the same. Its start is the JIT
  compiling, not what it compiled running. `claude --x86` keeps the JIT off.
- On the Mac itself `java Sieve` takes 0.07 s (JAVA_SPEED.md), so the sieve
  went from about 220 times native to about 22.

Counts from `SHIRO_BLINK_PROFILE` with the patch:

| | interpreted | in compiled code | regions from writable pages | pages marked | writes that hit code / beside it | regions dropped | pages given up |
|---|---:|---:|---:|---:|---:|---:|---:|
| `java Sieve` | 9.3 M | 657 M | 169 | 26 | 3 / 932 | 1 | 0 |
| `node loop.js` | 22.8 M | 5,123 M | 25 | 11 | 3 / 975 | 4 | 0 |
| `javac Hello.java` | 71 M | 1,626 M | 2164 | 424 | 323 / 46,565 | 575 | 6 |
| gcc, python3, `go build`, `claude --version` | | | 0 | 0 | 0 | 0 | 0 |

node runs 5.1 G instructions where it ran 1.35 G: with the program itself
faster, more of the loop is over before V8's optimizing thread, which
shares the one lock, has its code ready, so more of it runs in V8's
baseline code. It is still three times faster.

## Why a cold javac gains less than the sieve

`SHIRO_BLINK_PROFILE` on `TABCOMPUTER_JAVAC=jvm javac Hello.java`, both
engines, the same page load each (load 5–7, so the times are high; the
counts don't depend on load):

| | Build 1014 | patch 0553 |
|---|---:|---:|
| instructions interpreted, all threads | 385 M | 71 M |
| of them "compile failed before" (a writable page) | 292 M | 0.09 M |
| instructions run in compiled code | 1.33 G | 1.63 G |
| the Java main thread: holding the GIL | 30.8 s | 21.4 s |
| the Java main thread: waiting for the GIL | 11.4 s | 17.4 s |
| HotSpot's compiler threads: holding the GIL | 7.8 s + 2.4 s | 8.9 s + 7.8 s |
| entries into compiled code from the emulator's loop | 5.0 M | 15.4 M |
| the JIT's own compiles | 2.3 s | 5.6 s |
| regions compiled from writable pages | 0 | 2164 (575 dropped again) |
| pages marked / given up | | 424 / 6 |
| writes that hit compiled code / fell beside it | | 323 / 46,565 |

(Measured with the first build of the patch, before the lookup was
inlined; the counts are the mechanism's, not that change's.)

1. The interpreted instructions were a third of the main thread's time,
   not most of it (it holds the GIL for 21.4 s where it held it for
   30.8 s). JAVA_SPEED.md's "the interpreted sixth takes most
   of the time" came from the profile's 1-ms samples, which over-count the
   interpreter (#52 says why).
2. What is left on the main thread is libjvm's own C++ (class loading,
   verification, linking: compiled before the patch too) and the bytecode
   interpreter, which now runs as compiled regions but leaves compiled
   code at every bytecode: its handlers end in an indirect jump, so the
   entries from the emulator's loop tripled.
3. The program is faster, so HotSpot's compile queue fills sooner, a
   second compiler thread starts earlier, and the compiler threads get
   through more methods before javac exits: 16.7 s of GIL time against
   10.2 s. Under one lock that is time the main thread waits.

The sieve has none of this: one loop, compiled once, 658 M instructions in
compiled code and 9.6 M interpreted where it was 34 M and 629 M.

## What remains

1. **munmap and mprotect of code still drop everything.** Each region now
   knows the pieces it depends on for marked pages; recording them for
   every page would let both drop only the regions of the pages concerned.
   That is what a W^X JIT needs (each flip of a code page to writable
   empties every thread's table today), and a program that loads and
   unloads libraries.
2. **Dispatch between regions.** A template interpreter (HotSpot's, V8's
   Ignition, JavaScriptCore's LLInt) ends every handler with an indirect
   jump, which leaves the region for the emulator's loop and a hash lookup.
   That, and calls (#52: about 30 ns for a call and its return), is now the
   larger cost of a JVM's start.
3. **The JIT's own threads.** HotSpot's compiler threads and V8's
   optimizing thread take turns with the program under the GIL. With the
   program itself faster, more of its run happens before the optimized
   code is ready.
4. **A second mapping of the same memory.** .NET's default W^X scheme maps
   its code twice from a memfd. That doesn't run at all today (above). When
   it does, a write through the other mapping must reach the page's
   regions: by host page, not by guest address.
5. **Tuning.** The 64-byte piece, the 2048 writes a second, the 200
   executions before a compile and the rest times are first guesses that
   the workloads here did not push against (6 pages given up in a cold
   javac, none in the sieve or in node's loop).
6. **Marking a page drops the other threads' whole translation caches.**
   One entry per thread would do.
