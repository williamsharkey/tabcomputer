/**
 * inotify(7): watches on paths, and the events of what happens to them, as
 * Linux reports them.
 *
 * One event source: the FileSystem's change events (FileSystem.onChange),
 * which node-compat's fs.watch also listens to, so a change made anywhere
 * (a guest program, a shell builtin, the editor) reaches both. The kernel
 * adds what only it sees, the uses of its open files: IN_OPEN, IN_ACCESS,
 * IN_CLOSE_WRITE, IN_CLOSE_NOWRITE (fileEvent). A guest's write() goes into
 * the kernel's inode cache first; while the file is watched the kernel
 * reports it through the FileSystem when it happens (FileSystem.notify), and
 * the FileSystem's own event when the cache writes it back is an echo
 * inotify leaves out (fd.ts writeBackEcho).
 *
 * ABI (Linux syscall numbers; data as in kernel.ts):
 *   inotify_init1 294 (flags) → fd
 *   inotify_add_watch 254 (fd, pathLen, mask); data = path → wd
 *   inotify_rm_watch 255 (fd, wd)
 * Events read as struct inotify_event: wd i32, mask u32, cookie u32, len u32,
 * then the name NUL-padded to a multiple of 16 bytes (len).
 */
import * as A from './abi';
import type { KStat } from './abi';
import { type OpenFile, type OpenFileKind, type FileWatcher, ReadyListeners, abortableWait, charDevStat, fileWatchers, writeBackEcho } from './fd';
import type { FileSystem, FSChangeEvent } from '../filesystem';

export const IN_ACCESS = 0x1;
export const IN_MODIFY = 0x2;
export const IN_ATTRIB = 0x4;
export const IN_CLOSE_WRITE = 0x8;
export const IN_CLOSE_NOWRITE = 0x10;
export const IN_OPEN = 0x20;
export const IN_MOVED_FROM = 0x40;
export const IN_MOVED_TO = 0x80;
export const IN_CREATE = 0x100;
export const IN_DELETE = 0x200;
export const IN_DELETE_SELF = 0x400;
export const IN_MOVE_SELF = 0x800;
export const IN_Q_OVERFLOW = 0x4000;
export const IN_IGNORED = 0x8000;
export const IN_ONLYDIR = 0x1000000;
export const IN_DONT_FOLLOW = 0x2000000;
export const IN_EXCL_UNLINK = 0x4000000;
export const IN_MASK_CREATE = 0x10000000;
export const IN_MASK_ADD = 0x20000000;
export const IN_ISDIR = 0x40000000;
export const IN_ONESHOT = 0x80000000;
const IN_ALL_EVENTS = 0xfff;
/** Events about an entry of a watched directory, never about the watched object itself */
const CHILD_ONLY = IN_CREATE | IN_DELETE | IN_MOVED_FROM | IN_MOVED_TO;
/** Events about the watched object only */
const SELF_ONLY = IN_DELETE_SELF | IN_MOVE_SELF;
/** fs.inotify.max_queued_events, max_user_watches, max_user_instances (Linux's defaults) */
export const MAX_QUEUED_EVENTS = 16384;
export const MAX_USER_WATCHES = 65536;
export const MAX_USER_INSTANCES = 128;

interface Watch { file: InotifyFile; wd: number; path: string; mask: number; dir: boolean; orphan?: object }
interface Event { wd: number; mask: number; cookie: number; name: string }

const parentOf = (p: string) => p.slice(0, Math.max(1, p.lastIndexOf('/')));
const baseOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const enc = new TextEncoder();
/** An event's size: the header and the name, NUL-terminated and padded to 16 */
const sizeOf = (e: Event) => 16 + (e.name ? (enc.encode(e.name).length + 16) & ~15 : 0);

/** The watches of one kernel: by path, for every instance */
export class Inotify implements FileWatcher {
  private byPath = new Map<string, Set<Watch>>();
  private unsubscribe: (() => void) | null = null;
  private cookie = 0;
  /** Instances per uid (max_user_instances) */
  readonly instances = new Map<number, number>();
  constructor(private fs: () => FileSystem) {}

