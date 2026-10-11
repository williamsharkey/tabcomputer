/**
 * gunzip off the page's long tasks (#19): the JS inflater (gzip-codec.ts) took
 * 0.55 s in one task for a 10 MB .tgz. A single-member input is inflated by the
 * browser's DecompressionStream instead, fed a MiB at a time (pipeBytes). It is
 * used only when it agrees with the last member's trailer (CRC and size), so a
 * native decoder that stopped after a first member, or rejected a valid file,
 * changes nothing: gzip-codec.ts decodes those, and every error, as before.
 */
import { gunzipDetailed, isGzip, type GunzipResult } from './gzip-codec';
import { crc32Update } from './crc32';
import { pipeBytes } from '../../utils/stream-bytes';

const NATIVE_MIN = 1 << 20;
const CRC_SLICE = 4 << 20;

async function nativeGunzip(inp: Uint8Array): Promise<Uint8Array | null> {
  if (typeof DecompressionStream === 'undefined' || inp.length < 18) return null;
  let out: Uint8Array;
  try {
    out = await pipeBytes(inp, new DecompressionStream('gzip'));
  } catch {
    return null;
  }
  const t = inp.length - 8;
  const crc = (inp[t] | (inp[t + 1] << 8) | (inp[t + 2] << 16) | (inp[t + 3] << 24)) >>> 0;
  const isize = (inp[t + 4] | (inp[t + 5] << 8) | (inp[t + 6] << 16) | (inp[t + 7] << 24)) >>> 0;
  if (isize !== out.length >>> 0) return null;
  let c = 0;
  for (let off = 0; off < out.length; off += CRC_SLICE) {
    c = crc32Update(c, out, off, Math.min(off + CRC_SLICE, out.length));
    if (off + CRC_SLICE < out.length) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return c === crc ? out : null;
}

/** gunzipDetailed, with big single-member inputs inflated natively */
export async function gunzipDetailedAsync(inp: Uint8Array): Promise<GunzipResult> {
  if (inp.length >= NATIVE_MIN && isGzip(inp)) {
    const data = await nativeGunzip(inp);
    if (data) return { data, trailingGarbage: false };
  }
  return gunzipDetailed(inp);
}

export async function gunzipAsync(inp: Uint8Array): Promise<Uint8Array> {
  return (await gunzipDetailedAsync(inp)).data;
}
