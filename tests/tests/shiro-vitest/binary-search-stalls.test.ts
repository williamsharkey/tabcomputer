/**
 * #19, main-thread stalls in Claude-like workloads:
 * - grep and rg on a binary file (NUL bytes, invalid UTF-8) no longer decode it
 *   byte-exactly (~0.4 s for a 30 MB binary in node_modules): grep matches the
 *   native lossy decode and prints "Binary file X matches", rg skips it;
 * - (de)compression is fed to CompressionStream a MiB at a time (pipeBytes),
 *   with the page running between writes: one write of a 45 MB tar.gz was a
 *   0.8 s task.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import { pipeBytes } from '@shiro/utils/stream-bytes';
import { decodeBytes, encodeText } from '@shiro/utils/byte-text';

let shell: Shell;
let fs: any;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  await sh('rm -rf /tmp/bin19 && mkdir -p /tmp/bin19');
  // a binary: NULs, invalid UTF-8 and a matching "line"
  const bin = new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0xff, 0xfe, 0x80, 10, ...new TextEncoder().encode('has needle here'), 0xc3, 10, 0]);
  await fs.writeFile('/tmp/bin19/a.bin', bin);
  await fs.writeFile('/tmp/bin19/b.txt', 'needle in text\n');
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('grep and rg on binary files', () => {
  it('grep: "Binary file matches", counts and names; -a prints the line byte-exactly', async () => {
    expect((await sh('cd /tmp/bin19 && grep -r needle . | sort')).out).toBe('./b.txt:needle in text\nBinary file ./a.bin matches\n');
    expect((await sh('cd /tmp/bin19 && grep -c needle a.bin; grep -l needle a.bin; grep -q needle a.bin; echo st=$?')).out).toBe('1\na.bin\nst=0\n');
    expect((await sh('cd /tmp/bin19 && grep nomatch a.bin; echo st=$?')).out).toBe('st=1\n');
    await sh('cd /tmp/bin19 && grep -a needle a.bin > out.bin');
    const out: Uint8Array = await fs.readFile('/tmp/bin19/out.bin');
    expect(Array.from(out)).toEqual([...new TextEncoder().encode('has needle here'), 0xc3, 10]);
  });

  it('rg skips binary files', async () => {
    expect((await sh('cd /tmp/bin19 && rg needle')).out).toBe('b.txt:needle in text\n');
  });
});

describe('pipeBytes', () => {
  it('compresses and decompresses 5 MiB a MiB at a time, with macrotasks in between', async () => {
    const data = new Uint8Array(5 << 20);
    for (let i = 0; i < data.length; i++) data[i] = (i * 2654435761) >>> 24 & (i % 7 === 0 ? 0xff : 0x0f);
    let turns = 0;
    let running = true;
    const tick = () => { if (!running) return; turns++; setTimeout(tick, 0); };
    setTimeout(tick, 0);
    const gz = await pipeBytes(data, new CompressionStream('gzip'));
    running = false;
    expect(turns).toBeGreaterThanOrEqual(3);
    const back = await pipeBytes(gz, new DecompressionStream('gzip'));
    expect(back.length).toBe(data.length);
    expect(Buffer.compare(Buffer.from(back), Buffer.from(data))).toBe(0);
    expect((await pipeBytes(new Uint8Array(0), new CompressionStream('gzip'))).length).toBeGreaterThan(0);
  });

  it('a corrupt stream rejects', async () => {
    await expect(pipeBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), new DecompressionStream('gzip'))).rejects.toBeTruthy();
  });
});

describe('decodeBytes on invalid UTF-8', () => {
  it('round-trips every byte (escaped as U+DC80+byte)', () => {
    const b = new Uint8Array(70000);
    for (let i = 0; i < b.length; i++) b[i] = (i * 7919 + (i >> 3)) & 0xff;
    b.set([0xf0, 0x9f, 0x98, 0x80, 0xe2, 0x82, 0xac, 0xc3, 0xa9], 100); // valid 4-, 3-, 2-byte sequences among invalid ones
    const s = decodeBytes(b);
    expect(s.slice(0, 1)).toBe('\0');
    expect(s.includes('\u{1F600}€é')).toBe(true);
    expect(Array.from(encodeText(s))).toEqual(Array.from(b));
    expect(decodeBytes(new Uint8Array([0x61, 0xff, 0x62, 0xe2, 0x82]))).toBe('a\udcffb\udce2\udc82');
  });
});

describe('gunzipDetailedAsync', () => {
  const big = new Uint8Array(3 << 20);
  for (let i = 0; i < big.length; i++) big[i] = (i % 251) ^ ((i >> 12) & 0x3f);
  const cat = (...a: Uint8Array[]) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };

  it('agrees with the JS codec: one member, identical members, zero padding, trailing garbage', async () => {
    const { gunzipDetailedAsync } = await import('@shiro/commands/compress/gunzip-async');
    const { gunzipDetailed } = await import('@shiro/commands/compress/gzip-codec');
    const gz = await pipeBytes(big, new CompressionStream('gzip'));
    const cases: [string, Uint8Array][] = [
      ['one member', gz],
      ['two identical members', cat(gz, gz)],
      ['zero padding', cat(gz, new Uint8Array(512))],
      ['trailing garbage', cat(gz, new Uint8Array([1, 2, 3]))],
    ];
    for (const [name, input] of cases) {
      const want = gunzipDetailed(input);
      const got = await gunzipDetailedAsync(input);
      expect(got.trailingGarbage, name).toBe(want.trailingGarbage);
      expect(got.data.length, name).toBe(want.data.length);
      expect(Buffer.compare(Buffer.from(got.data), Buffer.from(want.data)), name).toBe(0);
    }
  });

  it('a corrupt member throws the codec\'s GzipError', async () => {
    const { gunzipDetailedAsync } = await import('@shiro/commands/compress/gunzip-async');
    const { GzipError } = await import('@shiro/commands/compress/gzip-codec');
    const gz = await pipeBytes(big, new CompressionStream('gzip'));
    const bad = gz.slice();
    bad[bad.length - 6] ^= 0xff; // the CRC
    await expect(gunzipDetailedAsync(bad)).rejects.toBeInstanceOf(GzipError);
  });

  it('tar xzf and gunzip of a big archive round-trip', async () => {
    await fs.writeFile('/tmp/bin19/big.dat', big);
    const r = await sh('cd /tmp/bin19 && tar czf b.tgz big.dat && mkdir x && tar xzf b.tgz -C x && cmp big.dat x/big.dat && gzip -k big.dat && mv big.dat orig.dat && gunzip big.dat.gz && cmp big.dat orig.dat && echo same');
    expect(r.out).toBe('same\n');
  });
});
