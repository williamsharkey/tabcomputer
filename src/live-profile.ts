/**
 * Live profile: a bounded capture of what the page and the kernel do over a
 * window of time, started and read from outside over `remote start` (the
 * remote `{type: 'profile'}` request, shiro-mcp's `profile` tool and
 * shiro-mcp/profile.mjs, which writes a Chrome/Perfetto trace). Built to time
 * native Claude Code's startup and keystrokes in a real user tab.
 *
 * While a capture runs it records:
 * - long tasks and long animation frames (the slowest script of each)
 * - input: keydown/keyup/pointer Event Timing entries (input delay, handler
 *   time, time to next paint) and, per keydown, the time until a terminal
 *   next wrote output (the echo). Key values are never recorded, only a class
 *   (char, Enter, Backspace, arrow, ctrl, other)
 * - terminal output bytes per sample
 * - the kernel's system calls, per process and number: calls answered at
 *   once (sync), calls that went async, their total and longest time. The
 *   kernel's syscall entry points are wrapped on the instance while the
 *   capture runs, as `strace` does, so nothing is paid when it's off
 * - every `sampleMs`: event-loop lag, JS heap, the shell lines in flight, and
 *   per kernel process (procGrep) the calls in progress and their age, the
 *   syscall and kernel-ms deltas, engine sleeps, threads in a call, and the
 *   Blink engine lock (holder, waiters, acquires since the last sample)
 * - marks: notes from the peer (`profile mark`) or the page
 *
 * Bounded (MAX_* below); it ends by itself after durationMs (default 60 s,
 * at most 10 min) and is read in slices (readProfile) so a reply stays small.
 */

import { activeCommands } from './watchdog';
import buildNumber from '../build-number.txt?raw';

export interface ProfileOptions {
  durationMs?: number;   // ends by itself after this, default 60 s, max 10 min
  sampleMs?: number;     // sampling interval, default 100 ms (min 20)
  procGrep?: string;     // kernel processes sampled (regex on the command line), default all
  label?: string;
}

export interface ProfileTask { t: number; ms: number; kind: 'longtask' | 'loaf'; script?: string; blockingMs?: number; layoutMs?: number }
export interface ProfileInput { t: number; name: string; key?: string; ms?: number; delayMs?: number; handlerMs?: number; echoMs?: number; echoBytes?: number }
export interface ProfileProcSample {
  pid: number;
  calls?: [number, number][];  // [nr, age ms] in progress, oldest first
  sc: number;                  // syscalls since the last sample
  kms: number;                 // kernel ms since the last sample
  sleeping?: boolean;
  thr?: number;                // threads in a syscall (Blink's engine calls)
  lock?: [number, number, number]; // engine lock: holder tid, waiters, acquires since the last sample
}
export interface ProfileSample { t: number; lag: number; heapMB?: number; out: number; active?: string; procs: ProfileProcSample[] }
export interface ProfileSyscall { pid: number; nr: number; name?: string; sync: number; async: number; ms: number; maxMs: number }
export interface ProfileProc { pid: number; ppid?: number; cmd: string; firstT: number; lastT: number; exited?: boolean }

export interface ProfileMeta {
  id: string; label?: string; startedAt: number; endedAt?: number; durationMs: number; sampleMs: number;
  procGrep?: string; running: boolean; endReason?: string;
  ua?: string; isolated?: boolean; cores?: number; build?: string;
  counts: Record<string, number>; dropped: Record<string, number>;
}

export interface Profile {
  meta: ProfileMeta;
  tasks: ProfileTask[]; inputs: ProfileInput[]; samples: ProfileSample[];
  marks: { t: number; text: string }[];
  syscalls: ProfileSyscall[]; procs: ProfileProc[];
}

export type ProfilePart = 'tasks' | 'inputs' | 'samples' | 'marks' | 'syscalls' | 'procs';
export const PROFILE_PARTS: ProfilePart[] = ['tasks', 'inputs', 'samples', 'marks', 'syscalls', 'procs'];

const MAX_DURATION = 10 * 60_000;
const MAX = { tasks: 5000, inputs: 5000, samples: 12_000, marks: 500 };
const ECHO_WINDOW_MS = 3000;
const LOAF_MIN_MS = 50;

interface Capture {
  meta: ProfileMeta;
  t0: number;            // performance.now() at start
  tasks: ProfileTask[]; inputs: ProfileInput[]; samples: ProfileSample[]; marks: { t: number; text: string }[];
  sys: Map<string, ProfileSyscall>;
  procs: Map<number, ProfileProc>;
  last: Map<number, { sc: number; kms: number; acq: number }>;
  pendingKeys: ProfileInput[];
  out: number;
  lastTick: number;
  re: RegExp | null;
  stop: (() => void)[];
}

