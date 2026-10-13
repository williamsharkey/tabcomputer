/**
 * The JVM's options under the x86 emulator (docs/research/JAVA_SPEED.md).
 *
 * The emulator runs one guest thread at a time, and it interprets the code
 * HotSpot generates (its code cache is writable memory, which the emulator's
 * own compiler leaves alone). So HotSpot's optimizing compiler (C2) costs
 * more than it gives back: its threads take turns with the program, and what
 * they produce is interpreted anyway. With only the quick compiler (C1) and
 * the serial collector, `javac Hello.java` takes a third less time and
 * `java Hello` starts in about a second instead of two.
 *
 * The kernel and the shell put these in front of a JDK launcher's own
 * arguments when they start one (Kernel.findProgram, resolveKernelProgram),
 * so they hold for `java`, `javac`, `jshell` and the rest however they are
 * started, and anything the user passes comes later and wins. TABCOMPUTER_JVM_DEFAULTS=0 in the environment leaves the
 * command line alone.
 */

export const JDK_HOME = '/usr/lib/jvm/java-21-openjdk-amd64';

const QUICK_COMPILER = '-XX:TieredStopAtLevel=1';
const SERIAL_GC = '-XX:+UseSerialGC';
export const JVM_FLAGS: readonly string[] = [QUICK_COMPILER, SERIAL_GC];
/**
 * javac compiles `"a" + b` to StringBuilder calls instead of an
 * invokedynamic call. The JVM links each shape of the latter by spinning
 * classes at run time: 1.4 s of the 3 a small program with one such line
 * takes here. The warm compiler (scripts/java/Javad.java) does the same.
 */
const INLINE_CONCAT = '-XDstringConcat=inline';

// ── The warm compiler, started at page load ───────────────────────────────
//
// `javac` (src/commands/java.ts) keeps a JVM up between compiles, but a reload
// ends it and the next first compile waits half a minute for a new one. A tab
// that compiled Java in the last week starts it a few seconds after boot
// instead (main.ts), when the page is idle and visible. It is a JVM in the
// emulator (a Worker and about 200 MB until it has idled for half an hour),
// so not in safe mode, not in a guest without a network, and not for a tab
// that is in the background. TABCOMPUTER_JAVAC_PRESTART=0 turns it off.

/** localStorage: when this tab last ran `javac` (epoch ms) */
export const JAVAC_USED_KEY = 'tabcomputer-javac-used';
const JAVAC_RECENT_MS = 7 * 24 * 3600_000;
export const JAVAC_PRESTART_DELAY_MS = 5000;

export function noteJavacUsed(now = Date.now()): void {
  try { localStorage.setItem(JAVAC_USED_KEY, String(now)); } catch { /* no storage: no prestart */ }
}

export interface JavacPrestartState {
  /** localStorage[JAVAC_USED_KEY] */
  usedAt: string | null;
  now: number;
  env: Record<string, string | undefined>;
  safe: boolean;
  guestNoNetwork: boolean;
  hidden: boolean;
}

/** 'start' now, 'later' (wanted, but the page is hidden: when it is shown), or 'no' */
export function javacPrestartWanted(s: JavacPrestartState): 'start' | 'later' | 'no' {
  if (s.safe || s.guestNoNetwork) return 'no';
  if (s.env.TABCOMPUTER_JAVAC_PRESTART === '0' || s.env.TABCOMPUTER_JAVAC === 'jvm') return 'no';
  const t = Number(s.usedAt);
  // (a time in the future is a changed clock, not a recent compile)
  if (!s.usedAt || !Number.isFinite(t) || t <= 0 || t > s.now + 60_000 || s.now - t >= JAVAC_RECENT_MS) return 'no';
  return s.hidden ? 'later' : 'start';
}

/**
 * After `delayMs`, and then when the page has nothing else to do, call
 * `start` if `check` says so. A hidden page waits until it is shown, and
 * checks again then.
 */
export function scheduleJavacPrestart(o: {
  check(): 'start' | 'later' | 'no';
  start(): void;
  delayMs?: number;
  /** Run `cb` when the page is idle (requestIdleCallback where there is one) */
  idle?(cb: () => void): void;
  onVisible?(cb: () => void): void;
  timer?(cb: () => void, ms: number): unknown;
}): void {
  const idle = o.idle ?? ((cb) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => unknown }).requestIdleCallback;
    if (ric) ric(cb, { timeout: 15_000 }); else setTimeout(cb, 0);
  });
  const onVisible = o.onVisible ?? ((cb) => {
    const on = () => { if (document.visibilityState !== 'visible') return; document.removeEventListener('visibilitychange', on); cb(); };
    document.addEventListener('visibilitychange', on);
  });
  let waiting = false;
  const attempt = (isIdle: boolean) => {
    const c = o.check();
    // (checked again at the idle moment: the page may have been hidden, or javac turned off, since)
    if (c === 'start') { if (isIdle) o.start(); else idle(() => attempt(true)); return; }
    if (c === 'later' && !waiting) { waiting = true; onVisible(() => { waiting = false; attempt(false); }); }
  };
  (o.timer ?? setTimeout)(() => attempt(false), o.delayMs ?? JAVAC_PRESTART_DELAY_MS);
}

/** A launcher in a JDK's or JRE's bin directory (`path` with symlinks resolved): its name, else null. */
export function jdkLauncher(realPath: string): string | null {
  return /^\/usr\/lib\/jvm\/[^/]+\/bin\/([^/]+)$/.exec(realPath)?.[1] ?? null;
}

/** Could `path` (not resolved) be one? Cheap: the names /usr/bin's alternatives use. */
export function mayBeJdkLauncher(path: string): boolean {
  if (path.startsWith('/usr/lib/jvm/')) return true;
  const base = path.slice(path.lastIndexOf('/') + 1);
  return /^(j[a-z]+|keytool|serialver|rmiregistry)$/.test(base);
}

/** A choice of collector or of compiler tiers the user made: ours would contradict it (two collectors are an error). */
const CHOOSES_GC = /-XX:[+-]Use\w*GC\b/;
const CHOOSES_COMPILER = /-XX:TieredStopAtLevel=|-XX:[+-]TieredCompilation|-Xint\b|-Xcomp\b|-XX:CICompilerCount=|-server\b|-client\b/;

/**
 * `argv` for the launcher `tool` with the emulator's options put after
 * argv[0]: as they are for `java`, as `-J...` for every other launcher.
 * Undefined when there is nothing to add.
 */
export function jvmDefaultArgs(tool: string, argv: string[], env: Record<string, string | undefined>): string[] | undefined {
  if (env.TABCOMPUTER_JVM_DEFAULTS === '0') return undefined;
  // what the JVM will see besides: the command line and the variables it reads options from
  const given = [...argv.slice(1), env.JAVA_TOOL_OPTIONS ?? '', env.JDK_JAVA_OPTIONS ?? '', env._JAVA_OPTIONS ?? ''].join(' ');
  const add: string[] = [];
  if (!CHOOSES_COMPILER.test(given)) add.push(QUICK_COMPILER);
  if (!CHOOSES_GC.test(given)) add.push(SERIAL_GC);
  const flags = tool === 'java' ? add : add.map((f) => `-J${f}`);
  if (tool === 'javac' && !argv.some((a) => a.startsWith('-XDstringConcat='))) flags.push(INLINE_CONCAT);
  if (!flags.length) return undefined;
  return [argv[0] ?? tool, ...flags, ...argv.slice(1)];
}
