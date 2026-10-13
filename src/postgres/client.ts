/**
 * A PostgreSQL client over a socket of the tab's network: the startup, then
 * simple queries. The built-in psql, createdb, dropdb and pg_isready use it,
 * so they talk to whatever listens (the tab's own service, or a server a
 * student started on another port).
 */
import { KSocket, type NetStack } from '../kernel/net';
import { AF_INET, AF_INET6 } from '../kernel/abi';
import { Frames, concat, message, parseReply, query, startupPacket, type Reply } from './wire';

export interface ConnectOptions {
  stack: NetStack;
  host: string;
  port: number;
  user: string;
  database: string;
  appName?: string;
}

export class PgError extends Error {
  constructor(message: string, readonly fields: Record<string, string> = {}) { super(message); }
}

export class PgClient {
  /** server_version, is_superuser, ... as the server reported them */
  params: Record<string, string> = {};
  /** 'I' idle, 'T' in a transaction, 'E' in a failed transaction */
  status = 'I';
  private frames = new Frames();
  private buf = new Uint8Array(65536);
  private closed = false;

  private constructor(private sock: KSocket, readonly options: ConnectOptions) {}

  /** Connect and log in. Throws PgError with the server's words (or why no server answered). */
  static async connect(options: ConnectOptions): Promise<PgClient> {
    const { stack, host, port } = options;
    const where = `connection to server at "${host}", port ${port} failed`;
    const s = stack.socket(host.includes(':') ? AF_INET6 : AF_INET, 1 /* SOCK_STREAM */);
    if (!(s instanceof KSocket)) throw new PgError(`${where}: no socket`);
    const r = await s.connectHost(host, port);
    if (r < 0) {
      void s.close();
      throw new PgError(`${where}: ${r === -111 ? 'Connection refused' : r === -101 ? 'Network is unreachable' : `errno ${-r}`}\n\tIs the server running on that host and accepting TCP/IP connections?`);
    }
    const c = new PgClient(s, options);
    await c.write(startupPacket({
      user: options.user, database: options.database, application_name: options.appName ?? 'psql', client_encoding: 'UTF8',
    }));
    const reply = await c.read();
    const err = reply.results.find((x) => x.error)?.error;
    if (err) { c.close(); throw new PgError(`${where}: ${err.S ?? 'FATAL'}:  ${err.M ?? ''}`, err); }
    if (reply.authRequest) {
      c.close();
      throw new PgError(`${where}: the server asks for a password, which the built-in psql does not send (apt install postgresql-client has a psql that does)`);
    }
    if (!reply.status) { c.close(); throw new PgError(`${where}: server closed the connection unexpectedly`); }
    return c;
  }

  private async write(b: Uint8Array): Promise<void> {
    for (let off = 0; off < b.length;) {
      const n = await this.sock.send(b.subarray(off));
      if (n <= 0) throw new PgError('server closed the connection unexpectedly');
      off += n;
    }
  }

  /** Messages up to ReadyForQuery (or a request for COPY data, or the end of the connection). */
  private async read(): Promise<Reply> {
    const parts: Uint8Array[] = [];
    for (;;) {
      let m = this.frames.next();
      while (!m) {
        const n = await this.sock.recv(this.buf);
        if (n <= 0) { this.closed = true; return this.take(parts); }
        this.frames.push(this.buf.slice(0, n));
        m = this.frames.next();
      }
      parts.push(m);
      const type = m[0];
      if (type === 0x5a /* Z */ || type === 0x47 /* G */) return this.take(parts);
      // (an authentication request other than Ok ends what this client can do)
      if (type === 0x52 /* R */ && !(m[5] === 0 && m[6] === 0 && m[7] === 0 && m[8] === 0)) return this.take(parts);
    }
  }

  private take(parts: Uint8Array[]): Reply {
    const reply = parseReply(parts.length ? concat(parts) : new Uint8Array(0));
    Object.assign(this.params, reply.params);
    if (reply.status) this.status = reply.status;
    return reply;
  }

  /**
   * Run `sql` (one statement or several) and return every result. When the
   * server asks for COPY data, `copyData` supplies it (null: the copy fails).
   */
  async query(sql: string, copyData?: () => Promise<Uint8Array | null>): Promise<Reply> {
    if (this.closed) throw new PgError('server closed the connection unexpectedly');
    await this.write(query(sql));
    let reply = await this.read();
    while (reply.copyIn && !reply.status) {
      const data = copyData ? await copyData() : null;
      if (data === null) await this.write(message('f', 'no data was given\0'));
      else await this.write(concat([...(data.length ? [message('d', data)] : []), message('c')]));
      const more = await this.read();
      reply = { ...more, results: [...reply.results, ...more.results], notices: [...reply.notices, ...more.notices], copyIn: more.copyIn };
    }
    if (!reply.status && this.closed) {
      const fatal = reply.results.find((x) => x.error)?.error;
      if (!fatal) throw new PgError('server closed the connection unexpectedly');
    }
    return reply;
  }

  get open(): boolean { return !this.closed; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.sock.send(message('X')).catch(() => {});
    void this.sock.close();
  }
}
