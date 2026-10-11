/**
 * node:fs, node:fs/promises, node:url, node:buffer and node:process (plus the
 * Buffer and process globals, build.ts NODE_GLOBALS) for vitest suites run in
 * the tab (test-runner.ts, docs/HOTSWAP.md "Testing in the tab").
 *
 * The tab's filesystem is asynchronous, and suites read synchronously
 * (readFileSync of a fixture or a source file), so `hotswap test` reads the
 * checkout into a snapshot first (snapshotTree) and the suite's fs works in
 * memory on top of it. Writes (a mkdtempSync work directory, writeFileSync)
 * stay in that memory and are gone after the run: the tab's own files are
 * never touched, the checkout included.
 */
import { createFakeBuffer } from '../node-compat/buffer';

/** Absolute path → contents */
export type Snapshot = Map<string, Uint8Array>;

export interface SnapshotFs {
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isFile(): boolean; isDirectory(): boolean; size?: number }>;
  readFile(path: string): Promise<Uint8Array | string>;
}

/** Directories a snapshot skips: the checkout's tarball copy, dependencies, git */
const SKIP_DIRS = new Set(['.hotswap', 'node_modules', '.git', 'dist']);
const MAX_FILE = 8 << 20;

/** Read a directory tree into a snapshot (files over 8 MB are left out) */
export async function snapshotTree(fs: SnapshotFs, root: string, into: Snapshot = new Map()): Promise<Snapshot> {
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try { names = await fs.readdir(dir); } catch { return; }
    await Promise.all(names.map(async (name) => {
      const p = `${dir}/${name}`;
      let st;
      try { st = await fs.stat(p); } catch { return; }
      if (st.isDirectory()) { if (!SKIP_DIRS.has(name)) await walk(p); return; }
      if (!st.isFile() || (st.size ?? 0) > MAX_FILE) return;
      try {
        const data = await fs.readFile(p);
        into.set(p, typeof data === 'string' ? new TextEncoder().encode(data) : data);
      } catch { /* unreadable: left out */ }
    }));
  };
  await walk(root.replace(/\/+$/, '') || '/');
  return into;
}

type Node = { type: 'file'; data: Uint8Array; mode: number; mtime: number } | { type: 'dir'; mode: number; mtime: number };

const ERRNO: Record<string, [number, string]> = {
  ENOENT: [-2, 'no such file or directory'], EEXIST: [-17, 'file already exists'], ENOTDIR: [-20, 'not a directory'],
  EISDIR: [-21, 'illegal operation on a directory'], ENOTEMPTY: [-39, 'directory not empty'],
};

