/**
 * The page's side of Pyodide as a kernel guest: a Python program that needs
 * compiled packages (numpy, pandas, matplotlib) runs as a kernel process
 * whose program is a Worker with Pyodide in it (guest.ts). The page's main
 * thread only answers its syscalls, so a long loop doesn't freeze the
 * desktop; its files are the tab's, its stdin the terminal's, ^C is
 * KeyboardInterrupt, and plt.show() opens a window.
 *
 * Needs a blocking channel (a cross-origin isolated page). python.ts keeps
 * the old in-page Pyodide for a page without one.
 */
import type { CommandContext } from '../commands/index';
import * as A from '../kernel/abi';
import { BufferFile, type OpenFile } from '../kernel/fd';
import type { Kernel, Runner } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { pyodideWorkerFactory, pyodideWorkerMode } from './boot';
import { webWorker, workerRunner, type GuestWorker } from '../kernel/worker-host';
import { pyodideIndexURL } from '../python/pyodide-dist';
import type { PyRun } from './runtime';

export { setPyodideWorkerFactory, pyodideWorkerMode } from './boot';

function createWorker(): GuestWorker {
  const factory = pyodideWorkerFactory();
  const w = factory ? factory() : webWorker(new Worker(new URL('./guest-entry.ts', import.meta.url), { type: 'module', name: 'pyodide' }));
  // (it starts loading Pyodide now, before any program is given to it. The page's first
  // use asks this site whether it has the distribution, so the place can arrive after
  // the program: the worker waits for it)
  void pyodideIndexURL().then((indexURL) => { try { w.postMessage({ type: 'pyodide-boot', indexURL }); } catch { /* terminated */ } });
  return w;
}

/**
 * One worker made ahead: a finished program's Python state can't be reused,
 * so each program gets a fresh Pyodide, and the next one is loaded (about a
 * second) as soon as one is taken. It goes when unused for a while.
 */
let spare: GuestWorker | null = null;
let spareTimer: ReturnType<typeof setTimeout> | null = null;
let SPARE_IDLE_MS = 180_000;
/** (tests) */
export function setPyodideSpareIdleMs(ms: number): void { SPARE_IDLE_MS = ms; }

export function dropSpare(): void {
  if (spareTimer) clearTimeout(spareTimer);
  spareTimer = null;
  const w = spare;
  spare = null;
  try { void w?.terminate(); } catch { /* gone */ }
}

function prepareSpare(): void {
  if (spare) return;
  try { spare = createWorker(); } catch { spare = null; return; }
  const mine = spare;
  mine.onError(() => { if (spare === mine) dropSpare(); });
  if (spareTimer) clearTimeout(spareTimer);
  spareTimer = setTimeout(dropSpare, SPARE_IDLE_MS);
}

/** A worker with Pyodide loading or loaded, for one process (the notebook kernel takes one too: src/notebook/kernel.ts) */
export function takeWorker(): GuestWorker {
  const w = spare ?? createWorker();
  spare = null;
  if (spareTimer) clearTimeout(spareTimer);
  spareTimer = null;
  // (the next one loads while this program runs, on a thread of its own)
  setTimeout(prepareSpare, 0);
  return w;
}

/**
 * After `pip install numpy`: fetch what the first program will need (the
 * browser's HTTP cache keeps it for the Worker) and load a Pyodide ahead.
 */
export function warmPyodide(files: string[] = []): void {
  if (!pyodideWorkerMode() || typeof fetch !== 'function') return;
  void pyodideIndexURL().then((base) => {
    for (const f of new Set(files)) void fetch(base + f).then((r) => r.arrayBuffer()).catch(() => {});
  });
  prepareSpare();
}

/** plt.show(): the figure saved at `path`, in a desktop window; where there is no desktop, a line saying where it is */
async function showFigure(kernel: Kernel, proc: Process, path: string, title: string): Promise<void> {
  const fs = kernel.fs;
  const wm = (globalThis as any).__tabcomputer?.desktop;
  const say = (s: string) => { void kernel.writeAll(proc, 2, new TextEncoder().encode(s)).catch(() => {}); };
  if (!fs || !wm?.createWindow || typeof document === 'undefined') {
    say(`${title}: saved to ${path} (no desktop to show it in)\n`);
    return;
  }
  try {
    const data = await fs.readFile(path) as Uint8Array;
    const url = URL.createObjectURL(new Blob([data.slice()], { type: 'image/png' }));
    const box = document.createElement('div');
    box.className = 'sd-app';
    box.dataset.figure = path;
    box.style.cssText = 'align-items:center;justify-content:center;background:#fff';
    const img = document.createElement('img');
    img.alt = title;
    img.style.cssText = 'max-width:100%;max-height:100%;object-fit:contain';
    box.appendChild(img);
    // (the window takes the figure's shape once the picture is decoded)
    await new Promise<void>((resolve) => { img.onload = img.onerror = () => resolve(); img.src = url; });
    const scale = Math.min(1, 720 / (img.naturalWidth || 640));
    const w = wm.createWindow({
      // (on top, but the keyboard stays where the program was started)
      appId: 'python-figure', title, focus: false, content: { kind: 'dom', element: box },
      width: Math.round((img.naturalWidth || 640) * scale), height: Math.round((img.naturalHeight || 480) * scale),
    });
    w.on?.('close', () => URL.revokeObjectURL(url));
  } catch (e: any) {
    say(`${title}: saved to ${path} (could not open a window: ${e?.message ?? e})\n`);
  }
}