  /** Hear the kernel's open files of `fs` (fd.ts) */
  attach(fs: FileSystem): void { fileWatchers.set(fs, this); }

  /** Whether anything watches `path` or its directory (cheap: callers check before doing work) */
  watched(path: string): boolean {
    return this.byPath.size > 0 && (this.byPath.has(path) || this.byPath.has(parentOf(path)));
  }

  add(file: InotifyFile, path: string, mask: number, dir = false): number {
    const set = this.byPath.get(path);
    const old = set && [...set].find((w) => w.file === file);
    if (old) {
      if (mask & IN_MASK_CREATE) return -A.EEXIST;
      old.mask = (mask & IN_MASK_ADD ? old.mask : 0) | (mask & ~(IN_MASK_ADD | IN_MASK_CREATE | IN_ONLYDIR | IN_DONT_FOLLOW));
      return old.wd;
    }
    if (file.watches.size >= MAX_USER_WATCHES) return -A.ENOSPC;
    const w: Watch = { file, wd: file.nextWd++, path, mask: mask & ~(IN_MASK_ADD | IN_MASK_CREATE | IN_ONLYDIR | IN_DONT_FOLLOW), dir };
    file.watches.set(w.wd, w);
    if (set) set.add(w); else this.byPath.set(path, new Set([w]));
    this.unsubscribe ??= this.fs().onChange((ev, p, np, detail) => this.fsChange(ev, p, np, detail));
    return w.wd;
  }

  /** Watches of open, unlinked inodes (orphaned) */
  private orphans = new Map<object, Set<Watch>>();
  /** The names open, unlinked inodes had (until their last close) */
  private orphanPaths = new Map<object, string>();

  /** inotify_rm_watch, or the watch's object gone: IN_IGNORED, and the watch goes */
  remove(w: Watch): void {
    w.file.watches.delete(w.wd);
    const set = w.orphan ? this.orphans.get(w.orphan) : this.byPath.get(w.path);
    set?.delete(w);
    if (set && !set.size) { if (w.orphan) this.orphans.delete(w.orphan); else this.byPath.delete(w.path); }
    w.file.push({ wd: w.wd, mask: IN_IGNORED, cookie: 0, name: '' });
    if (!this.byPath.size) { this.unsubscribe?.(); this.unsubscribe = null; }
  }

  /** An instance closed: its watches go, with no events */
  closed(file: InotifyFile): void {
    for (const w of file.watches.values()) {
      const set = w.orphan ? this.orphans.get(w.orphan) : this.byPath.get(w.path);
      set?.delete(w);
      if (set && !set.size) { if (w.orphan) this.orphans.delete(w.orphan); else this.byPath.delete(w.path); }
    }
    file.watches.clear();
    if (!this.byPath.size) { this.unsubscribe?.(); this.unsubscribe = null; }
  }

  /** `mask` happened to `path` (a directory when `dir`): to its watches, and its directory's with its name */
  emit(path: string, mask: number, cookie = 0, dir = false): void {
    const isdir = dir ? IN_ISDIR : 0;
    // (the directory's watches first, then the object's own, as Linux: LTP inotify10)
    if (!(mask & SELF_ONLY) && path !== '/') {
      for (const w of [...this.byPath.get(parentOf(path)) ?? []]) this.deliver(w, mask | isdir, cookie, baseOf(path));
    }
    if (!(mask & CHILD_ONLY)) for (const w of [...this.byPath.get(path) ?? []]) this.deliver(w, mask | isdir, cookie, '');
  }

  private deliver(w: Watch, mask: number, cookie: number, name: string): void {
    if (!(w.mask & mask & IN_ALL_EVENTS)) return;
    w.file.push({ wd: w.wd, mask, cookie, name });
    if (w.mask & IN_ONESHOT) this.remove(w);
  }

