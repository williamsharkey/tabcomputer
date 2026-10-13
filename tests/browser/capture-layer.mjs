// A package layer made without a Linux builder, for checks on a machine that
// has none (a Mac): the packages are installed by Debian's own apt and dpkg
// in a headless tab, what that changed is copied out, and
// scripts/debian/pack-layer.mjs packs it as it packs a chroot build.
// Production layers come from scripts/debian/build-layers.sh; this is for
// tests/browser/package-layers.mjs only.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/capture-layer.mjs URL WORK OUT PACKAGE...
//
// WORK must be on a case-sensitive filesystem (Debian has paths that differ
// only by case). On a Mac:
//   hdiutil create -size 3g -type SPARSE -fs 'Case-sensitive APFS' -volname tcwork work.sparseimage
//   hdiutil attach work.sparseimage          # → /Volumes/tcwork
// OUT is a package-set directory (TABCOMPUTER_DEBIAN_LAYERS/sets). The layer's
// key comes from server.mjs, so the server finds it for the same names.
// Prints the time `apt install` took in the tab: the number a layer replaces.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import { existsSync, lutimesSync, mkdirSync, readFileSync, rmSync, symlinkSync, chmodSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumPath, loadPlaywright } from './_browser.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const [url, work, out, ...packages] = process.argv.slice(2);
if (!url || !work || !out || !packages.length) { console.error('usage: capture-layer.mjs URL WORK OUT PACKAGE...'); process.exit(2); }
const { packageSetKey, packageSetNames } = await import(join(REPO, 'server.mjs'));
const names = packageSetNames(packages);
if (!names.ok) { console.error(`capture-layer: ${names.message}`); process.exit(2); }
const base = join(REPO, 'public/debian');
const rootfs = JSON.parse(readFileSync(join(base, 'rootfs.json'), 'utf8'));
const key = packageSetKey(rootfs.id, rootfs.snapshot, names.names);
const EPOCH = Number(process.env.SOURCE_DATE_EPOCH || 1790812800);

// Never part of a layer: the person's files, logs, caches, what the tab itself keeps
// (boot installs Claude Code and a certificate bundle in the background: not apt's doing)
const SKIP = /^\/(home|tmp|proc|dev|sys|run|root|dom|mnt|media)(\/|$)|^\/var\/(log|tmp|cache\/apt|lib\/apt\/lists|lib\/shiro|lib\/tabcomputer|lib\/pkg|lib\/shiro-gui)(\/|$)|^\/usr\/lib\/pkg(\/|$)|^\/usr\/local\/(lib\/node_modules|bin\/claude)(\/|$)|^\/etc\/ssl\/cert\.pem$/;

