/**
 * Live profile (src/live-profile.ts): the capture behind the remote `profile`
 * request, and shiro-mcp's reader and Chrome-trace export (shiro-mcp/src/trace.ts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { startProfile, stopProfile, markProfile, readProfile, fullProfile, sampleNow, noteTerminalOutput, keyClass, summarizeProfile, profileStatus } from '@shiro/live-profile';
import { profileToTrace, collectProfile } from '../../../shiro-mcp/src/trace';

const g = globalThis as any;
const saved = g.__tabcomputerKernel;
afterEach(() => { stopProfile(); g.__tabcomputerKernel = saved; });

class FakeKernel {
  procs = new Map<number, any>();
  syscallSync(_p: any, nr: number) { return nr === 39 ? 7 : undefined; }       // getpid answers at once
  syscall(_p: any, _nr: number) { return new Promise<number>((r) => setTimeout(() => r(0), 15)); }
  engineLock(pid: number) { return this.procs.get(pid)?.lock ?? null; }
}
const proc = (pid: number, argv: string[], extra: Record<string, unknown> = {}) =>
  ({ pid, ppid: 1, argv, state: 'running', syscalls: 0, kernelMs: 0, inSyscall: 0, calls: [], syscallSince: 0, data: {}, ...extra });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('live profile', () => {
  it('counts syscalls per process and number while it runs, and unhooks the kernel after', async () => {
    const k = new FakeKernel();
    const p = proc(42, ['claude']);
    k.procs.set(42, p);
    g.__tabcomputerKernel = k;
    await startProfile({ sampleMs: 1000, durationMs: 5000 });
    expect(Object.prototype.hasOwnProperty.call(k, 'syscall')).toBe(true);
    k.syscallSync(p, 39, [], new Uint8Array());
    k.syscallSync(p, 39, [], new Uint8Array());
    expect(k.syscallSync(p, 0, [], new Uint8Array())).toBeUndefined(); // not answered at once: not counted here
    await k.syscall(p, 0, [], new Uint8Array());
    await k.syscall(p, 232, [], new Uint8Array());
    const m = stopProfile()!;
    expect(m.running).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(k, 'syscall')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(k, 'syscallSync')).toBe(false);
    k.syscallSync(p, 39, [], new Uint8Array()); // after stop: not counted
    const s = (await readProfile({ part: 'syscalls' }))!;
    const by = Object.fromEntries((s.items as any[]).map((x) => [x.name ?? x.nr, x]));
    expect(by.getpid).toMatchObject({ pid: 42, nr: 39, sync: 2, async: 0 });
    expect(by.read).toMatchObject({ sync: 0, async: 1 });
    expect(by.read.ms).toBeGreaterThanOrEqual(10);
    expect(by.epoll_wait.maxMs).toBeGreaterThanOrEqual(10);
    expect(s.names?.[232]).toBe('epoll_wait');
  });

  it('leaves a wrapper put on top of its own (strace) in place', async () => {
    const k = new FakeKernel();
    g.__tabcomputerKernel = k;
    await startProfile({ sampleMs: 1000 });
    const ours = k.syscallSync;
    const strace = (...a: any[]) => (ours as any).apply(k, a);
    k.syscallSync = strace as any;
    stopProfile();
    expect(k.syscallSync).toBe(strace);
    expect(k.syscallSync(proc(1, ['x']), 39, [], new Uint8Array())).toBe(7);
  });

  it('samples calls in progress, syscall deltas and the engine lock of the matching processes', async () => {
    const k = new FakeKernel();
    const now = Date.now();
    const claude = proc(42, ['/home/user/.local/bin/claude'], { syscalls: 100, kernelMs: 10, lock: { holder: 43, waiters: 2, acquires: 1000 } });
    claude.data.engineCalls = new Map([[43, { nr: 202, since: now - 500, args: [] }]]);
    k.procs.set(42, claude);
    k.procs.set(7, proc(7, ['sh']));
    g.__tabcomputerKernel = k;
    await startProfile({ sampleMs: 1000, procGrep: 'claude' });
    claude.syscalls = 160; claude.kernelMs = 25; claude.lock = { holder: 0, waiters: 0, acquires: 1040 };
    claude.inSyscall = 1; claude.syscallSince = now - 300; claude.calls = [{ nr: 232, args: [] }];
    sampleNow();
    k.procs.delete(42);
    stopProfile();
    const { items } = (await readProfile({ part: 'samples' }))!;
    const s = (items as any[])[1].procs;
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ pid: 42, sc: 60, kms: 15, thr: 1, lock: [0, 0, 40] });
    expect(s[0].calls[0][0]).toBe(232);
    expect(s[0].calls[0][1]).toBeGreaterThanOrEqual(300);
    const procs = (await readProfile({ part: 'procs' }))!.items as any[];
    expect(procs).toEqual([expect.objectContaining({ pid: 42, cmd: '/home/user/.local/bin/claude', exited: true })]);
  });

  it('times keydown to terminal echo by key class, never the key', async () => {
    g.__tabcomputerKernel = new FakeKernel();
    await startProfile({ sampleMs: 1000 });
    const ev: any = new (g.window.Event)('keydown');
    Object.assign(ev, { key: 's' });
    g.document.dispatchEvent(ev);
    await wait(20);
    noteTerminalOutput(3);
    noteTerminalOutput(100); // not an echo any more
    markProfile('typed s');
    stopProfile();
    const p = (await fullProfile())!;
    const k = p.inputs.find((i) => i.name === 'keydown')!;
    expect(k.key).toBe('char');
    expect(k.echoBytes).toBe(3);
    expect(k.echoMs!).toBeGreaterThanOrEqual(15);
    expect(JSON.stringify(p)).not.toContain('"s"');
    expect(p.marks[0].text).toBe('typed s');
    expect(p.samples.reduce((a, s) => a + s.out, 0)).toBe(103);
    expect(summarizeProfile(p).join('\n')).toMatch(/keystrokes 1: echoed 1/);
    expect(keyClass({ key: 'c', ctrlKey: true })).toBe('ctrl');
    expect(keyClass({ key: 'ArrowUp' })).toBe('arrow');
    expect(keyClass({ key: 'Enter' })).toBe('Enter');
  });

  it('reads in slices under maxBytes, and ends by itself after durationMs', async () => {
    g.__tabcomputerKernel = new FakeKernel();
    await startProfile({ sampleMs: 20, durationMs: 300 });
    for (let i = 0; i < 50; i++) markProfile(`mark ${i} `.padEnd(100, 'x'));
    await wait(450);
    expect(profileStatus()).toMatchObject({ running: false, endReason: 'duration reached' });
    const first = (await readProfile({ part: 'marks', maxBytes: 1000 }))!;
    expect(first.items.length).toBeLessThan(50);
    expect(first.next).toBe(first.items.length);
    const all = await collectProfile(async (req: any) => readProfile(req), 1000);
    expect(all.marks).toHaveLength(50);
    expect(all.samples.length).toBeGreaterThanOrEqual(5);
    expect(all.meta.id).toBe(first.meta.id);
  });

  it('exports a Chrome trace: tasks, echo spans, syscall-in-progress spans, counters', () => {
    const p = {
      meta: { id: 'p1', startedAt: 1_000_000, label: 'claude startup', counts: {}, dropped: {} },
      tasks: [{ t: 10, ms: 120, kind: 'longtask' }, { t: 200, ms: 80, kind: 'loaf', script: 'x.js' }],
      inputs: [{ t: 50, name: 'keydown', key: 'char', echoMs: 40, echoBytes: 1 }, { t: 60, name: 'keydown', key: 'Enter' }, { t: 70, name: 'keyup', ms: 24, delayMs: 2, handlerMs: 5 }],
      marks: [{ t: 5, text: 'go' }],
      samples: [
        { t: 0, lag: 0, out: 0, procs: [{ pid: 42, sc: 0, kms: 0 }] },
        { t: 100, lag: 3, out: 10, procs: [{ pid: 42, sc: 5, kms: 1, calls: [[232, 50]], lock: [0, 1, 9] }] },
        { t: 200, lag: 0, out: 0, procs: [{ pid: 42, sc: 1, kms: 0, calls: [[232, 150]] }] },
        { t: 300, lag: 0, out: 0, procs: [{ pid: 42, sc: 9, kms: 0, calls: [[0, 10]] }] },
        { t: 400, lag: 0, out: 0, procs: [] },
      ],
      syscalls: [{ pid: 42, nr: 232, name: 'epoll_wait', sync: 0, async: 3, ms: 250, maxMs: 150 }, { pid: 42, nr: 0, name: 'read', sync: 9, async: 1, ms: 10, maxMs: 10 }],
      procs: [{ pid: 42, cmd: 'claude', firstT: 0, lastT: 300, exited: true }],
    };
    const tr = profileToTrace(p);
    const ev = tr.traceEvents;
    expect(ev.find((e) => e.name === 'long task')).toMatchObject({ ph: 'X', ts: 1_000_010_000, dur: 120_000 });
    expect(ev.find((e) => e.name === 'key char → echo')).toMatchObject({ ph: 'X', dur: 40_000 });
    expect(ev.find((e) => e.name === 'key Enter (no echo)')).toMatchObject({ ph: 'i' });
    const spans = ev.filter((e) => e.cat === 'syscall');
    expect(spans.map((e) => [e.name, e.ts, e.dur])).toEqual([
      ['epoll_wait', 1_000_050_000, 240_000], // started 50 ms in, same call through t=200, read from t=290
      ['read', 1_000_290_000, 110_000],
    ]);
    expect(ev.find((e) => e.name === 'engine lock')).toMatchObject({ ph: 'C', args: { waiters: 1, acquires: 9 } });
    expect(ev.find((e) => e.name === 'process_name' && e.pid === 1042)!.args!.name).toBe('42 claude');
    expect((tr.metadata as any).syscalls).toHaveLength(2);
  });
});
