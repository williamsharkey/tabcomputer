/**
 * Bun's standalone module graph, read from a compiled Bun executable (native
 * Claude Code): the files `bun build --compile` embedded, with their source.
 * docs/CLAUDE_VM.md has the layout.
 *
 * On Linux the graph is the ELF section `.bun`: a u64 payload length, then the
 * payload, which ends with an Offsets record and the trailer
 * "\n---- Bun! ----\n". Offsets name the module table; each module record is
 * string pointers (u32 offset, u32 length, from the payload start) for its
 * name, contents, source map, bytecode and, in newer Bun, more, followed by
 * four u8s (encoding, loader, module format, side).
 */

export const BUN_TRAILER = '\n---- Bun! ----\n';

/** Bun's loader numbers that occur in Claude Code's graph */
export const BunLoader = { js: 1, file: 5, napi: 10, text: 13 } as const;

export interface BunModule {
  /** The path the code sees, e.g. /$bunfs/root/cli */
  name: string;
  /** The file's bytes (a view into the executable, not a copy) */
  contents: Uint8Array;
  /** JSC bytecode beside the source, when there is any (byte length only) */
  bytecodeLength: number;
  encoding: number;
  loader: number;
  format: number;
}

export interface BunGraph {
  entry: BunModule;
  modules: BunModule[];
}

const RECORD_SIZES = [52, 44, 36]; // 6, 5 or 4 string pointers + 4 bytes

/**
 * Where the parser reads bytes: a whole file in memory, or the parts of one
 * fetched so far (remote-graph.ts). `need` throws NeedBytes for the ranges it
 * doesn't have yet, all at once, so a caller can fetch them and parse again.
 */
export interface ByteSource {
  size: number;
  need(ranges: [offset: number, length: number][]): void;
  /** bytes the source has (a view, not a copy) */
  bytes(offset: number, length: number): Uint8Array;
}

export class NeedBytes extends Error {
  ranges: [number, number][];
  constructor(ranges: [number, number][]) { super(`need ${ranges.length} byte ranges`); this.ranges = ranges; }
}

export function arraySource(a: Uint8Array): ByteSource {
  return {
    size: a.length,
    need() {},
    bytes: (o, l) => {
      if (o < 0 || o + l > a.length) throw new RangeError('out of range');
      return a.subarray(o, o + l);
    },
  };
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

/** The section `name`'s [offset, size] in an ELF64 little-endian file, or null. */
export function findElfSection(elf: Uint8Array | ByteSource, name: string): [number, number] | null {
  const src = elf instanceof Uint8Array ? arraySource(elf) : elf;
  if (src.size < 64) return null;
  src.need([[0, 64]]);
  const h = src.bytes(0, 64);
  if (h[0] !== 0x7f || h[1] !== 0x45 || h[2] !== 0x4c || h[3] !== 0x46 || h[4] !== 2 || h[5] !== 1) return null;
  const shoff = u64(h, 0x28);
  const shentsize = u16(h, 0x3a);
  const shnum = u16(h, 0x3c);
  const shstrndx = u16(h, 0x3e);
  if (!shoff || shentsize < 64 || shstrndx >= shnum || shoff + shnum * shentsize > src.size) return null;
  src.need([[shoff, shnum * shentsize]]);
  const sht = src.bytes(shoff, shnum * shentsize);
  const sh = (i: number) => i * shentsize;
  const strOff = u64(sht, sh(shstrndx) + 0x18);
  const strSize = u64(sht, sh(shstrndx) + 0x20);
  if (strOff + strSize > src.size) return null;
  src.need([[strOff, strSize]]);
  const strs = src.bytes(strOff, strSize);
  const want = new TextEncoder().encode(name + '\0');
  for (let i = 0; i < shnum; i++) {
    const n = u32(sht, sh(i));
    let match = n + want.length <= strs.length;
    for (let k = 0; match && k < want.length; k++) match = strs[n + k] === want[k];
    if (match) return [u64(sht, sh(i) + 0x18), u64(sht, sh(i) + 0x20)];
  }
  return null;
}

/** Parse the module graph of a compiled Bun executable; throws when there is none. */
export function parseBunGraph(elf: Uint8Array | ByteSource): BunGraph {
  const src = elf instanceof Uint8Array ? arraySource(elf) : elf;
  const sec = findElfSection(src, '.bun');
  if (!sec) throw new Error('not a Bun executable (no .bun section)');
  const [secOff, secSize] = sec;
  if (secOff + secSize > src.size || secSize < 8) throw new Error('.bun section: out of range');
  src.need([[secOff, 8]]);
  const payloadLen = u64(src.bytes(secOff, 8), 0);
  const base = secOff + 8;
  if (payloadLen < 48 || payloadLen > secSize - 8) throw new Error('.bun section: bad payload length');
  const end = base + payloadLen;
  const tailLen = BUN_TRAILER.length + 32;
  src.need([[end - tailLen, tailLen]]);
  const tail = src.bytes(end - tailLen, tailLen);
  const trailer = new TextDecoder().decode(tail.subarray(32));
  if (trailer !== BUN_TRAILER) throw new Error('.bun section: no Bun trailer');
  const modOff = u32(tail, 8);
  const modLen = u32(tail, 12);
  const entryId = u32(tail, 16);
  if (modOff + modLen > payloadLen) throw new Error('.bun section: module table out of range');
  src.need([[base + modOff, modLen]]);
  const table = src.bytes(base + modOff, modLen);

  const dec = new TextDecoder();
  const inRange = (o: number, l: number) => o + l <= payloadLen;
  for (const size of RECORD_SIZES) {
    if (modLen % size) continue;
    const count = modLen / size;
    const ptr = (i: number, k: number) => [u32(table, i * size + 8 * k), u32(table, i * size + 8 * k + 4)] as const;
    let ok = true;
    for (let i = 0; ok && i < count; i++) ok = inRange(...ptr(i, 0)) && inRange(...ptr(i, 1));
    if (!ok) continue;
    // the names first (they tell which record size it is), then every file's bytes
    src.need(Array.from({ length: count }, (_, i) => [base + ptr(i, 0)[0], ptr(i, 0)[1]] as [number, number]));
    const names: string[] = [];
    for (let i = 0; ok && i < count; i++) {
      const name = dec.decode(src.bytes(base + ptr(i, 0)[0], ptr(i, 0)[1]));
      ok = name.startsWith('/$bunfs/') || /^B:[\\/]~BUN[\\/]/.test(name);
      names.push(name);
    }
    if (!ok) continue; // another record size
    src.need(Array.from({ length: count }, (_, i) => [base + ptr(i, 1)[0], ptr(i, 1)[1]] as [number, number]));
    const modules: BunModule[] = names.map((name, i) => {
      const flags = i * size + size - 4;
      return {
        name,
        contents: src.bytes(base + ptr(i, 1)[0], ptr(i, 1)[1]),
        bytecodeLength: size >= 36 ? ptr(i, 3)[1] : 0,
        encoding: table[flags], loader: table[flags + 1], format: table[flags + 2],
      };
    });
    if (entryId >= modules.length) throw new Error('.bun section: entry point out of range');
    return { entry: modules[entryId], modules };
  }
  throw new Error('.bun section: unknown module record layout');
}
