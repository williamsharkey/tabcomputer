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
const VERSION = 1;

const ls = (): Storage | null => { try { return (globalThis as { localStorage?: Storage }).localStorage ?? null; } catch { return null; } };

/** The setting: off by default (experimental) */
export function snapshotsEnabled(): boolean { return ls()?.getItem(SETTING) === '1'; }
export function setSnapshotsEnabled(on: boolean): void { if (on) ls()?.setItem(SETTING, '1'); else ls()?.removeItem(SETTING); }

// ── what a snapshot holds ──

export type FdRecord =
  | { fd: number; cloexec: boolean; flags: number; kind: 'stdin' | 'output' | 'null' | 'x11' }
  | { fd: number; cloexec: boolean; flags: number; kind: 'event'; count: number; semaphore: boolean }
  | { fd: number; cloexec: boolean; flags: number; kind: 'listen'; address: string }
  | { fd: number; cloexec: boolean; flags: number; kind: 'file'; path: string; pos: number }
  /** One end of a pipe both of whose ends are the process's own, and empty; `pipe` numbers the pipes of a snapshot */
  | { fd: number; cloexec: boolean; flags: number; kind: 'pipe'; pipe: number; end: 'r' | 'w' }
  /** An inotify instance with nothing queued: its watches, by descriptor number */
  | { fd: number; cloexec: boolean; flags: number; kind: 'inotify'; watches: [number, string, number, boolean][]; nextWd: number }
  /** The same open file as descriptor `of` (a dup) */
  | { fd: number; cloexec: boolean; flags: number; kind: 'dup'; of: number };

export interface SnapshotMeta {
  v: number;
  app: string;
  /** What it was made from (snapshotKey): another key, another snapshot */
  key: string;
  taken: number;
  /** The process as it was started; `pid` is the one its windows' _NET_WM_PID names */
  pid: number;
  proc: { path: string; argv: string[]; env: Record<string, string>; cwd: string; umask: number };
  signals: { dispositions: [number, 'default' | 'ignore' | number][]; actions: [number, { flags: number; mask: number[]; restorer: number }][]; mask: number[] };
  fds: FdRecord[];
  /** The X client: its number, the server's atoms when it was taken (ids from 1), how many request bytes */
  x: { index: number; atoms: string[]; bytes: number };
  /** Every path it opened or looked for, with what was there ('' nothing) */
  files: [string, string][];
  sizes: { image: number; stored: number; x: number };
}

export interface StoredSnapshot { meta: SnapshotMeta; image: ArrayBuffer; x: ArrayBuffer }

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

/** Files the process opened that can't matter to a restore, or that change by themselves */
const IGNORED_PATH = /^\/(?:dev|proc|sys|tmp)\//;

/** Why a stored snapshot can't be used now (null: it can) */
export async function snapshotProblem(fs: FileSystem, snap: StoredSnapshot, key: string): Promise<string | null> {
  const m = snap.meta;
  if (m.v !== VERSION) return 'made by another version';
  if (m.key !== key) return 'the app, the build or the screen changed';
  for (const [path, was] of m.files) {
    if (await fileSignature(fs, path) !== was) return `${path} changed`;
  }
  return null;
}

// ── taking one ──

export interface TakeResult { ok: boolean; why?: string; meta?: SnapshotMeta; ms?: number }

