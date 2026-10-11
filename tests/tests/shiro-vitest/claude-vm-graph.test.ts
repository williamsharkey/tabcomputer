/**
 * src/claude-vm/bun-graph.ts: Bun's standalone module graph from a compiled
 * executable's `.bun` ELF section (docs/CLAUDE_VM.md). Against a synthetic
 * ELF, and against native Claude Code when bench/.cache has it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBunGraph, findElfSection, BunLoader } from '@shiro/claude-vm/bun-graph';
import { fakeBunElf } from './fake-bun-elf';


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
