/**
 * Kernel profiler: where guest programs spend their time in the kernel.
 *
 * While one is attached (Kernel.startProfile), every syscall of the
 * processes it follows is timed at the kernel's two entry points:
 * syscallSync (answered from memory: the time is kernel CPU) and syscall
 * (the async path: its first synchronous run is CPU, the rest until the
 * result is wall time the guest waits, mostly blocked). A KernelChannel
 * read/write that waits for readiness reports its blocked time too.
 *
 * Per syscall: calls, errors, how many took the sync path, CPU and wall
 * microseconds, the slowest call; per descriptor kind for fd calls (read
 * on a pty vs a file), per path for path calls, per process, and a
 * timeline. A pty trace times each keystroke: input → the guest's read
 * → its first and last write back (the render it caused), with the
 * syscalls made in between.
 *
 * Off (no profiler) the cost is one null check per call.
 */
import * as A from './abi';
import type { Process } from './process';
import { setPtyTrace, type Pty } from './pty';

export interface ProfileOptions {
  /** Processes to follow (with their descendants when `follow`); empty or undefined: every process */
  pids?: number[];
  /** Also follow children forked or spawned after the start (default true) */
  follow?: boolean;
  /** Instead of `pids`: whether to follow a process not followed yet (asked once per pid; `follow` still adds children) */
  filter?: (proc: Process) => boolean;
  /** Count path arguments (open, stat, access, readlink, ...) (default true) */
  paths?: boolean;
  /** Timeline bucket in ms (default 250; 0: none) */
  bucketMs?: number;
  /** Time keystrokes through the ptys (default true) */
  keys?: boolean;
}

export interface SyscallStat {
  nr: number;
  name: string;
  calls: number;
  errors: number;
  /** answered by syscallSync */
  sync: number;
  /** kernel CPU: sync calls and the async path's first synchronous run */
  cpuUs: number;
  /** guest-visible time in the kernel (sync calls: their CPU) */
  wallUs: number;
  maxUs: number;
  /** syscallSync tries that fell through to the async path (or waited for readiness), and their CPU */
  misses: number;
  missUs: number;
  /** waits for readiness (KernelChannel) and their time, inside wallUs */
  blocked: number;
  blockedUs: number;
  /** the slowest call's arguments (the channel's words) */
  maxArgs?: number[];
  /** poll, select and epoll waits: calls by timeout argument (ms; -1 forever), and how many returned 0 (timed out) */
  timeouts?: Record<string, number>;
  zero?: number;
}

export interface KeyStat {
  /** ms from the profile's start */
  t: number;
  bytes: number;
  /** input → the guest's read (ms; -1: never read) */
  readMs: number;
  /** read → first write back (ms; -1: none) */
  firstWriteMs: number;
  /** read → last write before the next key or the end (ms) */
  lastWriteMs: number;
  writes: number;
  writeBytes: number;
  /** syscalls the followed processes made from the read to the next key's read */
  calls: number;
  /** their kernel wall time (ms) */
  kernelMs: number;
  /** "pid:tid" → ms each thread spent outside the kernel in that window (gaps ending in it) */
  outside: Record<string, number>;
  byName: Record<string, number>;
  /** the path arguments of those calls */
  paths: Record<string, number>;
}

export interface ThreadStat {
  pid: number;
  /** the engine's thread id (the pid for the main thread, or a caller that doesn't say) */
  tid: number;
  comm: string;
  calls: number;
  /** time in the kernel's calls (from entry to result) */
  inKernelMs: number;
  /**
   * time between one call's result and the thread's next call: the guest
   * computing (plus the channel's trip each way); a thread asleep in the
   * engine (a futex, nanosleep) counts here too
   */
  outsideMs: number;
  /**
   * gaps after the engine said the thread sleeps (shiro_sleeping +1: futex
   * waits after their first tick, nanosleep). Blink says so for a process's
   * main thread only (patch 0036): its other threads' sleeps count as outside.
   */
  sleepMs: number;
  /** the longest of those gaps, and the calls on either side of it */
  maxGapMs: number;
  maxGapAfter: string;
  maxGapBefore: string;
  /** gaps by length: <1 ms, <10 ms, <100 ms, <1 s, longer */
  gaps: [number, number, number, number, number];
}

