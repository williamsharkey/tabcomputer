/**
 * A symlink to a symlink whose target is relative: the second target is
 * relative to the second link's directory. The in-memory walk (lookupCached:
 * the kernel's synchronous stat/open, the shell's cat) took it from the first
 * link's directory, so Debian's alternatives (libblas.so.3 → /etc/alternatives/…
 * → blas/libblas.so.3 → libblas.so.3.12.1) gave ENOENT and numpy couldn't load.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

const D = '/tmp/lnchain';

describe('symlink chains', () => {
  let shell: Shell;
  let fs: FileSystem;

  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    await fs.rm(D, { recursive: true } as any).catch(() => {});
    await fs.mkdir(`${D}/sub`, { recursive: true } as any);
    await fs.writeFile(`${D}/sub/real.txt`, 'data\n');
    await fs.symlink('real.txt', `${D}/sub/rel1`);             // relative, one hop
    await fs.symlink(`${D}/sub/rel1`, `${D}/abs_to_rel`);      // absolute → relative
    await fs.symlink('sub/rel1', `${D}/rel_to_rel`);           // relative → relative, another directory
    await fs.symlink(`${D}/abs_to_rel`, `${D}/abs_abs_rel`);   // three hops
    await fs.symlink('sub', `${D}/subdir`);                    // a directory link…
    await fs.symlink(`${D}/subdir/rel1`, `${D}/via_dir_link`); // …in the middle of a target
    await fs.symlink('loop2', `${D}/loop1`);
    await fs.symlink('loop1', `${D}/loop2`);
  });

  const chains = ['sub/rel1', 'abs_to_rel', 'rel_to_rel', 'abs_abs_rel', 'via_dir_link'];

  it('lookupCached and stat reach the file through every chain', async () => {
    for (const n of chains) {
      const hit = fs.lookupCached(`${D}/${n}`);
      expect(hit?.path, n).toBe(`${D}/sub/real.txt`);
      expect((await fs.stat(`${D}/${n}`)).isFile(), n).toBe(true);
    }
    // lstat-style lookup still sees the link itself
    expect(fs.lookupCached(`${D}/abs_to_rel`, false)?.node.type).toBe('symlink');
  });

  it('a link to a directory through a chain works as a directory component', async () => {
    await fs.symlink(`${D}/subdir`, `${D}/dir2`); // dir2 → subdir → sub
    expect(fs.lookupCached(`${D}/dir2/real.txt`)?.path).toBe(`${D}/sub/real.txt`);
  });

  it('cat reads through every chain', async () => {
    for (const n of chains) {
      const r = await run(shell, `cat ${D}/${n}`);
      expect(r.output.replace(/\r\n/g, '\n'), n).toBe('data\n');
      expect(r.exitCode, n).toBe(0);
    }
  });

  it("Debian's alternatives shape: lib → /etc/alternatives/… → dir/lib.so.3 → lib.so.3.12.1", async () => {
    await fs.mkdir(`${D}/usr/lib/blas`, { recursive: true } as any);
    await fs.mkdir(`${D}/etc/alternatives`, { recursive: true } as any);
    await fs.writeFile(`${D}/usr/lib/blas/libblas.so.3.12.1`, 'ELF');
    await fs.symlink('libblas.so.3.12.1', `${D}/usr/lib/blas/libblas.so.3`);
    await fs.symlink(`${D}/usr/lib/blas/libblas.so.3`, `${D}/etc/alternatives/libblas.so.3`);
    await fs.symlink(`${D}/etc/alternatives/libblas.so.3`, `${D}/usr/lib/libblas.so.3`);
    expect(fs.lookupCached(`${D}/usr/lib/libblas.so.3`)?.path).toBe(`${D}/usr/lib/blas/libblas.so.3.12.1`);
    expect(await fs.readFile(`${D}/usr/lib/libblas.so.3`, 'utf8')).toBe('ELF');
  });

  it('a loop is still not followed forever', async () => {
    expect(fs.lookupCached(`${D}/loop1`)).toBeUndefined(); // (stat() reports ELOOP)
    await expect(fs.stat(`${D}/loop1`)).rejects.toThrow(/ELOOP/);
  });
});
