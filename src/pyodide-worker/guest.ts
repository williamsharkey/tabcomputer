/**
 * Pyodide as a kernel guest: this runs in a Worker (host.ts starts it). It
 * loads Pyodide as soon as the page says where from, so a worker made ahead
 * of time is ready when a program comes; the kernel's start message then
 * gives it a process: its files are the tab's (kfs.ts), fds 0-2 are its
 * stdio, and it exits with the program's status.
 */
import * as A from '../kernel/abi';
import { connectGuest, isStartMessage, ChannelClosed, type GuestStartMessage, type GuestSys } from '../kernel/channel';
import { TERMIOS_SIZE } from '../kernel/pty';
import type { KfsSys } from './kfs';
import { installSupport, mountTab, runProgram, SLOW_MS, type PyRun } from './runtime';
import { runNotebookKernel, type NotebookStart } from './notebook-guest';

/** The page's first message to a new worker: where Pyodide is served from */
export interface PyodideBootMessage { type: 'pyodide-boot'; indexURL: string }

/** The kernel's start message, with what host.ts adds */
type PyodideStart = GuestStartMessage & {
  pyodide: PyRun;
  interrupt?: SharedArrayBuffer;
  /** A notebook's kernel instead of a program (notebook-guest.ts): it talks to the page over fd 3 */
  notebook?: NotebookStart;
};

/** kfs.ts's calls, on the kernel's channel */
export function kfsSys(sys: GuestSys): KfsSys {
  const ch = sys.ch;
  const enc = new TextEncoder();
  const path = (p: string): number => {
    const b = enc.encode(p);
    if (b.length > ch.data.length) return -A.ENAMETOOLONG;
    ch.data.set(b);
    return b.length;
  };
  return {
    stat: (p, follow) => (follow ? sys.stat(p) : sys.fstatat(A.AT_FDCWD, p, A.AT_SYMLINK_NOFOLLOW)),
    open: (p, flags, mode) => sys.open(p, flags, mode),
    close: (fd) => sys.close(fd),
    pread: (fd, buf, off) => sys.pread(fd, buf, off),
    pwrite: (fd, data, off) => sys.pwrite(fd, data, off),
    fstat: (fd) => sys.fstat(fd),
    readdir(p) {
      const fd = sys.open(p, A.O_RDONLY | A.O_DIRECTORY);
      if (fd < 0) return fd;
      const names: string[] = [];
      try {
        for (;;) {
          const n = ch.call(A.SYS_getdents64, fd, ch.data.length);
          if (n < 0) return n;
          if (n === 0) break;
          // linux_dirent64: ino(8) off(8) reclen(2) type(1) name\0, copied out of the shared buffer first
          const buf = ch.data.slice(0, n);
          const dv = new DataView(buf.buffer);
          for (let off = 0; off < n;) {
            const reclen = dv.getUint16(off + 16, true);
            let end = off + 19;
            while (end < off + reclen && buf[end] !== 0) end++;
            const name = A.decodeText(buf.subarray(off + 19, end));
            if (name !== '.' && name !== '..') names.push(name);
            off += reclen;
          }
        }
      } finally {
        sys.close(fd);
      }
      return names;
    },
    mkdir: (p, mode) => sys.mkdir(p, mode),
    unlink: (p) => sys.unlink(p),
    rmdir: (p) => sys.rmdir(p),
    rename: (from, to) => sys.rename(from, to),
    symlink: (target, p) => sys.symlink(target, p),
    readlink: (p) => sys.readlink(p),
    truncate(p, size) {
      const len = path(p);
      return len < 0 ? len : ch.call(A.SYS_truncate, len, size >>> 0, Math.floor(size / 0x100000000));
    },
    chmod(p, mode) {
      const len = path(p);
      return len < 0 ? len : ch.call(A.SYS_fchmodat, A.AT_FDCWD, len, mode);
    },
    utimes: (p, atimeMs, mtimeMs) => sys.utimensat(A.AT_FDCWD, p, atimeMs, mtimeMs),
  };
}

