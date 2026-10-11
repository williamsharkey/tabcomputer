/**
 * tabcomputer#66: node read a stdin pipe to EOF before the script's first
 * line when its source mentioned readFileSync(0) / '/dev/stdin' /
 * readSync(0, ...) (even in a branch that never runs), so `producer | node
 * x.js` started only when the producer ended, and on a pipe that stays open
 * (an agent's shell) it never started. A guest in a Worker now reads fd 0
 * when the script reads it, blocking then.
 * Also: process.exit() in a stdin 'data' listener printed "Error: process.exit(0)";
 * then it waited for the next read, which a pipe that stays open never answers
 * (repro 4 hung): a read still waiting for input doesn't hold an exit (STDIN_HOLD).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { Kernel } from '@shiro/kernel/kernel';
import { Process } from '@shiro/kernel/process';
import { createPipe } from '@shiro/kernel/pipe';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import type { CommandContext } from '@shiro/commands/index';

const enc = new TextEncoder();

describe('node as a guest: stdin read when the script reads it', () => {
  let cleanup: () => void;
  let fs: FileSystem;
  let shell: Shell;
  let kernel: Kernel;

  beforeAll(async () => {
    cleanup = await installNodeWorker();
    ({ fs, shell } = await createTestShell());
    kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
    // #66's scripts: one that only mentions stdin, one that reads it
    await fs.writeFile('/tmp/mention.cjs', 'console.log("start");\nif (process.argv.length > 99) require("fs").readFileSync(0);\n');
    await fs.writeFile('/tmp/reads.cjs', 'console.log("start");\nconsole.log("got " + JSON.stringify(require("fs").readFileSync(0, "utf8")));\n');
    await fs.writeFile('/tmp/devstdin.mjs', 'import { readFileSync } from "node:fs";\nconsole.log("start");\nif (process.argv[2] === "read") console.log("got " + readFileSync("/dev/stdin", "utf8").length);\n');
  }, 120_000);
  afterAll(() => cleanup?.());

  /** `sh -c CMD` as a kernel process on a stdin pipe: `input` written, closed only if `close` (an agent's shell never closes it) */
  async function agentSh(cmd: string, opts: { input?: string; close?: boolean; closeAfterMs?: number; ms?: number } = {}) {
    const env = { ...shell.env, TABCOMPUTER_NODE_WORKER: '1' };
    const argv = ['/bin/sh', '-c', cmd];
    const run = await kernel.findProgram('/bin/sh', new Process({ pid: -1, ppid: 1, path: '/bin/sh', argv, env, cwd: '/tmp' }));
    const [rd, wr] = createPipe();
    let out = '';
    const firstOut: number[] = [];
    const t0 = Date.now();
    const p = kernel.spawn({
      path: '/bin/sh', argv, env, cwd: '/tmp', run: run!,
      fds: { 0: rd, 1: new SinkFile((t) => { if (!out) firstOut.push(Date.now() - t0); out += t; }), 2: new SinkFile((t) => { out += t; }) },
    });
    if (opts.input) await wr.write(enc.encode(opts.input));
    if (opts.close) await wr.close();
    if (opts.closeAfterMs) setTimeout(() => void wr.close(), opts.closeAfterMs);
    const status = await Promise.race([p.wait(), new Promise<'hung'>((r) => setTimeout(() => r('hung'), opts.ms ?? 20_000))]);
    if (status === 'hung') kernel.kill(p.pid, 9);
    await wr.close();
    return { out: out.replace(/\r\n/g, '\n'), status, firstOutMs: firstOut[0] ?? -1 };
  }

  it('a script that only mentions readFileSync(0) runs and ends on a pipe that stays open (#66 repro 2)', async () => {
    const r = await agentSh('node /tmp/mention.cjs');
    expect(r.status).toBe(0);
    expect(r.out).toBe('start\n');
  }, 60_000);

  it('the same with readFileSync("/dev/stdin") in an ES module', async () => {
    const r = await agentSh('node /tmp/devstdin.mjs');
    expect(r.status).toBe(0);
    expect(r.out).toBe('start\n');
  }, 60_000);

  it('a script that reads stdin starts before the pipe ends, then gets all of it', async () => {
    const r = await agentSh('node /tmp/reads.cjs', { input: 'x\n', closeAfterMs: 3000 });
    expect(r.status).toBe(0);
    expect(r.out).toBe('start\ngot "x\\n"\n');
    expect(r.firstOutMs).toBeLessThan(2500); // "start" before the writer closed
  }, 60_000);

  it('readSync(0) in a loop reads the whole pipe', async () => {
    const r = await agentSh(`node -e 'const fs = require("fs"); const b = Buffer.alloc(3); let s = "", n; while ((n = fs.readSync(0, b, 0, 3)) > 0) s += b.toString("utf8", 0, n); console.log(JSON.stringify(s))'`, { input: 'hello world\n', close: true });
    expect(r.status).toBe(0);
    expect(r.out).toBe('"hello world\\n"\n');
  }, 60_000);

  it('process.exit(0) in a data listener exits 0 with no error (#66 repro 4)', async () => {
    const r = await agentSh(`node -e 'process.stdin.once("data", () => process.exit(0))'`, { input: 'hi\n' });
    expect(r.status).toBe(0);
    expect(r.out).toBe('');
  }, 60_000);

  it.each([
    ['a timer exits while a data listener waits', `node -e 'process.stdin.on("data", () => {}); setTimeout(() => { console.log("bye"); process.exit(0); }, 300)'`],
    ['a timer exits while a second fs.read(0) waits', `node -e 'const fs = require("fs"), b = Buffer.alloc(9); fs.read(0, b, 0, 9, null, () => fs.read(0, b, 0, 9, null, () => {})); setTimeout(() => { console.log("bye"); process.exit(0); }, 300)'`],
    ['exit() in a data listener that stays on', `node -e 'process.stdin.on("data", () => { console.log("bye"); process.exit(0); })'`],
  ])('%s, on a pipe that stays open: the exit ends it', async (_name, cmd) => {
    const r = await agentSh(cmd, { input: 'hi\n' });
    expect(r.status).toBe(0);
    expect(r.out).toBe('bye\n');
  }, 60_000);
});
