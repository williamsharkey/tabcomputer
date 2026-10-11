/**
 * /proc as the kernel sees it: per-process directories (`/proc/PID`,
 * `/proc/self`) and the system files that need the process table
 * (`/proc/stat`, `/proc/loadavg`, `/proc/uptime`). Everything else under /proc
 * (cpuinfo, meminfo, version, ...) is the FileSystem's virtual provider.
 *
 * The kernel consults `ProcFs` before the filesystem in open, stat, readlink
 * and getdents. Files are generated when opened (a snapshot, like Linux's
 * seq_file), so `cat /proc/PID/stat` and ps/top/htop read consistent lines.
 *
 * CPU time is an estimate: a process's wall time minus the time it spends
 * blocked in kernel syscalls (2 ms or more) and in waits the engine reports
 * (SYS_shiro_sleeping; `Process.kernelMs`), for processes that make syscalls through a channel
 * (programs in workers). A busy loop shows as
 * busy, a shell waiting at its prompt as idle. Memory sizes are not known to
 * the kernel and read as 0.
 */
import * as A from './abi';
import { DirFile, EventFile, ReadyListeners, TimerFile, type OpenFile } from './fd';
import { InotifyFile } from './inotify';
import type { FileSystem } from '../filesystem';
import type { Kernel } from './kernel';
import type { Process } from './process';

/** USER_HZ: the clock ticks /proc counts in. */
const HZ = 100;
/** When this page "booted": /proc/uptime, btime and process start times count from here. */
export const bootMs = Date.now();
const PAGE = 4096;

type Node =
  | { type: 'dir'; list: () => string[] }
  | { type: 'file'; text: () => string | Uint8Array }
  | { type: 'link'; target: () => string };

/** A directory under /proc; getdents reads its generated entries. */
class ProcDirFile extends DirFile {
  constructor(fs: FileSystem, path: string, flags: number, private names: () => string[]) {
    super(fs, path, flags);
  }
  private list: string[] | null = null;
  override seek(off: number, whence: number): number {
    if (whence === A.SEEK_SET && off === 0) { this.list = null; return 0; }
    return -A.ESPIPE;
  }
  override async readdir(): Promise<string[] | number> {
    this.list ??= ['.', '..', ...this.names()];
    return this.list;
  }
  override consume(n: number): void { this.list?.splice(0, n); }
  override async stat(): Promise<A.KStat> { return dirStat(this.path); }
}

/**
 * A generated /proc file: its text is taken when first read after open or a
 * seek back to the start, so programs that keep it open and rewind it
 * (procps' /proc/stat, top's refresh) see fresh values, as on Linux.
 */
class ProcFile implements OpenFile {
  kind = 'file' as const;
  private data: Uint8Array | null = null;
  private pos = 0;
  private listeners = new ReadyListeners();
  constructor(public path: string, public flags: number, private text: () => string | Uint8Array) {}
  private content(): Uint8Array {
    const t = this.text();
    return typeof t === 'string' ? new TextEncoder().encode(t) : t;
  }
  private snapshot(): Uint8Array {
    this.data ??= this.content();
    return this.data;
  }
  async read(buf: Uint8Array): Promise<number> {
    const d = this.snapshot();
    const n = Math.max(0, Math.min(buf.length, d.length - this.pos));
    buf.set(d.subarray(this.pos, this.pos + n));
    this.pos += n;
    return n;
  }
  async pread(buf: Uint8Array, off: number): Promise<number> {
    const d = off === 0 ? (this.data = this.content()) : this.snapshot();
    const n = Math.max(0, Math.min(buf.length, d.length - off));
    buf.set(d.subarray(off, off + n));
    return n;
  }
  async write(): Promise<number> { return -A.EBADF; }
  seek(off: number, whence: number): number {
    const base = whence === A.SEEK_SET ? 0 : whence === A.SEEK_CUR ? this.pos : whence === A.SEEK_END ? this.snapshot().length : -1;
    if (base < 0 || base + off < 0) return -A.EINVAL;
    this.pos = base + off;
    if (this.pos === 0) this.data = null; // regenerate on the next read
    return this.pos;
  }
  poll(events: number): number { return events & (A.POLLIN | A.POLLOUT); }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }
  async stat(): Promise<A.KStat> {
    const now = Date.now();
    return {
      dev: 4, ino: procIno(this.path), mode: A.S_IFREG | 0o444, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
      size: 0, blksize: 1024, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }
  async close(): Promise<void> {}
}

function dirStat(path: string): A.KStat {
  return {
    dev: 4, ino: procIno(path), mode: A.S_IFDIR | 0o555, nlink: 2, uid: 1000, gid: 1000, rdev: 0,
    size: 0, blksize: 1024, blocks: 0, atimeMs: bootMs, mtimeMs: bootMs, ctimeMs: bootMs,
  };
}

const procInos = new Map<string, number>();
function procIno(path: string): number {
  let n = procInos.get(path);
  if (!n) { n = 0x40000000 + procInos.size; procInos.set(path, n); }
  return n;
}

/** Linux's new_encode_dev */
function encodeDev(major: number, minor: number): number {
  return (minor & 0xff) | (major << 8) | ((minor & ~0xff) << 12);
}

export class ProcFs {
  constructor(private kernel: Kernel) {}

  /** CPU time of processes gone from the table, and the last value seen per pid (counters only grow). */
  private retiredMs = 0;
  private seenMs = new Map<number, number>();
  /** The last /proc/stat counters handed out: top and vmstat reject counters that go backwards. */
  private lastUser = 0;
  private lastIdle = 0;

  /** Total CPU ms of every process so far, alive or not. */
  private totalCpuMs(now: number): number {
    let live = 0;
    const alive = new Set<number>();
    for (const p of this.live()) {
      const ms = ProcFs.cpuMs(p, now);
      live += ms;
      alive.add(p.pid);
      this.seenMs.set(p.pid, ms);
    }
    for (const [pid, ms] of this.seenMs) {
      if (!alive.has(pid)) { this.retiredMs += ms; this.seenMs.delete(pid); }
    }
    return this.retiredMs + live;
  }

