/**
 * A pseudo-terminal for node as a kernel guest (Bun.Terminal in claude --vm):
 * /dev/ptmx for the master, /dev/pts/N for the slave, which stays open here
 * so the terminal outlives the programs run on it, as Bun's does. Programs
 * start in a session of their own with the slave as fds 0-2 and their
 * controlling tty. The master is read with poll() from the Worker's own
 * timers, so the program's event loop keeps running.
 */
import * as A from '../kernel/abi';
import type { GuestSys } from '../kernel/channel';
import { decodeTermios, encodeTermios, encodeWinsize, TCSETS, TERMIOS_SIZE, TIOCGPTN, TIOCSWINSZ, WINSIZE_SIZE } from '../kernel/pty';
import type { PtyChild, PtyFlags, PtyHost } from './hooks';

// The Worker's own timers: the program's keep-alive is the caller's business (node-compat)
const later = globalThis.setTimeout.bind(globalThis);
const cancel = globalThis.clearTimeout.bind(globalThis);

function ioctl(sys: GuestSys, fd: number, req: number, arg: Uint8Array): number {
  sys.ch.data.set(arg);
  const r = sys.ch.call(A.SYS_ioctl, fd, req, arg.length);
  if (r >= 0) arg.set(sys.ch.data.subarray(0, arg.length));
  return r;
}

export function openGuestPty(sys: GuestSys, opts: { cols: number; rows: number }): PtyHost | number {
  const master = sys.open('/dev/ptmx', A.O_RDWR | A.O_NOCTTY | A.O_NONBLOCK | A.O_CLOEXEC);
  if (master < 0) return master;
  const n = new Uint8Array(4);
  const r = ioctl(sys, master, TIOCGPTN, n);
  const slave = r < 0 ? r : sys.open(`/dev/pts/${new DataView(n.buffer).getUint32(0, true)}`, A.O_RDWR | A.O_NOCTTY | A.O_CLOEXEC);
  if (slave < 0) { sys.close(master); return slave; }
  for (const fd of [master, slave]) sys.fcntl(fd, A.F_SETFD, A.FD_CLOEXEC);
  const winsize = (cols: number, rows: number) => {
    const w = new Uint8Array(WINSIZE_SIZE);
    encodeWinsize({ cols: Math.max(1, cols | 0), rows: Math.max(1, rows | 0), xpixel: 0, ypixel: 0 }, w);
    ioctl(sys, master, TIOCSWINSZ, w);
  };
  winsize(opts.cols, opts.rows);

  let listener: ((b: Uint8Array | null) => void) | null = null;
  const early: Uint8Array[] = [];
  let closed = false, ended = false;
  const children = new Map<number, (r: { status: number | null; signal: number | null }) => void>();
  const buf = new Uint8Array(65536);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let idle = 0;

  const emit = (b: Uint8Array | null) => {
    if (b === null) { if (ended) return; ended = true; }
    if (listener) listener(b); else if (b) early.push(b);
  };
  /** One round: what the master has, and children that ended */
  const round = (): boolean => {
    let moved = false;
    if (!closed) {
      for (;;) {
        const got = sys.read(master, buf);
        if (got > 0) { moved = true; emit(buf.slice(0, got)); continue; }
        if (got === 0 || (got !== -A.EAGAIN && got !== -A.EINTR)) host.close();
        break;
      }
    }
    for (const [pid, done] of children) {
      const w = sys.waitpid(pid, A.WNOHANG);
      if (w.pid === 0) continue;
      children.delete(pid);
      moved = true;
      const st = w.pid < 0 ? 0 : w.status;
      // (what it wrote last, before it is reported ended)
      if (!closed) round();
      done(A.WIFSIGNALED(st) ? { status: null, signal: A.WTERMSIG(st) } : { status: A.WEXITSTATUS(st), signal: null });
    }
    return moved;
  };
  const tick = () => {
    timer = null;
    // back off while nothing happens (0, 1, 2 ... 20 ms)
    idle = round() ? 0 : Math.min(20, idle + 1);
    if (!closed || children.size) timer = later(tick, idle);
  };
  const kick = () => { idle = 0; if (timer !== null) cancel(timer); timer = later(tick, 0); };
  kick();

  const host: PtyHost = {
    onData(fn) {
      listener = fn;
      for (const b of early.splice(0)) fn(b);
      if (ended) fn(null);
    },
    write(b) {
      if (closed || !b.length) return 0;
      const w = sys.write(master, b);
      kick(); // (an echo, or the program's answer, comes soon)
      return w < 0 ? 0 : w;
    },
    resize(cols, rows) { if (!closed) winsize(cols, rows); },
    getFlags(): PtyFlags {
      const t = new Uint8Array(TERMIOS_SIZE);
      if (closed || ioctl(sys, master, A.TCGETS, t) < 0) return { iflag: 0, oflag: 0, cflag: 0, lflag: 0 };
      const { iflag, oflag, cflag, lflag } = decodeTermios(t);
      return { iflag, oflag, cflag, lflag };
    },
    setFlags(f) {
      const t = new Uint8Array(TERMIOS_SIZE);
      if (closed || ioctl(sys, master, A.TCGETS, t) < 0) return;
      ioctl(sys, master, TCSETS, encodeTermios({ ...decodeTermios(t), ...f }));
    },
    spawn(argv, o): PtyChild | number {
      if (closed) return -A.EIO;
      const pid = sys.spawn(o.path ?? argv[0], argv, {
        fds: [[0, slave], [1, slave], [2, slave]], setsid: true, ctty: 0,
        ...(o.env ? { env: o.env } : {}), ...(o.cwd ? { cwd: o.cwd } : {}),
      });
      if (pid < 0) return pid;
      const exited = new Promise<{ status: number | null; signal: number | null }>((r) => children.set(pid, r));
      kick();
      return { pid, exited, kill: (sig) => sys.kill(pid, sig) };
    },
    close() {
      if (closed) return;
      closed = true;
      sys.close(slave);
      sys.close(master); // hangup: SIGHUP to the session on it
      emit(null);
      if (children.size) kick();
      else if (timer !== null) { cancel(timer); timer = null; }
    },
    get closed() { return closed; },
  };
  return host;
}