export interface ProfileReport {
  ms: number;
  totals: { calls: number; errors: number; sync: number; cpuMs: number; wallMs: number; blockedMs: number; missMs: number };
  syscalls: SyscallStat[];
  /** "read:pty" → stat, for calls on a descriptor */
  byKind: Record<string, { calls: number; wallUs: number; cpuUs: number; bytes: number }>;
  /** path → calls and time (the top `pathLimit`) */
  /** (times: ms from the start of each of the first calls) */
  paths: { path: string; calls: number; errors: number; wallUs: number; nrs: string[]; times: number[] }[];
  pathCount: number;
  procs: { pid: number; ppid: number; comm: string; calls: number; cpuMs: number; wallMs: number; blockedMs: number }[];
  timeline: { t: number; calls: number; cpuMs: number; wallMs: number }[];
  threads: ThreadStat[];
  bucketMs: number;
  keys: KeyStat[];
}

let names: Map<number, string> | null = null;
/** "read" for SYS_read; syscall_N for numbers abi.ts doesn't name */
export function syscallName(nr: number): string {
  if (!names) {
    names = new Map();
    for (const [k, v] of Object.entries(A)) if (k.startsWith('SYS_') && typeof v === 'number' && !names.has(v)) names.set(v, k.slice(4));
  }
  return names.get(nr) ?? `syscall_${nr}`;
}

const nrs = (...ks: string[]): Set<number> =>
  new Set(ks.map((k) => (A as Record<string, unknown>)[`SYS_${k}`]).filter((n): n is number => typeof n === 'number'));
/** Calls whose args[0] is a descriptor: their stats are also kept per descriptor kind */
const FD_CALLS = nrs('read', 'write', 'pread64', 'pwrite64', 'readv', 'writev', 'close', 'fstat', 'lseek', 'ioctl', 'fcntl',
  'getdents64', 'sendto', 'recvfrom', 'sendmsg', 'recvmsg', 'fsync', 'ftruncate', 'connect', 'accept4', 'epoll_wait', 'epoll_pwait', 'epoll_ctl');
const BYTES_CALLS = nrs('read', 'write', 'pread64', 'pwrite64', 'sendto', 'recvfrom');

/** Waits whose timeout (ms) is an argument: its slot (select: seconds, µs in 2 and 3) */
const TIMEOUT_ARG: Record<number, number> = {};
for (const [k, i] of [['SYS_poll', 1], ['SYS_epoll_wait', 2], ['SYS_epoll_pwait', 2], ['SYS_select', 2], ['SYS_pselect6', 2], ['SYS_ppoll', 1]] as const) {
  const nr = (A as Record<string, unknown>)[k];
  if (typeof nr === 'number') TIMEOUT_ARG[nr] = i;
}
function timeoutOf(nr: number, args: ArrayLike<number>): number {
  const i = TIMEOUT_ARG[nr];
  if (nr === A.SYS_select) return args[2] < 0 ? -1 : args[2] * 1000 + Math.ceil(args[3] / 1000);
  return args[i] < 0 ? -1 : args[i];
}