async function fdRecords(proc: Process, xSock: OpenFile | null, output: OpenFile | null): Promise<FdRecord[] | string> {
  const { BufferFile, EventFile, RegularFile, DevNull } = await import('../kernel/fd');
  const { KSocket } = await import('../kernel/net');
  const { PipeEnd } = await import('../kernel/pipe');
  const { InotifyFile } = await import('../kernel/inotify');
  const out: FdRecord[] = [];
  const seen = new Map<OpenFile, number>();
  const pipes: unknown[] = [];
  const entries = proc.fds.entries();
  for (const [fd, f] of entries) {
    const base = { fd, cloexec: !!proc.fds.getCloexec(fd), flags: f.flags };
    const first = seen.get(f);
    if (first !== undefined && f !== output) { out.push({ ...base, kind: 'dup', of: first }); continue; }
    seen.set(f, fd);
    if (f instanceof PipeEnd) {
      // (its other end, and every reader and writer, must be among these descriptors: nobody else holds it)
      const mine = [...new Set(entries.map(([, e]) => e))].filter((e): e is InstanceType<typeof PipeEnd> => e instanceof PipeEnd && e.pipe === f.pipe);
      if (f.pipe.available || f.pipe.readers !== mine.filter((e) => e.end === 'r').length || f.pipe.writers !== mine.filter((e) => e.end === 'w').length) return `descriptor ${fd} is a pipe to another process, or holds data`;
      if (!pipes.includes(f.pipe)) pipes.push(f.pipe);
      out.push({ ...base, kind: 'pipe', pipe: pipes.indexOf(f.pipe), end: f.end });
      continue;
    }
    if (f instanceof InotifyFile) {
      if (f.poll(1 /* POLLIN */) || [...f.watches.values()].some((w) => w.orphan)) return `descriptor ${fd} (inotify) has events waiting`;
      out.push({ ...base, kind: 'inotify', watches: [...f.watches.values()].sort((a, b) => a.wd - b.wd).map((w) => [w.wd, w.path, w.mask, w.dir]), nextWd: f.nextWd });
      continue;
    }
    if (f === xSock) out.push({ ...base, kind: 'x11' });
    else if (f === output) out.push({ ...base, kind: 'output' });
    else if (f instanceof BufferFile) out.push({ ...base, kind: fd === 0 ? 'stdin' : 'output' });
    else if (f instanceof EventFile) out.push({ ...base, kind: 'event', ...f.state });
    else if (f instanceof DevNull && f.constructor === DevNull) out.push({ ...base, kind: 'null' });
    else if (f instanceof KSocket && f.state === 'listening' && f.unixKey && !f.unixKey.startsWith('\0') && f.netInfo().rxQueue === 0) out.push({ ...base, kind: 'listen', address: f.local?.address ?? f.unixKey });
    else if (f instanceof RegularFile && !f.inode.unlinked && (f.flags & 3) === 0) out.push({ ...base, kind: 'file', path: f.path, pos: f.seek(0, 1) });
    else return `descriptor ${fd} (${f.kind}${f instanceof KSocket ? ' ' + f.state + ' ' + (f.remote?.address ?? f.local?.address ?? '').replace('\0', '@') : ''}${(f as OpenFile).path ? ' ' + (f as OpenFile).path : ''}) can't be made again`;
  }
  return out;
}

/**
 * Take `proc`'s snapshot now. It is quiet enough when no thread is in the
 * middle of anything (the engine says) and no X byte went either way while
 * the image was made; otherwise `why` says what was in the way, and the
 * caller tries again later.
 */
