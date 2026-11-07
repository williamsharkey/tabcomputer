/**
 * Chrome refuses one IndexedDB transaction of about 450 MB of blobs even when
 * the origin is nearly empty (tabcomputer#167). A commit stays under
 * COMMIT_MAX_BYTES, and a refusal under quota is retried instead of ENOSPC.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';

describe('blob commit quota', () => {
  const saved = { bytes: FileSystem.COMMIT_MAX_BYTES, delays: FileSystem.THROTTLE_DELAYS };
  const storage = Object.getOwnPropertyDescriptor(navigator, 'storage');
  afterEach(() => {
    FileSystem.COMMIT_MAX_BYTES = saved.bytes;
    FileSystem.THROTTLE_DELAYS = saved.delays;
    if (storage) Object.defineProperty(navigator, 'storage', storage);
  });

  it('commits a batch bigger than the cap as several transactions, in order', async () => {
    FileSystem.COMMIT_MAX_BYTES = 1000;
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/bq', { recursive: true });
    await fs.sync();
    const db = (fs as any).db as IDBDatabase;
    const orig = db.transaction.bind(db);
    let txs = 0;
    db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => { txs++; return orig(...args); }) as IDBDatabase['transaction'];
    for (let i = 0; i < 5; i++) await fs.writeFile(`/tmp/bq/f${i}`, 'x'.repeat(800));
    await fs.sync();
    expect(txs).toBe(5);
    const other = new FileSystem();
    await other.init();
    expect(await other.readFile('/tmp/bq/f4', 'utf8')).toBe('x'.repeat(800));
  });

  it('a refusal far under quota keeps new files and retries, and clears when a commit lands', async () => {
    FileSystem.THROTTLE_DELAYS = [30];
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 1000, quota: 1e12 }) } });
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/bq2', { recursive: true });
    await fs.sync();
    const proto = Object.getPrototypeOf((fs as any).db.transaction('files').objectStore('files'));
    const put = proto.put;
    let thrown = false;
    proto.put = function (this: IDBObjectStore, v: unknown) {
      if (!thrown) { thrown = true; throw new DOMException('refused', 'QuotaExceededError'); }
      return put.call(this, v);
    };
    try {
      await fs.writeFile('/tmp/bq2/a', 'aaa');
      const done = fs.sync();
      await new Promise((r) => setTimeout(r, 10));
      expect(fs.storageThrottled).toBe(true);
      expect(fs.storageFull).toBe(false);
      await fs.writeFile('/tmp/bq2/b', 'bbb');
      await done;
    } finally { proto.put = put; }
    expect(fs.storageThrottled).toBe(false);
    expect(fs.storageFull).toBe(false);
    const other = new FileSystem();
    await other.init();
    expect(await other.readFile('/tmp/bq2/a', 'utf8')).toBe('aaa');
    expect(await other.readFile('/tmp/bq2/b', 'utf8')).toBe('bbb');
  });

  it('after the retries are used up it counts as full', async () => {
    FileSystem.THROTTLE_DELAYS = [1, 1];
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 1000, quota: 1e12 }) } });
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/bq3', { recursive: true });
    await fs.sync();
    const proto = Object.getPrototypeOf((fs as any).db.transaction('files').objectStore('files'));
    const put = proto.put;
    proto.put = function () { throw new DOMException('refused', 'QuotaExceededError'); };
    try {
      await fs.writeFile('/tmp/bq3/a', 'aaa');
      await expect(fs.sync()).rejects.toMatchObject({ code: 'ENOSPC' });
    } finally { proto.put = put; }
    expect(fs.storageThrottled).toBe(true);
    expect(fs.storageFull).toBe(true);
    // Two refusals, then it counts as full: 16 MB, 8 MB, 4 MB.
    expect((fs as any)._commitBytes).toBe(FileSystem.COMMIT_MAX_BYTES >> 2);
    (fs as any)._clearFullRetry();
  });

  it('writes during a retry do not start their own commits', async () => {
    FileSystem.THROTTLE_DELAYS = [80];
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 1000, quota: 1e12 }) } });
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/bq4', { recursive: true });
    await fs.sync();
    const db = (fs as any).db as IDBDatabase;
    const orig = db.transaction.bind(db);
    let txs = 0;
    db.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => { txs++; return orig(...args); }) as IDBDatabase['transaction'];
    const proto = Object.getPrototypeOf(db.transaction('files').objectStore('files'));
    const put = proto.put;
    let refuses = 0;
    proto.put = function (this: IDBObjectStore, v: unknown) {
      if (refuses < 1) { refuses++; throw new DOMException('refused', 'QuotaExceededError'); }
      return put.call(this, v);
    };
    try {
      await fs.writeFile('/home/user/bq4-a', 'a'.repeat(100));
      const done = fs.sync();
      await new Promise((r) => setTimeout(r, 20));
      const mid = txs;
      for (let i = 0; i < 8; i++) await fs.writeFile(`/home/user/bq4-${i}`, 'z');
      await new Promise((r) => setTimeout(r, 20));
      expect(txs).toBe(mid);
      await done;
    } finally { proto.put = put; }
    expect(txs).toBeLessThan(6);
  });

  it('once storage counts as full, a file under /tmp is still written, and stored when a commit lands', async () => {
    FileSystem.THROTTLE_DELAYS = [1];
    const savedBlob = FileSystem.BLOB_MIN;
    FileSystem.BLOB_MIN = 8;
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate: async () => ({ usage: 1000, quota: 1e12 }) } });
    const fs = new FileSystem();
    await fs.init();
    const proto = Object.getPrototypeOf((fs as any).db.transaction('files').objectStore('files'));
    const put = proto.put;
    let fails = 0;
    proto.put = function (this: IDBObjectStore, v: unknown) {
      if (fails++ < 2) throw new DOMException('refused', 'QuotaExceededError');
      return put.call(this, v);
    };
    try {
      await fs.writeFile('/home/user/bq5', 'pending');
      await expect(fs.sync()).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(fs.storageFull).toBe(true);
      // The directory has to be in the cache before the write, in this turn.
      await fs.mkdirNow('/tmp/bq5', { recursive: true });
      expect(fs.lookupCached('/tmp/bq5')?.node.type).toBe('dir');
      await fs.writeFile('/tmp/bq5/out', 'hello from a tool');
      await fs.writeFile('/tmp/bq5/big', 'x'.repeat(32));
      expect(await fs.readFile('/tmp/bq5/out', 'utf8')).toBe('hello from a tool');
      expect(await fs.readFile('/tmp/bq5/big', 'utf8')).toBe('x'.repeat(32));
      await expect(fs.writeFile('/home/user/bq5-nope', 'n')).rejects.toMatchObject({ code: 'ENOSPC' });
      const mid = new FileSystem();
      await mid.init();
      expect(await mid.exists('/tmp/bq5/out')).toBe(false);
      await fs.sync();
      expect(fs.storageFull).toBe(false);
      const other = new FileSystem();
      await other.init();
      expect(await other.readFile('/tmp/bq5/out', 'utf8')).toBe('hello from a tool');
      expect(await other.readFile('/tmp/bq5/big', 'utf8')).toBe('x'.repeat(32));
      expect(await other.readFile('/home/user/bq5', 'utf8')).toBe('pending');
    } finally {
      proto.put = put;
      FileSystem.BLOB_MIN = savedBlob;
      (fs as any)._clearFullRetry();
    }
  });
});