  /** CPU time of `p` in ms (see the file comment). */
  static cpuMs(p: Process, now = Date.now()): number {
    if (!p.syscalls) return 0;
    const end = p.state === 'zombie' && p.exitTime ? p.exitTime : now;
    const asleep = p.engineSleeps > 0 ? Math.max(0, end - p.engineSleepSince) : 0;
    // and a call it is blocked in now (wait4, a read): counted once it ends, as kernelMs
    const blocked = p.state !== 'zombie' && p.inSyscall > 0 && end - p.syscallSince >= 2 ? end - p.syscallSince : 0;
    return Math.max(0, end - p.startTime - p.kernelMs - Math.max(asleep, blocked));
  }

  private live(): Process[] {
    return [...this.kernel.procs.values()].filter((p) => p.pid > 0).sort((a, b) => a.pid - b.pid);
  }

  /** The node at `path` (absolute, normalized), undefined when it isn't ours. */
  private node(proc: Process, path: string): Node | undefined {
    if (path === '/proc') {
      return {
        type: 'dir', list: () => {
          const names = new Set([...this.fsNames(), 'self', 'thread-self', 'sysvipc', 'net', ...this.live().map((p) => String(p.pid))]);
          // the names, then the pids in order (procps lists them as readdir returns them)
          const pids = [...names].filter((n) => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b));
          return [...[...names].filter((n) => !/^\d+$/.test(n)), ...pids];
        },
      };
    }
    if (!path.startsWith('/proc/')) return undefined;
    const parts = path.slice(6).split('/');
    const head = parts[0];
    if (head === 'self' || head === 'thread-self') {
      if (parts.length === 1) return { type: 'link', target: () => String(proc.pid) };
      return this.pidNode(proc, proc, parts.slice(1));
    }
    if (/^\d+$/.test(head)) {
      const p = this.kernel.procs.get(Number(head));
      if (!p) {
        // A thread's tid names it too, as on Linux (not listed in /proc)
        const tid = Number(head);
        const owner = this.kernel.processOfTid(tid);
        if (!owner) return undefined;
        return parts.length === 1 ? { type: 'dir', list: () => PID_ENTRIES } : this.threadNode(proc, owner, tid, parts.slice(1));
      }
      return parts.length === 1 ? { type: 'dir', list: () => PID_ENTRIES } : this.pidNode(proc, p, parts.slice(1));
    }
    if (head === 'sysvipc') {
      if (parts.length === 1) return { type: 'dir', list: () => ['msg', 'sem', 'shm'] };
      if (parts.length === 2 && (parts[1] === 'shm' || parts[1] === 'sem' || parts[1] === 'msg')) {
        const which = parts[1];
        return { type: 'file', text: () => this.sysvipcText(which) };
      }
      return undefined;
    }
    if (head === 'net') {
      if (parts.length === 1) return { type: 'dir', list: () => ['tcp', 'tcp6'] };
      if (parts.length === 2 && (parts[1] === 'tcp' || parts[1] === 'tcp6')) {
        const v6 = parts[1] === 'tcp6';
        return { type: 'file', text: () => this.netTcpText(v6) };
      }
      return undefined;
    }
    if (parts.length !== 1) return undefined;
    switch (head) {
      case 'stat': return { type: 'file', text: () => this.statText() };
      case 'vmstat': return { type: 'file', text: () => VMSTAT_KEYS.map((k) => `${k} 0`).join('\n') + '\n' };
      case 'loadavg': return { type: 'file', text: () => this.loadavgText() };
      case 'config.gz': return { type: 'file', text: () => gzipStored(new TextEncoder().encode(KCONFIG)) };
      case 'uptime': return { type: 'file', text: () => {
        const up = (Date.now() - bootMs) / 1000;
        const idle = Math.max(0, up * this.ncpu() - this.live().reduce((s, p) => s + ProcFs.cpuMs(p) / 1000, 0));
        return `${up.toFixed(2)} ${idle.toFixed(2)}\n`;
      } };
    }
    return undefined;
  }

  /**
   * /proc/net/tcp and tcp6 as Linux prints them: every TCP socket some
   * process holds that is bound, listening or connected, its addresses in
   * hex (each 32-bit word in host order), state, queues, owner uid and inode
   * (the N of socket:[N] in /proc/PID/fd), so ss/netstat-style readers can
   * map inodes to endpoints.
   */
  private netTcpText(v6: boolean): string {
    const family = v6 ? A.AF_INET6 : A.AF_INET;
    const seen = new Set<number>();
    const rows: string[] = [];
    for (const p of this.live()) {
      for (const [, f] of p.fds.entries()) {
        const s = f as OpenFile & { ino?: number; domain?: number; type?: number; netInfo?: () => NetInfo };
        if (f.kind !== 'socket' || !s.netInfo || s.domain !== family || (s.type ?? A.SOCK_STREAM) !== A.SOCK_STREAM) continue;
        if (seen.has(s.ino ?? 0)) continue;
        seen.add(s.ino ?? 0);
        const n = s.netInfo();
        const st = TCP_STATES[n.state];
        if (!st) continue;
        const sl = String(rows.length).padStart(4) + ':';
        const addr = (a: SockAddrLike | null) => `${hexAddr(a?.address ?? '', v6)}:${hex(a?.port ?? 0, 4)}`;
        rows.push(`${sl} ${addr(n.local)} ${addr(n.remote)} ${st} ${hex(n.txQueue, 8)}:${hex(n.rxQueue, 8)} 00:00000000 00000000 ${String(p.uid ?? 0).padStart(5)} ${'0'.padStart(8)} ${s.ino ?? 0} 1 0000000000000000 100 0 0 10 0`);
      }
    }
    const head = v6
      ? '  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode'
      : '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode';
    return [head, ...rows].join('\n') + '\n';
  }

  /** /proc/PID/task/TID/...: the thread's own stat, status, syscall and wchan; the rest are its process's */
  private threadNode(caller: Process, p: Process, tid: number, rest: string[]): Node | undefined {
    if (rest.length === 1) {
      switch (rest[0]) {
        case 'stat': return { type: 'file', text: () => this.pidStat(p, tid) };
        case 'status': return { type: 'file', text: () => this.pidStatus(p, tid) };
        case 'syscall': return { type: 'file', text: () => threadSyscallText(p, tid) };
        case 'wchan': return { type: 'file', text: () => threadWchanText(p, tid) };
        case 'task': return undefined;
      }
    }
    return rest[0] === 'task' ? undefined : this.pidNode(caller, p, rest);
  }

  /** Each thread's state (kernel.threadStates): what /proc/PID/task/TID shows */
  threadStates(p: Process): ThreadState[] {
    const now = Date.now();
    return threadIds(p).map((tid) => {
      const c = threadCall(p, tid);
      const lock = c ? null : engineLock(p);
      const waitsLock = !!lock && lock.holder !== 0 && lock.holder !== tid;
      const w = c ? waitOf(p, c.nr, c.args) : { kind: waitsLock ? 'engine' : '' };
      return {
        tid, state: this.threadLetter(p, tid), nr: c ? c.nr : -1, args: c ? Array.from(c.args).slice(0, 6) : [],
        sinceMs: c ? now - c.since : 0, syscalls: p.threads.get(tid)?.syscalls ?? 0,
        waitKind: w.kind, ...(w.fd !== undefined ? { fd: w.fd } : {}), ...(w.fds ? { fds: w.fds } : {}),
      };
    });
  }

  /**
   * A thread's state letter: blocked in a syscall for 2 ms or more, or (with
   * the engine's lock word) waiting for another thread's engine lock, is S;
   * the main thread with no record of its own is its process's.
   */
  private threadLetter(p: Process, tid: number): string {
    if (p.state === 'zombie') return 'Z';
    if (p.state === 'stopped') return 'T';
    const c = threadCall(p, tid);
    if (c) return Date.now() - c.since >= 2 ? 'S' : 'R';
    const lock = engineLock(p);
    if (lock && lock.holder !== 0 && lock.holder !== tid) return 'S';
    if (tid === p.pid && !p.threads.get(tid)?.syscalls) return this.stateLetter(p);
    return 'R';
  }

  private pidNode(caller: Process, p: Process, rest: string[]): Node | undefined {
    const [name, sub] = rest;
    if (rest.length === 2 && name === 'fd') {
      const f = p.fds.get(Number(sub));
      if (!/^\d+$/.test(sub) || !f) return undefined;
      return { type: 'link', target: () => fdTarget(f) };
    }
    if (rest.length === 2 && name === 'fdinfo') {
      const f = p.fds.get(Number(sub));
      if (!/^\d+$/.test(sub) || !f) return undefined;
      return { type: 'file', text: () => fdInfo(f, p.fds.getCloexec(Number(sub)) ?? false) };
    }
    if (rest.length >= 2 && name === 'task') {
      const tid = Number(sub);
      if (!/^\d+$/.test(sub) || !threadIds(p).includes(tid)) return undefined;
      if (rest.length === 2) return { type: 'dir', list: () => PID_ENTRIES.filter((e) => e !== 'task') };
      return this.threadNode(caller, p, tid, rest.slice(2));
    }
    if (rest.length !== 1) return undefined;
    switch (name) {
      case 'fd':
      case 'fdinfo': return { type: 'dir', list: () => p.fds.entries().map(([fd]) => String(fd)) };
      case 'task': return { type: 'dir', list: () => threadIds(p).map(String) };
      case 'cwd': return { type: 'link', target: () => p.cwd };
      // A runner can name the program the process reports as itself (a WASI package's "self")
      // Linux gives the resolved path: glibc's ld.so expands $ORIGIN from it, and a
      // venv's bin/python is a symlink to an interpreter with RUNPATH $ORIGIN/../lib
      // (readlink also resolves what isn't cached)
      case 'exe': return { type: 'link', target: () => {
        const exe = typeof p.data.exe === 'string' ? p.data.exe : p.path;
        return (exe.startsWith('/') && this.kernel.fs?.realpathCached?.(exe)) || exe;
      } };
      case 'root': return { type: 'link', target: () => '/' };
      case 'cmdline': return { type: 'file', text: () => (p.state === 'zombie' ? '' : p.argv.map((a) => a + '\0').join('')) };
      case 'comm': return { type: 'file', text: () => p.comm.slice(0, 15) + '\n' };
      case 'environ': return { type: 'file', text: () => Object.entries(p.env).map(([k, v]) => `${k}=${v}\0`).join('') };
      case 'stat': return { type: 'file', text: () => this.pidStat(p) };
      case 'statm': return { type: 'file', text: () => '0 0 0 0 0 0 0\n' };
      case 'status': return { type: 'file', text: () => this.pidStatus(p) };
      // What a hung process is blocked in: the oldest syscall in progress
      // (nr and six args in hex; sp and pc aren't known: 0), or "running"
      case 'syscall': return { type: 'file', text: () => syscallText(p) };
      case 'wchan': return { type: 'file', text: () => wchanText(p) };
      case 'io': return { type: 'file', text: () => 'rchar: 0\nwchar: 0\nsyscr: 0\nsyscw: 0\nread_bytes: 0\nwrite_bytes: 0\ncancelled_write_bytes: 0\n' };
      case 'mounts': return { type: 'file', text: () => 'rootfs / rootfs rw 0 0\nproc /proc proc rw 0 0\n' };
    }
    return undefined;
  }

  /** /proc/sysvipc/{shm,sem,msg}, in Linux's columns (util-linux's ipcs reads them) */
  private sysvipcText(which: 'shm' | 'sem' | 'msg'): string {
    const k = this.kernel;
    const o = (n: number) => n.toString(8).padStart(4);
    const r = (n: number | string, w: number) => String(n).padStart(w);
    if (which === 'shm') {
      return '       key      shmid perms                  size  cpid  lpid nattch   uid   gid  cuid  cgid      atime      dtime      ctime                   rss                  swap\n'
        + k.shm.list().map((s) => `${r(s.key, 10)} ${r(s.id, 10)}  ${o(s.mode)} ${r(s.size, 21)} ${r(s.cpid, 5)} ${r(s.lpid, 5)}  ${r(s.nattch, 5)} ${r(s.uid, 5)} ${r(s.gid, 5)} ${r(s.cuid, 5)} ${r(s.cgid, 5)} ${r(s.atime, 10)} ${r(s.dtime, 10)} ${r(s.ctime, 10)} ${r(Math.ceil(s.size / 4096) * 4096, 21)} ${r(0, 21)}\n`).join('');
    }
    if (which === 'sem') {
      return '       key      semid perms      nsems   uid   gid  cuid  cgid      otime      ctime\n'
        + k.sem.list().map((s) => `${r(s.key, 10)} ${r(s.id, 10)}  ${o(s.mode)} ${r(s.vals.length, 10)} ${r(s.uid, 5)} ${r(s.gid, 5)} ${r(s.cuid, 5)} ${r(s.cgid, 5)} ${r(s.otime, 10)} ${r(s.ctime, 10)}\n`).join('');
    }
    return '       key      msqid perms      cbytes       qnum lspid lrpid   uid   gid  cuid  cgid      stime      rtime      ctime\n'
      + k.msg.list().map((q) => `${r(q.key, 10)} ${r(q.id, 10)}  ${o(q.mode)}  ${r(q.bytes, 10)} ${r(q.qnum, 10)} ${r(q.lspid, 5)} ${r(q.lrpid, 5)} ${r(q.uid, 5)} ${r(q.gid, 5)} ${r(q.cuid, 5)} ${r(q.cgid, 5)} ${r(q.stime, 10)} ${r(q.rtime, 10)} ${r(q.ctime, 10)}\n`).join('');
  }

  private fsNames(): string[] {
    // The FileSystem's virtual /proc entries (cpuinfo, meminfo, version, ...)
    const fsAny = this.kernel.fs as unknown as { virtualProviders?: { readdir?(p: string): string[] | null }[] } | undefined;
    for (const vp of fsAny?.virtualProviders ?? []) {
      const list = vp.readdir?.('/proc');
      // (with the pids of in-page shells, which the FileSystem's /proc describes)
      if (list) return list.filter((n) => n !== 'self');
    }
    return ['cpuinfo', 'meminfo', 'version', 'filesystems', 'mounts'];
  }

  private ncpu(): number {
    return (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 4;
  }

  private stateLetter(p: Process): string {
    if (p.state === 'zombie') return 'Z';
    if (p.state === 'stopped') return 'T';
    return p.sleeping() || !p.syscalls ? 'S' : 'R';
  }

  private ttyOf(p: Process): { nr: number; tpgid: number } {
    const t = p.ctty as (OpenFile & { pty?: { index: number; fgPgrp: number } }) | undefined;
    if (!t?.pty) return { nr: 0, tpgid: -1 };
    return { nr: encodeDev(136, t.pty.index), tpgid: t.pty.fgPgrp || -1 };
  }

  private pidStat(p: Process, tid?: number): string {
    const now = Date.now();
    const ticks = (ms: number) => Math.floor(ms / (1000 / HZ));
    const cpu = ticks(ProcFs.cpuMs(p, now));
    const { nr, tpgid } = this.ttyOf(p);
    const f = [
      tid ?? p.pid, `(${p.comm.slice(0, 15)})`, tid !== undefined ? this.threadLetter(p, tid) : this.stateLetter(p), p.ppid, p.pgid, p.sid, nr, tpgid,
      0x400000, 0, 0, 0, 0, cpu, 0, 0, 0, 20, 0, threadIds(p).length, 0, ticks(p.startTime - bootMs),
      0, 0, '18446744073709551615', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 17, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    return f.join(' ') + '\n';
  }

  private pidStatus(p: Process, tid?: number): string {
    const st = tid !== undefined ? this.threadLetter(p, tid) : this.stateLetter(p);
    const names: Record<string, string> = { R: 'R (running)', S: 'S (sleeping)', T: 'T (stopped)', Z: 'Z (zombie)' };
    const pending = [...p.pendingSignals].reduce((m, s) => m | (1n << BigInt(s - 1)), 0n);
    const blocked = [...p.sigmask].reduce((m, s) => m | (1n << BigInt(s - 1)), 0n);
    const ignored = [...p.dispositions].filter(([, d]) => d === 'ignore').reduce((m, [s]) => m | (1n << BigInt(s - 1)), 0n);
    const caught = [...p.dispositions].filter(([, d]) => typeof d === 'number').reduce((m, [s]) => m | (1n << BigInt(s - 1)), 0n);
    const hex = (n: bigint) => n.toString(16).padStart(16, '0');
    return [
      `Name:\t${p.comm.slice(0, 15)}`, `Umask:\t${p.umask.toString(8).padStart(4, '0')}`, `State:\t${names[st]}`,
      `Tgid:\t${p.pid}`, 'Ngid:\t0', `Pid:\t${tid ?? p.pid}`, `PPid:\t${p.ppid}`, 'TracerPid:\t0',
      `Uid:\t${p.ruid ?? p.uid}\t${p.uid}\t${p.suid ?? p.uid}\t${p.uid}`, `Gid:\t${p.rgid ?? p.gid}\t${p.gid}\t${p.sgid ?? p.gid}\t${p.gid}`,
      `FDSize:\t${Math.max(64, p.fds.size)}`, `Groups:\t${(p.groups ?? [p.gid]).join(' ')}`,
      'VmPeak:\t       0 kB', 'VmSize:\t       0 kB', 'VmRSS:\t       0 kB', `Threads:\t${threadIds(p).length}`,
      `SigPnd:\t${hex(0n)}`, `ShdPnd:\t${hex(pending)}`, `SigBlk:\t${hex(blocked)}`, `SigIgn:\t${hex(ignored)}`, `SigCgt:\t${hex(caught)}`,
      `Cpus_allowed_list:\t0-${this.ncpu() - 1}`, 'voluntary_ctxt_switches:\t0', 'nonvoluntary_ctxt_switches:\t0',
      // The engine's lock (Blink's GIL): which thread runs guest code, when the engine says
      ...(p.data.engine ? [`EngineLock:\t${engineLockText(p)}`] : []),
    ].join('\n') + '\n';
  }

  private statText(): string {
    const now = Date.now();
    const n = this.ncpu();
    const ticks = (ms: number) => Math.floor(ms / (1000 / HZ));
    const procs = this.live();
    const user = this.lastUser = Math.max(this.lastUser, ticks(this.totalCpuMs(now)));
    const idle = this.lastIdle = Math.max(this.lastIdle, ticks((now - bootMs) * n) - user);
    const line = (name: string, u: number, i: number) => `${name} ${u} 0 0 ${i} 0 0 0 0 0 0`;
    const lines = [line('cpu ', user, idle)];
    for (let c = 0; c < n; c++) lines.push(line(`cpu${c}`, Math.floor(user / n), Math.floor(idle / n)));
    const running = procs.filter((p) => this.stateLetter(p) === 'R').length;
    lines.push('intr 0', 'ctxt 0', `btime ${Math.floor(bootMs / 1000)}`, `processes ${this.kernel.lastPid}`,
      `procs_running ${Math.max(1, running)}`, 'procs_blocked 0');
    return lines.join('\n') + '\n';
  }

  /** Processes running now (state R). */
  running(): number {
    return this.live().filter((p) => this.stateLetter(p) === 'R').length;
  }

  /** The 1, 5 and 15 minute load averages (/proc/loadavg, sysinfo). */
  readonly load = new LoadAvg();
  private loadTimer?: ReturnType<typeof setInterval>;

  /** Brings the load averages up to now and keeps them sampled every 5 s while there are processes. */
  loadavg(now = Date.now()): [number, number, number] {
    this.load.sample(this.running(), now);
    if (!this.loadTimer && this.live().length) {
      this.loadTimer = setInterval(() => {
        this.load.sample(this.running());
        // Stop once idle and decayed to nothing; the next read restarts it
        if (!this.live().length && this.load.avg.every((v) => v < 0.005)) { clearInterval(this.loadTimer); this.loadTimer = undefined; }
      }, LOAD_FREQ_MS);
      (this.loadTimer as { unref?: () => void })?.unref?.();
    }
    return this.load.avg;
  }

  /** Stops the sampling timer (the kernel is going away). */
  dispose(): void {
    if (this.loadTimer) clearInterval(this.loadTimer);
    this.loadTimer = undefined;
  }

  private loadavgText(): string {
    const procs = this.live();
    const running = this.running();
    const [a, b, c] = this.loadavg();
    return `${a.toFixed(2)} ${b.toFixed(2)} ${c.toFixed(2)} ${Math.max(1, running)}/${procs.length} ${this.kernel.lastPid}\n`;
  }

  /**
   * The FileSystem's view of a /proc path this generates (ProcInfoSource.node):
   * in-page commands (the shell's cat, ls, grep) read the same /proc/PID as
   * programs. undefined when it isn't ours.
   */
  fsNode(path: string): { dir: string[] } | { text: string } | { bytes: Uint8Array } | { link: string } | undefined {
    if (path === '/proc') return undefined; // (the FileSystem lists /proc itself)
    const head = path.slice(6).split('/')[0];
    const p = /^\d+$/.test(head) ? this.kernel.processOfTid(Number(head)) : this.kernel.init;
    if (!p || head === 'self' || head === 'thread-self') return undefined;
    const n = this.node(p, path);
    if (!n) return undefined;
    if (n.type !== 'file') return n.type === 'dir' ? { dir: n.list() } : { link: n.target() };
    const t = n.text();
    return typeof t === 'string' ? { text: t } : { bytes: t };
  }

  // ── what the kernel calls ──

  /** readlink(2) of a /proc path: the target, -errno, or undefined when it isn't ours. */
  readlink(proc: Process, path: string): string | number | undefined {
    const n = this.node(proc, path);
    if (!n) return path.startsWith('/proc/') && this.ownsPrefix(path) ? -A.ENOENT : undefined;
    return n.type === 'link' ? n.target() : -A.EINVAL;
  }

  /** stat/lstat of a /proc path; undefined when it isn't ours. */
  stat(proc: Process, path: string, follow: boolean): A.KStat | number | undefined {
    let n = this.node(proc, path);
    if (!n) return path.startsWith('/proc/') && this.ownsPrefix(path) ? -A.ENOENT : undefined;
    if (n.type === 'link' && follow) {
      const target = n.target();
      if (!target.startsWith('/')) n = this.node(proc, `/proc/${target}`); // /proc/self
      else return undefined; // the kernel stats the target itself
      if (!n) return -A.ENOENT;
    }
    if (n.type === 'dir') return dirStat(path);
    const now = Date.now();
    return {
      dev: 4, ino: procIno(path), mode: n.type === 'link' ? A.S_IFLNK | 0o777 : A.S_IFREG | 0o444, nlink: 1,
      uid: 1000, gid: 1000, rdev: 0, size: 0, blksize: 1024, blocks: 0, atimeMs: now, mtimeMs: now, ctimeMs: now,
    };
  }

  /** Where a /proc link points (for open/stat to follow); undefined when `path` isn't a /proc link. */
  linkTarget(proc: Process, path: string): string | undefined {
    const n = this.node(proc, path);
    if (n?.type !== 'link') return undefined;
    const t = n.target();
    return t.startsWith('/') ? t : `/proc/${t}`;
  }

  /** open(2) of a /proc file or directory; undefined when it isn't ours. */
  open(proc: Process, path: string, flags: number): OpenFile | number | undefined {
    const n = this.node(proc, path);
    if (!n) return path.startsWith('/proc/') && this.ownsPrefix(path) ? -A.ENOENT : undefined;
    if (n.type === 'link') return undefined; // the kernel follows it
    if ((flags & A.O_ACCMODE) !== A.O_RDONLY) return -A.EACCES;
    if (n.type === 'dir') return new ProcDirFile(this.kernel.fs!, path, flags, n.list);
    if (flags & A.O_DIRECTORY) return -A.ENOTDIR;
    return new ProcFile(path, flags, n.text);
  }

  /** /proc/PID/... and /proc/self/... are wholly ours (a missing entry is ENOENT, not the FileSystem's). */
  private ownsPrefix(path: string): boolean {
    const head = path.slice(6).split('/')[0];
    // (a pid that isn't a kernel process may be an in-page shell's: the FileSystem's /proc)
    return (/^\d+$/.test(head) && !!this.kernel.processOfTid(Number(head))) || head === 'self' || head === 'thread-self';
  }
}

/** Linux samples the run queue every 5 s (LOAD_FREQ). */
export const LOAD_FREQ_MS = 5000;

/**
 * Linux's load averages: every 5 s each average moves toward the number of
 * running processes by 1 - e^(-5/60), e^(-5/300), e^(-5/900) (the 1, 5 and 15
 * minute windows). A sample after a longer gap applies the missed steps at
 * the current count.
 */
export class LoadAvg {
  avg: [number, number, number] = [0, 0, 0];
  private last: number;
  private static readonly WINDOWS = [60, 300, 900];
  constructor(now = Date.now()) { this.last = now; }
  sample(running: number, now = Date.now()): void {
    const steps = Math.floor((now - this.last) / LOAD_FREQ_MS);
    if (steps <= 0) return;
    this.last += steps * LOAD_FREQ_MS;
    this.avg = this.avg.map((v, i) => {
      const e = Math.exp((-LOAD_FREQ_MS / 1000 / LoadAvg.WINDOWS[i]) * steps);
      return v * e + running * (1 - e);
    }) as [number, number, number];
  }
}

/** /proc/vmstat: the counters vmstat(8) reads, all 0 (there is no paging to count). */
const VMSTAT_KEYS = [
  'nr_free_pages', 'nr_inactive_anon', 'nr_active_anon', 'nr_inactive_file', 'nr_active_file', 'nr_dirty', 'nr_writeback',
  'pgpgin', 'pgpgout', 'pswpin', 'pswpout', 'pgfault', 'pgmajfault', 'pgfree', 'pgsteal_kswapd', 'pgsteal_direct',
  'pgscan_kswapd', 'pgscan_direct', 'pgalloc_normal', 'pgactivate', 'pgdeactivate',
];

const PID_ENTRIES = ['cmdline', 'comm', 'cwd', 'environ', 'exe', 'fd', 'fdinfo', 'io', 'mounts', 'root', 'stat', 'statm', 'status', 'syscall', 'task', 'wchan'];

export function wchanText(p: Process): string {
  const c = p.calls[0];
  if (c) return wchanName(p, c.nr, c.args);
  return p.engineSleeps ? 'futex_wait_queue' : '0';
}

/** Where Linux would show a task blocked in syscall `nr` waiting (its wchan), roughly */
function wchanName(p: Process, nr: number, args: ArrayLike<number>): string {
  const byNr: Record<number, string> = {
    7: 'do_poll', 271: 'do_poll', 23: 'do_select', 270: 'do_select', 232: 'ep_poll', 281: 'ep_poll', 441: 'ep_poll',
    202: 'futex_wait_queue', 35: 'hrtimer_nanosleep', 230: 'hrtimer_nanosleep', 61: 'do_wait', 247: 'do_wait',
    34: 'sigsuspend', 130: 'sigsuspend', 128: 'do_sigtimedwait', 43: 'inet_csk_accept', 288: 'inet_csk_accept',
    42: 'inet_wait_for_connect', 70: 'do_msgrcv', 65: 'do_semtimedop', 220: 'do_semtimedop', 73: 'flock_lock_inode_wait',
  };
  if (byNr[nr]) return byNr[nr];
  // reads and writes: by what the fd is
  if (nr === 0 || nr === 1 || nr === 17 || nr === 18 || nr === 19 || nr === 20 || nr === 44 || nr === 45 || nr === 46 || nr === 47) {
    const kind = p.fds.get(args[0] ?? -1)?.kind;
    const write = nr === 1 || nr === 18 || nr === 20 || nr === 44 || nr === 46;
    if (kind === 'pipe') return write ? 'pipe_write' : 'pipe_read';
    if (kind === 'socket') return write ? 'sk_stream_wait_memory' : 'wait_woken';
    if (kind === 'pty') return write ? 'n_tty_write' : 'n_tty_read';
  }
  return 'do_syscall_64';
}

/** The ids of a process's threads: the main thread (the pid), then the others in order */
export function threadIds(p: Process): number[] {
  // (Blink's threads: the engine's own list, data.engineThreads)
  const engine = p.data.engineThreads as Set<number> | undefined;
  const ids = new Set<number>([p.pid, ...p.tids, ...p.threads.keys(), ...(engine ?? [])]);
  return [p.pid, ...[...ids].filter((t) => t !== p.pid).sort((a, b) => a - b)];
}

/** /proc/PID/task/TID/syscall: the call that thread is in, or "running" */
export function threadSyscallText(p: Process, tid: number): string {
  if (p.state === 'zombie') return 'running\n';
  const c = threadCall(p, tid);
  if (c) {
    const a = Array.from({ length: 6 }, (_, i) => '0x' + ((c.args[i] ?? 0) >>> 0).toString(16));
    return `${c.nr} ${a.join(' ')} 0x0 0x0\n`;
  }
  return tid === p.pid && !p.threads.get(tid)?.syscalls ? syscallText(p) : 'running\n';
}

/** /proc/PID/task/TID/wchan */
export function threadWchanText(p: Process, tid: number): string {
  if (p.state === 'zombie') return '0';
  const c = threadCall(p, tid);
  if (c) return wchanName(p, c.nr, c.args);
  const lock = engineLock(p);
  if (lock && lock.holder !== 0 && lock.holder !== tid) return 'futex_wait_queue';
  return tid === p.pid && !p.threads.get(tid)?.syscalls ? wchanText(p) : '0';
}

/**
 * The engine's lock word (Blink's GIL, perf-blink's patch 0126): the engine
 * hands the kernel `proc.data.engine = { memory: { buffer }, gilAddr }` and
 * the lock's state is four i32 at gilAddr: holder tid (0: nobody), waiters,
 * acquires. (Blink copies it every 50 ms into a 16-byte SAB, gilAddr 0, so
 * the page doesn't keep the process's wasm memory alive.)
 */
export function engineLock(p: Process): { holder: number; waiters: number; acquires: number; heldMs: number } | null {
  const e = p.data.engine as { memory?: { buffer: ArrayBufferLike }; gilAddr?: number } | undefined;
  // (gilAddr 0 is fine: the engine may copy the struct into a small buffer of its own)
  if (!e?.memory?.buffer || typeof e.gilAddr !== 'number') return null;
  let l: { holder: number; waiters: number; acquires: number };
  try {
    // (the buffer changes when the memory grows: take it each time)
    const w = new Int32Array(e.memory.buffer, e.gilAddr, 4);
    l = { holder: Atomics.load(w, 0), waiters: Atomics.load(w, 1), acquires: Atomics.load(w, 2) >>> 0 };
  } catch { return null; }
  // How long the holder has had it: since a read first saw this acquire (the
  // engine doesn't time it; a holder that is stuck shows the same acquire for good)
  const now = Date.now();
  const seen = lockSeen.get(p);
  const same = seen && seen.holder === l.holder && seen.acquires === l.acquires;
  if (!same) lockSeen.set(p, { holder: l.holder, acquires: l.acquires, at: now });
  return { ...l, heldMs: l.holder && same ? now - seen!.at : 0 };
}
const lockSeen = new WeakMap<Process, { holder: number; acquires: number; at: number }>();

export interface ThreadState {
  tid: number;
  /** R, S, T or Z, as /proc/PID/task/TID/stat */
  state: string;
  /** The syscall it is in (-1: none) and its arguments */
  nr: number;
  args: number[];
  /** How long it has been in it */
  sinceMs: number;
  syscalls: number;
  /** What it waits on: read, write, poll, epoll, futex, sleep, wait, accept, connect, ipc, signal, engine (another thread's engine lock), other; '' running */
  waitKind: string;
  /** The fd a blocked read/write/accept/connect/epoll_wait is on */
  fd?: number;
  /** An epoll_wait's interest list (the fds it waits for) */
  fds?: number[];
}

/** The call thread `tid` is in: its channel's record, or the engine's (Blink: data.engineCalls, no args) */
function threadCall(p: Process, tid: number): { nr: number; args: ArrayLike<number>; since: number } | null {
  const t = p.threads.get(tid);
  if (t && t.nr >= 0) return t;
  const e = (p.data.engineCalls as Map<number, { nr: number; since: number; args?: ArrayLike<number> }> | undefined)?.get(tid);
  return e ? { nr: e.nr, args: e.args ?? [], since: e.since } : null;
}

/** What a call in progress waits on, for diag: its kind and fd (an epoll's interest list) */
function waitOf(p: Process, nr: number, args: ArrayLike<number>): { kind: string; fd?: number; fds?: number[] } {
  const fdArg = args.length ? args[0] : undefined;
  switch (nr) {
    case 0: case 17: case 19: case 45: case 47: case 295: return { kind: 'read', fd: fdArg };
    case 1: case 18: case 20: case 44: case 46: case 296: return { kind: 'write', fd: fdArg };
    case 7: case 271: case 23: case 270: return { kind: 'poll' };
    case 232: case 281: case 441: {
      const ep = fdArg !== undefined ? p.fds.get(fdArg) as (OpenFile & { watchedFds?: () => number[] }) | undefined : undefined;
      return { kind: 'epoll', fd: fdArg, ...(ep?.watchedFds ? { fds: ep.watchedFds() } : {}) };
    }
    case 202: return { kind: 'futex' };
    case 35: case 230: case 34: return { kind: 'sleep' };
    case 61: case 247: return { kind: 'wait' };
    case 43: case 288: return { kind: 'accept', fd: fdArg };
    case 42: return { kind: 'connect', fd: fdArg };
    case 65: case 220: case 69: case 70: return { kind: 'ipc' };
    case 130: case 128: return { kind: 'signal' };
  }
  return { kind: 'other' };
}

function engineLockText(p: Process): string {
  const l = engineLock(p);
  if (!l) return 'n/a';
  return `${l.holder ? `held by ${l.holder}` : 'free'} (waiters ${l.waiters}, acquires ${l.acquires})`;
}

export function syscallText(p: Process): string {
  if (p.state === 'zombie') return 'running\n';
  const c = p.calls[0];
  // A wait Blink does itself (futex, nanosleep) has no kernel call: say futex
  if (!c) return p.engineSleeps ? '202 0x0 0x0 0x0 0x0 0x0 0x0 0x0 0x0\n' : 'running\n';
  const a = Array.from({ length: 6 }, (_, i) => '0x' + ((c.args[i] ?? 0) >>> 0).toString(16));
  return `${c.nr} ${a.join(' ')} 0x0 0x0\n`;
}

/**
 * /proc/PID/fdinfo/N: the description's offset and flags, and an inotify
 * instance's watches as Linux lists them (LTP inotify12 reads their masks)
 */
function fdInfo(f: OpenFile, cloexec: boolean): string {
  const pos = f.seek ? Math.max(0, f.seek(0, A.SEEK_CUR)) : 0;
  let t = `pos:\t${pos}\nflags:\t0${((f.flags | (cloexec ? A.O_CLOEXEC : 0)) >>> 0).toString(8)}\nmnt_id:\t1\nino:\t0\n`;
  if (f instanceof InotifyFile) {
    for (const w of f.watches.values()) {
      t += `inotify wd:${w.wd} ino:${(fnv(w.path) >>> 0).toString(16)} sdev:1 mask:${(w.mask >>> 0).toString(16)} ignored_mask:0\n`;
    }
  }
  return t;
}
const fnv = (s: string) => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x1000193); return h; };

