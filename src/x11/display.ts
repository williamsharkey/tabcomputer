/**
 * The X display as a kernel process: `Xshiro :N` listens on the AF_UNIX
 * socket /tmp/.X11-unix/XN (and the abstract name libxcb tries first) in the
 * kernel's NetStack, so any kernel process — x86-64 ELF in Blink, WASM —
 * connects with DISPLAY=:N. This module is small and loaded at boot; the
 * server itself (src/x11/session.ts: protocol, fonts, rootless windows) is
 * imported on the first connection.
 */
import type { Kernel } from '../kernel/kernel';
import { netStackOf, installNet, KSocket, type UnixOps } from '../kernel/net';
import { AF_UNIX, SOCK_STREAM } from '../kernel/abi';
import type { Process } from '../kernel/process';
import type { Client } from './server';

export interface DisplayHandle {
  display: number;
  proc: Process;
  /** Connections accepted so far. */
  connections: number;
  stop(): void;
}

const displays = new Map<number, DisplayHandle>();

export function getDisplay(n = 0): DisplayHandle | undefined { return displays.get(n); }

/** Start (or return) the X display `:n` in `kernel`. */
export async function startDisplay(kernel: Kernel, n = 0): Promise<DisplayHandle> {
  const existing = displays.get(n);
  if (existing) return existing;
  if (!netStackOf(kernel)) installNet(kernel);
  const stack = netStackOf(kernel)!;
  const fs = kernel.fs;
  const path = `/tmp/.X11-unix/X${n}`;
  if (fs) {
    await fs.mkdir('/tmp/.X11-unix', { recursive: true }).catch(() => {});
    if (await fs.exists(path)) await fs.unlink(path).catch(() => {});
  }
  const ops: UnixOps = {
    resolve: (p) => p,
    exists: async (p) => !!fs && (await fs.exists(p)),
    create: async (p) => { if (fs) await fs.writeFile(p, new Uint8Array(0)); return 0; },
  };
  const listeners: KSocket[] = [];
  for (const address of [path, `\0${path}`]) {
    const s = stack.socket(AF_UNIX, SOCK_STREAM);
    if (typeof s === 'number' || !(s instanceof KSocket)) throw new Error(`Xshiro: socket: ${s}`);
    const r = await stack.bindUnix(s, { family: AF_UNIX, address, port: 0 }, ops);
    if (r < 0) throw new Error(`Xshiro: bind ${address.replace('\0', '@')}: errno ${-r}`);
    s.listen(64);
    listeners.push(s);
  }
  let stopped = false;
  let wake: () => void = () => {};
  const done = new Promise<void>((res) => { wake = res; });
  const handle: DisplayHandle = {
    display: n,
    proc: null as unknown as Process,
    connections: 0,
    stop() {
      if (stopped) return;
      stopped = true;
      for (const l of listeners) void l.close();
      displays.delete(n);
      wake();
    },
  };
  const proc = kernel.spawn({
    path: 'Xshiro',
    argv: ['Xshiro', `:${n}`],
    env: { DISPLAY: `:${n}` },
    run: async (p) => {
      for (const l of listeners) l.ownerPid = p.pid;
      for (const l of listeners) void acceptLoop(l, handle, kernel, () => stopped);
      p.onTerminate(() => handle.stop());
      await done;
      return 0;
    },
  });
  handle.proc = proc;
  void proc.wait().then(() => handle.stop());
  displays.set(n, handle);
  return handle;
}

async function acceptLoop(listener: KSocket, handle: DisplayHandle, kernel: Kernel, stopped: () => boolean): Promise<void> {
  while (!stopped()) {
    const s = await listener.accept();
    if (typeof s === 'number') { if (stopped()) return; await new Promise((r) => setTimeout(r, 50)); continue; }
    handle.connections++;
    void serveClient(s, handle.display, kernel);
  }
}

/**
 * A client whose every request is kept from its first byte (src/gui/snapshot.ts):
 * played again into a new server, the bytes rebuild what the server holds for
 * it (windows, pixmaps, GCs, glyphs, properties, its sequence number).
 */
