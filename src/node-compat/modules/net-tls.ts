/**
 * Node.js 'net' and 'tls' module shims.
 *
 * net.Socket / net.Server are real TCP over kernel sockets (src/kernel/net.ts):
 * outbound connections go through the server's TCP relay, localhost reaches
 * net servers in the same page, and a net.Server is also published on the
 * virtual-server port table. A path instead of a port is a Unix domain socket
 * (the kernel's AF_UNIX): Claude Code's background sessions talk over them.
 * tls has no userspace TLS implementation here, so
 * it keeps the old inert socket instead of sending plaintext to a TLS port.
 */

import {
  netStack, NetStack, KSocket, AF_INET, AF_INET6, AF_UNIX, SOCK_STREAM, SHUT_WR, IPPROTO_TCP, TCP_NODELAY,
  SOL_SOCKET, SO_KEEPALIVE, errnoName, ipFamily, ipv6Groups, type UnixOps,
} from '../../kernel/net';

export interface NetDeps {
  /** Buffer implementation for 'data' chunks (Uint8Array when absent). */
  Buffer?: { from(data: any, encoding?: string): any };
  stack?: NetStack;
  /** Unix sockets on the page's stack: their socket files (a guest's stack has the kernel's) */
  unix?: UnixOps;
}

type Listener = (...args: any[]) => void;

/** An IPv6 literal in its short form, as libuv parses it ('0000:…:0000' is '::', vite probes both) */
function canonicalIp(host: string): string {
  if (ipFamily(host) !== 6) return host;
  try { return new URL(`http://[${host}]/`).hostname.slice(1, -1); } catch { return host; }
}

class Emitter {
  _events: Record<string, Listener[]> = {};
  on(ev: string, fn: Listener) { (this._events[ev] ||= []).push(fn); this._onListener(ev); return this; }
  addListener(ev: string, fn: Listener) { return this.on(ev, fn); }
  prependListener(ev: string, fn: Listener) { (this._events[ev] ||= []).unshift(fn); this._onListener(ev); return this; }
  once(ev: string, fn: Listener) {
    const w = (...a: any[]) => { this.off(ev, w); fn(...a); };
    (w as any).listener = fn;
    return this.on(ev, w);
  }
  off(ev: string, fn: Listener) {
    this._events[ev] = (this._events[ev] || []).filter((f) => f !== fn && (f as any).listener !== fn);
    return this;
  }
  removeListener(ev: string, fn: Listener) { return this.off(ev, fn); }
  removeAllListeners(ev?: string) { if (ev) delete this._events[ev]; else this._events = {}; return this; }
  listeners(ev: string) { return [...(this._events[ev] || [])]; }
  listenerCount(ev: string) { return (this._events[ev] || []).length; }
  setMaxListeners() { return this; }
  getMaxListeners() { return 10; }
  eventNames() { return Object.keys(this._events); }
  emit(ev: string, ...args: any[]) {
    const fns = this._events[ev];
    if (!fns?.length) return false;
    for (const f of [...fns]) f(...args);
    return true;
  }
  _onListener(_ev: string) {}
}

function sysError(errno: number, syscall: string, address?: string, port?: number): Error {
  const code = errnoName(-errno);
  const where = address !== undefined ? ` ${address}${port !== undefined ? `:${port}` : ''}` : '';
  const err: any = new Error(`${syscall} ${code}${where}`);
  err.code = code; err.errno = errno; err.syscall = syscall;
  if (address !== undefined) err.address = address;
  if (port !== undefined) err.port = port;
  return err;
}

const familyName = (f: number) => (f === AF_INET6 ? 'IPv6' : 'IPv4');
/** A Unix socket's path where node takes one: a string that isn't a port number */
const pathArg = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' && !/^\s*\d+\s*$/.test(v) ? v : undefined);