export async function takeSnapshot(kernel: Kernel, app: string, proc: Process, rec: XRecording, key: string, started: { argv: string[]; env: Record<string, string>; cwd: string; output: OpenFile | null }): Promise<TakeResult> {
  const t0 = Date.now();
  const fs = kernel.fs as FileSystem | undefined;
  const checkpoint = proc.data.engineCheckpoint as (() => Promise<EngineCheckpoint>) | undefined;
  if (!fs || !checkpoint) return { ok: false, why: 'the process has no engine to ask' };
  const client = rec.client;
  if (rec.over || rec.connections !== 1 || !client || client.closed) return { ok: false, why: rec.connections > 1 ? 'it has more than one X connection' : 'its X requests were not all kept' };
  const xSock = proc.fds.entries().map(([, f]) => f).find((f) => (f as { peerPid?: number; kind: string }).kind === 'socket' && (f as { remote?: { address?: string } }).remote?.address?.includes('.X11-unix')) ?? null;
  if (!xSock) return { ok: false, why: 'no X connection among its descriptors' };
  const queued = () => (xSock as unknown as { netInfo(): { rxQueue: number; txQueue: number } }).netInfo();
  const before = { bytes: rec.bytes, seq: client.seq, sent: client.sent };
  if (queued().rxQueue || queued().txQueue) return { ok: false, why: 'X data in flight' };
  const fds = await fdRecords(proc, xSock, started.output);
  if (typeof fds === 'string') return { ok: false, why: fds };
  const r = await checkpoint();
  if (r.rc !== 0 || !r.image) return { ok: false, why: r.why || `the engine said ${r.rc}` };
  // (a turn of the event loop: bytes the process wrote before the image are in the server by now)
  await new Promise((res) => setTimeout(res, 0));
  if (rec.bytes !== before.bytes || client.seq !== before.seq || client.sent !== before.sent || queued().rxQueue || queued().txQueue) return { ok: false, why: 'the app was talking to the display' };
  const again = await fdRecords(proc, xSock, started.output);
  if (JSON.stringify(again) !== JSON.stringify(fds)) return { ok: false, why: 'its descriptors changed meanwhile' };
  const { getXSession } = await import('../x11/session');
  const { server } = await getXSession(0);
  const requests = new Uint8Array(rec.bytes);
  let at = 0;
  for (const c of rec.chunks) { requests.set(c, at); at += c.length; }
  const files: [string, string][] = [];
  for (const path of (proc.data.openLog as Set<string> | undefined) ?? []) {
    if (!IGNORED_PATH.test(path)) files.push([path, await fileSignature(fs, path)]);
  }
  const [image, x] = await Promise.all([gzip(new Uint8Array(r.image)), gzip(requests)]);
  const meta: SnapshotMeta = {
    v: VERSION, app, key, taken: Date.now(), pid: proc.pid,
    proc: { path: proc.path, argv: started.argv, env: started.env, cwd: started.cwd, umask: proc.umask },
    signals: {
      dispositions: [...proc.dispositions.entries()],
      actions: [...proc.sigactions.entries()].map(([sig, a]) => [sig, { flags: a.flags, mask: [...a.mask], restorer: a.restorer }]),
      mask: [...proc.sigmask],
    },
    fds,
    x: { index: rec.index, atoms: server.atomNames(), bytes: rec.bytes },
    files,
    sizes: { image: r.image.byteLength, stored: image.byteLength + x.byteLength, x: rec.bytes },
  };
  // (the process may have moved on while the image was packed: that doesn't matter, the image is of then)
  await saveSnapshot({ meta, image, x });
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
 * Start `snap`'s process again. `stdio` gives the launcher's descriptors for
 * its stdin and output. Throws when it can't be (the caller starts the app
 * the usual way); what was set up by then is undone.
 */
