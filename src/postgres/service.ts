/**
 * The tab's postgres service (docs/POSTGRES.md, tabcomputer#126): a
 * PostgreSQL server on 127.0.0.1:5432 of the tab's own network, there by
 * the time anything connects. It starts on the first connection (`psql`,
 * node's `pg`, Python's `pg8000`, anything that speaks the wire protocol),
 * so a student installs and configures nothing.
 *
 * The server is PGlite in a Worker (engine.ts): one backend. Every
 * connection is served by it in turn: a connection holds the backend from
 * its first message until the server is idle again (ReadyForQuery outside a
 * transaction), so statements and transactions of two clients never
 * interleave. They do share one session: temporary tables, SET and LISTEN
 * are common to all, and prepared statements are kept apart by renaming
 * them per connection.
 *
 * The data directory is /var/lib/postgresql/<major>/main in the tab's
 * filesystem: the files PostgreSQL itself writes. After a statement the
 * files that changed are written there (keep()), WAL first and pg_control
 * last, so a reload at any moment finds a cluster that recovers like after
 * a crash.
 */
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { KSocket, type NetStack, type UnixOps } from '../kernel/net';
import { AF_INET, AF_UNIX, SOCK_STREAM } from '../kernel/abi';
import { klog, LOG_INFO, LOG_WARNING } from '../kernel/klog';
import type { Changes, DataFile, Dump, EngineInfo, EngineLike } from './engine';
import { copyFromStdin } from './sql-split';
import {
  Frames, PROTOCOL_V3, SSL_REQUEST, GSSENC_REQUEST, concat, errorResponse, ident, lastStatus, literal, message,
  parseReply, parseStartup, query, readyForQuery, renameStatement, sqlOf, startupPacket, type Reply,
} from './wire';

/** PostgreSQL's major version in the pinned PGlite: the data directory is named after it, as Debian's is */
export const PG_MAJOR = 18;
export const PG_PORT = 5432;
export const PG_DATA = `/var/lib/postgresql/${PG_MAJOR}/main`;
export const PG_SOCKET = `/var/run/postgresql/.s.PGSQL.${PG_PORT}`;
/** Written after a whole data directory is: a directory without it was cut short and is made again */
const MARKER = `/var/lib/postgresql/${PG_MAJOR}/tabcomputer.json`;

/** While statements keep coming, their files are kept this often (ms) */
const KEEP_EVERY = 250;

export type PostgresStatus = 'stopped' | 'starting' | 'running' | 'failed';

export interface PostgresDeps {
  fs: FileSystem;
  stack: NetStack;
  kernel?: Kernel;
  /** A new backend (default: the Worker; tests pass Engine itself) */
  engine?: () => EngineLike | Promise<EngineLike>;
  port?: number;
}

interface Conn {
  id: number;
  user: string;
  database: string;
  /** Prepared statements it made, as the backend knows them */
  statements: Set<string>;
  /** What it has SET (name, value): put back when the backend serves it again after another */
  settings: [string, string][];
  sock: KSocket;
}

/** Startup parameters that are not settings of the session */
const NOT_SETTINGS = /^(user|database|options|replication|_pq_\..*)$/;

async function workerEngine(): Promise<EngineLike> {
  // (no Workers, as under Node: the backend runs here)
  if (typeof Worker === 'undefined' || typeof document === 'undefined') return new (await import('./engine')).Engine();
  const worker = new Worker(new URL('./engine-worker.ts', import.meta.url), { type: 'module', name: 'postgres' });
  let next = 1;
  const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let dead: Error | null = null;
  worker.onmessage = (ev: MessageEvent<{ id: number; value?: unknown; error?: string }>) => {
    const w = waiting.get(ev.data.id);
    if (!w) return;
    waiting.delete(ev.data.id);
    if (ev.data.error !== undefined) w.reject(new Error(ev.data.error)); else w.resolve(ev.data.value);
  };
  worker.onerror = (ev) => {
    dead = new Error(`the database's worker stopped: ${ev.message || 'error'}`);
    for (const w of waiting.values()) w.reject(dead);
    waiting.clear();
  };
  // What goes to the worker is copied, never transferred: the bytes of a kept file are the
  // filesystem's own, and a message is a view of a connection's buffer. What comes back is transferred.
  const call = <T>(op: string, args: unknown[]): Promise<T> => new Promise<T>((resolve, reject) => {
    if (dead) { reject(dead); return; }
    const id = next++;
    waiting.set(id, { resolve: resolve as (v: unknown) => void, reject });
    worker.postMessage({ id, op, args });
  });
  // (a view is cut out first: a clone carries the whole buffer behind it)
  const compact = (b: Uint8Array) => (b.byteLength === b.buffer.byteLength ? b : b.slice());
  return {
    open: (opts) => call<EngineInfo>('open', [opts]),
    raw: (msg) => call<Uint8Array>('raw', [compact(msg)]),
    copyIn: (sql, data) => call<Uint8Array>('copyIn', [sql, compact(data)]),
    dump: (args) => call<Dump>('dump', [args]),
    changes: () => call<Changes>('changes', []),
    use: (database) => call<Changes>('use', [database]),
    close: async () => { try { return await call<Changes>('close', []); } finally { worker.terminate(); } },
  };
}

