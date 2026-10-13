/**
 * PostgreSQL itself: PGlite (PostgreSQL built to WebAssembly, Apache-2.0)
 * as one backend, with its data directory handed in and out as files so the
 * tab's filesystem can keep it. Nothing here touches the page: it runs in a
 * Worker (engine-worker.ts) and, where there is none (vitest), in process.
 *
 * PGlite is one process serving one database of the cluster, so a
 * connection to another database closes it cleanly and starts it again on
 * the same files (`use`).
 */
import type { PGlite as PGliteType } from '@electric-sql/pglite';
import { copyFromPath } from './sql-split';
import { query, errorResponse, readyForQuery, concat, lastStatus } from './wire';

/** A file of the data directory by its path below it; null bytes is a directory. */
export type DataFile = [path: string, bytes: Uint8Array | null];

export interface Changes {
  /** Files and directories that are new or changed since the last call */
  files: DataFile[];
  /** Paths that no longer exist */
  gone: string[];
}

export interface Dump {
  /** The SQL script; '' when pg_dump failed */
  text: string;
  error: string;
}

export interface EngineOpen {
  database: string;
  /** The data directory as kept; none: a new cluster is made (initdb) */
  files?: DataFile[];
}

export interface EngineInfo {
  /** `select version()` */
  version: string;
  /** A new cluster was made */
  fresh: boolean;
  /** Milliseconds to a running backend */
  ms: number;
}

/** What the page (or a test) drives: the Worker's proxy and Engine itself both are one. */
export interface EngineLike {
  open(opts: EngineOpen): Promise<EngineInfo>;
  /** Frontend messages in, the backend's reply out */
  raw(msg: Uint8Array): Promise<Uint8Array>;
  /** Run a COPY ... FROM STDIN statement over `data`; the reply as the wire would carry it */
  copyIn(sql: string, data: Uint8Array): Promise<Uint8Array>;
  /** pg_dump of the database being served, with pg_dump's own arguments */
  dump(args: string[]): Promise<Dump>;
  changes(): Promise<Changes>;
  /** Serve another database of the cluster; the files the clean stop changed */
  use(database: string): Promise<Changes>;
  /** Stop cleanly; the files the stop changed */
  close(): Promise<Changes>;
}

/** Where PGlite keeps its cluster inside its own (in-memory) filesystem */
const PGDATA = '/pglite/data';
/** WAL files of 1 MB (the default is 16): each write to the database rewrites the newest one in the tab's filesystem */
const INITDB = ['--wal-segsize=1'];

interface EmFS {
  readdir(p: string): string[];
  lstat(p: string): { mode: number; size: number; mtime: Date };
  isDir(mode: number): boolean;
  readFile(p: string): Uint8Array;
  writeFile(p: string, data: Uint8Array): void;
  mkdirTree(p: string): void;
  utime(p: string, atime: number, mtime: number): void;
}

/** The modification time given to files as they are handed in: any later write has a newer one */
const KEPT_MTIME = 1000;

function walk(FS: EmFS, dir: string, out: [string, number | null, number][] = []): [string, number | null, number][] {
  for (const name of FS.readdir(dir)) {
    if (name === '.' || name === '..') continue;
    const p = `${dir}/${name}`;
    const st = FS.lstat(p);
    if (FS.isDir(st.mode)) { out.push([p, null, 0]); walk(FS, p, out); }
    else out.push([p, st.size, st.mtime.getTime()]);
  }
  return out;
}

export class Engine implements EngineLike {
  private pg: PGliteType | null = null;
  /** path → what was last handed out ("d", or mtime:size) */
  private seen = new Map<string, string>();
  /** A scan sees a write made in the same millisecond as the last one */
  private lastScan = 0;
  private database = '';
  private wasm: { pglite?: WebAssembly.Module; initdb?: WebAssembly.Module; bundle?: Blob } = {};

  /**
   * `assets`: where pglite.wasm, initdb.wasm and pglite.data are, when the
   * caller knows (the Worker passes the build's URLs); else PGlite finds
   * them beside its own module (node).
   */
  constructor(private assets?: { pglite: string; initdb: string; data: string }) {}

  private get fs(): EmFS { return (this.pg as unknown as { Module: { FS: EmFS } }).Module.FS; }

  private async modules(): Promise<{ pgliteWasmModule?: WebAssembly.Module; initdbWasmModule?: WebAssembly.Module; fsBundle?: Blob }> {
    if (!this.assets) return {};
    if (!this.wasm.pglite) {
      const [pglite, initdb, bundle] = await Promise.all([
        WebAssembly.compileStreaming(fetch(this.assets.pglite)),
        WebAssembly.compileStreaming(fetch(this.assets.initdb)),
        fetch(this.assets.data).then((r) => { if (!r.ok) throw new Error(`pglite.data: HTTP ${r.status}`); return r.blob(); }),
      ]);
      this.wasm = { pglite, initdb, bundle };
    }
    return { pgliteWasmModule: this.wasm.pglite, initdbWasmModule: this.wasm.initdb, fsBundle: this.wasm.bundle };
  }

