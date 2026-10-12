/**
 * npm install dropped the x bit of a package's files: the extractor wrote
 * each file with the default mode. Codex 0.162 checks that its own
 * vendor/…/bin/codex is executable and refused to start ("local Codex package
 * file bin/codex is not executable"). A file the archive marks executable is
 * now chmod'ed by the writer.
 */
import { describe, it, expect } from 'vitest';
import { extractTarGzToFS } from '@shiro/utils/tar-utils';

const enc = new TextEncoder();
function tarOf(files: [string, string, string][]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, mode, text] of files) {
    const data = enc.encode(text);
    const h = new Uint8Array(512);
    const put = (s: string, off: number) => h.set(enc.encode(s), off);
    put(name, 0); put(mode + '\0', 100); put('0000000\0', 108); put('0000000\0', 116);
    put(data.length.toString(8).padStart(11, '0') + '\0', 124); put('00000000000\0', 136);
    put('        ', 148); put('0', 156); put('ustar\0', 257); put('00', 263);
    put(h.reduce((a, b) => a + b, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) { out.set(b, o); o += b.length; }
  return out;
}
async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
}

describe('extractTarGzToFS keeps the x bit', () => {
  it('chmods the files the archive marks executable, and only those', async () => {
    const tgz = await gzip(tarOf([
      ['package/vendor/bin/codex', '0000755', 'ELF'],
      ['package/package.json', '0000644', '{}'],
      ['package/run.sh', '0000700', '#!/bin/sh\n'],
    ]));
    const written: string[] = [];
    const modes: Record<string, number> = {};
    await extractTarGzToFS(tgz, '/pkg', {
      writeFile: async (p) => { written.push(p); },
      mkdir: async () => {},
      chmod: async (p, m) => { expect(written).toContain(p); modes[p] = m; },
    });
    expect(written).toHaveLength(3);
    expect(Object.keys(modes).sort()).toEqual(written.filter((p) => !p.endsWith('package.json')).sort());
    expect(Object.values(modes).every((m) => m === 0o755)).toBe(true);
  });

  it('a writer without chmod still extracts', async () => {
    const tgz = await gzip(tarOf([['package/a', '0000755', 'x']]));
    const written: string[] = [];
    await extractTarGzToFS(tgz, '/pkg', { writeFile: async (p) => { written.push(p); }, mkdir: async () => {} });
    expect(written).toHaveLength(1);
  });
});
