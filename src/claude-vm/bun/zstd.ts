/** Bun.zstdDecompressSync and zstdDecompress: decompression only (fzstd, in JS), to a Buffer */
import { decompress } from 'fzstd';
import { toBytes } from './hash';

export function zstdDecompressSync(data: unknown, toBuffer: (b: Uint8Array) => Uint8Array = (b) => b): Uint8Array {
  return toBuffer(decompress(toBytes(data)));
}

export async function zstdDecompress(data: unknown, toBuffer?: (b: Uint8Array) => Uint8Array): Promise<Uint8Array> {
  return zstdDecompressSync(data, toBuffer);
}
