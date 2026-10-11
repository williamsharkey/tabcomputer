/**
 * tabcomputer#61: nohup was a stub (it logged the command line to nohup.out and
 * never ran the command). Now it runs COMMAND with SIGHUP ignored, appends
 * its output to nohup.out when that would go to the terminal, and exits with
 * COMMAND's status.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { SIGHUP, SIGTERM } from '@shiro/kernel/signals';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('nohup (#61)', () => {
  let shell: Shell;
  let fs: FileSystem;
  const text = async (p: string) => fs.readFile(p, 'utf8') as Promise<string>;

  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    await fs.rm('/tmp/nh61', { recursive: true } as any).catch(() => {});
    await fs.mkdir('/tmp/nh61', { recursive: true } as any);
    await run(shell, 'cd /tmp/nh61');
  });

  it('runs the command, its output (stdout and stderr) appended to nohup.out', async () => {
    const r = await run(shell, `nohup sh -c 'echo out; echo err >&2; touch ran.flag'`);
    expect(r.exitCode).toBe(0);
    expect(await fs.exists('/tmp/nh61/ran.flag')).toBe(true); // (the stub never ran it)
    expect(r.output).toContain("appending output to 'nohup.out'");
    expect(r.output).not.toContain('out\n'); // (not on the terminal)
    expect(await text('/tmp/nh61/nohup.out')).toBe('out\nerr\n');
    // appended, as GNU's
    await run(shell, `nohup echo again`);
    expect(await text('/tmp/nh61/nohup.out')).toBe('out\nerr\nagain\n');
  });

  it("exits with the command's status: 7, and 127 for a missing command", async () => {
    expect((await run(shell, `nohup sh -c 'exit 7'; echo "rc=$?"`)).output).toContain('rc=7');
    expect((await run(shell, `nohup no-such-command-61; echo "rc=$?"`)).output).toContain('rc=127');
    expect((await run(shell, `nohup true; echo "rc=$?"`)).output).toContain('rc=0');
  });

  it('with stdout redirected there is no nohup.out: the output goes where it was sent', async () => {
    const r = await run(shell, `nohup sh -c 'echo redirected' > out.txt; cat out.txt`);
    expect(r.output).toContain('redirected');
    expect(await text('/tmp/nh61/out.txt')).toBe('redirected\n');
    expect(await fs.exists('/tmp/nh61/nohup.out')).toBe(false);
    expect(r.output).not.toContain('appending output');
  });

  it('nohup … & keeps running in the background, its output arriving in nohup.out as it is written', async () => {
    await run(shell, `nohup sh -c 'echo first; sleep 0.4; echo second' &`);
    let now = '';
    for (let i = 0; i < 30 && !now.includes('first'); i++) { await tick(50); now = await text('/tmp/nh61/nohup.out').catch(() => ''); }
    expect(now).toBe('first\n'); // (before the command ended)
    for (let i = 0; i < 60 && !now.includes('second'); i++) { await tick(50); now = await text('/tmp/nh61/nohup.out').catch(() => ''); }
    expect(now).toBe('first\nsecond\n');
  });

  it("a shell's ignored signals reach the programs it starts: SIGHUP doesn't end them, SIGTERM does", async () => {
    const { runKernelPipeline } = await import('@shiro/shell-kernel');
    const child = shell.fork();
    child.ignoredSignals = new Set([SIGHUP]);
    expect(child.fork().ignoredSignals.has(SIGHUP)).toBe(true); // (inherited)
    let started: { pgid: number; kill: (pid: number, sig: number) => number } | null = null;
    const job = runKernelPipeline(child, [{
      argv: ['server'],
      run: async (p: any, k: any) => { started = { pgid: p.pgid, kill: (pid, sig) => k.kill(pid, sig) }; return new Promise<number>(() => {}); },
    }], { captureStdout: true, captureStderr: true, writeStdout: () => {}, writeStderr: () => {}, command: 'server', cwd: '/', env: {} });
    for (let i = 0; i < 40 && !started; i++) await tick(10);
    expect(started).not.toBeNull();
    started!.kill(-started!.pgid, SIGHUP);
    const after = await Promise.race([job, tick(150).then(() => 'still running' as const)]);
    expect(after).toBe('still running');
    started!.kill(-started!.pgid, SIGTERM);
    expect(((await Promise.race([job, tick(3000).then(() => null)])) as any)?.exitCode).toBe(128 + SIGTERM);
  });
});
