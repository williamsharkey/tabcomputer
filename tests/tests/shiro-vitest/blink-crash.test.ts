/**
 * A Blink engine that dies (a wasm trap, an abort, a worker killed from
 * outside) ends its kernel processes with a signal status, so whoever waits
 * for them wakes: a fork child that died inside Blink before exec used to
 * stay "running", and its parent's wait4 hung (debian's forkmaps repro).
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll } from 'vitest';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { workerRunner, type GuestWorker } from '@shiro/kernel/worker-host';
import { wireWorker, blinkCrashSignal, ABORT_GRACE_MS } from '@shiro/x86-engine/blink';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';
import type { Process } from '@shiro/kernel/process';
import { createTestShell } from './helpers';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const forever = () => new Promise<number>(() => {});

/** A GuestWorker whose events the test fires */
function fakeWorker() {
  let message: (m: unknown) => void = () => {};
  let error: (e: unknown) => void = () => {};
  let exit: (c: number) => void = () => {};
  const w: GuestWorker & { send: typeof message; fail: typeof error; vanish: typeof exit; terminated: boolean } = {
    postMessage() {}, terminated: false,
    terminate() { w.terminated = true; },
    onMessage: (cb) => { message = cb; }, onError: (cb) => { error = cb; }, onExit: (cb) => { exit = cb; },
    send: (m) => message(m), fail: (e) => error(e), vanish: (c) => exit(c),
  };
  return w;
}

describe('Blink engine crashes: the processes die of a signal', () => {
  it('classifies the crash: an abort is SIGABRT, a trap or any other engine error SIGSEGV', () => {
    expect(blinkCrashSignal(new Error('Aborted(Assertion failed: pt & PAGE_V)'))).toBe(A.SIGABRT);
    expect(blinkCrashSignal('aborted: native code called abort()')).toBe(A.SIGABRT);
    expect(blinkCrashSignal(new WebAssembly.RuntimeError('memory access out of bounds'))).toBe(A.SIGSEGV);
    expect(blinkCrashSignal(new Error('unreachable'))).toBe(A.SIGSEGV);
  });

  it('a worker error or a vanished worker ends the process with SIGSEGV / SIGKILL (workerRunner), and its parent\'s wait4 returns', async () => {
    const kernel = new Kernel({ registerWithProcessTable: false });
    const parent = kernel.spawn({ path: 'parent', cwd: '/', run: forever });
    for (const [how, sig] of [['error', A.SIGSEGV], ['vanish', A.SIGKILL]] as const) {
      const w = fakeWorker();
      const child = kernel.spawn({ path: 'child', cwd: '/', parent,
        run: workerRunner(() => w, { crashStatus: blinkCrashSignal, vanishedStatus: A.SIGKILL }) });
      const data = new Uint8Array(16);
      const waiting = kernel.syscall(parent, A.SYS_wait4, [child.pid, 0, 0, 0], data);
      await tick(5);
      if (how === 'error') w.fail(new WebAssembly.RuntimeError('memory access out of bounds'));
      else w.vanish(1);
      expect(await waiting).toBe(child.pid);
      const st = new DataView(data.buffer).getInt32(0, true);
      expect(A.WIFSIGNALED?.(st) ?? (st & 0x7f) !== 0).toBe(true);
      expect(st & 0x7f).toBe(sig);
    }
    // exec: the kernel ends the old image's worker while the process goes on in the next one;
    // that worker's exit (or a late error) must not kill the new program
    const w = fakeWorker();
    const proc = kernel.spawn({ path: 'sh', cwd: '/', parent,
      run: workerRunner(() => w, { crashStatus: blinkCrashSignal, vanishedStatus: A.SIGKILL }) });
    await tick(5);
    proc.data.execRunner = forever;
    proc.stopRunner();
    expect(w.terminated).toBe(true);
    w.vanish(1);
    w.fail(new Error('late'));
    await tick(10);
    expect(proc.state).toBe('running');
    await kernel.exit(proc, 0);
  });

  it('blink-abort: the guest\'s own exit_group then ends it with SIGABRT; an engine that never gets there is ended a second later', async () => {
    const kernel = new Kernel({ registerWithProcessTable: false });
    const statusOf = (p: Process) => p.wait();
    // the engine prints and exits (host.mjs fail: exit_group(134))
    const a = kernel.spawn({ path: 'a', cwd: '/', run: forever });
    const wa = fakeWorker();
    wireWorker(a, wa, kernel, []);
    const aDone = statusOf(a);
    wa.send({ type: 'blink-abort', text: 'aborted: Assertion failed' });
    expect(a.exiting).toBeFalsy(); // (its stderr line still goes out)
    await kernel.syscall(a, A.SYS_exit_group, [134], new Uint8Array(8));
    expect(await aDone).toBe(A.SIGABRT);
    // the engine wedges after the abort: the kernel ends it
    const b = kernel.spawn({ path: 'b', cwd: '/', run: forever });
    const wb = fakeWorker();
    wireWorker(b, wb, kernel, []);
    const hosted = kernel.vfork(b);
    wb.send({ type: 'blink-hosted', pid: hosted.pid });
    const bDone = statusOf(b);
    const t0 = Date.now();
    wb.send({ type: 'blink-abort', text: 'aborted: pt & PAGE_V' });
    await tick(10);
    expect(await hosted.wait()).toBe(A.SIGABRT);
    expect(await bDone).toBe(A.SIGABRT);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(ABORT_GRACE_MS - 50);
  });

  it('a worker that ends without the kernel ending it takes the children it hosted with it (SIGKILL)', async () => {
    const kernel = new Kernel({ registerWithProcessTable: false });
    const p = kernel.spawn({ path: 'p', cwd: '/', run: forever });
    const w = fakeWorker();
    wireWorker(p, w, kernel, []);
    const c = kernel.vfork(p);
    w.send({ type: 'blink-hosted', pid: c.pid });
    w.vanish(1);
    await tick(10);
    expect(c.state).toBe('zombie');
    expect(c.exitStatus).toBe(A.SIGKILL);
    // a worker the kernel ended on purpose (the process exited) leaves a hosted daemon() child running
    const q = kernel.spawn({ path: 'q', cwd: '/', run: forever });
    const wq = fakeWorker();
    wireWorker(q, wq, kernel, []);
    const d = kernel.vfork(q);
    wq.send({ type: 'blink-hosted', pid: d.pid });
    await kernel.exit(q, 0);
    wq.terminate(); // (deferred while it hosts d)
    expect(d.state).toBe('running');
    await kernel.exit(d, 0);
    await tick(600); // terminateWhenQuiet
    wq.vanish(0);
    await tick(10);
    expect(d.exitStatus).toBe(0);
  });
});

