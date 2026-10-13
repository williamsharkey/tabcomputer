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
