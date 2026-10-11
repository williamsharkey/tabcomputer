/** Bun.sleepSync(ms): blocks. Atomics.wait where the thread may block (a Worker), a busy wait on the page's main thread */
let cell: Int32Array | null = null;

export function sleepSync(ms: number): void {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return;
  try {
    cell ??= new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(cell, 0, 0, n);
    return;
  } catch { /* (no SharedArrayBuffer, or the main thread, which may not wait) */ }
  const end = performance.now() + n;
  while (performance.now() < end) { /* spin */ }
}
