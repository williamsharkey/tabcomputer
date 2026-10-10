/**
 * Main-thread watchdog: what was the page doing when it froze?
 *
 * Captured from boot into a bounded ring (like console-log.ts):
 * - event-loop lag: a 500 ms heartbeat; a tick late by LAG_RECORD_MS or more is
 *   an event, with the shell commands running at the time
 * - long tasks (PerformanceObserver 'longtask') and long animation frames
 *   ('long-animation-frame', Chromium), with the script that ran when known
 * - shell commands: top-level starts and ends, and every execute() in flight
 *   (innermost first), so a runaway function or `source` shows by name
 * - JS heap every 10 s (performance.memory, Chromium)
 *
 * The newest events are saved to localStorage every 5 s, after a stall, and on
 * pagehide, so the next load can read what led up to a freeze or a reload.
 *
 * A page that never recovers can't save anything itself, so a small Worker
 * watches the heartbeat: when the page has missed it for WEDGE_MS, the worker
 * writes the page's last snapshot (commands in flight, lag, heap) to
 * IndexedDB, and keeps the record's duration current until the page answers
 * again (record deleted) or the tab is closed or reloaded (record kept). The
 * next load reports it as a `wedge` event and in diagnostics().previousWedge.
 *
 * Read with the `watchdog` command, the remote `{type: 'diag'}` request, and the
 * shiro-mcp `diag` tool. Safe mode records but never replaces the previous
 * load's saved ring, like the console log.
 */

import { isSafeMode } from './safe-mode';
import { kernelDiagnostics } from './kernel-diag';
import type { RelayInfo } from './remote-relay';

export type WatchdogKind = 'lag' | 'longtask' | 'loaf' | 'cmd' | 'cmd-end' | 'stall' | 'wedge' | 'note';

export interface WatchdogEvent {
  t: number;          // ms epoch
  kind: WatchdogKind;
  ms?: number;        // lag, task length, command run time, stall length
  text?: string;      // command line, script, note
  active?: string[];  // commands in flight, innermost first (lag/stall/longtask)
}

export interface ActiveCommand { line: string; started: number; depth: number }

export interface WedgeRecord {
  since: number;      // last heartbeat the worker saw
  seenAt: number;     // last time the worker updated the record
  snapshot: Snapshot | null;
}

export interface Snapshot {
  t: number;
  active: { line: string; ms: number }[];
  lastLagMs: number;
  heapMB?: number;
  recent: string[];   // last top-level commands started
}

export interface Diagnostics {
  now: number;
  pageStart: number;
  visible: boolean;
  lag: { lastMs: number; maxMs1m: number; avgMs1m: number; samples1m: number };
  longTasks: { count1m: number; ms1m: number; count: number; ms: number; maxMs: number };
  memory: { usedMB?: number; totalMB?: number; limitMB?: number; seriesMB: [number, number][] };
  active: { line: string; ms: number; depth: number }[];
  events: WatchdogEvent[];
  dropped: number;
  previousWedge?: WedgeRecord | null;
  workerAlive: boolean;
}

export interface DiagQuery {
  limit?: number;     // newest events returned, default 200
  since?: number;     // ms epoch, or negative = ms ago
  kind?: string;      // comma list of kinds
  previous?: boolean; // the ring saved by the previous page load
}

const MAX_EVENTS = 1500;
const MAX_TEXT = 300;
const MAX_ACTIVE = 64;
const TICK_MS = 500;
export const LAG_RECORD_MS = 250;
export const STALL_MS = 2000;
export const WEDGE_MS = 3000;
const LONGTASK_RECORD_MS = 200;
const MEM_EVERY_MS = 10_000;
const MEM_SERIES = 120;
const PERSIST_KEY = 'tabcomputer-watchdog';
const PERSIST_EVENTS = 400;
const PERSIST_EVERY_MS = 5000;
const IDB_NAME = 'tabcomputer-watchdog'; // = WATCHDOG_IDB in watchdog-worker.ts

