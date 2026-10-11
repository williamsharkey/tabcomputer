/**
 * glshiro's executor in a Worker (docs/research/GL.md, "Page side"): one
 * WebGL2 context on an OffscreenCanvas per connection, so GL work and the
 * GPU's waits stay off the page's main thread. Frames go back as
 * ImageBitmaps for the X window's GL surface, without a readback.
 *
 * Messages in: {init}, {batch, buf, sizes?} (buf transferred), {sizes}.
 * Messages out: {send, data} for the guest, {frame, xid, bitmap}, {done,
 * commands, frames}, {broken}.
 */
import { Executor } from './exec';

type Size = { width: number; height: number };
type In =
  | { type: 'init' }
  | { type: 'batch'; buf: ArrayBuffer; sizes?: [number, Size | null][] }
  | { type: 'sizes'; sizes: [number, Size | null][] };

const scope = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent<In>) => void) | null };
const sizes = new Map<number, Size>();
let ex: Executor | null = null;

function applySizes(list?: [number, Size | null][]) {
  for (const [xid, s] of list ?? []) s ? sizes.set(xid, s) : sizes.delete(xid);
}

scope.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    const gl = new OffscreenCanvas(1, 1).getContext('webgl2', { alpha: false, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false, premultipliedAlpha: false }) as WebGL2RenderingContext | null;
    if (!gl) { scope.postMessage({ type: 'broken', reason: 'no WebGL2 in a Worker' }); return; }
    ex = new Executor(gl, {
      presentMode: 'bitmap',
      send: (data) => scope.postMessage({ type: 'send', data }, [data.buffer]),
      drawableSize: (xid) => sizes.get(xid) ?? null,
      present: (xid, f) => { if (f.bitmap) scope.postMessage({ type: 'frame', xid, bitmap: f.bitmap }, [f.bitmap]); },
      log: (msg) => console.warn(msg),
    });
    return;
  }
  if (m.type === 'sizes') { applySizes(m.sizes); return; }
  if (m.type === 'batch') {
    applySizes(m.sizes);
    if (!ex) return;
    const ok = ex.run(m.buf);
    scope.postMessage(ok ? { type: 'done', commands: ex.executed, frames: ex.frames } : { type: 'broken', reason: 'the GL stream broke' });
  }
};
