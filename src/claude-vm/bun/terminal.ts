/**
 * Bun.Terminal and Bun.spawn's `terminal` option on the kernel's ptys.
 * Claude Code's background sessions (`claude --bg`, `claude agents`) run each
 * session under a pty host (`claude --bg-pty-host`), which makes
 * `new Bun.Terminal({ cols, rows, data })`, starts Claude on it with
 * `Bun.spawn(argv, { terminal })`, writes keys with `write`, follows the
 * client's size with `resize`, and `close`s it after the session ends.
 *
 * Bun's surface: options cols (80), rows (24), name, data(terminal, bytes),
 * exit(terminal, 0 | 1, null) when the pty closes, drain(terminal); methods
 * write (bytes taken), resize, setRawMode, ref/unref, close, `closed`, the
 * termios flags (inputFlags, outputFlags, localFlags, controlFlags), and
 * `await using`. A spawned process's stdin, stdout and stderr are the
 * terminal (null on the Subprocess); `proc.terminal` is it. The pty stays
 * open after its programs exit, until `close()` (exit fires then), as Bun's.
 *
 * The pty comes from the process's child_process (PTY_ACCESS in
 * node-compat/modules/child-process.ts): node-worker/pty.ts as a kernel
 * guest, node-compat/pty-page.ts in the page.
 */
import { BRKINT, CS8, CSIZE, ECHO, ECHONL, ICANON, ICRNL, IEXTEN, IGNBRK, IGNCR, INLCR, ISIG, ISTRIP, IXON, OPOST, PARENB, PARMRK } from '../../kernel/pty';
import type { PtyHost } from '../../node-worker/hooks';
import type { SpawnEnv } from './spawn';

const PTY_ACCESS = Symbol.for('tabcomputer.pty');
/** (`await using`; the page's engines have it, the lib types this repo compiles with don't) */
const asyncDispose: symbol = (Symbol as { asyncDispose?: symbol }).asyncDispose ?? Symbol.for('Symbol.asyncDispose');
interface PtyAccess {
  open(opts: { cols: number; rows: number }): PtyHost | number;
  keepAlive(): () => void;
}

export const SIGNALS: Record<string, number> = {
  SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGABRT: 6, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14,
  SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22, SIGWINCH: 28,
};
export const signalNumberOf = (sig?: number | string): number => (typeof sig === 'number' ? sig : sig ? SIGNALS[sig] ?? SIGNALS[`SIG${sig}`] ?? 15 : 15);
export const signalNameOf = (n: number): string => Object.keys(SIGNALS).find((k) => SIGNALS[k] === n) ?? `SIG${n}`;

export interface TerminalOptions {
  cols?: number;
  rows?: number;
  name?: string;
  data?: (terminal: any, data: Uint8Array) => void;
  exit?: (terminal: any, exitCode: number, signal: string | null) => void;
  drain?: (terminal: any) => void;
}

const ptyAccessOf = (env: SpawnEnv): PtyAccess | undefined => env.childProcess?.[PTY_ACCESS];

