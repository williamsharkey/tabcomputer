/**
 * Snapshots of started GUI apps (docs/research/GUI_SNAPSHOTS.md). Experimental:
 * off unless localStorage `tabcomputer-gui-snapshots` is `1`.
 *
 * A GTK or Qt app spends its launch computing the same start-up every time
 * (docs/GUI_LAUNCH.md). With snapshots on, the first start of an app is kept:
 * once its window is up and it has gone quiet, the engine writes the
 * process's image (every page of memory, every thread's registers: Blink
 * patch 0551), and the page keeps what the kernel and the X server hold for
 * it. The next launch rebuilds the process from that instead of running the
 * program:
 *
 * - the image goes to a new Blink worker (`blinkRunner(path, image)`), whose
 *   threads go on where they were, a waiting system call run again;
 * - its descriptors are made again from their records: the launcher's stdio,
 *   eventfds, a listening socket bound to its path, files by path and
 *   offset, and the X connection;
 * - the X server gets the client back by playing its recorded requests into
 *   a client with the same number (src/x11/display.ts `adoptXClient`): the
 *   windows, pixmaps, glyphs and properties are rebuilt as they were made, and
 *   the window is on screen before the process runs.
 *
 * A snapshot is used only while what it was made from is unchanged: the
 * build, the engine, the app's packages, its arguments and environment, the
 * screen, and every file the process opened or looked for (system files by
 * size and time, files under /home by content). It holds the process's
 * memory, so it never leaves the profile's own IndexedDB.
 */
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import type { OpenFile } from '../kernel/fd';
import type { XRecording } from '../x11/display';
import type { XServer } from '../x11/server';
import type { EngineCheckpoint } from '../x86-engine/blink';

const SETTING = 'tabcomputer-gui-snapshots';
const ATOMS = 'tabcomputer-x-atoms';
const SLOTS = 'tabcomputer-gui-snapshot-slots';
const DB = 'tabcomputer-gui-snapshots';
const VERSION = 2;

const ls = (): Storage | null => { try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; } };

/** The setting: off by default (experimental) */
export function snapshotsEnabled(): boolean { return ls()?.getItem(SETTING) === '1'; }
export function setSnapshotsEnabled(on: boolean): void { if (on) ls()?.setItem(SETTING, '1'); else ls()?.removeItem(SETTING); }

// ── what a snapshot holds ──

/** An open file, as what makes it again. Processes name them by number: a pipe's two ends, or a file two processes inherited, are one each. */
export type FileRecord =
  | { flags: number; kind: 'stdin' | 'output' | 'null' | 'x11' }
  | { flags: number; kind: 'event'; count: number; semaphore: boolean }
  | { flags: number; kind: 'listen'; address: string }
  | { flags: number; kind: 'file'; path: string; pos: number }
  /** One end of a pipe whose every end is held by the snapshot's processes, and empty; `pipe` numbers the pipes */
  | { flags: number; kind: 'pipe'; pipe: number; end: 'r' | 'w' }
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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore('snapshots'); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction('snapshots', mode);
      const r = run(t.objectStore('snapshots'));
      t.oncomplete = () => resolve(r.result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

export const loadSnapshot = (app: string): Promise<StoredSnapshot | null> => tx<StoredSnapshot | undefined>('readonly', (s) => s.get(app)).then((v) => v ?? null, () => null);
export const saveSnapshot = (snap: StoredSnapshot): Promise<unknown> => tx('readwrite', (s) => s.put(snap, snap.meta.app));
export const dropSnapshot = (app: string): Promise<unknown> => tx('readwrite', (s) => s.delete(app)).catch(() => undefined);
export const listSnapshots = (): Promise<StoredSnapshot[]> => tx<StoredSnapshot[]>('readonly', (s) => s.getAll()).catch(() => []);

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
  if (!store || !snapshotsEnabled()) return;
  try {
    const saved = JSON.parse(store.getItem(ATOMS) ?? '[]') as string[];
    if (Array.isArray(saved) && !server.adoptAtoms(saved)) store.removeItem(ATOMS);
  } catch { store.removeItem(ATOMS); }
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => { timer = null; try { store.setItem(ATOMS, JSON.stringify(server.atomNames())); } catch { /* full: the next snapshot is checked against the table anyway */ } };
  server.hooks.atomAdded = () => { timer ??= setTimeout(save, 300); };
}

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

// ── validity ──

export interface KeyParts { app: string; argv: string[]; env: Record<string, string>; packages: string[]; screen: [number, number, number]; textMode: string }

/** Everything a snapshot depends on that is known before the process runs */
export function snapshotKey(p: KeyParts): string {
  const g = globalThis as { __guiSnapshotBuild?: string };
  const build = typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : '';
  const engine = typeof __BLINK_ENGINE_DIR__ === 'string' ? __BLINK_ENGINE_DIR__ : '';
  return JSON.stringify({ v: VERSION, build: g.__guiSnapshotBuild ?? build, engine, app: p.app, argv: p.argv, env: Object.entries(p.env).sort(([a], [b]) => (a < b ? -1 : 1)), packages: p.packages, screen: p.screen, text: p.textMode });
}

