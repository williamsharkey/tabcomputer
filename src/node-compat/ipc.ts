/**
 * node's IPC channel ('json' serialization: one JSON text per line; 'advanced': see ipcLine), for
 * fork() and stdio 'ipc' between kernel guests (src/node-worker/child.ts
 * makes the socketpair; the child finds it as NODE_CHANNEL_FD).
 */
import type { GuestIpc } from '../node-worker/hooks';
import { ProcessExitError } from '../commands/jseval/utils';

// (the Worker's own timer, captured before a script's globals stand in: no program activity)
const later = globalThis.setTimeout.bind(globalThis);

/**
 * One message's bytes on the channel. `advanced` (fork's serialization: 'advanced',
 * node's structured clone): a line starting with "A", whose JSON tags what JSON has
 * no word for (vitest 4's forks pool sends BigInt, Map, Set, Date, undefined…)
 */
export const ipcLine = (m: unknown, advanced = false): string =>
  (advanced ? 'A' + JSON.stringify(encodeClone(m)) : JSON.stringify(m)) + '\n';

const cloneError = (what: string) => Object.assign(new Error(`${what} could not be cloned.`), { name: 'DataCloneError', code: 25 });
const TYPED: Record<string, any> = {
  Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array,
  Float32Array, Float64Array, BigInt64Array, BigUint64Array, DataView,
};
const ERRORS: Record<string, ErrorConstructor> = { Error, EvalError, RangeError, ReferenceError, SyntaxError, TypeError, URIError };
const b64 = (u: Uint8Array) => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = (s: string) => { const t = atob(s); const u = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) u[i] = t.charCodeAt(i); return u; };

/** A value as structured clone sees it, in JSON: tagged arrays for all but strings, finite numbers, booleans and null */
export function encodeClone(v: unknown): unknown {
  const seen = new Map<object, number>();
  const enc = (x: any): unknown => {
    if (x === null || typeof x === 'string' || typeof x === 'boolean') return x;
    if (typeof x === 'number') return Number.isFinite(x) && !Object.is(x, -0) ? x : ['n', Object.is(x, -0) ? '-0' : String(x)];
    if (x === undefined) return ['u'];
    if (typeof x === 'bigint') return ['b', x.toString()];
    if (typeof x === 'function' || typeof x === 'symbol') throw cloneError(String(x));
    if (seen.has(x)) return ['r', seen.get(x)];
    const id = seen.size;
    seen.set(x, id);
    if (Array.isArray(x)) return ['A', id, x.map(enc)];
    if (x instanceof Date) return ['D', id, x.getTime()];
    if (x instanceof RegExp) return ['R', id, x.source, x.flags];
    if (x instanceof Map) return ['M', id, [...x].map(([k, val]) => [enc(k), enc(val)])];
    if (x instanceof Set) return ['S', id, [...x].map(enc)];
    if (x instanceof ArrayBuffer) return ['AB', id, b64(new Uint8Array(x))];
    if (ArrayBuffer.isView(x)) {
      const kind = x instanceof DataView ? 'DataView' : Object.keys(TYPED).find((k) => x instanceof TYPED[k] && Object.getPrototypeOf(x) === TYPED[k].prototype) ?? 'Uint8Array';
      return ['T', id, kind, b64(new Uint8Array(x.buffer, x.byteOffset, x.byteLength))];
    }
    if (x instanceof Error) {
      const extra: Record<string, unknown> = {};
      for (const k of Object.keys(x)) extra[k] = enc((x as any)[k]);
      return ['E', id, x.name, x.message, x.stack, 'cause' in x ? enc((x as any).cause) : ['u'], 'cause' in x, extra];
    }
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(x)) o[k] = enc(x[k]);
    return ['O', id, o];
  };
  return enc(v);
}

/** encodeClone's JSON back to the value */
export function decodeClone(v: unknown): unknown {
  const refs: unknown[] = [];
  const dec = (x: any): any => {
    if (!Array.isArray(x)) return x;
    switch (x[0]) {
      case 'u': return undefined;
      case 'n': return x[1] === '-0' ? -0 : Number(x[1]);
      case 'b': return BigInt(x[1]);
      case 'r': return refs[x[1]];
      case 'A': { const a: unknown[] = []; refs[x[1]] = a; for (const e of x[2]) a.push(dec(e)); return a; }
      case 'D': return (refs[x[1]] = new Date(x[2]));
      case 'R': return (refs[x[1]] = new RegExp(x[2], x[3]));
      case 'M': { const m = new Map(); refs[x[1]] = m; for (const [k, val] of x[2]) m.set(dec(k), dec(val)); return m; }
      case 'S': { const st = new Set(); refs[x[1]] = st; for (const e of x[2]) st.add(dec(e)); return st; }
      case 'AB': return (refs[x[1]] = unb64(x[2]).buffer);
      case 'T': {
        const u = unb64(x[3]);
        const C = TYPED[x[2]] ?? Uint8Array;
        return (refs[x[1]] = C === DataView ? new DataView(u.buffer) : new C(u.buffer, 0, u.byteLength / (C.BYTES_PER_ELEMENT ?? 1)));
      }
      case 'E': {
        const e: any = new (ERRORS[x[2]] ?? Error)(x[3]);
        refs[x[1]] = e;
        if (!ERRORS[x[2]]) e.name = x[2];
        e.stack = x[4];
        if (x[6]) e.cause = dec(x[5]);
        for (const [k, val] of Object.entries(x[7] ?? {})) e[k] = dec(val);
        return e;
      }
      case 'O': { const o: Record<string, unknown> = {}; refs[x[1]] = o; for (const [k, val] of Object.entries(x[2])) o[k] = dec(val); return o; }
      default: return x;
    }
  };
  return dec(v);
}

