# Java: compile and run in 3 seconds

2026-10-13, branch unix/java-fast. For tabcomputer#121 (`javac Hello.java`
took 50–100 s) and #122 (the JVM exited 139 when given a tuning flag).

**Since (Blink patch 0553, the same day).** The emulator now compiles what
HotSpot generates ([BLINK_RWX_JIT.md](BLINK_RWX_JIT.md)): `java Sieve` takes
1.6 s where it took 15.5 s, the real `javac Hello.java` 12.7 s cold where it
took 20.9 s, `jshell` answers `1+1` in 45 s where it took 70 s (the same
machine, measured there). What follows is as it was written before that
patch; where it says the interpreted code "takes most of the time", that
document's profile says a third, for javac.

**Result.** After the first compile of a page load, `javac Hello.java &&
java Hello` takes about 1.4 s and the same for a 15-line class with an
ArrayList about 2 s (measured below). The first compile still takes about
half a minute. The three flags of #122 run.

| | before | now |
|---|---:|---:|
| `javac Hello.java`, 2nd and later | 33 s | 0.35 s |
| `javac Bank.java`, 2nd and later | 46 s | 0.76 s |
| `java Hello` | 1.7 s | 1.0 s |
| `java Bank` | 3.6 s | 1.2 s |
| `javac Hello.java`, first of a page load | 33 s | 27–35 s |
| `java -Xint -version` | exit 139 | runs |

`Bank` is the class in "The two programs" below. "Before" is Build 1008 on
the same machine, same day.

## How it was measured

- A local build (`npx vite build`, `server.mjs` with the java layer copied
  from the mirror) in headless Chrome 155 on an Apple M3, isolated page.
  Times are of a shell line run in a terminal-less shell fork, as
  `scripts/browser-check.mjs` does, or `date +%s%N` around a command
  inside one line.
- The machine was shared: load average 3–7 during the runs quoted, unless a
  row says otherwise. Rows give the median of 3 or 5 runs, or the range. One
  early profile was taken at load 15–24 and is used only for ratios.
- A school Chromebook is slower. Nothing here was measured on one.

### The two programs

`Hello` prints one line. `Bank`:

```java
import java.util.ArrayList;

public class Bank {
  private final ArrayList<Integer> accounts = new ArrayList<>();
  void deposit(int amount) { accounts.add(amount); }
  long total() { long sum = 0; for (int a : accounts) sum += a; return sum; }
  public static void main(String[] args) {
    Bank b = new Bank();
    for (int i = 0; i < 1000; i++) b.deposit(i);
    System.out.println("accounts " + b.accounts.size() + " total " + b.total());
  }
}
```

`Sieve` (a sieve to 3 million and a 30-million-step loop) stands for a
program that computes.

## Where the time goes

`javac Hello.java` is 33 s here (33.4, 35.8, 32.4). On the same Mac outside
the tab, the same JDK version takes 0.22–0.36 s.

1. **The emulator interprets everything HotSpot generates.** Blink compiles
   x86 code to WebAssembly only from pages that are not writable
   (docs/X86_ENGINES.md, "Safety"). HotSpot's code cache is read-write-execute
   memory, so its bytecode interpreter (generated at start) and every method
   its JIT compiles run in Blink's own interpreter, one instruction at a
   time. `SHIRO_BLINK_PROFILE` on `javac Hello.java`: 2.40 G guest
   instructions ran as compiled WebAssembly (libjvm, libc) and 0.45 G were
   interpreted, of which 0.27 G "compile failed before" and 0.16 G "not at a
   branch target"; the sampled addresses of the interpreted ones are in the
   code cache. The interpreted sixth takes most of the time. `Sieve` shows
   the cost alone: 18.9 s in the tab, 0.07 s on the Mac.