export class PostgresService {
  status: PostgresStatus = 'stopped';
  /** Why the last start failed */
  error = '';
  info: (EngineInfo & { loadMs: number; startedAt: number }) | null = null;
  /** Connections accepted since the start */
  connections = 0;
  proc: Process | null = null;

  private engine: EngineLike | null = null;
  private starting: Promise<void> | null = null;
  private listeners: KSocket[] = [];
  private conns = new Set<Conn>();
  private nextConn = 1;
  /** The database the backend serves and the role its session runs as */
  private database = 'postgres';
  private sessionUser = 'postgres';
  /** The backend is serving `owner` (null: the service itself) until it is released */
  private busy = false;
  private owner: Conn | null = null;
  /** The connection whose settings the backend's session has now */
  private last: Conn | null = null;
  private waiters: (() => void)[] = [];
  private keeping: Promise<void> | null = null;
  private dirty = false;
  private fresh = false;
  private wake: () => void = () => {};

  constructor(private deps: PostgresDeps) {}

  get port(): number { return this.deps.port ?? PG_PORT; }
  /** The AF_UNIX socket libpq looks for when given no host */
  get socket(): string { return PG_SOCKET.replace(/\d+$/, String(this.port)); }
  get running(): boolean { return this.status === 'running'; }
  /** Open connections */
  get clients(): number { return this.conns.size; }

