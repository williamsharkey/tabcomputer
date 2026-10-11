/**
 * tabcomputer#63: an agent's Bash call is a kernel `sh -c` that exits as soon
 * as its command line is done. A background job it starts (`npx vite &`,
 * `sh -c '…' &`) must outlive it, as an async list outlives a non-interactive
 * bash. Only a signal to the job (its own process group, or `kill $!`) ends
 * it, and that signal reaches just the job's programs, not the agent shell's
 * other jobs. A foreground command still ends with its shell (#53).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import { inPageJobForPid } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { Kernel } from '@shiro/kernel/kernel';
import { Process } from '@shiro/kernel/process';
import { createPipe } from '@shiro/kernel/pipe';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import * as A from '@shiro/kernel/abi';
import type { CommandContext } from '@shiro/commands/index';

const sq = (s: string) => `'${s.replace(/'/g, `'"'"'`)}'`;
/** Claude Code's command line for its Bash tool (from the native binary) */
const claudeWrap = (cmd: string) =>
  `source /home/user/.claude/shell-snapshots/snapshot-bash.sh 2>/dev/null || true && eval ${sq(cmd)} < /dev/null && pwd -P >| /tmp/claude-cwd-63`;

let fs: FileSystem;
let shell: Shell;
let kernel: Kernel;

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
});