/** The path argument's length slot (the path is at data offset 0), by syscall */
const PATH_LEN_ARG: Record<number, number> = {};
for (const [k, i] of [
  ['SYS_open', 0], ['SYS_openat', 1], ['SYS_stat', 0], ['SYS_lstat', 0], ['SYS_newfstatat', 1], ['SYS_access', 0],
  ['SYS_faccessat', 1], ['SYS_faccessat2', 1], ['SYS_readlink', 0], ['SYS_readlinkat', 1], ['SYS_statx', 1],
  ['SYS_mkdir', 0], ['SYS_mkdirat', 1], ['SYS_unlink', 0], ['SYS_unlinkat', 1], ['SYS_chdir', 0], ['SYS_rmdir', 0],
  ['SYS_truncate', 0], ['SYS_utimensat', 1], ['SYS_inotify_add_watch', 1],
] as const) {
  const nr = (A as Record<string, unknown>)[k];
  if (typeof nr === 'number') PATH_LEN_ARG[nr] = i;
}

function pathOf(nr: number, args: ArrayLike<number>, data: Uint8Array): string | undefined {
  const i = PATH_LEN_ARG[nr];
  if (i === undefined) return undefined;
  const len = args[i];
  if (!(len > 0) || len > data.length || len > 4096) return undefined;
  return A.decodeText(data.subarray(0, len));
}

const now = (): number => performance.now();
/** call times kept per path */
const PATH_TIMES = 200;

interface ProcStat { pid: number; ppid: number; comm: string; calls: number; cpuUs: number; wallUs: number; blockedUs: number }
interface KindStat { calls: number; wallUs: number; cpuUs: number; bytes: number }
interface PathStat { calls: number; errors: number; wallUs: number; nrs: Set<number>; times: number[] }
interface Bucket { calls: number; cpuUs: number; wallUs: number }
interface Thread { pid: number; tid: number; comm: string; calls: number; inUs: number; outUs: number; maxGapUs: number; maxGapAfter: number; maxGapBefore: number; gaps: [number, number, number, number, number]; inCall: boolean; enteredAt: number; lastEnd: number; lastNr: number; sleepUs: number; asleep: boolean; nextAsleep: boolean }
interface Key { outside: Map<string, number>; t: number; bytes: number; readAt: number; firstWriteAt: number; lastWriteAt: number; writes: number; writeBytes: number; calls: number; wallUs: number; byName: Map<number, number>; paths: Map<string, number> }

/** What describe() reads off a call before it runs */
export interface CallInfo { path?: string; kind?: string; args: ArrayLike<number>; th?: Thread; t?: number }
/** An async call in progress (Kernel.syscall): begin() → end() */
export interface ProfiledCall extends CallInfo { proc: Process; nr: number; t0: number; cpuUs: number; key: Key | null }

export class KernelProfiler {
  readonly t0 = now();
  private readonly wantAll: boolean;
  private readonly pids = new Set<number>();
  private readonly notPids = new Set<number>();
  private readonly follow: boolean;
  private readonly filter?: (proc: Process) => boolean;
  private readonly withPaths: boolean;
  private readonly bucketMs: number;
  private readonly stats = new Map<number, SyscallStat>();
  private readonly kinds = new Map<string, KindStat>();
  private readonly pathStats = new Map<string, PathStat>();
  private readonly procStats = new Map<number, ProcStat>();
  private readonly buckets: Bucket[] = [];
  private readonly keyList: Key[] = [];
  /** the key whose read was the latest: calls and writes until the next one's read are its */
  private curKey: Key | null = null;
  private stopped = false;
  private readonly keys: boolean;
  private readonly threads = new Map<string, Thread>();
  /**
   * The engine thread the next call comes from: a channel sets it right
   * before it enters the kernel (syscallSync, syscall), which reads and
   * clears it. 0: the process's main thread.
   */
  tid = 0;

  constructor(opts: ProfileOptions = {}) {
    this.wantAll = !opts.pids?.length && !opts.filter;
    this.filter = opts.filter;
    for (const p of opts.pids ?? []) this.pids.add(p);
    this.follow = opts.follow ?? true;
    this.withPaths = opts.paths ?? true;
    this.bucketMs = opts.bucketMs ?? 250;
    this.keys = opts.keys ?? true;
    if (this.keys) setPtyTrace(this);
  }

