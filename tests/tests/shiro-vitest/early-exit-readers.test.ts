/**
 * head, grep -m/-q/-l/--line-buffered and sed with a q read stdin only as far
 * as they need (ctx.stdinStream, src/commands/stdin-stream.ts). On a stream
 * they stop, their process closes the pipe, and an endless writer gets SIGPIPE:
 * `while :; do echo y; done | head -1` ends (the #72 follow-up). The pipelines
 * here run in a shell that is a kernel process (an agent's `sh -c`), where a
 * loop-headed pipeline streams (Shell.runStreamedPipeline).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import type { Kernel } from '@shiro/kernel/kernel';
import type { CommandContext } from '@shiro/commands/index';
import { Process } from '@shiro/kernel/process';
import { createPipe } from '@shiro/kernel/pipe';
import { SinkFile } from '@shiro/wasi/stdio';
import { kernelForContext } from '@shiro/wasi/run-command';
import { takeStdinLines, takeStdinBytes } from '@shiro/commands/stdin-stream';

let fs: FileSystem;
let shell: Shell;
let kernel: Kernel;

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
  await fs.writeFile('/tmp/four', 'l1\nl2\nl3\nl4\n');
});

/** `sh -c CMD` as a kernel process, stdin a pipe that stays open; output and when the first of `mark` appeared */
async function agentSh(cmd: string, ms = 15_000) {
  const argv = ['/bin/sh', '-c', cmd];
  const env = { ...shell.env };
  const runner = await kernel.findProgram('/bin/sh', new Process({ pid: -1, ppid: 1, path: '/bin/sh', argv, env, cwd: '/tmp' }));
  const [rd, wr] = createPipe();
  let out = '';
  const times: { t: number; text: string }[] = [];
  const t0 = Date.now();
  const sink = new SinkFile((text) => { out += text; times.push({ t: Date.now() - t0, text }); });
  const p = kernel.spawn({ path: '/bin/sh', argv, env, cwd: '/tmp', fds: { 0: rd, 1: sink, 2: sink }, run: runner! });
  const status = await Promise.race([p.wait(), new Promise<'hung'>((r) => setTimeout(() => r('hung'), ms))]);
  if (status === 'hung') kernel.kill(p.pid, 9);
  await wr.close();
  const at = (s: string) => { let acc = ''; for (const c of times) { acc += c.text; if (acc.includes(s)) return c.t; } return -1; };
  return { out: out.replace(/\r\n/g, '\n'), status, ms: Date.now() - t0, at };
}

describe('readers that stop early end an endless writer', () => {
  it.each([
    ['while :; do echo y; done | head -1; echo "ps=${PIPESTATUS[*]}"', 'y\nps=141 0\n'],
    ['while :; do echo y; done | head -c 3; echo', 'y\ny\n'],
    ['i=0; while :; do i=$((i+1)); echo $i; done | grep -m1 5; echo "ps=${PIPESTATUS[*]}"', '5\nps=141 0\n'],
    ['while :; do echo z; done | grep -q z; echo "q=$? ps=${PIPESTATUS[*]}"', 'q=0 ps=141 0\n'],
    ['while :; do echo y; done | grep -l y', '(standard input)\n'],
    ['while :; do echo y; done | sed 2q', 'y\ny\n'],
    ["while :; do echo y; done | sed -n '1p;1q'", 'y\n'],
    ['yes | head -3', 'y\ny\ny\n'],
    ['seq 1 1000000 | grep -m1 5', '5\n'],
  ])('%s', async (cmd, want) => {
    const r = await agentSh(cmd);
    expect(r.status).toBe(0);
    expect(r.out).toBe(want);
    expect(r.ms).toBeLessThan(10_000);
  }, 30_000);

  it('grep --line-buffered passes lines on as they arrive', async () => {
    const r = await agentSh('(echo a; sleep 2; echo b) | grep --line-buffered . | while read l; do echo "got $l"; done');
    expect(r.out).toBe('got a\ngot b\n');
    expect(r.at('got a')).toBeLessThan(1500);
  }, 30_000);
});

describe('the same results as reading everything', () => {
  it.each([
    ['cat /tmp/four | head -2', 'l1\nl2\n'],
    ['cat /tmp/four | head -n -1', 'l1\nl2\nl3\n'],
    ['cat /tmp/four | head -c 4', 'l1\nl'],
    ['cat /tmp/four | head -0; echo rc=$?', 'rc=0\n'],
    ["printf 'x\\ny' | head -5", 'x\ny'],
    ['cat /tmp/four | grep -c l', '4\n'],
    ['cat /tmp/four | grep -m2 -A1 l', 'l1\nl2\nl3\n'],
    ['cat /tmp/four | grep -n -m1 l3', '3:l3\n'],
    ['cat /tmp/four | grep -v -m1 l1', 'l2\n'],
    ["printf '' | grep -m1 x; echo rc=$?", 'rc=1\n'],
    ['cat /tmp/four | sed -n 2p', 'l2\n'],
    ['cat /tmp/four | sed 3q', 'l1\nl2\nl3\n'],
    ['cat /tmp/four | sed "/l2/q"', 'l1\nl2\n'],
    ["cat /tmp/four | sed -n '$p'", 'l4\n'],
    ['for i in 1 2 3; do echo $i; done | head -2', '1\n2\n'],
    ['for i in 1 2 3; do echo $i; done | sed -n 3p', '3\n'],
  ])('%s', async (cmd, want) => {
    const r = await agentSh(cmd);
    expect(r.out).toBe(want);
  }, 30_000);
});

describe('takeStdinLines / takeStdinBytes', () => {
  const enc = new TextEncoder();
  function streamCtx(chunks: string[]) {
    const q = chunks.map((c) => enc.encode(c));
    const ctx = { stdin: '', stdinStream: { read: async () => q.shift() ?? null } } as unknown as CommandContext;
    return { ctx, left: () => q.length };
  }

  it('stops reading once enough lines are complete; a line split across chunks is one line', async () => {
    const { ctx, left } = streamCtx(['a\nb', 'b\nc\n', 'd\n', 'e\n']);
    let seen = 0;
    const batches: string[][] = [];
    expect(await takeStdinLines(ctx, (lines) => { batches.push(lines); return (seen += lines.length) >= 2; })).toBe(true);
    expect(batches).toEqual([['a'], ['bb', 'c']]);
    expect(ctx.stdin).toBe('a\nbb\nc\n');
    expect(left()).toBe(2);
  });

  it('a last line without a newline at EOF; multibyte text across chunks', async () => {
    const bytes = enc.encode('héllo\nwörld');
    const { ctx } = streamCtx([]);
    const q = [bytes.subarray(0, 2), bytes.subarray(2, 9), bytes.subarray(9)];
    ctx.stdinStream = { read: async () => q.shift() ?? null };
    const lines: string[] = [];
    await takeStdinLines(ctx, (ls) => { lines.push(...ls); return false; });
    expect(lines).toEqual(['héllo', 'wörld']);
    expect(ctx.stdin).toBe('héllo\nwörld');
  });

  it('bytes: at least n, then stop; no stream: false', async () => {
    const { ctx, left } = streamCtx(['ab', 'cd', 'ef']);
    expect(await takeStdinBytes(ctx, 3)).toBe(true);
    expect(ctx.stdin).toBe('abcd');
    expect(left()).toBe(1);
    expect(await takeStdinLines({ stdin: 'x' } as unknown as CommandContext, () => true)).toBe(false);
  });
});
