/**
 * The page's side of a notebook's kernel: one Python that stays up for a
 * notebook, as a kernel process whose program is a Pyodide Worker
 * (src/pyodide-worker/notebook-guest.ts has the protocol). Its files are the
 * tab's, its working directory is the notebook's folder, it shows in `ps`,
 * and the page's main thread only answers its syscalls, so a long cell does
 * not freeze the desktop.
 *
 * No DOM here: the Notebook app and `jupyter execute` are the callers.
 */
import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import * as A from '../kernel/abi';
import { BufferFile, ReadyListeners, abortableWait, type OpenFile, type OpenFileKind } from '../kernel/fd';
import type { Kernel, Runner } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { workerRunner } from '../kernel/worker-host';
import { pyodideWorkerMode } from '../pyodide-worker/boot';
import { importsOf, pythonSites } from '../python/route';
import { readPyodideIndex } from '../python/pyodide-dist';
import { translateCell } from './magics';
import type { KernelOutput } from './nbformat';

/**
 * fd 3 of the kernel's process: lines of JSON each way. The guest's writes
 * arrive at `onLine`; `push` queues a line for its next read, which waits
 * until there is one (a signal ends the wait with EINTR).
 */
export class ControlFile implements OpenFile {
  kind: OpenFileKind = 'pipe';
  flags = A.O_RDWR;
  onLine: (line: string) => void = () => {};
  private queue: Uint8Array[] = [];
  private partial: Uint8Array[] = [];
  private closed = false;
  private waiters = new Set<() => void>();
  private listeners = new ReadyListeners();
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  /** Queue `line` (without its line break) for the guest */
  push(line: string): void {
    this.queue.push(this.enc.encode(line + '\n'));
    for (const w of [...this.waiters]) w();
    this.listeners.fire(A.POLLIN);
  }

  /** The guest's next read returns end of file */
  end(): void {
    this.closed = true;
    for (const w of [...this.waiters]) w();
    this.listeners.fire();
  }

  async read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    for (;;) {
      const head = this.queue[0];
      if (head) {
        const n = Math.min(head.length, buf.length);
        buf.set(head.subarray(0, n));
        if (n === head.length) this.queue.shift(); else this.queue[0] = head.subarray(n);
        return n;
      }
      if (this.closed) return 0;
      if (!(await abortableWait(this.waiters, signal))) return -A.EINTR;
    }
  }

  async write(buf: Uint8Array): Promise<number> {
    let start = 0;
    for (let i = 0; i < buf.length; i++) {
      if (buf[i] !== 10) continue;
      const piece = buf.slice(start, i);
      let line = piece;
      if (this.partial.length) {
        const all = new Uint8Array(this.partial.reduce((a, p) => a + p.length, 0) + piece.length);
        let off = 0;
        for (const p of this.partial) { all.set(p, off); off += p.length; }
        all.set(piece, off);
        line = all;
        this.partial = [];
      }
      start = i + 1;
      try { this.onLine(this.dec.decode(line)); } catch (e) { console.warn('[notebook] kernel message', e); }
    }
    if (start < buf.length) this.partial.push(buf.slice(start));
    return buf.length;
  }

  poll(events: number): number { return events & ((this.queue.length || this.closed ? A.POLLIN : 0) | A.POLLOUT); }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  seek(): number { return -A.ESPIPE; }
  async stat(): Promise<A.KStat> {
    const now = Date.now();
    return { dev: 2, ino: 0, mode: A.S_IFIFO | 0o600, nlink: 1, uid: 1000, gid: 1000, rdev: 0, size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now };
  }
  async close(): Promise<void> { this.closed = true; }
}

/** A cell's printed text, as the kernel process writes it to fd 1 or 2 */
class StreamFile implements OpenFile {
  kind: OpenFileKind = 'pipe';
  flags = A.O_WRONLY;
  private listeners = new ReadyListeners();
  private dec = new TextDecoder();
  constructor(private cb: (text: string) => void) {}
  async read(): Promise<number> { return -A.EBADF; }
  async write(buf: Uint8Array): Promise<number> {
    this.cb(this.dec.decode(buf.slice(), { stream: true }));
    return buf.length;
  }
  poll(events: number): number { return events & A.POLLOUT; }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  seek(): number { return -A.ESPIPE; }
  async stat(): Promise<A.KStat> {
    const now = Date.now();
    return { dev: 2, ino: 0, mode: A.S_IFIFO | 0o600, nlink: 1, uid: 1000, gid: 1000, rdev: 0, size: 0, blksize: 4096, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now };
  }
  async close(): Promise<void> {}
}

export type KernelState = 'starting' | 'idle' | 'busy' | 'dead';

export interface ExecHandlers {
  onOutput(msg: KernelOutput): void;
  /** `input()`: the text the person typed. `signal` aborts when the cell is stopped. */
  onInput?(prompt: string, password: boolean, signal: AbortSignal): Promise<string>;
}

export interface ExecResult {
  /** 'abort': the Python process ended before the cell did */
  status: 'ok' | 'error' | 'abort';
  /** The cell's number (In [3]); 0 when it did not run */
  count: number;
}