2. **The JIT's threads take turns with the program.** Blink runs one guest
   thread at a time. In that profile the Java main thread ran 70 s and waited
   79 s for the engine, while HotSpot's two compiler threads ran 39 s and
   37 s and the collector's threads about 10 s. With C1 only and the serial
   collector, `javac Hello.java` is 22.9 s (24.0, 22.4, 22.9): a third less.
3. **javac starts cold every time.** In a JVM that is already up and has
   compiled once, the same compile takes 2.3–3.1 s with a new compiler
   context (4.4–4.7 s for `Bank`). So about 20 of the 23 s are the JVM
   starting, javac's classes being loaded and verified (they are not in the
   JDK's class-data archive), and javac running its first pass through the
   bytecode interpreter.
4. **Most of a warm compile is javac setting itself up.** javac builds its
   symbol table and reads `java.lang` and friends from the runtime image for
   every compile. Keeping that context between compiles (`JavacTaskPool`,
   what jshell uses) cuts a warm one-file compile to 0.3–0.8 s here. On the
   Mac with `-Xint`, the same change is 190 ms → 9.5 ms.

Class-data sharing is already doing its part: `java -Xshare:off Hello` is
4.0–4.7 s against 1.7 s.

## #122: the segfault

Cause: a bug in Blink's `FindVirtual`, which picks the address for
`mmap(0, …)`. It walks the page tables and, where an entry at some level is
missing, counts that entry's whole span (2 MiB, 1 GiB) as free. When the
address it is looking at is in the middle of the span, that counts more than
was looked at, and the last part of the range is never checked. A mapping
there is handed out a second time.

What happened in the JVM (`SHIRO_BLINK_CRASH=2`, `SHIRO_BLINK_MMLOG=1`):

1. glibc gives the Java main thread a malloc arena: `mmap(0, 128 MiB)`,
   trimmed to a 64 MiB boundary. That leaves a hole of 0x3fb4000 bytes
   (just under 64 MiB) below the arena, at 0xc804c000.
2. With `-Xint` or `-XX:TieredStopAtLevel=1` the code cache is smaller, and
   a later 64 MiB reservation (`mmap(0, 0x4000000, PROT_NONE)`) is the first
   to try that hole. Blink returned 0xc804c000: the range ends 0x4c000 bytes
   inside the arena. HotSpot unmapped it again, and the arena's first pages
   went with it.
3. The next `malloc` read the thread's cache there and faulted. HotSpot's
   signal handler read the `Thread` object, in the same pages, and faulted
   again, each time one signal frame deeper, until the stack ran out:
   exit 139.

Without those flags the reservations happen to be other sizes, so it was
luck that plain `java` ran. `MALLOC_ARENA_MAX=1` also avoided it.

Fix: Blink patch 0552, one line (a missing entry counts only to the end of
its span). `public/engines/blink/` is rebuilt from the patch series with
emsdk 6.0.11. `tests/browser/java-fast.mjs` runs the three commands;
`fixtures/x86/mmaphole.c` does the same reserve, trim and reserve in C
(compiled with Debian's gcc in the tab: it reports the overlap on the old
engine and none on the new).

## The cheap routes, measured

Compile and run, both programs. "Warm" means a JVM that has compiled before.

