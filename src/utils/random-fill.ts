/**
 * Fill any byte range with random bytes (#46).
 *
 * crypto.getRandomValues takes at most 65536 bytes per call and refuses views
 * of a SharedArrayBuffer (a threaded WASM program's memory), so anything that
 * fills a size its caller chooses — node's randomBytes, WASI random_get,
 * getrandom(2) — goes through here: 64 KiB at a time, through a copy when the
 * memory is shared.
 */

export const RANDOM_CHUNK = 65536;

export function fillRandom<T extends ArrayBufferView>(view: T): T {
  const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  const shared = typeof SharedArrayBuffer !== 'undefined' && view.buffer instanceof SharedArrayBuffer;
  const tmp = shared ? new Uint8Array(Math.min(bytes.length, RANDOM_CHUNK)) : null;
  for (let i = 0; i < bytes.length; i += RANDOM_CHUNK) {
    const part = bytes.subarray(i, Math.min(bytes.length, i + RANDOM_CHUNK));
    if (tmp) {
      const t = tmp.subarray(0, part.length);
      crypto.getRandomValues(t);
      part.set(t);
    } else {
      crypto.getRandomValues(part);
    }
  }
  return view;
}
