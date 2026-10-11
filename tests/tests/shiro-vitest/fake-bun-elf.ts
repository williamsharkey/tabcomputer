/**
 * A synthetic Bun standalone executable (docs/CLAUDE_VM.md) for the claude --vm tests.
 */
import { BUN_TRAILER } from '@shiro/claude-vm/bun-graph';

const enc = new TextEncoder();

/** A minimal ELF64 with a .bun section holding `files` (record size 52), entry `entry` */
export function fakeBunElf(files: { name: string; contents: string; loader: number }[], entry: number, recordSize = 52): Uint8Array {
  // payload: strings, module table, Offsets, trailer
  const data: number[] = [];
  const put = (b: Uint8Array) => { const o = data.length; data.push(...b); return [o, b.length] as const; };
  const ptrs = files.map((f) => ({ name: put(enc.encode(f.name)), contents: put(enc.encode(f.contents)), loader: f.loader }));
  const modOff = data.length;
  for (const p of ptrs) {
    const rec = new DataView(new ArrayBuffer(recordSize));
    rec.setUint32(0, p.name[0], true); rec.setUint32(4, p.name[1], true);
    rec.setUint32(8, p.contents[0], true); rec.setUint32(12, p.contents[1], true);
    rec.setUint8(recordSize - 4, 1); rec.setUint8(recordSize - 3, p.loader); rec.setUint8(recordSize - 2, 1);
    data.push(...new Uint8Array(rec.buffer));
  }
  const offsets = new DataView(new ArrayBuffer(32));
  offsets.setBigUint64(0, BigInt(data.length), true);
  offsets.setUint32(8, modOff, true); offsets.setUint32(12, ptrs.length * recordSize, true);
  offsets.setUint32(16, entry, true);
  data.push(...new Uint8Array(offsets.buffer), ...enc.encode(BUN_TRAILER));
  const payload = Uint8Array.from(data);

  const shstr = enc.encode('\0.shstrtab\0.bun\0');
  const secOff = 64, strOff = secOff + 8 + payload.length, shoff = strOff + shstr.length;
  const out = new Uint8Array(shoff + 3 * 64);
  const dv = new DataView(out.buffer);
  out.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
  dv.setBigUint64(0x28, BigInt(shoff), true);
  dv.setUint16(0x3a, 64, true); dv.setUint16(0x3c, 3, true); dv.setUint16(0x3e, 1, true);
  dv.setBigUint64(secOff, BigInt(payload.length), true);
  out.set(payload, secOff + 8);
  out.set(shstr, strOff);
  // [1] .shstrtab, [2] .bun
  dv.setUint32(shoff + 64, 1, true); dv.setBigUint64(shoff + 64 + 0x18, BigInt(strOff), true); dv.setBigUint64(shoff + 64 + 0x20, BigInt(shstr.length), true);
  dv.setUint32(shoff + 128, 11, true); dv.setBigUint64(shoff + 128 + 0x18, BigInt(secOff), true); dv.setBigUint64(shoff + 128 + 0x20, BigInt(8 + payload.length), true);
  return out;
}
