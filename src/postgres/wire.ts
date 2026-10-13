/**
 * The PostgreSQL wire protocol (v3), as far as the tab's postgres service
 * and the built-in psql need it: framing, the startup packet, the messages
 * the service writes itself, and reading a simple query's results.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const PROTOCOL_V3 = 196608;
export const SSL_REQUEST = 80877103;
export const GSSENC_REQUEST = 80877104;
export const CANCEL_REQUEST = 80877102;

export function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const i32 = (b: Uint8Array, off: number) => ((b[off] << 24) | (b[off + 1] << 16) | (b[off + 2] << 8) | b[off + 3]) | 0;
const i16 = (b: Uint8Array, off: number) => (b[off] << 8) | b[off + 1];

/** One message: its type byte, its length, its body. */
export function message(type: string, ...body: (Uint8Array | string)[]): Uint8Array {
  const parts = body.map((p) => (typeof p === 'string' ? enc.encode(p) : p));
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(5 + len);
  out[0] = type.charCodeAt(0);
  new DataView(out.buffer).setInt32(1, 4 + len);
  let off = 5;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export const query = (sql: string): Uint8Array => message('Q', sql + '\0');
export const readyForQuery = (status: string): Uint8Array => message('Z', status);
export const commandComplete = (tag: string): Uint8Array => message('C', tag + '\0');

/** An ErrorResponse (or, with severity NOTICE/WARNING, the body of a NoticeResponse). */
export function errorResponse(severity: string, code: string, text: string, type = 'E'): Uint8Array {
  return message(type, `S${severity}\0V${severity}\0C${code}\0M${text}\0\0`);
}

export function startupPacket(params: Record<string, string>): Uint8Array {
  let body = '';
  for (const [k, v] of Object.entries(params)) body += `${k}\0${v}\0`;
  const b = enc.encode(body + '\0');
  const out = new Uint8Array(8 + b.length);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, out.length);
  dv.setInt32(4, PROTOCOL_V3);
  out.set(b, 8);
  return out;
}

/** The code of a startup-phase packet (a protocol version or a request code) and, for a startup, its parameters. */
export function parseStartup(pkt: Uint8Array): { code: number; params: Record<string, string> } {
  const code = i32(pkt, 4);
  const params: Record<string, string> = {};
  if (code === PROTOCOL_V3) {
    const words = dec.decode(pkt.subarray(8)).split('\0');
    for (let i = 0; i + 1 < words.length && words[i]; i += 2) params[words[i]] = words[i + 1];
  }
  return { code, params };
}

/**
 * Bytes in, whole messages out. Before the startup packet a message has no
 * type byte (`untyped`); afterwards each is a type byte and a length.
 */
export class Frames {
  private buf: Uint8Array = new Uint8Array(0);

  push(b: Uint8Array): void {
    this.buf = this.buf.length ? concat([this.buf, b]) : b;
  }

  /** The next whole message, or null until more bytes arrive. Throws on a length no message has. */
  next(untyped = false): Uint8Array | null {
    const head = untyped ? 4 : 5;
    if (this.buf.length < head) return null;
    const len = i32(this.buf, untyped ? 0 : 1) + (untyped ? 0 : 1);
    if (len < head || len > (1 << 30)) throw new Error('not a PostgreSQL message');
    if (this.buf.length < len) return null;
    const out = this.buf.subarray(0, len);
    this.buf = this.buf.subarray(len);
    return out;
  }

  get pending(): number { return this.buf.length; }
}

/** Each backend message of `b`: its type and its body. */
export function* messages(b: Uint8Array): Generator<{ type: string; body: Uint8Array; raw: Uint8Array }> {
  let off = 0;
  while (off + 5 <= b.length) {
    const len = i32(b, off + 1);
    if (len < 4 || off + 1 + len > b.length) return;
    yield { type: String.fromCharCode(b[off]), body: b.subarray(off + 5, off + 1 + len), raw: b.subarray(off, off + 1 + len) };
    off += 1 + len;
  }
}

/** The transaction status of the last ReadyForQuery in `b` ('I', 'T' or 'E'), or '' when it has none. */
export function lastStatus(b: Uint8Array): string {
  let status = '';
  for (const m of messages(b)) if (m.type === 'Z' && m.body.length === 1) status = String.fromCharCode(m.body[0]);
  return status;
}

/** The fields of an ErrorResponse or NoticeResponse body, by their one-letter codes (S, C, M, D, H, P, ...). */
export function errorFields(body: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of dec.decode(body).split('\0')) if (part) out[part[0]] = part.slice(1);
  return out;
}

export interface Column { name: string; typeOid: number; tableOid: number; }

/** One statement's result in a simple query's reply. */
export interface Result {
  columns: Column[] | null;
  rows: (string | null)[][];
  /** The command tag ("SELECT 2", "INSERT 0 1", "CREATE TABLE"); '' when the statement failed */
  tag: string;
  error?: Record<string, string>;
  /** COPY ... TO STDOUT: the data as sent */
  copyOut?: Uint8Array[];
}

