/**
 * src/claude-vm/remote-graph.ts: the Bun module graph read by byte ranges, as
 * the preinstall reads the site's copy of native Claude Code
 * (claude-vm/preinstall.ts). Against a synthetic Bun executable, and against
 * native Claude Code when bench/.cache has it.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseBunGraph, BunLoader } from '@shiro/claude-vm/bun-graph';
import { fetchBunGraph, httpRangeGet, coalesce, RangesUnsupported } from '@shiro/claude-vm/remote-graph';
import { fakeBunElf } from './fake-bun-elf.mjs';

const files = [
  { name: '/$bunfs/root/chunk-a.js', contents: '// @bun\nexport const a = 1;\n'.repeat(50), loader: BunLoader.js },
  { name: '/$bunfs/root/cli', contents: '// @bun\nimport{a}from"/$bunfs/root/chunk-a.js";\n', loader: BunLoader.js },
  { name: '/$bunfs/root/SKILL.md', contents: '# a skill\n'.repeat(100), loader: BunLoader.text },
];

const same = (a: ReturnType<typeof parseBunGraph>, b: ReturnType<typeof parseBunGraph>) => {
  expect(a.modules.map((m) => [m.name, m.loader, Buffer.from(m.contents).toString('latin1')]))
    .toEqual(b.modules.map((m) => [m.name, m.loader, Buffer.from(m.contents).toString('latin1')]));
  expect(a.entry.name).toBe(b.entry.name);
};

describe('claude --vm: the module graph by byte ranges', () => {
  it('reads the same graph as the whole file, asking only for ranges inside it', async () => {
    const elf = fakeBunElf(files, 1);
    const asked: [number, number][] = [];
    const get = async (s: number, e: number) => { asked.push([s, e]); expect(s).toBeGreaterThanOrEqual(0); expect(e).toBeLessThanOrEqual(elf.length); return elf.slice(s, e); };
    // a small first fetch and small requests: several rounds, large ranges in pieces
    const { graph, bytes } = await fetchBunGraph(elf.length, get, { suffix: 200, chunk: 64, parallel: 3 });
    same(graph, parseBunGraph(elf));
    expect(asked.length).toBeGreaterThan(3);
    expect(bytes).toBe(asked.reduce((n, [s, e]) => n + e - s, 0));
    // the default: the whole small file's end in one request, nothing more
    const again: number[] = [];
    const r = await fetchBunGraph(elf.length, async (s, e) => { again.push(e - s); return elf.slice(s, e); });
    same(r.graph, parseBunGraph(elf));
    expect(again).toEqual([elf.length]);
  });

  it('fails clearly for a file that is not a Bun executable, and past maxBytes', async () => {
    const junk = new Uint8Array(4096);
    await expect(fetchBunGraph(junk.length, async (s, e) => junk.slice(s, e))).rejects.toThrow('no .bun section');
    const elf = fakeBunElf(files, 1);
    await expect(fetchBunGraph(elf.length, async (s, e) => elf.slice(s, e), { suffix: 100, maxBytes: 300 })).rejects.toThrow('spread over more than');
    await expect(fetchBunGraph(elf.length, async (s, e) => elf.slice(s, e - 1))).rejects.toThrow('bytes');
  });

  it('merges ranges that touch or lie close', () => {
    expect(coalesce([[100, 10], [0, 10], [12, 5], [5000, 1], [0, 0]], 10)).toEqual([[0, 17], [100, 110], [5000, 5001]]);
  });

  it('httpRangeGet: a 206 for exactly the range; a 200 means the server has no ranges', async () => {
    const body = Uint8Array.from({ length: 100 }, (_, i) => i);
    const server = (status: number, range?: string) => (async (_url: string, init?: RequestInit) => {
      const m = /bytes=(\d+)-(\d+)/.exec((init?.headers as any)?.Range)!;
      const [s, e] = [Number(m[1]), Number(m[2])];
      return new Response(status === 206 ? body.slice(s, e + 1) : body, { status, headers: { 'content-range': range ?? `bytes ${s}-${e}/100` } });
    }) as typeof fetch;
    expect([...await httpRangeGet('/x', server(206))(10, 13)]).toEqual([10, 11, 12]);
    await expect(httpRangeGet('/x', server(200))(10, 13)).rejects.toBeInstanceOf(RangesUnsupported);
    await expect(httpRangeGet('/x', server(206, 'bytes 0-2/100'))(10, 13)).rejects.toThrow('another range');
    await expect(httpRangeGet('/x', server(404))(10, 13)).rejects.toThrow('HTTP 404');
  });

  it('httpRangeGet: `?range=` first (compressed by this site\'s server); a server without it is left for `Range:`', async () => {
    const body = Uint8Array.from({ length: 100 }, (_, i) => i);
    const asked: string[] = [];
    const sliced = (async (url: string, init?: RequestInit) => {
      asked.push(url + ((init?.headers as any)?.Range ? ' ' + (init!.headers as any).Range : ''));
      const [, s, e] = /range=(\d+)-(\d+)/.exec(url)!.map(Number);
      return new Response(body.slice(s, e + 1), { status: 200, headers: { 'x-tabcomputer-range': `bytes ${s}-${e}/100` } });
    }) as typeof fetch;
    const get = httpRangeGet('/x', sliced);
    expect([...await get(10, 13), ...await get(0, 1)]).toEqual([10, 11, 12, 0]);
    expect(asked).toEqual(['/x?range=10-12', '/x?range=0-0']);
    // an older server: the whole file for `?range=`, then a 206 for `Range:` (and no more `?range=`)
    asked.length = 0;
    const older = (async (url: string, init?: RequestInit) => {
      const range = (init?.headers as any)?.Range;
      asked.push(range ? `${url} ${range}` : url);
      if (!range) return new Response(body, { status: 200 });
      const [, s, e] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number);
      return new Response(body.slice(s, e + 1), { status: 206, headers: { 'content-range': `bytes ${s}-${e}/100` } });
    }) as typeof fetch;
    const old = httpRangeGet('/x', older);
    expect([...await old(10, 13), ...await old(20, 21)]).toEqual([10, 11, 12, 20]);
    expect(asked).toEqual(['/x?range=10-12', '/x bytes=10-12', '/x bytes=20-20']);
  });

  const native = resolve(__dirname, '../../../bench/.cache/fixtures/claude-native');
  it.skipIf(!existsSync(native))('native Claude Code: the same graph from a fraction of the file', async () => {
    const bin = new Uint8Array(readFileSync(native));
    const { graph, bytes } = await fetchBunGraph(bin.length, async (s, e) => bin.subarray(s, e));
    same(graph, parseBunGraph(bin));
    expect(bytes).toBeLessThan(bin.length / 3);
  });
});
