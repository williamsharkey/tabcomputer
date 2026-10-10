import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { Buffer } from 'node:buffer';
import { createWatchApi } from '@shiro/node-compat/modules/fs-watch';

// A node guest hears the page's filesystem changes later than its own reads see them
// (they are relayed): a change from before a watch began is already in what the watcher read.
describe('fs.watch and changes relayed late', () => {
  it("drops a change older than the watch, and a directory's change older than the file's own watch", async () => {
    const listeners = new Set<(event: string, path: string, newPath?: string, at?: number) => void>();
    const ctx: any = {
      cwd: '/', fs: {
        resolvePath: (p: string) => p,
        isDirCached: (p: string) => p === '/d',
        readdirCached: (p: string) => (p === '/d' ? ['f.json'] : undefined),
        onChange: (fn: any) => { listeners.add(fn); return () => listeners.delete(fn); },
      },
    };
    const api = createWatchApi({ ctx, fileCache: new Map(), getBuiltinModule: (n: string) => (n === 'fs' ? { existsSync: () => true } : n === 'events' ? { EventEmitter } : { Buffer }) });
    const fire = (event: string, path: string, at?: number) => { for (const fn of [...listeners]) fn(event, path, undefined, at); };
    const seen: string[] = [];
    const dir = api.watch('/d', (t: string, n: string) => seen.push(`dir ${t} ${n}`));
    await new Promise((r) => setTimeout(r, 5));
    const before = Date.now() - 1;
    const file = api.watch('/d/f.json', (t: string, n: string) => seen.push(`file ${t} ${n}`));
    fire('write', '/d/f.json', before); // (the write the file's watcher already read)
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual([]);
    fire('write', '/d/f.json', Date.now());
    fire('write', '/d/f.json'); // (no time: the page's own, in order)
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(['dir change f.json', 'file change f.json', 'dir change f.json', 'file change f.json']);
    dir.close(); file.close();
  });
});