interface SockAddrLike { address: string; port: number }
interface NetInfo { state: string; local: SockAddrLike | null; remote: SockAddrLike | null; rxQueue: number; txQueue: number }
/** Linux's TCP states (include/net/tcp_states.h); unbound sockets aren't listed */
const TCP_STATES: Record<string, string> = { connected: '01', connecting: '02', closed: '07', bound: '07', listening: '0A' };
const hex = (n: number, w: number) => (n >>> 0).toString(16).toUpperCase().padStart(w, '0');
/** An address as /proc/net prints it: its bytes as 32-bit words, each in host (little-endian) order */
export function hexAddr(address: string, v6: boolean): string {
  const bytes = v6 ? ipv6Bytes(address) : ipv4Bytes(address);
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) for (let j = 3; j >= 0; j--) out += bytes[i + j].toString(16).toUpperCase().padStart(2, '0');
  return out;
}
function ipv4Bytes(a: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  return m ? [1, 2, 3, 4].map((i) => Number(m[i]) & 255) : [0, 0, 0, 0];
}
function ipv6Bytes(a: string): number[] {
  const out = new Array<number>(16).fill(0);
  if (!a || a === '::') return out;
  let s = a.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  // a dotted IPv4 tail (::ffff:1.2.3.4) is two groups
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) { const b = ipv4Bytes(v4[1]); s = s.slice(0, v4.index) + ((b[0] << 8) | b[1]).toString(16) + ':' + ((b[2] << 8) | b[3]).toString(16); }
  if (!s.includes(':')) return out;
  const [hd, tl] = s.includes('::') ? s.split('::') : [s, undefined];
  const h = hd ? hd.split(':') : [];
  const t = tl !== undefined && tl ? tl.split(':') : [];
  const groups = tl === undefined ? h : [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  groups.slice(0, 8).forEach((g, i) => { const v = parseInt(g || '0', 16) || 0; out[i * 2] = (v >> 8) & 255; out[i * 2 + 1] = v & 255; });
  return out;
}

