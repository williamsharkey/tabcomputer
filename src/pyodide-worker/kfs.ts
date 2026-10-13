/**
 * The tab's files inside Pyodide: an Emscripten filesystem whose every
 * operation is a call on the tab's kernel (NODEFS is the model: nodes are
 * names, the path is rebuilt from them, open files hold a kernel fd). Mounted
 * over the tab's top-level directories, so `open('data.csv')`, `os.listdir`,
 * `plt.savefig` and pandas' `to_csv` read and write the tab's own files at
 * the tab's own paths, with nothing copied in or out.
 *
 * It needs calls that block (a Worker on the kernel's channel): Emscripten's
 * filesystem API is synchronous.
 */

/** The kernel's stat, as far as this needs it (src/kernel/abi.ts KStat) */
export interface KfsStat {
  dev: number; ino: number; mode: number; nlink: number; uid: number; gid: number; rdev: number;
  size: number; blksize: number; blocks: number; atimeMs: number; mtimeMs: number; ctimeMs: number;
}

/**
 * The calls the filesystem makes. Each returns its result, or a negative
 * Linux errno (the kernel's convention).
 */
export interface KfsSys {
  /** lstat when `follow` is false */
  stat(path: string, follow: boolean): KfsStat | number;
  open(path: string, flags: number, mode: number): number;
  close(fd: number): number;
  pread(fd: number, buf: Uint8Array, off: number): number;
  pwrite(fd: number, data: Uint8Array, off: number): number;
  fstat(fd: number): KfsStat | number;
  readdir(path: string): string[] | number;
  mkdir(path: string, mode: number): number;
  unlink(path: string): number;
  rmdir(path: string): number;
  rename(from: string, to: string): number;
  symlink(target: string, path: string): number;
  readlink(path: string): string | number;
  truncate(path: string, size: number): number;
  chmod(path: string, mode: number): number;
  utimes(path: string, atimeMs: number, mtimeMs: number): number;
}

// Linux open(2) flags, the same numbers in Emscripten's libc and the kernel's ABI
const O_ACCMODE = 3, O_CREAT = 0o100, O_EXCL = 0o200;
const ENOENT = 2;
const S_IFMT = 0o170000, S_IFREG = 0o100000, S_IFDIR = 0o040000, S_IFLNK = 0o120000;

/** Linux errno → its name, for the ones a file call returns */
const ERRNO_NAMES: Record<number, string> = {
  1: 'EPERM', 2: 'ENOENT', 4: 'EINTR', 5: 'EIO', 9: 'EBADF', 11: 'EAGAIN', 12: 'ENOMEM', 13: 'EACCES', 16: 'EBUSY',
  17: 'EEXIST', 18: 'EXDEV', 19: 'ENODEV', 20: 'ENOTDIR', 21: 'EISDIR', 22: 'EINVAL', 23: 'ENFILE', 24: 'EMFILE',
  25: 'ENOTTY', 27: 'EFBIG', 28: 'ENOSPC', 29: 'ESPIPE', 30: 'EROFS', 31: 'EMLINK', 32: 'EPIPE', 36: 'ENAMETOOLONG',
  38: 'ENOSYS', 39: 'ENOTEMPTY', 40: 'ELOOP', 95: 'ENOTSUP',
};

/** The Emscripten errno for a (positive) Linux one; `codes` is Emscripten's ERRNO_CODES */
export function emErrno(linux: number, codes: Record<string, number>): number {
  return codes[ERRNO_NAMES[linux] ?? 'EIO'] ?? codes.EIO ?? 29;
}

/**
 * The filesystem object for `FS.mount(kfs, { root: '/home' }, '/home')`.
 * `FS` is Emscripten's (pyodide.FS), `codes` its errno numbers (pyodide.ERRNO_CODES).
 */
