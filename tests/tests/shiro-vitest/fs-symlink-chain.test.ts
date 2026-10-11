/**
 * lookupCached (the kernel's synchronous stat/open path) follows chains of
 * symlinks the way stat() does: each link's relative target is resolved
 * against that link's own directory, and targets may pass through linked
 * directories. Debian's alternatives make such chains:
 * libblas.so.3 → /usr/lib/x86_64-linux-gnu/blas/libblas.so.3 → libblas.so.3.11.0
 * (Blender failed to load: "liblapack.so.3: cannot open shared object file").
 */
import { it, expect } from 'vitest';
import { FileSystem } from '@shiro/filesystem';

it('lookupCached follows a link to a relative link in another directory, and through linked directories', async () => {
  const fs = new FileSystem();
  await fs.init();
  await fs.mkdir('/tmp/c/usr/lib/blas', { recursive: true });
  await fs.writeFile('/tmp/c/usr/lib/blas/libblas.so.3.11.0', 'blas');
  await fs.symlink('libblas.so.3.11.0', '/tmp/c/usr/lib/blas/libblas.so.3');
  await fs.symlink('/tmp/c/usr/lib/blas/libblas.so.3', '/tmp/c/usr/lib/libblas.so.3');
  // a directory link on the way (usrmerge's /lib → usr/lib), in a link's target and in the path
  await fs.symlink('usr/lib', '/tmp/c/lib');
  await fs.symlink('/tmp/c/lib/blas/libblas.so.3', '/tmp/c/usr/lib/viadir.so');
  await fs.symlink('../lib/blas', '/tmp/c/usr/blasdir');
  // #65's repro: relative → relative in another directory, and absolute → relative
  await fs.mkdir('/tmp/c/D/sub', { recursive: true });
  await fs.writeFile('/tmp/c/D/sub/real.txt', 'data');
  await fs.symlink('real.txt', '/tmp/c/D/sub/rel1');
  await fs.symlink('/tmp/c/D/sub/rel1', '/tmp/c/D/abs_to_rel');
  await fs.symlink('sub/rel1', '/tmp/c/D/rel_to_rel');
  for (const p of ['/tmp/c/D/abs_to_rel', '/tmp/c/D/rel_to_rel']) expect(fs.lookupCached(p)?.path, p).toBe('/tmp/c/D/sub/real.txt');
  for (const p of ['/tmp/c/usr/lib/libblas.so.3', '/tmp/c/usr/lib/viadir.so', '/tmp/c/lib/libblas.so.3', '/tmp/c/usr/blasdir/libblas.so.3']) {
    const hit = fs.lookupCached(p);
    expect(hit, p).toBeTruthy();
    expect(hit!.path, p).toBe('/tmp/c/usr/lib/blas/libblas.so.3.11.0');
    expect(hit!.node.type).toBe('file');
    expect((await fs.stat(p)).size, p).toBe(4);
  }
  // without following, the link itself
  expect(fs.lookupCached('/tmp/c/usr/lib/libblas.so.3', false)!.node.type).toBe('symlink');
  // a dangling chain is missing, as stat says
  await fs.symlink('nowhere', '/tmp/c/usr/lib/blas/dangling');
  await fs.symlink('/tmp/c/usr/lib/blas/dangling', '/tmp/c/usr/lib/d.so');
  expect(fs.lookupCached('/tmp/c/usr/lib/d.so')).toBeNull();
  await expect(fs.stat('/tmp/c/usr/lib/d.so')).rejects.toThrow(/ENOENT/);
  // a loop is left to stat() (ELOOP)
  await fs.symlink('/tmp/c/loop2', '/tmp/c/loop1');
  await fs.symlink('/tmp/c/loop1', '/tmp/c/loop2');
  expect(fs.lookupCached('/tmp/c/loop1')).toBeUndefined();
});
