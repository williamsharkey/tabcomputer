/**
 * Snapshots of started GUI apps (docs/research/GUI_SNAPSHOTS.md). The setting
 * is in snapshot-setting.ts: on by default for the apps the test restores.
 *
 * A GTK or Qt app spends its launch computing the same start-up every time
 * (docs/GUI_LAUNCH.md). With snapshots on, the first start of an app is kept:
 * once its window is up and it has gone quiet, the engine writes the image
 * of each of its processes (every page of memory, every thread's registers:
 * Blink patch 0551), and the page keeps what the kernel and the X server
 * hold for them. The next launch rebuilds the processes from that instead
 * of running the program:
 *
 * - each image goes to a new Blink worker (`blinkRunner(path, image)`),
 *   whose threads go on where they were, a waiting system call run again;
 *   children are started under their parent, with the pids they had;
 * - their open files are made again from records, once each however many
 *   descriptors and processes hold them: the launcher's stdio, eventfds,
 *   inotify watches, pipes and socket pairs between them, a listening socket
 *   bound to its path, read-only files by path and offset, the X connection;
 * - the X server gets the client back by playing its recorded requests into
 *   a client with the same number (src/x11/display.ts `adoptXClient`): the
 *   windows, pixmaps, glyphs and properties are rebuilt as they were made, and
 *   the window is on screen before the process runs.
 *
 * A snapshot is used only while what it was made from is unchanged: the
 * build, the engine's version, the app's packages, its arguments and
 * environment, the screen, and every path its processes opened, looked at
 * or listed (system files by size and time, settings under a dot name in
 * /home by their lines, any other file by its bytes, a listed directory by
 * its names, caches not at all), and for two weeks at most. One that is
 * outdated is taken again in the background (retake.ts). It holds the
 * processes' memory, so it never leaves the profile's own IndexedDB, and
 * an app that read a sign-in gets none.
 */
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import type { OpenFile } from '../kernel/fd';
import type { XRecording } from '../x11/display';
import type { XServer } from '../x11/server';
import type { EngineCheckpoint } from '../x86-engine/blink';

import { credentialFileReason } from '../credentials';
import { snapshotsOn } from './snapshot-setting';
export { snapshotsOn as snapshotsEnabled, setSnapshotsEnabled } from './snapshot-setting';

const ATOMS = 'tabcomputer-x-atoms';
const SLOTS = 'tabcomputer-gui-snapshot-slots';
const SKIP = 'tabcomputer-gui-snapshot-skip';
const DB = 'tabcomputer-gui-snapshots';
export const VERSION = 3;

/**
 * The most the snapshots take together, in bytes of what is stored (gzip).
 * 256 MB holds the corpus's five largest at once (GIMP 85, Inkscape 67,
 * FeatherPad 36, Mousepad 33, Geany 20: docs/research/GUI_SNAPSHOTS.md) and
 * is small beside a Debian install. Never more than a tenth of what the
 * browser says the site may still use: storage that is not persisted is
 * deleted whole when the disk runs low, and snapshots must not be why.
 */
export const SNAPSHOT_CAP = 256_000_000;
/** A snapshot older than this is taken again: what the checks below can't see (a clock, a file read through another path) is bounded by it */
export const MAX_AGE_MS = 14 * 24 * 3600_000;

const ls = (): Storage | null => { try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; } };

// ── what a snapshot holds ──

/** An open file, as what makes it again. Processes name them by number: a pipe's two ends, or a file two processes inherited, are one each. */
export type FileRecord =
  | { flags: number; kind: 'stdin' | 'output' | 'null' | 'x11' }
  | { flags: number; kind: 'event'; count: number; semaphore: boolean }
  | { flags: number; kind: 'listen'; address: string }
  | { flags: number; kind: 'file'; path: string; pos: number }
  /** One end of a pipe whose every end is held by the snapshot's processes, and empty; `pipe` numbers the pipes */
  | { flags: number; kind: 'pipe'; pipe: number; end: 'r' | 'w' }
  /** One side of a connected socket pair both of whose sides the snapshot's processes hold, nothing queued; `pair` numbers them */
  | { flags: number; kind: 'pair'; pair: number; side: 0 | 1; type: number }
  /** An inotify instance with nothing queued: its watches, by watch descriptor */
  | { flags: number; kind: 'inotify'; watches: [number, string, number, boolean][]; nextWd: number };

export interface ProcRecord {
  /** The pid it had: its windows' _NET_WM_PID, and what its parent and children know it by */
  pid: number;
  /** Its parent's place in `procs` (-1: the page started it) */
  parent: number;
  path: string; argv: string[]; env: Record<string, string>; cwd: string; umask: number;
  signals: { dispositions: [number, 'default' | 'ignore' | number][]; actions: [number, { flags: number; mask: number[]; restorer: number }][]; mask: number[] };
  /** Descriptor → the open file's place in `files` */
  fds: { fd: number; cloexec: boolean; file: number }[];
  /** Its image's bytes, unpacked */
  image: number;
}

export interface SnapshotMeta {
  v: number;
  app: string;
  /** What it was made from (snapshotKey): another key, another snapshot */
  key: string;
  taken: number;
  /** Taken from a start nobody saw (retake.ts) */
  hidden?: boolean;
  /** The app's process first, then its children, each after its parent */
  procs: ProcRecord[];
  files: FileRecord[];
  /** The X client: its number, the server's atoms when it was taken (ids from 1), how many request bytes, the server's time */
  x: { index: number; atoms: string[]; bytes: number; time: number };
  /** Every path the processes opened or looked for, with what was there ('' nothing) */
  opened: [string, string][];
  sizes: { image: number; stored: number; x: number };
}

