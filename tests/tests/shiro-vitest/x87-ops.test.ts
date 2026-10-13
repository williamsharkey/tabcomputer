/**
 * The x87 instructions under Blink against what the Intel manual says each
 * does (Blink patch 0554, tabcomputer#150). fixtures/x86/x87ops.c runs every
 * register form of add, mul, sub, subr, div and divr (D8, DC and DE, each
 * with st(0) to st(7)), the memory forms, the compares, the integer loads
 * and stores under each rounding mode, the stack instructions, a long double
 * least squares after tesseract's, and fcmovcc, ftst, fxam, fprem, fxtract,
 * the constants and the transcendentals. It checks itself: the operands are
 * exact in a double, so the answers are the same on a real x87 and in Blink,
 * whose registers are doubles. The same source built for x86-64 macOS passes
 * under Rosetta, which is where the model was checked.
 *
 * Before the patch: `fsubp %st,%st(i)` wrote st(1) whatever i was (Debian's
 * tesseract lost text lines to it), `fdiv`/`fdivr %st,%st(i)` were each
 * other's, `fucompp` was SIGILL, an integer store that doesn't fit was
 * saturated, and fxam called a subnormal double a denormal. With infinite
 * operands fsub's two cases were each other's (inf - 1 was -inf). And
 * fxrstor brought four empty registers back in use (patch 0557), so after
 * ld.so's fxsave and fxrstor x87 code that used the whole stack set IE and
 * SF: numpy's "invalid value encountered" warnings.
 *
 * Built with the host's gcc, or `zig cc` for x86_64-linux-musl (macOS: zig on
 * PATH or ZIG); skipped without either.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run } from './helpers';

const FIX = resolve(__dirname, 'fixtures/x86');
const bin = join(mkdtempSync(join(tmpdir(), 'shiro-x87ops-')), 'x87ops');
const build = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, [...args, '-static', '-O1', '-o', bin, 'x87ops.c', '-lm'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 });
    // a Linux x86-64 ELF (macOS's gcc is clang and builds for the host)
    const h = readFileSync(bin);
    return h.readUInt32BE(0) === 0x7f454c46 && h.readUInt16LE(18) === 62;
  } catch { return false; }
};
const haveBin = build('gcc', []) || build(process.env.ZIG || 'zig', ['cc', '-target', 'x86_64-linux-musl']);

const ALL_OK = [
  'register forms: ok',
  'memory forms: ok',
  'compares: ok',
  'integers: ok',
  'stack: ok',
  'long double: ok',
  'the rest: ok',
  'flags and tags: ok',
  'x87ops ok',
  '',
].join('\n');

describe('x87 instructions (x86 under Blink)', () => {
  it.skipIf(!haveBin)('every form gives what the manual says, with the JIT and without', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', readFileSync(bin), { mode: 0o755 });
    const jit = await run(shell, 'cd /home/user/work && ./prog');
    expect(jit.output.replace(/\r\n/g, '\n')).toBe(ALL_OK);
    expect(jit.exitCode).toBe(0);
    const interp = await run(shell, 'cd /home/user/work && BLINK_WJIT=0 ./prog');
    expect(interp.output.replace(/\r\n/g, '\n')).toBe(ALL_OK);
    expect(interp.exitCode).toBe(0);
  }, 120_000);
});