/** The kernel Runner: the process's program is a Pyodide guest worker running `run` */
export function pyodideRunner(run: PyRun): Runner {
  return (proc, kernel) => {
    // ^C. A handler in the guest keeps the kernel from ending the process; here the page raises
    // Pyodide's interrupt (KeyboardInterrupt at the next bytecode). A second ^C that finds the
    // first one not taken (a long call into compiled code, which never looks) ends the process.
    const interrupt = new SharedArrayBuffer(4);
    const flag = new Uint8Array(interrupt);
    let raisedAt = 0;
    const off = proc.addSignalListener((sig) => {
      if (sig !== A.SIGINT) return;
      const now = Date.now();
      if (Atomics.load(flag, 0) === 2 && now - raisedAt > 400) { kernel.kill(proc.pid, A.SIGKILL); return; }
      if (Atomics.load(flag, 0) !== 2) raisedAt = now;
      Atomics.store(flag, 0, 2);
    });
    proc.onTerminate(off);
    return workerRunner((p) => {
      const w = takeWorker();
      w.onMessage((m: any) => {
        if (m?.type === 'pyodide-show' && typeof m.path === 'string') void showFigure(kernel, p, m.path, String(m.title ?? 'Figure'));
      });
      return w;
    }, { dataSize: 1 << 20, startData: { pyodide: run, interrupt } })(proc, kernel);
  };
}

/** A program for the shell's kernel pipeline (pkg-manager.ts packageKernelProgram) */
export function pyodideKernelProgram(run: PyRun, argv0 = 'python3'): { argv: string[]; run: Runner } {
  return { argv: [argv0, ...run.argv.slice(run.kind === 'repl' ? 1 : 0)], run: pyodideRunner(run) };
}

/** Run `run` for a shell command: a foreground job on the terminal's pty, or on the shell's stdio */
export async function runPyodide(ctx: CommandContext, run: PyRun, argv0 = 'python3'): Promise<number> {
  const { argv } = pyodideKernelProgram(run, argv0);
  const env = { ...ctx.env };
  delete env.__PIPE_STDIN;
  const { kernelForContext } = await import('../wasi/run-command');
  const kernel = kernelForContext(ctx);
  const term = ctx.terminal;
  const toTerminal = !!term && ctx.stdoutIsTTY !== false;
  const readStdin = (ctx as any).readStdin as (() => Promise<string>) | undefined;
  if (!ctx.stdin && readStdin && !(toTerminal && term!.tty)) ctx.stdin = await readStdin();
  if (toTerminal && term!.tty && ctx.shell) {
    const { runKernelPipeline } = await import('../shell-kernel');
    const r = await runKernelPipeline(ctx.shell, [{ argv, run: pyodideRunner(run) }], {
      stdin: ctx.stdin ? ctx.stdin : undefined,
      captureStdout: false,
      captureStderr: false,
      stderrSink: ctx.stderrIsTTY === false ? (ctx.streamStderr ?? ((t) => { ctx.stderr += t; })) : undefined,
      writeStdout: (t) => { ctx.stdout += t; },
      writeStderr: (t) => { ctx.stderr += t; },
      terminal: term,
      command: argv.join(' '),
      cwd: ctx.cwd,
      env,
    });
    return r.exitCode;
  }
  const { SinkFile } = await import('../wasi/stdio');
  const fds: Record<number, OpenFile> = {
    0: new BufferFile(ctx.stdin || '', A.O_RDONLY, { fifo: !!ctx.stdin }),
    1: toTerminal
      ? new SinkFile((t) => term!.writeOutput(t.replace(/\r?\n/g, '\r\n')), { tty: true })
      : new SinkFile(ctx.streamStdout ?? ((t) => { ctx.stdout += t; })),
    2: term && ctx.stderrIsTTY !== false && !ctx.streamStderr
      ? new SinkFile((t) => term.writeOutput(t.replace(/\r?\n/g, '\r\n')), { tty: true })
      : new SinkFile(ctx.streamStderr ?? ((t) => { ctx.stderr += t; })),
  };
  const proc = kernel.spawn({ path: argv0, argv, env, cwd: ctx.cwd, fds, pgid: 0, run: pyodideRunner(run) });
  const abort = (ctx.shell as any)?.abortController as AbortController | null | undefined;
  const onAbort = () => {
    const sig = (abort?.signal.reason as { signal?: unknown } | undefined)?.signal;
    kernel.kill(-proc.pgid, typeof sig === 'number' ? sig : A.SIGINT);
  };
  abort?.signal.addEventListener('abort', onAbort);
  try {
    const status = await proc.wait();
    await kernel.waitpid(proc.pid, A.WNOHANG);
    return A.shellExitCode(status);
  } finally {
    abort?.signal.removeEventListener('abort', onAbort);
  }
}