export interface KernelDeps {
  kernel: Kernel;
  fs: FileSystem;
  /** `!command` and `%pip` run in a fork of it */
  shell: Shell;
  /** The notebook's folder: the Python's working directory */
  cwd: string;
  /** The notebook's file name, for `ps` */
  name: string;
}

interface Running {
  id: number;
  handlers: ExecHandlers;
  resolve: (r: ExecResult) => void;
  /** Aborts what the page is doing for the cell (an input box, a shell command) */
  abort: AbortController;
}

/** Why cells cannot run on this page, or '' when they can */
export function kernelUnavailable(): string {
  return pyodideWorkerMode() ? '' : 'Cells cannot run on this page: the browser did not give it shared memory. The notebook can be read and edited.';
}

export class NotebookKernel {
  state: KernelState = 'dead';
  /** What it is waiting for, as a short sentence ('' when nothing) */
  statusText = '';
  /** The Python's version, once it is up */
  python = '';
  /** What the Python process last wrote outside a cell: why it stopped, when it did */
  lastError = '';
  private proc: Process | null = null;
  private ctl: ControlFile | null = null;
  private flag: Uint8Array | null = null;
  private current: Running | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private seq = 0;
  private sites: string[] = [];
  private ready: Promise<void> = Promise.resolve();
  private fail: ((e: Error) => void) | null = null;
  /** Goes up at every shutdown: a cell asked for before it does not start the next Python */
  private generation = 0;
  private listeners = new Set<() => void>();

  constructor(private deps: KernelDeps) {}

  /** Called when `state` or `statusText` changes */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private set(state: KernelState, text = this.statusText): void {
    if (state === this.state && text === this.statusText) return;
    this.state = state;
    this.statusText = text;
    for (const cb of [...this.listeners]) { try { cb(); } catch { /* a listener's own problem */ } }
  }

  /** Start the Python process (a no-op while one is up) */
  start(): void {
    if (this.proc || kernelUnavailable()) return;
    const { kernel, fs, shell, cwd, name } = this.deps;
    const ctl = new ControlFile();
    const interrupt = new SharedArrayBuffer(4);
    this.ctl = ctl;
    this.flag = new Uint8Array(interrupt);
    this.lastError = '';
    this.python = '';
    let up!: () => void;
    let failed!: (e: Error) => void;
    this.ready = new Promise<void>((resolve, reject) => { up = resolve; failed = reject; });
    this.ready.catch(() => {});
    this.fail = failed;
    ctl.onLine = (line) => this.message(line, up);
    const stream = (name: 'stdout' | 'stderr') => new StreamFile((text) => {
      if (this.current) this.current.handlers.onOutput({ t: 'stream', name, text });
      else if (name === 'stderr') this.lastError = (this.lastError + text).slice(-2000);
    });
    this.set('starting', 'Starting Python');
    const env = { ...shell.env } as Record<string, string>;
    void (async () => {
      try { this.sites = await pythonSites(fs, { cwd, env, canPyodide: true }); } catch { this.sites = []; }
      if (this.ctl !== ctl) return; // (shut down meanwhile)
      const run: Runner = async (proc, k) => {
        const { takeWorker } = await import('../pyodide-worker/host');
        return workerRunner(() => takeWorker(), { dataSize: 1 << 20, startData: { notebook: { sitePaths: this.sites }, interrupt } })(proc, k);
      };
      const proc = kernel.spawn({
        path: 'python3', argv: ['python3', '-m', 'notebook', name], env, cwd, pgid: 0, run,
        fds: { 0: new BufferFile('', A.O_RDONLY), 1: stream('stdout'), 2: stream('stderr'), 3: ctl },
      });
      this.proc = proc;
      void proc.wait().then(() => {
        void kernel.waitpid(proc.pid, A.WNOHANG).catch(() => {});
        if (this.proc !== proc) return;
        this.proc = null;
        this.ctl = null;
        failed(new Error(this.lastError.trim() || 'The Python process stopped.'));
        const cur = this.current;
        this.current = null;
        cur?.abort.abort();
        cur?.resolve({ status: 'abort', count: 0 });
        this.set('dead', '');
      });
    })();
  }

  private message(line: string, up: () => void): void {
    let m: any;
    try { m = JSON.parse(line); } catch { return; }
    const cur = this.current;
    switch (m?.t) {
      case 'ready':
        this.python = String(m.python ?? '');
        up();
        if (this.state === 'starting') this.set('idle', '');
        break;
      case 'status':
        this.set(this.state, String(m.text ?? ''));
        break;
      case 'display': case 'result': case 'error': case 'clear': case 'stream':
        cur?.handlers.onOutput(m as KernelOutput);
        break;
      case 'input':
        if (cur) void this.input(m, cur);
        break;
      case 'shell':
        if (cur) void this.shell(m, cur);
        break;
      case 'done':
        if (cur && cur.id === m.id) {
          this.current = null;
          this.set('idle', '');
          cur.resolve({ status: m.status === 'ok' ? 'ok' : 'error', count: Number(m.count) || 0 });
        }
        break;
    }
  }

