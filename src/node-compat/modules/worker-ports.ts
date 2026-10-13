/**
 * worker_threads' MessageChannel and MessagePort (tabcomputer#82).
 *
 * A channel's two ports are joined: what one posts, the other gets as a
 * 'message', a task later, once something listens (or start() is called).
 *
 * A port can go to another thread in a postMessage's transfer list (tinypool
 * hands each worker its port so; vitest's threads pool sends one per test
 * file through that). Threads here talk through the page, which can't carry
 * a port of ours, so a transferred port travels as an id: the message is
 * wrapped, the port's place in it marked, and from then on what either end
 * posts goes over the same thread link under that id (a `PortLink`: a Worker
 * and its thread's parentPort are the two ends of one).
 */

/** The key of a wrapped message; nothing a program posts has it */
const WIRE = '\u0000tabcomputer-wt';

type Emitter = (obj: any) => any;

/** One side of the path between a Worker's thread and its parent */
export interface PortLink {
  send(wire: unknown): void;
  /** This side's ports whose other end is across the link, by id */
  ports: Map<string, any>;
}

export interface WorkerPorts {
  MessagePort: any;
  MessageChannel: any;
  receiveMessageOnPort(port: any): { message: unknown } | undefined;
  /** A copy of `value` for this thread, the ports in `transfer` handed over as they are */
  localClone(value: unknown, transfer?: unknown[]): unknown;
  /** A link's side: `send` carries a wrapped message to the other side */
  link(send: (wire: unknown) => void): PortLink;
  /** What to send over `link` for postMessage(value, transfer); `after` runs once it is sent */
  encode(link: PortLink, value: unknown, transfer?: unknown[]): { wire: unknown; after(): void };
  /** A message from across `link`: `{ value }` for the program, or null when it was a port's */
  receive(link: PortLink, wire: unknown): { value: unknown } | null;
  /** The other side is gone: its ports here close */
  unlink(link: PortLink): void;
  /** A port listened to whose other end is in another thread: what keeps a thread running */
  alive(): boolean;
}

const isPlain = (v: any) => { const p = Object.getPrototypeOf(v); return p === Object.prototype || p === null; };