// Real Blink: a fork child blocked for good, whose engine dies under it
const FIX = resolve(__dirname, 'fixtures/x86');
const out = mkdtempSync(join(tmpdir(), 'shiro-blink-crash-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));
const bin = join(out, 'crashwait');
let haveBin = false;
try { execFileSync('gcc', ['-static', '-O1', '-o', bin, 'crashwait.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 }); haveBin = true; } catch { /* no gcc */ }

describe.skipIf(!haveBin)('Blink engine crashes: a real fork child', () => {
  const start = async (env: string) => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', readFileSync(bin), { mode: 0o755 });
    await shell.execute('cd /home/user/work', () => {});
    const kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
    let output = '';
    const done = shell.execute(`${env} ./prog`, (s: string) => { output += s; });
    // the child, blocked in its read
    let child: Process | undefined;
    for (let i = 0; i < 600 && !child; i++) {
      const m = /child (\d+)/.exec(output);
      const c = m ? kernel.procs.get(Number(m[1])) : undefined;
      if (c && c.inSyscall > 0) child = c;
      else await tick(50);
    }
    expect(child, output).toBeDefined();
    return { kernel, child: child!, done, output: () => output.replace(/\r\n/g, '\n') };
  };

  it("its own worker (BLINK_SAME_INSTANCE_FORK=0) traps: the child dies of SIGSEGV and the parent's waitpid says so", async () => {
    const { child, done, output } = await start('BLINK_SAME_INSTANCE_FORK=0');
    const native = (child.data.worker as GuestWorker | undefined)?.native as { emit(e: string, err: unknown): void } | undefined;
    expect(native).toBeDefined();
    native!.emit('error', new WebAssembly.RuntimeError('memory access out of bounds'));
    expect(await done).toBe(0);
    expect(output()).toContain(`child signal ${A.SIGSEGV}\n`);
  }, 90_000);

  it("its own worker killed from outside: the child dies of SIGKILL and the parent's waitpid returns", async () => {
    const { child, done, output } = await start('BLINK_SAME_INSTANCE_FORK=0');
    const native = (child.data.worker as GuestWorker | undefined)?.native as { terminate(): unknown } | undefined;
    void native!.terminate();
    expect(await done).toBe(0);
    expect(output()).toContain(`child signal ${A.SIGKILL}\n`);
  }, 90_000);

  it('a hosted child (same-instance fork, the default): the parent\'s worker killed ends both, and the shell gets the status', async () => {
    const { kernel, child, done } = await start('');
    const parent = kernel.procs.get(child.ppid)!;
    expect(child.data.worker).toBeUndefined(); // it runs in the parent's engine
    const native = (parent.data.worker as GuestWorker | undefined)?.native as { terminate(): unknown } | undefined;
    void native!.terminate();
    expect(await done).toBe(128 + A.SIGKILL);
    await tick(50);
    expect(child.state).toBe('zombie');
    expect(child.exitStatus).toBe(A.SIGKILL);
  }, 90_000);
});