function fsError(code: string, syscall: string, path: string): Error {
  const [errno, text] = ERRNO[code];
  return Object.assign(new Error(`${code}: ${text}, ${syscall} '${path}'`), { code, errno, syscall, path });
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

function fileURLToPath(u: string | URL): string {
  const url = typeof u === 'string' ? new URL(u) : u;
  if (url.protocol !== 'file:') throw new TypeError(`The URL must be of scheme file: ${url.href}`);
  return decodeURIComponent(url.pathname);
}

/**
 * The node modules a suite gets in the tab, over a snapshot. `cwd` resolves
 * relative paths. Anything not implemented throws a message saying so.
 */
export function makeTestNode(snapshot: Snapshot, cwd = '/home/user') {
  const Buffer = createFakeBuffer();
  const nodes = new Map<string, Node>();
  const now = Date.now();
  const addDirs = (p: string) => {
    for (let d = p; !nodes.has(d); d = dirOf(d)) {
      nodes.set(d, { type: 'dir', mode: 0o755, mtime: now });
      if (d === '/') break;
    }
  };
  addDirs('/'); addDirs('/tmp'); addDirs(cwd);
  for (const [p, data] of snapshot) {
    const n = normalize(p);
    addDirs(dirOf(n));
    nodes.set(n, { type: 'file', data, mode: 0o644, mtime: now });
  }

  const pathOf = (p: unknown): string => {
    if (p instanceof URL) return fileURLToPath(p);
    if (typeof p === 'string' && p.startsWith('file:')) return fileURLToPath(p);
    if (p instanceof Uint8Array) p = new TextDecoder().decode(p);
    if (typeof p !== 'string') throw new TypeError(`The "path" argument must be of type string, URL or Buffer. Received ${typeof p}`);
    return normalize(p.startsWith('/') ? p : `${cwd}/${p}`);
  };
  const encodingOf = (o: unknown): string | undefined => (typeof o === 'string' ? o : (o as any)?.encoding ?? undefined);
  const get = (p: string, syscall: string): Node => {
    const n = nodes.get(p);
    if (n) return n;
    // ENOTDIR when a parent is a file
    for (let d = dirOf(p); d !== '/'; d = dirOf(d)) if (nodes.get(d)?.type === 'file') throw fsError('ENOTDIR', syscall, p);
    throw fsError('ENOENT', syscall, p);
  };
  const parentDir = (p: string, syscall: string) => {
    const d = nodes.get(dirOf(p));
    if (!d) throw fsError('ENOENT', syscall, p);
    if (d.type !== 'dir') throw fsError('ENOTDIR', syscall, p);
  };
  const bytes = (data: unknown, enc?: string): Uint8Array => {
    if (typeof data === 'string') return enc && enc !== 'utf8' && enc !== 'utf-8' ? new Uint8Array(Buffer.from(data, enc)) : new TextEncoder().encode(data);
    if (data instanceof Uint8Array) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
    return new TextEncoder().encode(String(data));
  };
  const out = (data: Uint8Array, enc?: string) => (enc && enc !== 'buffer' ? Buffer.from(data).toString(enc) : Buffer.from(data));
  const children = (p: string) => {
    const pre = p === '/' ? '/' : p + '/';
    const names: string[] = [];
    for (const k of nodes.keys()) if (k !== p && k.startsWith(pre) && !k.slice(pre.length).includes('/')) names.push(k.slice(pre.length));
    return names.sort();
  };
  const statOf = (n: Node) => {
    const size = n.type === 'file' ? n.data.length : 4096;
    const t = new Date(n.mtime);
    return {
      dev: 1, ino: 0, mode: (n.type === 'dir' ? 0o040000 : 0o100000) | n.mode, nlink: 1, uid: 1000, gid: 1000, rdev: 0,
      size, blksize: 4096, blocks: Math.ceil(size / 512), atimeMs: n.mtime, mtimeMs: n.mtime, ctimeMs: n.mtime, birthtimeMs: n.mtime,
      atime: t, mtime: t, ctime: t, birthtime: t,
      isFile: () => n.type === 'file', isDirectory: () => n.type === 'dir', isSymbolicLink: () => false,
      isFIFO: () => false, isSocket: () => false, isBlockDevice: () => false, isCharacterDevice: () => false,
    };
  };
  const dirent = (dir: string, name: string) => {
    const n = nodes.get(dir === '/' ? `/${name}` : `${dir}/${name}`)!;
    return { name, parentPath: dir, path: dir, isFile: () => n.type === 'file', isDirectory: () => n.type === 'dir', isSymbolicLink: () => false };
  };
  const mkdir = (p: string, recursive: boolean): string | undefined => {
    const existing = nodes.get(p);
    if (existing) { if (recursive && existing.type === 'dir') return undefined; throw fsError('EEXIST', 'mkdir', p); }
    if (!recursive) { parentDir(p, 'mkdir'); nodes.set(p, { type: 'dir', mode: 0o755, mtime: Date.now() }); return undefined; }
    let first: string | undefined;
    const missing: string[] = [];
    for (let d = p; !nodes.has(d); d = dirOf(d)) missing.unshift(d);
    if (nodes.get(dirOf(missing[0]))?.type === 'file') throw fsError('ENOTDIR', 'mkdir', p);
    for (const d of missing) { first ??= d; nodes.set(d, { type: 'dir', mode: 0o755, mtime: Date.now() }); }
    return first;
  };
  const write = (p: string, data: Uint8Array, append: boolean, mode?: number) => {
    const n = nodes.get(p);
    if (n?.type === 'dir') throw fsError('EISDIR', 'open', p);
    if (!n) parentDir(p, 'open');
    const old = append && n?.type === 'file' ? n.data : null;
    const merged = old ? new Uint8Array(old.length + data.length) : data;
    if (old) { merged.set(old); merged.set(data, old.length); }
    nodes.set(p, { type: 'file', data: merged, mode: mode ?? (n?.mode ?? 0o644), mtime: Date.now() });
  };
  const rm = (p: string, opts: { recursive?: boolean; force?: boolean } = {}, syscall = 'rm') => {
    const n = nodes.get(p);
    if (!n) { if (opts.force) return; throw fsError('ENOENT', syscall, p); }
    if (n.type === 'dir') {
      if (!opts.recursive && children(p).length) throw fsError(syscall === 'rmdir' ? 'ENOTEMPTY' : 'EISDIR', syscall, p);
      for (const k of [...nodes.keys()]) if (k.startsWith(p + '/')) nodes.delete(k);
    }
    nodes.delete(p);
  };
  let tmpSeq = 0;

  const fs: any = {
    constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, O_RDONLY: 0, O_WRONLY: 1, O_RDWR: 2, O_CREAT: 64, O_EXCL: 128, O_TRUNC: 512, O_APPEND: 1024, COPYFILE_EXCL: 1 },
    existsSync: (p: unknown) => { try { return nodes.has(pathOf(p)); } catch { return false; } },
    readFileSync(p: unknown, o?: unknown) {
      const path = pathOf(p), n = get(path, 'open');
      if (n.type === 'dir') throw fsError('EISDIR', 'read', path);
      return out(n.data, encodingOf(o));
    },
    writeFileSync(p: unknown, data: unknown, o?: any) { write(pathOf(p), bytes(data, encodingOf(o)), o?.flag === 'a', o?.mode); },
    appendFileSync(p: unknown, data: unknown, o?: any) { write(pathOf(p), bytes(data, encodingOf(o)), true, o?.mode); },
    statSync(p: unknown, o?: any) {
      try { return statOf(get(pathOf(p), 'stat')); } catch (e) { if (o?.throwIfNoEntry === false) return undefined; throw e; }
    },
    readdirSync(p: unknown, o?: any) {
      const path = pathOf(p), n = get(path, 'scandir');
      if (n.type !== 'dir') throw fsError('ENOTDIR', 'scandir', path);
      if (o?.recursive) {
        const all: string[] = [];
        const walk = (d: string, rel: string) => { for (const c of children(d)) { const r = rel ? `${rel}/${c}` : c; all.push(r); if (nodes.get(`${d === '/' ? '' : d}/${c}`)!.type === 'dir') walk(`${d === '/' ? '' : d}/${c}`, r); } };
        walk(path, '');
        return o.withFileTypes ? all.map((r) => dirent(dirOf(`${path}/${r}`), r.split('/').pop()!)) : all;
      }
      return o?.withFileTypes ? children(path).map((c) => dirent(path, c)) : children(path);
    },
    mkdirSync: (p: unknown, o?: any) => mkdir(pathOf(p), typeof o === 'object' && !!o?.recursive),
    mkdtempSync(prefix: string) {
      const base = pathOf(prefix);
      parentDir(base, 'mkdtemp');
      let p: string;
      do p = `${base}${(Date.now() + tmpSeq++).toString(36).slice(-6)}`; while (nodes.has(p));
      nodes.set(p, { type: 'dir', mode: 0o700, mtime: Date.now() });
      return p;
    },
    rmSync: (p: unknown, o?: any) => rm(pathOf(p), o),
    rmdirSync: (p: unknown, o?: any) => rm(pathOf(p), { recursive: !!o?.recursive }, 'rmdir'),
    unlinkSync(p: unknown) {
      const path = pathOf(p);
      if (get(path, 'unlink').type === 'dir') throw fsError('EISDIR', 'unlink', path);
      nodes.delete(path);
    },
    copyFileSync(a: unknown, b: unknown) {
      const from = pathOf(a), n = get(from, 'copyfile');
      if (n.type === 'dir') throw fsError('EISDIR', 'copyfile', from);
      write(pathOf(b), n.data, false, n.mode);
    },
    renameSync(a: unknown, b: unknown) {
      const from = pathOf(a), to = pathOf(b), n = get(from, 'rename');
      parentDir(to, 'rename');
      for (const k of [...nodes.keys()]) if (k === from || k.startsWith(from + '/')) { nodes.set(to + k.slice(from.length), nodes.get(k)!); nodes.delete(k); }
      void n;
    },
    accessSync: (p: unknown) => { get(pathOf(p), 'access'); },
    chmodSync: (p: unknown, mode: number) => { get(pathOf(p), 'chmod').mode = mode & 0o7777; },
    realpathSync: (p: unknown) => { const path = pathOf(p); get(path, 'realpath'); return path; },
    utimesSync: (p: unknown, _a: unknown, m: number | Date) => { get(pathOf(p), 'utime').mtime = m instanceof Date ? m.getTime() : m * 1000; },
  };
  fs.lstatSync = fs.statSync;
  fs.realpathSync.native = fs.realpathSync;
  fs.cpSync = (a: unknown, b: unknown, o?: any) => {
    const from = pathOf(a), to = pathOf(b), n = get(from, 'cp');
    if (n.type === 'file') { fs.copyFileSync(from, to); return; }
    if (!o?.recursive) throw Object.assign(new Error(`Recursive option is required to copy a directory: ${from}`), { code: 'ERR_FS_EISDIR' });
    mkdir(to, true);
    for (const c of children(from)) fs.cpSync(`${from}/${c}`, `${to}/${c}`, o);
  };

  // The callback-less promise API over the same calls
  const promises: any = {};
  const asyncOf = (name: string) => (...a: unknown[]) => new Promise((res, rej) => { try { res(fs[`${name}Sync`](...a)); } catch (e) { rej(e); } });
  for (const name of ['readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'readdir', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'copyFile', 'rename', 'access', 'chmod', 'realpath', 'utimes', 'cp']) {
    promises[name] = asyncOf(name);
    // and the callback API
    fs[name] = (...a: any[]) => {
      const cb = typeof a[a.length - 1] === 'function' ? a.pop() : null;
      (promises[name](...a) as Promise<unknown>).then((v) => cb?.(null, v), (e) => cb?.(e));
    };
  }
  fs.exists = (p: unknown, cb: (b: boolean) => void) => queueMicrotask(() => cb(fs.existsSync(p)));
  fs.promises = promises;
  promises.constants = fs.constants;

  // A missing name throws when used. esbuild's __toESM makes the namespace from the
  // module's prototype, so the thrower is the prototype too (as build.ts's hs-stub)
  const unsupported = (mod: string, obj: any) => {
    const thrower = new Proxy({}, {
      get(_t, k) {
        if (typeof k === 'symbol' || k === 'then' || k === '__esModule') return undefined;
        throw new Error(`node:${mod} in the tab has no ${String(k)} (hotswap test's fs works in memory on a snapshot of the checkout)`);
      },
    });
    return new Proxy(obj, {
      get: (t, k) => (k in t || typeof k === 'symbol' || k === 'then' || k === '__esModule' ? t[k] : (thrower as any)[k]),
      getPrototypeOf: () => thrower,
    });
  };
  const url = { fileURLToPath, pathToFileURL: (p: string) => new URL(`file://${encodeURI(pathOf(p))}`), URL, URLSearchParams };
  // node's process, enough for suites that read process.env or process.cwd()
  const t0 = performance.now();
  const noop = () => proc;
  const proc: any = {
    env: { HOME: '/home/user', USER: 'user', PATH: '/usr/local/bin:/usr/bin:/bin', TMPDIR: '/tmp', SHELL: '/bin/sh', LANG: 'C.UTF-8' },
    cwd: () => cwd, chdir: () => { throw new Error('process.chdir() in the tab: use paths'); },
    platform: 'linux', arch: 'x64', argv: ['/usr/bin/node', 'vitest'], execArgv: [], execPath: '/usr/bin/node',
    version: 'v22.0.0', versions: { node: '22.0.0' }, release: { name: 'node' }, pid: 1, ppid: 0, exitCode: undefined,
    nextTick: (f: (...a: unknown[]) => void, ...a: unknown[]) => queueMicrotask(() => f(...a)),
    hrtime: Object.assign((prev?: [number, number]) => {
      const ns = Math.round((performance.now() - t0) * 1e6), s = Math.floor(ns / 1e9), n = ns % 1e9;
      return prev ? [s - prev[0] - (n < prev[1] ? 1 : 0), (n - prev[1] + 1e9) % 1e9] : [s, n];
    }, { bigint: () => BigInt(Math.round((performance.now() - t0) * 1e6)) }),
    uptime: () => (performance.now() - t0) / 1000,
    memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0, arrayBuffers: 0 }),
    on: noop, once: noop, off: noop, addListener: noop, removeListener: noop, removeAllListeners: noop, emit: () => false, listenerCount: () => 0,
    exit: (code?: number) => { throw new Error(`process.exit(${code ?? ''}) in a test in the tab`); },
    stdout: { write: () => true, isTTY: false, columns: 80 }, stderr: { write: () => true, isTTY: false }, stdin: { isTTY: false },
  };
  return {
    process: proc,
    fs: unsupported('fs', fs),
    'fs/promises': unsupported('fs/promises', promises),
    url: { ...url, default: url },
    buffer: { Buffer, default: { Buffer } },
    Buffer,
  };
}
