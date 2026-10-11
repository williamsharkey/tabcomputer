/**
 * isomorphic-git's pack reading off the page's main thread (tabcomputer#28).
 *
 * `git clone` indexes the pack it received on the page: every object is
 * inflated by pako (isomorphic-git ships `supportsDecompressionStream =
 * false`), and readSlice hands inflate the rest of the pack from the object
 * on, which pako stops reading at the stream's end. A 265 MB pack gave
 * 300-2700 ms tasks. This build transform:
 * - inflates objects of 64 KB or more with the browser's DecompressionStream
 *   (native, off the main thread; fed a MiB at a time), pako if that fails;
 * - gives inflate the object's own compressed bytes when its end is known:
 *   fromPack has every object's end (for the CRCs), an index read from an
 *   .idx has every offset; unknown, pako reads it as before;
 * - lets the page run every ~30 ms in fromPack's two passes over the objects;
 * - on the page, fromPack hands the whole indexing to a worker
 *   (src/git-pack-indexer.ts) and builds the index from the .idx it returns.
 * Each anchor must match exactly once: an isomorphic-git upgrade that moves
 * them fails the build here, not silently.
 */
import type { Plugin } from 'vite';

const EDITS: [string, string][] = [
  // inflate: big objects natively, pako otherwise or on failure
  ['let supportsDecompressionStream = false;', 'let supportsDecompressionStream = null;'],
  [`async function inflate(buffer) {
  if (supportsDecompressionStream === null) {
    supportsDecompressionStream = testDecompressionStream();
  }
  return supportsDecompressionStream
    ? browserInflate(buffer)
    : pako.inflate(buffer)
}`, `async function inflate(buffer, exact = true) {
  if (supportsDecompressionStream === null) {
    supportsDecompressionStream = testDecompressionStream();
  }
  // (DecompressionStream rejects bytes after the stream: only an object's own slice)
  if (supportsDecompressionStream && exact && buffer.byteLength >= 65536) {
    try { return await browserInflate(buffer) } catch (_) { /* pako below */ }
  }
  return pako.inflate(buffer)
}

/** Where the object at pack offset \`start\` ends, if known (shiro: vite-plugin-isogit.ts) */
function __shiroObjectEnd(index, start, packLength) {
  const known = index.__shiroEnds && index.__shiroEnds[start];
  if (known) return known.end
  if (!index.__shiroSorted) {
    if (!index.offsets || index.offsets.size === 0) return undefined
    index.__shiroSorted = Float64Array.from(index.offsets.values()).sort();
  }
  const s = index.__shiroSorted;
  let lo = 0, hi = s.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (s[mid] <= start) lo = mid + 1; else hi = mid; }
  if (lo > 0 && s[lo - 1] !== start) return undefined // not an object's start: unknown
  return lo < s.length ? s[lo] : packLength - 20
}

let __shiroTurnAt = 0;
/** A turn for the page now and then in a long loop over objects */
async function __shiroTurn() {
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
  if (now - __shiroTurnAt < 30) return
  await new Promise((resolve) => setTimeout(resolve, 0));
  __shiroTurnAt = typeof performance !== 'undefined' ? performance.now() : Date.now();
}`],
  // browserInflate: the input fed a MiB at a time (new Blob([buffer]) copied a big object in one go: 540 ms)
  [`async function browserInflate(buffer) {
  const ds = new DecompressionStream('deflate');
  const d = new Blob([buffer]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(d).arrayBuffer())
}`, `async function browserInflate(buffer) {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  const fed = (async () => {
    for (let off = 0; off < buffer.byteLength; off += 1 << 20) {
      await writer.write(buffer.subarray(off, off + (1 << 20)));
      if ((off >> 20) % 4 === 3) await new Promise((resolve) => setTimeout(resolve, 0)); // (the writes resolve as microtasks)
    }
    await writer.close();
  })();
  fed.catch(() => {});
  const out = new Uint8Array(await new Response(ds.readable).arrayBuffer());
  await fed;
  return out
}`],
  // readSlice: the object's own compressed bytes when its end is known
  [`    const buffer = raw.slice(reader.tell());
    object = Buffer.from(await inflate(buffer));`, `    const __end = __shiroObjectEnd(this, start, start + raw.byteLength);
    const buffer = __end !== undefined ? raw.slice(reader.tell(), __end - start) : raw.slice(reader.tell());
    object = Buffer.from(await inflate(buffer, __end !== undefined));`],
  // readSlice: a turn before each object (checkout reads thousands through it, outside fromPack)
  [`    const raw = (await this.pack).slice(start);`, `    await __shiroTurn();
    const raw = (await this.pack).slice(start);`],
  // FileSystem.read: a big file's bytes wrapped, not copied (git read a 265 MB pack back: a 66 ms copy).
  // isomorphic-git only reads them (packs, blobs it hashes); small ones are copied as before
  [`      if (typeof buffer !== 'string') {
        buffer = Buffer.from(buffer);
      }`, `      if (typeof buffer !== 'string') {
        buffer = buffer.byteLength >= 1048576 && ArrayBuffer.isView(buffer)
          ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
          : Buffer.from(buffer);
      }`],
  // fromPack: the page hands the whole indexing (both passes: inflate, sha1, crc) to a worker
  // (src/git-pack-indexer.ts sets the hook; the worker itself has none) and gets the .idx back
  [`  static async fromPack({ pack, getExternalRefDelta, onProgress }) {`, `  static async fromPack({ pack, getExternalRefDelta, onProgress }) {
    const __indexer = typeof globalThis !== 'undefined' ? globalThis.__shiroPackIndexer : undefined;
    const __idx = typeof __indexer === 'function' ? await __indexer(pack).catch(() => null) : null;
    if (__idx) {
      const p = await GitPackIndex.fromIdx({ idx: Buffer.from(__idx.buffer, __idx.byteOffset, __idx.byteLength), getExternalRefDelta });
      if (p) {
        p.pack = Promise.resolve(pack);
        p.toBuffer = async () => Buffer.from(__idx.buffer, __idx.byteOffset, __idx.byteLength); // (fromIdx skips the CRCs)
        return p
      }
    }`],
  // fromPack: the ends it computed, and turns in both passes
  [`    await listpack([pack], async ({ data, type, reference, offset, num }) => {
      if (totalObjectCount === null) totalObjectCount = num;`, `    await listpack([pack], async ({ data, type, reference, offset, num }) => {
      await __shiroTurn();
      if (totalObjectCount === null) totalObjectCount = num;`],
  [`      getExternalRefDelta,
    });

    // Resolve deltas and compute the oids`, `      getExternalRefDelta,
    });
    p.__shiroEnds = offsetToObject;

    // Resolve deltas and compute the oids`],
  [`    for (let offset in offsetToObject) {
      offset = Number(offset);`, `    for (let offset in offsetToObject) {
      await __shiroTurn();
      offset = Number(offset);`],
];

/** GitPackIndex for the indexing worker (src/git-pack-worker.ts): not part of isomorphic-git's API */
const EXPORT_ESM = '\nexport { GitPackIndex as __shiroGitPackIndex };\n';
const EXPORT_CJS = '\nexports.__shiroGitPackIndex = GitPackIndex;\n';

export function isogitPackOffMainThread(): Plugin {
  return {
    name: 'isogit-pack-off-main-thread',
    enforce: 'pre',
    transform(code, id) {
      if (!/[\\/]isomorphic-git[\\/]index\.c?js$/.test(id)) return null;
      let out = code;
      for (const [from, to] of EDITS) {
        const n = out.split(from).length - 1;
        if (n !== 1) this.error(`vite-plugin-isogit: expected one match in ${id}, found ${n}: ${from.slice(0, 60)}`);
        out = out.replace(from, () => to);
      }
      out += id.endsWith('.cjs') ? EXPORT_CJS : EXPORT_ESM;
      return { code: out, map: null };
    },
  };
}