export function createNetModule(deps: NetDeps = {}): any {
  const stack = deps.stack ?? netStack;
  const toChunk = (b: Uint8Array) => (deps.Buffer ? deps.Buffer.from(b) : b);
  const toBytes = (data: any, encoding?: string): Uint8Array => {
    if (data instanceof Uint8Array) return data;
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (deps.Buffer && encoding && encoding !== 'utf8' && encoding !== 'utf-8') return deps.Buffer.from(String(data), encoding);
    return new TextEncoder().encode(String(data));
  };

  class Socket extends Emitter {
    connecting = false;
    pending = true;
    destroyed = false;
    readable = true;
    writable = true;
    allowHalfOpen: boolean;
    bytesRead = 0;
    bytesWritten = 0;
    readableEnded = false;
    writableEnded = false;
    writableFinished = false;
    _ksock: KSocket | null = null;
    private flowing: boolean | null = null;
    private resumeWaiters: (() => void)[] = [];
    private decoder: TextDecoder | null = null;
    private queued: { data: Uint8Array; cb?: (e?: Error | null) => void }[] = [];
    private writeChain: Promise<void> = Promise.resolve();
    private pendingBytes = 0;
    private needDrain = false;
    private endRequested = false;
    private idleMs = 0;
    private idleTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(opts: { allowHalfOpen?: boolean } = {}) {
      super();
      this.allowHalfOpen = !!opts.allowHalfOpen;
    }

    /** @internal Wrap an accepted kernel socket. */
    static _fromKernel(k: KSocket, allowHalfOpen = false): Socket {
      const s = new Socket({ allowHalfOpen });
      s._ksock = k;
      s.pending = false;
      s.startReading();
      return s;
    }

    get readyState() {
      if (this.connecting) return 'opening';
      if (this.destroyed || (!this.readable && !this.writable)) return 'closed';
      if (!this.readable) return 'writeOnly';
      if (!this.writable) return 'readOnly';
      return 'open';
    }
    get remoteAddress() { const p = this._ksock?.getpeername(); return p && typeof p !== 'number' ? p.address : undefined; }
    get remotePort() { const p = this._ksock?.getpeername(); return p && typeof p !== 'number' ? p.port : undefined; }
    get remoteFamily() { const p = this._ksock?.getpeername(); return p && typeof p !== 'number' ? familyName(p.family) : undefined; }
    get localAddress() { return this._ksock?.getsockname().address; }
    get localPort() { return this._ksock?.getsockname().port; }
    get bufferSize() { return this.pendingBytes; }
    get writableLength() { return this.pendingBytes; }
    address() {
      const a = this._ksock?.getsockname();
      return a ? { address: a.address, family: familyName(a.family), port: a.port } : {};
    }

    connect(...args: any[]): this {
      let opts: any;
      let cb: Listener | undefined;
      if (typeof args[0] === 'object' && args[0] !== null) { opts = args[0]; cb = args[1]; }
      else {
        opts = { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined };
        cb = typeof args[1] === 'function' ? args[1] : args[2];
      }
      if (typeof args[0] === 'string' && pathArg(args[0]) !== undefined) opts = { path: args[0] };
      if (cb) this.once('connect', cb);
      if (opts.path !== undefined) return this.connectPath(String(opts.path));
      const port = Number(opts.port);
      const host: string = opts.host || 'localhost';
      if (opts.allowHalfOpen !== undefined) this.allowHalfOpen = !!opts.allowHalfOpen;
      if (opts.timeout) this.setTimeout(opts.timeout);
      this.connecting = true;
      const fam = opts.family === 6 || ipFamily(host) === 6 ? AF_INET6 : AF_INET;
      const k = stack.socket(fam, SOCK_STREAM) as KSocket;
      this._ksock = k;
      (async () => {
        const r = ipFamily(host)
          ? await k.connect({ family: ipFamily(host) === 6 ? AF_INET6 : AF_INET, address: canonicalIp(host), port })
          : await k.connectHost(host, port);
        if (this.destroyed) { void k.close(); return; }
        this.connecting = false;
        if (r < 0) { this.destroy(sysError(r, 'connect', host, port)); return; }
        this.pending = false;
        const peer = k.getpeername();
        if (typeof peer !== 'number' && !ipFamily(host)) this.emit('lookup', null, peer.address, peer.family === AF_INET6 ? 6 : 4, host);
        this.emit('connect');
        this.emit('ready');
        for (const q of this.queued.splice(0)) this.enqueueWrite(q.data, q.cb);
        if (this.endRequested) this.finishEnd();
        this.startReading();
      })();
      return this;
    }

    /** A Unix domain socket (the kernel's AF_UNIX) */
    private connectPath(path: string): this {
      this.connecting = true;
      const k = stack.socket(AF_UNIX, SOCK_STREAM) as KSocket;
      this._ksock = k;
      (async () => {
        const addr = { family: AF_UNIX, address: path, port: 0 };
        const r = deps.unix && stack instanceof NetStack ? await stack.connectUnix(k, addr, deps.unix) : await k.connect(addr);
        if (this.destroyed) { void k.close(); return; }
        this.connecting = false;
        if (r < 0) { this.destroy(sysError(r, 'connect', path)); return; }
        this.pending = false;
        this.emit('connect');
        this.emit('ready');
        for (const q of this.queued.splice(0)) this.enqueueWrite(q.data, q.cb);
        if (this.endRequested) this.finishEnd();
        this.startReading();
      })();
      return this;
    }

    // ── reading ──

    _onListener(ev: string) {
      if (ev === 'data' && this.flowing === null) this.resume();
    }
    setEncoding(enc = 'utf8') { this.decoder = new TextDecoder(enc === 'utf8' ? 'utf-8' : enc); return this; }
    pause() { this.flowing = false; return this; }
    resume() {
      this.flowing = true;
      for (const w of this.resumeWaiters.splice(0)) w();
      return this;
    }
    isPaused() { return this.flowing === false; }

    private startReading() {
      const k = this._ksock!;
      const buf = new Uint8Array(64 * 1024);
      (async () => {
        for (;;) {
          while (this.flowing !== true && !this.destroyed) await new Promise<void>((r) => this.resumeWaiters.push(r));
          if (this.destroyed) return;
          const n = await k.read(buf);
          if (this.destroyed) return;
          if (n > 0) {
            this.bytesRead += n;
            this.touch();
            const bytes = buf.slice(0, n);
            this.emit('data', this.decoder ? this.decoder.decode(bytes, { stream: true }) : toChunk(bytes));
            continue;
          }
          if (n === 0) {
            this.readable = false;
            this.readableEnded = true;
            this.emit('end');
            if (!this.allowHalfOpen && !this.writableEnded) this.end();
            this.maybeClose();
            return;
          }
          this.destroy(sysError(n, 'read'));
          return;
        }
      })();
    }

    pipe(dest: any, opts: { end?: boolean } = {}) {
      this.on('data', (chunk: any) => {
        if (dest.write(chunk) === false && typeof dest.once === 'function') {
          this.pause();
          dest.once('drain', () => this.resume());
        }
      });
      if (opts.end !== false) this.on('end', () => dest.end?.());
      dest.emit?.('pipe', this);
      return dest;
    }
    unpipe() { return this; }

    async *[Symbol.asyncIterator]() {
      const chunks: any[] = [];
      let done = false;
      let failure: Error | null = null;
      let wake: (() => void) | null = null;
      const kick = () => { wake?.(); wake = null; };
      this.on('data', (c: any) => { chunks.push(c); kick(); });
      this.on('end', () => { done = true; kick(); });
      this.on('error', (e: Error) => { failure = e; kick(); });
      this.on('close', () => { done = true; kick(); });
      for (;;) {
        if (chunks.length) { yield chunks.shift(); continue; }
        if (failure) throw failure;
        if (done) return;
        await new Promise<void>((r) => { wake = r; });
      }
    }

    // ── writing ──

    write(data: any, encoding?: any, cb?: any): boolean {
      if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (this.writableEnded || this.destroyed) {
        const err: any = new Error('This socket has been ended by the other party');
        err.code = 'EPIPE';
        queueMicrotask(() => { cb?.(err); this.emit('error', err); });
        return false;
      }
      const bytes = toBytes(data, encoding);
      this.pendingBytes += bytes.length;
      if (this.connecting || !this._ksock) this.queued.push({ data: bytes, cb });
      else this.enqueueWrite(bytes, cb);
      const ok = this.pendingBytes < 16 * 1024;
      if (!ok) this.needDrain = true;
      return ok;
    }

    private enqueueWrite(bytes: Uint8Array, cb?: (e?: Error | null) => void) {
      const k = this._ksock!;
      this.writeChain = this.writeChain.then(async () => {
        if (this.destroyed) return;
        let off = 0;
        while (off < bytes.length) {
          const n = await k.write(bytes.subarray(off));
          if (n < 0) { const e = sysError(n, 'write'); cb?.(e); this.destroy(e); return; }
          off += n;
        }
        this.bytesWritten += bytes.length;
        this.pendingBytes -= bytes.length;
        this.touch();
        cb?.(null);
        if (this.needDrain && this.pendingBytes === 0) { this.needDrain = false; this.emit('drain'); }
      });
    }

    end(data?: any, encoding?: any, cb?: any): this {
      if (typeof data === 'function') { cb = data; data = undefined; }
      else if (typeof encoding === 'function') { cb = encoding; encoding = undefined; }
      if (data !== undefined && data !== null) this.write(data, encoding);
      if (cb) this.once('finish', cb);
      if (this.writableEnded) return this;
      this.writableEnded = true;
      this.endRequested = true;
      if (!this.connecting && this._ksock) this.finishEnd();
      return this;
    }

    private finishEnd() {
      this.writeChain = this.writeChain.then(() => {
        if (this.destroyed) return;
        this._ksock?.shutdown(SHUT_WR);
        this.writable = false;
        this.writableFinished = true;
        this.emit('finish');
        this.maybeClose();
      });
    }

    private maybeClose() {
      if (!this.readable && !this.writable && !this.destroyed) this.destroy();
    }

    destroy(err?: Error): this {
      if (this.destroyed) return this;
      this.destroyed = true;
      this.connecting = false;
      this.readable = false;
      this.writable = false;
      if (this.idleTimer) clearTimeout(this.idleTimer);
      for (const w of this.resumeWaiters.splice(0)) w();
      void this._ksock?.close();
      queueMicrotask(() => {
        if (err && this.listenerCount('error')) this.emit('error', err);
        this.emit('close', !!err);
      });
      return this;
    }
    destroySoon() { this.end(); return this; }
    resetAndDestroy() { return this.destroy(); }

    setTimeout(ms: number, cb?: Listener) {
      this.idleMs = ms;
      if (cb) this.once('timeout', cb);
      this.touch();
      return this;
    }
    private touch() {
      if (this.idleTimer) clearTimeout(this.idleTimer);
      this.idleTimer = this.idleMs > 0 && !this.destroyed ? setTimeout(() => this.emit('timeout'), this.idleMs) : null;
    }
    setNoDelay(noDelay = true) { this._ksock?.setsockopt(IPPROTO_TCP, TCP_NODELAY, noDelay ? 1 : 0); return this; }
    setKeepAlive(enable = false) { this._ksock?.setsockopt(SOL_SOCKET, SO_KEEPALIVE, enable ? 1 : 0); return this; }
    ref() { return this; }
    unref() { return this; }
    cork() {}
    uncork() {}
    setDefaultEncoding() { return this; }
  }

  class Server extends Emitter {
    listening = false;
    maxConnections = Infinity;
    private ksock: KSocket | null = null;
    private conns = new Set<Socket>();
    private opts: { allowHalfOpen?: boolean };

    constructor(opts?: any, listener?: Listener) {
      super();
      if (typeof opts === 'function') { listener = opts; opts = {}; }
      this.opts = opts || {};
      if (listener) this.on('connection', listener);
    }

    listen(...args: any[]): this {
      let port = 0, host: string | undefined, backlog = 511;
      const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined;
      let path: string | undefined;
      if (typeof args[0] === 'object' && args[0] !== null) {
        port = Number(args[0].port ?? 0); host = args[0].host; backlog = args[0].backlog ?? backlog;
        if (typeof args[0].path === 'string') path = args[0].path;
      } else if ((path = pathArg(args[0])) !== undefined) {
        if (typeof args[1] === 'number') backlog = args[1];
      } else {
        port = Number(args[0] ?? 0);
        if (typeof args[1] === 'string') { host = args[1]; if (typeof args[2] === 'number') backlog = args[2]; }
        else if (typeof args[1] === 'number') backlog = args[1];
      }
      if (cb) this.once('listening', cb);
      const fam = path !== undefined ? AF_UNIX : host && ipFamily(host) === 6 ? AF_INET6 : AF_INET;
      const k = stack.socket(fam, SOCK_STREAM) as KSocket;
      const addr = path ?? (host && ipFamily(host) ? canonicalIp(host) : fam === AF_INET6 ? '::' : '0.0.0.0');
      const fail = (r: number) => {
        void k.close();
        this.emit('error', path !== undefined ? sysError(r, 'listen', path) : sysError(r, 'listen', addr, port));
      };
      // A Unix socket in the page: its socket file on this process's filesystem (a guest's bind is the kernel's)
      if (path !== undefined && deps.unix && stack instanceof NetStack) {
        void stack.bindUnix(k, { family: AF_UNIX, address: path, port: 0 }, deps.unix).then((r) => {
          if (r === 0) r = k.listen(backlog);
          if (r < 0) { fail(r); return; }
          this.ksock = k;
          this.listening = true;
          this.emit('listening');
          this.accepting(k);
        });
        return this;
      }
      let r = k.bind({ family: fam, address: addr, port: path !== undefined ? 0 : port });
      if (r === 0) r = k.listen(backlog);
      if (r < 0) {
        queueMicrotask(() => fail(r));
        return this;
      }
      this.ksock = k;
      this.listening = true;
      queueMicrotask(() => this.emit('listening'));
      this.accepting(k);
      return this;
    }

    private accepting(k: KSocket): void {
      (async () => {
        for (;;) {
          const c = await k.accept();
          if (typeof c === 'number') return;
          if (this.conns.size >= this.maxConnections) { void c.close(); continue; }
          const s = Socket._fromKernel(c, !!this.opts.allowHalfOpen);
          this.conns.add(s);
          s.on('close', () => this.conns.delete(s));
          this.emit('connection', s);
        }
      })();
    }

    /** node's listening handle: set while listening, null before and after (supertest closes a server only if it has one) */
    get _handle(): { fd: number; ref(): void; unref(): void; hasRef(): boolean } | null {
      return this.listening ? { fd: -1, ref() {}, unref() {}, hasRef: () => true } : null;
    }

    address() {
      if (!this.ksock || !this.listening) return null;
      const a = this.ksock.getsockname();
      // (a Unix socket's address is its path, as node's)
      if (a.family === AF_UNIX) return a.address;
      return { address: a.address, family: familyName(a.family), port: a.port };
    }

    close(cb?: (err?: Error) => void) {
      if (!this.listening) {
        const err: any = new Error('Server is not running.');
        err.code = 'ERR_SERVER_NOT_RUNNING';
        queueMicrotask(() => cb?.(err));
        return this;
      }
      this.listening = false;
      void this.ksock?.close();
      this.ksock = null;
      const done = () => { this.emit('close'); cb?.(); };
      if (!this.conns.size) queueMicrotask(done);
      else {
        let left = this.conns.size;
        for (const s of this.conns) s.once('close', () => { if (--left === 0) done(); });
      }
      return this;
    }
    getConnections(cb: (err: Error | null, n: number) => void) { queueMicrotask(() => cb(null, this.conns.size)); return this; }
    ref() { return this; }
    unref() { return this; }
  }

  const connect = (...args: any[]) => {
    const opts = typeof args[0] === 'object' && args[0] !== null ? args[0] : {};
    const s = new Socket({ allowHalfOpen: opts.allowHalfOpen });
    return s.connect(...args);
  };

  return {
    Socket,
    Stream: Socket,
    Server,
    createServer: (opts?: any, listener?: Listener) => new Server(opts, listener),
    createConnection: connect,
    connect,
    BlockList,
    SocketAddress,
    // (an IPv6 zone ID, fe80::1%eth0, is part of a valid address)
    isIP: (input: string) => ipFamily(noZone(String(input))),
    isIPv4: (input: string) => ipFamily(String(input)) === 4,
    isIPv6: (input: string) => ipFamily(noZone(String(input))) === 6,
    getDefaultAutoSelectFamily: () => false,
    setDefaultAutoSelectFamily: () => {},
  };
}