/** `sh -c -l CMD` as a kernel process with a stdin pipe that stays open (the Bash tool's spawn) */
async function spawnAgentSh(cmd: string): Promise<{ proc: Process; out: () => string; done: Promise<number>; close: () => void }> {
  const e = { ...shell.env, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const argv = ['/bin/sh', '-c', '-l', cmd];
  const run = await kernel.findProgram('/bin/sh', new Process({ pid: -1, ppid: 1, path: '/bin/sh', argv, env: e, cwd: '/home/user' }));
  const [rd, wr] = createPipe();
  let out = '';
  const proc = kernel.spawn({ path: '/bin/sh', argv, env: e, cwd: '/home/user', fds: { 0: rd, 1: new SinkFile((t) => { out += t; }), 2: new SinkFile((t) => { out += t; }) }, run: run! });
  return { proc, out: () => out, done: proc.wait(), close: () => void wr.close() };
}

/** Run one Bash-tool call to its end */
async function agentSh(cmd: string, ms = 10_000): Promise<{ out: string; status: number | 'hung' }> {
  const a = await spawnAgentSh(claudeWrap(cmd));
  const status = await Promise.race([a.done, new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);
  a.close();
  return { out: a.out(), status };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(path: string, ms = 6000): Promise<string | null> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    if (await fs.exists(path)) return (await fs.readFile(path, 'utf8')) as string;
  }
  return null;
}
async function dir(name: string): Promise<string> {
  const d = `/tmp/bg63-${name}`;
  await fs.rm(d, { recursive: true } as any).catch(() => {});
  await fs.mkdir(d, { recursive: true } as any);
  return d;
}

describe('background jobs outlive the agent shell that started them (#63)', () => {
  it('sh -c "sleep 1; echo ok > f" & : the call returns at once, f appears after its shell is gone', async () => {
    const d = await dir('survive');
    const t0 = Date.now();
    const r = await agentSh(`sh -c "sleep 1; echo ok > ${d}/f" &`);
    expect(r.status).toBe(0);
    expect(Date.now() - t0).toBeLessThan(900); // (it didn't wait for the job)
    expect(await fs.exists(`${d}/f`)).toBe(false);
    expect(await waitFor(`${d}/f`)).toBe('ok\n');
  });

  it('so do ( list ) &, and (timeout 30 cmd &) started from a shell that exits at once', async () => {
    const d = await dir('forms');
    const r = await agentSh(`( sleep 1; echo sub > ${d}/sub ) & (timeout 30 sh -c "sleep 1; echo tmo > ${d}/tmo" &)`);
    expect(r.status).toBe(0);
    expect(await waitFor(`${d}/sub`)).toBe('sub\n');
    expect(await waitFor(`${d}/tmo`)).toBe('tmo\n'); // (not killed with 130 when its parent shell ended)
  });

  it("kill -TERM -- -PID (the job's own process group) still ends it", async () => {
    const d = await dir('group');
    const r = await agentSh(`sh -c "sleep 2; echo late > ${d}/f" & echo $! > ${d}/pid`);
    expect(r.status).toBe(0);
    const pid = Number(await waitFor(`${d}/pid`));
    expect(pid).toBeGreaterThan(0);
    await sleep(300); // (its sh -c is running)
    expect(inPageJobForPid(pid)?.status).toBe('running');
    // (the kill builtin's registry, kernel/signals.ts jobControl, sees the job's group from any shell)
    const { jobControl } = await import('@shiro/kernel/signals');
    expect(jobControl.kill(-pid, 0)).toBe(0);
    // from a new agent call, as every Bash-tool call is a new sh -c
    const k = await agentSh(`kill -TERM -- -${pid}; echo "kill=$?"`);
    expect(k.out).toContain('kill=0');
    await sleep(2500);
    expect(await fs.exists(`${d}/f`)).toBe(false);
    expect(inPageJobForPid(pid)).toBeUndefined();
  });

  it("a job's kernel programs run in the job's group: its signal reaches them, as that signal, and no other job's", async () => {
    const { runKernelPipeline } = await import('@shiro/shell-kernel');
    const opts = { captureStdout: true, captureStderr: true, writeStdout: () => {}, writeStderr: () => {}, command: 'srv', cwd: '/', env: {} };
    /** A background job's shell (executeBackground: jobPgid, its own abort) running one program that never ends */
    const job = (pgid: number) => {
      const sh = shell.fork();
      sh.options.delete('monitor'); // (a job without job control, as an agent's sh -c starts it)
      sh.jobPgid = pgid;
      const abort = new AbortController();
      sh.abortController = abort;
      const got: { proc?: Process; k?: Kernel } = {};
      const run = runKernelPipeline(sh, [{ argv: ['srv'], run: async (p: any, k: any) => { got.proc = p; got.k = k; return new Promise<number>(() => {}); } }], opts);
      return { abort, run, got };
    };
    const reason = (extra: object) => Object.assign(new DOMException('The operation was aborted.', 'AbortError'), extra);
    const a = job(900_001), b = job(900_002), c = job(900_003);
    for (let i = 0; i < 50 && !(a.got.proc && b.got.proc && c.got.proc); i++) await sleep(10);
    expect([a.got.proc?.pgid, b.got.proc?.pgid, c.got.proc?.pgid]).toEqual([900_001, 900_002, 900_003]);
    // kill -TERM $! (signalInPageJob): the job's programs get SIGTERM; the other jobs run on
    a.abort.abort(reason({ signal: A.SIGTERM }));
    expect((await Promise.race([a.run, sleep(3000).then(() => null)]))?.exitCode).toBe(128 + A.SIGTERM);
    expect(await Promise.race([b.run, sleep(150).then(() => 'running')])).toBe('running');
    // kill -- -PGID: the kernel signalled the group itself, the job's abort doesn't send it again
    c.abort.abort(reason({ signal: A.SIGTERM, groupSignalled: 900_003 }));
    expect(await Promise.race([c.run, sleep(150).then(() => 'running')])).toBe('running');
    c.got.k!.kill(-900_003, A.SIGTERM);
    expect((await Promise.race([c.run, sleep(3000).then(() => null)]))?.exitCode).toBe(128 + A.SIGTERM);
    b.got.k!.kill(-900_002, A.SIGKILL);
    await Promise.race([b.run, sleep(3000)]);
  });

  it('a foreground command still ends when its shell is killed (#53)', async () => {
    const d = await dir('fg');
    const a = await spawnAgentSh(claudeWrap(`sh -c "sleep 1.5; echo fg > ${d}/fg"`));
    await sleep(300);
    kernel.kill(a.proc.pid, A.SIGTERM);
    await Promise.race([a.done, sleep(3000)]);
    a.close();
    await sleep(2000);
    expect(await fs.exists(`${d}/fg`)).toBe(false);
  });
});
