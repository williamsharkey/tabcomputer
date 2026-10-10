import { describe, it, expect, afterEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { Kernel } from '@shiro/kernel/kernel';
import * as A from '@shiro/kernel/abi';
import { createTestShell, run } from './helpers';
import { stored } from './fs-store-check';

// Idle clean file content leaves memory (FileSystem "Content cache").
describe('FileSystem content cache', () => {
  const budget = FileSystem.CONTENT_BUDGET;
  afterEach(() => { FileSystem.CONTENT_BUDGET = budget; });
  const later = () => Date.now() + FileSystem.CONTENT_IDLE_MS + 1;
  const bytes = (n: number, v: number) => new Uint8Array(n).fill(v);

  it('drops a big clean file once idle and reads it back from IndexedDB', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.holdSmallContent(); // big files here: the small ones (/etc's) stay
    await fs.writeFile('/tmp/big.bin', bytes(9 << 20, 7));
    expect(fs.sweepContent(later())).toBe(0); // not committed yet
    await fs.sync();
    expect(fs.sweepContent(Date.now())).toBe(0); // used just now
    expect(fs.sweepContent(later())).toBe(9 << 20);
    expect(fs.contentCacheBytes).toBeLessThan(FileSystem.CONTENT_SMALL); // (/etc's small files stay, held)
    expect(fs.readBytesCached('/tmp/big.bin')).toBeUndefined();
    expect((await fs.stat('/tmp/big.bin')).size).toBe(9 << 20);
    const back = (await fs.readFile('/tmp/big.bin')) as Uint8Array;
    expect(back.length).toBe(9 << 20);
    expect(back[12345]).toBe(7);
    expect(fs.readBytesCached('/tmp/big.bin')?.length).toBe(9 << 20);
  });

  it('keeps pinned (open) files, and ones under 8 MiB within the budget', async () => {
    const fs = new FileSystem();
    await fs.init();
    await fs.holdSmallContent(); // big files here: the small ones (/etc's) stay
    await fs.writeFile('/tmp/open.bin', bytes(9 << 20, 1));
    await fs.writeFile('/tmp/small.bin', bytes(100 << 10, 2));
    await fs.sync();
    const unpin = fs.addContentPin((p) => p === '/tmp/open.bin');
    expect(fs.sweepContent(later())).toBe(0);
    unpin();
    expect(fs.sweepContent(later())).toBe(9 << 20);
    expect(fs.readBytesCached('/tmp/small.bin')?.length).toBe(100 << 10);
  });

  it('beyond the budget drops the least recently used first', async () => {
    FileSystem.CONTENT_BUDGET = 250 << 10;
    const fs = new FileSystem();
    await fs.init();
    await fs.holdSmallContent(); // big files here: the small ones (/etc's) stay
    for (const n of ['a', 'b', 'c', 'd']) await fs.writeFile(`/tmp/lru-${n}`, bytes(100 << 10, 3));
    await fs.sync();
    fs.readBytesCached('/tmp/lru-a'); // a is now the most recently used
    expect(fs.sweepContent(later())).toBe(200 << 10); // b and c go, 200 KiB left
    expect(fs.readBytesCached('/tmp/lru-b')).toBeUndefined();
    expect(fs.readBytesCached('/tmp/lru-c')).toBeUndefined();
    expect(fs.readBytesCached('/tmp/lru-d')).toBeDefined();
    expect(fs.readBytesCached('/tmp/lru-a')).toBeDefined();
    expect(((await fs.readFile('/tmp/lru-b')) as Uint8Array).length).toBe(100 << 10);
  });

  // Small files (under CONTENT_SMALL) leave memory too, their nodes staying:
  // stat answers from memory, the bytes come back from IndexedDB
  describe('small files', { timeout: 60_000 }, () => {
    const text = (s: string) => new TextEncoder().encode(s);
    async function evicted(): Promise<FileSystem> {
      const fs = new FileSystem();
      await fs.init();
      await fs.mkdir('/tmp/sm/d', { recursive: true });
      await fs.writeFile('/tmp/sm/a', 'alpha');
      await fs.writeFile('/tmp/sm/b', bytes(10 << 10, 4));
      await fs.writeFile('/tmp/sm/d/c', 'gamma');
      await fs.chmod('/tmp/sm/a', 0o640);
      await fs.sync();
      return fs;
    }

    it('go when idle; lookupCached and stat still answer; readFile brings the bytes back', async () => {
      const fs = await evicted();
      const before = await fs.stat('/tmp/sm/a');
      expect(fs.sweepContent(later())).toBeGreaterThanOrEqual(5 + (10 << 10) + 5);
      expect(fs.readBytesCached('/tmp/sm/a')).toBeUndefined();
      expect(fs.readBytesCached('/tmp/sm/d/c')).toBeUndefined();
      const hit = fs.lookupCached('/tmp/sm/a', false)!;
      expect(hit.node.evicted).toBe(true);
      expect([hit.node.size, hit.node.mode & 0o777]).toEqual([5, 0o640]);
      const st = await fs.stat('/tmp/sm/a');
      expect([st.size, st.ino, st.mode, st.mtimeMs]).toEqual([before.size, before.ino, before.mode, before.mtimeMs]);
      expect((await fs.lstat('/tmp/sm/b')).size).toBe(10 << 10);
      expect(await fs.readFile('/tmp/sm/a', 'utf8')).toBe('alpha');
      expect(fs.readBytesCached('/tmp/sm/a')).toEqual(text('alpha'));
      expect(fs.lookupCached('/tmp/sm/a')!.node.evicted).toBeUndefined();
      expect(((await fs.readFile('/tmp/sm/b')) as Uint8Array)[100]).toBe(4);
      // Nothing of it is stored
      for (const n of (await stored(fs)).values()) expect(n.evicted).toBeUndefined();
    });

    it('writes, renames and deletes after the bytes went are not undone by the kept node', async () => {
      const fs = await evicted();
      fs.sweepContent(later());
      await fs.unlink('/tmp/sm/a');
      expect(fs.lookupCached('/tmp/sm/a', false)).toBeNull();
      await expect(fs.stat('/tmp/sm/a')).rejects.toThrow(/ENOENT/);
      await fs.rename('/tmp/sm/b', '/tmp/sm/b2');
      expect(fs.lookupCached('/tmp/sm/b', false)).toBeNull();
      expect(((await fs.readFile('/tmp/sm/b2')) as Uint8Array).length).toBe(10 << 10);
      await fs.rm('/tmp/sm/d', { recursive: true });
      expect(fs.lookupCached('/tmp/sm/d/c', false)).toBeNull();
      await expect(fs.stat('/tmp/sm/d/c')).rejects.toThrow(/ENOENT/);
      await fs.writeFile('/tmp/sm/e', 'one');
      await fs.sync();
      fs.sweepContent(later());
      await fs.appendFile('/tmp/sm/e', '+two');
      expect(fs.readBytesCached('/tmp/sm/e')).toEqual(text('one+two'));
      await fs.sync();
      fs.sweepContent(later());
      await fs.chmod('/tmp/sm/e', 0o600);
      expect((fs.lookupCached('/tmp/sm/e')!.node.mode) & 0o777).toBe(0o600);
      expect(await fs.readFile('/tmp/sm/e', 'utf8')).toBe('one+two');
      await fs.sync();
      fs.sweepContent(later());
      await fs.writeFile('/tmp/sm/e', 'three');
      expect(fs.lookupCached('/tmp/sm/e')!.node.size).toBe(5);
      const other = new FileSystem();
      await other.init();
      expect(await other.readFile('/tmp/sm/e', 'utf8')).toBe('three');
      expect(await other.exists('/tmp/sm/a')).toBe(false);
    });

    it('stay unwritten, open or held: dirty files, pinned ones, and all small ones once node runs in the page', async () => {
      const fs = await evicted();
      await fs.writeFile('/tmp/sm/dirty', 'not yet stored');
      const unpin = fs.addContentPin((p) => p === '/tmp/sm/a');
      fs.sweepContent(later());
      expect(fs.readBytesCached('/tmp/sm/dirty')).toBeDefined();
      expect(fs.readBytesCached('/tmp/sm/a')).toBeDefined();
      expect(fs.readBytesCached('/tmp/sm/b')).toBeUndefined();
      unpin();
      // Held: the ones already gone come back, and nothing small goes from now on
      await fs.holdSmallContent();
      expect(fs.readBytesCached('/tmp/sm/b')?.length).toBe(10 << 10);
      expect(fs.readBytesCached('/tmp/sm/d/c')).toEqual(text('gamma'));
      await fs.writeFile('/tmp/sm/big', bytes(9 << 20, 1));
      await fs.sync();
      expect(fs.sweepContent(later())).toBe(9 << 20); // big files still go
      expect(fs.readBytesCached('/tmp/sm/a')).toBeDefined();
    });

    it('readdir, exists and unlink of an idle file read no bytes; writeNow keeps its inode number and mode', async () => {
      const fs = await evicted();
      fs.sweepContent(later());
      const reqs: unknown[] = [];
      const orig = (fs as any)._request.bind(fs);
      (fs as any)._request = (m: unknown, make: unknown) => { reqs.push(make); return orig(m, make); };
      await expect(fs.readdir('/tmp/sm/a')).rejects.toThrow(/ENOTDIR/); // isomorphic-git's walker does this for every file
      expect(await fs.exists('/tmp/sm/b')).toBe(true);
      await fs.unlink('/tmp/sm/d/c');
      expect(reqs).toEqual([]);
      (fs as any)._request = orig;
      const before = await fs.stat('/tmp/sm/a');
      await fs.writeNow('/tmp/sm/a', text('now'));
      const after = await fs.stat('/tmp/sm/a');
      expect([after.ino, after.mode, after.size]).toEqual([before.ino, before.mode, 3]);
      const other = new FileSystem();
      await other.init();
      expect(await other.exists('/tmp/sm/d/c')).toBe(false);
      expect(await other.readFile('/tmp/sm/a', 'utf8')).toBe('now');
    });

    it('reading one idle file brings its idle neighbours back in the same transaction, never over newer writes', async () => {
      const fs = new FileSystem();
      await fs.init();
      await fs.mkdir('/tmp/smb/sub', { recursive: true });
      for (let i = 0; i < 20; i++) await fs.writeFile(`/tmp/smb/f${i}`, `file ${i}`);
      await fs.writeFile('/tmp/smb/sub/deep', 'deep');
      await fs.readdir('/tmp/smb'); // (the child index)
      await fs.sync();
      fs.sweepContent(later());
      await fs.writeNow('/tmp/smb/f3', text('rewritten')); // newer than what is stored (no read of the old bytes first)
      await fs.unlink('/tmp/smb/f4');
      let n = 0;
      const orig = (fs as any)._request.bind(fs);
      (fs as any)._request = (m: unknown, make: unknown) => { n++; return orig(m, make); };
      expect(await fs.readFile('/tmp/smb/f0', 'utf8')).toBe('file 0');
      expect(n).toBe(1);
      for (let i = 1; i < 20; i++) if (i !== 3 && i !== 4) expect(new TextDecoder().decode(fs.readBytesCached(`/tmp/smb/f${i}`))).toBe(`file ${i}`);
      expect(fs.readBytesCached('/tmp/smb/f3')).toEqual(text('rewritten'));
      expect(fs.lookupCached('/tmp/smb/f4', false)).toBeNull();
      expect(fs.readBytesCached('/tmp/smb/sub/deep')).toBeUndefined(); // only the directory's own files
      (fs as any)._request = orig;
    });

    it('a hard-linked small file goes whole and comes back through either name', async () => {
      const fs = await evicted();
      await fs.link('/tmp/sm/a', '/tmp/sm/a2');
      await fs.sync();
      fs.sweepContent(later());
      expect(fs.readBytesCached('/tmp/sm/a2')).toBeUndefined();
      expect(await fs.readFile('/tmp/sm/a2', 'utf8')).toBe('alpha');
      expect(((await fs.stat('/tmp/sm/a')) as any).nlink).toBe(2);
    });

    it('the kernel stats them from memory and opens them through IndexedDB', async () => {
      const { fs, shell } = await createTestShell();
      const kernel = new Kernel({ shell });
      try {
        const proc = kernel.spawn({ path: 'p', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
        await fs.mkdir('/tmp/smk', { recursive: true });
        await fs.writeFile('/tmp/smk/f', 'kernel bytes');
        await fs.sync();
        fs.sweepContent(later());
        expect(fs.lookupCached('/tmp/smk/f')!.node.evicted).toBe(true);
        const enc = new TextEncoder();
        const p = enc.encode('/tmp/smk/f');
        const d = new Uint8Array(256); d.set(p);
        expect(kernel.syscallSync(proc, A.SYS_stat, [p.length], d)).toBe(0); // answered from memory
        expect(Number(new DataView(d.buffer).getBigInt64(48, true))).toBe(12); // st_size
        const o = new Uint8Array(256); o.set(p);
        const fd = await kernel.syscall(proc, A.SYS_openat, [A.AT_FDCWD, p.length, A.O_RDONLY, 0], o) as number;
        expect(fd).toBeGreaterThanOrEqual(0);
        const buf = new Uint8Array(64);
        const n = await kernel.syscall(proc, A.SYS_read, [fd, 64], buf) as number;
        expect(new TextDecoder().decode(buf.subarray(0, n))).toBe('kernel bytes');
        kernel.kill(proc.pid, A.SIGKILL);
      } finally { kernel.dispose(); }
    });

    it('node in the page holds them: readFileSync of a file whose bytes had gone', async () => {
      const { fs, shell } = await createTestShell();
      await fs.mkdir('/tmp/smn', { recursive: true });
      await fs.writeFile('/tmp/smn/data.txt', 'written by the shell');
      await fs.sync();
      fs.sweepContent(later());
      expect(fs.readBytesCached('/tmp/smn/data.txt')).toBeUndefined();
      const r = await run(shell, `node -e "process.stdout.write(require('fs').readFileSync('/tmp/smn/data.txt', 'utf8'))"`);
      expect(r.output).toContain('written by the shell');
      await fs.sync();
      fs.sweepContent(later());
      expect(fs.readBytesCached('/tmp/smn/data.txt')).toBeDefined();
    });
  });
});

