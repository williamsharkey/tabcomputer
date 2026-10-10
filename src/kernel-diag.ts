/**
 * Kernel side of the remote `diag` request: what each process is blocked on,
 * and the sockets and pipes it holds. The same facts the freeze-diag.sh script
 * gathers with js-eval (tabcomputer#19), in one call that works while a
 * native agent (claude in Blink) seems stuck:
 *
 * - per process: state, syscalls in progress (nr and first args, oldest first,
 *   as /proc/PID/syscall) and for how long, syscall count, kernel ms, engine
 *   sleeps, pending/deferred signals, threads
 * - per socket fd: state, rx bytes queued (data waiting that nobody reads, or
 *   no data at all?), EOF/shutdown/error, and the relay peer's WebSocket state,
 *   bufferedAmount and unacked bytes (the TCP relay's flow control)
 * - per pipe fd and named pipe: readers, writers, bytes, waiters (writer-less
 *   FIFOs correlate with freezes: tabcomputer#21)
 *
 * Read-only and synchronous; no kernel imports (it reads the kernel singleton),
 * so the page doesn't load the kernel just to answer.
 */

export interface KernelDiagQuery {
  grep?: string;      // only processes whose command line matches (regex, case-insensitive)
  limit?: number;     // processes returned, default 100
}

const hexArgs = (args: ArrayLike<number> | undefined) =>
  Array.from(args ?? []).slice(0, 4).map((a) => '0x' + (Number(a) >>> 0).toString(16));

function fdInfo(file: any): Record<string, unknown> {
  const out: Record<string, unknown> = { kind: file?.kind };
  try {
    if (typeof file?.debugInfo === 'function') Object.assign(out, file.debugInfo());
    else if (file?.pipe?.debugInfo) Object.assign(out, { end: file.end ?? 'rw' }, file.pipe.debugInfo());
    else if (file?.path) out.path = String(file.path);
  } catch (e: any) { out.error = String(e?.message || e); }
  return out;
}

export function kernelDiagnostics(q: KernelDiagQuery = {}): Record<string, unknown> | null {
  const k = (globalThis as any).__tabcomputerKernel;
  if (!k?.procs) return null;
  const now = Date.now();
  let re: RegExp | null = null;
  if (q.grep) { try { re = new RegExp(q.grep, 'i'); } catch { re = new RegExp(q.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); } }
  const limit = Math.max(1, Math.min(q.limit ?? 100, 1000));
  const procs: Record<string, unknown>[] = [];
  let total = 0;
  for (const p of k.procs.values() as Iterable<any>) {
    total++;
    const cmd = (p.argv?.length ? p.argv.join(' ') : p.path || '').slice(0, 200);
    if (re && !re.test(cmd)) continue;
    if (procs.length >= limit) continue;
    let fds: Record<string, unknown>[] = [];
    try {
      fds = (p.fds?.entries?.() ?? []).map(([fd, file]: [number, any]) => ({ fd, ...fdInfo(file) }));
    } catch { /* table closing */ }
    procs.push({
      pid: p.pid, ppid: p.ppid, cmd, state: p.state,
      sleeping: typeof p.sleeping === 'function' ? p.sleeping(now) : undefined,
      inSyscall: p.inSyscall,
      syscallAgeMs: p.inSyscall ? now - p.syscallSince : 0,
      calls: (p.calls ?? []).slice(0, 4).map((c: any) => [c.nr, ...hexArgs(c.args)]),
      syscalls: p.syscalls, kernelMs: p.kernelMs,
      engineSleeps: p.engineSleeps, engineSleepMs: p.engineSleeps ? now - p.engineSleepSince : 0,
      pendingSignals: [...(p.pendingSignals ?? [])], deferredSignals: [...(p.deferredSignals ?? [])],
      tids: [...(p.tids ?? [])],
      ageMs: now - p.startTime,
      fds,
    });
  }
  let fifos: unknown[] = [];
  try { fifos = k.fifoInfo?.() ?? []; } catch { /* older kernel */ }
  return { now, procs, matched: procs.length, total, fifos };
}
