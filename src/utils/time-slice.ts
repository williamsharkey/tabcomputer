/**
 * A long loop over the filesystem (tar c, grep -r) can run as one task: reads
 * from the in-memory cache resolve as microtasks, so the page never gets a
 * turn (#19). timeSlicer() returns a function to await in such a loop: it
 * yields a message task once `budgetMs` have passed since the slicer was made
 * or last yielded, and is a plain return otherwise. The budget is small
 * because the shell may already have held the loop for up to 30 ms (its
 * maybeYield) when the command starts. A message task, not
 * setTimeout(0), which browsers clamp to 4 ms when nested. Under Node the
 * port is unref'd so it doesn't keep the process alive.
 */
const resolvers: (() => void)[] = [];
let port: MessagePort | null = null;

export function yieldTask(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof MessageChannel !== 'function') { setTimeout(resolve, 0); return; }
    if (!port) {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => resolvers.shift()?.();
      (ch.port1 as any).unref?.();
      (ch.port2 as any).unref?.();
      port = ch.port2;
    }
    resolvers.push(resolve);
    port.postMessage(null);
  });
}

/** Yields made by timeSlicer()s (tests read it: Node delivers port messages in batches, so a ticker can't see the turns) */
export const sliceStats = { yields: 0 };

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function timeSlicer(budgetMs = 10): () => Promise<void> | void {
  let start = now();
  return () => {
    if (now() - start < budgetMs) return;
    sliceStats.yields++;
    return yieldTask().then(() => { start = now(); });
  };
}
