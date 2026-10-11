import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { createWatchApi } from '@shiro/node-compat/modules/fs-watch';

// A node guest hears the page's filesystem changes later than its own reads see them
// (they are relayed): a change from before a watch began is already in what the watcher read.
// Changes are stamped with the page's wall-clock time to the microsecond.
const now = () => performance.timeOrigin + performance.now();
describe('fs.watch and changes relayed late', () => {
  it("drops a change older than the watch, and a directory's change older than the file's own watch", async () => {
    const listeners = new Set<(event: string, path: string, newPath?: string, detail?: { at?: number }) => void>();
    const ctx: any = {
      cwd: '/', fs: {
        resolvePath: (p: string) => p,
        isDirCached: (p: string) => p === '/d',
        readdirCached: (p: string) => (p === '/d' ? ['f.json'] : undefined),
        onChange: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
    };
    const api = createWatchApi({ ctx, fileCache: new Map(), getBuiltinModule: (n: string) => (n === 'fs' ? { existsSync: () => true } : n === 'events' ? { EventEmitter } : { Buffer }) });
    const fire = (event: string, path: string, at?: number) => { for (const fn of [...listeners]) fn(event, path, undefined, at === undefined ? undefined : { at }); };
    const seen: string[] = [];
    const dir = api.watch('/d', (t: string, n: string) => seen.push(`dir ${t} ${n}`));
    await new Promise((r) => setTimeout(r, 5));
    const before = now() - 1;
    const file = api.watch('/d/f.json', (t: string, n: string) => seen.push(`file ${t} ${n}`));
    fire('write', '/d/f.json', before); // (the write the file's watcher already read)
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([]);
    fire('write', '/d/f.json', now());
    fire('write', '/d/f.json'); // (no time: the page's own, in order)
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(['dir change f.json', 'file change f.json', 'dir change f.json', 'file change f.json']);
    // A change made before the same one reached us is one with it, as inotify merges an unread
    // event with the next (Astro restarted on writeFileSync's second 'change' of
    // .astro/settings.json); one made after that counts
    seen.length = 0;
    const t = now();
    fire('write', '/d/f.json', t);
    fire('write', '/d/f.json', t);
    await new Promise((r) => setTimeout(r, 10));
    fire('write', '/d/f.json', now());
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(['dir change f.json', 'file change f.json', 'dir change f.json', 'file change f.json']);
    // A write earlier in the millisecond the file's own watch began (chokidar watching a file it
    // saw created) is in what it read; with whole milliseconds it passed for a new change
    seen.length = 0;
    const t1 = now();
    const fresh = api.watch('/d/f.json', (t: string, n: string) => seen.push(`fresh ${t} ${n}`));
    fire('write', '/d/f.json', t1);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.filter((s) => s.startsWith('fresh'))).toEqual([]);
    dir.close(); file.close(); fresh.close();
  });
});

// A storm (rm -rf node_modules under a recursive watcher) mustn't run every
// callback in one turn of the event loop: delivery goes on in later tasks.
describe('fs.watch event storms', () => {
  it('delivers a small burst in a microtask, and a storm in chunks with the page running between them', async () => {
    const listeners = new Set<(event: string, path: string) => void>();
    const ctx: any = {
      cwd: '/', fs: {
        resolvePath: (p: string) => p,
        isDirCached: (p: string) => p === '/d',
        readdirCached: () => [],
        onChange: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
    };
    const api = createWatchApi({ ctx, fileCache: new Map(), getBuiltinModule: (n: string) => (n === 'fs' ? { existsSync: () => true } : n === 'events' ? { EventEmitter } : { Buffer }) });
    const fire = (event: string, path: string) => { for (const fn of [...listeners]) fn(event, path); };
    const seen: string[] = [];
    const busy = (ms: number) => { const t = performance.now(); while (performance.now() - t < ms) { /* a listener's work */ } };
    const w = api.watch('/d', { recursive: true }, (_t: string, n: string) => { seen.push(n); busy(0.2); });

    fire('delete', '/d/a');
    await Promise.resolve(); await Promise.resolve();
    expect(seen).toEqual(['a']); // small bursts: same timing as before
    seen.length = 0;

    let ticks = 0;
    const iv = setInterval(() => ticks++, 0);
    for (let i = 0; i < 2000; i++) fire('delete', `/d/node_modules/f${i}`);
    const t0 = performance.now();
    while (seen.length < 2000 && performance.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 1));
    clearInterval(iv);
    expect(seen).toEqual(Array.from({ length: 2000 }, (_, i) => `node_modules/f${i}`)); // all, in order
    expect(ticks).toBeGreaterThan(5); // the page had turns while ~400 ms of callbacks ran
    w.close();
  });
});