let cur: Capture | null = null;
let lastDone: Capture | null = null;
let seq = 0;

const now = () => performance.now();
const rel = (c: Capture, perfT: number) => Math.round((perfT - c.t0) * 10) / 10;
const round1 = (n: number) => Math.round(n * 10) / 10;

function push<T>(c: Capture, list: T[], part: keyof typeof MAX, item: T): void {
  if (list.length >= MAX[part]) { c.meta.dropped[part] = (c.meta.dropped[part] ?? 0) + 1; return; }
  list.push(item);
}

/** The class of a key, never its value (a profile may be shared; keystrokes can be secrets) */
export function keyClass(e: { key?: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): string {
  const k = e.key ?? '';
  if (e.ctrlKey || e.metaKey) return 'ctrl';
  if (e.altKey) return 'alt';
  if (k === 'Enter' || k === 'Backspace' || k === 'Tab' || k === 'Escape' || k === ' ') return k === ' ' ? 'char' : k;
  if (k.startsWith('Arrow')) return 'arrow';
  if (k.length === 1) return 'char';
  return 'other';
}

const kernelOf = () => (globalThis as any).__tabcomputerKernel ?? (globalThis as any).window?.__tabcomputer?.kernel;

/** Wrap the kernel's syscall entry points (on the instance, restored on stop). */
function hookKernel(c: Capture): void {
  const k = kernelOf();
  if (!k || typeof k.syscallSync !== 'function' || typeof k.syscall !== 'function') return;
  const hadSync = Object.prototype.hasOwnProperty.call(k, 'syscallSync'), sync0 = k.syscallSync;
  const hadAsync = Object.prototype.hasOwnProperty.call(k, 'syscall'), async0 = k.syscall;
  let on = true;
  const rec = (proc: any, nr: number) => {
    const key = `${proc.pid}:${nr}`;
    let s = c.sys.get(key);
    if (!s) { s = { pid: proc.pid, nr, sync: 0, async: 0, ms: 0, maxMs: 0 }; c.sys.set(key, s); }
    return s;
  };
  const sync = function (this: any, proc: any, nr: number, args: ArrayLike<number>, data: Uint8Array) {
    const r = sync0.call(this, proc, nr, args, data);
    if (on && r !== undefined && proc) rec(proc, nr).sync++;
    return r;
  };
  const async = function (this: any, proc: any, nr: number, args: ArrayLike<number>, data: Uint8Array) {
    const p: Promise<number> = async0.call(this, proc, nr, args, data);
    if (on && proc) {
      const s = rec(proc, nr);
      s.async++;
      const t = now();
      const done = () => { const ms = now() - t; s.ms += ms; if (ms > s.maxMs) s.maxMs = ms; };
      p.then(done, done);
    }
    return p;
  };
  k.syscallSync = sync;
  k.syscall = async;
  c.stop.push(() => {
    on = false;
    // Another wrapper (strace) on top of ours stays; ours just stops counting
    if (k.syscallSync === sync) { if (hadSync) k.syscallSync = sync0; else delete k.syscallSync; }
    if (k.syscall === async) { if (hadAsync) k.syscall = async0; else delete k.syscall; }
  });
}

/** Count terminal output and match it to the keydowns waiting for an echo. */
export function noteTerminalOutput(bytes: number): void {
  const c = cur;
  if (!c || !bytes) return;
  c.out += bytes;
  if (c.pendingKeys.length) {
    const t = rel(c, now());
    for (const k of c.pendingKeys) { k.echoMs = round1(t - k.t); k.echoBytes = bytes; }
    c.pendingKeys.length = 0;
  }
}

async function hookTerminals(c: Capture): Promise<void> {
  let T: any;
  try { T = (await import('@xterm/xterm')).Terminal; } catch { return; }
  const proto = T?.prototype;
  if (!proto || typeof proto.write !== 'function' || cur !== c) return;
  const write0 = proto.write;
  const write = function (this: any, data: string | Uint8Array, cb?: () => void) {
    noteTerminalOutput(typeof data === 'string' ? data.length : data?.length ?? 0);
    return write0.call(this, data, cb);
  };
  proto.write = write;
  c.stop.push(() => { if (proto.write === write) proto.write = write0; });
}

function hookPage(c: Capture): void {
  const PO = (globalThis as any).PerformanceObserver;
  const observe = (type: string, opts: Record<string, unknown>, fn: (e: any) => void) => {
    if (!PO || !(PO.supportedEntryTypes ?? []).includes(type)) return;
    try {
      const o = new PO((list: any) => { if (cur === c) for (const e of list.getEntries()) fn(e); });
      o.observe({ type, ...opts });
      c.stop.push(() => o.disconnect());
    } catch { /* unsupported options */ }
  };
  observe('longtask', {}, (e) => {
    const a = e.attribution?.[0];
    push(c, c.tasks, 'tasks', { t: rel(c, e.startTime), ms: round1(e.duration), kind: 'longtask', script: a?.containerSrc || a?.name || undefined });
  });
  observe('long-animation-frame', {}, (e) => {
    if (e.duration < LOAF_MIN_MS) return;
    const s = (e.scripts || []).slice().sort((x: any, y: any) => y.duration - x.duration)[0];
    const script = s ? `${s.invoker || s.invokerType || ''} ${s.sourceFunctionName || ''} ${String(s.sourceURL || '').split('/').pop()}:${s.sourceCharPosition ?? ''}`.trim().slice(0, 200) : undefined;
    push(c, c.tasks, 'tasks', { t: rel(c, e.startTime), ms: round1(e.duration), kind: 'loaf', script, blockingMs: round1(e.blockingDuration ?? 0), layoutMs: s ? round1(s.forcedStyleAndLayoutDuration ?? 0) : undefined });
  });
  observe('event', { durationThreshold: 16 }, (e) => {
    if (!/^(key|pointer|click|input|beforeinput|compositionend)/.test(e.name)) return;
    push(c, c.inputs, 'inputs', { t: rel(c, e.startTime), name: e.name, ms: round1(e.duration), delayMs: round1(e.processingStart - e.startTime), handlerMs: round1(e.processingEnd - e.processingStart) });
  });
  const doc = (globalThis as any).document;
  if (doc?.addEventListener) {
    const onKey = (e: any) => {
      if (cur !== c) return;
      const k: ProfileInput = { t: rel(c, now()), name: 'keydown', key: keyClass(e) };
      push(c, c.inputs, 'inputs', k);
      c.pendingKeys.push(k);
      if (c.pendingKeys.length > 64) c.pendingKeys.shift();
    };
    doc.addEventListener('keydown', onKey, true);
    c.stop.push(() => doc.removeEventListener('keydown', onKey, true));
  }
}

/** One sample: lag since the previous tick, heap, and the kernel processes. */
export function sampleNow(c: Capture | null = cur): void {
  if (!c) return;
  const tp = now();
  const lag = Math.max(0, tp - c.lastTick - c.meta.sampleMs);
  c.lastTick = tp;
  const t = rel(c, tp);
  // keydowns that never got an echo
  if (c.pendingKeys.length && t - c.pendingKeys[0].t > ECHO_WINDOW_MS) c.pendingKeys = c.pendingKeys.filter((k) => t - k.t <= ECHO_WINDOW_MS);
  const mem = (performance as any).memory;
  const procs: ProfileProcSample[] = [];
  const k = kernelOf();
  const wall = Date.now();
  const seen = new Set<number>();
  if (k?.procs) {
    for (const p of k.procs.values() as Iterable<any>) {
      if (p.state === 'zombie') continue;
      let info = c.procs.get(p.pid);
      if (!info) {
        const cmd = (p.argv?.length ? p.argv.join(' ') : p.path || '').slice(0, 200);
        if (c.re && !c.re.test(cmd)) continue;
        info = { pid: p.pid, ppid: p.ppid, cmd, firstT: t, lastT: t };
        c.procs.set(p.pid, info);
      }
      info.lastT = t;
      seen.add(p.pid);
      const prev = c.last.get(p.pid) ?? { sc: p.syscalls ?? 0, kms: p.kernelMs ?? 0, acq: -1 };
      const s: ProfileProcSample = { pid: p.pid, sc: (p.syscalls ?? 0) - prev.sc, kms: (p.kernelMs ?? 0) - prev.kms };
      const calls = (p.calls ?? []) as { nr: number }[];
      if (calls.length && p.inSyscall) s.calls = calls.slice(0, 4).map((x) => [x.nr, wall - (p.syscallSince ?? wall)]);
      const ec = p.data?.engineCalls as Map<number, { nr: number; since: number }> | undefined;
      if (ec?.size) {
        s.thr = ec.size;
        if (!s.calls) s.calls = [...ec.values()].slice(0, 4).map((x) => [x.nr, wall - x.since]);
      }
      if (typeof p.sleeping === 'function') { try { s.sleeping = !!p.sleeping(wall); } catch { /* older kernel */ } }
      let acq = prev.acq;
      try {
        const l = k.engineLock?.(p.pid);
        if (l) { s.lock = [l.holder, l.waiters, prev.acq < 0 ? 0 : l.acquires - prev.acq]; acq = l.acquires; }
      } catch { /* no engine */ }
      c.last.set(p.pid, { sc: p.syscalls ?? 0, kms: p.kernelMs ?? 0, acq });
      procs.push(s);
    }
  }
  for (const [pid, info] of c.procs) if (!seen.has(pid) && !info.exited) { info.exited = true; c.last.delete(pid); }
  const act = activeCommands()[0];
  push(c, c.samples, 'samples', {
    t, lag: round1(lag), heapMB: mem?.usedJSHeapSize ? Math.round(mem.usedJSHeapSize / 1048576) : undefined,
    out: c.out, active: act ? act.line.slice(0, 120) : undefined, procs,
  });
  c.out = 0;
}

export async function startProfile(o: ProfileOptions = {}): Promise<ProfileMeta> {
  if (cur) stopProfile('replaced by a new capture');
  const durationMs = Math.max(100, Math.min(o.durationMs ?? 60_000, MAX_DURATION));
  const sampleMs = Math.max(20, Math.min(o.sampleMs ?? 100, 5000));
  let re: RegExp | null = null;
  if (o.procGrep) { try { re = new RegExp(o.procGrep, 'i'); } catch { re = new RegExp(o.procGrep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }
  const nav = (globalThis as any).navigator;
  const c: Capture = {
    meta: {
      id: `p${Date.now().toString(36)}${++seq}`, label: o.label?.slice(0, 200), startedAt: Date.now(), durationMs, sampleMs,
      procGrep: o.procGrep, running: true, ua: nav?.userAgent, isolated: (globalThis as any).crossOriginIsolated, cores: nav?.hardwareConcurrency,
      build: String(buildNumber).trim(), counts: {}, dropped: {},
    },
    t0: now(), tasks: [], inputs: [], samples: [], marks: [], sys: new Map(), procs: new Map(), last: new Map(),
    pendingKeys: [], out: 0, lastTick: now(), re, stop: [],
  };
  cur = c;
  hookKernel(c);
  hookPage(c);
  sampleNow(c);
  const iv = setInterval(() => sampleNow(c), sampleMs);
  const end = setTimeout(() => { if (cur === c) stopProfile('duration reached'); }, durationMs);
  c.stop.push(() => { clearInterval(iv); clearTimeout(end); });
  await hookTerminals(c);
  return metaOf(c);
}

function metaOf(c: Capture): ProfileMeta {
  c.meta.counts = { tasks: c.tasks.length, inputs: c.inputs.length, samples: c.samples.length, marks: c.marks.length, syscalls: c.sys.size, procs: c.procs.size };
  return { ...c.meta, counts: { ...c.meta.counts }, dropped: { ...c.meta.dropped } };
}

export function markProfile(text: string): boolean {
  if (!cur) return false;
  push(cur, cur.marks, 'marks', { t: rel(cur, now()), text: String(text).slice(0, 300) });
  return true;
}

export function stopProfile(reason = 'stopped'): ProfileMeta | null {
  const c = cur;
  if (!c) return lastDone ? metaOf(lastDone) : null;
  sampleNow(c);
  cur = null;
  for (const f of c.stop.splice(0).reverse()) { try { f(); } catch { /* already gone */ } }
  c.meta.running = false;
  c.meta.endedAt = Date.now();
  c.meta.endReason = reason;
  lastDone = c;
  return metaOf(c);
}

export function profileStatus(): ProfileMeta | null {
  const c = cur ?? lastDone;
  return c ? metaOf(c) : null;
}

/** x86-64 syscall names for the numbers a capture saw */
async function syscallNames(nrs: Iterable<number>): Promise<Map<number, string>> {
  const names = new Map<number, string>();
  try {
    const abi = await import('./kernel/abi');
    const all = new Map<number, string>();
    for (const [k, v] of Object.entries(abi)) if (k.startsWith('SYS_') && typeof v === 'number' && !all.has(v)) all.set(v, k.slice(4));
    for (const nr of nrs) { const n = all.get(nr); if (n) names.set(nr, n); }
  } catch { /* no kernel */ }
  return names;
}

export interface ProfileSlice {
  meta: ProfileMeta; part: ProfilePart; offset: number; items: unknown[]; total: number; next: number | null;
  names?: Record<number, string>;
}

/**
 * Read a slice of the current (or last) capture: `part`'s items from `offset`,
 * up to `limit` items and about `maxBytes` of JSON (default 200 KB).
 */
export async function readProfile(q: { part?: string; offset?: number; limit?: number; maxBytes?: number } = {}): Promise<ProfileSlice | null> {
  const c = cur ?? lastDone;
  if (!c) return null;
  const part = (PROFILE_PARTS.includes(q.part as ProfilePart) ? q.part : 'samples') as ProfilePart;
  let all: unknown[];
  let names: Record<number, string> | undefined;
  if (part === 'syscalls') {
    const list = [...c.sys.values()].map((s) => ({ ...s, ms: round1(s.ms), maxMs: round1(s.maxMs) }))
      .sort((a, b) => b.ms - a.ms || (b.sync + b.async) - (a.sync + a.async));
    const n = await syscallNames(new Set(list.map((s) => s.nr)));
    for (const s of list) s.name = n.get(s.nr);
    names = Object.fromEntries(n);
    all = list;
  } else if (part === 'procs') all = [...c.procs.values()];
  else all = c[part];
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.max(1, Math.min(q.limit ?? 5000, 20_000));
  const maxBytes = Math.max(1000, Math.min(q.maxBytes ?? 200_000, 2_000_000));
  const items: unknown[] = [];
  let bytes = 0;
  for (let i = offset; i < all.length && items.length < limit; i++) {
    const n = JSON.stringify(all[i]).length + 1;
    if (items.length && bytes + n > maxBytes) break;
    items.push(all[i]);
    bytes += n;
  }
  const end = offset + items.length;
  return { meta: metaOf(c), part, offset, items, total: all.length, next: end < all.length ? end : null, names };
}

/** The whole capture at once (in-page use and tests; remote peers read slices) */
export async function fullProfile(): Promise<Profile | null> {
  const c = cur ?? lastDone;
  if (!c) return null;
  const syscalls = (await readProfile({ part: 'syscalls', limit: 20_000, maxBytes: 2_000_000 }))!.items as ProfileSyscall[];
  return { meta: metaOf(c), tasks: c.tasks, inputs: c.inputs, samples: c.samples, marks: c.marks, syscalls, procs: [...c.procs.values()] };
}

/** One-screen summary, for `watchdog profile` and the remote reply. */
export function summarizeProfile(p: Pick<Profile, 'meta' | 'tasks' | 'inputs' | 'samples' | 'syscalls'>): string[] {
  const m = p.meta;
  const span = ((m.endedAt ?? Date.now()) - m.startedAt) / 1000;
  const out: string[] = [`profile ${m.id}${m.label ? ` (${m.label})` : ''}: ${m.running ? 'running' : `ended (${m.endReason})`}, ${span.toFixed(1)} s, sample ${m.sampleMs} ms`];
  const lt = p.tasks.filter((t) => t.kind === 'longtask');
  const lf = p.tasks.filter((t) => t.kind === 'loaf');
  const sum = (a: number[]) => a.reduce((x, y) => x + y, 0);
  out.push(`long tasks ${lt.length} (${Math.round(sum(lt.map((t) => t.ms)))} ms, max ${Math.round(Math.max(0, ...lt.map((t) => t.ms)))} ms); long frames ${lf.length} (max ${Math.round(Math.max(0, ...lf.map((t) => t.ms)))} ms)`);
  const lags = p.samples.map((s) => s.lag);
  out.push(`event-loop lag: max ${Math.round(Math.max(0, ...lags))} ms, samples over 50 ms: ${lags.filter((l) => l > 50).length}/${lags.length}`);
  const echo = p.inputs.filter((i) => i.echoMs !== undefined).map((i) => i.echoMs!).sort((a, b) => a - b);
  const keys = p.inputs.filter((i) => i.name === 'keydown' && i.key).length;
  if (keys) {
    const q = (f: number) => echo.length ? Math.round(echo[Math.min(echo.length - 1, Math.floor(f * echo.length))]) : NaN;
    out.push(`keystrokes ${keys}: echoed ${echo.length}, echo p50 ${q(0.5)} ms, p90 ${q(0.9)} ms, max ${q(1)} ms`);
  }
  const top = p.syscalls.slice(0, 6).map((s) => `${s.pid}:${s.name ?? s.nr} ${s.sync + s.async}x ${Math.round(s.ms)}ms`);
  if (top.length) out.push(`syscalls by time: ${top.join(', ')}`);
  return out;
}