/** The Terminal class for one process's Bun */
export function terminalClass(env: SpawnEnv) {
  class Terminal {
    /** @internal */ readonly pty: PtyHost;
    #opts: TerminalOptions;
    #ref = true;
    #release: (() => void) | null = null;

    constructor(opts: TerminalOptions = {}) {
      if (opts === null || typeof opts !== 'object') throw new TypeError('Terminal options must be an object');
      const access = ptyAccessOf(env);
      const pty = access ? access.open({ cols: opts.cols ?? 80, rows: opts.rows ?? 24 }) : -38;
      if (typeof pty === 'number') throw Object.assign(new Error(`Failed to open a pseudo-terminal (errno ${-pty})`), { code: pty === -38 ? 'ENOSYS' : 'EIO', errno: pty, syscall: 'openpty' });
      this.pty = pty;
      this.#opts = opts;
      this.#hold();
      pty.onData((b) => {
        if (b) { try { opts.data?.(this, b); } catch (e) { queueMicrotask(() => { throw e; }); } return; }
        this.#unhold();
        try { opts.exit?.(this, 0, null); } catch (e) { queueMicrotask(() => { throw e; }); }
      });
    }

    get closed(): boolean { return this.pty.closed; }

    write(data: string | ArrayBufferView | ArrayBuffer): number {
      if (this.pty.closed) return 0;
      const b = typeof data === 'string' ? new TextEncoder().encode(data)
        : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data);
      return this.pty.write(b);
    }

    resize(cols: number, rows: number): void {
      if (!(cols > 0) || !(rows > 0)) throw new RangeError('cols and rows must be positive');
      this.pty.resize(cols, rows);
    }

    /** cfmakeraw on the terminal's modes (or canonical, echoing ones back) */
    setRawMode(enabled: boolean): void {
      const f = this.pty.getFlags();
      if (enabled) {
        this.pty.setFlags({
          iflag: f.iflag & ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL | IXON),
          oflag: f.oflag & ~OPOST,
          lflag: f.lflag & ~(ECHO | ECHONL | ICANON | ISIG | IEXTEN),
          cflag: (f.cflag & ~(CSIZE | PARENB)) | CS8,
        });
      } else {
        this.pty.setFlags({ iflag: f.iflag | ICRNL | IXON, oflag: f.oflag | OPOST, lflag: f.lflag | ECHO | ICANON | ISIG | IEXTEN });
      }
    }

    get inputFlags(): number { return this.pty.getFlags().iflag; }
    set inputFlags(v: number) { this.pty.setFlags({ iflag: v >>> 0 }); }
    get outputFlags(): number { return this.pty.getFlags().oflag; }
    set outputFlags(v: number) { this.pty.setFlags({ oflag: v >>> 0 }); }
    get localFlags(): number { return this.pty.getFlags().lflag; }
    set localFlags(v: number) { this.pty.setFlags({ lflag: v >>> 0 }); }
    get controlFlags(): number { return this.pty.getFlags().cflag; }
    set controlFlags(v: number) { this.pty.setFlags({ cflag: v >>> 0 }); }

    /** While open and ref()'d (the default), the terminal keeps the process running */
    ref(): void { this.#ref = true; this.#hold(); }
    unref(): void { this.#ref = false; this.#unhold(); }

    close(): void {
      if (this.pty.closed) return;
      this.pty.close(); // (onData(null): exit and the release)
    }

    async [asyncDispose](): Promise<void> { this.close(); }

    #hold(): void {
      if (this.#ref && !this.#release && !this.pty.closed) this.#release = ptyAccessOf(env)?.keepAlive() ?? null;
    }
    #unhold(): void { const r = this.#release; this.#release = null; r?.(); }

    /** @internal what it was made with (drain is never needed: writes are taken whole) */
    get options(): TerminalOptions { return this.#opts; }
  }
  return Terminal;
}

export interface TerminalSpawnOptions {
  path: string;
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  onExit?: (proc: any, exitCode: number | null, signalCode: number | null, error?: Error) => void;
}

/** Bun.spawn(cmd, { terminal }): the program on the terminal's pty, in a session of its own */
export function spawnOnTerminal(env: SpawnEnv, terminal: InstanceType<ReturnType<typeof terminalClass>>, o: TerminalSpawnOptions): any {
  const child = terminal.pty.spawn(o.argv, { path: o.path, cwd: o.cwd, env: o.env });
  if (typeof child === 'number') {
    if (child === -2 && !o.path.includes('/')) throw Object.assign(new Error(`Executable not found in $PATH: "${o.path}"`), { code: 'ENOENT' });
    throw Object.assign(new Error(`${child === -2 ? 'ENOENT: no such file or directory' : `errno ${-child}`}, posix_spawn '${o.path}'`),
      { code: child === -2 ? 'ENOENT' : 'EIO', errno: child, syscall: 'posix_spawn', path: o.path });
  }
  let exitCode: number | null = null, signalCode: string | null = null, killed = false;
  let release: (() => void) | null = ptyAccessOf(env)?.keepAlive() ?? null;
  const unhold = () => { const r = release; release = null; r?.(); };
  const exited = child.exited.then(({ status, signal }) => {
    exitCode = status;
    signalCode = signal === null ? null : signalNameOf(signal);
    unhold();
    // (onExit after `exited` has settled, as Bun calls it)
    if (o.onExit) setTimeout(() => { try { o.onExit!(proc, status, signal, undefined); } catch { /* the handler's */ } }, 0);
    return status ?? 128 + (signal ?? 0);
  });
  const proc: any = {
    pid: child.pid,
    terminal,
    stdin: null, stdout: null, stderr: null,
    exited,
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    get killed() { return killed; },
    kill(sig?: number | string) {
      if (exitCode !== null || signalCode !== null) return;
      const n = signalNumberOf(sig);
      if (child.kill(n) === 0 && n !== 0) killed = true;
    },
    ref() { if (!release && exitCode === null && signalCode === null) release = ptyAccessOf(env)?.keepAlive() ?? null; },
    unref() { unhold(); },
    resourceUsage() { return undefined; },
    async [asyncDispose]() { if (exitCode === null && signalCode === null) proc.kill('SIGTERM'); await exited; },
  };
  return proc;
}
