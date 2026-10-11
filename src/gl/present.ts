/**
 * A glshiro connection's backend: a WebGL2 context, the executor, and how
 * frames reach the X window. Until Xshiro offers a canvas over a GL window,
 * frames are read back and drawn into the window's pixels (like PutImage),
 * so Xshiro composes them with everything else.
 */
import { Executor, type ExecHost, type Present } from './exec';
import type { Backend } from './server';
import { MSG_FRAME, OPS } from './wire';
import type { GLSurface } from '../x11/gl-surface';
import { peekXSession } from '../x11/session';
import type { XServer } from '../x11/server';
import { Painter, defaultGC } from '../x11/raster';

function webgl2(): WebGL2RenderingContext {
  const attrs: WebGLContextAttributes = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false };
  let gl: WebGL2RenderingContext | null = null;
  if (typeof OffscreenCanvas !== 'undefined') gl = new OffscreenCanvas(1, 1).getContext('webgl2', attrs) as WebGL2RenderingContext | null;
  if (!gl && typeof document !== 'undefined') gl = document.createElement('canvas').getContext('webgl2', attrs);
  if (!gl) throw new Error('this browser has no WebGL2: GL apps need it');
  return gl;
}

/** Draws RGBA pixels (bottom row first) into an X window, as the app's frame. */
export function drawIntoWindow(server: XServer, xid: number, f: Present): void {
  if (!f.pixels) return;
  let d;
  try { d = server.drawable(xid); } catch { return; }
  const w = Math.min(f.width, d.pix.width), h = Math.min(f.height, d.pix.height);
  const src = new Uint32Array(f.pixels.buffer, f.pixels.byteOffset, f.width * f.height);
  const rows = new Uint32Array(w * h);
  const alpha = d.depth === 32 ? 0 : 0xff000000;
  for (let y = 0; y < h; y++) {
    const s = (f.height - 1 - y) * f.width;
    for (let x = 0; x < w; x++) {
      const v = src[s + x]; // bytes R G B A → 0xAABBGGRR
      rows[y * w + x] = (((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff) | (alpha || (v & 0xff000000))) >>> 0;
    }
  }
  const p = new Painter(d.pix, defaultGC());
  p.copyRows(0, 0, w, h, rows, w, 0);
  p.finish();
}

/**
 * Paces the guest to the page's frames: frame acks wait for the next
 * animation frame, and libGLX_tabcomputer stops at its swap once it's
 * MAX_FRAMES_AHEAD frames ahead. A hidden tab gets no animation frames, so
 * its GL apps wait instead of rendering frames nobody sees. Other messages
 * go at once.
 */
export function pacedSend(send: (data: Uint8Array) => void, nextFrame: (cb: () => void) => void): (data: Uint8Array) => void {
  let held: Uint8Array[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const h = held;
    held = [];
    for (const m of h) send(m);
  };
  return (data) => {
    if (data.length < 4 || new DataView(data.buffer, data.byteOffset, 4).getUint32(0, true) !== MSG_FRAME) { send(data); return; }
    held.push(data);
    if (!scheduled) { scheduled = true; nextFrame(flush); }
  };
}

/**
 * The X windows a batch makes current (tcMakeCurrent's draw and read), found
 * by walking command headers. Pbuffers created (tcCreatePbuffer) go into
 * `pbuffers` and are left out, then and in later batches.
 */
const MAKE_CURRENT = OPS.findIndex(([name]) => name === 'tcMakeCurrent');
const CREATE_PBUFFER = OPS.findIndex(([name]) => name === 'tcCreatePbuffer');
export function windowsMadeCurrent(buf: ArrayBuffer, pbuffers = new Set<number>()): number[] {
  const dv = new DataView(buf);
  const out: number[] = [];
  for (let off = 0; off + 12 <= buf.byteLength;) {
    const end = off + dv.getUint32(off + 8, true);
    for (let p = off + 12; p + 4 <= end;) {
      const h = dv.getUint32(p, true);
      let words = h >>> 16;
      if (!words) words = dv.getUint32(p + 4, true);
      if (words < 1) return out;
      if ((h & 0xffff) === MAKE_CURRENT && (h >>> 16) && p + 16 <= end) {
        const draw = dv.getUint32(p + 8, true), read = dv.getUint32(p + 12, true);
        if (draw && !pbuffers.has(draw)) out.push(draw);
        if (read && read !== draw && !pbuffers.has(read)) out.push(read);
      } else if ((h & 0xffff) === CREATE_PBUFFER && (h >>> 16) && p + 8 <= end) pbuffers.add(dv.getUint32(p + 4, true));
      p += words * 4;
    }
    if (end <= off) return out;
    off = end;
  }
  return out;
}

/** Whether to run the executor in a Worker and present through GL surfaces (localStorage tabcomputer_gl_worker=0 turns it off). */
function workerPath(xs: XServer | null): boolean {
  try { if (globalThis.localStorage?.getItem('tabcomputer_gl_worker') === '0') return false; } catch { /* none */ }
  return !!xs?.glSurfaceProvider && typeof Worker !== 'undefined' && typeof OffscreenCanvas !== 'undefined';
}

/**
 * The executor in a Worker (worker.ts). Frames come back as ImageBitmaps and
 * go into the window's GL surface (a `bitmaprenderer` canvas over it), so
 * there is no readback; the window's own pixels stay what X drew, and
 * XGetImage reads the frame from the surface when asked. The page
 * tells the Worker each window's size, from its surface.
 */
function createWorkerBackend(send: (data: Uint8Array) => void, xs: XServer): Backend {
  const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'glshiro' });
  const surfaces = new Map<number, { surface: GLSurface; unsub: (() => void)[] }>();
  let commands = 0, frames = 0, busy = 0, broken = false;
  /** made current before the window could take a surface (not mapped yet, say): tried again on each batch and frame */
  const pending = new Set<number>();
  /** pbuffers' XIDs, which the X server never sees: the Worker sizes them */
  const pbuffers = new Set<number>();
  const sizeOf = (s: GLSurface) => ({ width: s.width, height: s.height });
  const track = (xid: number): [number, { width: number; height: number }] | null => {
    if (surfaces.has(xid)) return null;
    let surface: GLSurface;
    try { surface = xs.glSurface(xid); } catch { return null; } // not an X window (yet)
    const entry = { surface, unsub: [] as (() => void)[] };
    entry.unsub.push(surface.onChange(() => worker.postMessage({ type: 'sizes', sizes: [[xid, sizeOf(surface)]] })));
    entry.unsub.push(surface.onDestroy(() => { forget(xid); worker.postMessage({ type: 'sizes', sizes: [[xid, null]] }); }));
    surfaces.set(xid, entry);
    return [xid, sizeOf(surface)];
  };
  const forget = (xid: number) => {
    const e = surfaces.get(xid);
    if (!e) return;
    surfaces.delete(xid);
    for (const u of e.unsub) u();
  };
  worker.onmessage = (ev: MessageEvent) => {
    const m = ev.data as { type: string; data?: Uint8Array; xid?: number; bitmap?: ImageBitmap; commands?: number; frames?: number; busy?: number; reason?: string };
    switch (m.type) {
      case 'send': send(m.data!); break;
      case 'frame': {
        if (pending.has(m.xid!)) { const t = track(m.xid!); if (t) { pending.delete(m.xid!); worker.postMessage({ type: 'sizes', sizes: [t] }); } }
        const e = surfaces.get(m.xid!);
        if (e) e.surface.present(m.bitmap!); else m.bitmap!.close();
        break;
      }
      case 'done': commands = m.commands!; frames = m.frames!; busy = m.busy ?? busy; break;
      case 'broken': broken = true; console.warn('[glshiro]', m.reason); break;
    }
  };
  worker.postMessage({ type: 'init' });
  return {
    run(buf) {
      if (broken) return false;
      const sizes: [number, { width: number; height: number }][] = [];
      for (const xid of windowsMadeCurrent(buf, pbuffers)) if (!surfaces.has(xid)) pending.add(xid);
      for (const xid of pending) { const t = track(xid); if (t) { sizes.push(t); pending.delete(xid); } }
      worker.postMessage({ type: 'batch', buf, sizes }, [buf]);
      return true;
    },
    close() {
      worker.terminate();
      for (const [xid, e] of [...surfaces]) { forget(xid); e.surface.release(); }
    },
    commands: () => commands,
    frames: () => frames,
    busyMs: () => busy,
  };
}

export async function createWebGLBackend(rawSend: (data: Uint8Array) => void): Promise<Backend> {
  const send = typeof requestAnimationFrame === 'function' ? pacedSend(rawSend, (cb) => requestAnimationFrame(() => cb())) : rawSend;
  const session = await peekXSession(0);
  const xs = session ? (await session).server : null;
  if (xs && workerPath(xs)) return createWorkerBackend(send, xs);
  const gl = webgl2();
  const host: ExecHost = {
    send,
    presentMode: 'async-pixels',
    drawableSize(xid) {
      if (!xs) return null;
      try {
        const d = xs.drawable(xid);
        return d.win ? { width: d.win.width, height: d.win.height } : { width: d.pix.width, height: d.pix.height };
      } catch { return null; }
    },
    present(xid, frame) { if (xs) drawIntoWindow(xs, xid, frame); },
    log: (m) => console.warn(m),
  };
  const ex = new Executor(gl, host);
  return {
    run: (b) => ex.run(b),
    close: () => { gl.getExtension('WEBGL_lose_context')?.loseContext(); },
    commands: () => ex.executed,
    frames: () => ex.frames,
  };
}
