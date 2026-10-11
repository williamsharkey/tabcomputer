/**
 * node's crypto random functions past getRandomValues' 65536-byte quota
 * (williamsharkey/tabcomputer#46): randomBytes, randomFillSync, randomFill;
 * randomInt. Both configs: the page's node here, a guest's under test:worker.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;
beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
});

async function node(code: string) {
  await fs.writeFile('/tmp/rnd.js', code);
  let out = '', err = '';
  const status = await shell.execute('node /tmp/rnd.js', (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err, status };
}

describe('crypto random past 64 KiB (tabcomputer#46)', () => {
  it('randomBytes: any size, every chunk filled', async () => {
    const r = await node(`const c = require('crypto');
for (const n of [0, 1, 65536, 65537, 1 << 20]) {
  const b = c.randomBytes(n);
  // (each 64 KiB chunk has bytes that aren't zero: none was left unfilled)
  let filled = true;
  for (let i = 0; i < n; i += 65536) if (b.subarray(i, i + 65536).every((x) => x === 0)) filled = false;
  console.log(n, b.length, Buffer.isBuffer(b), filled);
}
c.randomBytes(200000, (e, b) => console.log('cb', e, b.length));
`);
    // (a lost callback reads as this mismatch, with what node printed; a hang as the test's timeout)
    expect(r, `node printed ${JSON.stringify(r)}`).toMatchObject({ out: '0 0 true true\n1 1 true true\n65536 65536 true true\n65537 65537 true true\n1048576 1048576 true true\ncb null 200000\n', status: 0 });
  });

  it('randomFillSync and randomFill: offsets and sizes in elements, past 64 KiB', async () => {
    const r = await node(`const c = require('crypto');
const b = Buffer.alloc(300000);
c.randomFillSync(b, 100000);
console.log(b.subarray(0, 100000).every((x) => x === 0), b.subarray(100000).filter((x) => x !== 0).length > 190000);
const u = new Uint32Array(40000);
c.randomFillSync(u, 10, 20000);
console.log(u.subarray(0, 10).every((x) => x === 0), u.subarray(10, 20010).filter(Boolean).length > 19000, u.subarray(20010).every((x) => x === 0));
try { c.randomFillSync(b, 400000); } catch (e) { console.log(e.name); }
c.randomFill(new Uint8Array(70000), (e, a) => console.log('cb', e, a.filter(Boolean).length > 65000));
`);
    expect(r).toMatchObject({ out: 'true true\ntrue true true\nRangeError\ncb null true\n', status: 0 });
  });

  it('getRandomValues keeps the Web Crypto quota, as node', async () => {
    const r = await node(`const c = require('crypto');
console.log(c.getRandomValues(new Uint8Array(65536)).length);
try { c.getRandomValues(new Uint8Array(65537)); } catch (e) { console.log(e.name); }
`);
    expect(r).toMatchObject({ out: '65536\nQuotaExceededError\n', status: 0 });
  });

  it('randomInt: in [min, max), sync and with a callback', async () => {
    const r = await node(`const c = require('crypto');
const xs = Array.from({ length: 2000 }, () => c.randomInt(10));
const ys = Array.from({ length: 2000 }, () => c.randomInt(-5, 5));
console.log(xs.every((x) => Number.isInteger(x) && x >= 0 && x < 10), new Set(xs).size, ys.every((y) => y >= -5 && y < 5), new Set(ys).size);
try { c.randomInt(5, 5); } catch (e) { console.log(e.name); }
c.randomInt(3, (e, n) => console.log('cb', e, n >= 0 && n < 3));
`);
    expect(r).toMatchObject({ out: 'true 10 true 10\nRangeError\ncb null true\n', status: 0 });
  });
});
