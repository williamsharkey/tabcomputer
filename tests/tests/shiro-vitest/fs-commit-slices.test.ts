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
});

