/**
 * SSE, SSE2, SSE3 and SSSE3 under Blink against x86-64 itself (Blink patch
 * 0555, tabcomputer#150's wider check). fixtures/x86/ssediff.c prints one
 * checksum per instruction form (378 of them: register and memory operands,
 * immediates, to and from the general registers, flags) over twelve operand
 * pairs with special floats, saturating integers and shift counts past the
 * width; every bit of the destination counts. fixtures/x86/ssediff.expected
 * is its output with x86-64's semantics: the same source built for macOS and
 * run under Rosetta 2.
 *
 * It found cvttpd2dq and cvtpd2dq exchanged (a vectorized `(int)x` rounded),
 * and three conversions that left the destination's upper half as it was.
 *
 * One difference is the host's, not Blink's: the sign of a NaN that an
 * operation makes (inf - inf, 0/0, the root of a negative number). x86 makes
 * a negative one and so does Blink on an x86 host; on an ARM host the NaN is
 * positive. The seven instructions whose operands here make one are allowed
 * that on a host that isn't x64, and nothing else is.
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
const bin = join(mkdtempSync(join(tmpdir(), 'shiro-ssediff-')), 'ssediff');
const build = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, [...args, '-static', '-O1', '-o', bin, 'ssediff.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 });
    const h = readFileSync(bin);
    return h.readUInt32BE(0) === 0x7f454c46 && h.readUInt16LE(18) === 62;
  } catch { return false; }
};
const haveBin = build('gcc', []) || build(process.env.ZIG || 'zig', ['cc', '-target', 'x86_64-linux-musl']);

/** Instructions whose operands here make a NaN from numbers: its sign is the host CPU's. */
const HOST_NAN_SIGN = new Set(['addps', 'divps', 'sqrtps', 'divss', 'sqrtss', 'sqrtpd', 'sqrtsd']);

/** The forms whose checksum is not x86's. */
function wrong(output: string): string[] {
  const want = readFileSync(join(FIX, 'ssediff.expected'), 'utf8').trim().split('\n');
  const got = output.replace(/\r\n/g, '\n').trim().split('\n');
  expect(got.length).toBe(want.length);
  return got.filter((line, i) => line !== want[i]).map((line) => line.replace(/ [0-9a-f]{16}$/, ''));
}

describe('SSE instructions against x86-64 (x86 under Blink)', () => {
  it.skipIf(!haveBin)('every form gives x86\'s result, with the JIT and without', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', readFileSync(bin), { mode: 0o755 });
    for (const env of ['', 'BLINK_WJIT=0 ']) {
      const r = await run(shell, `cd /home/user/work && ${env}./prog`);
      expect(r.exitCode).toBe(0);
      const bad = wrong(r.output);
      const hosts = bad.filter((name) => HOST_NAN_SIGN.has(name.split(' ')[0]));
      expect(bad.filter((name) => !hosts.includes(name)), `${env}not x86's`).toEqual([]);
      if (process.arch === 'x64') expect(hosts, `${env}the sign of a new NaN, on an x86 host`).toEqual([]);
    }
  }, 120_000);
});
