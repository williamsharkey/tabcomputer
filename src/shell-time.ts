/**
 * CPU time for the shell's `time`: the user and system time of the kernel
 * processes a timed command started (WASM, x86 and node programs, and theirs),
 * from the kernel's accounting (ProcFs.cpuMs, the figure `ps` and /proc show).
 * Work a builtin does in the page itself has no process and is not counted.
 */
import type { Shell } from './shell';
import type { Process } from './kernel/process';
import type { CommandContext } from './commands/index';

export interface CpuTimes { user: number; sys: number }

/** Start counting; the returned function stops and gives the seconds used. */
export async function startCpuMeter(shell: Shell, terminal?: unknown): Promise<() => CpuTimes> {
  const { kernelForContext } = await import('./wasi/run-command');
  const { ProcFs } = await import('./kernel/procfs');
  const kernel = kernelForContext({ fs: shell.fs, shell } as unknown as CommandContext);
  const seen: { proc: Process; ppid: number; sid: number }[] = [];
  const stop = kernel.onSpawn((proc) => { seen.push({ proc, ppid: proc.ppid, sid: proc.sid }); });
  return () => {
    stop();
    // Only this shell's programs: under its own process when it is one, else in
    // its terminal's session or started without a terminal. Another window's
    // jobs belong to that window's session.
    const host = shell.kernelHost?.proc.pid;
    const sid = (terminal as { tty?: { leader?: { sid?: number } } } | null | undefined)?.tty?.leader?.sid;
    const mine = new Set<number>();
    let cpu = 0, sys = 0;
    for (const { proc, ppid, sid: s } of seen) {
      const own = mine.has(ppid) || (host !== undefined ? ppid === host : ppid <= 1 || sid === undefined || s === sid);
      if (!own) continue;
      mine.add(proc.pid);
      cpu += ProcFs.cpuMs(proc);
      sys += ProcFs.systemMs(proc);
    }
    return { user: Math.max(0, cpu - sys) / 1000, sys: sys / 1000 };
  };
}

/** bash's `0m1.234s` */
export function minSec(seconds: number): string {
  return `${Math.floor(seconds / 60)}m${(seconds % 60).toFixed(3)}s`;
}
