import { describe, it, expect } from 'vitest';
import { FileSystem } from '@shiro/filesystem';

// tabcomputer#71: the browser deleted the filesystem's IndexedDB mid-session
// (eviction, "Clear site data", another tab). The next operation reopened,
// got a new empty database and accepted it; each read of a file whose bytes
// had left memory then cached "doesn't exist", and new writes went into the
// empty database. Now a volume sentinel ties the page to the database it
// loaded: a reopen that finds none, or another one, marks storage lost.
describe('FileSystem storage lost (volume sentinel)', { timeout: 30_000 }, () => {
  const DB = 'tabcomputer-fs';
  const later = () => Date.now() + FileSystem.CONTENT_IDLE_MS + 1;

  const deleteDb = () => new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });

  /** Whether the database exists, without leaving one behind. */
  const dbExists = () => new Promise<boolean>((resolve, reject) => {
    let created = false;
    const req = indexedDB.open(DB);
    req.onupgradeneeded = () => { created = true; req.transaction!.abort(); };
    req.onsuccess = () => { req.result.close(); resolve(true); };
    req.onerror = () => (created ? resolve(false) : reject(req.error));
  });

  /** One raw record of the current database. */
  const rawGet = (key: string) => new Promise<any>((resolve, reject) => {
    const req = indexedDB.open(DB);
    req.onsuccess = () => {
      const db = req.result;
      const get = db.transaction('files', 'readonly').objectStore('files').get(key);
      get.onsuccess = () => { db.close(); resolve(get.result); };
      get.onerror = () => { db.close(); reject(get.error); };
    };
    req.onerror = () => reject(req.error);
  });

  /**
   * A booted filesystem with /tmp/sl/a's bytes out of memory and /tmp/keep/b's
   * in (another directory: a read brings an evicted file's idle neighbours back).
   * The key index is loaded, as it is in the page soon after boot.
   */
  async function booted(): Promise<FileSystem> {
    const fs = new FileSystem();
    await fs.init();
    await fs.mkdir('/tmp/sl', { recursive: true });
    await fs.mkdir('/tmp/keep', { recursive: true });
    await fs.writeFile('/tmp/sl/a', 'alpha');
    await fs.writeFile('/tmp/keep/b', 'beta');
    await fs.sync();
    await (fs as any)._getAllKeys();
    expect(fs.sweepContent(later())).toBeGreaterThan(0);
    expect(fs.readBytesCached('/tmp/sl/a')).toBeUndefined();
    expect(await fs.readFile('/tmp/keep/b', 'utf8')).toBe('beta'); // back in memory
    expect(fs.readBytesCached('/tmp/sl/a')).toBeUndefined();
    return fs;
  }

  it('init writes a sentinel with a random id; the next boot keeps it', async () => {
    await deleteDb();
    const fs = new FileSystem();
    await fs.init();
    expect(fs.volumeId).toMatch(/^[0-9a-z-]{16,}$/);
    expect((await rawGet('\u0001volume'))?.id).toBe(fs.volumeId);
    // Internal: never a file
    expect(await fs.readdir('/')).not.toContain('\u0001volume');
    const again = new FileSystem();
    await again.init();
    expect(again.volumeId).toBe(fs.volumeId);
  });

  it('an install from before the sentinel gets one at init', async () => {
    const fs = new FileSystem();
    await fs.init();
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open(DB);
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('files', 'readwrite');
        tx.objectStore('files').delete('\u0001volume');
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    const old = new FileSystem();
    await old.init();
    expect(old.volumeId).toBeTruthy();
    expect(old.volumeId).not.toBe(fs.volumeId);
    expect((await rawGet('\u0001volume'))?.id).toBe(old.volumeId);
    expect(old.storageLost).toBeNull();
  });

  it('a closed connection that reopens to the same volume is not a loss', async () => {
    const fs = await booted();
    (fs as any).db.close();
    (fs as any).db = null;
    expect(await fs.readFile('/tmp/sl/a', 'utf8')).toBe('alpha');
    expect(fs.storageLost).toBeNull();
  });

  it('deleteDatabase mid-session: EIO for what needs IndexedDB, writes kept in memory, no new empty database', async () => {
    const fs = await booted();
    const heard: string[] = [];
    fs.onStorageLost((l) => heard.push(l.reason));
    await deleteDb(); // versionchange: the page's connection closes, the delete goes through

    // The evicted file: EIO, not ENOENT, and again (nothing cached as missing)
    await expect(fs.readFile('/tmp/sl/a', 'utf8')).rejects.toMatchObject({ code: 'EIO' });
    await expect(fs.readFile('/tmp/sl/a', 'utf8')).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.storageLost).not.toBeNull();
    expect(heard).toHaveLength(1);
    // Its node is still known (stat from memory), and a file in memory still reads
    expect((await fs.stat('/tmp/sl/a')).size).toBe(5);
    expect(await fs.readFile('/tmp/keep/b', 'utf8')).toBe('beta');

    // A write after the loss: readable, pending, and sync() says EIO
    await fs.writeFile('/tmp/sl/c', 'gamma');
    expect(await fs.readFile('/tmp/sl/c', 'utf8')).toBe('gamma');
    expect(fs.pendingWrites).toBeGreaterThan(0);
    await expect(fs.sync()).rejects.toMatchObject({ code: 'EIO' });
    await new Promise((r) => setTimeout(r, 200)); // any probe or flush would have run by now
    expect(fs.pendingWrites).toBeGreaterThan(0);
    expect(fs.inMemoryFiles().map((n) => n.path)).toEqual(expect.arrayContaining(['/tmp/keep/b', '/tmp/sl/c']));

    // Nothing reopened into a silent empty database
    expect(await dbExists()).toBe(false);
  });

  it('notices the deletion by itself (versionchange), before any file operation', async () => {
    const fs = await booted();
    const lost = new Promise<string>((resolve) => fs.onStorageLost((l) => resolve(l.reason)));
    await deleteDb();
    expect(await lost).toMatch(/deleted/);
    expect(await dbExists()).toBe(false);
  });

  it('a database replaced by another volume (another tab booted) is a loss, and nothing is written into it', async () => {
    const fs = await booted();
    // Drop the connection quietly (as if closed under storage pressure, the
    // handlers not reached), then another page deletes and boots a new volume
    const db = (fs as any).db as IDBDatabase;
    db.onclose = null;
    db.onversionchange = null;
    db.close();
    (fs as any).db = null;
    await deleteDb();
    const other = new FileSystem();
    await other.init();
    await other.writeFile('/tmp/other.txt', 'theirs');
    await other.sync();
    expect(other.volumeId).not.toBe(fs.volumeId);

    await expect(fs.readFile('/tmp/sl/a', 'utf8')).rejects.toMatchObject({ code: 'EIO' });
    expect(fs.storageLost?.reason).toMatch(/another volume/);
    await fs.writeFile('/tmp/sl/mine', 'not theirs');
    await expect(fs.sync()).rejects.toMatchObject({ code: 'EIO' });
    expect(await rawGet('/tmp/sl/mine')).toBeUndefined();
    expect(await rawGet('/tmp/sl/a')).toBeUndefined();
    // The other page's volume is untouched
    expect((await rawGet('\u0001volume'))?.id).toBe(other.volumeId);
    other.clearCache();
    expect(await other.readFile('/tmp/other.txt', 'utf8')).toBe('theirs');
  });

  it('importAll keeps the sentinel', async () => {
    const fs = new FileSystem();
    await fs.init();
    const all = await fs.exportAll();
    await fs.importAll(all);
    expect((await rawGet('\u0001volume'))?.id).toBe(fs.volumeId);
    (fs as any).db.close();
    (fs as any).db = null;
    await fs.readdir('/tmp');
    expect(fs.storageLost).toBeNull();
  });
});
