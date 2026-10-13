/**
 * For package-layers.test.ts: server.mjs's package layers (createPackageLayers)
 * on a port of its own, with a stand-in for the builder. Plain Node, because
 * vitest's polyfilled modules can't load server.mjs, and the real builder
 * needs root and a Linux chroot.
 *
 *   DIR=layers WORK=dir ROOTFS=dir [BUILDER=0] [QUEUE=n] [PER_ADDRESS=n] [PER_HOUR=n] node package-layers-harness.mjs   → prints "PORT n"
 *   GET /debian/layers/set?...      the route under test
 *   GET /__spawned                  every builder start so far: [{ file, args, env: { the variables the service set } }]
 *   GET /__release?key=KEY          let the held build of KEY go on
 *   GET /__stats                    the service's own view
 *
 * As a builder (`node package-layers-harness.mjs --build KEY`, which is what
 * the service is told to run): it reads SPEC like scripts/debian/build-set.sh,
 * prints the lines that script prints, and writes OUT/KEY/layer.json. What a
 * package name asks of it:
 *   hold-*     wait for /__release (a file in WORK) before installing
 *   fail-*     exit 1 after downloading
 *   huge-*     refuse as too large, exit 4
 *   ghost-*    apt's "Unable to locate package", exit 100
 */
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);

if (process.argv[2] === '--build') {
  const key = process.argv[3];
  const { OUT, WORK, SPEC, BASE } = process.env;
  const names = JSON.parse(readFileSync(SPEC, 'utf8')).layers[key].packages;
  const say = (l) => process.stdout.write(l + '\n');
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  say('::tc:: phase resolving');
  if (names.some((n) => n.startsWith('ghost-'))) { process.stderr.write(`E: Unable to locate package ${names.find((n) => n.startsWith('ghost-'))}\n`); process.exit(100); }
  if (names.some((n) => n.startsWith('huge-'))) { say('::tc:: refused too-large This set downloads 900 MB of packages; the builder takes at most 200 MB.'); process.exit(4); }
  const total = names.length + 2;
  say(`::tc:: total ${total}`);
  say('::tc:: phase downloading');
  for (let i = 1; i <= total; i++) say(`Get:${i} http://snapshot.test/debian trixie/main amd64 pkg${i} amd64 1.0 [1 kB]`);
  if (names.some((n) => n.startsWith('fail-'))) process.exit(1);
  say('::tc:: phase installing');
  say(`Setting up dep1 (1.0) ...`);
  if (names.some((n) => n.startsWith('hold-'))) while (!existsSync(join(WORK, `release-${key}`))) await wait(25);
  for (const n of names) say(`Setting up ${n} (1.0) ...`);
  say('::tc:: phase packing');
  const base = JSON.parse(readFileSync(join(BASE, 'rootfs.json'), 'utf8'));
  mkdirSync(join(OUT, key), { recursive: true });
  mkdirSync(join(OUT, 'chunks'), { recursive: true });
  writeFileSync(join(OUT, key, 'index-00aa.json.gz'), 'not a real index');
  writeFileSync(join(OUT, 'chunks', `${'ab'.repeat(32)}.gz`), 'not a real chunk');
  writeFileSync(join(OUT, key, 'layer.json'), JSON.stringify({ format: 1, kind: 'layer', id: 'aa00', name: key, base: base.id, snapshot: base.snapshot, recipe: 'test', index: `${key}/index-00aa.json.gz`, packages: total, entries: 1, files: 1, bytes: 1, chunks: 1, chunkBytes: 16 }));
  process.exit(0);
}

const m = await import(new URL('../../../server.mjs', import.meta.url).href);
const { spawn } = await import('node:child_process');
const env = process.env;
const cfg = {
  ...m.packageLayersConfig({
    TABCOMPUTER_DEBIAN_LAYERS: env.DIR, STATIC_DIR: env.ROOTFS, TABCOMPUTER_LAYER_BUILDER: env.BUILDER === '0' ? '0' : '1',
    TABCOMPUTER_LAYER_BUILDER_WORK: env.WORK, TABCOMPUTER_LAYER_BUILDER_CMD: JSON.stringify(['node', self, '--build']),
    TABCOMPUTER_LAYER_QUEUE: env.QUEUE, TABCOMPUTER_LAYER_PER_ADDRESS: env.PER_ADDRESS, TABCOMPUTER_LAYER_PER_ADDRESS_HOUR: env.PER_HOUR,
    TABCOMPUTER_TRUST_PROXY: 'always',
  }),
  failedMs: Number(env.FAILED_MS || 600_000),
};
const spawned = [];
const layers = m.createPackageLayers(cfg, {
  log: () => {},
  spawnFn: (file, args, opts) => {
    spawned.push({ file, args, env: Object.fromEntries(Object.entries(opts.env).filter(([k, v]) => process.env[k] !== v)) });
    return spawn(file, args, opts);
  },
});

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/__spawned') return json(spawned);
  if (url.pathname === '/__stats') return json(layers.stats());
  if (url.pathname === '/__release') { writeFileSync(join(env.WORK, `release-${url.searchParams.get('key')}`), ''); return json({}); }
  if (url.pathname === '/debian/layers/set') return layers.handle(req, res, url);
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1', () => console.log(`PORT ${server.address().port}`));
process.on('SIGTERM', () => { layers.close(); process.exit(0); });
