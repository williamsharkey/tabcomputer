/**
 * tabcomputer#72: a pipeline headed by a loop, ( … ), { … } or if ran the head
 * to its end before the next element started (its output was the rest's
 * input as one string), so `(echo a; sleep 2; echo b) | while read` saw `a`
 * after 2 s and `while :; do echo y; done | head`-style pipelines never ended.
 * Each element now runs as a subshell that is a kernel process, joined by
 * kernel pipes (Shell.runStreamedPipeline).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell, run } from './helpers';
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

beforeAll(async () => {
  ({ fs, shell } = await createTestShell());
  kernel = kernelForContext({ fs, shell } as unknown as CommandContext);
});

/** `sh -c CMD` as a kernel process (an agent's shell): stdin a pipe never closed; each output chunk with its time */
async function agentSh(cmd: string, opts: { env?: Record<string, string>; ms?: number } = {}) {
  const env = { ...shell.env, ...opts.env };
  const argv = ['/bin/sh', '-c', cmd];
  const runner = await kernel.findProgram('/bin/sh', new Process({ pid: -1, ppid: 1, path: '/bin/sh', argv, env, cwd: '/tmp' }));
  const [rd, wr] = createPipe();
  let out = '';
  const chunks: { t: number; text: string }[] = [];
  const t0 = Date.now();
  const sink = new SinkFile((text) => { out += text; chunks.push({ t: Date.now() - t0, text }); });
  const p = kernel.spawn({ path: '/bin/sh', argv, env, cwd: '/tmp', fds: { 0: rd, 1: sink, 2: sink }, run: runner! });
  const status = await Promise.race([p.wait(), new Promise<'hung'>((r) => setTimeout(() => r('hung'), opts.ms ?? 15_000))]);
  if (status === 'hung') kernel.kill(p.pid, 9);
  await wr.close();
  /** When `text` first appeared in the output (ms), or -1 */
  const at = (text: string) => { let acc = ''; for (const c of chunks) { acc += c.text; if (acc.includes(text)) return c.t; } return -1; };
  return { out: out.replace(/\r\n/g, '\n'), status, at };
}