const { chromium } = loadPlaywright();
const browser = await chromium.launch({ executablePath: chromiumPath(), args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(url);
await page.waitForFunction(() => window.__tabcomputer && window.__tabcomputer.shell, null, { timeout: 90_000 });
const sh = (cmd) => page.evaluate(async (cmd) => {
  let o = '';
  const t0 = performance.now();
  const s = window.__capShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  return { code, out: o.replace(/\r\n/g, '\n'), ms: Math.round(performance.now() - t0) };
}, cmd);

/** The tree as it is: per path a signature; file bytes are hashed in the page */
const snapshot = (slot) => page.evaluate(async (slot) => {
  const hex = (b) => Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
  const nodes = await window.__tabcomputer.fs.exportAll();
  const map = new Map();
  for (const n of nodes) {
    let sig;
    if (n.type === 'dir') sig = `d ${n.mode & 0o7777}`;
    else if (n.type === 'symlink') sig = `l ${n.symlinkTarget}`;
    else if (n.lazy) sig = `z ${n.mode & 0o7777} ${n.size} ${n.lazy.chunk}:${n.lazy.off}`;
    else sig = `f ${n.mode & 0o7777} ${n.size} ${hex(await crypto.subtle.digest('SHA-256', n.content ?? new Uint8Array(0)))}`;
    map.set(n.path, { sig, node: n });
  }
  window[slot] = map;
  return map.size;
}, slot);

let r = await sh('debian install');
if (r.code) { console.error(r.out); process.exit(1); }
console.log(`debian install: ${(r.ms / 1000).toFixed(1)} s`);
console.log(`before: ${await snapshot('__s0')} paths`);
r = await sh(`apt install -y ${names.names.join(' ')}`);
console.log(`apt install -y ${names.names.join(' ')}: exit ${r.code}, ${(r.ms / 1000).toFixed(1)} s`);
if (r.code) { console.error(r.out.split('\n').slice(-20).join('\n')); process.exit(1); }
console.log(`after: ${await snapshot('__s1')} paths`);

// What the install changed. A base file that was only read (a placeholder
// before, bytes now) is compared with the base tree below.
const changed = await page.evaluate(() => {
  const list = [];
  const removed = [];
  for (const [path, { sig, node }] of window.__s1) {
    const was = window.__s0.get(path);
    if (was && was.sig === sig) continue;
    // (a placeholder before and bytes now: where the base keeps those bytes, to tell a read from a change)
    const lazy = was?.node.lazy && was.node.type === 'file' && node.type === 'file' && was.node.size === node.size && (was.node.mode & 0o7777) === (node.mode & 0o7777) ? was.node.lazy : null;
    list.push({ path, type: node.type, mode: node.mode & 0o7777, mtime: Math.floor(node.mtime / 1000), size: node.size, target: node.symlinkTarget, was: lazy ? { chunk: lazy.chunk, off: lazy.off } : null });
  }
  for (const path of window.__s0.keys()) if (!window.__s1.has(path)) removed.push(path);
  window.__changed = list;
  return { list, removed };
});
const wanted = changed.list.filter((e) => !SKIP.test(e.path));
console.log(`changed: ${changed.list.length} paths (${wanted.length} kept), removed: ${changed.removed.length}`);

// The trees pack-layer.mjs diffs
const baseDir = join(work, `base-${rootfs.id}`);
const root = join(work, 'root');
if (!existsSync(join(baseDir, '.complete'))) {
  execFileSync('node', [join(REPO, 'scripts/debian/unpack-rootfs.mjs'), base, baseDir], { stdio: 'inherit' });
  writeFileSync(join(baseDir, '.complete'), '');
}
// (unpacked again and not copied: a copy drops the setuid and sticky bits)
execFileSync('node', [join(REPO, 'scripts/debian/unpack-rootfs.mjs'), base, root], { stdio: 'inherit' });
const baseChunks = new Map();
const baseChunk = (id) => {
  if (!baseChunks.has(id)) { baseChunks.clear(); baseChunks.set(id, gunzipSync(readFileSync(join(base, 'chunks', `${id}.gz`)))); }
  return baseChunks.get(id);
};

const bytesOf = (paths) => page.evaluate(async (paths) => {
  const outp = [];
  for (const p of paths) {
    const c = window.__s1.get(p).node.content ?? new Uint8Array(0);
    let s = '';
    for (let i = 0; i < c.length; i += 0x8000) s += String.fromCharCode.apply(null, c.subarray(i, i + 0x8000));
    outp.push(btoa(s));
  }
  return outp;
}, paths);

const clamp = (t) => (t > EPOCH && t < 4000000000 ? EPOCH : t);
const dirs = [];
let files = 0, same = 0, bytes = 0;
const fileEntries = wanted.filter((e) => e.type === 'file');
for (const e of wanted.sort((a, b) => (a.path < b.path ? -1 : 1))) {
  const abs = join(root, e.path);
  if (e.type === 'dir') { mkdirSync(abs, { recursive: true }); dirs.push([abs, e.mode, clamp(e.mtime)]); }
  else if (e.type === 'symlink') {
    mkdirSync(dirname(abs), { recursive: true });
    rmSync(abs, { recursive: true, force: true });
    symlinkSync(e.target, abs);
    lutimesSync(abs, clamp(e.mtime), clamp(e.mtime));
  }
}
for (let i = 0; i < fileEntries.length;) {
  const batch = [];
  for (let n = 0; i < fileEntries.length && batch.length < 400 && n < 6e6; i++) { batch.push(fileEntries[i]); n += fileEntries[i].size; }
  const contents = await bytesOf(batch.map((e) => e.path));
  for (const [j, e] of batch.entries()) {
    const data = Buffer.from(contents[j], 'base64');
    const abs = join(root, e.path);
    // The same bytes as the base's: the file was only read (or moved aside by a diversion of the tab's)
    if (e.was && existsSync(join(base, 'chunks', `${e.was.chunk}.gz`)) && baseChunk(e.was.chunk).subarray(e.was.off, e.was.off + e.size).equals(data)) { same++; continue; }
    mkdirSync(dirname(abs), { recursive: true });
    rmSync(abs, { recursive: true, force: true });
    writeFileSync(abs, data);
    chmodSync(abs, e.mode);
    utimesSync(abs, clamp(e.mtime), clamp(e.mtime));
    files++; bytes += data.length;
  }
}
for (const p of changed.removed.filter((p) => !SKIP.test(p))) rmSync(join(root, p), { recursive: true, force: true });
for (const [abs, mode, mtime] of dirs.reverse()) { chmodSync(abs, mode); utimesSync(abs, mtime, mtime); }
await browser.close();
console.log(`copied out ${files} files, ${(bytes / 1e6).toFixed(1)} MB (${same} base files were only read)`);

// The builder's own clean-up of what a tab's apt leaves and a chroot build's does not
for (const p of ['var/cache/debconf/config.dat-old', 'var/cache/debconf/templates.dat-old', 'var/lib/dpkg/status-old', 'var/lib/dpkg/diversions-old']) rmSync(join(root, p), { force: true });

const spec = join(work, `${key}.json`);
writeFileSync(spec, JSON.stringify({ layers: { [key]: { title: names.names.join(', '), description: 'Debian packages', packages: names.names } } }));
mkdirSync(out, { recursive: true });
const recipe = createHash('sha256').update(`captured ${rootfs.id} ${names.names.join(' ')}`).digest('hex').slice(0, 16);
execFileSync('node', [join(REPO, 'scripts/debian/pack-layer.mjs'), baseDir, root, out, '--id', key, '--spec', spec, '--base-id', rootfs.id, '--snapshot', rootfs.snapshot, '--recipe', recipe],
  { stdio: 'inherit', env: { ...process.env, SOURCE_DATE_EPOCH: String(EPOCH) } });
console.log(`layer ${key} for ${names.names.join(' ')} is in ${out}`);
