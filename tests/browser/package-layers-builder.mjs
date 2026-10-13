// A stand-in for scripts/debian/build-set.sh, for tests/browser/package-layers.mjs
// on a machine that cannot run the real builder (it needs root and a Linux
// chroot). server.mjs starts it as its builder
// (TABCOMPUTER_LAYER_BUILDER_CMD='["node","tests/browser/package-layers-builder.mjs"]')
// with the set's key; it prints the lines build-set.sh prints, a few a second,
// and then puts a layer that was built before (tests/browser/capture-layer.mjs)
// in place: FIXTURE names a sets directory that has the key.
//
// So the tab sees a first-ever build exactly as the server reports one, and
// then applies a real layer. A key FIXTURE lacks fails like a failed build.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const key = process.argv[2];
const { OUT, FIXTURE, SPEC } = process.env;
const say = (l) => process.stdout.write(l + '\n');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const names = JSON.parse(readFileSync(SPEC, 'utf8')).layers[key].packages;
say('::tc:: phase resolving');
await wait(600);
const from = join(FIXTURE ?? '', key);
if (!FIXTURE || !existsSync(join(from, 'layer.json'))) {
  process.stderr.write(`E: Unable to locate package ${names[0]}\n`);
  process.exit(100);
}
const total = JSON.parse(readFileSync(join(from, 'layer.json'), 'utf8')).packages;
const step = Number(process.env.STEP_MS || 60);
say(`::tc:: total ${total}`);
say('::tc:: phase downloading');
for (let i = 1; i <= total; i++) { say(`Get:${i} https://snapshot.debian.org/archive/debian trixie/main amd64 package${i} amd64 1.0 [100 kB]`); await wait(step / 2); }
say('::tc:: phase installing');
for (let i = 1; i <= total; i++) { say(`Setting up package${i} (1.0) ...`); await wait(step); }
say('::tc:: phase packing');
await wait(1800);
mkdirSync(join(OUT, 'chunks'), { recursive: true });
for (const f of readdirSync(join(FIXTURE, 'chunks'))) if (!existsSync(join(OUT, 'chunks', f))) cpSync(join(FIXTURE, 'chunks', f), join(OUT, 'chunks', f));
mkdirSync(join(OUT, key), { recursive: true });
for (const f of readdirSync(from).filter((f) => f !== 'layer.json')) cpSync(join(from, f), join(OUT, key, f));
cpSync(join(from, 'layer.json'), join(OUT, key, 'layer.json'));