type IpFamily = 'ipv4' | 'ipv6';
/** An IPv6 address without its zone ID: node accepts fe80::1%eth0 and ignores the zone */
const noZone = (a: string): string => { const i = a.indexOf('%'); return i > 0 && a.includes(':') ? a.slice(0, i) : a; };
const received = (v: unknown) => v === null ? 'null' : typeof v === 'object' ? `an instance of ${(v as object).constructor?.name ?? 'Object'}` : `type ${typeof v} (${typeof v === 'string' ? `'${v}'` : String(v)})`;
/** The text of an address argument: a string or a SocketAddress, else ERR_INVALID_ARG_TYPE (as node) */
const addressArg = (v: unknown, name: string): string => {
  if (v instanceof SocketAddress) return v.address;
  if (typeof v === 'string') return v;
  throw Object.assign(new TypeError(`The "${name}" argument must be an instance of SocketAddress or of type string. Received ${received(v)}`), { code: 'ERR_INVALID_ARG_TYPE' });
};
/** The family of an argument: a SocketAddress's own, else `family` */
const familyArg = (v: unknown, family: unknown): IpFamily => famOf(v instanceof SocketAddress ? v.family : family);
const famOf = (f: unknown): IpFamily => {
  const v = String(f ?? 'ipv4').toLowerCase();
  if (v !== 'ipv4' && v !== 'ipv6') throw Object.assign(new TypeError(`The argument 'family' must be one of: 'ipv4', 'ipv6'. Received '${f}'`), { code: 'ERR_INVALID_ARG_VALUE' });
  return v;
};
/** An address as a number (IPv4: 32 bits, IPv6: 128), or throws as node does */
function ipValue(address: unknown, family: IpFamily): bigint {
  const raw = String(address instanceof SocketAddress ? address.address : address);
  const a = family === 'ipv6' ? noZone(raw) : raw;
  if (family === 'ipv4') {
    if (ipFamily(a) !== 4) throw Object.assign(new TypeError('Invalid socket address'), { code: 'ERR_INVALID_ADDRESS' });
    return a.split('.').reduce((n, p) => (n << 8n) | BigInt(Number(p)), 0n);
  }
  if (ipFamily(a) !== 6) throw Object.assign(new TypeError('Invalid socket address'), { code: 'ERR_INVALID_ADDRESS' });
  return ipv6Groups(a).reduce((n, g) => (n << 16n) | BigInt(g), 0n);
}
const MAPPED = 0xffffn << 32n; // ::ffff:0:0/96

