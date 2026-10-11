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

/** The `.bun` section's [offset, size] in an ELF64 little-endian file, or null. */
export function findElfSection(elf: Uint8Array, name: string): [number, number] | null {
  if (elf.length < 64 || elf[0] !== 0x7f || elf[1] !== 0x45 || elf[2] !== 0x4c || elf[3] !== 0x46 || elf[4] !== 2 || elf[5] !== 1) return null;
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const shoff = Number(dv.getBigUint64(0x28, true));
  const shentsize = dv.getUint16(0x3a, true);
  const shnum = dv.getUint16(0x3c, true);
  const shstrndx = dv.getUint16(0x3e, true);
  if (!shoff || shentsize < 64 || shstrndx >= shnum || shoff + shnum * shentsize > elf.length) return null;
  const sh = (i: number) => shoff + i * shentsize;
  const strOff = Number(dv.getBigUint64(sh(shstrndx) + 0x18, true));
  const want = new TextEncoder().encode(name + '\0');
  for (let i = 0; i < shnum; i++) {
    const n = strOff + dv.getUint32(sh(i), true);
    let match = n + want.length <= elf.length;
    for (let k = 0; match && k < want.length; k++) match = elf[n + k] === want[k];
    if (match) return [Number(dv.getBigUint64(sh(i) + 0x18, true)), Number(dv.getBigUint64(sh(i) + 0x20, true))];
  }
  return null;
}

/** Parse the module graph of a compiled Bun executable; throws when there is none. */
export function parseBunGraph(elf: Uint8Array): BunGraph {
  const sec = findElfSection(elf, '.bun');
  if (!sec) throw new Error('not a Bun executable (no .bun section)');
  const [secOff, secSize] = sec;
  const dv = new DataView(elf.buffer, elf.byteOffset, elf.byteLength);
  const payloadLen = Number(dv.getBigUint64(secOff, true));
  const base = secOff + 8;
  if (payloadLen < 48 || payloadLen > secSize - 8) throw new Error('.bun section: bad payload length');
  const end = base + payloadLen;
  const trailer = new TextDecoder().decode(elf.subarray(end - BUN_TRAILER.length, end));
  if (trailer !== BUN_TRAILER) throw new Error('.bun section: no Bun trailer');
  const offsets = end - BUN_TRAILER.length - 32;
  const modOff = dv.getUint32(offsets + 8, true);
  const modLen = dv.getUint32(offsets + 12, true);
  const entryId = dv.getUint32(offsets + 16, true);
  if (modOff + modLen > payloadLen) throw new Error('.bun section: module table out of range');

  const dec = new TextDecoder();
  const slice = (o: number, l: number) => {
    if (o + l > payloadLen) throw new RangeError('.bun section: string out of range');
    return elf.subarray(base + o, base + o + l);
  };
  for (const size of RECORD_SIZES) {
    if (modLen % size) continue;
    const count = modLen / size;
    const modules: BunModule[] = [];
    try {
      for (let i = 0; i < count; i++) {
        const p = base + modOff + i * size;
        const ptr = (k: number) => [dv.getUint32(p + 8 * k, true), dv.getUint32(p + 8 * k + 4, true)] as const;
        const name = dec.decode(slice(...ptr(0)));
        if (!name.startsWith('/$bunfs/') && !/^B:[\\/]~BUN[\\/]/.test(name)) throw new Error('not a module name');
        const flags = p + size - 4;
        modules.push({
          name,
          contents: slice(...ptr(1)),
          bytecodeLength: size >= 36 ? ptr(3)[1] : 0,
          encoding: elf[flags], loader: elf[flags + 1], format: elf[flags + 2],
        });
      }
    } catch { continue; } // another record size
    if (entryId >= modules.length) throw new Error('.bun section: entry point out of range');
    return { entry: modules[entryId], modules };
  }
  throw new Error('.bun section: unknown module record layout');
}
