import type { Command, CommandContext } from './index';
import type { Shell } from '../shell';
import { AF_INET, SOCK_STREAM } from '../kernel/abi';
import { getShiroOrigin } from '../utils/shiro-origin';
import { JDK_HOME, JVM_FLAGS, noteJavacUsed } from '../java-defaults';

/**
 * `javac`, kept warm (docs/research/JAVA_SPEED.md).
 *
 * The java toolchain's compiler is a Java program: every `javac Hello.java`
 * starts a JVM and loads javac in the x86 emulator, half a minute or more. This
 * builtin sends the compile to a JVM that stays up instead (Javad,
 * scripts/java/Javad.java, shipped as java/javad.jar): the first compile of a
 * page load starts it, later ones take a second or two. A tab that compiled
 * Java in the last week starts it by itself a few seconds after boot
 * (`prestartJavad`; the conditions are in java-defaults.ts).
 *
 * The real javac still does everything Javad doesn't take (it answers 127):
 * -version, --release, modules, annotation processors, jars on the class path,
 * and any compile when Javad can't be started or reached. TABCOMPUTER_JAVAC=jvm
 * always runs the real one.
 */

const REAL_JAVAC = `${JDK_HOME}/bin/javac`;
const REAL_JAVA = `${JDK_HOME}/bin/java`;
const JAR = '/usr/lib/tabcomputer/java/javad.jar';
const STATE = '/tmp/.tabcomputer-javad';
/** Javad exits after this long without a compile (it holds a JVM's memory) */
const IDLE_SECONDS = 1800;
/** How long a first compile waits for Javad before the real javac takes it */
const START_TIMEOUT_MS = 240_000;

const JAVAD_FLAGS = [
  ...JVM_FLAGS, '-XX:-UsePerfData', '-Xmx256m',
  ...['api', 'code', 'util'].map((p) => `--add-exports=jdk.compiler/com.sun.tools.javac.${p}=ALL-UNNAMED`),
];

interface Daemon {
  /** The port once Javad listens; null when it could not be started */
  port: Promise<number | null>;
  /** Javad's process ended */
  exited: boolean;
  stop(): void;
  log: string[];
}
let daemon: Daemon | null = null;

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function javaInstalled(fs: CommandContext['fs']): Promise<boolean> {
  return !!(await fs.stat(REAL_JAVAC).catch(() => null));
}