const events: WatchdogEvent[] = [];
let dropped = 0;
let dirty = false;
const pageStart = Date.now();
const lagRing: [number, number][] = [];    // [t, lag ms] for the last minute
const taskRing: [number, number][] = [];   // [t, ms] long tasks in the last minute
let taskCount = 0, taskMs = 0, taskMax = 0;
let lastLag = 0;
const memSeries: [number, number][] = [];
const active = new Map<number, ActiveCommand>();
let activeSeq = 0;
const recent: string[] = [];
// Lines that finished lately: a stall is noticed on the next heartbeat, after
// the command that froze the page may already have returned
const ended: { line: string; started: number; ended: number }[] = [];
let workerAlive = false;
let watchWorker: Worker | null = null;
let previousWedge: WedgeRecord | null | undefined;

const clip = (s: string) => (s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '…' : s);

export function recordEvent(e: WatchdogEvent): void {
  if (e.text) e.text = clip(e.text);
  events.push(e);
  if (events.length > MAX_EVENTS) { events.shift(); dropped++; }
  dirty = true;
}

/** Commands in flight, innermost (latest started) first. */
export function activeCommands(now = Date.now()): { line: string; ms: number; depth: number }[] {
  // Map order is start order: newest last
  return [...active.values()].reverse()
    .map((c) => ({ line: c.line, ms: now - c.started, depth: c.depth }));
}

/** What ran during the last `windowMs`: in flight now, then lines that ended within it (innermost first) */
const activeLines = (windowMs = 0) => {
  const now = Date.now();
  const lines = activeCommands(now).slice(0, 4).map((c) => `${Math.round(c.ms / 1000)}s ${c.line.slice(0, 120)}`);
  for (let i = ended.length - 1; i >= 0 && lines.length < 6; i--) {
    const e = ended[i];
    if (e.ended < now - windowMs) break;
    lines.push(`ended after ${Math.round((e.ended - e.started) / 1000)}s ${e.line.slice(0, 120)}`);
  }
  return lines;
};

/**
 * Called by Shell.execute around every command line. `depth` 0 is a line
 * typed at a prompt or sent by a remote peer; deeper ones are function bodies,
 * `source`, loops. Returns the token for commandEnded.
 */
export function commandStarted(line: string, depth: number): number {
  const id = ++activeSeq;
  if (active.size < MAX_ACTIVE) active.set(id, { line: clip(line), started: Date.now(), depth });
  if (depth === 0) {
    recordEvent({ t: Date.now(), kind: 'cmd', text: line });
    recent.push(clip(line).slice(0, 160));
    if (recent.length > 10) recent.shift();
    // A command that freezes the page in its first task never reaches a
    // heartbeat: give the worker the snapshot that names it now
    try { watchWorker?.postMessage({ snap: snapshot() }); } catch { /* worker gone */ }
  }
  return id;
}

export function commandEnded(id: number, status?: number): void {
  const c = active.get(id);
  if (!c) return;
  active.delete(id);
  ended.push({ line: c.line, started: c.started, ended: Date.now() });
  if (ended.length > 32) ended.shift();
  if (c.depth === 0) {
    const ms = Date.now() - c.started;
    // Short successful top-level commands only add noise next to their start
    if (ms >= 1000 || (status !== undefined && status !== 0)) {
      recordEvent({ t: Date.now(), kind: 'cmd-end', ms, text: `${status ?? '?'} ${c.line}` });
    }
  }
}

function heap(): { usedMB?: number; totalMB?: number; limitMB?: number } {
  const m = (typeof performance !== 'undefined' ? (performance as any).memory : undefined);
  if (!m) return {};
  return { usedMB: Math.round(m.usedJSHeapSize / 1048576), totalMB: Math.round(m.totalJSHeapSize / 1048576), limitMB: Math.round(m.jsHeapSizeLimit / 1048576) };
}

export function snapshot(now = Date.now()): Snapshot {
  // While an outside agent is attached over the relay, the worker may have to
  // answer `diag` for a frozen page: give it the kernel's state every 5 s
  if (relayProxy && now - lastKernelAt >= 5000) {
    lastKernelAt = now;
    try { lastKernel = kernelDiagnostics({ limit: 30 }); } catch { lastKernel = null; }
  }
  return {
    t: now,
    active: activeCommands(now).slice(0, 8).map(({ line, ms }) => ({ line, ms })),
    lastLagMs: lastLag,
    heapMB: heap().usedMB,
    recent: recent.slice(-5),
    ...(relayProxy && lastKernel ? { kernel: lastKernel } : {}),
  };
}
let lastKernelAt = 0;
let lastKernel: Record<string, unknown> | null = null;

