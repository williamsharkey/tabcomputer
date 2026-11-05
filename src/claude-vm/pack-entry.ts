/**
 * Build one layout pack from a Claude Code binary. Run via
 * scripts/claude-vm/pack-layout.mjs (esbuild bundles this for Node).
 *
 *   node pack-entry.mjs BINARY OUT_DIR [VERSION] [SHA256]
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { parseBunGraph } from './bun-graph';
import { renderVmLayout, VM_LAYOUT } from './extract';
import { encodeLayoutPack, VM_DIR_PLACEHOLDER } from './layout-pack';

const binPath = process.argv[2];
const outDir = process.argv[3];
const version = process.argv[4] || '0.0.0';
const elf = new Uint8Array(readFileSync(binPath));
const sha = (process.argv[5] || createHash('sha256').update(elf).digest('hex'));
const graph = parseBunGraph(elf);
const t0 = Date.now();
const rendered = await renderVmLayout(graph, VM_DIR_PLACEHOLDER, (n, total) => {
  if (n % 400 === 0 || n === total) process.stdout.write(`  ${n}/${total} modules (${((Date.now() - t0) / 1000).toFixed(1)} s)\n`);
}, 0);
const pack = encodeLayoutPack({
  vmLayout: VM_LAYOUT, placeholder: VM_DIR_PLACEHOLDER, sha256: sha, version, files: rendered.files,
});
const gz = gzipSync(pack, { level: 6 });
const dir = `${outDir}/${sha}/${VM_LAYOUT}`;
mkdirSync(dir, { recursive: true });
writeFileSync(`${dir}/pack.gz`, gz);
process.stdout.write(`pack ${(pack.length / 2 ** 20).toFixed(1)} MB, gzip ${(gz.length / 2 ** 20).toFixed(1)} MB -> ${dir}/pack.gz\n`);
