/**
 * Blink's wasm JIT compiles code in writable pages (vendor/blink patch 0553):
 * a JIT's code cache, a trampoline, code a program patches. This file checks
 * that compiled code never outlives the bytes it was compiled from.
 *
 * fixtures/x86/smcjit.c rewrites hot code in every way the patch has a path
 * for; each case checks itself. The cases run with the JIT's defaults, with
 * writable pages left to the interpreter (BLINK_WJIT_RWX=0) and without the
 * JIT. BLINK_WJIT_RWX=3 compiles writable pages and ignores the writes, and
 * =4 ignores mprotect and munmap too: the cases must fail there, which shows
 * they would catch a missing invalidation.
 *
 * Needs a C compiler for x86-64 Linux as `gcc` (skipped otherwise).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run } from './helpers';

const FIX = resolve(__dirname, 'fixtures/x86');
const dir = mkdtempSync(join(tmpdir(), 'shiro-x86-smc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const bin = join(dir, 'smcjit');
let built = false;
try {
  execFileSync('gcc', ['-static', '-O1', '-mno-red-zone', '-pthread', '-o', bin, 'smcjit.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 });
  built = readFileSync(bin).subarray(0, 4).toString('latin1') === '\x7fELF';
} catch { /* no compiler for Linux: skipped */ }

async function smc(what: string, env = ''): Promise<{ output: string; exitCode: number }> {
  const { fs, shell } = await createTestShell();
  await fs.mkdir('/home/user/work', { recursive: true });
  await fs.mkdir('/tmp', { recursive: true });
  await fs.writeFile('/home/user/work/prog', readFileSync(bin), { mode: 0o755 });
  await shell.execute('cd /home/user/work', () => {});
  const r = await Promise.race([
    run(shell, `${env} ./prog ${what}`),
    new Promise<{ output: string; exitCode: number }>((res) => setTimeout(() => res({ output: 'TIMEOUT', exitCode: -1 }), 110_000)),
  ]);
  return { output: r.output.replace(/\r\n/g, '\n'), exitCode: r.exitCode };
}

// what each case rewrites, and whether the write (W) or mprotect/munmap (P)
// is what has to drop the compiled code
const CASES: [string, string, 'W' | 'P'][] = [
  ['overwrite', 'a hot function in an RWX page is overwritten and called again', 'W'],
  ['patchimm', 'an immediate inside a hot loop is patched by a function the loop calls', 'W'],
  ['codedata', 'code and the data it writes share a page, then the code is rewritten', 'W'],
  ['straddle', 'an instruction across two pages is patched by one store across them', 'W'],
  ['wx', 'mprotect RW -> RX -> RW cycles, and RWX -> RX -> RWX', 'P'],
  ['refill', 'a code buffer is filled, run and refilled', 'W'],
  ['thread', 'a second thread rewrites what the first is running', 'W'],
  ['sysread', 'read() and pread() put new code in the page', 'W'],
  ['madvise', 'MADV_DONTNEED zeroes a page of compiled code', 'W'],
  ['fuzz', 'random rewrites and calls agree with a model', 'W'],
];

describe.skipIf(!built)('Blink engine: code on writable pages', () => {
  for (const [name, title] of CASES) {
    it(`${name}: ${title}`, async () => {
      const r = await smc(name);
      expect(r.output).toContain(`${name} ok`);
      expect(r.exitCode).toBe(0);
    }, 120_000);
  }

  it('the same with writable pages left to the interpreter (BLINK_WJIT_RWX=0)', async () => {
    for (const [name] of CASES) {
      const r = await smc(name, 'BLINK_WJIT_RWX=0');
      expect(r.output, name).toContain(`${name} ok`);
    }
  }, 600_000);

  it('the same without the JIT (BLINK_WJIT=0)', async () => {
    for (const [name] of CASES) {
      const r = await smc(name === 'fuzz' ? 'fuzz 1500' : name, 'BLINK_WJIT=0');
      expect(r.output, name).toContain(`${name} ok`);
    }
  }, 900_000);

  it('the fuzz case gives the same checksum with and without the JIT', async () => {
    const a = await smc('fuzz 3000');
    const b = await smc('fuzz 3000', 'BLINK_WJIT=0');
    expect(a.output).toMatch(/^fuzz ok [0-9a-f]+$/m);
    expect(a.output).toBe(b.output);
  }, 300_000);

  // the fixtures have teeth: with the invalidation taken out, each fails
  for (const [name, , kind] of CASES) {
    it(`${name} fails when ${kind === 'W' ? 'writes to compiled code are ignored (BLINK_WJIT_RWX=3)' : 'mprotect is ignored too (BLINK_WJIT_RWX=4)'}`, async () => {
      const r = await smc(name, `BLINK_WJIT_RWX=${kind === 'W' ? 3 : 4}`);
      expect(r.output).not.toContain(`${name} ok`);
      expect(r.exitCode).not.toBe(0);
    }, 120_000);
  }
});