/** Bytes in, whole messages out (node's own NODE_* messages are not the program's) */
export function ipcReader(onMessage: (m: unknown) => void): (b: Uint8Array) => void {
  const dec = new TextDecoder();
  let buf = '';
  return (b) => {
    buf += dec.decode(b, { stream: true });
    for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let m: any;
      try { m = line[0] === 'A' ? decodeClone(JSON.parse(line.slice(1))) : JSON.parse(line); } catch { continue; }
      if (m && typeof m === 'object' && typeof m.cmd === 'string' && m.cmd.startsWith('NODE_')) continue;
      onMessage(m);
    }
  };
}

/** send()'s optional arguments: (message, [sendHandle], [options], [callback]) */
const callbackOf = (rest: unknown[]): ((e: Error | null) => void) | undefined => rest.find((a) => typeof a === 'function') as any;

const closedError = () => Object.assign(new Error('Channel closed'), { code: 'ERR_IPC_CHANNEL_CLOSED' });

/**
 * A forked node's side: process.send, process.on('message'), connected,
 * disconnect() and channel.ref()/unref(). Returns whether the channel keeps
 * the process alive (connected, ref()'d, and something listens), as in node.
 */
export function attachProcessIpc(proc: any, ipc: GuestIpc, events: Record<string, Function[]>, advanced = false): () => boolean {
  let refd = true;
  // The channel's events come from the Worker's timers, not from the script: process.exit() in a
  // listener (it throws ProcessExitError to unwind) ends the process there. Escaping, it was an
  // uncaught error in the Worker, which the kernel ends with status 1 ("Uncaught Error:
  // process.exit(0)"; a forked child's exit(0) on a 'message' read as 1). Other errors propagate.
  const emitFromChannel = (event: string, ...args: unknown[]): boolean => {
    try { proc.emit(event, ...args); return true; } catch (e) { if (e instanceof ProcessExitError) return false; throw e; }
  };
  const disconnected = () => {
    if (!proc.connected) return;
    proc.connected = false;
    queueMicrotask(() => { emitFromChannel('disconnect'); });
  };
  proc.connected = true;
  proc.channel = { ref() { refd = true; }, unref() { refd = false; } };
  proc.send = (message: unknown, ...rest: unknown[]) => {
    const cb = callbackOf(rest);
    if (!proc.connected) {
      const e = closedError();
      queueMicrotask(() => { if (!cb) emitFromChannel('error', e); else try { cb(e); } catch (x) { if (!(x instanceof ProcessExitError)) throw x; } });
      return false;
    }
    if (message === undefined) throw Object.assign(new TypeError('The "message" argument must be specified'), { code: 'ERR_MISSING_ARGS' });
    const ok = ipc.send(ipcLine(message, advanced));
    if (!ok) disconnected();
    // (a callback that exits, as vitest's forks worker's last send does: the exit, not an uncaught error)
    if (cb) queueMicrotask(() => { try { cb(ok ? null : closedError()); } catch (e) { if (!(e instanceof ProcessExitError)) throw e; } });
    return ok;
  };
  proc.disconnect = () => {
    if (!proc.connected) return;
    ipc.close();
    disconnected();
  };
  // Messages that came before anything listens wait for a listener (the parent may send
  // before the child's script has run: jest-worker's first message), then go in order
  const pending: unknown[] = [];
  let waiting = false;
  const flush = () => {
    waiting = false;
    if (!(events['message']?.length)) { if (pending.length && proc.connected) { waiting = true; later(flush, 5); } return; }
    // (once a listener exits, nothing more is delivered)
    for (const m of pending.splice(0)) if (!emitFromChannel('message', m, undefined)) break;
  };
  const read = ipcReader((m) => { pending.push(m); if (!waiting) flush(); });
  ipc.onData((b) => { if (b) read(b); else disconnected(); });
  return () => proc.connected && refd && ((events['message']?.length ?? 0) + (events['disconnect']?.length ?? 0)) > 0;
}
