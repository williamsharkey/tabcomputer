import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import { SIGINT, SIGTERM, SIGKILL, TIMEOUT_EXPIRED_EVENT } from '@shiro/kernel/signals';
import { timeout } from '@shiro/commands/timeout';
import type { Shell } from '@shiro/shell';

// #53: `(timeout 90 node server.js &)` left the server running for good. The
// shell around timeout went away first: its abort reached timeout's controller
// before the job was spawned, so runKernelPipeline's 'abort' listener (attached
// after the spawn) never heard it, and at 90 s timeout's own abort() was a
// no-op on the already-aborted controller.

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
/** The promise's value, or 'still running' after `ms` (the bug: a job nothing stops) */
const within = <T>(p: Promise<T>, ms: number) => Promise.race([p, tick(ms).then(() => 'still running' as const)]);
const abortReason = (extra: object) => Object.assign(new DOMException('The operation was aborted.', 'AbortError'), extra);

/** A kernel program that runs until a signal ends it; `ignore` lists the signals it ignores */
const forever = (ignore: number[] = []) => async (p: any) => {
  for (const sig of ignore) p.dispositions.set(sig, 'ignore');
  return new Promise<number>(() => {});
};

describe('a kernel job and an abort that came first (#53)', () => {
  let shell: Shell;
  beforeEach(async () => { ({ shell } = await createTestShell()); });

  const runJob = async (ignore: number[] = []) => {
    const { runKernelPipeline } = await import('@shiro/shell-kernel');
    return runKernelPipeline(shell, [{ argv: ['server'], run: forever(ignore) }], {
      captureStdout: true, captureStderr: true, writeStdout: () => {}, writeStderr: () => {},
      command: 'server', cwd: '/', env: {},
    });
  };

  it('an abort before the job exists still ends it, with the signal the abort names', async () => {
    const abort = new AbortController();
    abort.abort(abortReason({ signal: SIGTERM, killAfter: 5000 })); // before the spawn, as the race had it
    shell.abortController = abort;
    const r = await within(runJob(), 3000);
    expect(r).not.toBe('still running');
    expect((r as any).exitCode).toBe(128 + SIGTERM);
  });

  it('an abort that lands while the job is being set up (between its awaits) ends it too', async () => {
    const abort = new AbortController();
    shell.abortController = abort;
    const run = runJob();
    queueMicrotask(() => abort.abort()); // the outer shell went away: no reason, so SIGINT
    const r = await within(run, 3000);
    expect(r).not.toBe('still running');
    expect((r as any).exitCode).toBe(128 + SIGINT);
  });

  it("timeout's expiry event reaches a job that outlived the first abort, with -k's SIGKILL after it", async () => {
    // The program is up and ignores SIGINT; then the outer shell's abort (SIGINT)
    // comes, which it survives; then timeout's time runs out on the aborted signal.
    // (An abort before the program is up kills it at once, by default action: the first test.)
    const abort = new AbortController();
    shell.abortController = abort;
    const term = runJob([SIGINT]);
    await tick(50); // its ignore is installed
    abort.abort();
    await tick(50);
    expect(await within(term, 0)).toBe('still running');
    abort.signal.dispatchEvent(new CustomEvent(TIMEOUT_EXPIRED_EVENT, { detail: { signal: SIGTERM, killAfter: 5000 } }));
    expect(((await within(term, 3000)) as any).exitCode).toBe(128 + SIGTERM);

    const abort2 = new AbortController();
    shell.abortController = abort2;
    const stubborn = runJob([SIGINT, SIGTERM]);
    await tick(50);
    abort2.abort();
    await tick(50);
    expect(await within(stubborn, 0)).toBe('still running');
    abort2.signal.dispatchEvent(new CustomEvent(TIMEOUT_EXPIRED_EVENT, { detail: { signal: SIGTERM, killAfter: 100 } }));
    expect(((await within(stubborn, 3000)) as any).exitCode).toBe(128 + SIGKILL);
  });
});

describe("timeout's signal when its controller was aborted already (#53)", () => {
  /** timeout with a stand-in child shell whose COMMAND ends when it hears an abort or the expiry event */
  const runTimeout = async (args: string[], outerAborted: boolean) => {
    const heard: { how: string; signal?: number; killAfter?: number }[] = [];
    const child: any = {
      inheritedAbort: null as AbortController | null,
      cwd: '/',
      setTerminal() {},
      executeWithStdin() {
        const s = child.inheritedAbort!.signal as AbortSignal;
        return new Promise<number>((resolve) => {
          s.addEventListener('abort', () => { heard.push({ how: 'abort', ...(s.reason?.signal ? { signal: s.reason.signal, killAfter: s.reason.killAfter } : {}) }); if (s.reason?.signal) resolve(128 + s.reason.signal); });
          s.addEventListener(TIMEOUT_EXPIRED_EVENT, (e) => { const d = (e as CustomEvent).detail; heard.push({ how: 'expired', signal: d.signal, killAfter: d.killAfter }); resolve(128 + d.signal); });
        });
      },
    };
    const outer = new AbortController();
    if (outerAborted) outer.abort();
    const ctx: any = { args, shell: { fork: () => child, abortController: outer }, env: {}, cwd: '/', stdin: '', stdout: '', stderr: '' };
    const code = await within(timeout.exec(ctx) as Promise<number>, 3000);
    return { code, heard };
  };

  it('still sends its signal (and -k) at the deadline when the shell around it aborted first', async () => {
    const { code, heard } = await runTimeout(['-k', '2', '0.1', 'server'], true);
    expect(code).toBe(124);
    expect(heard).toEqual([{ how: 'expired', signal: SIGTERM, killAfter: 2000 }]);
  });

  it('otherwise aborts as before (the abort carries the signal)', async () => {
    const { code, heard } = await runTimeout(['-s', 'KILL', '0.1', 'server'], false);
    expect(code).toBe(124);
    expect(heard).toEqual([{ how: 'abort', signal: SIGKILL, killAfter: 5000 }]);
  });
});