export function createKfs(FS: any, codes: Record<string, number>, sys: KfsSys): any {
  const fail = (r: number): never => { throw new FS.ErrnoError(emErrno(-r, codes)); };
  const ok = <T>(r: T | number): T => {
    if (typeof r === 'number' && r < 0) fail(r);
    return r as T;
  };

  const realPath = (node: any): string => {
    const parts: string[] = [];
    while (node.parent !== node) { parts.push(node.name); node = node.parent; }
    const root: string = node.mount.opts.root;
    parts.reverse();
    return parts.length ? (root === '/' ? '' : root) + '/' + parts.join('/') : root;
  };
  const child = (parent: any, name: string) => { const p = realPath(parent); return (p === '/' ? '' : p) + '/' + name; };

  const kfs: any = {
    mount(mount: any) {
      const st = ok(sys.stat(mount.opts.root, true)) as KfsStat;
      return kfs.createNode(null, '/', st.mode, 0);
    },
    createNode(parent: any, name: string, mode: number, dev: number) {
      const t = mode & S_IFMT;
      if (t !== S_IFREG && t !== S_IFDIR && t !== S_IFLNK) {
        // (a FIFO, a socket or a device of the tab: not reachable from Pyodide)
        throw new FS.ErrnoError(codes.EINVAL);
      }
      const node = FS.createNode(parent, name, mode, dev);
      node.node_ops = kfs.node_ops;
      node.stream_ops = kfs.stream_ops;
      return node;
    },
    node_ops: {
      getattr(node: any) {
        const st = ok(sys.stat(realPath(node), false)) as KfsStat;
        node.mode = st.mode;
        return {
          dev: st.dev, ino: st.ino, mode: st.mode, nlink: st.nlink, uid: st.uid, gid: st.gid, rdev: st.rdev,
          size: st.size, atime: new Date(st.atimeMs), mtime: new Date(st.mtimeMs), ctime: new Date(st.ctimeMs),
          blksize: st.blksize || 4096, blocks: st.blocks || Math.ceil(st.size / 512),
        };
      },
      setattr(node: any, attr: any) {
        const path = realPath(node);
        if (attr.mode !== undefined) {
          ok(sys.chmod(path, attr.mode & 0o7777));
          node.mode = attr.mode;
        }
        if (attr.size !== undefined) ok(sys.truncate(path, attr.size));
        // (Emscripten 4 passes atime/mtime; older ones a single timestamp)
        const at = attr.atime ?? attr.timestamp, mt = attr.mtime ?? attr.timestamp;
        if (at !== undefined || mt !== undefined) {
          const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Number(v));
          ok(sys.utimes(path, ms(at ?? mt), ms(mt ?? at)));
        }
      },
      lookup(parent: any, name: string) {
        const st = ok(sys.stat(child(parent, name), false)) as KfsStat;
        return kfs.createNode(parent, name, st.mode, 0);
      },
      mknod(parent: any, name: string, mode: number, dev: number) {
        const node = kfs.createNode(parent, name, mode, dev);
        const path = realPath(node);
        try {
          if ((mode & S_IFMT) === S_IFDIR) ok(sys.mkdir(path, mode & 0o7777));
          else ok(sys.close(ok(sys.open(path, O_CREAT | O_EXCL | 1, mode & 0o7777))));
        } catch (e) {
          FS.destroyNode?.(node);
          throw e;
        }
        return node;
      },
      rename(oldNode: any, newDir: any, newName: string) {
        ok(sys.rename(realPath(oldNode), child(newDir, newName)));
        oldNode.name = newName;
      },
      unlink(parent: any, name: string) { ok(sys.unlink(child(parent, name))); },
      rmdir(parent: any, name: string) { ok(sys.rmdir(child(parent, name))); },
      readdir(node: any) { return ['.', '..', ...(ok(sys.readdir(realPath(node))) as string[])]; },
      symlink(parent: any, newName: string, oldPath: string) {
        ok(sys.symlink(oldPath, child(parent, newName)));
        return kfs.createNode(parent, newName, S_IFLNK | 0o777, 0);
      },
      readlink(node: any) { return ok(sys.readlink(realPath(node))) as string; },
    },
    stream_ops: {
      open(stream: any) {
        if ((stream.node.mode & S_IFMT) !== S_IFREG) return; // a directory is read by name
        const path = realPath(stream.node);
        // (FS.open made the file and cut it to nothing already where the flags say so)
        let fd = sys.open(path, stream.flags & O_ACCMODE, 0o666);
        // The file went away since this node was looked up (another process), and O_CREAT asks for it
        if (fd === -ENOENT && (stream.flags & O_CREAT)) fd = sys.open(path, (stream.flags & O_ACCMODE) | O_CREAT, 0o666);
        stream.kfd = ok(fd);
        stream.shared.refcount = 1;
      },
      close(stream: any) {
        if (stream.kfd !== undefined && --stream.shared.refcount === 0) sys.close(stream.kfd);
      },
      dup(stream: any) { stream.shared.refcount++; },
      read(stream: any, buffer: Uint8Array, offset: number, length: number, position: number) {
        let done = 0;
        while (done < length) {
          const n = sys.pread(stream.kfd, buffer.subarray(offset + done, offset + length), position + done);
          if (n < 0) { if (done) break; fail(n); }
          if (n === 0) break;
          done += n;
        }
        return done;
      },
      write(stream: any, buffer: Uint8Array, offset: number, length: number, position: number) {
        if (length === 0) return 0;
        return ok(sys.pwrite(stream.kfd, buffer.subarray(offset, offset + length), position));
      },
      llseek(stream: any, offset: number, whence: number) {
        let position = offset;
        if (whence === 1) position += stream.position;
        else if (whence === 2 && stream.kfd !== undefined) position += (ok(sys.fstat(stream.kfd)) as KfsStat).size;
        if (position < 0) throw new FS.ErrnoError(codes.EINVAL);
        return position;
      },
    },
  };
  return kfs;
}