  /** Whether calls of `proc` are counted (a child of a followed process is followed from its first call) */
  wants(proc: Process): boolean {
    if (this.stopped) return false;
    if (this.wantAll || this.pids.has(proc.pid)) return true;
    if (this.notPids.has(proc.pid)) return false;
    if ((this.follow && this.pids.has(proc.ppid)) || this.filter?.(proc)) { this.pids.add(proc.pid); return true; }
    this.notPids.add(proc.pid);
    return false;
  }

  private stat(nr: number): SyscallStat {
    let s = this.stats.get(nr);
    if (!s) {
      s = { nr, name: syscallName(nr), calls: 0, errors: 0, sync: 0, cpuUs: 0, wallUs: 0, maxUs: 0, misses: 0, missUs: 0, blocked: 0, blockedUs: 0 };
      this.stats.set(nr, s);
    }
    return s;
  }

  private procStat(proc: Process): ProcStat {
    let s = this.procStats.get(proc.pid);
    if (!s) {
      s = { pid: proc.pid, ppid: proc.ppid, comm: '', calls: 0, cpuUs: 0, wallUs: 0, blockedUs: 0 };
      this.procStats.set(proc.pid, s);
    }
    s.comm = proc.comm; // (exec changes it)
    return s;
  }

  private bucket(t: number): Bucket | null {
    if (!this.bucketMs) return null;
    const i = Math.max(0, Math.floor((t - this.t0) / this.bucketMs));
    if (i > 100_000) return null;
    while (this.buckets.length <= i) this.buckets.push({ calls: 0, cpuUs: 0, wallUs: 0 });
    return this.buckets[i];
  }

  private thread(proc: Process): Thread {
    const tid = this.tid || proc.pid;
    this.tid = 0;
    const k = `${proc.pid}:${tid}`;
    let th = this.threads.get(k);
    if (!th) {
      th = { pid: proc.pid, tid, comm: '', calls: 0, inUs: 0, outUs: 0, maxGapUs: 0, maxGapAfter: -1, maxGapBefore: -1, gaps: [0, 0, 0, 0, 0], inCall: false, enteredAt: 0, lastEnd: 0, lastNr: -1, sleepUs: 0, asleep: false, nextAsleep: false };
      this.threads.set(k, th);
    }
    th.comm = proc.comm;
    return th;
  }

  /** A thread enters the kernel at `t`: the gap since its last call's result is time outside (computing) */
  private enter(th: Thread, nr: number, t: number): void {
    if (th.inCall) return; // (a retry of the same call: a sync miss, a readiness attempt)
    th.inCall = true;
    th.enteredAt = t;
    if (!th.lastEnd) return;
    const gap = (t - th.lastEnd) * 1000;
    // after shiro_sleeping(+1): the engine slept (a futex wait, nanosleep), it didn't compute
    if (th.asleep) { th.sleepUs += gap; return; }
    th.outUs += gap;
    th.gaps[gap < 1000 ? 0 : gap < 10_000 ? 1 : gap < 100_000 ? 2 : gap < 1_000_000 ? 3 : 4]++;
    if (gap > th.maxGapUs) { th.maxGapUs = gap; th.maxGapAfter = th.lastNr; th.maxGapBefore = nr; }
    const key = this.curKey;
    if (key) { const k = `${th.pid}:${th.tid}`; key.outside.set(k, (key.outside.get(k) ?? 0) + gap); }
  }

  private leave(th: Thread, nr: number, t: number): void {
    th.calls++;
    th.inUs += (t - th.enteredAt) * 1000;
    th.inCall = false;
    th.lastEnd = t;
    th.lastNr = nr;
    th.asleep = th.nextAsleep;
    th.nextAsleep = false;
  }

  /** What a call is about, read before it runs (a stat writes its result over the path; close drops the fd) */
  describe(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): CallInfo {
    const path = this.withPaths ? pathOf(nr, args, data) : undefined;
    const kind = FD_CALLS.has(nr) ? (proc.fds.get(args[0])?.kind ?? 'badf') : undefined;
    const th = this.thread(proc);
    const t = now();
    this.enter(th, nr, t);
    if (nr === A.SYS_shiro_sleeping) th.nextAsleep = args[0] > 0;
    return { path, kind, args, th, t };
  }