  /** The object at `path` is gone: IN_DELETE_SELF, then IN_IGNORED, for its watches (and those below it) */
  private gone(path: string): void {
    for (const [p, set] of [...this.byPath]) {
      if (p !== path && !p.startsWith(path + '/')) continue;
      for (const w of [...set]) {
        if (w.mask & IN_DELETE_SELF) w.file.push({ wd: w.wd, mask: IN_DELETE_SELF, cookie: 0, name: '' });
        this.remove(w);
      }
    }
  }

  /** The FileSystem's change events (the one source; see the file comment) */
  fsChange(event: FSChangeEvent, path: string, newPath?: string, detail?: { created?: boolean; dir?: boolean; fd?: boolean }): void {
    if (!this.byPath.size) return;
    if (event === 'write' && writeBackEcho(this.fs(), path)) return;
    switch (event) {
      case 'write':
        // through a kernel descriptor: what it did (its close reports
        // itself); otherwise a whole file, written and closed (the shell, an
        // editor: `echo hi > f` is IN_CREATE, IN_MODIFY, IN_CLOSE_WRITE)
        if (detail?.fd) { this.emit(path, detail.created ? IN_CREATE : IN_MODIFY); break; }
        if (detail?.created) this.emit(path, IN_CREATE);
        this.emit(path, IN_MODIFY);
        this.emit(path, IN_CLOSE_WRITE);
        break;
      case 'mkdir': this.emit(path, IN_CREATE, 0, true); break;
      case 'attrib': this.emit(path, IN_ATTRIB, 0, !!detail?.dir); break;
      case 'delete': {
        // a file's last link: IN_ATTRIB on it first (its link count), then
        // IN_DELETE in its directory, IN_DELETE_SELF and IN_IGNORED (LTP
        // inotify04); a directory has no IN_ATTRIB
        const own = [...this.byPath.get(path) ?? []];
        const dir = !!detail?.dir || own.some((w) => w.dir);
        if (!dir) for (const w of own) this.deliver(w, IN_ATTRIB, 0, '');
        this.emit(path, IN_DELETE, 0, dir);
        this.gone(path);
        break;
      }
      case 'rename': {
        if (!newPath) break;
        const cookie = ++this.cookie >>> 0 || ++this.cookie;
        this.emit(path, IN_MOVED_FROM, cookie, !!detail?.dir);
        this.emit(newPath, IN_MOVED_TO, cookie, !!detail?.dir);
        // the moved object's watches: IN_MOVE_SELF, and they follow it
        for (const [p, set] of [...this.byPath]) {
          if (p !== path && !p.startsWith(path + '/')) continue;
          this.byPath.delete(p);
          const to = newPath + p.slice(path.length);
          const dest = this.byPath.get(to) ?? new Set<Watch>();
          for (const w of set) {
            if (p === path && (w.mask & IN_MOVE_SELF)) this.deliver(w, IN_MOVE_SELF, 0, '');
            w.path = to;
            if (w.file.watches.has(w.wd)) dest.add(w);
          }
          if (dest.size) this.byPath.set(to, dest);
        }
        break;
      }
    }
  }

  /**
   * `path`'s inode lost its last name while open: its watches go with it
   * (they hear what its fds do, but IN_EXCL_UNLINK ones), with IN_ATTRIB
   * now; IN_DELETE_SELF and IN_IGNORED come at its last close (LTP inotify12)
   */
  orphaned(ino: object, path: string): void {
    // (its directory's watches hear its fds too, as the name it had)
    this.orphanPaths.set(ino, path);
    const set = this.byPath.get(path);
    if (!set) return;
    this.byPath.delete(path);
    for (const w of set) { w.orphan = ino; this.deliver(w, IN_ATTRIB, 0, ''); }
    const live = [...set].filter((w) => w.file.watches.has(w.wd));
    if (live.length) this.orphans.set(ino, new Set(live));
    if (!this.byPath.size && !this.orphans.size) { this.unsubscribe?.(); this.unsubscribe = null; }
  }

  orphanEvent(ino: object, mask: number): void {
    const path = this.orphanPaths.get(ino);
    if (path !== undefined) {
      for (const w of [...this.byPath.get(parentOf(path)) ?? []]) if (!(w.mask & IN_EXCL_UNLINK)) this.deliver(w, mask, 0, baseOf(path));
    }
    for (const w of [...this.orphans.get(ino) ?? []]) if (!(w.mask & IN_EXCL_UNLINK)) this.deliver(w, mask, 0, '');
  }