export interface XRecording {
  /** The process whose connection is recorded */
  pid: number;
  /** The client number it is given (its resource ids are made from it) */
  index: number;
  chunks: Uint8Array[];
  bytes: number;
  /** Past this many bytes the recording is dropped (`chunks` emptied, `over` set) */
  limit: number;
  over: boolean;
  /** Connections the process made: more than one can't be played back as one client */
  connections: number;
  client: Client | null;
}

const recordings = new Map<number, XRecording>();

/** Record the X connection process `pid` is about to make, as client number `index`. */
export function recordXClient(pid: number, index: number, limit = 64 << 20): XRecording {
  const rec: XRecording = { pid, index, chunks: [], bytes: 0, limit, over: false, connections: 0, client: null };
  recordings.set(pid, rec);
  return rec;
}

/** Stop recording `pid`'s connection (the bytes so far stay in its record). */
export function stopXRecording(pid: number): void { recordings.delete(pid); }

async function serveClient(sock: KSocket, display: number, kernel: Kernel): Promise<void> {
  const { getXSession } = await import('./session');
  const { server } = await getXSession(display);
  // GL apps (docs/research/GL.md): GLX and libGLX_tabcomputer when the page has WebGL2
  await (await import('../gl/setup')).prepareGL(kernel);
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false;
  let rec = recordings.get(sock.peerPid) ?? null;
  // (a second connection, or its number taken by another instance of the app: not recorded)
  if (rec && (++rec.connections > 1 || server.clients.has(rec.index))) { rec.over = true; rec.chunks = []; rec = null; }
  const client = server.connect({
    write: (d) => { chain = chain.then(() => (closed ? 0 : sock.send(d))); },
    close: () => { closed = true; void chain.then(() => sock.close()); },
  }, rec?.index);
  if (rec) rec.client = client;
  await pump(sock, client, rec);
  server.disconnect(client);
  closed = true;
  void sock.close();
}

async function pump(sock: KSocket, client: Client, rec: XRecording | null): Promise<void> {
  const buf = new Uint8Array(256 * 1024);
  for (;;) {
    const n = await sock.recv(buf);
    if (n <= 0) break;
    if (rec && !rec.over && recordings.get(rec.pid) === rec) {
      rec.bytes += n;
      if (rec.bytes > rec.limit) { rec.over = true; rec.chunks = []; } else rec.chunks.push(buf.slice(0, n));
    }
    client.receive(buf.subarray(0, n));
  }
}

/**
 * A restored process's X connection: client number `index` with the server
 * state its recorded `requests` build, on a new socket pair. The requests are
 * played with the client's output dropped (it read those replies and events
 * the first time), so its sequence number ends where the process left it;
 * then each of its toplevels is told where it is now. Returns the process's
 * end of the pair; `done` resolves when the connection has ended.
 */
export async function adoptXClient(kernel: Kernel, display: number, index: number, requests: Uint8Array[]): Promise<{ sock: KSocket; client: Client; done: Promise<void> }> {
  const { getXSession } = await import('./session');
  const { server } = await getXSession(display);
  if (server.clients.has(index)) throw new Error(`X client number ${index} is in use`);
  if (!netStackOf(kernel)) installNet(kernel);
  const pair = netStackOf(kernel)!.socketpair();
  if (typeof pair === 'number') throw new Error(`socketpair: errno ${-pair}`);
  const [guest, ours] = pair;
  let chain: Promise<unknown> = Promise.resolve();
  let closed = false, muted = true;
  const client = server.connect({
    write: (d) => { if (!muted) chain = chain.then(() => (closed ? 0 : ours.send(d))); },
    close: () => { closed = true; void chain.then(() => ours.close()); },
  }, index);
  for (const chunk of requests) client.receive(chunk);
  client.flush();
  muted = false;
  for (const w of server.topsOf(client)) if (w.mapped) server.announce(w);
  const done = pump(ours, client, null).then(() => {
    server.disconnect(client);
    closed = true;
    void ours.close();
  });
  return { sock: guest, client, done };
}
