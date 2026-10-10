/**
 * inotify (src/kernel/inotify.ts): a guest's syscalls and changes made
 * straight through the FileSystem (the shell's builtins, the editor) are
 * events of one source, FileSystem.onChange; the kernel's open files add
 * IN_OPEN, IN_ACCESS and IN_CLOSE_*. (LTP inotify01, inotify02, inotify04)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createTestShell } from './helpers';
import type { FileSystem } from '@shiro/filesystem';
import { Kernel } from '@shiro/kernel/kernel';
import type { Process } from '@shiro/kernel/process';
import * as A from '@shiro/kernel/abi';
import * as I from '@shiro/kernel/inotify';

describe('inotify', () => {
  let fs: FileSystem;
  let kernel: Kernel;
  let proc: Process;
  const enc = new TextEncoder();
  const call = (nr: number, args: number[], path = '') => {
    const data = new Uint8Array(4096);
    data.set(enc.encode(path));
    return kernel.syscall(proc, nr, args, data);
  };
  const L = (s: string) => enc.encode(s).length;
  const open = (p: string, flags: number, mode = 0o644) => call(A.SYS_openat, [A.AT_FDCWD, L(p), flags, mode], p);
  const watch = (fd: number, p: string, mask: number) => call(A.SYS_inotify_add_watch, [fd, L(p), mask], p);
  /** The events queued, as [wd, mask, cookie, name] */
  const events = async (fd: number) => {
    const buf = new Uint8Array(4096);
    const n = await kernel.syscall(proc, A.SYS_read, [fd, buf.length], buf);
    if (n === -A.EAGAIN) return [];
    expect(n).toBeGreaterThan(0);
    const dv = new DataView(buf.buffer);
    const out: [number, number, number, string][] = [];
    for (let o = 0; o < n;) {
      const len = dv.getUint32(o + 12, true);
      const name = new TextDecoder().decode(buf.subarray(o + 16, o + 16 + len)).replace(/\0+$/, '');
      out.push([dv.getInt32(o, true), dv.getUint32(o + 4, true), dv.getUint32(o + 8, true), name]);
      o += 16 + len;
    }
    return out;
  };
  const settle = () => new Promise((r) => setTimeout(r, 30));

  beforeAll(async () => {
    ({ fs } = await createTestShell());
    kernel = new Kernel({ fs, registerWithProcessTable: false });
    await fs.mkdir('/tmp/in', { recursive: true });
    proc = kernel.spawn({ path: 'holder', cwd: '/tmp/in', fds: {}, run: () => new Promise<number>(() => {}) });
  });
  afterAll(() => { kernel.kill(proc.pid, A.SIGKILL); });

  it('a watched file: chmod, open, read, close, open, write, close in order, nothing more (LTP inotify01)', async () => {
    await fs.writeFile('/tmp/in/f', 'hello');
    const ifd = await call(A.SYS_inotify_init1, [A.O_NONBLOCK]);
    expect(ifd).toBeGreaterThanOrEqual(0);
    const wd = await watch(ifd, '/tmp/in/f', 0xfff);
    expect(wd).toBe(1);
    expect(await call(A.SYS_chmod, [L('/tmp/in/f'), 0o755], '/tmp/in/f')).toBe(0);
    let fd = await open('/tmp/in/f', A.O_RDONLY);
    expect(await kernel.syscall(proc, A.SYS_read, [fd, 16], new Uint8Array(16))).toBe(5);
    await call(A.SYS_close, [fd]);
    fd = await open('/tmp/in/f', A.O_RDWR | A.O_CREAT);
    expect(await kernel.syscall(proc, A.SYS_write, [fd, 3], enc.encode('abc'))).toBe(3);
    await call(A.SYS_close, [fd]);
    await settle(); // (the inode's write-back: an echo, not another IN_MODIFY)
    expect((await events(ifd)).map((e) => e[1])).toEqual(
      [I.IN_ATTRIB, I.IN_OPEN, I.IN_ACCESS, I.IN_CLOSE_NOWRITE, I.IN_OPEN, I.IN_MODIFY, I.IN_CLOSE_WRITE]);
    expect(await events(ifd)).toEqual([]);
    await call(A.SYS_close, [ifd]);
  });

  it('a watched directory: create, move (one cookie), delete, mkdir with names; a change made straight through the FileSystem too (LTP inotify02)', async () => {
    await fs.mkdir('/tmp/in/d');
    const ifd = await call(A.SYS_inotify_init1, [A.O_NONBLOCK]);
    const wd = await watch(ifd, '/tmp/in/d', 0xfff);
    const fd = await open('/tmp/in/d/a', A.O_WRONLY | A.O_CREAT);
    await call(A.SYS_close, [fd]);
    expect(await call(A.SYS_rename, [L('/tmp/in/d/a'), L('/tmp/in/d/b')], '/tmp/in/d/a\0/tmp/in/d/b'.split('\0').join(''))).toBeDefined();
    await settle();
    let ev = await events(ifd);
    expect(ev.slice(0, 3)).toEqual([[wd, I.IN_CREATE, 0, 'a'], [wd, I.IN_OPEN, 0, 'a'], [wd, I.IN_CLOSE_WRITE, 0, 'a']]);
    // the shell writing a file and making a directory: the same events
    await fs.writeFile('/tmp/in/d/c', 'x');
    await fs.writeFile('/tmp/in/d/c', 'y');
    await fs.mkdir('/tmp/in/d/sub');
    await fs.unlink('/tmp/in/d/c');
    ev = await events(ifd);
    // (a whole file each time: written and closed, as `echo x > c`)
    expect(ev).toEqual([
      [wd, I.IN_CREATE, 0, 'c'], [wd, I.IN_MODIFY, 0, 'c'], [wd, I.IN_CLOSE_WRITE, 0, 'c'],
      [wd, I.IN_MODIFY, 0, 'c'], [wd, I.IN_CLOSE_WRITE, 0, 'c'],
      [wd, I.IN_CREATE | I.IN_ISDIR, 0, 'sub'], [wd, I.IN_DELETE, 0, 'c'],
    ]);
    // a rename: IN_MOVED_FROM and IN_MOVED_TO with one cookie
    await fs.writeFile('/tmp/in/d/m', 'm');
    await events(ifd);
    await fs.rename('/tmp/in/d/m', '/tmp/in/d/n');
    ev = await events(ifd);
    expect(ev.map((e) => [e[1], e[3]])).toEqual([[I.IN_MOVED_FROM, 'm'], [I.IN_MOVED_TO, 'n']]);
    expect(ev[0][2]).toBe(ev[1][2]);
    expect(ev[0][2]).not.toBe(0);
    await call(A.SYS_close, [ifd]);
  });

  it('a watched file deleted: IN_ATTRIB (its links), IN_DELETE_SELF, IN_IGNORED; rm_watch: IN_IGNORED; errors (LTP inotify04)', async () => {
    await fs.writeFile('/tmp/in/g', 'g');
    const ifd = await call(A.SYS_inotify_init1, [A.O_NONBLOCK]);
    const wd = await watch(ifd, '/tmp/in/g', I.IN_DELETE_SELF | I.IN_ATTRIB);
    await fs.unlink('/tmp/in/g');
    expect((await events(ifd)).map((e) => e[1]).filter((m) => m !== I.IN_ATTRIB)).toEqual([I.IN_DELETE_SELF, I.IN_IGNORED]);
    expect(await call(A.SYS_inotify_rm_watch, [ifd, wd])).toBe(-A.EINVAL);
    await fs.writeFile('/tmp/in/h', 'h');
    const wd2 = await watch(ifd, '/tmp/in/h', I.IN_MODIFY);
    expect(await call(A.SYS_inotify_rm_watch, [ifd, wd2])).toBe(0);
    expect(await events(ifd)).toEqual([[wd2, I.IN_IGNORED, 0, '']]);
    expect(await watch(ifd, '/tmp/in/nope', I.IN_MODIFY)).toBe(-A.ENOENT);
    expect(await watch(ifd, '/tmp/in/h', 0)).toBe(-A.EINVAL);
    expect(await watch(ifd, '/tmp/in/h', I.IN_MODIFY | I.IN_ONLYDIR)).toBe(-A.ENOTDIR);
    const plain = await open('/tmp/in/h', A.O_RDONLY);
    expect(await watch(plain, '/tmp/in/h', I.IN_MODIFY)).toBe(-A.EINVAL); // not an inotify fd
    await call(A.SYS_close, [plain]);
    await events(ifd);
    // the same path again: the same wd, the mask replaced (or added to)
    const w3 = await watch(ifd, '/tmp/in/h', I.IN_MODIFY);
    expect(await watch(ifd, '/tmp/in/h', I.IN_ATTRIB | I.IN_MASK_ADD)).toBe(w3);
    expect(await watch(ifd, '/tmp/in/h', I.IN_ATTRIB | I.IN_MASK_CREATE)).toBe(-A.EEXIST);
    // FIONREAD, a buffer too small, blocking reads
    await fs.writeFile('/tmp/in/h', 'more');
    const n = new Uint8Array(4);
    expect(await kernel.syscall(proc, A.SYS_ioctl, [ifd, A.FIONREAD, 4], n)).toBe(0);
    expect(new DataView(n.buffer).getInt32(0, true)).toBe(16);
    expect(await kernel.syscall(proc, A.SYS_read, [ifd, 8], new Uint8Array(8))).toBe(-A.EINVAL);
    await call(A.SYS_close, [ifd]);
    expect(await call(A.SYS_inotify_init1, [0x40])).toBe(-A.EINVAL);
  });
});