| Route | `javac Hello` | `java Hello` | `javac Bank` | `java Bank` | Notes |
|---|---:|---:|---:|---:|---|
| Build 1008 | 33.4 s | 1.7 s | 46.2 s | 3.6 s | |
| `-XX:TieredStopAtLevel=1 -XX:+UseSerialGC` | 22.9 s | 1.1 s | 30.3 s | 2.8 s | **shipped** as the default |
| the same, `-XX:-UsePerfData -XX:CICompilerCount=1 -Xmx256m` | 21.6 s | | | | no better than noise |
| `-Xint` | 100.8 s | 0.9 s | | 2.4 s | one run of javac; `Sieve` 149 s against 18.9 s |
| Zero VM (`openjdk-21-jre-zero`, `-zero -Xshare:off`) | 28 s | 4.0 s | 43 s | 3.9 s | load 12; Debian's Zero archive doesn't match its `modules` file, so no CDS |
| `-XDstringConcat=inline` for javac | | | | 1.5 s | against 2.9 s for the same class; **shipped** |
| warm JVM, a new javac context per compile | 2.3–3.1 s | | 4.4–4.7 s | | Javad's `m` op |
| warm JVM, context kept (`JavacTaskPool`) | **0.35 s** | 1.0 s | **0.76 s** | 1.2 s | **shipped**: the `javac` command |
| warm Zero VM, new context | 3.7 s | | 7.1 s | | load 6–12 |
| warm JVM, ECJ 3.38 | 19 s | | 20 s | | ECJ reads the runtime image again for every compile |
| warm JVM also runs the class | | 0.1–0.2 s | | 0.1–0.2 s | Javad's `r` op; not shipped, see below |
| dynamic class-data archive of javac's classes | | | | | starts the warm JVM in 27–28 s instead of 34–42 s; not shipped |

- Rows for the warm JVM other than the shipped one were timed by
  `JavadClient`, a Java client whose own `ping` takes 1.1 s; that is
  subtracted. The shipped row is the `javac` command itself.
- `java Sieve`: 23.3 s with HotSpot's defaults, 18.9 s with C1 and the
  serial collector. So C1 is the better default for programs that compute,
  too.
- ECJ is not a way out: it is slower cold than javac was warm.
- Running the class in the warm JVM is ten times faster than a new JVM, but
  a program that loops forever can't be stopped there (no `Thread.stop`
  since Java 20), `System.exit` needs the deprecated security manager, and
  static state would leak from run to run. A second, idle JVM that takes one
  program and exits would give most of it safely; it is not built.

## What shipped