/** The jar this build ships, written where the JVM can read it. False when there is none. */
async function installJar(fs: CommandContext['fs']): Promise<boolean> {
  let bytes: Uint8Array | null = null;
  try {
    const res = await fetch(new URL('java/javad.jar', getShiroOrigin() + '/').href);
    const b = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    // (a zip: an SPA fallback page isn't)
    if (b && b.length > 4 && b[0] === 0x50 && b[1] === 0x4b) bytes = b;
  } catch { /* offline: the copy from an earlier load, if any */ }
  const have = await fs.readFile(JAR).catch(() => null) as Uint8Array | null;
  if (!bytes) return !!have;
  if (have && have.length === bytes.length && have.every((v, i) => v === bytes![i])) return true;
  await fs.mkdir(JAR.slice(0, JAR.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(JAR, bytes, { mode: 0o644 });
  return true;
}

/** Start Javad in a process of its own, without a terminal, that outlives the command that started it. */
function startDaemon(shell: Shell): Daemon {
  const side = shell.fork();
  (side as unknown as { terminal: unknown }).terminal = null;
  side.cwd = '/';
  const own = new AbortController();
  side.inheritedAbort = own;
  const log: string[] = [];
  const note = (s: string) => { log.push(s); if (log.length > 50) log.shift(); };
  const d: Daemon = { port: Promise.resolve(null), exited: false, stop: () => own.abort(), log };
  d.port = (async () => {
    const fs = shell.fs;
    if (!await installJar(fs)) { d.exited = true; return null; }
    // a port file from an earlier page load names a process that is gone
    await fs.unlink(`${STATE}/port`).catch(() => {});
    const line = [REAL_JAVA, ...JAVAD_FLAGS, '-cp', JAR, 'Javad', STATE, String(IDLE_SECONDS)].map(sq).join(' ');
    void side.execute(line, note, note).catch(() => 1).then(() => { d.exited = true; if (daemon === d) daemon = null; });
    const t0 = Date.now();
    while (!d.exited && Date.now() - t0 < START_TIMEOUT_MS) {
      const text = await fs.readFile(`${STATE}/port`, 'utf8').catch(() => null);
      const port = typeof text === 'string' ? Number(text.trim()) : NaN;
      if (port > 0 && port < 65536) return port;
      await sleep(150);
    }
    if (!d.exited) d.stop();
    return null;
  })();
  return d;
}

/** Javad for this page, started if it isn't running. `started` says this call started it. */
export function ensureJavad(shell: Shell): { daemon: Daemon; started: boolean } {
  if (daemon && !daemon.exited) return { daemon, started: false };
  daemon = startDaemon(shell);
  return { daemon, started: true };
}

/**
 * Page load (main.ts, java-defaults.ts `scheduleJavacPrestart`): start Javad
 * before the first `javac`, when Java is installed and it isn't running.
 * True when this call started it.
 */
export async function prestartJavad(shell: Shell): Promise<boolean> {
  if (daemon && !daemon.exited) return false;
  if (!await javaInstalled(shell.fs)) return false;
  return ensureJavad(shell).started;
}

/** Stop Javad (tests; `javac --tabcomputer-stop`). */
export function stopJavad(): void {
  daemon?.stop();
  daemon = null;
}

export function javadStatus(): { running: boolean; log: string[] } {
  return { running: !!daemon && !daemon.exited, log: daemon?.log ?? [] };
}

// ── Javad's protocol (scripts/java/Javad.java) ────────────────────────────

const enc = new TextEncoder();

/** Java's DataOutput.writeUTF: a 2-byte length and the bytes. Null when a string doesn't fit one (65535 bytes, or a NUL or astral character, which Java encodes its own way). */
export function encodeRequest(op: string, cwd: string, classpath: string, args: string[]): Uint8Array | null {
  const parts: Uint8Array[] = [Uint8Array.of(op.charCodeAt(0))];
  const utf = (s: string): boolean => {
    if (/[\0\u{10000}-\u{10FFFF}]/u.test(s)) return false;
    const b = enc.encode(s);
    if (b.length > 65535) return false;
    parts.push(Uint8Array.of(b.length >> 8, b.length & 255), b);
    return true;
  };
  if (!utf(cwd) || !utf(classpath)) return null;
  const n = args.length;
  parts.push(Uint8Array.of(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255));
  for (const a of args) if (!utf(a)) return null;
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/** Reply frames: [kind 1|2, int len, bytes]..., then [0, int status]. Feed it bytes as they arrive. */
export class ReplyParser {
  private buf = new Uint8Array(0);
  status: number | null = null;
  constructor(private onData: (kind: 1 | 2, bytes: Uint8Array) => void) {}
  /** False when the bytes are not a reply (something else listens on the port). */
  push(chunk: Uint8Array): boolean {
    if (this.status !== null) return true;
    const b = new Uint8Array(this.buf.length + chunk.length);
    b.set(this.buf); b.set(chunk, this.buf.length);
    let off = 0;
    while (b.length - off >= 5) {
      const kind = b[off];
      const n = ((b[off + 1] << 24) | (b[off + 2] << 16) | (b[off + 3] << 8) | b[off + 4]);
      if (kind === 0) { this.status = n; break; }
      if ((kind !== 1 && kind !== 2) || n < 0 || n > (64 << 20)) return false;
      if (b.length - off - 5 < n) break;
      this.onData(kind, b.subarray(off + 5, off + 5 + n));
      off += 5 + n;
    }
    this.buf = b.slice(off);
    return true;
  }
}

/** One request to Javad. Returns the exit status, or null when it could not be asked (the caller runs the real javac). */
async function request(port: number, body: Uint8Array, out: (s: string) => void, err: (s: string) => void, signal?: AbortSignal): Promise<number | null> {
  const { netStack, KSocket } = await import('../kernel/net');
  const s = netStack.socket(AF_INET, SOCK_STREAM);
  if (typeof s === 'number' || !(s instanceof KSocket)) return null;
  const onAbort = () => { void s.close(); };
  signal?.addEventListener('abort', onAbort);
  try {
    if (await s.connectHost('127.0.0.1', port) < 0) return null;
    for (let off = 0; off < body.length;) {
      const n = await s.write(body.subarray(off));
      if (n < 0) return null;
      off += n;
    }
    // (stream decoders: a character can be split between two frames)
    const d1 = new TextDecoder(), d2 = new TextDecoder();
    let wrote = false;
    const parser = new ReplyParser((kind, bytes) => {
      wrote = true;
      if (kind === 1) out(d1.decode(bytes, { stream: true })); else err(d2.decode(bytes, { stream: true }));
    });
    const buf = new Uint8Array(64 * 1024);
    while (parser.status === null) {
      const n = await s.read(buf);
      if (signal?.aborted) return 130;
      // Javad went away mid-reply: nothing was shown yet, so the real javac can still do it
      if (n <= 0) return wrote ? 1 : null;
      if (!parser.push(buf.subarray(0, n))) return wrote ? 1 : null;
    }
    return parser.status;
  } catch {
    return null;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    void s.close();
  }
}

/** Is this a command line Javad may take? (It decides for itself too; this saves starting it for `javac -version`.) */
export function mayUseJavad(args: string[]): boolean {
  return args.some((a) => a.endsWith('.java') && !a.startsWith('-')) &&
    !args.some((a) => a.startsWith('@') || a.startsWith('-J') || a === '--release' || a === '-version' || a === '--version' || a === '--help' || a === '-help');
}

async function runReal(ctx: CommandContext, program: string, args: string[], out: (s: string) => void, err: (s: string) => void): Promise<number> {
  const side = ctx.shell.fork();
  side.cwd = ctx.cwd;
  Object.assign(side.env, ctx.env);
  return side.execute([program, ...args].map(sq).join(' '), out, err);
}

export const javacCmd: Command = {
  name: 'javac',
  description: 'The Java compiler (toolchain install java), kept warm between compiles',
  // /usr/bin/javac is Debian's; at the prompt this builtin runs first
  keepOverPackage: () => true,
  async exec(ctx) {
    const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s; };
    const err = (s: string) => { if (ctx.streamStderr) ctx.streamStderr(s); else ctx.stderr += s; };
    if (ctx.args[0] === '--tabcomputer-stop') { stopJavad(); return 0; }
    if (ctx.args[0] === '--tabcomputer-status') {
      const st = javadStatus();
      out(`javac: the warm compiler is ${st.running ? 'running' : 'not running'}\n${st.log.join('')}`);
      return 0;
    }
    if (!await javaInstalled(ctx.fs)) {
      err('javac: Java is not installed. Install it with: toolchain install java\n');
      return 127;
    }
    // (a tab that compiles Java gets the warm compiler started at its next page loads)
    noteJavacUsed();
    const real = () => runReal(ctx, REAL_JAVAC, ctx.args, out, err);
    if (ctx.env.TABCOMPUTER_JAVAC === 'jvm' || !mayUseJavad(ctx.args)) return real();
    const body = encodeRequest('c', ctx.cwd, ctx.env.CLASSPATH ?? '', ctx.args);
    if (!body) return real();

    const signal: AbortSignal | undefined = ctx.shell?.abortController?.signal;
    const { daemon: d, started } = ensureJavad(ctx.shell);
    if (started && ctx.stderrIsTTY !== false && ctx.terminal) {
      err('javac: starting the Java compiler. This first compile takes up to a minute; the next ones take seconds.\n');
    }
    const port = await Promise.race([
      d.port,
      new Promise<null>((r) => { if (signal?.aborted) r(null); else signal?.addEventListener('abort', () => r(null), { once: true }); }),
    ]);
    if (signal?.aborted) return 130;
    if (port === null) return real();
    const status = await request(port, body, out, err, signal);
    if (status === null) {
      // not answering: don't ask it again
      if (daemon === d) stopJavad();
      return real();
    }
    return status === 127 ? real() : status;
  },
};
