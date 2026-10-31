/**
 * Bun's module graph read from a native Claude Code binary on a server, by
 * byte ranges: only the parts the parser asks for (bun-graph.ts), never the
 * whole file. In 2.1.316 that is ~55 of 315 MB: the files' bytes, their names
 * and the module table sit together at the end of the `.bun` section, after
 * the JSC bytecode and the Bun runtime, which `claude --vm` doesn't use.
 *
 * The server sends exact slices of Anthropic's unchanged file
 * (server.mjs /claude-releases/, which keeps a binary only once its sha256
 * matches the release manifest).
 */
import { parseBunGraph, NeedBytes, type BunGraph, type ByteSource } from './bun-graph';

/** The bytes [start, end) of the file */
export type RangeGet = (start: number, end: number) => Promise<Uint8Array>;

export interface RemoteGraphOptions {
  /** Bytes per request for a large range (default 8 MiB) */
  chunk?: number;
  /** Requests at once (default 4) */
  parallel?: number;
  /** Bytes received so far */
  onProgress?: (bytes: number) => void;
  /** More than this many bytes in all, and it gives up (default 160 MiB): the layout isn't the expected one */
  maxBytes?: number;
  /** How much of the file's end to fetch first (default 512 KiB) */
  suffix?: number;
}

/** The file's last bytes, fetched first: the section headers, and in 2.1.316 the module table and names too */
const SUFFIX = 512 * 1024;
/** Ranges closer than this are fetched as one */
const GAP = 64 * 1024;

class Windows implements ByteSource {
  private wins: { off: number; buf: Uint8Array }[] = [];
  size: number;
  constructor(size: number) { this.size = size; }
  add(off: number, buf: Uint8Array) { this.wins.push({ off, buf }); }
  private find(o: number, l: number) {
    return this.wins.find((w) => o >= w.off && o + l <= w.off + w.buf.length);
  }
  need(ranges: [number, number][]) {
    const missing = ranges.filter(([o, l]) => l > 0 && !this.find(o, l));
    if (missing.length) throw new NeedBytes(missing);
  }
  bytes(o: number, l: number) {
    if (l === 0) return new Uint8Array(0);
    const w = this.find(o, l);
    if (!w) throw new NeedBytes([[o, l]]);
    return w.buf.subarray(o - w.off, o - w.off + l);
  }
}

/** Sorted ranges merged where they overlap or lie within GAP of each other, as [start, end) */
export function coalesce(ranges: [number, number][], gap = GAP): [number, number][] {
  const r = ranges.filter(([, l]) => l > 0).map(([o, l]) => [o, o + l] as [number, number]).sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  for (const [s, e] of r) {
    const last = out[out.length - 1];
    if (last && s - last[1] <= gap) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** The graph of the `size`-byte binary that `get` reads, and how many bytes that took. */
export async function fetchBunGraph(size: number, get: RangeGet, opts: RemoteGraphOptions = {}): Promise<{ graph: BunGraph; bytes: number }> {
  const chunk = opts.chunk ?? 8 * 2 ** 20;
  const parallel = Math.max(1, opts.parallel ?? 4);
  const maxBytes = opts.maxBytes ?? 160 * 2 ** 20;
  const src = new Windows(size);
  let bytes = 0;
  const fetchRange = async (s: number, e: number) => {
    if (bytes + (e - s) > maxBytes) throw new Error(`the binary's JavaScript is spread over more than ${Math.round(maxBytes / 2 ** 20)} MB`);
    const buf = new Uint8Array(e - s);
    const parts: [number, number][] = [];
    for (let p = s; p < e; p += chunk) parts.push([p, Math.min(e, p + chunk)]);
    let next = 0;
    const worker = async () => {
      while (next < parts.length) {
        const [ps, pe] = parts[next++];
        const got = await get(ps, pe);
        if (got.length !== pe - ps) throw new Error(`range ${ps}-${pe - 1}: ${got.length} bytes`);
        buf.set(got, ps - s);
        bytes += got.length;
        opts.onProgress?.(bytes);
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, parts.length) }, worker));
    src.add(s, buf);
  };
  const tail = Math.min(opts.suffix ?? SUFFIX, size);
  await Promise.all([fetchRange(size - tail, size), size > tail ? fetchRange(0, Math.min(64, size - tail)) : null]);
  for (let round = 0; round < 12; round++) {
    try {
      return { graph: parseBunGraph(src), bytes };
    } catch (e) {
      if (!(e instanceof NeedBytes)) throw e;
      for (const [s, end] of coalesce(e.ranges.map(([o, l]) => [Math.max(0, o), Math.min(size, o + l) - Math.max(0, o)] as [number, number]))) {
        await fetchRange(s, end);
      }
    }
  }
  throw new Error('the binary\'s module graph needed too many requests');
}

export class RangesUnsupported extends Error {}

/** A RangeGet over the page's fetch for `url`: each answer must be a 206 for exactly that range. */
export function httpRangeGet(url: string, fetchFn: typeof fetch = fetch): RangeGet {
  return async (start, end) => {
    const ac = new AbortController();
    const r = await fetchFn(url, { headers: { Range: `bytes=${start}-${end - 1}` }, cache: 'no-store', signal: ac.signal });
    if (r.status !== 206) {
      ac.abort(); // (a 200 is the whole file: don't download it)
      throw r.status === 200 ? new RangesUnsupported(`${url}: the server sends no byte ranges`) : new Error(`${url}: HTTP ${r.status}`);
    }
    const cr = /^bytes (\d+)-(\d+)\//.exec(r.headers.get('content-range') || '');
    if (!cr || Number(cr[1]) !== start || Number(cr[2]) !== end - 1) {
      ac.abort();
      throw new Error(`${url}: the server sent another range (${r.headers.get('content-range')})`);
    }
    return new Uint8Array(await r.arrayBuffer());
  };
}
