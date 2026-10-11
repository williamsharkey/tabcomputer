import { describe, it, expect } from 'vitest';
import { createActivity } from '@shiro/node-compat/activity';

// #50: node exited 0 mid-download. fetch() counted as the script's activity only
// until the headers came; a big body's chunks then arrived with nothing pending,
// and the idle exit (execution.ts idleExit: 150 ms quiet) ended the script.

const SIZE = 2 << 20, CHUNK = 32 << 10, GAP_MS = 25; // 64 chunks over ~1.6 s, no network
const IDLE_MS = 150; // execution.ts IDLE_EXIT_MS

/** A response whose body streams SIZE bytes, a chunk every GAP_MS (a slow server) */
function slowResponse(): Response {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, GAP_MS));
      const n = Math.min(CHUNK, SIZE - sent);
      c.enqueue(new Uint8Array(n).fill(sent / CHUNK & 0xff));
      sent += n;
      if (sent >= SIZE) c.close();
    },
  }, { highWaterMark: 0 });
  return new Response(body, { headers: { 'content-length': String(SIZE) } });
}

/** Watch `pending` as idleExit does; the longest stretch with nothing pending, in ms */
function idleWatch(activity: { pending: number }) {
  let quietSince: number | null = null, longest = 0;
  const t = setInterval(() => {
    const now = performance.now();
    if (activity.pending > 0) { quietSince = null; return; }
    quietSince ??= now;
    longest = Math.max(longest, now - quietSince);
  }, 10);
  return () => { clearInterval(t); return longest; };
}

const readers: Record<string, (r: Response) => Promise<number>> = {
  'reader.read()': async (r) => {
    const rd = r.body!.getReader();
    let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) return n; n += value.length; }
  },
  'for await': async (r) => {
    let n = 0;
    for await (const chunk of r.body as any as AsyncIterable<Uint8Array>) n += chunk.length;
    return n;
  },
  'arrayBuffer()': async (r) => (await r.arrayBuffer()).byteLength,
  'clone().text()': async (r) => (await r.clone().text()).length,
  'pipeThrough() then read': async (r) => {
    const rd = r.body!.pipeThrough(new TransformStream()).getReader();
    let n = 0;
    for (;;) { const { done, value } = await rd.read(); if (done) return n; n += value.length; }
  },
};

describe('fetch body reads keep a node script alive (#50)', () => {
  for (const [how, read] of Object.entries(readers)) {
    it(`streams a 2 MiB body to completion with ${how}, never idle for ${IDLE_MS} ms`, async () => {
      const { activity, trackAsync, trackResponse } = createActivity();
      const stop = idleWatch(activity);
      // as execution.ts installs fetch: trackAsync(routedFetch(...).then(trackResponse))
      const res = await trackAsync(Promise.resolve(slowResponse()).then(trackResponse));
      const n = await read(res);
      const longestQuiet = stop();
      expect(n).toBe(SIZE);
      expect(longestQuiet).toBeLessThan(IDLE_MS);
      expect(activity.pending).toBe(0); // and nothing left pending once it's read
    }, 20_000);
  }

  it('without it, the same download looks idle (the bug)', async () => {
    const { activity, trackAsync } = createActivity();
    const stop = idleWatch(activity);
    const res = await trackAsync(Promise.resolve(slowResponse()));
    expect(await readers['reader.read()'](res)).toBe(SIZE);
    expect(stop()).toBeGreaterThanOrEqual(IDLE_MS);
  }, 20_000);

  it('a body nobody reads keeps nothing pending', async () => {
    const { activity, trackAsync, trackResponse } = createActivity();
    await trackAsync(Promise.resolve(slowResponse()).then(trackResponse));
    await new Promise((r) => setTimeout(r, 0));
    expect(activity.pending).toBe(0);
  });
});