/** The relay as hosted by the worker, seen from the page (remote.ts wires it like a data channel) */
export interface WorkerRelay {
  readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  send(text: string): void;
  close(): void;
}
let relayProxy: WorkerRelay | null = null;

/**
 * Run a remote session's relay in the watchdog worker, so `diag` is answered
 * even while this page is frozen. Null when the worker isn't running (then
 * the caller runs the relay in the page).
 */
export function workerRelay(opts: { base: string; info: RelayInfo; code: string }): WorkerRelay | null {
  const w = watchWorker;
  if (!w || !workerAlive) return null;
  if (relayProxy) { const old = relayProxy; relayProxy = null; old.readyState = 'closed'; }
  const proxy: WorkerRelay = {
    readyState: 'connecting', onopen: null, onclose: null, onmessage: null,
    send(text) {
      if (proxy.readyState !== 'open') throw new Error('relay channel is not open');
      w.postMessage({ relaySend: text });
    },
    close() {
      if (proxy.readyState === 'closed') return;
      proxy.readyState = 'closed';
      if (relayProxy === proxy) { relayProxy = null; w.postMessage({ relayStop: true }); }
      proxy.onclose?.();
    },
  };
  relayProxy = proxy;
  w.postMessage({ relayStart: opts });
  return proxy;
}

function prune(ring: [number, number][], now: number) {
  while (ring.length && ring[0][0] < now - 60_000) ring.shift();
}

/** One heartbeat tick: `lag` is how late it ran. Exported for tests. */
export function noteLag(lag: number, now = Date.now()): void {
  lastLag = lag;
  lagRing.push([now, lag]);
  prune(lagRing, now);
  if (lag >= LAG_RECORD_MS) {
    recordEvent({ t: now, kind: lag >= STALL_MS ? 'stall' : 'lag', ms: Math.round(lag), active: activeLines(lag + TICK_MS) });
  }
}

export function noteLongTask(ms: number, now = Date.now(), text?: string, kind: 'longtask' | 'loaf' = 'longtask'): void {
  if (kind === 'longtask') {
    taskCount++; taskMs += ms; if (ms > taskMax) taskMax = ms;
    taskRing.push([now, ms]);
    prune(taskRing, now);
  }
  if (ms >= LONGTASK_RECORD_MS) recordEvent({ t: now, kind, ms: Math.round(ms), text, active: activeLines(Math.max(0, Date.now() - now)) });
}