  private record(proc: Process, nr: number, r: number, cpuUs: number, wallUs: number, sync: boolean, d: CallInfo, key: Key | null, t: number): void {
    const { path, kind } = d;
    const s = this.stat(nr);
    s.calls++;
    if (r < 0 && r >= -4095) s.errors++;
    if (sync) s.sync++;
    s.cpuUs += cpuUs;
    s.wallUs += wallUs;
    if (wallUs > s.maxUs || !s.maxArgs) { s.maxUs = Math.max(s.maxUs, wallUs); s.maxArgs = Array.from(d.args); }
    if (TIMEOUT_ARG[nr] !== undefined) {
      const tk = String(timeoutOf(nr, d.args));
      const h = (s.timeouts ??= {});
      if (tk in h || Object.keys(h).length < 32) h[tk] = (h[tk] ?? 0) + 1;
      if (r === 0) s.zero = (s.zero ?? 0) + 1;
    }
    const ps = this.procStat(proc);
    ps.calls++; ps.cpuUs += cpuUs; ps.wallUs += wallUs;
    if (kind !== undefined) {
      const k = `${s.name}:${kind}`;
      let ks = this.kinds.get(k);
      if (!ks) { ks = { calls: 0, wallUs: 0, cpuUs: 0, bytes: 0 }; this.kinds.set(k, ks); }
      ks.calls++; ks.wallUs += wallUs; ks.cpuUs += cpuUs;
      if (r > 0 && BYTES_CALLS.has(nr)) ks.bytes += r;
    }
    if (path !== undefined) {
      let pst = this.pathStats.get(path);
      if (!pst) { pst = { calls: 0, errors: 0, wallUs: 0, nrs: new Set(), times: [] }; this.pathStats.set(path, pst); }
      pst.calls++; pst.wallUs += wallUs; pst.nrs.add(nr);
      if (pst.times.length < PATH_TIMES) pst.times.push(t - this.t0);
      if (r < 0) pst.errors++;
    }
    const b = this.bucket(t);
    if (b) { b.calls++; b.cpuUs += cpuUs; b.wallUs += wallUs; }
    if (key) {
      key.calls++; key.wallUs += wallUs;
      key.byName.set(nr, (key.byName.get(nr) ?? 0) + 1);
      if (path !== undefined) key.paths.set(path, (key.paths.get(path) ?? 0) + 1);
    }
  }

  // ── hooks (Kernel, KernelChannel) ──

  /** A syscallSync call: `r` undefined means it fell through (a miss) */
  sync(proc: Process, nr: number, r: number | undefined, us: number, d: CallInfo): void {
    if (r === undefined) {
      const s = this.stat(nr);
      s.misses++; s.missUs += us;
      return;
    }
    const t = now();
    if (d.th) this.leave(d.th, nr, t);
    this.record(proc, nr, r, us, us, true, d, this.curKey, t);
  }

  begin(proc: Process, nr: number, args: ArrayLike<number>, data: Uint8Array): ProfiledCall {
    const d = this.describe(proc, nr, args, data);
    return { ...d, args: Array.from(args), proc, nr, t0: now(), cpuUs: 0, key: this.curKey };
  }

  end(c: ProfiledCall, r: number): void {
    if (this.stopped) return;
    const t = now();
    if (c.th) this.leave(c.th, c.nr, t);
    this.record(c.proc, c.nr, r, c.cpuUs, (t - c.t0) * 1000, false, c, c.key, c.t0);
  }