function isatty(sys: GuestSys, fd: number): boolean {
  sys.ch.data.fill(0, 0, TERMIOS_SIZE);
  return sys.ch.call(A.SYS_ioctl, fd, A.TCGETS, TERMIOS_SIZE) >= 0;
}

async function runGuest(py: any, start: PyodideStart, post: (m: unknown) => void): Promise<void> {
  const sys = connectGuest(start, post);
  try {
    // ^C: the page raises it in Pyodide's interrupt buffer (a loop that makes no calls sees it
    // there); a handler here makes the kernel end a blocked read with EINTR instead of ending us
    if (start.interrupt) {
      py.setInterruptBuffer(new Uint8Array(start.interrupt));
      sys.sigaction(A.SIGINT, { handler: 2, flags: A.SA_NODEFER }); // (a second ^C must reach the page too)
    }
    mountTab(py, kfsSys(sys));
    if (start.notebook) {
      const flag = start.interrupt ? new Uint8Array(start.interrupt) : null;
      const rc = await runNotebookKernel(py, start.notebook, start.cwd, { ...start.env, TABCOMPUTER_PID: String(start.pid) }, {
        ctlRead: (buf) => sys.read(3, buf),
        ctlWrite: (data) => { sys.write(3, data); },
        write: (fd, data) => { sys.write(fd, data); },
        interrupted: () => !!flag && Atomics.load(flag, 0) === 2,
        clearInterrupt: () => { if (flag) Atomics.store(flag, 0, 0); },
      });
      sys.exit(rc);
      return;
    }
    const flag = start.interrupt ? new Uint8Array(start.interrupt) : null;
    const rc = await runProgram(py, start.pyodide, start.cwd, { ...start.env, TABCOMPUTER_PID: String(start.pid) }, {
      read: (buf) => sys.read(0, buf),
      write: (fd, data) => { sys.write(fd, data); },
      isatty: (fd) => isatty(sys, fd),
      show: (path, title) => post({ type: 'pyodide-show', path, title }),
      interrupted: () => !!flag && Atomics.load(flag, 0) === 2,
      clearInterrupt: () => { if (flag) Atomics.store(flag, 0, 0); },
    });
    sys.exit(rc);
  } catch (e) {
    if (e instanceof ChannelClosed) return; // the process was ended: the page terminates this worker
    try { sys.write(2, `python3: ${(e as Error)?.message ?? e}\n`); } catch { /* closed */ }
    try { sys.exit(1); } catch { /* closed */ }
  }
}

/** The Worker's main: `listen` subscribes to the page's messages, `post` sends to it. */
export function pyodideGuestMain(listen: (h: (m: unknown) => void) => void, post: (m: unknown) => void): void {
  let boot: Promise<any> | null = null;
  // The page sends the place once it knows it (host.ts createWorker), which can be
  // after the program: a program waits for it
  let placed!: (p: Promise<any>) => void;
  const located = new Promise<any>((r) => { placed = r; });
  located.catch(() => { /* reported when a program asks for it */ });
  listen((m: any) => {
    if (m?.type === 'pyodide-boot' && !boot) {
      const base = String(m.indexURL).replace(/\/?$/, '/');
      boot = import(/* @vite-ignore */ `${base}pyodide.mjs`)
        .then((mod) => mod.loadPyodide({ indexURL: base }))
        .then((py) => { installSupport(py); post({ type: 'pyodide-ready' }); return py; });
      boot.catch(() => { /* reported when a program asks for it */ });
      placed(boot);
      return;
    }
    if (isStartMessage(m)) {
      const start = m as PyodideStart;
      // (the first use fetches Pyodide itself: say so on a terminal when it takes a while)
      const note = setTimeout(() => {
        try { const s = connectGuest(start, post); if (isatty(s, 2)) s.write(2, 'python3: loading Pyodide...\n'); } catch { /* closed */ }
      }, SLOW_MS);
      void located.finally(() => clearTimeout(note)).then(
        (py) => runGuest(py, start, post),
        (e) => {
          const sys = connectGuest(start, post);
          try {
            sys.write(2, `python3: could not load Pyodide: ${e?.message ?? e}\n`);
            sys.exit(1);
          } catch { /* closed */ }
        },
      );
    }
  });
}