  inodeGone(ino: object): void {
    this.orphanPaths.delete(ino);
    for (const w of [...this.orphans.get(ino) ?? []]) {
      if (w.mask & IN_DELETE_SELF) w.file.push({ wd: w.wd, mask: IN_DELETE_SELF, cookie: 0, name: '' });
      this.remove(w);
    }
  }

  /** What the kernel's open files see: IN_OPEN, IN_ACCESS, IN_CLOSE_WRITE, IN_CLOSE_NOWRITE */
  fileEvent(path: string, mask: number, dir = false): void {
    if (this.watched(path)) this.emit(path, mask, 0, dir);
  }
}

/** An inotify instance (inotify_init1): its watches and its queue of events */
export class InotifyFile implements OpenFile {
  kind: OpenFileKind = 'dev';
  readonly watches = new Map<number, Watch>();
  nextWd = 1;
  private queue: Event[] = [];
  private bytes = 0;
  private listeners = new ReadyListeners();
  private waiters = new Set<() => void>();
  constructor(private owner: Inotify, public flags: number, private uid = 0) {}

  push(e: Event): void {
    // the same event as the last one, still unread, is that one (Linux merges them)
    const last = this.queue[this.queue.length - 1];
    if (last && last.wd === e.wd && last.mask === e.mask && last.cookie === e.cookie && last.name === e.name) return;
    if (this.queue.length >= MAX_QUEUED_EVENTS) {
      if (last?.mask !== IN_Q_OVERFLOW) e = { wd: -1, mask: IN_Q_OVERFLOW, cookie: 0, name: '' };
      else return;
    }
    this.queue.push(e);
    this.bytes += sizeOf(e);
    for (const w of [...this.waiters]) w();
    this.listeners.fire();
  }

  async read(buf: Uint8Array, signal?: AbortSignal): Promise<number> {
    while (!this.queue.length) {
      if (this.flags & A.O_NONBLOCK) return -A.EAGAIN;
      if (!(await abortableWait(this.waiters, signal))) return -A.EINTR;
    }
    // whole events only; a buffer too small for the first is EINVAL
    if (sizeOf(this.queue[0]) > buf.length) return -A.EINVAL;
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.length);
    let off = 0;
    while (this.queue.length && off + sizeOf(this.queue[0]) <= buf.length) {
      const e = this.queue.shift()!;
      const n = sizeOf(e);
      this.bytes -= n;
      dv.setInt32(off, e.wd, true);
      dv.setUint32(off + 4, e.mask >>> 0, true);
      dv.setUint32(off + 8, e.cookie >>> 0, true);
      dv.setUint32(off + 12, n - 16, true);
      buf.fill(0, off + 16, off + n);
      if (e.name) buf.set(enc.encode(e.name), off + 16);
      off += n;
    }
    return off;
  }

  async write(): Promise<number> { return -A.EINVAL; }
  poll(events: number): number { return (this.queue.length ? A.POLLIN : 0) & events; }
  onReady(cb: () => void): () => void { return this.listeners.add(cb); }

  async ioctl(req: number, arg: Uint8Array): Promise<number> {
    if (req === A.FIONREAD && arg.length >= 4) {
      new DataView(arg.buffer, arg.byteOffset, 4).setInt32(0, this.bytes, true);
      return 0;
    }
    return -A.EINVAL;
  }

  async stat(): Promise<KStat> { return charDevStat(0); }
  async close(): Promise<void> {
    this.owner.closed(this);
    this.owner.instances.set(this.uid, Math.max(0, (this.owner.instances.get(this.uid) ?? 1) - 1));
    for (const w of [...this.waiters]) w();
  }

  /** inotify_rm_watch */
  removeWatch(wd: number): number {
    const w = this.watches.get(wd);
    if (!w) return -A.EINVAL;
    this.owner.remove(w);
    return 0;
  }
}