describe('pipelines headed by a compound stream (#72)', () => {
  it("the next element sees the head's output as it is written", async () => {
    const r = await agentSh('(echo a; sleep 2; echo b) | while read l; do echo "got $l"; done; echo "ps=${PIPESTATUS[*]}"');
    expect(r.status).toBe(0);
    expect(r.out).toBe('got a\ngot b\nps=0 0\n');
    expect(r.at('got a')).toBeLessThan(1500);
    expect(r.at('got b')).toBeGreaterThanOrEqual(1800);
  }, 30_000);

  it('an endless loop ends when its reader does (SIGPIPE: 141)', async () => {
    const r = await agentSh('while :; do echo y; done | while read l; do echo "got $l"; break; done; echo "ps=${PIPESTATUS[*]}"');
    expect(r.status).toBe(0);
    expect(r.out).toBe('got y\nps=141 0\n');
  }, 30_000);

  it('timeout stops a streamed pipeline, and only it', async () => {
    const r = await agentSh("timeout 1 sh -c '(sleep 5; echo x) | cat'; echo \"rc=$?\"; echo after");
    expect(r.status).toBe(0);
    expect(r.out).toBe('rc=124\nafter\n');
  }, 30_000);

  it('subshell semantics: variables and functions in, nothing out', async () => {
    const r = await agentSh('v=7; f() { echo "fn $1"; }; (echo "v=$v"; f z; v=8) | cat; for i in 1 2; do w=$i; done | cat; echo "v=$v w=${w-unset}"');
    expect(r.out).toBe('v=7\nfn z\nv=7 w=unset\n');
  }, 30_000);

  it('command substitution, a reading group, redirects, pipefail', async () => {
    const r = await agentSh([
      'x=$(for i in 1 2 3; do echo $i; done | tail -1); echo "subst=$x"',
      'for i in 1 2 3; do echo $i; done | { read a; read b; echo "group $a $b"; }',
      'for i in 1 2; do echo $i; done | wc -l > /tmp/stream-wc; echo "redir=$(cat /tmp/stream-wc)"',
      'set -o pipefail; (exit 3) | cat; echo "pf=$? ps=${PIPESTATUS[*]}"',
    ].join('; '));
    expect(r.out).toBe('subst=3\ngroup 1 2\nredir=2\npf=3 ps=3 0\n');
  }, 30_000);

  it('a lot of output through a slow reader arrives whole (the writer waits on a full pipe)', async () => {
    const r = await agentSh('(i=0; while [ $i -lt 3000 ]; do echo "line $i 0123456789012345678901234567890123456789"; i=$((i+1)); done) | (sleep 1; wc -l)');
    expect(r.out.trim()).toBe('3000');
  }, 60_000);

  it('TABCOMPUTER_STREAM_PIPES=0 keeps the old way (the head runs to its end first)', async () => {
    const r = await agentSh('(echo a; sleep 2; echo b) | while read l; do echo "got $l"; done', { env: { TABCOMPUTER_STREAM_PIPES: '0' } });
    expect(r.out).toBe('got a\ngot b\n');
    expect(r.at('got a')).toBeGreaterThanOrEqual(1800);
  }, 30_000);

  it("sleep 2 | sh -c 'echo started': the rest runs while the sleep does", async () => {
    const r = await agentSh("sleep 2 | sh -c 'echo started'; echo \"ps=${PIPESTATUS[*]}\"");
    expect(r.status).toBe(0);
    expect(r.out).toBe('started\nps=0 0\n');
    expect(r.at('started')).toBeLessThan(1500);
    expect(r.at('ps=')).toBeGreaterThanOrEqual(1800); // the pipeline still lasts as long as the sleep
    // in the page shell, and with a sleep in the middle
    const chunks: { t: number; text: string }[] = [];
    const t0 = Date.now();
    const code = await shell.execute('echo in | sleep 2 | echo out; echo "rc=$? ps=${PIPESTATUS[*]}"', (s) => { chunks.push({ t: Date.now() - t0, text: s }); });
    expect(code).toBe(0);
    expect(chunks.map((c) => c.text).join('').replace(/\r\n/g, '\n')).toBe('out\nrc=0 ps=0 0 0\n');
    expect(chunks.find((c) => c.text.includes('out'))!.t).toBeLessThan(1500);
    // the old way with the escape hatch
    const old = await agentSh("sleep 2 | sh -c 'echo started'", { env: { TABCOMPUTER_STREAM_PIPES: '0' } });
    expect(old.out).toBe('started\n');
    expect(old.at('started')).toBeGreaterThanOrEqual(1800);
  }, 30_000);

  it('pipelines the sleep rule leaves alone: read at the end, a sleep at the end, a function, a quoted |', async () => {
    const r = await run(shell, [
      'sleep 0.1 | read v; echo "read rc=$?"',
      'echo a | sleep 0.1; echo "tail rc=$?"',
      'sleep() { echo "my sleep $*"; }; sleep 5 | cat; unset -f sleep',
      'echo "sleep 9 | x"',
      'sleep 0.1 | cat; echo "ps=${PIPESTATUS[*]}"',
      'sleep 0.1 | false; echo "rc=$?"',
    ].join('\n'));
    expect(r.output.replace(/\r\n/g, '\n')).toBe('read rc=1\ntail rc=0\nmy sleep 5\nsleep 9 | x\nps=0 0\nrc=1\n');
  }, 30_000);

  it('in the page shell too', async () => {
    const { output, exitCode } = await run(shell, 'for i in 1 2 3; do echo $i; done | tail -1; (echo p; echo q) | tac');
    expect(exitCode).toBe(0);
    expect(output.replace(/\r\n/g, '\n')).toBe('3\nq\np\n');
  }, 30_000);
});