export function createWorkerPorts(makeEmitter: Emitter, defer: (fn: () => void) => void): WorkerPorts {
  let nextId = 0;
  const prefix = Math.random().toString(36).slice(2, 10);
  /** Open ports with an end in another thread */
  const remote = new Set<any>();

  class MessagePort {
    _peer: MessagePort | null = null;
    _route: { link: PortLink; id: string } | null = null;
    _queue: unknown[] = [];
    _started = false;
    _closed = false;
    _refd = true;
    _flushing = false;
    _onmessage: ((ev: { data: unknown }) => void) | null = null;
    constructor() {
      makeEmitter(this);
      // listening for 'message' starts the port, as in node
      const self = this as any;
      for (const k of ['on', 'addListener', 'once']) {
        const orig = self[k];
        self[k] = (ev: string, fn: Function) => { const r = orig(ev, fn); if (ev === 'message') this.start(); return r; };
      }
    }
    get onmessage() { return this._onmessage; }
    set onmessage(fn: ((ev: { data: unknown }) => void) | null) { this._onmessage = typeof fn === 'function' ? fn : null; if (this._onmessage) this.start(); }
    addEventListener(ev: string, fn: (e: { data: unknown }) => void) {
      const wrapped = (data: unknown) => fn({ data });
      (fn as any).__tcPortListener = wrapped;
      (this as any).on(ev, ev === 'message' ? wrapped : fn);
    }
    removeEventListener(ev: string, fn: Function) { (this as any).off(ev, (fn as any).__tcPortListener ?? fn); }
    postMessage(value: unknown, transfer?: unknown[]) {
      if (this._closed) return;
      if (this._route) {
        const { link, id } = this._route;
        const m = encode(link, value, transfer);
        link.send({ [WIRE]: 'port', id, m: m.wire });
        m.after();
      } else if (this._peer) {
        this._peer._enqueue(localClone(value, transfer));
      }
    }
    _enqueue(value: unknown) {
      if (this._closed) return;
      this._queue.push(value);
      this._flush();
    }
    _flush() {
      if (this._flushing || !this._started || !this._queue.length) return;
      this._flushing = true;
      defer(() => {
        this._flushing = false;
        while (this._queue.length && !this._closed && this._started) {
          const v = this._queue.shift();
          try { this._onmessage?.({ data: v }); } catch { /* a handler's own error */ }
          (this as any).emit('message', v);
        }
      });
    }
    start() { this._started = true; this._flush(); }
    close() {
      if (this._closed) return;
      const peer = this._peer, route = this._route;
      this._shut();
      if (peer) peer._shut();
      if (route) route.link.send({ [WIRE]: 'close', id: route.id });
    }
    /** Closed from either end: no more messages, 'close' a task later */
    _shut() {
      if (this._closed) return;
      this._closed = true;
      this._peer = null;
      if (this._route) { this._route.link.ports.delete(this._route.id); this._route = null; }
      remote.delete(this);
      defer(() => { (this as any).emit('close'); });
    }
    ref() { this._refd = true; return this; }
    unref() { this._refd = false; return this; }
    hasRef() { return this._refd; }
  }

  class MessageChannel {
    port1: MessagePort;
    port2: MessagePort;
    constructor() {
      this.port1 = new MessagePort();
      this.port2 = new MessagePort();
      this.port1._peer = this.port2;
      this.port2._peer = this.port1;
    }
  }

  const portsOf = (transfer?: unknown[]): MessagePort[] => (Array.isArray(transfer) ? transfer.filter((t): t is MessagePort => t instanceof MessagePort) : []);

  /** `value` with each of `ports` swapped for what `mark` gives (plain objects and arrays copied on the way; null: none found) */
  function swapPorts(value: unknown, ports: Set<MessagePort>, mark: (p: MessagePort) => unknown): unknown {
    const seen = new Map<object, unknown>();
    const walk = (v: any): any => {
      if (v === null || typeof v !== 'object') return v;
      if (v instanceof MessagePort) return ports.has(v) ? mark(v) : v;
      if (seen.has(v)) return seen.get(v);
      if (Array.isArray(v)) { const out: unknown[] = []; seen.set(v, out); for (const x of v) out.push(walk(x)); return out; }
      if (!isPlain(v)) return v;
      const out: Record<string, unknown> = {};
      seen.set(v, out);
      for (const k of Object.keys(v)) out[k] = walk(v[k]);
      return out;
    };
    return walk(value);
  }
  /** The reverse, after a clone: marks back to ports, in place */
  function revive(value: unknown, port: (mark: any) => unknown): unknown {
    const seen = new Set<object>();
    const walk = (v: any): any => {
      if (v === null || typeof v !== 'object') return v;
      if (v[WIRE] === 'ref') return port(v);
      if (seen.has(v) || !(Array.isArray(v) || isPlain(v))) return v;
      seen.add(v);
      for (const k of Object.keys(v)) { const x = v[k]; if (x !== null && typeof x === 'object') v[k] = walk(x); }
      return v;
    };
    return walk(value);
  }

  function localClone(value: unknown, transfer?: unknown[]): unknown {
    const ports = portsOf(transfer);
    const clone = (v: unknown) => { try { return structuredClone(v); } catch { return v; } };
    if (!ports.length) return clone(value);
    // the same thread: the port itself is what arrives
    const moved: MessagePort[] = [];
    const marked = swapPorts(value, new Set(ports), (p) => ({ [WIRE]: 'ref', n: moved.push(p) - 1 }));
    return revive(clone(marked), (m) => moved[m.n]);
  }

  /** Give `port` to the thread across `link`: its id there; what its other end posts goes over the link from now on */
  function moveOut(link: PortLink, port: MessagePort, after: (() => void)[]): string {
    const id = `${prefix}:${++nextId}`;
    if (port._route) {
      // a port that came from another thread, passed on: this thread stays between the two
      const relay = new MessageChannel();
      const pass = (from: MessagePort, to: MessagePort) => { from.unref(); (from as any).on('message', (v: unknown) => to.postMessage(v, findPorts(v))); (from as any).on('close', () => to.close()); };
      pass(port, relay.port1);
      pass(relay.port1, port);
      port = relay.port2;
    }
    const stays = port._peer;
    const waiting = port._queue.splice(0);
    port._peer = null;
    port._closed = true; // (handed over: this object is done, as node's is)
    if (stays) {
      stays._peer = null;
      stays._route = { link, id };
      link.ports.set(id, stays);
      remote.add(stays);
    }
    // what it had not delivered yet goes with it
    if (waiting.length) after.push(() => { for (const v of waiting) { const m = encode(link, v, findPorts(v)); link.send({ [WIRE]: 'into', id, m: m.wire }); m.after(); } });
    return id;
  }
  function findPorts(value: unknown): MessagePort[] {
    const found: MessagePort[] = [];
    const seen = new Set<object>();
    const walk = (v: any) => {
      if (v === null || typeof v !== 'object' || seen.has(v)) return;
      seen.add(v);
      if (v instanceof MessagePort) { found.push(v); return; }
      if (Array.isArray(v) || isPlain(v)) for (const k of Object.keys(v)) walk(v[k]);
    };
    walk(value);
    return found;
  }

  function encode(link: PortLink, value: unknown, transfer?: unknown[]): { wire: unknown; after(): void } {
    const ports = portsOf(transfer);
    if (!ports.length) return { wire: value, after() {} };
    const after: (() => void)[] = [];
    const ids = new Map<MessagePort, string>();
    const v = swapPorts(value, new Set(ports), (p) => {
      if (!ids.has(p)) ids.set(p, moveOut(link, p, after));
      return { [WIRE]: 'ref', id: ids.get(p) };
    });
    return { wire: { [WIRE]: 'msg', v }, after() { for (const fn of after) fn(); } };
  }

  /** A wrapped message's value, its marks made ports whose other end is across `link` */
  function unwrap(link: PortLink, m: any): unknown {
    if (m === null || typeof m !== 'object' || m[WIRE] !== 'msg') return m;
    return revive(m.v, (mark) => {
      const port = new MessagePort();
      port._route = { link, id: mark.id };
      link.ports.set(mark.id, port);
      remote.add(port);
      return port;
    });
  }

  function receive(link: PortLink, wire: any): { value: unknown } | null {
    const kind = wire !== null && typeof wire === 'object' ? wire[WIRE] : undefined;
    if (kind === undefined) return { value: wire };
    if (kind === 'msg') return { value: unwrap(link, wire) };
    const port = link.ports.get(wire.id);
    if (!port) return null;
    // 'port': from its other end; 'into': what the port held when it was sent here
    if (kind === 'port' || kind === 'into') port._enqueue(unwrap(link, wire.m));
    else if (kind === 'close') port._shut();
    return null;
  }

  return {
    MessagePort,
    MessageChannel,
    receiveMessageOnPort(port: any) {
      if (!(port instanceof MessagePort) || !port._queue.length) return undefined;
      return { message: port._queue.shift() };
    },
    localClone,
    link: (send) => ({ send, ports: new Map() }),
    encode,
    receive,
    unlink(link) { for (const p of [...link.ports.values()]) p._shut(); link.ports.clear(); },
    alive() {
      for (const p of remote) if (!p._closed && p._refd && p._started && ((p as any).listenerCount('message') > 0 || p._onmessage)) return true;
      return false;
    },
  };
}