/** net.BlockList: rules for addresses, ranges and subnets, checked in either family (IPv4-mapped IPv6 matches IPv4 rules). */
export class BlockList {
  private list: { family: IpFamily; lo: bigint; hi: bigint; text: string }[] = [];
  static isBlockList(v: unknown): boolean { return v instanceof BlockList; }
  addAddress(address: unknown, family?: string): void {
    const text = addressArg(address, 'address');
    const f = familyArg(address, family), v = ipValue(text, f);
    this.list.push({ family: f, lo: v, hi: v, text: `Address: ${f === 'ipv4' ? 'IPv4' : 'IPv6'} ${text}` });
  }
  addRange(start: unknown, end: unknown, family?: string): void {
    const t1 = addressArg(start, 'start'), t2 = addressArg(end, 'end');
    const f = familyArg(start, family), lo = ipValue(t1, f), hi = ipValue(t2, f);
    if (lo > hi) throw Object.assign(new RangeError('The value of "start" is out of range. It must be <= "end".'), { code: 'ERR_INVALID_ARG_VALUE' });
    this.list.push({ family: f, lo, hi, text: `Range: ${f === 'ipv4' ? 'IPv4' : 'IPv6'} ${t1}-${t2}` });
  }
  addSubnet(net: unknown, prefix: number, family?: string): void {
    const text = addressArg(net, 'net');
    const f = familyArg(net, family), bits = f === 'ipv4' ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) throw Object.assign(new RangeError(`The value of "prefix" is out of range. It must be >= 0 && <= ${bits}. Received ${prefix}`), { code: 'ERR_OUT_OF_RANGE' });
    const host = (1n << BigInt(bits - prefix)) - 1n;
    const lo = ipValue(text, f) & ~host;
    this.list.push({ family: f, lo, hi: lo | host, text: `Subnet: ${f === 'ipv4' ? 'IPv4' : 'IPv6'} ${text}/${prefix}` });
  }
  check(address: unknown, family?: string): boolean {
    // As node: a string that isn't an address of the family (or a family that isn't one) is no match
    const text = addressArg(address, 'address');
    if (family !== undefined && !(address instanceof SocketAddress) && typeof family !== 'string') {
      throw Object.assign(new TypeError(`The "family" argument must be of type string. Received ${received(family)}`), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    let f: IpFamily, v: bigint;
    try { f = familyArg(address, family); v = ipValue(text, f); } catch { return false; }
    // the same address in the other family: a.b.c.d is ::ffff:a.b.c.d
    const v4 = f === 'ipv4' ? v : (v >> 32n) === 0xffffn ? v & 0xffffffffn : null;
    const v6 = f === 'ipv6' ? v : MAPPED | v;
    return this.list.some((r) => r.family === 'ipv4' ? v4 !== null && v4 >= r.lo && v4 <= r.hi : v6 >= r.lo && v6 <= r.hi);
  }
  get rules(): string[] { return this.list.map((r) => r.text).reverse(); }
}

/** net.SocketAddress: an address, port, family and IPv6 flow label, checked as node checks them. */
export class SocketAddress {
  readonly #address: string;
  readonly #port: number;
  readonly #family: IpFamily;
  readonly #flowlabel: number;
  constructor(options: { address?: string; port?: number; family?: string; flowlabel?: number } = {}) {
    if (options === null || typeof options !== 'object') {
      throw Object.assign(new TypeError(`The "options" argument must be of type object. Received ${received(options)}`), { code: 'ERR_INVALID_ARG_TYPE' });
    }
    const family = famOf(options.family ?? 'ipv4');
    const address = options.address ?? (family === 'ipv4' ? '127.0.0.1' : '::');
    if (typeof address !== 'string') throw Object.assign(new TypeError(`The "options.address" property must be of type string. Received ${received(address)}`), { code: 'ERR_INVALID_ARG_TYPE' });
    const port = options.port ?? 0;
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 0 || port > 65535) {
      throw Object.assign(new RangeError(`options.port should be >= 0 and < 65536. Received ${received(port)}.`), { code: 'ERR_SOCKET_BAD_PORT' });
    }
    const flowlabel = options.flowlabel ?? 0;
    if (typeof flowlabel !== 'number' || !Number.isInteger(flowlabel) || flowlabel < 0 || flowlabel > 0xffffffff) {
      throw Object.assign(new RangeError(`The value of "options.flowlabel" is out of range. It must be >= 0 && <= 4294967295. Received ${flowlabel}`), { code: 'ERR_OUT_OF_RANGE' });
    }
    try { ipValue(address, family); } catch { throw Object.assign(new Error('Invalid socket address'), { code: 'ERR_INVALID_ADDRESS' }); }
    this.#address = address;
    this.#port = port;
    this.#family = family;
    this.#flowlabel = flowlabel;
  }
  get address(): string { return this.#address; }
  get port(): number { return this.#port; }
  get family(): IpFamily { return this.#family; }
  get flowlabel(): number { return this.#flowlabel; }
  toJSON() { return { address: this.#address, port: this.#port, family: this.#family, flowlabel: this.#flowlabel }; }
  static isSocketAddress(value: unknown): value is SocketAddress { return value instanceof SocketAddress; }
  /** 'host:port' or '[v6]:port', as node parses it (through URL); undefined when it doesn't */
  static parse(input: string): SocketAddress | undefined {
    if (typeof input !== 'string') throw Object.assign(new TypeError(`The "input" argument must be of type string. Received ${received(input)}`), { code: 'ERR_INVALID_ARG_TYPE' });
    try {
      const { hostname, port } = new URL(`http://${input}`);
      if (hostname.startsWith('[') && hostname.endsWith(']')) return new SocketAddress({ address: hostname.slice(1, -1), port: Number(port) | 0, family: 'ipv6' });
      return new SocketAddress({ address: hostname, port: Number(port) | 0 });
    } catch {
      return undefined;
    }
  }
}

/** The pre-relay inert socket, kept for tls (no TLS implementation in the Node shim). */
function createInertSocketClass() {
  return class InertSocket {
    writable = true;
    readable = true;
    destroyed = false;
    _events: Record<string, Function[]> = {};
    on(ev: string, fn: Function) { (this._events[ev] ||= []).push(fn); return this; }
    once(ev: string, fn: Function) { return this.on(ev, fn); }
    off() { return this; }
    emit(ev: string, ...args: any[]) { (this._events[ev] || []).forEach(f => f(...args)); }
    write(_data: any, encoding?: any, cb?: Function) { if (typeof encoding === 'function') cb = encoding; cb?.(); return true; }
    end(data?: any, _encoding?: any, cb?: Function) { if (typeof data === 'function') cb = data; cb?.(); this.destroyed = true; }
    destroy() { this.destroyed = true; return this; }
    setEncoding() { return this; }
    setKeepAlive() { return this; }
    setNoDelay() { return this; }
    setTimeout() { return this; }
    ref() { return this; }
    unref() { return this; }
    address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
    get remoteAddress() { return '127.0.0.1'; }
    get remotePort() { return 0; }
    get localAddress() { return '127.0.0.1'; }
    get localPort() { return 0; }
    pipe(dest: any) { return dest; }
  };
}

export interface TlsDeps {
  getBuiltinModule: (name: string) => any;
}

export function createTlsModule(deps: TlsDeps): any {
  const { getBuiltinModule } = deps;
  const netMod = getBuiltinModule('net');
  const TLSSocket = createInertSocketClass();
  const connect = (_opts: any, cb?: Function) => {
    const sock = new TLSSocket();
    if (typeof _opts === 'function') cb = _opts;
    if (cb) setTimeout(() => cb!(), 0);
    return sock;
  };
  // A plaintext net.Server must not pose as a TLS server either
  class InertServer {
    _events: Record<string, Function[]> = {};
    on(ev: string, fn: Function) { (this._events[ev] ||= []).push(fn); return this; }
    once(ev: string, fn: Function) { return this.on(ev, fn); }
    listen(port?: any, host?: any, cb?: Function) {
      if (typeof port === 'function') cb = port;
      else if (typeof host === 'function') cb = host;
      setTimeout(() => cb?.(), 0);
      return this;
    }
    close(cb?: Function) { cb?.(); return this; }
    address() { return { address: '127.0.0.1', family: 'IPv4', port: 0 }; }
    ref() { return this; }
    unref() { return this; }
  }
  return {
    ...netMod,
    Server: InertServer,
    createServer: () => new InertServer(),
    TLSSocket,
    createSecureContext: () => ({}),
    // The browser checked the certificate for the host it connected to
    checkServerIdentity: (_host: string, _cert: unknown) => undefined,
    getCiphers: () => ['TLS_AES_256_GCM_SHA384'],
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    // The page's fetch verifies TLS with the browser's own roots, so node code gets no
    // bundle of its own (an empty list, as an array: Claude Code spreads it)
    rootCertificates: Object.freeze([] as string[]),
    getCACertificates: (_type?: string) => [] as string[],
    connect,
  };
}
