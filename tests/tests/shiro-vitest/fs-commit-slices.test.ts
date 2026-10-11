import { describe, it, expect, afterEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { stored, checkStore } from './fs-store-check';

// A flush is one transaction whose requests go in slices (COMMIT_SLICE_MS of
// main thread each, the next from the last one's success): every record
// lands, in order, all or nothing.
describe('commit slices', { timeout: 60_000 }, () => {
  const saved = FileSystem.COMMIT_SLICE_MS;
  afterEach(() => { FileSystem.COMMIT_SLICE_MS = saved; });

  it('a batch issued one request per slice stores everything, a range delete before the writes after it', async () => {
    FileSystem.COMMIT_SLICE_MS = 0; // a slice after every request
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/cs/old', { recursive: true });
    for (let i = 0; i < 50; i++) await fs.writeFile(`/tmp/cs/old/f${i}`, `old ${i}`);
    await fs.sync();
    await fs.rm('/tmp/cs/old', { recursive: true }); // a range delete...
    await fs.mkdir('/tmp/cs/old', { recursive: true });
    for (let i = 0; i < 300; i++) await fs.writeFile(`/tmp/cs/old/g${i}`, `new ${i}`); // ...then writes under it, one batch
    await fs.writeFile('/tmp/cs/old/g7', 'rewritten');
    await fs.sync();
    const recs = await stored(fs);
    checkStore(recs);
    const under = [...recs.keys()].filter((k) => k.startsWith('/tmp/cs/old/')).sort();
    expect(under.length).toBe(300);
    expect(under.some((k) => /\/f\d+$/.test(k))).toBe(false);
    expect(new TextDecoder().decode(recs.get('/tmp/cs/old/g7').content)).toBe('rewritten');
    const other = new FileSystem();
    await other.init();
    expect(await other.readFile('/tmp/cs/old/g299', 'utf8')).toBe('new 299');
    expect(await other.exists('/tmp/cs/old/f3')).toBe(false);
  });

  it('a long run of calls answered from memory gives the page a turn (find over a big tree was one task)', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/cs2', { recursive: true });
    await fs.writeFile('/tmp/cs2/f', 'x');
    let ran = false;
    let ranAfter = 0, calls = 0;
    setTimeout(() => { ran = true; ranAfter = calls; }, 0);
    const t0 = performance.now();
    while (performance.now() - t0 < 200) { await fs.lstat('/tmp/cs2/f'); calls++; }
    expect(ran).toBe(true);
    expect(ranAfter).toBeLessThan(calls); // during the run, not after it
  });

  it('a 300 MB batch commits in slices the page runs between, and one failure partway stores none of it', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/cs3', { recursive: true });
    await fs.sync();
    const MiB = 1 << 20;
    const write = (tag: string) => Promise.all(Array.from({ length: 300 }, (_, i) => fs.writeNow(`/tmp/cs3/${tag}${i}`, new Uint8Array(MiB).fill(i & 255)).catch(() => {})));
    // Issued in slices (each from the last one's success: separate tasks in a
    // browser; fake-indexeddb runs them back to back): none holds the thread long
    const proto0 = Object.getPrototypeOf((fs as any).db.transaction('files').objectStore('files'));
    const put0 = proto0.put;
    const slices: { start: number; end: number; puts: number }[] = [];
    let open = false;
    proto0.put = function (this: IDBObjectStore, v: unknown) {
      const now = performance.now();
      if (!open) { slices.push({ start: now, end: now, puts: 0 }); open = true; queueMicrotask(() => { open = false; }); }
      const r = put0.call(this, v);
      const sl = slices[slices.length - 1];
      sl.end = performance.now(); sl.puts++;
      return r;
    };
    try {
      await write('a');
      await fs.sync();
    } finally { proto0.put = put0; }
    const big = slices.filter((x) => x.puts > 0);
    expect(big.length).toBeGreaterThan(2);
    expect(Math.max(...big.map((x) => x.end - x.start))).toBeLessThan(50);
    expect(big.reduce((a, b) => a + b.puts, 0)).toBeGreaterThanOrEqual(300);
    const recs = await stored(fs);
    expect([...recs.keys()].filter((k) => k.startsWith('/tmp/cs3/a')).length).toBe(300);
    // All or nothing: a request failing partway aborts the whole transaction
    const proto = Object.getPrototypeOf((fs as any).db.transaction('files').objectStore('files'));
    const put = proto.put;
    let n = 0;
    proto.put = function (this: IDBObjectStore, v: unknown) { if (++n === 150) throw new DOMException('injected', 'DataError'); return put.call(this, v); };
    try {
      await write('b');
      await fs.sync().catch(() => {});
    } finally { proto.put = put; }
    const other = new FileSystem();
    await other.init();
    expect((await other.readdir('/tmp/cs3')).filter((n2) => n2.startsWith('b'))).toEqual([]);
  });

  it('a Node Buffer view is stored as its own bytes, not its whole buffer (git clone stored each 1 MiB block of a pack as 265 MB)', async () => {
    const saved2 = { min: FileSystem.BLOB_MIN, block: FileSystem.BLOCK };
    FileSystem.BLOB_MIN = 64 << 10; FileSystem.BLOCK = 16 << 10;
    try {
      const fs = new FileSystem();
      await fs.init();
      await fs.mkdir('/tmp/cs4', { recursive: true });
      const whole = Buffer.alloc(4 << 20, 7); // isomorphic-git's pack: one big Buffer
      const pack = whole.slice(1 << 20, (1 << 20) + (256 << 10)); // a Buffer view (Buffer.slice doesn't copy)
      expect(pack.buffer.byteLength).toBe(whole.buffer.byteLength);
      await fs.writeFile('/tmp/cs4/pack', pack); // big: blocks
      await fs.writeFile('/tmp/cs4/small', whole.slice(100, 200)); // small: one record
      const recs = await stored(fs);
      const blocks = [...recs.entries()].filter(([k]) => k.startsWith('\u0001b/'));
      expect(blocks.length).toBe(16);
      for (const [, r] of blocks) expect(r.content.buffer.byteLength).toBe(r.content.byteLength);
      const small = recs.get('/tmp/cs4/small').content;
      expect([small.byteLength, small.buffer.byteLength]).toEqual([100, 100]);
      const other = new FileSystem();
      await other.init();
      const back = await other.readFile('/tmp/cs4/pack') as Uint8Array;
      expect(back.length).toBe(256 << 10);
      expect(back[1000]).toBe(7);
    } finally { FileSystem.BLOB_MIN = saved2.min; FileSystem.BLOCK = saved2.block; }
  });
});

