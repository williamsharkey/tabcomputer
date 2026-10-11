/**
 * #53: `(timeout 90 node server.mjs > srv.log 2>&1 &)` from an agent's `sh -c`.
 * The background job outlives the shell that started it (bash leaves an async
 * list alone when its shell exits), timeout still ends it on time, and what it
 * writes reaches the redirected file as it's written. And output an in-page
 * shell wrote before timeout or Ctrl-C stopped it is kept.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { Kernel } from '@shiro/kernel/kernel';
import { Process } from '@shiro/kernel/process';
import { createPipe } from '@shiro/kernel/pipe';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';

let fs: FileSystem;
let shell: Shell;
let kernel: Kernel;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));
const size = async (p: string) => { try { return String(await fs.readFile(p, 'utf8')).length; } catch { return -1; } };

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
  // (a script, not node: the in-page node of the tests exits once only timers are left)
  await fs.writeFile('/tmp/loop.sh', 'n=0; while :; do echo tick $n; n=$((n+1)); sleep 0.1; done\n');
  await fs.writeFile('/tmp/up.js', 'require("http").createServer((q, s) => s.end("ok")).listen(+process.argv[2], () => console.log("up"));\n');
});

async function run(cmd: string, abortAfter?: number): Promise<{ out: string; status: number }> {
  let out = '';
  if (abortAfter) setTimeout(() => shell.abortController?.abort(), abortAfter);
  const status = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), status };
}

/** `sh -c CMD` as a kernel process, as an agent's Bash tool runs it */
async function agentSh(cmd: string): Promise<number> {
  const env = { ...shell.env, PATH: '/usr/local/bin:/usr/bin:/bin' };
  const argv = ['/bin/sh', '-c', cmd];
  const prog = await kernel.findProgram('/bin/sh', new Process({ pid: -1, ppid: 1, path: '/bin/sh', argv, env, cwd: '/tmp' }));
  const [rd, wr] = createPipe();
  const proc = kernel.spawn({ path: '/bin/sh', argv, env, cwd: '/tmp', fds: { 0: rd, 1: new SinkFile(() => {}), 2: new SinkFile(() => {}) }, run: prog! });
  const status = await proc.wait();
  void wr.close();
  return status;
}

describe('(timeout N cmd > log 2>&1 &) (#53)', () => {
  it('outlives the shell that started it, logs as it goes, and stops at N seconds', async () => {
    const t0 = Date.now();
    expect(await agentSh('(timeout 2 sh /tmp/loop.sh > /tmp/a.log 2>&1 &); timeout 2 sh /tmp/loop.sh > /tmp/b.log 2>&1 &')).toBe(0);
    expect(Date.now() - t0).toBeLessThan(1000);
    await tick(1000);
    // running after its shell ended, and its output is in the file already
    for (const f of ['/tmp/a.log', '/tmp/b.log']) expect(await size(f)).toBeGreaterThan(20);
    await tick(2000);
    const done = [await size('/tmp/a.log'), await size('/tmp/b.log')];
    await tick(700);
    expect([await size('/tmp/a.log'), await size('/tmp/b.log')]).toEqual(done);
  }, 30_000);

  it("a node program's console.log reaches the file while it runs", async () => {
    expect(await agentSh('(timeout 5 node /tmp/up.js 5431 > /tmp/n.log 2>&1 &)')).toBe(0);
    await tick(2000);
    expect(String(await fs.readFile('/tmp/n.log', 'utf8'))).toBe('up\n');
  }, 30_000);

  it('Ctrl-C does not reach a background job, and the shell exiting leaves it running', async () => {
    const r = await run('sh /tmp/loop.sh > /tmp/c.log & sleep 5', 300);
    expect(r.status).toBe(130);
    const before = await size('/tmp/c.log');
    await tick(500);
    expect(await size('/tmp/c.log')).toBeGreaterThan(before);
    await run('kill %1; wait');
  }, 30_000);
});

describe('what an in-page shell wrote before it was stopped', () => {
  it.each([
    ["timeout 1 sh -c 'echo a; sleep 3'; echo rc=$?", 'a\nrc=124\n'],
    ["x=$(timeout 1 sh -c 'echo a; sleep 3'); echo x=$x", 'x=a\n'],
    ["timeout 1 sh /tmp/loop.sh | head -2", 'tick 0\ntick 1\n'],
    ["timeout 1 sh /tmp/loop.sh > /tmp/t.log; echo rc=$?; head -2 /tmp/t.log", 'rc=124\ntick 0\ntick 1\n'],
  ])('%s', async (cmd, want) => {
    expect((await run(cmd)).out).toBe(want);
  }, 30_000);

  it('Ctrl-C keeps what sh -c printed', async () => {
    expect(await run("sh -c 'echo a; sleep 3; echo b'", 400)).toEqual({ out: 'a\n', status: 130 });
  }, 30_000);
});