function readSaved(): { pageStart: number; events: WatchdogEvent[] } | null {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(PERSIST_KEY) : null;
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// The previous load's ring, read before this load's saves replace it
const safe = isSafeMode();
let previousSaved: { pageStart: number; events: WatchdogEvent[] } | null | undefined = safe ? undefined : readSaved();

export function diagnostics(q: DiagQuery = {}): Diagnostics {
  const now = Date.now();
  let source = events;
  let start = pageStart;
  if (q.previous) {
    if (previousSaved === undefined) previousSaved = readSaved();
    source = previousSaved?.events || [];
    start = previousSaved?.pageStart ?? 0;
  }
  const kinds = q.kind ? new Set(q.kind.split(',').map((s) => s.trim())) : null;
  const since = q.since === undefined ? undefined : q.since < 0 ? now + q.since : q.since;
  const matched = source.filter((e) => (!kinds || kinds.has(e.kind)) && (since === undefined || e.t >= since));
  const limit = Math.max(1, Math.min(q.limit ?? 200, MAX_EVENTS));
  prune(lagRing, now); prune(taskRing, now);
  const lags = lagRing.map(([, l]) => l);
  return {
    now,
    pageStart: start,
    visible: typeof document === 'undefined' || document.visibilityState !== 'hidden',
    lag: {
      lastMs: Math.round(lastLag),
      maxMs1m: Math.round(Math.max(0, ...lags)),
      avgMs1m: lags.length ? Math.round(lags.reduce((a, b) => a + b, 0) / lags.length) : 0,
      samples1m: lags.length,
    },
    longTasks: {
      count1m: taskRing.length,
      ms1m: Math.round(taskRing.reduce((a, [, d]) => a + d, 0)),
      count: taskCount, ms: Math.round(taskMs), maxMs: Math.round(taskMax),
    },
    memory: { ...heap(), seriesMB: memSeries.slice() },
    active: activeCommands(now),
    events: matched.slice(-limit),
    dropped: q.previous ? 0 : dropped,
    previousWedge,
    workerAlive,
  };
}

/** Plain-text rendering for the shell command. */
export function formatDiagnostics(d: Diagnostics): string {
  const time = (t: number) => new Date(t).toISOString().slice(11, 23);
  const out: string[] = [];
  out.push(`lag: last ${d.lag.lastMs}ms, max ${d.lag.maxMs1m}ms, avg ${d.lag.avgMs1m}ms over 1 min${d.visible ? '' : ' (tab hidden: timers throttled)'}`);
  out.push(`long tasks: ${d.longTasks.count1m} (${d.longTasks.ms1m}ms) in 1 min; ${d.longTasks.count} (${d.longTasks.ms}ms, max ${d.longTasks.maxMs}ms) since load`);
  if (d.memory.usedMB !== undefined) out.push(`heap: ${d.memory.usedMB}/${d.memory.limitMB} MB`);
  out.push(`watchdog worker: ${d.workerAlive ? 'running' : 'not running'}`);
  if (d.previousWedge) {
    const w = d.previousWedge;
    out.push(`previous load froze at ${new Date(w.since).toISOString()} for at least ${Math.round((w.seenAt - w.since) / 1000)}s`);
    for (const c of w.snapshot?.active || []) out.push(`  running ${Math.round(c.ms / 1000)}s: ${c.line}`);
  }
  if (d.active.length) {
    out.push('in flight (innermost first):');
    for (const c of d.active.slice(0, 10)) out.push(`  ${String(Math.round(c.ms / 1000)).padStart(5)}s  ${'  '.repeat(Math.min(c.depth, 6))}${c.line}`);
  }
  if (d.events.length) out.push('events:');
  for (const e of d.events) {
    const ms = e.ms !== undefined ? ` ${e.ms}ms` : '';
    const act = e.active?.length ? `  [${e.active[0]}]` : '';
    out.push(`  ${time(e.t)} ${e.kind.padEnd(8)}${ms} ${e.text ?? ''}${act}`.trimEnd());
  }
  return out.join('\n');
}

export function clearWatchdog(): void {
  events.length = 0; lagRing.length = 0; taskRing.length = 0; memSeries.length = 0;
  taskCount = taskMs = taskMax = 0; lastLag = 0; dropped = 0; recent.length = 0; ended.length = 0;
  dirty = true;
}

/** Reset the in-flight table (tests). */
export function clearActive(): void { active.clear(); }

// ── IndexedDB: the worker's wedge record (src/watchdog-worker.ts writes it) ──

/** Take a wedge record left by an earlier load (one from this load is left alone). */
function idbTake(before: number): Promise<WedgeRecord | null> {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onerror = () => resolve(null);
      r.onsuccess = () => {
        try {
          const tx = r.result.transaction('kv', 'readwrite');
          const store = tx.objectStore('kv');
          const get = store.get('wedge');
          get.onsuccess = () => {
            const v: WedgeRecord | null = get.result ?? null;
            if (v && v.since < before) { store.delete('wedge'); resolve(v); } else resolve(null);
          };
          get.onerror = () => resolve(null);
          tx.oncomplete = () => r.result.close();
        } catch { resolve(null); }
      };
    } catch { resolve(null); }
  });
}

// ── install ───────────────────────────────────────────────────────────────

// localStorage writes are synchronous: at most one every PERSIST_MIN_MS, except at pagehide
const PERSIST_MIN_MS = 3000;
let lastPersist = 0;
function persist(force = false): void {
  if (!dirty || safe) return;
  const now = Date.now();
  if (!force && now - lastPersist < PERSIST_MIN_MS) return;
  lastPersist = now;
  dirty = false;
  try { localStorage.setItem(PERSIST_KEY, JSON.stringify({ pageStart, events: events.slice(-PERSIST_EVENTS) })); } catch { /* quota */ }
}

