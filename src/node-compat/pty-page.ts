/**
 * A pseudo-terminal for node in the page (Bun.Terminal in claude --vm without
 * the node worker): a kernel pty, and programs started on it as kernel
 * processes in a session of their own. node-worker/pty.ts does the same with
 * syscalls for node as a kernel guest.
 */
import * as A from '../kernel/abi';
import type { Kernel } from '../kernel/kernel';
import { attachKernelTty, openpty, O_RDWR, O_NOCTTY, type PtyFile } from '../kernel/pty';
import type { PtyChild, PtyFlags, PtyHost } from '../node-worker/hooks';

export function openKernelPty(kernel: Kernel, opts: { cols: number; rows: number }): PtyHost {
  attachKernelTty(kernel); // (job control for the session; /dev/pts/N, as ttyname finds it)
  const { pty, master, slave } = openpty({ winsize: { cols: Math.max(1, opts.cols | 0), rows: Math.max(1, opts.rows | 0) } });
  let closed = false;
  let listener: ((b: Uint8Array | null) => void) | null = null;
  const early: Uint8Array[] = [];
  pty.onOutput((b) => { if (listener) listener(b.slice()); else early.push(b.slice()); });
  const host: PtyHost = {
    onData(fn) {
      listener = fn;
      for (const b of early.splice(0)) fn(b);
      if (closed) fn(null);
    },
    write(b) {
      if (closed || !b.length) return 0;
      pty.input(b);
      return b.length;
    },
    resize(cols, rows) { if (!closed) pty.setWinsize({ cols: Math.max(1, cols | 0), rows: Math.max(1, rows | 0) }); },
    getFlags(): PtyFlags {
      const { iflag, oflag, cflag, lflag } = pty.termios;
      return { iflag, oflag, cflag, lflag };
    },
    setFlags(f) { if (!closed) pty.setTermios({ ...pty.termios, ...f }); },
    spawn(argv, o): PtyChild | number {
      if (closed) return -A.EIO;
      const tty = pty.openSlave(O_RDWR | O_NOCTTY) as PtyFile;
      const proc = kernel.spawn({
        path: o.path ?? argv[0], argv, fds: { 0: tty, 1: tty, 2: tty }, setsid: true, ctty: 0,
        ...(o.env ? { env: o.env } : {}), ...(o.cwd ? { cwd: o.cwd } : {}),
      });
      const exited = proc.wait().then(async (st) => {
        await kernel.waitpid(proc.pid, A.WNOHANG); // (reaped now, not by init later)
        return A.WIFSIGNALED(st) ? { status: null, signal: A.WTERMSIG(st) } : { status: A.WEXITSTATUS(st), signal: null };
      });
      return { pid: proc.pid, exited, kill: (sig) => kernel.kill(proc.pid, sig) };
    },
    close() {
      if (closed) return;
      closed = true;
      void slave.close();
      void master.close(); // hangup: SIGHUP to the session on it
      listener?.(null);
    },
    get closed() { return closed; },
  };
  return host;
}
