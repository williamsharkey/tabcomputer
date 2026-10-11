/**
 * Bun.listen and Bun.connect over the process's own `net` (node-compat's in
 * the page: kernel sockets, whose listen binds at once, so a listener's port
 * is known when Bun.listen returns, as in Bun). Handlers as Bun calls them:
 * open(socket), data(socket, Buffer), drain, end (the peer half-closed),
 * close(socket, error?), error, timeout; for connect also connectError, and
 * the promise rejects with "Failed to connect" and the system's code.
 */

export interface SocketEnv { net?: any; Buffer?: any }

interface Handlers {
  open?(s: BunSocket): void;
  data?(s: BunSocket, d: unknown): void;
  drain?(s: BunSocket): void;
  end?(s: BunSocket): void;
  close?(s: BunSocket, err?: Error): void;
  error?(s: BunSocket, err: Error): void;
  timeout?(s: BunSocket): void;
  connectError?(s: BunSocket, err: Error): void;
  binaryType?: 'buffer' | 'arraybuffer' | 'uint8array';
}

/** A Bun socket around a node one */
export class BunSocket {
  data: unknown;
  private err: Error | undefined;
  constructor(private sock: any, private handlers: Handlers, data: unknown, private env: SocketEnv) {
    this.data = data;
    sock.on('data', (d: Uint8Array) => this.handlers.data?.(this, this.convert(d)));
    sock.on('drain', () => this.handlers.drain?.(this));
    sock.on('end', () => this.handlers.end?.(this));
    sock.on('timeout', () => this.handlers.timeout?.(this));
    sock.on('error', (e: Error) => { this.err = e; this.handlers.error?.(this, e); });
    sock.on('close', () => this.handlers.close?.(this, this.err));
  }

  private convert(d: Uint8Array): unknown {
    const t = this.handlers.binaryType;
    if (t === 'uint8array') return new Uint8Array(d.buffer, d.byteOffset, d.byteLength);
    if (t === 'arraybuffer') return d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    return this.env.Buffer && !this.env.Buffer.isBuffer(d) ? this.env.Buffer.from(d) : d;
  }

  /** The bytes taken (all of them: node buffers the rest), -1 once closed */
  write(data: string | ArrayBufferView | ArrayBuffer, offset = 0, length?: number): number {
    if (this.sock.destroyed || this.sock.writableEnded) return -1;
    let bytes: Uint8Array = typeof data === 'string' ? new TextEncoder().encode(data)
      : data instanceof ArrayBuffer ? new Uint8Array(data)
      : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    bytes = bytes.subarray(offset, length === undefined ? undefined : offset + length);
    this.sock.write(this.env.Buffer ? this.env.Buffer.from(bytes) : bytes);
    return bytes.length;
  }

  end(data?: string | ArrayBufferView | ArrayBuffer): number {
    const n = data === undefined ? 0 : this.write(data);
    this.sock.end();
    return n;
  }

  shutdown(halfClose = false) { if (halfClose) this.sock.end(); else this.sock.destroy(); }
  terminate() { this.sock.destroy(); }
  flush() {}
  reload(opts: { socket?: Handlers }) { if (opts?.socket) this.handlers = opts.socket; }
  timeout(seconds: number) { this.sock.setTimeout(seconds * 1000); }
  setNoDelay(on = true) { this.sock.setNoDelay?.(on); return true; }
  setKeepAlive(on = true, delay = 0) { this.sock.setKeepAlive?.(on, delay); return true; }
  ref() { this.sock.ref?.(); }
  unref() { this.sock.unref?.(); }
  /** 1 open, 0 ended (still readable), -1 closed */
  get readyState(): number { return this.sock.destroyed ? -1 : this.sock.writableEnded ? 0 : 1; }
  get remoteAddress(): string { return this.sock.remoteAddress ?? ''; }
  get remotePort(): number { return this.sock.remotePort ?? 0; }
  get localAddress(): string { return this.sock.localAddress ?? ''; }
  get localPort(): number { return this.sock.localPort ?? 0; }
  get bytesWritten(): number { return this.sock.bytesWritten ?? 0; }
  get authorized(): boolean { return false; }
}

interface ListenOptions { hostname?: string; port?: number; unix?: string; socket: Handlers; data?: unknown; tls?: unknown }

function needNet(env: SocketEnv, what: string) {
  if (!env.net) throw new Error(`Bun.${what} needs the process's net module`);
  return env.net;
}

export function listen(env: SocketEnv, opts: ListenOptions) {
  const net = needNet(env, 'listen');
  if (!opts?.socket) throw new TypeError('Expected "socket" object');
  let handlers = opts.socket;
  const sockets = new Set<any>();
  const server = net.createServer((sock: any) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
    const s = new BunSocket(sock, handlers, opts.data, env);
    handlers.open?.(s);
  });
  const hostname = opts.hostname ?? '0.0.0.0';
  if (opts.unix) server.listen(opts.unix);
  else server.listen(Number(opts.port ?? 0), hostname);
  server.on('error', () => { /* (a failed bind: the port stays as asked) */ });
  return {
    get port(): number { return server.address()?.port ?? Number(opts.port ?? 0); },
    hostname,
    unix: opts.unix,
    data: opts.data,
    stop(closeActive = false) {
      server.close();
      if (closeActive) for (const s of sockets) s.destroy();
    },
    reload(o: { socket?: Handlers }) { if (o?.socket) handlers = o.socket; },
    ref() { server.ref?.(); },
    unref() { server.unref?.(); },
  };
}

interface ConnectOptions { hostname?: string; port?: number; unix?: string; socket: Handlers; data?: unknown; tls?: unknown }

export function connect(env: SocketEnv, opts: ConnectOptions): Promise<BunSocket> {
  const net = needNet(env, 'connect');
  if (!opts?.socket) return Promise.reject(new TypeError('Expected "socket" object'));
  return new Promise((resolve, reject) => {
    const sock = opts.unix ? net.connect({ path: opts.unix }) : net.connect({ host: opts.hostname ?? 'localhost', port: Number(opts.port) });
    let open = false;
    const onError = (e: any) => {
      if (open) return;
      const err: any = new Error('Failed to connect');
      err.code = e?.code ?? 'ECONNREFUSED';
      err.errno = e?.errno;
      err.syscall = 'connect';
      opts.socket.connectError?.(new BunSocket(sock, {}, opts.data, env), err);
      reject(err);
    };
    sock.once('error', onError);
    sock.once('connect', () => {
      open = true;
      sock.removeListener('error', onError);
      const s = new BunSocket(sock, opts.socket, opts.data, env);
      opts.socket.open?.(s);
      resolve(s);
    });
  });
}