export interface Reply {
  results: Result[];
  notices: Record<string, string>[];
  /** Transaction status after the reply ('I', 'T', 'E'), '' when no ReadyForQuery came */
  status: string;
  /** ParameterStatus values seen (the startup reply's server_version, ...) */
  params: Record<string, string>;
  /** The server asked for COPY data (CopyInResponse) */
  copyIn?: boolean;
  /** AuthenticationXXX request code other than Ok (3 cleartext, 5 md5, 10 SASL) */
  authRequest?: number;
}

/** Read a reply (the messages up to and including ReadyForQuery) into results. */
export function parseReply(b: Uint8Array): Reply {
  const reply: Reply = { results: [], notices: [], status: '', params: {} };
  let cur: Result | null = null;
  const open = (): Result => (cur ??= { columns: null, rows: [], tag: '' });
  const done = () => { if (cur) { reply.results.push(cur); cur = null; } };
  for (const m of messages(b)) {
    switch (m.type) {
      case 'T': {
        const r = open();
        const n = i16(m.body, 0);
        r.columns = [];
        let off = 2;
        for (let i = 0; i < n; i++) {
          let end = off;
          while (m.body[end] !== 0) end++;
          const name = dec.decode(m.body.subarray(off, end));
          off = end + 1;
          r.columns.push({ name, tableOid: i32(m.body, off), typeOid: i32(m.body, off + 6) });
          off += 18;
        }
        break;
      }
      case 'D': {
        const r = open();
        const n = i16(m.body, 0);
        const row: (string | null)[] = [];
        let off = 2;
        for (let i = 0; i < n; i++) {
          const len = i32(m.body, off);
          off += 4;
          if (len < 0) { row.push(null); continue; }
          row.push(dec.decode(m.body.subarray(off, off + len)));
          off += len;
        }
        r.rows.push(row);
        break;
      }
      case 'H': open().copyOut = []; break;
      case 'd': open().copyOut?.push(m.body.slice()); break;
      case 'G': reply.copyIn = true; break;
      case 'C': open().tag = dec.decode(m.body).replace(/\0$/, ''); done(); break;
      case 'I': open(); done(); break; // EmptyQueryResponse
      case 'E': open().error = errorFields(m.body); done(); break;
      case 'N': reply.notices.push(errorFields(m.body)); break;
      case 'S': {
        const [k, v] = dec.decode(m.body).split('\0');
        reply.params[k] = v;
        break;
      }
      case 'R': { const code = i32(m.body, 0); if (code !== 0) reply.authRequest = code; break; }
      case 'Z': reply.status = String.fromCharCode(m.body[0]); break;
    }
  }
  done();
  return reply;
}

/** `"name"` for an identifier, `'text'` for a literal. */
export const ident = (name: string): string => '"' + name.replace(/"/g, '""') + '"';
export const literal = (text: string): string => "'" + text.replace(/'/g, "''") + "'";

function cstringEnd(b: Uint8Array, off: number): number {
  while (off < b.length && b[off] !== 0) off++;
  return off;
}

/**
 * A frontend message with its prepared statement's name made this
 * connection's own (`prefix` + name), for Parse, Bind, Describe and Close.
 * Connections share one session, so two clients' "s1" must not be the same
 * statement. The unnamed statement stays unnamed.
 */
export function renameStatement(msg: Uint8Array, prefix: string, seen?: Set<string>): Uint8Array {
  const type = String.fromCharCode(msg[0]);
  let at = -1;
  if (type === 'P') at = 5;
  else if (type === 'B') at = cstringEnd(msg, 5) + 1; // after the portal's name
  else if ((type === 'D' || type === 'C') && msg[5] === 0x53 /* 'S' */) at = 6;
  if (at < 0) return msg;
  const end = cstringEnd(msg, at);
  if (end === at) return msg;
  const name = prefix + dec.decode(msg.subarray(at, end));
  if (type === 'P') seen?.add(name);
  if (type === 'C') seen?.delete(name);
  const nameBytes = enc.encode(name);
  const out = new Uint8Array(msg.length - (end - at) + nameBytes.length);
  out.set(msg.subarray(0, at), 0);
  out.set(nameBytes, at);
  out.set(msg.subarray(end), at + nameBytes.length);
  new DataView(out.buffer).setInt32(1, out.length - 1);
  return out;
}

/** The SQL text of a Query ('Q') or Parse ('P') message. */
export function sqlOf(msg: Uint8Array): string {
  const type = String.fromCharCode(msg[0]);
  if (type === 'Q') return dec.decode(msg.subarray(5, cstringEnd(msg, 5)));
  if (type === 'P') { const at = cstringEnd(msg, 5) + 1; return dec.decode(msg.subarray(at, cstringEnd(msg, at))); }
  return '';
}
