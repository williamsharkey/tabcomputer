/** Bun.hash.crc32: CRC-32 (IEEE, as gzip and zip frame it), continuing from `seed` */

let table: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}

/** The bytes Bun hashes: a string's UTF-8, an ArrayBuffer's or a view's bytes */
export function toBytes(data: unknown): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof ArrayBuffer || (typeof SharedArrayBuffer !== 'undefined' && data instanceof SharedArrayBuffer)) return new Uint8Array(data);
  throw new TypeError('Expected a string, ArrayBuffer or ArrayBufferView');
}

export function crc32(data: unknown, seed = 0): number {
  const t = crcTable();
  const bytes = toBytes(data);
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const M64 = (1n << 64n) - 1n;
const P1 = 11400714785074694791n, P2 = 14029467366897019727n, P3 = 1609587929392839161n, P4 = 9650029242287828579n, P5 = 2870177450012600261n;
const rotl = (x: bigint, r: bigint) => ((x << r) | (x >> (64n - r))) & M64;
const round = (acc: bigint, lane: bigint) => (rotl((acc + lane * P2) & M64, 31n) * P1) & M64;
const merge = (acc: bigint, v: bigint) => (((acc ^ round(0n, v)) * P1) + P4) & M64;

/** Bun.hash.xxHash64: XXH64 of the bytes with `seed`, as a bigint */
export function xxHash64(data: unknown, seed: number | bigint = 0): bigint {
  const b = toBytes(data);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const s = BigInt.asUintN(64, BigInt(seed));
  const len = b.length;
  let i = 0;
  let h: bigint;
  if (len >= 32) {
    let v1 = (s + P1 + P2) & M64, v2 = (s + P2) & M64, v3 = s, v4 = (s - P1) & M64;
    for (; i + 32 <= len; i += 32) {
      v1 = round(v1, dv.getBigUint64(i, true));
      v2 = round(v2, dv.getBigUint64(i + 8, true));
      v3 = round(v3, dv.getBigUint64(i + 16, true));
      v4 = round(v4, dv.getBigUint64(i + 24, true));
    }
    h = (rotl(v1, 1n) + rotl(v2, 7n) + rotl(v3, 12n) + rotl(v4, 18n)) & M64;
    h = merge(merge(merge(merge(h, v1), v2), v3), v4);
  } else h = (s + P5) & M64;
  h = (h + BigInt(len)) & M64;
  for (; i + 8 <= len; i += 8) h = ((rotl(h ^ round(0n, dv.getBigUint64(i, true)), 27n) * P1) + P4) & M64;
  if (i + 4 <= len) { h = ((rotl(h ^ ((BigInt(dv.getUint32(i, true)) * P1) & M64), 23n) * P2) + P3) & M64; i += 4; }
  for (; i < len; i++) h = (rotl(h ^ ((BigInt(b[i]) * P5) & M64), 11n) * P1) & M64;
  h ^= h >> 33n; h = (h * P2) & M64;
  h ^= h >> 29n; h = (h * P3) & M64;
  h ^= h >> 32n;
  return h;
}