  private reply(m: { rid: number }, fields: Record<string, unknown>): void {
    this.ctl?.push(JSON.stringify({ t: 'reply', rid: m.rid, ...fields }));
  }

  private async input(m: { rid: number; prompt: string; password: boolean }, cur: Running): Promise<void> {
    let value = '';
    try {
      if (!cur.handlers.onInput) throw new Error('no input');
      value = await cur.handlers.onInput(String(m.prompt ?? ''), !!m.password, cur.abort.signal);
    } catch {
      // (stopped, or nowhere to ask: the cell gets KeyboardInterrupt from the interrupt, or an empty line)
      if (cur.abort.signal.aborted) return;
    }
    if (cur.abort.signal.aborted) return;
    this.reply(m, { value });
  }

  /** `!command`: in a fork of the tab's shell, in the Python's working directory */
  private async shell(m: { rid: number; cmd: string; cwd: string; capture: boolean }, cur: Running): Promise<void> {
    const sh = this.deps.shell.fork();
    sh.cwd = String(m.cwd || this.deps.cwd);
    let out = '';
    const emit = (name: 'stdout' | 'stderr') => (text: string) => {
      if (m.capture && name === 'stdout') out += text;
      else cur.handlers.onOutput({ t: 'stream', name, text });
    };
    const onAbort = () => { try { (sh as { abortController?: AbortController | null }).abortController?.abort(); } catch { /* ended */ } };
    cur.abort.signal.addEventListener('abort', onAbort);
    let code = 1;
    try {
      code = await sh.execute(String(m.cmd), emit('stdout'), emit('stderr'));
    } catch (e) {
      emit('stderr')(`${(e as Error)?.message ?? e}\n`);
    } finally {
      cur.abort.signal.removeEventListener('abort', onAbort);
    }
    if (cur.abort.signal.aborted) return;
    this.reply(m, { code, out });
  }

  /** The Pyodide packages `code` needs that only the tab's pip knows of (a pure package that depends on numpy) */
  private async packagesFor(code: string): Promise<string[]> {
    const { fs, cwd } = this.deps;
    const modules: Record<string, string[]> = {};
    for (const site of this.sites) {
      const index = await readPyodideIndex(fs, site).catch(() => null);
      for (const [mod, pkgs] of Object.entries(index?.modules ?? {})) modules[mod] ??= pkgs;
    }
    if (!Object.keys(modules).length) return [];
    const packages = new Set<string>();
    for (const mod of await importsOf(fs, code, cwd)) for (const p of modules[mod] ?? []) packages.add(p);
    return [...packages].sort();
  }

  private send(type: 'exec' | 'load', source: string, handlers: ExecHandlers): Promise<ExecResult> {
    const generation = this.generation;
    const job = this.queue.then(async (): Promise<ExecResult> => {
      if (generation !== this.generation) return { status: 'abort', count: 0 };
      this.start();
      try { await this.ready; } catch { return { status: 'abort', count: 0 }; }
      const ctl = this.ctl;
      if (!ctl) return { status: 'abort', count: 0 };
      const code = translateCell(source);
      const packages = await this.packagesFor(code).catch(() => []);
      if (this.ctl !== ctl) return { status: 'abort', count: 0 };
      return new Promise<ExecResult>((resolve) => {
        const id = ++this.seq;
        this.current = { id, handlers, resolve, abort: new AbortController() };
        if (type === 'exec') this.set('busy', '');
        ctl.push(JSON.stringify({ t: type, id, code, packages }));
      });
    });
    this.queue = job.catch(() => {});
    return job;
  }

  /** Run a cell's source. Cells run one at a time, in the order asked. */
  execute(source: string, handlers: ExecHandlers): Promise<ExecResult> {
    return this.send('exec', source, handlers);
  }

  /** Fetch and load the packages `source` imports, ahead of the first run */
  preload(source: string): Promise<ExecResult> {
    return this.send('load', source, { onOutput: () => {} });
  }

  /** Stop the running cell: KeyboardInterrupt in Python, and an end to its input box or shell command */
  interrupt(): void {
    const { proc, flag, current } = this;
    if (!proc || !flag || !current || this.state !== 'busy') return;
    current.abort.abort();
    Atomics.store(flag, 0, 2);
    this.deps.kernel.kill(proc.pid, A.SIGINT);
  }

  /** End the Python process. Cells waiting to run are answered with 'abort'. */
  shutdown(): void {
    const proc = this.proc;
    const cur = this.current;
    this.proc = null;
    this.ctl = null;
    this.current = null;
    this.generation++;
    this.fail?.(new Error('The Python process was stopped.'));
    this.fail = null;
    cur?.abort.abort();
    cur?.resolve({ status: 'abort', count: 0 });
    if (proc) this.deps.kernel.kill(proc.pid, A.SIGKILL);
    this.set('dead', '');
  }

  /** A new Python: every variable is gone */
  restart(): void {
    this.shutdown();
    this.queue = Promise.resolve();
    this.start();
  }
}
