/**
 * 80-bit long double loads and stores under Blink (patch 0540). Blink's x87
 * registers are doubles, so fldt and fstpt convert: to the nearest double
 * (ties to even), infinity past DBL_MAX, a subnormal or zero under DBL_MIN,
 * and subnormal doubles stored normalized. Before, a value just under 2
 * loaded as 1, a finite value past DBL_MAX as NaN (issue #110 item 6: numpy's
 * long double limits), one under DBL_MIN as garbage, and a subnormal was
 * stored as a different number. fixtures/x86/x87ldbl.c prints the bits.
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
const bin = join(mkdtempSync(join(tmpdir(), 'shiro-x87ldbl-')), 'x87ldbl');
const build = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, [...args, '-static', '-O1', '-o', bin, 'x87ldbl.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 });
    // a Linux x86-64 ELF (macOS's gcc is clang and builds for the host)
    const h = readFileSync(bin);
    return h.readUInt32BE(0) === 0x7f454c46 && h.readUInt16LE(18) === 62;
  } catch { return false; }
};
const haveBin = build('gcc', []) || build(process.env.ZIG || 'zig', ['cc', '-target', 'x86_64-linux-musl']);

describe('x87 long double loads and stores (x86 under Blink)', () => {
  it.skipIf(!haveBin)('fldt rounds to the nearest double, overflows to infinity and underflows to a subnormal; fstpt normalizes subnormals', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', readFileSync(bin), { mode: 0o755 });
    const r = await run(shell, 'cd /home/user/work && ./prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe([
      'load 1 3ff0000000000000',
      'load 1+ulp 3ff0000000000000',
      'load 1-ulp 3ff0000000000000',
      'load 2-ulp 4000000000000000',             // was 1
      'load -(2-ulp) c000000000000000',
      'load tie-even 3ff0000000000000',
      'load tie-odd 3ff0000000000002',
      'load pi 400921fb54442d18',
      'load DBL_MAX 7fefffffffffffff',
      'load DBL_MAX+half 7ff0000000000000',
      'load 1.5*2^1024 7ff0000000000000',        // was NaN
      'load 1.5*2^5000 7ff0000000000000',        // was NaN
      'load LDBL_MAX 7ff0000000000000',
      'load -LDBL_MAX fff0000000000000',
      'load inf 7ff0000000000000',
      'load nan 7ff8000000000000',
      'load DBL_MIN 0010000000000000',
      'load 1.5*DBL_MIN/2 000c000000000000',     // was 2^-1023
      'load DBL_TRUE_MIN 0000000000000001',
      'load 1.5*DBL_TRUE_MIN/2 0000000000000001',
      'load DBL_TRUE_MIN/2 0000000000000000',
      'load 1.5*2^-2000 0000000000000000',       // was 2^-1023
      'load LDBL_MIN 0000000000000000',
      'load -0 8000000000000000',
      'store 1 3fff 8000000000000000',
      'store DBL_MAX 43fe fffffffffffff800',
      'store DBL_MIN 3c01 8000000000000000',
      'store DBL_MIN/2 3c00 8000000000000000',   // was 0000 c000000000000000
      'store 3*DBL_TRUE_MIN 3bce c000000000000000',
      'store -DBL_TRUE_MIN bbcd 8000000000000000',
      'store inf 7fff 8000000000000000',
      'store -0 8000 0000000000000000',
      '',
    ].join('\n'));
    expect(r.exitCode).toBe(0);
  }, 120_000);
});