/** What /proc/PID/fd/N points at. */
export function fdTarget(f: OpenFile): string {
  if (f.path) return f.path;
  // (a pipe end's inode is its pipe's: both ends of one pipe show the same pipe:[N])
  const ino = (f as { ino?: number }).ino ?? (f as { pipe?: { ino?: number } }).pipe?.ino ?? 0;
  if (f instanceof EventFile) return 'anon_inode:[eventfd]';
  if (f instanceof TimerFile) return 'anon_inode:[timerfd]';
  switch (f.kind) {
    case 'pipe': return `pipe:[${ino}]`;
    case 'socket': return `socket:[${ino}]`;
    case 'epoll': return 'anon_inode:[eventpoll]';
    default: return 'anon_inode:[shiro]';
  }
}

/**
 * /proc/config.gz: the kernel's build options as this kernel has them (what
 * it implements =y, what it doesn't "is not set"), for programs that check
 * (LTP's needs_kconfigs).
 */
const KCONFIG = [
  '# Linux/x86_64 kernel configuration (tabcomputer)',
  'CONFIG_64BIT=y', 'CONFIG_X86_64=y', 'CONFIG_SMP=y', 'CONFIG_MMU=y', 'CONFIG_HZ=100',
  'CONFIG_MULTIUSER=y', 'CONFIG_SYSVIPC=y', 'CONFIG_POSIX_MQUEUE=y', 'CONFIG_POSIX_TIMERS=y', 'CONFIG_FUTEX=y',
  'CONFIG_EPOLL=y', 'CONFIG_INOTIFY_USER=y', 'CONFIG_SIGNALFD=y', 'CONFIG_TIMERFD=y', 'CONFIG_EVENTFD=y', 'CONFIG_SHMEM=y', 'CONFIG_MEMFD_CREATE=y',
  'CONFIG_FILE_LOCKING=y', 'CONFIG_PROC_FS=y', 'CONFIG_TMPFS=y', 'CONFIG_UNIX=y', 'CONFIG_NET=y', 'CONFIG_INET=y', 'CONFIG_IPV6=y',
  'CONFIG_UNIX98_PTYS=y', 'CONFIG_IKCONFIG=y', 'CONFIG_IKCONFIG_PROC=y',
  '# CONFIG_AIO is not set', '# CONFIG_IO_URING is not set', '# CONFIG_FANOTIFY is not set',
  '# CONFIG_USERFAULTFD is not set', '# CONFIG_NAMESPACES is not set', '# CONFIG_USER_NS is not set', '# CONFIG_NET_NS is not set',
  '# CONFIG_PID_NS is not set', '# CONFIG_UTS_NS is not set', '# CONFIG_IPC_NS is not set', '# CONFIG_CGROUPS is not set',
  '# CONFIG_SECCOMP is not set', '# CONFIG_BPF_SYSCALL is not set', '# CONFIG_PERF_EVENTS is not set', '# CONFIG_KCMP is not set',
  '# CONFIG_CHECKPOINT_RESTORE is not set', '# CONFIG_SWAP is not set', '# CONFIG_QUOTA is not set', '# CONFIG_MODULES is not set',
].join('\n') + '\n';

/** `data` as a gzip file of stored (uncompressed) deflate blocks */
function gzipStored(data: Uint8Array): Uint8Array {
  let crc = ~0;
  for (const b of data) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  crc = ~crc >>> 0;
  const blocks = Math.max(1, Math.ceil(data.length / 65535));
  const out = new Uint8Array(10 + data.length + blocks * 5 + 8);
  out.set([0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 3]);
  let o = 10;
  for (let i = 0; i < blocks; i++) {
    const part = data.subarray(i * 65535, (i + 1) * 65535);
    out[o++] = i === blocks - 1 ? 1 : 0;
    out[o++] = part.length & 0xff; out[o++] = part.length >> 8;
    out[o++] = ~part.length & 0xff; out[o++] = (~part.length >> 8) & 0xff;
    out.set(part, o); o += part.length;
  }
  const dv = new DataView(out.buffer);
  dv.setUint32(o, crc, true);
  dv.setUint32(o + 4, data.length, true);
  return out;
}
