/**
 * isomorphic-git's pack indexing in a worker (tabcomputer#28): `git clone`
 * of a big repository spent seconds of the page's main thread inflating and
 * hashing every object of the pack. vite-plugin-isogit.ts makes fromPack call
 * globalThis.__shiroPackIndexer(pack) first; this sets it. The worker gets a
 * copy of the pack (made a slice at a time; the filesystem may hold the
 * original's buffer, so it isn't transferred) and returns the .idx. Null on
 * any failure (a thin pack's external bases, no Worker): fromPack indexes on
 * the page, as before.
 */

/** Copy `bytes` into a new buffer COPY_SLICE at a time, with the page running in between. */
const COPY_SLICE = 8 << 20;
async function copyInSlices(bytes: Uint8Array): Promise<Uint8Array> {
  const out = new Uint8Array(bytes.byteLength);
  for (let off = 0; off < bytes.byteLength; off += COPY_SLICE) {
    out.set(bytes.subarray(off, off + COPY_SLICE), off);
    if (off + COPY_SLICE < bytes.byteLength) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return out;
}

export async function indexPackInWorker(pack: Uint8Array): Promise<Uint8Array | null> {
  if (typeof Worker === 'undefined' || typeof window === 'undefined') return null;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./git-pack-worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return null;
  }
  try {
    const copy = await copyInSlices(pack);
    return await new Promise<Uint8Array | null>((resolve) => {
      worker.onmessage = (e: MessageEvent<{ idx?: Uint8Array; error?: string }>) => resolve(e.data.idx ?? null);
      worker.onerror = () => resolve(null);
      worker.postMessage({ pack: copy }, [copy.buffer]);
    });
  } finally {
    worker.terminate();
  }
}

export function installPackIndexer(): void {
  (globalThis as { __shiroPackIndexer?: unknown }).__shiroPackIndexer ??= indexPackInWorker;
}
