/**
 * Bun.spawn onto the Node runtime's child_process, Bun.file as far as spawn's
 * stdio (and a simple read) needs it, and Bun.stdin.stream().
 *
 * Bun's defaults: stdin 'ignore', stdout 'pipe', stderr 'inherit'. A piped
 * stdout/stderr is a web ReadableStream of Uint8Array; a piped stdin is a
 * FileSink (write/flush/end). stdin may also be data (a string, bytes, a Blob,
 * a Response, a ReadableStream), written to the child and closed.
 */
import { which } from './which';
import { SIGNALS, spawnOnTerminal, terminalClass, type TerminalOptions } from './terminal';

export interface SpawnEnv {
  fs: any;
  process: any;
  childProcess: any;
  Buffer?: any;
}


/** Bun.file(path | fd): a lazily read file */
export class BunFile {
  readonly fd: number | undefined;
  readonly name: string | undefined;
  constructor(private env: SpawnEnv, target: string | number | URL, readonly type = 'application/octet-stream') {
    if (typeof target === 'number') this.fd = target;
    else this.name = target instanceof URL ? decodeURIComponent(target.pathname) : String(target);
  }
  get size(): number {
    try { return this.fd !== undefined ? this.env.fs.fstatSync(this.fd).size : this.env.fs.statSync(this.name).size; } catch { return 0; }
  }
  async exists(): Promise<boolean> {
    if (this.fd !== undefined) return true;
    try { this.env.fs.statSync(this.name); return true; } catch { return false; }
  }
  async bytes(): Promise<Uint8Array> {
    const b = this.fd !== undefined ? this.env.fs.readFileSync(this.fd) : this.env.fs.readFileSync(this.name);
    return typeof b === 'string' ? new TextEncoder().encode(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  }
  async arrayBuffer(): Promise<ArrayBuffer> { const b = await this.bytes(); return b.slice().buffer; }
  async text(): Promise<string> { return new TextDecoder().decode(await this.bytes()); }
  async json(): Promise<unknown> { return JSON.parse(await this.text()); }
  stream(): ReadableStream<Uint8Array> {
    return new ReadableStream({ start: async (c) => { c.enqueue(await this.bytes()); c.close(); } });
  }
}

/** A Node Readable as a web ReadableStream of bytes */
function webStream(readable: any): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let done = false;
      const finish = () => { if (!done) { done = true; try { controller.close(); } catch { /* closed */ } } };
      readable.on('data', (d: any) => { if (!done) controller.enqueue(typeof d === 'string' ? enc.encode(d) : new Uint8Array(d.buffer ?? d, d.byteOffset ?? 0, d.byteLength ?? d.length)); });
      readable.on('end', finish);
      readable.on('close', finish);
      readable.on('error', (e: unknown) => { if (!done) { done = true; controller.error(e); } });
    },
    cancel() { readable.destroy?.(); },
  });
}

/** What a child's stdio slot becomes for child_process */
function stdioOf(env: SpawnEnv, v: any, slot: 0 | 1 | 2, opened: number[]): { node: any; feed?: any; path?: boolean } {
  if (v === undefined) return { node: slot === 0 ? 'ignore' : slot === 1 ? 'pipe' : 'inherit' };
  if (v === null || v === 'ignore') return { node: 'ignore' };
  if (v === 'pipe' || v === 'inherit') return { node: v };
  if (typeof v === 'string') throw Object.assign(new TypeError("stdio must be an array of 'inherit', 'pipe', 'ignore', Bun.file(pathOrFd), number, or null"), { code: 'ERR_INVALID_ARG_TYPE' });
  if (typeof v === 'number') return { node: v };
  if (v instanceof BunFile) {
    if (v.fd !== undefined) return { node: v.fd };
    const fd = env.fs.openSync(v.name, slot === 0 ? 'r' : 'w');
    opened.push(fd);
    return { node: fd, path: true };
  }
  // data for stdin: written to a pipe, then closed
  if (slot === 0) return { node: 'pipe', feed: v };
  throw new TypeError(`Bun.spawn: unsupported stdio value for fd ${slot}`);
}

