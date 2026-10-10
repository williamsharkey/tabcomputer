/**
 * The kernel side of the remote `diag` request (src/kernel-diag.ts): what a
 * process is blocked in, and the sockets and pipes it holds (tabcomputer#19).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { kernelDiagnostics } from '@shiro/kernel-diag';
import { NetStack } from '@shiro/kernel/net';
import { createPipe } from '@shiro/kernel/pipe';

const g = globalThis as any;
const saved = g.__tabcomputerKernel;
afterEach(() => { g.__tabcomputerKernel = saved; });

describe('kernel diagnostics', () => {
  it('shows syscalls in progress, unread socket bytes and a writer-less pipe', async () => {
    const pair = new NetStack().socketpair();
    if (typeof pair === 'number') throw new Error(`socketpair: ${pair}`);
    const [a, b] = pair;
    await b.write(new TextEncoder().encode('hello'));
    const [r, w] = createPipe();
    w.pipe.writers--; // the writer went away (closed elsewhere)
    const t0 = Date.now() - 5000;
    g.__tabcomputerKernel = {
      procs: new Map([[42, {
        pid: 42, ppid: 1, argv: ['claude', '--resume'], state: 'running', inSyscall: 1, syscallSince: t0,
        calls: [{ nr: 232, args: [13, 0x400, 4000, 0] }], syscalls: 1234, kernelMs: 99, engineSleeps: 0,
        engineSleepSince: 0, pendingSignals: new Set([15]), deferredSignals: new Set(), tids: new Set([43]),
        startTime: t0 - 1000, sleeping: () => true,
        fds: { entries: () => [[3, a], [4, r]] },
      }], [7, { pid: 7, ppid: 1, argv: ['sh'], state: 'running', calls: [], startTime: Date.now(), fds: { entries: () => [] } }]]),
      fifoInfo: () => [{ path: '/tmp/fifo1', ...r.pipe.debugInfo() }],
    };
    const d: any = kernelDiagnostics({ grep: 'claude' });
    expect(d.total).toBe(2);
    expect(d.procs).toHaveLength(1);
    const p = d.procs[0];
    expect(p).toMatchObject({ pid: 42, cmd: 'claude --resume', inSyscall: 1, sleeping: true, pendingSignals: [15], tids: [43] });
    expect(p.syscallAgeMs).toBeGreaterThanOrEqual(5000);
    expect(p.calls[0]).toEqual([232, '0xd', '0x400', '0xfa0', '0x0']);
    const sock = p.fds.find((f: any) => f.fd === 3);
    expect(sock).toMatchObject({ kind: 'socket', state: 'connected', rxLen: 5, rxEof: false, soError: 0 });
    const pipe = p.fds.find((f: any) => f.fd === 4);
    expect(pipe).toMatchObject({ kind: 'pipe', end: 'r', readers: 1, writers: 0 });
    expect(d.fifos[0]).toMatchObject({ path: '/tmp/fifo1', writers: 0 });
    expect(p.threads).toBeUndefined(); // (a kernel without per-thread state)
  });

  it('includes per-thread state and the engine lock when the kernel has them', () => {
    g.__tabcomputerKernel = {
      procs: new Map([[5, { pid: 5, argv: ['claude'], calls: [], startTime: Date.now(), fds: { entries: () => [] } }]]),
      threadStates: (pid: number) => [{ tid: pid, state: 'S', nr: 232, args: [13, 1024, 4000], sinceMs: 9000, syscalls: 7 }],
      engineLock: () => ({ holder: 6, waiters: 1, acquires: 40 }),
    };
    const p: any = (kernelDiagnostics() as any).procs[0];
    expect(p.threads).toEqual([{ tid: 5, state: 'S', nr: 232, args: [13, 1024, 4000], sinceMs: 9000, syscalls: 7 }]);
    expect(p.engineLock).toEqual({ holder: 6, waiters: 1, acquires: 40 });
  });

  it('is null without a kernel', () => {
    g.__tabcomputerKernel = undefined;
    expect(kernelDiagnostics()).toBeNull();
  });
});
