/**
 * fs.promises.realpath of a file this script wrote whose write hasn't reached storage yet,
 * reached through a symlinked directory: the file is in the script's cache under the
 * directory's real path. compat-dev's "fs lstat and realpath" saw ENOENT here under load.
 */
import { describe, it, expect } from 'vitest';
import { createFsPromisesModule } from '@shiro/node-compat/modules/fs';

describe('fs.promises.realpath while a write is in flight', () => {
  it('finds a file written through a symlinked directory before storage has it', async () => {
    const fileCache = new Map<string, string>([['/d/dir/in', 'x']]);
    const ctx: any = {
      cwd: '/d',
      fs: {
        resolvePath: (p: string, cwd: string) => (p.startsWith('/') ? p : `${cwd}/${p}`),
        // storage: the directory and the link are there, the file not yet
        realpath: async (p: string) => { if (p === '/d/DL' || p === '/d/dir') return '/d/dir'; throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
        exists: async (p: string) => p === '/d/dir' || p === '/d/DL',
        realpathCached: (p: string) => (p === '/d/DL' || p === '/d/dir' ? '/d/dir' : undefined),
      },
    };
    const promises = createFsPromisesModule({ ctx, fileCache, fileMtimes: new Map(), pendingPromises: [], tickSyncOps: () => {}, FakeBuffer: Buffer, getBuiltinModule: () => null, homeDir: '/d' } as any);
    expect(await promises.realpath('/d/DL/in')).toBe('/d/dir/in');
    expect(await promises.realpath('DL/in')).toBe('/d/dir/in');
    expect(await promises.realpath('/d/dir/in')).toBe('/d/dir/in');
    await expect(promises.realpath('/d/DL/nope')).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