/** `images`: each process's image, gzipped, in `procs`' order; `x`: the client's request bytes, gzipped */
export interface StoredSnapshot { meta: SnapshotMeta; images: ArrayBuffer[]; x: ArrayBuffer }

// ── storage: the profile's own IndexedDB ──

/** What is known of a stored snapshot without reading its images: the index store's value */
export interface IndexEntry { meta: SnapshotMeta; used: number }

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      // (version 1 kept each snapshot whole under one key: those were made by another VERSION)
      if (db.objectStoreNames.contains('snapshots')) db.deleteObjectStore('snapshots');
      db.createObjectStore('snapshots');
      if (!db.objectStoreNames.contains('index')) db.createObjectStore('index');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (snapshots: IDBObjectStore, index: IDBObjectStore) => IDBRequest<T> | null): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const t = db.transaction(['snapshots', 'index'], mode);
      const r = run(t.objectStore('snapshots'), t.objectStore('index'));
      t.oncomplete = () => resolve(r?.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

/** The stored snapshots, without their images */
export const listSnapshots = (): Promise<IndexEntry[]> => tx<IndexEntry[]>('readonly', (_s, i) => i.getAll()).then((v) => v ?? [], () => []);
export const snapshotEntry = (app: string): Promise<IndexEntry | null> => tx<IndexEntry | undefined>('readonly', (_s, i) => i.get(app)).then((v) => v ?? null, () => null);

export async function loadSnapshot(app: string): Promise<StoredSnapshot | null> {
  try {
    const entry = await snapshotEntry(app);
    if (!entry) return null;
    const body = await tx<{ images: ArrayBuffer[]; x: ArrayBuffer } | undefined>('readonly', (s) => s.get(app));
    return body ? { meta: entry.meta, images: body.images, x: body.x } : null;
  } catch { return null; }
}

/**
 * Keep `snap`, then drop the least recently used ones until the total is
 * within the cap. Returns the apps dropped. One that is over the cap alone
 * is not kept (the answer is its own app), and the others stay.
 */
export async function saveSnapshot(snap: StoredSnapshot, cap?: number): Promise<string[]> {
  const app = snap.meta.app;
  cap ??= await snapshotCap();
  if (snap.meta.sizes.stored > cap) { await dropSnapshot(app); return [app]; }
  await tx('readwrite', (s, i) => { s.put({ images: snap.images, x: snap.x }, app); return i.put({ meta: snap.meta, used: Date.now() } satisfies IndexEntry, app); });
  const drop = evictions(await listSnapshots(), cap, app);
  for (const a of drop) { await dropSnapshot(a); releaseClientNumber(a); }
  return drop;
}

export const dropSnapshot = (app: string): Promise<unknown> => tx('readwrite', (s, i) => { s.delete(app); return i.delete(app); }).catch(() => undefined);
export const dropAllSnapshots = (): Promise<unknown> => tx('readwrite', (s, i) => { s.clear(); return i.clear(); }).catch(() => undefined);

/** `app`'s snapshot was used now (a restore): the least recently used go first when space is needed */
export async function touchSnapshot(app: string): Promise<void> {
  // (one transaction: a snapshot that was dropped meanwhile is not put back)
  await tx('readwrite', (_s, i) => {
    const got = i.get(app) as IDBRequest<IndexEntry | undefined>;
    got.onsuccess = () => { if (got.result) i.put({ ...got.result, used: Date.now() }, app); };
    return null;
  }).catch(() => undefined);
}

/**
 * Which snapshots go so that the rest fit in `cap` bytes: the least recently
 * used first, the one just kept (`keep`) last. When that one is over the cap
 * alone, it goes and the others stay.
 */
export function evictions(entries: IndexEntry[], cap: number, keep?: string): string[] {
  const kept = keep === undefined ? undefined : entries.find((e) => e.meta.app === keep);
  if (kept && kept.meta.sizes.stored > cap) return evictions(entries.filter((e) => e !== kept), cap).concat(keep!);
  let total = entries.reduce((a, e) => a + e.meta.sizes.stored, 0);
  const out: string[] = [];
  const order = [...entries].sort((a, b) => (a.meta.app === keep ? 1 : b.meta.app === keep ? -1 : a.used - b.used));
  for (const e of order) {
    if (total <= cap) break;
    out.push(e.meta.app);
    total -= e.meta.sizes.stored;
  }
  return out;
}

/** The cap now: SNAPSHOT_CAP, or a tenth of what the site may still use when that is less */
export async function snapshotCap(estimate?: { usage?: number; quota?: number } | null, ours?: number): Promise<number> {
  try {
    const est = estimate === undefined ? await (globalThis as { navigator?: Navigator }).navigator?.storage?.estimate?.() : estimate;
    if (!est || !est.quota) return SNAPSHOT_CAP;
    ours ??= (await listSnapshots()).reduce((a, e) => a + e.meta.sizes.stored, 0);
    const free = Math.max(0, est.quota - (est.usage ?? 0)) + ours;
    return Math.min(SNAPSHOT_CAP, Math.floor(free / 10));
  } catch { return SNAPSHOT_CAP; }
}

/** What the snapshots take: for `doctor` and Settings */
export async function snapshotUsage(): Promise<{ apps: { app: string; stored: number; taken: number; used: number }[]; total: number; cap: number }> {
  const entries = await listSnapshots();
  const apps = entries.map((e) => ({ app: e.meta.app, stored: e.meta.sizes.stored, taken: e.meta.taken, used: e.used })).sort((a, b) => b.stored - a.stored);
  const total = apps.reduce((a, e) => a + e.stored, 0);
  return { apps, total, cap: await snapshotCap(undefined, total) };
}

async function pipe(data: Uint8Array, through: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<ArrayBuffer> {
  return new Response(new Blob([data as BlobPart]).stream().pipeThrough(through as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).arrayBuffer();
}
export const gzip = (data: Uint8Array): Promise<ArrayBuffer> => pipe(data, new CompressionStream('gzip') as never);
export const gunzip = (data: Uint8Array): Promise<ArrayBuffer> => pipe(data, new DecompressionStream('gzip') as never);

// ── the X side: stable atoms and client numbers ──

/**
 * Clients hold atom ids, and a restored one holds those of the session it was
 * started in. With snapshots on, the server's atom table is the profile's:
 * loaded when the server starts, saved as it grows, so an atom keeps its id
 * across page loads.
 */
export async function keepAtoms(server: XServer): Promise<void> {
  const store = ls();
  if (!store || !snapshotsOn()) return;
  const adopt = (text: string | null): boolean => {
    try {
      const saved = JSON.parse(text ?? '[]') as string[];
      return !Array.isArray(saved) || server.adoptAtoms(saved);
    } catch { return false; }
  };
  if (!adopt(store.getItem(ATOMS))) store.removeItem(ATOMS);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let full = false;
  const save = () => {
    timer = null;
    if (full) return;
    // (another tab of the profile may have saved since: take its atoms first, so the two tables stay one.
    // Where they can't be, each tab keeps its own, and a snapshot from the other is refused at restore)
    adopt(store.getItem(ATOMS));
    const names = server.atomNames();
    // A client that makes up atom names without end would fill the profile's storage: stop keeping them
    if (names.length > MAX_KEPT_ATOMS) { full = true; store.removeItem(ATOMS); return; }
    try { store.setItem(ATOMS, JSON.stringify(names)); } catch { /* full: the next snapshot is checked against the table anyway */ }
  };
  server.hooks.atomAdded = () => { timer ??= setTimeout(save, 300); };
  (globalThis as { addEventListener?: (t: string, f: (e: { key: string | null; newValue: string | null }) => void) => void }).addEventListener?.('storage', (e) => { if (e.key === ATOMS && e.newValue) adopt(e.newValue); });
}
const MAX_KEPT_ATOMS = 4000;

/** The X client number an app's snapshots use: one of the reserved ones, the same every time */
export function clientNumberFor(app: string, first: number, last: number): number | null {
  const store = ls();
  let slots: Record<string, number> = {};
  try { slots = JSON.parse(store?.getItem(SLOTS) ?? '{}') as Record<string, number>; } catch { /* start over */ }
  if (typeof slots[app] === 'number' && slots[app] >= first && slots[app] <= last) return slots[app];
  const used = new Set(Object.values(slots));
  for (let n = first; n <= last; n++) {
    if (used.has(n)) continue;
    slots[app] = n;
    try { store?.setItem(SLOTS, JSON.stringify(slots)); } catch { /* not kept: it is asked again */ }
    return n;
  }
  return null;
}

/** Give `app`'s client number back (its snapshot was dropped for space) */
export function releaseClientNumber(app: string): void {
  const store = ls();
  try {
    const slots = JSON.parse(store?.getItem(SLOTS) ?? '{}') as Record<string, number>;
    if (!(app in slots)) return;
    delete slots[app];
    store?.setItem(SLOTS, JSON.stringify(slots));
  } catch { /* stays taken */ }
}

/**
 * Apps that can't be snapshotted as they are (a shell on a pty, a connection
 * to the session bus, never quiet), with the key that was true for: asked
 * again only when the key changes. Without it every quit would start the app
 * again in the background to find the same thing out.
 */
interface Skip { key: string; ids: string; why: string }
export function skipReason(app: string, key: string): string | null {
  try {
    const all = JSON.parse(ls()?.getItem(SKIP) ?? '{}') as Record<string, Skip>;
    return all[app] && all[app].key === keyHash(key) ? all[app].why : null;
  } catch { return null; }
}
/** The same without the key (which takes the display to work out): `app` was found unfit on this build and engine */
export function skippedOnThisBuild(app: string): boolean {
  try {
    const all = JSON.parse(ls()?.getItem(SKIP) ?? '{}') as Record<string, Skip>;
    const ids = buildIds();
    return !!all[app] && all[app].ids === `${ids.build}|${ids.engine}`;
  } catch { return false; }
}
export function setSkip(app: string, key: string, why: string | null): void {
  const store = ls();
  try {
    const all = JSON.parse(store?.getItem(SKIP) ?? '{}') as Record<string, Skip>;
    const ids = buildIds();
    if (why === null) { if (!(app in all)) return; delete all[app]; } else all[app] = { key: keyHash(key), ids: `${ids.build}|${ids.engine}`, why };
    store?.setItem(SKIP, JSON.stringify(all));
  } catch { /* asked again next time */ }
}
function keyHash(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

// ── validity ──

export interface KeyParts { app: string; argv: string[]; env: Record<string, string>; packages: string[]; screen: [number, number, number]; textMode: string }

/**
 * The build and the engine this page runs: `engine` is the directory the
 * Blink engine is loaded from, named by the content of its files
 * (vite-plugin-engines.ts), so a rebuilt engine is another key.
 */
export function buildIds(): { build: string; engine: string } {
  const g = globalThis as { __guiSnapshotBuild?: string; __guiSnapshotEngine?: string };
  return {
    build: g.__guiSnapshotBuild ?? (typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : ''),
    engine: g.__guiSnapshotEngine ?? (typeof __BLINK_ENGINE_DIR__ === 'string' ? __BLINK_ENGINE_DIR__ : ''),
  };
}

/** Everything a snapshot depends on that is known before the process runs */
export function snapshotKey(p: KeyParts, ids: { build: string; engine: string } = buildIds()): string {
  return JSON.stringify({ v: VERSION, build: ids.build, engine: ids.engine, app: p.app, argv: p.argv, env: Object.entries(p.env).sort(([a], [b]) => (a < b ? -1 : 1)), packages: p.packages, screen: p.screen, text: p.textMode });
}

const KEY_WORDS: Record<string, string> = { v: 'the snapshot format', build: 'the build', engine: 'the engine', app: 'the app', argv: 'its arguments', env: 'its environment', packages: 'its packages', screen: 'the screen', text: 'the text mode' };

/** What differs between two keys, in words ("the engine and the screen") */
export function keyChange(was: string, now: string): string {
  try {
    const a = JSON.parse(was) as Record<string, unknown>, b = JSON.parse(now) as Record<string, unknown>;
    const names = Object.keys(KEY_WORDS).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k])).map((k) => KEY_WORDS[k]);
    if (names.length) return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  } catch { /* not keys of this form */ }
  return 'what it was made from';
}

async function sha256(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Under a dot name in a home directory: an app's settings, not someone's document */
const SETTINGS_PATH = /^\/(?:home\/[^/]+|root)\/(?:.*\/)?\.[^/]+(?:\/|$)/;
/** Debian's files and tabcomputer's own: what packages write. Everything else is the person's */
const SYSTEM_PATH = /^\/(?:usr|etc|lib|lib64|bin|sbin|var|opt|boot|run)\//;
const MAX_HASHED = 16 << 20;

/**
 * What is at `path`, as a short string. '' is nothing; a directory is 'dir',
 * and `path/` (a directory the process listed) is the names in it. A system
 * file is its size and time. A file anywhere else is its bytes, so a document
 * that was open when the snapshot was taken and has changed since outdates
 * it; except settings (a file under a dot name in a home directory), which
 * are their lines whatever the order: GIMP rewrites controllerrc at every
 * exit from a hash table, the same entries in another order, and that is not
 * another setting.
 */
async function fileSignature(fs: FileSystem, path: string): Promise<string> {
  if (path.endsWith('/') && path.length > 1) {
    const names = await fs.readdir(path.slice(0, -1)).catch(() => null);
    return names ? 'l' + await sha256(new TextEncoder().encode([...names].sort().join('\n'))) : '';
  }
  const st = await fs.stat(path).catch(() => null);
  if (!st) return '';
  if (st.isDirectory()) return 'dir';
  const byTime = `${st.size}:${Math.floor(Number(st.mtime instanceof Date ? st.mtime.getTime() : st.mtime ?? 0))}`;
  if (SYSTEM_PATH.test(path) || st.size > MAX_HASHED) return byTime;
  const data = await fs.readFile(path).catch(() => null);
  if (data === null) return '';
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  if (!SETTINGS_PATH.test(path)) return 'c' + await sha256(bytes);
  // (text of a sensible size: sorted lines; anything else as it is)
  const text = bytes.length < (1 << 20) && !bytes.includes(0) ? new TextDecoder().decode(bytes) : null;
  return 'h' + await sha256(text === null ? bytes : new TextEncoder().encode(text.split('\n').sort().join('\n')));
}

/**
 * Paths that don't decide whether a snapshot is good: devices and /proc, and
 * the user's cache directory. A cache is by definition something the app
 * does as well without, and some are rewritten at every exit (babl's
 * conversion cache under GIMP), which would outdate every snapshot the
 * moment the app quits.
 */
const IGNORED_PATH = /^\/(?:dev|proc|sys)(?:\/|$)|^\/(?:home\/[^/]+|root)\/\.cache(?:\/|$)/;
const TMP_PATH = /^\/tmp(?:\/|$)/;

/**
 * What is at each of `paths` now, for a snapshot's `opened` (the paths that
 * don't count are left out). Under /tmp only a file that is there and that
 * the processes did not write counts (`written`): a document opened from
 * /tmp does, the app's own sockets, locks and swap files don't. A path a
 * socket is bound to (`sockets`), or a link to one (Geany's instance socket
 * is in /tmp, with a link to it under ~/.config/geany), is there while the
 * app runs and gone when it has quit: it never counts.
 */
export async function signaturesOf(fs: FileSystem, paths: Iterable<string>, written: ReadonlySet<string> = new Set(), sockets: ReadonlySet<string> = new Set()): Promise<[string, string][]> {
  const out: [string, string][] = [];
  for (const path of paths) {
    if (IGNORED_PATH.test(path) || sockets.has(path)) continue;
    if (sockets.size && !path.endsWith('/') && sockets.has(await fs.realpath(path).catch(() => path))) continue;
    if (TMP_PATH.test(path)) {
      if (path.endsWith('/') || written.has(path)) continue;
      const st = await fs.stat(path).catch(() => null);
      if (!st || !st.isFile()) continue;
    }
    out.push([path, await fileSignature(fs, path)]);
  }
  return out;
}

/**
 * A file among `paths` that holds a sign-in (src/credentials.ts: a token
 * file, or text with a token in it), or null. A snapshot is the processes'
 * memory: an app that read one gets no snapshot.
 */
export async function signInAmong(fs: FileSystem, paths: Iterable<string>): Promise<string | null> {
  for (const path of paths) {
    if (path.endsWith('/') || SYSTEM_PATH.test(path) || IGNORED_PATH.test(path)) continue;
    const st = await fs.stat(path).catch(() => null);
    if (!st || !st.isFile()) continue;
    let text: string | null = null;
    if (st.size < (1 << 20)) {
      const data = await fs.readFile(path).catch(() => null);
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      if (bytes && !bytes.includes(0)) text = new TextDecoder().decode(bytes);
    }
    if (credentialFileReason(path, text)) return path;
  }
  return null;
}

/** Why a stored snapshot can't be used now (null: it can) */
export async function snapshotProblem(fs: FileSystem, snap: { meta: SnapshotMeta }, key: string, now = Date.now()): Promise<string | null> {
  const m = snap.meta;
  if (m.v !== VERSION) return 'made by another version';
  if (m.key !== key) return `${keyChange(m.key, key)} changed`;
  if (now - m.taken > MAX_AGE_MS) return 'it is more than two weeks old';
  for (const [path, was] of m.opened) {
    if (await fileSignature(fs, path) !== was) return `${path} changed`;
  }
  return null;
}

// ── taking one ──

export interface TakeResult {
  ok: boolean; why?: string; meta?: SnapshotMeta; ms?: number;
  /** Not this time, and not the next either while nothing changes: the app as it is can't have a snapshot */
  never?: boolean;
  /** Snapshots dropped to keep the total within the cap */
  dropped?: string[];
}

/** What the launcher knows of the start a snapshot is taken from */
export interface Started {
  argv: string[]; env: Record<string, string>; cwd: string; output: OpenFile | null;
  /** A start nobody sees (retake.ts): no window on the desktop, so no input can reach it */
  hidden?: boolean;
  /** True once nobody wants this snapshot any more: one being made is not kept */
  cancelled?: () => boolean;
}

/** `main` and its descendants, each after its parent */
function family(kernel: Kernel, main: Process): Process[] {
  const out = [main];
  for (let i = 0; i < out.length; i++) for (const p of kernel.procs.values()) if (p.ppid === out[i].pid && !out.includes(p)) out.push(p);
  return out;
}

interface Look { files: FileRecord[]; fds: ProcRecord['fds'][]; pipes: { written: number }[] }

/** The processes' open files as records, or why one of them can't be made again */
async function lookAtFiles(procs: Process[], xSock: OpenFile | null, output: OpenFile | null): Promise<Look | string> {
  const { BufferFile, EventFile, RegularFile, DevNull } = await import('../kernel/fd');
  const { KSocket } = await import('../kernel/net');
  const { PipeEnd } = await import('../kernel/pipe');
  const { InotifyFile } = await import('../kernel/inotify');
  const files: FileRecord[] = [];
  const seen = new Map<OpenFile, number>();
  const pipes: InstanceType<typeof PipeEnd>['pipe'][] = [];
  const pairs: OpenFile[][] = [];
  const all = new Set<OpenFile>();
  for (const p of procs) for (const [, f] of p.fds.entries()) all.add(f);
  const record = (f: OpenFile, fd: number, pid: number): FileRecord | string => {
    const flags = f.flags;
    const where = procs.length > 1 ? `descriptor ${fd} of process ${pid}` : `descriptor ${fd}`;
    if (f === xSock) return { flags, kind: 'x11' };
    if (f === output) return { flags, kind: 'output' };
    if (f instanceof PipeEnd) {
      // (every reader and writer of it must be among these processes: nobody else holds it)
      const mine = [...all].filter((e): e is InstanceType<typeof PipeEnd> => e instanceof PipeEnd && e.pipe === f.pipe);
      if (f.pipe.available || f.pipe.readers !== mine.filter((e) => e.end === 'r').length || f.pipe.writers !== mine.filter((e) => e.end === 'w').length) return `${where} is a pipe to another process, or holds data`;
      if (!pipes.includes(f.pipe)) pipes.push(f.pipe);
      return { flags, kind: 'pipe', pipe: pipes.indexOf(f.pipe), end: f.end };
    }
    if (f instanceof InotifyFile) {
      if (f.poll(1 /* POLLIN */) || [...f.watches.values()].some((w) => w.orphan)) return `${where} (inotify) has events waiting`;
      return { flags, kind: 'inotify', watches: [...f.watches.values()].sort((a, b) => a.wd - b.wd).map((w) => [w.wd, w.path, w.mask, w.dir]), nextWd: f.nextWd };
    }
    if (f instanceof BufferFile) return { flags, kind: fd === 0 ? 'stdin' : 'output' };
    if (f instanceof EventFile) return { flags, kind: 'event', ...f.state };
    if (f instanceof DevNull && f.constructor === DevNull) return { flags, kind: 'null' };
    if (f instanceof KSocket && f.state === 'connected' && f.pairedWith && all.has(f.pairedWith)) {
      const other = f.pairedWith;
      if (f.netInfo().rxQueue || other.netInfo().rxQueue) return `${where} is a socket with data waiting`;
      let n = pairs.findIndex((p) => p.includes(f));
      if (n < 0) n = pairs.push([f, other]) - 1;
      return { flags, kind: 'pair', pair: n, side: pairs[n][0] === f ? 0 : 1, type: f.type };
    }
    if (f instanceof KSocket && f.state === 'listening' && f.unixKey && !f.unixKey.startsWith('\0') && f.netInfo().rxQueue === 0) return { flags, kind: 'listen', address: f.local?.address ?? f.unixKey };
    if (f instanceof RegularFile && !f.inode.unlinked && (f.flags & 3) === 0) return { flags, kind: 'file', path: f.path, pos: f.seek(0, 1) };
    return `${where} (${f.kind}${f instanceof KSocket ? ' ' + f.state + ' ' + (f.remote?.address ?? f.local?.address ?? '').replace('\0', '@') : ''}${f.path ? ' ' + f.path : ''}) can't be made again`;
  };
  const fds: ProcRecord['fds'][] = [];
  for (const p of procs) {
    const mine: ProcRecord['fds'] = [];
    for (const [fd, f] of p.fds.entries()) {
      let n = seen.get(f);
      if (n === undefined) {
        const r = record(f, fd, p.pid);
        if (typeof r === 'string') return r;
        n = files.push(r) - 1;
        seen.set(f, n);
      }
      mine.push({ fd, cloexec: !!p.fds.getCloexec(fd), file: n });
    }
    fds.push(mine);
  }
  return { files, fds, pipes: pipes.map((p) => ({ written: p.written })) };
}

/**
 * Take the snapshot of `main` and its children now. They are quiet enough
 * when no thread of any of them is in the middle of anything (the engine
 * says, process by process) and nothing passed while the images were made:
 * no X byte either way, no byte through a pipe between them, the same
 * descriptors. Otherwise `why` says what was in the way, and the caller
 * tries again later.
 */
export async function takeSnapshot(kernel: Kernel, app: string, main: Process, rec: XRecording, key: string, started: Started): Promise<TakeResult> {
  const t0 = Date.now();
  const fs = kernel.fs as FileSystem | undefined;
  if (!fs) return { ok: false, why: 'no filesystem' };
  const client = rec.client;
  if (rec.over || rec.connections !== 1 || !client || client.closed) return { ok: false, never: true, why: rec.connections > 1 ? 'it has more than one X connection' : 'its X requests were not all kept' };
  const procs = family(kernel, main);
  for (const p of procs) {
    if (!p.data.engineCheckpoint || p.state !== 'running' || p.data.embryo) return { ok: false, never: !p.data.embryo && p.state === 'running', why: `process ${p.pid} (${p.comm}) is not one the engine can write out now` };
  }
  const xSock = main.fds.entries().map(([, f]) => f).find((f) => f.kind === 'socket' && (f as { remote?: { address?: string } }).remote?.address?.includes('.X11-unix')) ?? null;
  if (!xSock) return { ok: false, why: 'no X connection among its descriptors' };
  const queued = () => (xSock as unknown as { netInfo(): { rxQueue: number; txQueue: number } }).netInfo();
  const before = { bytes: rec.bytes, seq: client.seq, sent: client.sent };
  if (queued().rxQueue || queued().txQueue) return { ok: false, why: 'X data in flight' };
  const look = await lookAtFiles(procs, xSock, started.output);
  // (a descriptor that can't be made again is there for as long as the app runs: a pty, the session bus)
  if (typeof look === 'string') return { ok: false, never: !/holds data|data waiting|events waiting/.test(look), why: look };
  // The image is the processes' memory: one that read a sign-in is not kept
  const paths = new Set<string>((main.data.openLog as Set<string> | undefined) ?? []);
  for (const p of procs) paths.add(p.path);
  const signIn = await signInAmong(fs, paths);
  if (signIn) return { ok: false, never: true, why: `it read a sign-in (${signIn})` };
  const raw: ArrayBuffer[] = [];
  for (const p of procs) {
    const r = await (p.data.engineCheckpoint as () => Promise<EngineCheckpoint>)();
    if (r.rc !== 0 || !r.image) return { ok: false, why: r.why || `the engine said ${r.rc}` };
    raw.push(r.image);
  }
  // (a turn of the event loop: bytes a process wrote before its image are where they went by now)
  await new Promise((res) => setTimeout(res, 0));
  if (rec.bytes !== before.bytes || client.seq !== before.seq || client.sent !== before.sent || queued().rxQueue || queued().txQueue) return { ok: false, why: 'the app was talking to the display' };
  const again = family(kernel, main);
  const look2 = again.length === procs.length && again.every((p, i) => p === procs[i]) ? await lookAtFiles(procs, xSock, started.output) : 'its processes changed meanwhile';
  if (typeof look2 === 'string' || JSON.stringify(look2) !== JSON.stringify(look)) return { ok: false, why: typeof look2 === 'string' ? look2 : 'its descriptors changed, or its processes talked, meanwhile' };
  const { getXSession } = await import('../x11/session');
  const { server } = await getXSession(0);
  const requests = new Uint8Array(rec.bytes);
  let at = 0;
  for (const c of rec.chunks) { requests.set(c, at); at += c.length; }
  // (again: what it opened while the images were made counts too)
  for (const path of (main.data.openLog as Set<string> | undefined) ?? []) paths.add(path);
  const opened = await signaturesOf(fs, paths, (main.data.openWritten as Set<string> | undefined) ?? new Set(), kernel.socketPaths ?? new Set());
  const [x, ...images] = await Promise.all([gzip(requests), ...raw.map((b) => gzip(new Uint8Array(b)))]);
  const meta: SnapshotMeta = {
    v: VERSION, app, key, taken: Date.now(), ...(started.hidden ? { hidden: true } : {}),
    procs: procs.map((p, i) => ({
      pid: p.pid, parent: procs.findIndex((q) => q.pid === p.ppid),
      path: p.path, argv: i ? p.argv : started.argv, env: i ? { ...p.env } : started.env, cwd: i ? p.cwd : started.cwd, umask: p.umask,
      signals: {
        dispositions: [...p.dispositions.entries()],
        actions: [...p.sigactions.entries()].map(([sig, a]) => [sig, { flags: a.flags, mask: [...a.mask], restorer: a.restorer }]),
        mask: [...p.sigmask],
      },
      fds: look.fds[i], image: raw[i].byteLength,
    })),
    files: look.files,
    x: { index: rec.index, atoms: server.atomNames(), bytes: rec.bytes, time: server.time() },
    opened,
    sizes: { image: raw.reduce((a, b) => a + b.byteLength, 0), stored: x.byteLength + images.reduce((a, b) => a + b.byteLength, 0), x: rec.bytes },
  };
  if (started.cancelled?.()) return { ok: false, why: 'cancelled' };
  // (the processes may have moved on while the images were packed: that doesn't matter, the images are of then)
  const dropped = await saveSnapshot({ meta, images, x });
  if (dropped.includes(app)) return { ok: false, never: true, why: `it is larger than the space snapshots may take (${Math.round(meta.sizes.stored / 1e6)} MB)`, dropped };
  return { ok: true, meta, ms: Date.now() - t0, dropped };
}

/** After its first window: this long before the first try, and this long without an X byte before any */
const SETTLE_MS = 1500, QUIET_MS = 150, TRIES = 60;

export interface SnapshotWatch { done: Promise<TakeResult>; cancel(): void }

/**
 * Keep `proc`'s snapshot once it is up and quiet: after its first window
 * that isn't a splash screen, when nobody has pressed a key or a button in
 * the display since it started (what is typed must not end up in an image
 * every later launch starts from). Gives up when the process ends, when it
 * can't be snapshotted, or after TRIES busy answers.
 */
export function snapshotWhenQuiet(kernel: Kernel, app: string, proc: Process, rec: XRecording, key: string, started: Started): SnapshotWatch {
  let cancelled = false;
  const done = (async (): Promise<TakeResult> => {
    const { getXSession } = await import('../x11/session');
    const { stopXRecording } = await import('../x11/display');
    const { server } = await getXSession(0);
    const input0 = server.inputCount;
    const finish = (r: TakeResult): TakeResult => { stopXRecording(proc.pid); rec.chunks = []; return r; };
    const isSplash = (w: { props: Map<number, { data: Uint8Array }> }) => {
      const t = w.props.get(server.existingAtom('_NET_WM_WINDOW_TYPE'));
      return !!t && t.data.length >= 4 && (server.atomName(new DataView(t.data.buffer, t.data.byteOffset).getUint32(0, true)) ?? '').endsWith('_SPLASH');
    };
    let upSince = 0, lastBytes = -1, quietSince = 0, why = '';
    for (let tries = 0; tries < TRIES;) {
      await new Promise((res) => setTimeout(res, 100));
      if (cancelled) return finish({ ok: false, why: 'cancelled' });
      if (proc.exiting || proc.state === 'zombie') return finish({ ok: false, why: 'the app ended first' });
      if (rec.over || rec.connections > 1) return finish({ ok: false, never: true, why: rec.connections > 1 ? 'it has more than one X connection' : 'its X requests were not all kept' });
      // (a hidden start has no window to press a key in: what is typed meanwhile goes to other apps)
      if (!started.hidden && server.inputCount !== input0) return finish({ ok: false, why: 'it was used before it went quiet' });
      const c = rec.client;
      if (!c || !server.topsOf(c).some((w) => w.mapped && !w.overrideRedirect && !isSplash(w))) { upSince = 0; continue; }
      const now = Date.now();
      upSince ||= now;
      if (rec.bytes !== lastBytes) { lastBytes = rec.bytes; quietSince = now; continue; }
      if (now - upSince < SETTLE_MS || now - quietSince < QUIET_MS) continue;
      const r = await takeSnapshot(kernel, app, proc, rec, key, started);
      if (r.ok || r.never) return finish(r);
      why = r.why ?? '';
      tries++;
      quietSince = Date.now();
    }
    return finish({ ok: false, never: true, why: `never quiet: ${why}` });
  })().catch((e) => ({ ok: false, why: String((e as Error)?.message ?? e) }));
  return { done, cancel: () => { cancelled = true; } };
}

// ── restoring one ──

export interface Restored { proc: Process; ms: { x: number; image: number; total: number } }

/**
 * Start `snap`'s processes again. `stdio` gives the launcher's descriptors
 * for the app's stdin and output. Throws when it can't be (the caller
 * starts the app the usual way); what was set up by then is undone.
 */
export async function restoreSnapshot(kernel: Kernel, snap: StoredSnapshot, stdio: { stdin: OpenFile; output: OpenFile }): Promise<Restored> {
  const t0 = Date.now();
  const m = snap.meta;
  const fs = kernel.fs as FileSystem;
  const { EventFile, DevNull } = await import('../kernel/fd');
  const { createPipe } = await import('../kernel/pipe');
  const { InotifyFile } = await import('../kernel/inotify');
  const { netStackOf, installNet, unixOpsFor } = await import('../kernel/net');
  const { adoptXClient } = await import('../x11/display');
  const { getXSession } = await import('../x11/session');
  const { blinkRunner } = await import('../x86-engine/blink');
  const A = await import('../kernel/abi');
  const { server } = await getXSession(0);
  if (server.clients.has(m.x.index)) throw new Error('the app is already running');
  // A process with children is known to them by its pid, and they to it: all of them back, or none
  if (m.procs.length > 1 && m.procs.some((p) => kernel.procs.has(p.pid))) throw new Error('one of its pids is taken');
  if (!server.adoptAtoms(m.x.atoms)) throw new Error("the display's atoms are not the snapshot's");
  server.timeAtLeast(m.x.time);
  // The images unpack while the window is rebuilt
  const images = snap.images.map((b) => gunzip(new Uint8Array(b)));
  for (const i of images) i.catch(() => {});
  const requests = new Uint8Array(await gunzip(new Uint8Array(snap.x)));
  const made: OpenFile[] = [];
  const started: Process[] = [];
  const pipes = new Map<number, { r: OpenFile; w: OpenFile; used: Set<OpenFile> }>();
  const pairs = new Map<number, { sides: [OpenFile, OpenFile]; used: Set<OpenFile> }>();
  let tx = 0;
  try {
    if (!netStackOf(kernel)) installNet(kernel);
    const stack = netStackOf(kernel)!;
    const files: OpenFile[] = [];
    for (const r of m.files) {
      let f: OpenFile;
      if (r.kind === 'stdin') f = stdio.stdin;
      else if (r.kind === 'output') f = stdio.output;
      else if (r.kind === 'pipe') {
        let p = pipes.get(r.pipe);
        if (!p) { const [rd, wr] = createPipe(); p = { r: rd, w: wr, used: new Set() }; pipes.set(r.pipe, p); }
        f = p[r.end];
        p.used.add(f);
      } else if (r.kind === 'pair') {
        let p = pairs.get(r.pair);
        if (!p) {
          const made2 = stack.socketpair(r.type);
          if (typeof made2 === 'number') throw new Error(`socketpair: errno ${-made2}`);
          p = { sides: made2, used: new Set() };
          pairs.set(r.pair, p);
        }
        f = p.sides[r.side];
        p.used.add(f);
      } else if (r.kind === 'inotify') {
        const uid = kernel.init.uid ?? 0;
        const ino = new InotifyFile(kernel.inotify, r.flags, uid);
        kernel.inotify.instances.set(uid, (kernel.inotify.instances.get(uid) ?? 0) + 1);
        // (the process holds its watch descriptors: each gets its number back)
        for (const [wd, path, mask, dir] of r.watches) { ino.nextWd = wd; kernel.inotify.add(ino, path, mask, dir); }
        ino.nextWd = r.nextWd;
        f = ino;
      } else if (r.kind === 'null') f = new DevNull();
      else if (r.kind === 'event') f = new EventFile(r.count, r.flags, r.semaphore);
      else if (r.kind === 'file') {
        const o = await kernel.open(kernel.init, r.path, r.flags & ~A.O_OPEN_ONLY);
        if (typeof o === 'number') throw new Error(`${r.path}: errno ${-o}`);
        o.seek?.(r.pos, 0);
        f = o;
      } else if (r.kind === 'listen') {
        const sk = stack.socket(A.AF_UNIX, A.SOCK_STREAM);
        if (typeof sk === 'number') throw new Error(`socket: errno ${-sk}`);
        // (the socket's file is the old process's: it went with the page that held the listener)
        await fs.unlink(r.address).catch(() => {});
        const b = await stack.bindUnix(sk as never, { family: A.AF_UNIX, address: r.address, port: 0 }, unixOpsFor(kernel, kernel.init));
        if (b < 0) throw new Error(`bind ${r.address}: errno ${-b}`);
        (sk as unknown as { listen(n: number): number }).listen(128);
        f = sk;
      } else {
        const tA = Date.now();
        f = (await adoptXClient(kernel, 0, m.x.index, [requests])).sock;
        tx = Date.now() - tA;
      }
      if (r.kind !== 'stdin' && r.kind !== 'output') { f.flags = r.flags; made.push(f); }
      files.push(f);
    }
    const tI = Date.now();
    const bytes = await Promise.all(images);
    const ti = Date.now() - tI;
    for (const [i, r] of m.procs.entries()) {
      const fds: Record<number, OpenFile> = {};
      for (const d of r.fds) fds[d.fd] = files[d.file];
      // (with the pid it had, when that is free: glibc keeps the main thread's, and its windows name it)
      const proc = kernel.spawn({ path: r.path, argv: r.argv, env: r.env, cwd: r.cwd, fds, pid: r.pid, parent: r.parent >= 0 ? started[r.parent] : undefined, run: blinkRunner(r.path, bytes[i]) });
      started.push(proc);
      if (m.procs.length > 1 && proc.pid !== r.pid) throw new Error(`pid ${r.pid} could not be had`);
      proc.umask = r.umask;
      proc.dispositions.clear();
      proc.sigmask.clear();
      for (const [sig, d] of r.signals.dispositions) proc.dispositions.set(sig, d);
      for (const [sig, a] of r.signals.actions) proc.sigactions.set(sig, { flags: a.flags, mask: new Set(a.mask), restorer: a.restorer });
      for (const sig of r.signals.mask) proc.sigmask.add(sig);
      for (const d of r.fds) {
        if (d.cloexec) proc.fds.setCloexec(d.fd, true);
        const f = files[d.file] as { ownerPid?: number; kind: string };
        if (f.kind === 'socket' && !i) f.ownerPid = proc.pid;
      }
      proc.data.restoredFrom = r.pid;
    }
    // (an end every process had closed: gone here too. After the spawns: a descriptor table holds its files)
    for (const p of pipes.values()) for (const e of [p.r, p.w]) if (!p.used.has(e)) void e.close();
    for (const p of pairs.values()) for (const e of p.sides) if (!p.used.has(e)) void e.close();
    void touchSnapshot(m.app);
    return { proc: started[0], ms: { x: tx, image: ti, total: Date.now() - t0 } };
  } catch (e) {
    for (const p of started.reverse()) { try { kernel.kill(p.pid, 9); } catch { /* gone */ } }
    for (const f of made) void f.close().catch(() => {});
    throw e;
  }
}