function install(): void {
  // Heartbeat. Hidden tabs throttle timers (1/s, then 1/min), which isn't a freeze.
  let expected = performance.now() + TICK_MS;
  let wasHidden = document.visibilityState === 'hidden';
  let worker: Worker | null = null;
  let lastSnap = 0;
  let lastHidden = wasHidden;
  setInterval(() => {
    const now = performance.now();
    const hidden = document.visibilityState === 'hidden';
    const lag = Math.max(0, now - expected);
    expected = now + TICK_MS;
    if (!hidden && !wasHidden) {
      noteLag(lag);
      if (lag >= STALL_MS) persist();
    }
    wasHidden = hidden;
    if (worker) {
      // One heartbeat a second (sooner when visibility changes). The snapshot
      // in it is what the worker saves if the page stops answering.
      const t = Date.now();
      if (t - lastSnap >= 1000 || hidden !== lastHidden) { lastSnap = t; lastHidden = hidden; worker.postMessage({ snap: snapshot(t), hidden }); }
    }
  }, TICK_MS);

  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const attr = (e as any).attribution?.[0];
        const where = attr && attr.containerSrc ? attr.containerSrc : undefined;
        noteLongTask(e.duration, Math.round(performance.timeOrigin + e.startTime), where);
      }
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* not supported */ }
  try {
    // Long animation frames name the script that ran (Chromium 123+)
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) {
        if (e.duration < LONGTASK_RECORD_MS) continue;
        const s = (e.scripts || []).slice().sort((a: any, b: any) => b.duration - a.duration)[0];
        const text = s ? `${s.invoker || s.invokerType || ''} ${s.sourceFunctionName || ''} ${String(s.sourceURL || '').split('/').pop()}:${s.sourceCharPosition ?? ''}`.trim() : undefined;
        noteLongTask(e.duration, Math.round(performance.timeOrigin + e.startTime), text, 'loaf');
      }
    }).observe({ type: 'long-animation-frame', buffered: true } as any);
  } catch { /* not supported */ }

  setInterval(() => {
    const m = heap();
    if (m.usedMB === undefined) return;
    memSeries.push([Date.now(), m.usedMB]);
    if (memSeries.length > MEM_SERIES) memSeries.shift();
  }, MEM_EVERY_MS);

  if (!safe) setInterval(persist, PERSIST_EVERY_MS);
  addEventListener('pagehide', () => persist(true));

  try {
    worker = watchWorker = new Worker(new URL('./watchdog-worker.ts', import.meta.url), { type: 'module', name: 'watchdog' });
    workerAlive = true;
    worker.onmessage = (e) => {
      const m = e.data || {};
      if (m.stall) recordEvent({ t: m.since, kind: 'note', ms: m.stall, text: `worker saw the page frozen for ${Math.round(m.stall / 1000)}s` });
      else if (m.relayOpen) { if (relayProxy) { relayProxy.readyState = 'open'; relayProxy.onopen?.(); } }
      else if (m.relayMessage !== undefined) relayProxy?.onmessage?.({ data: m.relayMessage });
      else if (m.relayClose) { const p = relayProxy; relayProxy = null; if (p) { p.readyState = 'closed'; p.onclose?.(); } }
    };
    worker.onerror = () => { workerAlive = false; };
  } catch { worker = null; }

  // Did the previous load end frozen? (Read before this load's worker can write)
  if (typeof indexedDB !== 'undefined') {
    idbTake(pageStart).then((w) => {
      previousWedge = w;
      if (w) {
        const first = w.snapshot?.active?.[0];
        recordEvent({ t: w.since, kind: 'wedge', ms: w.seenAt - w.since,
          text: `previous load froze and was closed or reloaded${first ? ` while running: ${first.line}` : ''}` });
        console.warn(`[watchdog] the previous load froze for ${Math.round((w.seenAt - w.since) / 1000)}s+${first ? ` while running: ${first.line}` : ''} (see \`watchdog --prev\`)`);
      }
    });
  }
}

/** Kill switch: `watchdog off` (localStorage, honored in safe mode too) or ?watchdog=0 for one load */
export const WATCHDOG_OFF_KEY = 'tabcomputer-watchdog-off';
export function watchdogDisabled(): string | null {
  try {
    if (new URLSearchParams(location.search).get('watchdog') === '0') return '?watchdog=0';
    if (localStorage.getItem(WATCHDOG_OFF_KEY) === '1') return '`watchdog off`';
  } catch { /* no storage */ }
  return null;
}
let installed = false;
export const watchdogInstalled = () => installed;

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !(window as any).__tabcomputerWatchdog && !watchdogDisabled()) {
  try { install(); installed = true; } catch { /* never break boot */ }
  (window as any).__tabcomputerWatchdog = { diagnostics, format: formatDiagnostics, clear: clearWatchdog };
}