  /** A KernelChannel read/write that waited `ms` for readiness (its result is counted by sync()) */
  blocked(proc: Process, nr: number, ms: number): void {
    if (this.stopped || !this.wants(proc)) return;
    const s = this.stat(nr);
    s.blocked++; s.blockedUs += ms * 1000; s.wallUs += ms * 1000;
    if (ms * 1000 > s.maxUs) s.maxUs = ms * 1000;
    const ps = this.procStat(proc);
    ps.blockedUs += ms * 1000; ps.wallUs += ms * 1000;
  }

  // ── pty trace (pty.ts) ──

  input(_pty: Pty, n: number): void {
    if (!n) return;
    this.keyList.push({ t: now(), bytes: n, readAt: 0, firstWriteAt: 0, lastWriteAt: 0, writes: 0, writeBytes: 0, calls: 0, wallUs: 0, byName: new Map(), paths: new Map(), outside: new Map() });
  }

  read(_pty: Pty, n: number): void {
    if (!n) return;
    const t = now();
    let latest: Key | null = null;
    for (let i = this.keyList.length - 1; i >= 0 && !this.keyList[i].readAt; i--) {
      this.keyList[i].readAt = t;
      latest ??= this.keyList[i];
    }
    if (latest) this.curKey = latest;
  }

  write(_pty: Pty, n: number): void {
    const k = this.curKey;
    if (!k || !n) return;
    const t = now();
    if (!k.firstWriteAt) k.firstWriteAt = t;
    k.lastWriteAt = t;
    k.writes++;
    k.writeBytes += n;
  }

  // ── results ──

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.keys) setPtyTrace(null);
  }

  /** The report as `strace -c` prints it (formatReport) */
  format(pathLimit = 50): string {
    return formatReport(this.report(pathLimit));
  }

  report(pathLimit = 50): ProfileReport {
    const ms = now() - this.t0;
    const syscalls = [...this.stats.values()].filter((s) => s.calls || s.blocked || s.misses).sort((a, b) => b.wallUs - a.wallUs || b.calls - a.calls);
    const sum = (f: (s: SyscallStat) => number) => syscalls.reduce((n, s) => n + f(s), 0);
    const r3 = (x: number) => Math.round(x * 1000) / 1000;
    const paths = [...this.pathStats.entries()].sort((a, b) => b[1].calls - a[1].calls || b[1].wallUs - a[1].wallUs).slice(0, pathLimit)
      .map(([path, p]) => ({ path, calls: p.calls, errors: p.errors, wallUs: Math.round(p.wallUs), nrs: [...p.nrs].map(syscallName), times: p.times.map(r3) }));
    const keys: KeyStat[] = this.keyList.map((k) => {
      const names: Record<string, number> = {};
      for (const [nr, n] of [...k.byName.entries()].sort((a, b) => b[1] - a[1])) names[syscallName(nr)] = n;
      return {
        t: r3(k.t - this.t0), bytes: k.bytes,
        readMs: k.readAt ? r3(k.readAt - k.t) : -1,
        firstWriteMs: k.firstWriteAt ? r3(k.firstWriteAt - k.readAt) : -1,
        lastWriteMs: k.lastWriteAt ? r3(k.lastWriteAt - k.readAt) : -1,
        outside: Object.fromEntries([...k.outside.entries()].sort((a, b) => b[1] - a[1]).map(([t, us]) => [t, r3(us / 1000)])),
        writes: k.writes, writeBytes: k.writeBytes, calls: k.calls, kernelMs: r3(k.wallUs / 1000), byName: names, paths: Object.fromEntries(k.paths),
      };
    });
    return {
      ms: r3(ms),
      totals: {
        calls: sum((s) => s.calls), errors: sum((s) => s.errors), sync: sum((s) => s.sync),
        cpuMs: r3(sum((s) => s.cpuUs) / 1000), wallMs: r3(sum((s) => s.wallUs) / 1000),
        blockedMs: r3(sum((s) => s.blockedUs) / 1000), missMs: r3(sum((s) => s.missUs) / 1000),
      },
      syscalls: syscalls.map((s) => ({ ...s, cpuUs: Math.round(s.cpuUs), wallUs: Math.round(s.wallUs), maxUs: Math.round(s.maxUs), missUs: Math.round(s.missUs), blockedUs: Math.round(s.blockedUs) })),
      byKind: Object.fromEntries([...this.kinds.entries()].sort((a, b) => b[1].wallUs - a[1].wallUs)
        .map(([k, v]) => [k, { calls: v.calls, wallUs: Math.round(v.wallUs), cpuUs: Math.round(v.cpuUs), bytes: v.bytes }])),
      paths,
      pathCount: this.pathStats.size,
      procs: [...this.procStats.values()].map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, calls: p.calls, cpuMs: r3(p.cpuUs / 1000), wallMs: r3(p.wallUs / 1000), blockedMs: r3(p.blockedUs / 1000) })),
      threads: [...this.threads.values()].sort((a, b) => b.outUs - a.outUs).map((th) => ({
        pid: th.pid, tid: th.tid, comm: th.comm, calls: th.calls, inKernelMs: r3(th.inUs / 1000), outsideMs: r3(th.outUs / 1000), sleepMs: r3(th.sleepUs / 1000),
        maxGapMs: r3(th.maxGapUs / 1000), maxGapAfter: th.maxGapAfter < 0 ? '' : syscallName(th.maxGapAfter),
        maxGapBefore: th.maxGapBefore < 0 ? '' : syscallName(th.maxGapBefore), gaps: [...th.gaps] as ThreadStat['gaps'],
      })),
      timeline: this.buckets.map((b, i) => ({ t: i * this.bucketMs, calls: b.calls, cpuMs: r3(b.cpuUs / 1000), wallMs: r3(b.wallUs / 1000) })),
      bucketMs: this.bucketMs,
      keys,
    };
  }
}

