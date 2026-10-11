/**
 * What node-compat does differently as a kernel guest in a Worker
 * (by default; TABCOMPUTER_NODE_WORKER=0 opts out): `ctx.nodeGuest`, set by guest.ts. Absent in
 * the page, where node-compat works as before.
 */
import type { ChildOptions, ChildResult } from './child';

export interface NodeGuestHooks {
  /** A file's text for the module/file cache (read through on a miss), undefined if missing or binary */
  readText(path: string): string | undefined;
  /** child_process's sync calls: run `sh -c CMD` to the end (blocks the worker) */
  runChildSync(cmd: string, opts?: ChildOptions): ChildResult;
  /** child_process's async calls: the same, the event loop running meanwhile */
  runChild(cmd: string, opts?: ChildOptions): Promise<ChildResult>;
  /** Write to fd 1 or 2 now (output streams to a pipe or file instead of waiting for exit) */
  writeOut?(fd: 1 | 2, s: string): void;
  /** node's net module's stack: sockets over socket syscalls (net.ts) */
  netStack?: unknown;
  /** Who hears the worker's unhandled promise rejections (node's process 'unhandledRejection'; null: nobody) */
  onUnhandledRejection?(fn: ((reason: unknown, promise: Promise<unknown>) => void) | null): void;
  /** worker_threads: start `file` (or code, with eval) as a thread of this process, a guest of its own */
  startThread?(file: string, opts: { threadId: number; eval?: boolean; workerData?: unknown; argv?: string[]; env?: Record<string, string>; stdout?: boolean; stderr?: boolean }, events: ThreadEvents): ThreadHandle;
  /** Set in a worker_threads thread */
  thread?: ThreadSide;
  /** process.stdin on the terminal: fd 0 read as the process on the pty (tty.ts); set when fd 0 is a tty */
  ttyStdin?(on: { data(text: string): void; end(): void; signal(sig: number): void }): {
    readonly reading: boolean; start(): void; pause(): void; setRaw(on: boolean): void; close(): void;
  };
  /**
   * What only the page can do: the clipboard, a server's preview pane, and calls
   * with results and events (claude --vm's addon stand-ins: src/claude-vm/addons/bridge.ts)
   */
  page?: { clipboard(text: string): void; preview(port: number): void; call?: import('../claude-vm/addons/bridge').PageBridge['call'] };
  /**
   * fs.readFileSync(0): read piped stdin into buf, blocking until bytes come (as node's sync
   * read of a pipe); 0 at EOF, -errno on an error. Not set when fd 0 is a terminal.
   */
  readStdinSync?(buf: Uint8Array): number;
  /** Whether open handles (sockets, servers) keep the program running */
  busy?(): boolean;
  /**
   * NODE_CHANNEL_FD: this node was forked (fork(), stdio 'ipc') and this is its
   * channel to the parent: newline-delimited JSON both ways, as node's 'json'
   * serialization. Bytes as they arrive, null when the parent closes it.
   */
  ipc?: GuestIpc;
  /** fork()'s serialization: 'advanced' (structured clone, ipc.ts ipcLine) or 'json' */
  ipcAdvanced?: boolean;
  /** The kernel's process ids for this node (process.pid, process.ppid) */
  ids?: { pid: number; ppid: number };
  /** kill(2) another process: 0 or -errno */
  kill?(pid: number, sig: number): number;
  /**
   * The signals the script listens for (process.on('SIGTERM')), as node: `watch(sig, true)`
   * catches one, so the kernel's default action (ending the process) no longer applies,
   * `false` gives it back; `onSignal` is where a caught one comes, from the Worker's timers
   * (tabcomputer#91)
   */
  signals?: { watch(sig: number, on: boolean): void; onSignal(fn: (sig: number) => void): void };
  /**
   * TypeScript/JSX to an ES module with the page's esbuild, blocking until it is done
   * (SYS_shiro_transform: Bun.Transpiler in claude --vm). Throws with `errors` as Bun's.
   */
  transformSync?(code: string, loader: 'js' | 'jsx' | 'ts' | 'tsx'): string;
  /** A new pseudo-terminal whose programs this node starts (Bun.Terminal in claude --vm): pty.ts; -errno when there is none */
  openPty?(opts: { cols: number; rows: number }): PtyHost | number;
  /** node:wasi's preview1 imports: blocking syscalls on this thread's channel (modules/wasi.ts) */
  wasi?: import('../node-compat/modules/wasi').WasiSys;
}

/** A worker_threads Worker's thread, as its parent sees it */
export interface ThreadHandle {
  post(value: unknown): void;
  terminate(): void;
}

export interface ThreadEvents {
  online(): void;
  message(value: unknown): void;
  error(err: { message: string; stack?: string }): void;
  exit(code: number): void;
  /** What it wrote, with `new Worker(f, { stdout: true })` / `{ stderr: true }`: worker.stdout/stderr */
  stdout?(bytes: Uint8Array): void;
  stderr?(bytes: Uint8Array): void;
}

/** In a worker_threads thread: its side of the link to the parent */
export interface ThreadSide {
  threadId: number;
  workerData: unknown;
  post(value: unknown): void;
  onMessage(fn: (value: unknown) => void): void;
}

export function nodeGuestOf(ctx: unknown): NodeGuestHooks | undefined {
  return (ctx as { nodeGuest?: NodeGuestHooks } | null)?.nodeGuest;
}

export interface GuestIpc {
  /** Write a whole message (blocks until the kernel takes it); false once closed */
  send(text: string): boolean;
  /** Start reading: chunks to `fn`, then null at the channel's end */
  onData(fn: (b: Uint8Array | null) => void): void;
  close(): void;
}

/** termios flags of a pty, as Bun.Terminal shows them */
export interface PtyFlags { iflag: number; oflag: number; cflag: number; lflag: number }

/**
 * A pseudo-terminal owned by a program (node-worker/pty.ts as a kernel guest,
 * node-compat/pty-page.ts in the page): its master side, and programs started
 * with the slave as their stdio and controlling tty.
 */
export interface PtyHost {
  /** What the programs write, as it comes; null once the pty is closed */
  onData(fn: (b: Uint8Array | null) => void): void;
  /** Keyboard input: bytes the programs read. The number taken (0 once closed). */
  write(b: Uint8Array): number;
  resize(cols: number, rows: number): void;
  getFlags(): PtyFlags;
  setFlags(f: Partial<PtyFlags>): void;
  /** Run argv[0] (or `path`) in a new session on this pty; -errno if it can't start */
  spawn(argv: string[], opts: { path?: string; cwd?: string; env?: Record<string, string> }): PtyChild | number;
  close(): void;
  readonly closed: boolean;
}

export interface PtyChild {
  pid: number;
  /** kill(2): 0 or -errno */
  kill(sig: number): number;
  /** How it ended: the exit code, or the signal that ended it */
  exited: Promise<{ status: number | null; signal: number | null }>;
}
