/**
 * A tabcomputer live profile (src/live-profile.ts, the remote `profile`
 * request) as a Chrome trace (chrome://tracing, https://ui.perfetto.dev):
 * - "page" process: long tasks and long animation frames on the main thread
 *   track, input events and keydown→echo spans on an input track, marks as
 *   instants, counters for event-loop lag, JS heap and terminal output
 * - one process per kernel process: the syscall in progress at each sample
 *   as spans (named by syscall), counters for syscalls and kernel ms per
 *   sample, threads in a call, and Blink's engine lock (waiters, acquires)
 * The per-syscall totals go in the trace's metadata.
 */

export interface TraceEvent {
  name: string; ph: string; ts: number; pid: number; tid?: number; dur?: number; s?: string;
  cat?: string; args?: Record<string, unknown>;
}

const PAGE = 1;
const MAIN = 1, INPUT = 2;
const us = (startedAt: number, tMs: number) => Math.round((startedAt + tMs) * 1000);

export function profileToTrace(p: any): { traceEvents: TraceEvent[]; displayTimeUnit: string; metadata: Record<string, unknown> } {
  const m = p.meta ?? {};
  const base = Number(m.startedAt) || 0;
  const ev: TraceEvent[] = [];
  const meta = (pid: number, name: string, tid?: number, tname?: string) => {
    ev.push({ name: 'process_name', ph: 'M', ts: 0, pid, args: { name } });
    if (tid !== undefined) ev.push({ name: 'thread_name', ph: 'M', ts: 0, pid, tid, args: { name: tname } });
  };
  meta(PAGE, `tabcomputer page${m.label ? ` (${m.label})` : ''}`, MAIN, 'main thread');
  ev.push({ name: 'thread_name', ph: 'M', ts: 0, pid: PAGE, tid: INPUT, args: { name: 'input' } });

  for (const t of p.tasks ?? []) {
    ev.push({ name: t.kind === 'loaf' ? 'long animation frame' : 'long task', cat: t.kind, ph: 'X', ts: us(base, t.t), dur: Math.round(t.ms * 1000), pid: PAGE, tid: MAIN,
      args: { script: t.script, blockingMs: t.blockingMs, layoutMs: t.layoutMs } });
  }
  for (const i of p.inputs ?? []) {
    if (i.name === 'keydown' && i.key !== undefined) {
      ev.push(i.echoMs !== undefined
        ? { name: `key ${i.key} → echo`, cat: 'echo', ph: 'X', ts: us(base, i.t), dur: Math.max(1, Math.round(i.echoMs * 1000)), pid: PAGE, tid: INPUT, args: { echoBytes: i.echoBytes } }
        : { name: `key ${i.key} (no echo)`, cat: 'echo', ph: 'i', s: 't', ts: us(base, i.t), pid: PAGE, tid: INPUT });
    } else {
      ev.push({ name: i.name, cat: 'event-timing', ph: 'X', ts: us(base, i.t), dur: Math.round((i.ms ?? 0) * 1000), pid: PAGE, tid: INPUT,
        args: { delayMs: i.delayMs, handlerMs: i.handlerMs } });
    }
  }
  for (const k of p.marks ?? []) ev.push({ name: k.text, cat: 'mark', ph: 'i', s: 'g', ts: us(base, k.t), pid: PAGE, tid: MAIN });

  const procName = new Map<number, string>();
  for (const pr of p.procs ?? []) procName.set(pr.pid, pr.cmd);
  const names: Record<string, string> = {};
  for (const s of p.syscalls ?? []) if (s.name) names[s.nr] = s.name;
  const sysName = (nr: number) => names[nr] ?? `syscall_${nr}`;
  // pids of kernel processes, offset so they don't meet the page's
  const kp = (pid: number) => 1000 + pid;
  const named = new Set<number>();
  const open = new Map<number, { nr: number; ts: number }>();
  const close = (pid: number, ts: number) => {
    const o = open.get(pid);
    if (!o) return;
    ev.push({ name: sysName(o.nr), cat: 'syscall', ph: 'X', ts: o.ts, dur: Math.max(1, ts - o.ts), pid: kp(pid), tid: 1 });
    open.delete(pid);
  };
  for (const s of p.samples ?? []) {
    const ts = us(base, s.t);
    ev.push({ name: 'page', ph: 'C', ts, pid: PAGE, args: { lagMs: s.lag, heapMB: s.heapMB ?? 0, termOutBytes: s.out ?? 0 } });
    const here = new Set<number>();
    for (const q of s.procs ?? []) {
      here.add(q.pid);
      if (!named.has(q.pid)) {
        named.add(q.pid);
        meta(kp(q.pid), `${q.pid} ${procName.get(q.pid) ?? ''}`.trim(), 1, 'syscall in progress (sampled)');
      }
      ev.push({ name: 'kernel', ph: 'C', ts, pid: kp(q.pid), args: { syscalls: q.sc, kernelMs: q.kms, threadsInCall: q.thr ?? 0 } });
      if (q.lock) ev.push({ name: 'engine lock', ph: 'C', ts, pid: kp(q.pid), args: { waiters: q.lock[1], acquires: q.lock[2] } });
      // The oldest call in progress: a span while it stays the same call
      const first = q.calls?.[0];
      const o = open.get(q.pid);
      if (first) {
        const startTs = ts - Math.round(first[1] * 1000);
        if (o && (o.nr !== first[0] || startTs > o.ts + 5000)) close(q.pid, Math.min(ts, Math.max(o.ts + 1, startTs)));
        if (!open.has(q.pid)) open.set(q.pid, { nr: first[0], ts: Math.max(startTs, o ? o.ts + 1 : startTs) });
      } else close(q.pid, ts);
    }
    for (const pid of [...open.keys()]) if (!here.has(pid)) close(pid, ts);
  }
  const lastTs = us(base, p.samples?.length ? p.samples[p.samples.length - 1].t : 0);
  for (const pid of [...open.keys()]) close(pid, lastTs);

  return {
    traceEvents: ev,
    displayTimeUnit: 'ms',
    metadata: { tabcomputerProfile: m, syscalls: p.syscalls ?? [], procs: p.procs ?? [] },
  };
}

export const PROFILE_PARTS = ['tasks', 'inputs', 'samples', 'marks', 'syscalls', 'procs'] as const;

/**
 * Read a whole capture from the tab in slices: `send` makes one remote
 * request ({type: 'profile', action: 'read', part, offset}) and returns the reply.
 */
export async function collectProfile(send: (req: Record<string, unknown>) => Promise<any>, maxBytes = 200_000): Promise<any> {
  const out: any = { meta: null };
  for (const part of PROFILE_PARTS) {
    const items: unknown[] = [];
    for (let offset: number | null = 0; offset !== null;) {
      const r = await send({ type: 'profile', action: 'read', part, offset, maxBytes });
      if (r?.type === 'error') throw new Error(r.error);
      if (!r?.meta) return out;
      out.meta = r.meta;
      items.push(...(r.items ?? []));
      offset = typeof r.next === 'number' && r.next > offset ? r.next : null;
    }
    out[part] = items;
  }
  return out;
}