async function bytesOf(v: any): Promise<Uint8Array | ReadableStream<Uint8Array>> {
  if (typeof v === 'string') return new TextEncoder().encode(v);
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof Blob !== 'undefined' && v instanceof Blob) return new Uint8Array(await v.arrayBuffer());
  if (typeof Response !== 'undefined' && v instanceof Response) return v.body ?? new Uint8Array(0);
  if (v && typeof v.getReader === 'function') return v as ReadableStream<Uint8Array>;
  throw new TypeError('Bun.spawn: unsupported stdin value');
}

export interface SpawnOptions {
  cmd?: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: any; stdout?: any; stderr?: any;
  stdio?: any[];
  argv0?: string;
  onExit?: (proc: any, exitCode: number | null, signalCode: number | null, error?: Error) => void;
  detached?: boolean;
  /** A Bun.Terminal, or its options for a new one: the program's stdio and controlling tty (terminal.ts) */
  terminal?: any;
}

export function spawn(env: SpawnEnv, cmdOrOpts: string[] | SpawnOptions, maybeOpts: SpawnOptions = {}): any {
  const opts: SpawnOptions = Array.isArray(cmdOrOpts) ? { ...maybeOpts, cmd: cmdOrOpts } : { ...cmdOrOpts };
  const argv = (opts.cmd ?? []).map(String);
  if (!argv.length) throw new TypeError('Bun.spawn: cmd must not be empty');
  // a program that isn't there fails at once, as Bun's posix_spawn does
  const found = argv[0].includes('/') ? (() => { try { return env.fs.statSync(argv[0]).isFile() ? argv[0] : null; } catch { return null; } })()
    : which(env.fs, argv[0], { PATH: opts.env?.PATH ?? env.process.env?.PATH, cwd: opts.cwd }, { cwd: env.process.cwd() });
  const childEnv = opts.env ? Object.fromEntries(Object.entries(opts.env).filter(([, v]) => v !== undefined)) as Record<string, string> : env.process.env;
  // (on a terminal the kernel finds the program: a builtin needs no file)
  if (opts.terminal) {
    const Terminal = terminalOf(env);
    const terminal = opts.terminal instanceof Terminal ? opts.terminal : new Terminal(opts.terminal as TerminalOptions);
    return spawnOnTerminal(env, terminal, {
      path: found ?? argv[0], argv: opts.argv0 ? [opts.argv0, ...argv.slice(1)] : argv,
      cwd: opts.cwd ?? env.process.cwd(), env: childEnv, onExit: opts.onExit,
    });
  }
  if (!found) {
    throw argv[0].includes('/')
      ? Object.assign(new Error(`ENOENT: no such file or directory, posix_spawn '${argv[0]}'`), { code: 'ENOENT', errno: -2, syscall: 'posix_spawn', path: argv[0] })
      : Object.assign(new Error(`Executable not found in $PATH: "${argv[0]}"`), { code: 'ENOENT' });
  }
  const opened: number[] = [];
  const [i, o, e] = [0, 1, 2].map((k) => stdioOf(env, opts.stdio?.[k] ?? (k === 0 ? opts.stdin : k === 1 ? opts.stdout : opts.stderr), k as 0 | 1 | 2, opened));
  const child = env.childProcess.spawn(argv[0], argv.slice(1), {
    cwd: opts.cwd ?? env.process.cwd(),
    env: childEnv,
    stdio: [i.node, o.node, e.node],
    ...(opts.argv0 ? { argv0: opts.argv0 } : {}),
    ...(opts.detached ? { detached: true } : {}),
  });
  const closeOpened = () => { for (const fd of opened.splice(0)) { try { env.fs.closeSync(fd); } catch { /* closed */ } } };

  let exitCode: number | null = null, signalCode: string | null = null, resolveExit!: (n: number) => void;
  const exited = new Promise<number>((r) => { resolveExit = r; });
  const proc: any = {
    pid: child.pid,
    get exitCode() { return exitCode; },
    get signalCode() { return signalCode; },
    get killed() { return !!child.killed; },
    exited,
    stdin: undefined as any,
    // (piped: a stream; a file descriptor given: that number, as Bun has it)
    stdout: o.node === 'pipe' && child.stdout ? webStream(child.stdout) : typeof o.node === 'number' && !o.path ? o.node : undefined,
    stderr: e.node === 'pipe' && child.stderr ? webStream(child.stderr) : typeof e.node === 'number' && !e.path ? e.node : undefined,
    kill(sig?: number | string) {
      const name = typeof sig === 'number' ? Object.keys(SIGNALS).find((k) => SIGNALS[k] === sig) ?? 'SIGTERM' : sig ?? 'SIGTERM';
      child.kill(name);
    },
    ref() { child.ref?.(); },
    unref() { child.unref?.(); },
    resourceUsage() { return undefined; },
    async [Symbol.asyncDispose]() { if (exitCode === null) child.kill('SIGTERM'); await exited; },
  };
  if (i.node === 'pipe' && child.stdin) {
    if (i.feed !== undefined) {
      void (async () => {
        const data = await bytesOf(i.feed);
        if (data instanceof Uint8Array) child.stdin.write(data);
        else { const r = data.getReader(); for (;;) { const { done, value } = await r.read(); if (done) break; child.stdin.write(value); } }
        child.stdin.end();
      })();
    } else {
      // a FileSink
      proc.stdin = {
        write(chunk: any) {
          const b = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : ArrayBuffer.isView(chunk) ? new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength) : new Uint8Array(chunk);
          child.stdin.write(b);
          return b.byteLength;
        },
        flush() { return 0; },
        end(err?: unknown) { void err; child.stdin.end(); return 0; },
        ref() {}, unref() {},
      };
    }
  }
  let finished = false;
  const done = (code: number | null, sig: string | null, error?: Error) => {
    if (finished) return;
    finished = true;
    exitCode = code;
    signalCode = sig;
    closeOpened();
    // (a signal: exited resolves to 128 + its number, as a shell reports it)
    resolveExit(code ?? (sig ? 128 + (SIGNALS[sig] ?? 15) : 1));
    // (onExit runs after `exited` has settled, as Bun calls it)
    if (opts.onExit) setTimeout(() => { try { opts.onExit!(proc, code, sig ? SIGNALS[sig] ?? null : null, error); } catch { /* the handler's problem */ } }, 0);
  };
  child.on('exit', (code: number | null, sig: string | null) => done(code, sig));
  child.on('error', (err: Error) => done(code127(err), null, err));
  return proc;
}
/** One Terminal class per process's Bun (instanceof works across its calls) */
const terminals = new WeakMap<SpawnEnv, ReturnType<typeof terminalClass>>();
export function terminalOf(env: SpawnEnv): ReturnType<typeof terminalClass> {
  let T = terminals.get(env);
  if (!T) { T = terminalClass(env); terminals.set(env, T); }
  return T;
}
const code127 = (err: any) => (err?.code === 'ENOENT' ? 127 : 1);

/** Bun.stdin: the process's stdin as a BunFile whose stream() is a web ReadableStream */
export function stdinOf(env: SpawnEnv): any {
  const file = new BunFile(env, 0);
  let taken: ReadableStream<Uint8Array> | null = null;
  return Object.assign(file, {
    stream() { taken ??= webStream(env.process.stdin); return taken; },
    async text() {
      const r = (this as any).stream().getReader();
      const parts: Uint8Array[] = [];
      for (;;) { const { done, value } = await r.read(); if (done) break; parts.push(value); }
      const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) { all.set(p, at); at += p.length; }
      return new TextDecoder().decode(all);
    },
  });
}
