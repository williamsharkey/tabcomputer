/**
 * src/claude-vm/bun-graph.ts: Bun's standalone module graph from a compiled
 * executable's `.bun` ELF section (docs/CLAUDE_VM.md). Against a synthetic
 * ELF, and against native Claude Code when bench/.cache has it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBunGraph, findElfSection, BUN_TRAILER, BunLoader } from '@shiro/claude-vm/bun-graph';

const enc = new TextEncoder();

/** A minimal ELF64 with a .bun section holding `files` (record size 52), entry `entry` */
function fakeBunElf(files: { name: string; contents: string; loader: number }[], entry: number, recordSize = 52): Uint8Array {
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

describe('claude --vm: the Bun module graph', () => {
  const files = [
    { name: '/$bunfs/root/chunk-a.js', contents: '// @bun\nexport const a = 1;\n', loader: BunLoader.js },
    { name: '/$bunfs/root/cli', contents: '// @bun\nimport{a}from"/$bunfs/root/chunk-a.js";\n', loader: BunLoader.js },
    { name: '/$bunfs/root/SKILL.md', contents: '# a skill\n', loader: BunLoader.text },
  ];

  it('finds .bun by name and reads every module, its loader and the entry point', () => {
    for (const size of [52, 44, 36]) {
      const g = parseBunGraph(fakeBunElf(files, 1, size));
      expect(g.modules.map((m) => m.name)).toEqual(files.map((f) => f.name));
      expect(g.entry.name).toBe('/$bunfs/root/cli');
      expect(new TextDecoder().decode(g.entry.contents)).toBe(files[1].contents);
      expect(g.modules.map((m) => m.loader)).toEqual([BunLoader.js, BunLoader.js, BunLoader.text]);
    }
  });

  it('says what is wrong with something that is not a Bun executable', () => {
    expect(() => parseBunGraph(new Uint8Array(100))).toThrow('no .bun section');
    const elf = fakeBunElf(files, 1);
    const [off, size] = findElfSection(elf, '.bun')!;
    elf[off + size - 2] = 0x21; // the trailer's last dash
    expect(() => parseBunGraph(elf)).toThrow('no Bun trailer');
    expect(() => parseBunGraph(fakeBunElf(files, 7))).toThrow('entry point out of range');
  });

  const native = resolve(__dirname, '../../../bench/.cache/fixtures/claude-native');
  it.skipIf(!existsSync(native))('reads native Claude Code (bench/.cache/fixtures/claude-native): source beside bytecode', () => {
    const bin = readFileSync(native);
    const g = parseBunGraph(new Uint8Array(bin.buffer, bin.byteOffset, bin.byteLength));
    expect(g.entry.name).toBe('/$bunfs/root/cli');
    const head = new TextDecoder().decode(g.entry.contents.subarray(0, 200));
    expect(head.startsWith('// @bun')).toBe(true);
    expect(head).toContain('Claude Code');
    const js = g.modules.filter((m) => m.loader === BunLoader.js);
    expect(js.length).toBeGreaterThan(1000);
    expect(js.every((m) => m.contents.length > 0)).toBe(true);
    expect(g.modules.some((m) => m.loader === BunLoader.napi)).toBe(true);
  });
});