  /** Start the server (once): the backend on the kept data directory, then the listeners. */
  start(): Promise<void> {
    if (this.status === 'running') return Promise.resolve();
    this.starting ??= this.boot().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async boot(): Promise<void> {
    this.status = 'starting';
    this.error = '';
    try {
      const t0 = Date.now();
      const files = await this.load();
      const loadMs = Date.now() - t0;
      this.engine = await (this.deps.engine ?? workerEngine)();
      const info = await this.engine.open({ database: 'postgres', files });
      this.database = 'postgres';
      this.sessionUser = 'postgres';
      this.last = null;
      this.fresh = info.fresh;
      this.info = { ...info, loadMs, startedAt: Date.now() };
      await this.listen();
      this.status = 'running';
      klog.log(LOG_INFO, `postgres: PostgreSQL ${PG_MAJOR} on 127.0.0.1:${this.port}, data in ${PG_DATA} (${info.fresh ? 'new cluster' : `${files?.length ?? 0} files`}, ${loadMs + info.ms} ms)`);
      this.keep();
    } catch (e) {
      this.status = 'failed';
      this.error = (e as Error)?.message ?? String(e);
      klog.log(LOG_WARNING, `postgres: did not start: ${this.error}`);
      for (const l of this.listeners) void l.close();
      this.listeners = [];
      this.engine = null;
      throw e;
    }
  }

  private async listen(): Promise<void> {
    const { stack, fs, kernel } = this.deps;
    const tcp = stack.socket(AF_INET, SOCK_STREAM);
    if (!(tcp instanceof KSocket)) throw new Error(`socket: errno ${-(tcp as number)}`);
    const r = tcp.bind({ family: AF_INET, address: '127.0.0.1', port: this.port });
    if (r < 0) { void tcp.close(); throw new Error(`port ${this.port} is in use by another program`); }
    const l = tcp.listen(64);
    if (l < 0) { void tcp.close(); throw new Error(`port ${this.port} is in use by another program`); }
    this.listeners = [tcp];
    // libpq's default for a connection without a host (Debian's psql, psycopg) is this socket
    const unix = stack.socket(AF_UNIX, SOCK_STREAM);
    const ops: UnixOps = {
      resolve: (p) => p,
      exists: async (p) => fs.exists(p),
      create: async (p) => { await fs.writeFile(p, new Uint8Array(0)); return 0; },
    };
    const bindUnix = async () => {
      if (!(unix instanceof KSocket)) return;
      const path = this.socket;
      await fs.mkdir(path.replace(/\/[^/]*$/, ''), { recursive: true });
      if (await fs.exists(path)) await fs.unlink(path);
      if ((await stack.bindUnix(unix, { family: AF_UNIX, address: path, port: 0 }, ops)) < 0) return;
      if (unix.listen(64) < 0) { void unix.close(); return; }
      this.listeners.push(unix);
      if (this.proc) unix.ownerPid = this.proc.pid;
      void this.acceptLoop(unix);
    };
    const stopped = new Promise<void>((res) => { this.wake = res; });
    if (kernel) {
      this.proc = kernel.spawn({
        path: 'postgres',
        argv: ['postgres', '-D', PG_DATA],
        run: async (p) => {
          tcp.ownerPid = p.pid;
          p.onTerminate(() => { void this.stop(); });
          await stopped;
          return 0;
        },
      });
    }
    void this.acceptLoop(tcp);
    await bindUnix().catch(() => {});
  }

  private async acceptLoop(listener: KSocket): Promise<void> {
    while (this.listeners.includes(listener)) {
      const s = await listener.accept();
      if (typeof s === 'number') { if (!this.listeners.includes(listener)) return; await new Promise((r) => setTimeout(r, 50)); continue; }
      this.connections++;
      void this.serve(s);
    }
  }

  /** Stop the server: a clean shutdown, its last files kept, the port free. */
  async stop(): Promise<void> {
    if (this.starting) await this.starting.catch(() => {});
    if (this.status !== 'running') { this.status = 'stopped'; return; }
    this.status = 'stopped';
    for (const l of this.listeners) void l.close();
    this.listeners = [];
    await this.deps.fs.unlink(this.socket).catch(() => {});
    for (const c of this.conns) void c.sock.close();
    const engine = this.engine;
    this.engine = null;
    this.wake();
    this.proc = null;
    if (engine) {
      await this.acquire(null);
      try {
        await this.kept();
        await this.write(await engine.close().catch(() => ({ files: [], gone: [] })));
      } finally { this.release(null); }
    }
    klog.log(LOG_INFO, 'postgres: stopped');
  }

  // ── the data directory in the tab's filesystem ──

  private async load(): Promise<DataFile[] | undefined> {
    const { fs } = this.deps;
    let complete = false;
    try { complete = JSON.parse(await fs.readFile(MARKER, 'utf8') as string).complete === true; } catch { /* none yet */ }
    if (!complete) {
      if (await fs.exists(PG_DATA)) await fs.rm(PG_DATA, { recursive: true });
      return undefined;
    }
    const out: DataFile[] = [];
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const name of await fs.readdir(dir)) {
        const full = `${dir}/${name}`;
        const path = rel ? `${rel}/${name}` : name;
        if ((await fs.stat(full)).isDirectory()) { out.push([path, null]); await walk(full, path); }
        else out.push([path, await fs.readFile(full) as Uint8Array]);
      }
    };
    await walk(PG_DATA, '');
    return out;
  }

  /** Write what changed: directories, WAL, the rest, pg_control last, then what is gone. */
  private async write(ch: Changes): Promise<void> {
    if (!ch.files.length && !ch.gone.length) return;
    const { fs } = this.deps;
    const first = this.fresh;
    if (first) {
      await fs.mkdir(PG_DATA, { recursive: true });
      this.fresh = false;
    }
    const rank = (p: string) => (p === 'global/pg_control' ? 2 : p.startsWith('pg_wal/') ? 0 : 1);
    for (const [path, bytes] of ch.files) if (bytes === null) await fs.mkdir(`${PG_DATA}/${path}`, { recursive: true });
    const files = ch.files.filter(([, b]) => b !== null).sort((a, b) => rank(a[0]) - rank(b[0]));
    for (const [path, bytes] of files) await fs.writeFile(`${PG_DATA}/${path}`, bytes!, { mode: 0o600 });
    for (const path of [...ch.gone].sort((a, b) => b.length - a.length)) await fs.rm(`${PG_DATA}/${path}`, { recursive: true }).catch(() => {});
    if (first) await fs.writeFile(MARKER, JSON.stringify({ complete: true, postgresql: PG_MAJOR, made: new Date().toISOString() }) + '\n');
  }

  /**
   * Keep the backend's changed files: at once after a statement on its own,
   * and every KEEP_EVERY ms while statements keep coming (a script of 20 000
   * INSERTs would otherwise look through the directory and rewrite a WAL
   * file 20 000 times).
   */
  private keep(): void {
    this.dirty = true;
    this.keeping ??= (async () => {
      while (this.dirty && this.engine) {
        const wait = this.keptAt + KEEP_EVERY - Date.now();
        if (wait > 0 && !this.flushing) await new Promise<void>((r) => { this.hurry = r; setTimeout(r, wait); });
        if (!this.engine) break;
        this.dirty = false;
        try { await this.write(await this.engine.changes()); }
        catch (e) { klog.logRatelimited(LOG_WARNING, `postgres: could not keep the data directory: ${(e as Error)?.message ?? e}`); }
        this.keptAt = Date.now();
      }
    })().finally(() => { this.keeping = null; });
  }
  private keptAt = 0;
  private flushing = false;
  private hurry: () => void = () => {};

  /** Everything written so far is in the tab's filesystem. */
  async kept(): Promise<void> {
    this.flushing = true;
    try {
      this.hurry?.();
      while (this.keeping) await this.keeping;
    } finally { this.flushing = false; }
  }

  // ── one backend, many connections ──

  private async acquire(c: Conn | null): Promise<void> {
    while (this.busy) await new Promise<void>((r) => this.waiters.push(r));
    this.busy = true;
    this.owner = c;
  }

  private release(c: Conn | null): void {
    if (!this.busy || this.owner !== c) return;
    this.busy = false;
    this.owner = null;
    this.waiters.shift()?.();
  }

  /** A statement of the service's own, on the backend as it is. */
  private async sql(text: string): Promise<Reply> {
    return parseReply(await this.engine!.raw(query(text)));
  }

  /** Make the backend serve `c`: its database, its role. An error's fields when it can't. */
  private async enter(c: Conn, create = false): Promise<{ code: string; text: string } | null> {
    if (this.database !== c.database) {
      const has = await this.sql(`SELECT 1 FROM pg_database WHERE datname = ${literal(c.database)} AND datallowconn`);
      if (!has.results[0]?.rows.length) {
        if (!create) return { code: '3D000', text: `database "${c.database}" does not exist` };
        const made = await this.sql(`CREATE DATABASE ${ident(c.database)}`);
        if (made.results[0]?.error) return { code: made.results[0].error.C ?? 'XX000', text: made.results[0].error.M ?? 'could not create the database' };
      }
      await this.park();
      await this.kept();
      await this.write(await this.engine!.use(c.database));
      this.database = c.database;
      this.sessionUser = 'postgres';
    }
    if (this.sessionUser !== c.user) {
      const r = await this.sql(`SET SESSION AUTHORIZATION ${ident(c.user)}`);
      const err = r.results[0]?.error;
      if (err) return { code: err.C === '22023' ? '28000' : err.C ?? 'XX000', text: err.M ?? 'could not become the role' };
      this.sessionUser = c.user;
    }
    return null;
  }

  /** Note what the connection served last has SET, before the session is another's. */
  private async park(): Promise<void> {
    const prev = this.last;
    this.last = null;
    if (!prev || !this.conns.has(prev)) return;
    const cur = await this.sql(`SELECT name, setting FROM pg_catalog.pg_settings WHERE source = 'session'`);
    prev.settings = (cur.results[0]?.rows ?? []) as [string, string][];
  }

  /**
   * Give the one session to `c`: what the last connection SET is taken
   * out (a restored dump leaves search_path empty) and what `c` had SET is
   * put back. Nothing to do while the same connection keeps the backend.
   */
  private async settle(c: Conn): Promise<void> {
    if (this.last === c) return;
    await this.park();
    await this.sql('RESET ALL');
    const sets = c.settings.map(([k, v]) => `pg_catalog.set_config(${literal(k)}, ${literal(v)}, false)`);
    if (sets.length) {
      const all = await this.sql(`SELECT ${sets.join(', ')}`);
      // (one name the server does not know must not lose the rest)
      if (all.results[0]?.error) for (const one of sets) await this.sql(`SELECT ${one}`);
    }
    this.last = c;
  }

  /**
   * A new connection's role and database. A role that does not exist is
   * made (a superuser: the tab has one person), and so is a database named
   * after it, which is where psql and most drivers go when given no name.
   */
  private async admit(c: Conn): Promise<{ code: string; text: string } | null> {
    if (this.sessionUser !== 'postgres') {
      await this.sql('RESET SESSION AUTHORIZATION');
      this.sessionUser = 'postgres';
    }
    const role = await this.sql(`SELECT 1 FROM pg_roles WHERE rolname = ${literal(c.user)}`);
    if (!role.results[0]?.rows.length) {
      const made = await this.sql(`CREATE ROLE ${ident(c.user)} LOGIN SUPERUSER`);
      if (made.results[0]?.error) return { code: '28000', text: made.results[0].error.M ?? `role "${c.user}" does not exist` };
    }
    if (this.sessionUser !== c.user) {
      await this.sql(`SET SESSION AUTHORIZATION ${ident(c.user)}`);
      this.sessionUser = c.user;
    }
    const refused = await this.enter(c, c.database === c.user);
    if (!refused) await this.settle(c);
    return refused;
  }

  /** pg_dump of `database` for `user`, run by the backend itself (it is in turn like a connection). */
  async dump(user: string, database: string, args: string[]): Promise<Dump> {
    await this.start();
    const c: Conn = { id: 0, user, database, statements: new Set(), settings: [], sock: null as unknown as KSocket };
    await this.acquire(c);
    try {
      if (!this.engine) return { text: '', error: 'the server stopped' };
      const refused = await this.admit(c);
      if (refused) return { text: '', error: `connection to server failed: FATAL:  ${refused.text}` };
      return await this.engine.dump(args);
    } finally {
      this.release(c);
      this.keep();
    }
  }

  private async serve(sock: KSocket): Promise<void> {
    const c: Conn = { id: this.nextConn++, user: 'postgres', database: 'postgres', statements: new Set(), settings: [], sock };
    this.conns.add(c);
    const frames = new Frames();
    const buf = new Uint8Array(65536);
    const send = async (b: Uint8Array): Promise<void> => {
      for (let off = 0; off < b.length;) {
        const n = await sock.send(b.subarray(off));
        if (n <= 0) throw new Error('client gone');
        off += n;
      }
    };
    /** The next whole message; null when the client is gone */
    const next = async (untyped = false): Promise<Uint8Array | null> => {
      for (;;) {
        const m = frames.next(untyped);
        if (m) return m;
        const n = await sock.recv(buf);
        if (n <= 0) return null;
        frames.push(buf.slice(0, n));
      }
    };
    let holding = false;
    let status = 'I';
    const prefix = `c${c.id}_`;
    try {
      // Startup: no TLS (the connection never leaves the tab), no password
      for (;;) {
        const pkt = await next(true);
        if (!pkt) return;
        const { code, params } = parseStartup(pkt);
        if (code === SSL_REQUEST || code === GSSENC_REQUEST) { await send(new Uint8Array([0x4e /* N */])); continue; }
        if (code !== PROTOCOL_V3) return; // (a cancel request: nothing to cancel between messages)
        c.user = params.user || 'postgres';
        c.database = params.database || c.user;
        // (client_encoding, application_name, DateStyle, ...: the session's settings from its first statement)
        c.settings = Object.entries(params).filter(([k]) => !NOT_SETTINGS.test(k));
        break;
      }
      await this.acquire(c);
      try {
        if (!this.engine) return;
        const refused = await this.admit(c);
        if (refused) { await send(errorResponse('FATAL', refused.code, refused.text)); return; }
        await send(await this.engine.raw(startupPacket({ user: 'postgres', database: c.database })));
      } finally {
        this.release(c);
        this.keep();
      }

      for (;;) {
        const first = await next();
        if (!first || first[0] === 0x58 /* X */) return;
        // Every whole message that has arrived goes to the backend together
        const batch = [first];
        for (let m = frames.next(); m; m = frames.next()) batch.push(m);
        if (!holding) {
          await this.acquire(c);
          holding = true;
          if (!this.engine) return;
          const refused = await this.enter(c);
          if (refused) { await send(errorResponse('FATAL', refused.code, refused.text)); return; }
          await this.settle(c);
        }
        let quit = false;
        let run: Uint8Array[] = [];
        const flush = async () => {
          if (!run.length) return;
          const out = await this.engine!.raw(concat(run));
          run = [];
          status = lastStatus(out) || status;
          await send(out);
        };
        for (let i = 0; i < batch.length; i++) {
          const m = batch[i];
          const type = m[0];
          if (type === 0x58) { quit = true; break; }
          if (type === 0x51 /* Q */ || type === 0x50 /* P */) {
            const copy = copyFromStdin(sqlOf(m));
            if (copy) {
              await flush();
              if (type === 0x51 && copy === 'one') {
                // COPY ... FROM STDIN: the data is taken here and given to the backend whole
                const sql = sqlOf(m);
                await send(message('G', new Uint8Array([/binary/i.test(sql) ? 1 : 0, 0, 0])));
                const data: Uint8Array[] = [];
                let failed = '';
                for (;;) {
                  const d = i + 1 < batch.length ? batch[++i] : await next();
                  if (!d) return;
                  if (d[0] === 0x64 /* d */) data.push(d.subarray(5));
                  else if (d[0] === 0x63 /* c */) break;
                  else if (d[0] === 0x66 /* f */) { failed = new TextDecoder().decode(d.subarray(5)).replace(/\0$/, ''); break; }
                }
                const out = failed
                  ? concat([errorResponse('ERROR', '57014', `COPY from stdin failed: ${failed}`), readyForQuery(status)])
                  : await this.engine!.copyIn(sql, concat(data.length ? data : [new Uint8Array(0)]));
                status = lastStatus(out) || status;
                await send(out);
              } else {
                // (in the backend this would wait for data that never comes)
                const refuse = errorResponse('ERROR', '0A000', 'COPY FROM STDIN has to be a statement of its own, sent as a simple query, in this database');
                if (type === 0x51) await send(concat([refuse, readyForQuery(status)]));
                else {
                  await send(refuse);
                  // the rest of the extended-query sequence is skipped up to its Sync
                  for (;;) {
                    const d = i + 1 < batch.length ? batch[++i] : await next();
                    if (!d) return;
                    if (d[0] === 0x53 /* S */) break;
                  }
                  await send(readyForQuery(status));
                }
              }
              continue;
            }
          }
          run.push(renameStatement(m, prefix, c.statements));
        }
        await flush();
        this.keep();
        if (status === 'I') { holding = false; this.release(c); }
        if (quit) return;
      }
    } catch (e) {
      const text = (e as Error)?.message ?? String(e);
      if (text !== 'client gone' && this.status === 'running') {
        klog.log(LOG_WARNING, `postgres: connection ${c.id}: ${text}`);
        await sock.send(errorResponse('FATAL', '57P01', `the database stopped: ${text}`)).catch(() => {});
        void this.failed(text);
      }
    } finally {
      this.conns.delete(c);
      // What the connection left in the shared session goes with it
      if (this.engine && this.status === 'running') {
        try {
          if (!holding) await this.acquire(c);
          holding = true;
          if (status !== 'I') await this.engine.raw(query('ROLLBACK'));
          if (c.statements.size && this.database === c.database) {
            await this.engine.raw(query([...c.statements].map((n) => `DEALLOCATE ${ident(n)}`).join('; ')));
          }
        } catch { /* the backend is gone */ }
      }
      if (holding) this.release(c);
      void sock.close();
    }
  }

  /** The backend threw: drop it, so the next connection starts one on the kept files. */
  private async failed(why: string): Promise<void> {
    if (this.status !== 'running') return;
    this.error = why;
    this.status = 'stopped';
    for (const l of this.listeners) void l.close();
    this.listeners = [];
    for (const c of this.conns) void c.sock.close();
    const engine = this.engine;
    this.engine = null;
    this.wake();
    this.proc = null;
    this.busy = false;
    this.owner = null;
    for (const w of this.waiters.splice(0)) w();
    await engine?.close().catch(() => {});
  }
}

// ── the tab's one service ──

let service: PostgresService | null = null;

/** The tab's postgres service (made on first use; it starts on the first connection). */
export function postgresService(deps: PostgresDeps): PostgresService {
  return (service ??= new PostgresService(deps));
}

export function currentPostgres(): PostgresService | null { return service; }

/**
 * Make connections to 127.0.0.1:5432 start the service: called at boot, it
 * loads nothing until then. Returns the function that takes it out again.
 */
export function installPostgres(deps: PostgresDeps): () => void {
  const svc = postgresService(deps);
  const port = svc.port;
  const start = () => svc.start();
  deps.stack.onDemand.set(port, start);
  deps.stack.onDemand.set(svc.socket, start);
  return () => {
    for (const key of [port, svc.socket]) if (deps.stack.onDemand.get(key) === start) deps.stack.onDemand.delete(key);
    if (service === svc) service = null;
    void svc.stop();
  };
}