  private async start(database: string, files: DataFile[] | undefined): Promise<void> {
    const { PGlite, MemoryFS } = await import('@electric-sql/pglite');
    // What is handed in is what is kept: only what the backend writes from here on is a change
    const seen = this.seen;
    seen.clear();
    class KeptFS extends MemoryFS {
      async initialSyncFs(): Promise<void> {
        if (!files) return;
        const FS = (this as unknown as { pg: { Module: { FS: EmFS } } }).pg.Module.FS;
        for (const [path, bytes] of files) {
          const full = `${PGDATA}/${path}`;
          if (bytes === null) { FS.mkdirTree(full); seen.set(path, 'd'); continue; }
          FS.mkdirTree(full.slice(0, full.lastIndexOf('/')));
          FS.writeFile(full, bytes);
          FS.utime(full, KEPT_MTIME, KEPT_MTIME);
          seen.set(path, `${KEPT_MTIME}:${bytes.length}`);
        }
      }
    }
    this.pg = await PGlite.create({
      fs: new KeptFS(),
      database,
      initDbStartParams: INITDB,
      ...(await this.modules()),
    } as never) as unknown as PGliteType;
    this.database = database;
  }

  async open(opts: EngineOpen): Promise<EngineInfo> {
    const t0 = Date.now();
    await this.start(opts.database, opts.files);
    const version = (await this.pg!.query<{ version: string }>('select version()')).rows[0].version;
    return { version, fresh: !opts.files, ms: Date.now() - t0 };
  }

  async raw(msg: Uint8Array): Promise<Uint8Array> {
    return this.pg!.execProtocolRaw(msg, { syncToFs: false });
  }

  async copyIn(sql: string, data: Uint8Array): Promise<Uint8Array> {
    const pg = this.pg as unknown as { _handleBlob?: (b: Blob) => Promise<void>; _cleanupBlob?: () => Promise<void> };
    if (!pg._handleBlob || !pg._cleanupBlob) {
      const sync = await this.raw(new Uint8Array([0x53, 0, 0, 0, 4]));
      return concat([errorResponse('ERROR', '0A000', 'COPY FROM STDIN is not available in this build of the database'), readyForQuery(lastStatus(sync) || 'I')]);
    }
    await pg._handleBlob(new Blob([data as BlobPart]));
    try {
      return await this.raw(query(copyFromPath(sql, '/dev/blob')));
    } finally {
      await pg._cleanupBlob();
    }
  }

  async dump(args: string[]): Promise<Dump> {
    try {
      // PostgreSQL's own pg_dump, built to WebAssembly (it writes INSERTs, not COPY, and drops prepared statements when done)
      const { pgDump } = await import('@electric-sql/pglite-tools/pg_dump');
      const file = await pgDump({ pg: this.pg as never, args });
      return { text: await file.text(), error: '' };
    } catch (e) {
      return { text: '', error: (e as Error)?.message ?? String(e) };
    }
  }

  /** What changed in the data directory since the last scan, by modification time and size. */
  private scan(read = false): Changes {
    const FS = this.fs;
    const started = Date.now();
    const files: DataFile[] = [];
    const now = new Set<string>();
    for (const [full, size, mtime] of walk(FS, PGDATA)) {
      const path = full.slice(PGDATA.length + 1);
      now.add(path);
      const key = size === null ? 'd' : `${mtime}:${size}`;
      if (this.seen.get(path) === key && (size === null || mtime < this.lastScan - 1)) continue;
      this.seen.set(path, key);
      if (read) files.push([path, size === null ? null : FS.readFile(full)]);
    }
    const gone = [...this.seen.keys()].filter((p) => !now.has(p));
    for (const p of gone) this.seen.delete(p);
    this.lastScan = started;
    return { files, gone };
  }

  async changes(): Promise<Changes> {
    return this.scan(true);
  }

  private async stop(): Promise<{ changes: Changes; all: DataFile[] }> {
    const pg = this.pg!;
    const FS = this.fs;
    // PGlite drops its filesystem as it closes: read the stopped cluster first
    let out: { changes: Changes; all: DataFile[] } = { changes: { files: [], gone: [] }, all: [] };
    const fsOf = (pg as unknown as { fs: { closeFs(): Promise<void> } }).fs;
    const closeFs = fsOf.closeFs.bind(fsOf);
    fsOf.closeFs = async () => {
      const changes = this.scan(true);
      const changed = new Map(changes.files);
      const all: DataFile[] = walk(FS, PGDATA).map(([full, size]) => {
        const path = full.slice(PGDATA.length + 1);
        return [path, size === null ? null : changed.get(path) ?? FS.readFile(full)];
      });
      out = { changes, all };
      await closeFs();
    };
    await pg.close();
    this.pg = null;
    return out;
  }

  async use(database: string): Promise<Changes> {
    if (database === this.database) return { files: [], gone: [] };
    const { changes, all } = await this.stop();
    await this.start(database, all);
    return changes;
  }

  async close(): Promise<Changes> {
    if (!this.pg) return { files: [], gone: [] };
    return (await this.stop()).changes;
  }
}
