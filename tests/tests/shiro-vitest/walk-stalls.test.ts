/**
 * #19, main-thread stalls in long filesystem walks:
 * - tar c and grep -r give the page a turn every few ms (timeSlicer): cached
 *   reads resolve as microtasks, so a walk was one task (75-100 ms over
 *   node_modules);
 * - grep matches a binary file a chunk at a time as it decodes it, instead of
 *   building the whole decoded string first; its output is unchanged;
 * - tar pads a member's data with a zero block instead of copying it padded.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import { timeSlicer, yieldTask, sliceStats } from '@shiro/utils/time-slice';

let shell: Shell;
let fs: any;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

/** Yields the time slicers made while `p` ran. */
async function yieldsDuring<T>(p: () => Promise<T>): Promise<number> {
  const before = sliceStats.yields;
  await p();
  return sliceStats.yields - before;
}

describe('timeSlicer', () => {
  it('returns plainly within its budget and yields a task after it', async () => {
    const slice = timeSlicer(5);
    expect(slice()).toBeUndefined();
    const t0 = performance.now();
    while (performance.now() - t0 < 6) { /* spin */ }
    let ran = false;
    setTimeout(() => { ran = true; }, 0);
    const p = slice();
    expect(p).toBeInstanceOf(Promise);
    await p;
    await yieldTask();
    expect(slice()).toBeUndefined(); // the budget restarts after a yield
    // (a message task then a timer: both turns ran)
    await new Promise((r) => setTimeout(r, 0));
    expect(ran).toBe(true);
  });
});

describe('grep on a binary file, matched a chunk at a time', () => {
  const CHUNK = 256 << 10;
  // ~700 KiB: NULs, matching lines across the 256 KiB chunk boundaries, a
  // 3-byte UTF-8 character split by a boundary, no newline at the end
  function makeBinary(): Uint8Array {
    const parts: number[] = [];
    const push = (s: string) => { for (const b of new TextEncoder().encode(s)) parts.push(b); };
    let i = 0;
    while (parts.length < 700 << 10) {
      if (parts.length > CHUNK - 40 && parts.length < CHUNK) { push('x'.repeat(CHUNK - 8 - parts.length) + 'needle €€ tail\n'); continue; }
      if (parts.length > 2 * CHUNK - 40 && parts.length < 2 * CHUNK) { while (parts.length < 2 * CHUNK - 1) parts.push(0x61); push('€ needle\n'); continue; }
      parts.push(0);
      push(i % 5 === 0 ? `line ${i} needle\n` : `line ${i} hay\n`);
      i++;
    }
    push('last needle without newline');
    return new Uint8Array(parts);
  }

  it('-c, -v -c, -m, -l, -L, -q and the plain message agree with a whole-file decode', async () => {
    const bin = makeBinary();
    await sh('mkdir -p /tmp/gb');
    await fs.writeFile('/tmp/gb/big.bin', bin);
    const lines = new TextDecoder().decode(bin).split('\n');
    const hit = lines.filter((l) => l.includes('needle')).length;
    const euro = lines.filter((l) => /€ needle|needle €/.test(l)).length;
    expect(euro).toBe(2);
    const g = async (args: string) => (await sh(`cd /tmp/gb && grep ${args}; echo st=$?`)).out;
    expect(await g('-c needle big.bin')).toBe(`${hit}\nst=0\n`);
    expect(await g('-c "€ needle\\|needle €" big.bin')).toBe(`2\nst=0\n`);
    expect(await g('-v -c needle big.bin')).toBe(`${lines.length - hit}\nst=0\n`);
    expect(await g('-m 3 -c needle big.bin')).toBe('3\nst=0\n');
    expect(await g('-c "without newline$" big.bin')).toBe('1\nst=0\n');
    expect(await g('needle big.bin')).toBe('Binary file big.bin matches\nst=0\n');
    expect(await g('-l needle big.bin')).toBe('big.bin\nst=0\n');
    expect(await g('-L needle big.bin')).toBe('st=1\n');
    expect(await g('-L nomatch big.bin')).toBe('big.bin\nst=0\n');
    expect(await g('-q needle big.bin')).toBe('st=0\n');
    expect(await g('nomatch big.bin')).toBe('st=1\n');
    expect(await g('-H -c needle big.bin')).toBe(`big.bin:${hit}\nst=0\n`);
  });
});

describe('long walks give the page turns', () => {
  beforeEach(async () => {
    await sh('mkdir -p /tmp/walk');
    for (let d = 0; d < 20; d++) {
      await fs.mkdir(`/tmp/walk/d${d}`, { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, i) => fs.writeFile(`/tmp/walk/d${d}/f${i}.txt`, `file ${d}/${i}\n`.repeat(40) + (i === 7 ? 'needle\n' : ''))));
    }
  });

  it('grep -r', async () => {
    expect((await sh('grep -rc needle /tmp/walk | grep -c ":1$"')).out).toBe('20\n');
    // warm (the walk's reads come from the cache, as microtasks): still slices, each up to the budget
    const t0 = performance.now();
    const yields = await yieldsDuring(() => sh('grep -rc needle /tmp/walk > /dev/null'));
    // (budget 10 ms; elapsed includes the shell's own time, so half of that)
    expect(yields).toBeGreaterThanOrEqual(Math.floor((performance.now() - t0) / 20) - 1);
  });

  it('tar cf', async () => {
    await sh('cd /tmp && tar cf walk.tar walk');
    const t0 = performance.now();
    const yields = await yieldsDuring(() => sh('cd /tmp && tar cf walk.tar walk'));
    // (budget 10 ms; elapsed includes the shell's own time, so half of that)
    expect(yields).toBeGreaterThanOrEqual(Math.floor((performance.now() - t0) / 20) - 1);
    expect((await sh('tar tf /tmp/walk.tar | wc -l')).out.trim()).toBe(String(1 + 20 + 2000));
  });
});

describe('tar data padding', () => {
  it('members of 0, 1, 511, 512, 513 and 1500 bytes round-trip; the archive is whole records', async () => {
    await sh('mkdir -p /tmp/pad/src');
    const sizes = [0, 1, 511, 512, 513, 1500];
    for (const n of sizes) await fs.writeFile(`/tmp/pad/src/f${n}`, Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) & 0xff));
    expect((await sh('cd /tmp/pad && tar cf a.tar src && mkdir out && cd out && tar xf ../a.tar; echo st=$?')).out).toBe('st=0\n');
    const tar: Uint8Array = await fs.readFile('/tmp/pad/a.tar');
    expect(tar.length % 10240).toBe(0);
    for (const n of sizes) {
      const back: Uint8Array = await fs.readFile(`/tmp/pad/out/src/f${n}`);
      expect(Array.from(back)).toEqual(Array.from({ length: n }, (_, i) => (i * 7 + n) & 0xff));
    }
  });
});
