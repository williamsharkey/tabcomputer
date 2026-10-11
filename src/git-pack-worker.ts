/**
 * Indexes a git pack off the page (src/git-pack-indexer.ts): isomorphic-git's
 * own GitPackIndex.fromPack (both passes: inflate, sha1, crc32), exported to
 * this worker by vite-plugin-isogit.ts. Gets the pack, returns the .idx.
 */
import './git-pack-worker-env';
// @ts-expect-error: exported by the build transform (vite-plugin-isogit.ts), not in isomorphic-git's types
import { __shiroGitPackIndex as GitPackIndex } from 'isomorphic-git';
import { Buffer } from 'buffer';

/** A thin pack's object outside it: the page indexes that one (it has the repository) */
const EXTERNAL = 'shiro: external ref delta';

self.onmessage = async (e: MessageEvent<{ pack: Uint8Array }>) => {
  try {
    const pack = Buffer.from(e.data.pack.buffer, e.data.pack.byteOffset, e.data.pack.byteLength);
    const p = await GitPackIndex.fromPack({ pack, getExternalRefDelta: async () => { throw new Error(EXTERNAL); } });
    const idx: Uint8Array = await p.toBuffer();
    const out = Uint8Array.prototype.slice.call(idx); // (its own buffer, transferred)
    (self as unknown as Worker).postMessage({ idx: out }, [out.buffer]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ error: String((err as Error)?.message ?? err) });
  }
};