export async function restoreSnapshot(kernel: Kernel, snap: StoredSnapshot, stdio: { stdin: OpenFile; output: OpenFile }): Promise<Restored> {
  const t0 = Date.now();
  const m = snap.meta;
  const fs = kernel.fs as FileSystem;
  const { EventFile, DevNull } = await import('../kernel/fd');
  const { createPipe } = await import('../kernel/pipe');
  const { InotifyFile } = await import('../kernel/inotify');
  const pipes = new Map<number, { r: OpenFile; w: OpenFile; used: Set<OpenFile> }>();
  const { netStackOf, installNet, unixOpsFor } = await import('../kernel/net');
  const { adoptXClient } = await import('../x11/display');
  const { getXSession } = await import('../x11/session');
  const { blinkRunner } = await import('../x86-engine/blink');
  const A = await import('../kernel/abi');
  const { server } = await getXSession(0);
  if (server.clients.has(m.x.index)) throw new Error('the app is already running');
  if (!server.adoptAtoms(m.x.atoms)) throw new Error("the display's atoms are not the snapshot's");
  // The image unpacks while the window is rebuilt
  const image = gunzip(new Uint8Array(snap.image));
  image.catch(() => {});
  const requests = new Uint8Array(await gunzip(new Uint8Array(snap.x)));
  const made: OpenFile[] = [];
  const fds: Record<number, OpenFile> = {};
  let xDone: Promise<void> | null = null;
  let tx = 0;
  try {
    if (!netStackOf(kernel)) installNet(kernel);
    const stack = netStackOf(kernel)!;
    for (const r of m.fds) {
      let f: OpenFile;
      if (r.kind === 'stdin') f = stdio.stdin;
      else if (r.kind === 'output') f = stdio.output;
      else if (r.kind === 'dup') { fds[r.fd] = fds[r.of]; continue; }
      else if (r.kind === 'pipe') {
        let p = pipes.get(r.pipe);
        if (!p) { const [rd, wr] = createPipe(); p = { r: rd, w: wr, used: new Set() }; pipes.set(r.pipe, p); }
        f = p[r.end];
        p.used.add(f);
      }
      else if (r.kind === 'inotify') {
        const uid = kernel.init.uid ?? 0;
        const ino = new InotifyFile(kernel.inotify, r.flags, uid);
        kernel.inotify.instances.set(uid, (kernel.inotify.instances.get(uid) ?? 0) + 1);
        // (the process holds its watch descriptors: each gets its number back)
        for (const [wd, path, mask, dir] of r.watches) { ino.nextWd = wd; kernel.inotify.add(ino, path, mask, dir); }
        ino.nextWd = r.nextWd;
        f = ino;
      }
      else if (r.kind === 'null') f = new DevNull();
      else if (r.kind === 'event') f = new EventFile(r.count, r.flags, r.semaphore);
      else if (r.kind === 'file') {
        const o = await kernel.open(kernel.init, r.path, r.flags & ~A.O_OPEN_ONLY);
        if (typeof o === 'number') throw new Error(`${r.path}: errno ${-o}`);
        o.seek?.(r.pos, 0);
        f = o;
      } else if (r.kind === 'listen') {
        const s = stack.socket(A.AF_UNIX, A.SOCK_STREAM);
        if (typeof s === 'number') throw new Error(`socket: errno ${-s}`);
        // (the socket's file is the old process's: it went with the page that held the listener)
        await fs.unlink(r.address).catch(() => {});
        const b = await stack.bindUnix(s as never, { family: A.AF_UNIX, address: r.address, port: 0 }, unixOpsFor(kernel, kernel.init));
        if (b < 0) throw new Error(`bind ${r.address}: errno ${-b}`);
        (s as unknown as { listen(n: number): number }).listen(128);
        f = s;
      } else {
        const tA = Date.now();
        const x = await adoptXClient(kernel, 0, m.x.index, [requests]);
        tx = Date.now() - tA;
        xDone = x.done;
        f = x.sock;
      }
      if (r.kind !== 'stdin' && r.kind !== 'output') { f.flags = r.flags; made.push(f); }
      fds[r.fd] = f;
    }
    // (an end the process had closed: gone here too)
    for (const p of pipes.values()) for (const e of [p.r, p.w]) if (!p.used.has(e)) void e.close();
    const tI = Date.now();
    const bytes = await image;
    const ti = Date.now() - tI;
    const proc = kernel.spawn({ path: m.proc.path, argv: m.proc.argv, env: m.proc.env, cwd: m.proc.cwd, fds, run: blinkRunner(m.proc.path, bytes) });
    proc.umask = m.proc.umask;
    for (const [sig, d] of m.signals.dispositions) proc.dispositions.set(sig, d);
    for (const [sig, a] of m.signals.actions) proc.sigactions.set(sig, { flags: a.flags, mask: new Set(a.mask), restorer: a.restorer });
    for (const sig of m.signals.mask) proc.sigmask.add(sig);
    for (const r of m.fds) {
      if (r.cloexec) proc.fds.setCloexec(r.fd, true);
      const f = fds[r.fd] as { ownerPid?: number; kind: string };
      if (f.kind === 'socket') f.ownerPid = proc.pid;
    }
    proc.data.restoredFrom = m.pid;
    void xDone;
    return { proc, ms: { x: tx, image: ti, total: Date.now() - t0 } };
  } catch (e) {
    for (const f of made) void f.close().catch(() => {});
    throw e;
  }
}
