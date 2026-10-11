/**
 * execve from a multithreaded x86 program under Blink: Linux ends the other
 * threads and the new image starts alone. Claude Code's renderer switch
 * relaunches itself with process.execve from a Bun process with several
 * threads (one blocked reading the tty); in a user's tab it stopped before
 * the new image ran.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run } from './helpers';

const FIX = resolve(__dirname, 'fixtures/x86');
const dir = mkdtempSync(join(tmpdir(), 'shiro-exec-threads-'));
const bin = join(dir, 'execthreads');
const bin1 = join(dir, 'execthreads-1');
let built = false;
try {
  execFileSync('gcc', ['-static', '-O1', '-pthread', '-o', bin, 'execthreads.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 });
  execFileSync('gcc', ['-static', '-O1', '-pthread', '-DNOTHREADS', '-o', bin1, 'execthreads.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 });
  built = true;
} catch { /* no gcc: skipped */ }

async function runProg(b: string): Promise<string> {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/home/user/work', { recursive: true });
  await fs.writeFile('/home/user/work/prog', readFileSync(b), { mode: 0o755 });
  await shell.execute('cd /home/user/work', () => {});
  const r = await Promise.race([
    run(shell, './prog; echo rc $?'),
    new Promise<{ output: string }>((res) => setTimeout(() => res({ output: 'TIMEOUT' }), 60_000)),
  ]);
  return r.output.replace(/\r\n/g, '\n');
}

describe('execve from a multithreaded program', () => {
  it.skipIf(!built)('a single-threaded program execs itself', async () => {
    expect(await runProg(bin1)).toBe('before exec tasks=1\nafter exec tasks=1\nrc 0\n');
  }, 90_000);

  // Known bug (Build 966): the exec traps in Blink ("prog: memory access out of
  // bounds", status 1) and the new image never runs. it.fails until it's fixed
  // (then this flips: make it a plain it).
  it.fails.skipIf(!built)('ends the other threads; the new image runs with one', async () => {
    // (/proc/self/task lists only the main thread before perf-kernel's per-thread /proc)
    expect(await runProg(bin)).toMatch(/^before exec tasks=[14]\nafter exec tasks=1\nrc 0\n$/);
  }, 90_000);
});