1. **Blink patch 0552** (#122), with the engine rebuilt.
2. **JVM options by default** (`src/java-defaults.ts`). When the shell or
   the kernel starts a launcher in `/usr/lib/jvm/*/bin/`, it puts
   `-XX:TieredStopAtLevel=1 -XX:+UseSerialGC` first (`-J…` for `javac`,
   `jshell`, `jar` and the rest), and `-XDstringConcat=inline` for `javac`.
   An option of the user's comes later and wins; a collector or compiler
   choice of the user's (also in `JAVA_TOOL_OPTIONS`) leaves ours out.
   `TABCOMPUTER_JVM_DEFAULTS=0` turns it off.
3. **A warm `javac`** (`src/commands/java.ts`, `scripts/java/Javad.java`,
   `public/java/javad.jar`, 14 KB). `javac` at the prompt is a builtin that
   sends the compile to a JVM that stays up (Javad). `toolchain install
   java` starts it in the background; otherwise the first `javac` of a page
   load does, and says so. It exits after 30 minutes without a compile.
   - Javad keeps javac's context between compiles and forgets everything
     that came from the user's directories after each one, so a class file
     that was rebuilt, deleted or belongs to another directory is read again.
   - It takes plain compiles: `.java` files, `-d`, `-cp`, `-g`, `-Xlint…`,
     `-encoding`, `-nowarn`, `-deprecation`, `-Werror`, `-parameters`. For
     anything else (`-version`, `--release`, modules, processors, a jar on
     the class path, `-sourcepath`) it answers "not mine" and the real javac
     runs. So does it when Javad can't be started or reached.
   - `TABCOMPUTER_JAVAC=jvm` always runs the real javac. `/usr/bin/javac`,
     and `javac` run by another program (make, `sh -c`), are the real one.
     `javac --tabcomputer-status` and `--tabcomputer-stop` show and stop
     Javad.
4. Tests: `scripts/java/test.sh` (Javad against the real javac over 43
   steps of edits: messages, exit statuses and class files byte for byte),
   `tests/tests/shiro-vitest/javac-warm.test.ts` (the client's protocol and
   the option rules), `tests/browser/java-fast.mjs` (the tab, end to end).

Measured with what shipped (5 rounds, load 4–7; `javac && java` is the sum):

| | `javac` | `java` | sum |
|---|---:|---:|---:|
| Hello | 0.29–0.61 s | 1.00–1.10 s | 1.4 s |
| Bank | 0.68–0.94 s | 1.14–1.26 s | 2.0 s |
| a new 1-line program using `Scanner`, with `echo 21 \|` | | | 3.9 s |

The real javac with the default options: Hello 24.5 s, Bank 34.6 s
(37.1 s and 41.1 s with `TABCOMPUTER_JVM_DEFAULTS=0`). `java Hello.java`
(the source launcher): 24.3 s, was 36–42 s.

Memory: Chrome's processes held 726 MiB before Java and 934 MiB after
these runs with Javad up, and 853 MiB a few seconds after it was stopped
(`ps` on the host; a rough figure).

### What it does not fix

- The first compile of a page load: 27 s when `toolchain install java` had
  just started Javad, 35 s when `javac` starts it. A reload ends Javad.
  A tab that ran `javac` in the last 7 days starts Javad again by itself
  5 s after boot (`scheduleJavacPrestart` in `src/java-defaults.ts`;
  `TABCOMPUTER_JAVAC_PRESTART=0` turns it off). Measured on a Mac, system
  Chrome headless, local build, 2026-10-13, `javac Hello.java` typed 60 s
  after a reload, two rounds: 41.1 s and 40.2 s without it, 0.7 s and 0.8 s
  with it. A `javac` typed before the compiler is up waits for the same
  one; that case was not timed.
- `jshell`: 105 s to evaluate `1+1` (91 s in #121). It compiles each
  snippet in a JVM of its own.
- `java Hello.java`: 24 s. The source launcher compiles in its own JVM.
- A program that computes: `Sieve` 18.9 s.

## Nothing new to host

`javad.jar` and the engine are part of the build (`public/`). The java
layer on the mirror is unchanged.

Two things a rebuilt java layer could add later (`toolchains.json`
`prepare`, run by `build-layers.sh` on the droplet), neither needed for the
numbers above:

- a dynamic class-data archive of Javad's classes
  (`-XX:ArchiveClassesAtExit`, 11.5 MB), used with `-XX:SharedArchiveFile`:
  the first compile about 7–14 s sooner;
- `java -zero -Xshare:dump`, if the Zero VM is ever wanted: Debian's
  archive for it is stale.

## The WebAssembly routes (assessed, not built)

From the projects' own pages, read 2026-10-12; nothing here was run. Speeds
marked "claim" are the source's; "estimate" is a guess.

| Route | Licence | Gives `javac` and `java`? | Expected speed | Cost to adopt | Main risk |
|---|---|---|---|---|---|
| **CheerpJ 4.3** (a JVM in wasm with a bytecode JIT, OpenJDK class library; Java 8, 11, 17) | Proprietary. Free for FOSS and personal use, but the free tier loads the runtime from the vendor's CDN and forbids self-hosting; self-hosting needs a commercial licence | Both. JavaFiddle runs Java 8's javac from `tools.jar` | No published numbers. Estimate: 5–10 s first, 2–4 s after | 1–2 weeks for a `javac`/`java` outside the kernel, plus a licence | Licence; no documented blocking stdin; its own filesystem (`/files/` in IndexedDB), not tabcomputer's |
| **TeaVM 0.13 + teavm-javac** (javac and TeaVM compiled to one wasm; each program becomes a new wasm module) | Apache-2.0, javac GPLv2+Classpath | `javac` yes. No JVM: no class loading or reflection, and TeaVM's own class library (java.util 62 % complete) | Estimate: 1–3 s | 2–3 weeks, with a `Scanner` and stdin to write | `System.in` throws EOF in its class library; programs behave differently from a JVM |
| **GraalVM Web Image** (`native-image --tool:svm-wasm`, javac as wasm) | Oracle GraalVM (GFTC: free to use and redistribute, not open source); experimental, not in the Community Edition | `javac` only. Closed world: can't run a class file | 69 ms to compile a sample class in Chrome (a third-party report), 27 MB wasm | 1–2 weeks for `javac`; `java` still the emulated JVM | Experimental; no threads; not WASI |
| **GraalVM native-image javac, x86-64** (under the emulator) | as above, or GPLv2+CE with the Community Edition | `javac` only | Estimate: 3–15 s. No JVM start and no code cache, so Blink compiles all of it | 2–4 days to try | Needs a build per JDK; `java` unchanged |
| **OpenJDK 21 Zero compiled to wasm** (JavaBox: emscripten, interpreter only, a warm compile server inside) | OpenJDK GPLv2+CE; the port's own glue has no licence file | Both, Java 21 | Claim: 3–5 s to boot, under 1 s to compile and run after. 76 MB | 1–2 weeks hosted as it is in a Worker; 4–8 weeks or more as a WASIX process of the kernel | A hobby port (9 commits); its notes say GC and finalizer threads may not start |

Sources: [CheerpJ 4.3](https://labs.leaningtech.com/blog/cheerpj-4.3),
[its licence as an open project met it](https://plantuml.com/faq-licence-cheerpj),
[JavaFiddle](https://github.com/leaningtech/javafiddle);
[TeaVM 0.13](https://www.teavm.org/docs/release-notes/0.13.0.html),
[teavm-javac](https://github.com/konsoletyper/teavm-javac),
[its class library report](https://teavm.org/jcl-report/recent/jcl.html),
[`TConsoleInputStream`](https://github.com/konsoletyper/teavm/blob/master/classlib/src/main/java/org/teavm/classlib/java/lang/TConsoleInputStream.java);
[GraalVM Web Image](https://www.graalvm.org/dev/reference-manual/web-image/),
[its javac demo](https://github.com/graalvm/graalvm-demos/tree/master/web-image/javac),
[the size and time report](https://github.com/openjavaformat/open-java-format/issues/21);
[JavaBox](https://github.com/bmarti44/javabox);
[jdk-dev on an emscripten port, 2024](https://mail.openjdk.org/pipermail/jdk-dev/2024-August/009321.html).
The CheerpJ licence pages themselves refused the fetch; its terms above are
from the 4.3 announcement and PlantUML's FAQ.

What the Zero measurements here say about the last row: HotSpot's Zero
interpreter as x86 code under Blink compiled a warm `Hello` in 3.7 s, no
faster than C1's output being interpreted (2.3–3.1 s). Compiled straight to wasm it
would skip the x86 layer (a factor of perhaps 3–5, an estimate).

## Recommendation

1. Ship this branch. The edit, compile, run loop is at 1.4–2 s once the
   compiler is up.
2. Hide the first half minute: start Javad when a page that has used Java
   in the last days loads, not only at `toolchain install java`. It costs a
   JVM's memory (about 100–200 MiB) and half a minute of one core, so it
   should follow use. A class-data archive in the layer takes 7–14 s off.
3. The real fix is in the emulator: compile code from writable pages, with
   writes to a page that has compiled code dropping it. Everything HotSpot
   generates would then run as WebAssembly instead of being interpreted. The
   same holds for V8 in Debian's `node` and for JavaScriptCore in native
   Claude Code (which is why that runs with its JIT off). `Sieve` at 270
   times native is the measure of what is there to gain.
4. After that, an idle JVM that runs one program and exits (0.1–0.2 s
   instead of 1 s per run), and `java X.java` and `jshell` through Javad.
5. Of the WebAssembly routes, only a JVM compiled to wasm (the JavaBox kind)
   gives both commands with a licence tabcomputer can ship, and it is weeks
   of work on a port nobody maintains. It is worth a look only if step 3
   turns out not to be feasible.