async function sha256(b: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', b as BufferSource));
  return Array.from(d, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** What is at `path`, as a short string: '' nothing; a file under /home by content, any other by size and time */
async function fileSignature(fs: FileSystem, path: string): Promise<string> {
  const st = await fs.stat(path).catch(() => null);
  if (!st) return '';
  if (st.isDirectory()) return 'dir';
  if (path.startsWith('/home/')) {
    const data = await fs.readFile(path).catch(() => null);
    if (data === null) return '';
    return 'h' + await sha256(typeof data === 'string' ? new TextEncoder().encode(data) : data);
  }
  return `${st.size}:${Math.floor(Number(st.mtime instanceof Date ? st.mtime.getTime() : st.mtime ?? 0))}`;
}

/**
 * Files the process opened that don't decide whether its snapshot is good:
 * devices and /proc, /tmp, and the user's cache directory. A cache is by
 * definition something the app does as well without, and some are rewritten
 * at every exit (babl's conversion cache under GIMP), which would outdate
 * every snapshot the moment the app quits.
 */
const IGNORED_PATH = /^\/(?:dev|proc|sys|tmp)\/|^\/home\/[^/]+\/\.cache\//;

/** Why a stored snapshot can't be used now (null: it can) */
export async function snapshotProblem(fs: FileSystem, snap: StoredSnapshot, key: string): Promise<string | null> {
  const m = snap.meta;
  if (m.v !== VERSION) return 'made by another version';
  if (m.key !== key) return 'the app, the build or the screen changed';
  for (const [path, was] of m.opened) {
    if (await fileSignature(fs, path) !== was) return `${path} changed`;
  }
  return null;
}

// ── taking one ──

export interface TakeResult { ok: boolean; why?: string; meta?: SnapshotMeta; ms?: number }

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
export async function takeSnapshot(kernel: Kernel, app: string, main: Process, rec: XRecording, key: string, started: { argv: string[]; env: Record<string, string>; cwd: string; output: OpenFile | null }): Promise<TakeResult> {
  const t0 = Date.now();
  const fs = kernel.fs as FileSystem | undefined;
  if (!fs) return { ok: false, why: 'no filesystem' };
  const client = rec.client;
  if (rec.over || rec.connections !== 1 || !client || client.closed) return { ok: false, why: rec.connections > 1 ? 'it has more than one X connection' : 'its X requests were not all kept' };
  const procs = family(kernel, main);
  for (const p of procs) {
    if (!p.data.engineCheckpoint || p.state !== 'running' || p.data.embryo) return { ok: false, why: `process ${p.pid} (${p.comm}) is not one the engine can write out now` };
  }
  const xSock = main.fds.entries().map(([, f]) => f).find((f) => f.kind === 'socket' && (f as { remote?: { address?: string } }).remote?.address?.includes('.X11-unix')) ?? null;
  if (!xSock) return { ok: false, why: 'no X connection among its descriptors' };
  const queued = () => (xSock as unknown as { netInfo(): { rxQueue: number; txQueue: number } }).netInfo();
  const before = { bytes: rec.bytes, seq: client.seq, sent: client.sent };
  if (queued().rxQueue || queued().txQueue) return { ok: false, why: 'X data in flight' };
  const look = await lookAtFiles(procs, xSock, started.output);
  if (typeof look === 'string') return { ok: false, why: look };
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
  const opened: [string, string][] = [];
  for (const path of (main.data.openLog as Set<string> | undefined) ?? []) {
    if (!IGNORED_PATH.test(path)) opened.push([path, await fileSignature(fs, path)]);
  }
  const [x, ...images] = await Promise.all([gzip(requests), ...raw.map((b) => gzip(new Uint8Array(b)))]);
  const meta: SnapshotMeta = {
    v: VERSION, app, key, taken: Date.now(),
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
  // (the processes may have moved on while the images were packed: that doesn't matter, the images are of then)
  await saveSnapshot({ meta, images, x });
  return { ok: true, meta, ms: Date.now() - t0 };
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
export function snapshotWhenQuiet(kernel: Kernel, app: string, proc: Process, rec: XRecording, key: string, started: { argv: string[]; env: Record<string, string>; cwd: string; output: OpenFile | null }): SnapshotWatch {
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
      if (rec.over || rec.connections > 1) return finish({ ok: false, why: rec.connections > 1 ? 'it has more than one X connection' : 'its X requests were not all kept' });
      if (server.inputCount !== input0) return finish({ ok: false, why: 'it was used before it went quiet' });
      const c = rec.client;
      if (!c || !server.topsOf(c).some((w) => w.mapped && !w.overrideRedirect && !isSplash(w))) { upSince = 0; continue; }
      const now = Date.now();
      upSince ||= now;
      if (rec.bytes !== lastBytes) { lastBytes = rec.bytes; quietSince = now; continue; }
      if (now - upSince < SETTLE_MS || now - quietSince < QUIET_MS) continue;
      const r = await takeSnapshot(kernel, app, proc, rec, key, started);
      if (r.ok) return finish(r);
      why = r.why ?? '';
      tries++;
      quietSince = Date.now();
    }
    return finish({ ok: false, why: `never quiet: ${why}` });
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
    return { proc: started[0], ms: { x: tx, image: ti, total: Date.now() - t0 } };
  } catch (e) {
    for (const p of started.reverse()) { try { kernel.kill(p.pid, 9); } catch { /* gone */ } }
    for (const f of made) void f.close().catch(() => {});
    throw e;
  }
}