const pct = (a: number, b: number) => (b > 0 ? (100 * a / b).toFixed(2) : '0.00');
const pad = (s: string | number, n: number) => String(s).padStart(n);

/** median of a list (NaN when empty) */
function median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/** strace -c's table, with the kernel's own columns; then descriptor kinds, paths, processes and keystrokes */
export function formatReport(r: ProfileReport, opts: { paths?: number; keys?: boolean } = {}): string {
  const out: string[] = [];
  const tot = r.totals;
  out.push(`${tot.calls} calls in ${(r.ms / 1000).toFixed(3)} s: kernel CPU ${tot.cpuMs.toFixed(1)} ms, in the kernel ${tot.wallMs.toFixed(1)} ms (blocked on readiness ${tot.blockedMs.toFixed(1)} ms), sync path ${pct(tot.sync, tot.calls)}%, sync misses ${tot.missMs.toFixed(1)} ms`);
  out.push('% time     seconds  usecs/call  cpu-us/call     calls    errors    sync%  max-ms syscall');
  out.push('------ ----------- ----------- ------------ --------- --------- -------- ------- ----------------');
  for (const s of r.syscalls) {
    if (!s.calls && !s.blocked) continue;
    out.push(`${pad(pct(s.wallUs, tot.wallMs * 1000), 6)} ${pad((s.wallUs / 1e6).toFixed(6), 11)} ${pad(s.calls ? Math.round(s.wallUs / s.calls) : 0, 11)} ${pad(s.calls ? (s.cpuUs / s.calls).toFixed(1) : '0', 12)} ${pad(s.calls, 9)} ${pad(s.errors || '', 9)} ${pad(pct(s.sync, s.calls), 8)} ${pad((s.maxUs / 1000).toFixed(1), 7)} ${s.name}`);
  }
  out.push('------ ----------- ----------- ------------ --------- --------- -------- ------- ----------------');
  out.push(`100.00 ${pad((tot.wallMs / 1000).toFixed(6), 11)} ${pad(tot.calls ? Math.round(tot.wallMs * 1000 / tot.calls) : 0, 11)} ${pad(tot.calls ? (tot.cpuMs * 1000 / tot.calls).toFixed(1) : '0', 12)} ${pad(tot.calls, 9)} ${pad(tot.errors || '', 9)} ${pad(pct(tot.sync, tot.calls), 8)} ${pad('', 7)} total`);
  const waits = r.syscalls.filter((s) => s.timeouts);
  if (waits.length) {
    out.push('', 'waits by timeout (ms: calls; -1 = none):');
    for (const s of waits) out.push(`${s.name.padEnd(12)} ${Object.entries(s.timeouts!).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t}: ${n}`).join(', ')}; ${s.zero ?? 0} timed out`);
  }
  const kinds = Object.entries(r.byKind);
  if (kinds.length) {
    out.push('', 'by descriptor:     calls    wall-ms     cpu-ms        bytes');
    for (const [k, v] of kinds.slice(0, 20)) out.push(`${k.padEnd(16)} ${pad(v.calls, 7)} ${pad((v.wallUs / 1000).toFixed(1), 10)} ${pad((v.cpuUs / 1000).toFixed(1), 10)} ${pad(v.bytes, 12)}`);
  }
  const np = opts.paths ?? 15;
  if (np && r.paths.length) {
    out.push('', `paths (${r.pathCount} distinct; top ${Math.min(np, r.paths.length)}):  calls  errors  wall-ms`);
    for (const p of r.paths.slice(0, np)) out.push(`${pad(p.calls, 7)} ${pad(p.errors || '', 7)} ${pad((p.wallUs / 1000).toFixed(1), 8)}  ${p.path}  (${p.nrs.join(',')})`);
  }
  if (r.procs.length > 1) {
    out.push('', '  pid   ppid     calls   cpu-ms   wall-ms  blocked-ms comm');
    for (const p of [...r.procs].sort((a, b) => b.wallMs - a.wallMs).slice(0, 20)) out.push(`${pad(p.pid, 5)} ${pad(p.ppid, 6)} ${pad(p.calls, 9)} ${pad(p.cpuMs.toFixed(1), 8)} ${pad(p.wallMs.toFixed(1), 9)} ${pad(p.blockedMs.toFixed(1), 11)} ${p.comm}`);
  }
  if (r.threads.length) {
    out.push('', '  pid    tid     calls  kernel-ms  outside-ms  asleep-ms  max-gap-ms (after → before)          gaps <1ms/<10/<100/<1s/more  comm');
    for (const t of r.threads.slice(0, 15)) {
      out.push(`${pad(t.pid, 5)} ${pad(t.tid, 6)} ${pad(t.calls, 9)} ${pad(t.inKernelMs.toFixed(1), 10)} ${pad(t.outsideMs.toFixed(1), 11)} ${pad(t.sleepMs.toFixed(1), 10)} ${pad(t.maxGapMs.toFixed(1), 11)} ${`(${t.maxGapAfter} → ${t.maxGapBefore})`.padEnd(26)} ${pad(t.gaps.join('/'), 27)}  ${t.comm}`);
    }
  }
  const keys = r.keys.filter((k) => k.readMs >= 0);
  if ((opts.keys ?? true) && keys.length) {
    const f = (xs: number[]) => (xs.length ? median(xs).toFixed(1) : '-');
    out.push('', `keystrokes: ${r.keys.length} (${keys.length} read); median ms: input→read ${f(keys.map((k) => k.readMs))}, read→first write ${f(keys.filter((k) => k.firstWriteMs >= 0).map((k) => k.firstWriteMs))}, read→last write ${f(keys.filter((k) => k.lastWriteMs >= 0).map((k) => k.lastWriteMs))}; median per key: ${f(keys.map((k) => k.calls))} syscalls, ${f(keys.map((k) => k.kernelMs))} ms in the kernel, ${f(keys.map((k) => k.writeBytes))} bytes written`);
  }
  return out.join('\n') + '\n';
}
