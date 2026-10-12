#!/usr/bin/env node
// The two caches GIMP builds on its first start, as GIMP itself writes them in
// the tab, for scripts/gui/overlays/ (docs/GUI_LAUNCH.md "GIMP's first start"):
//
// - gimp-pluginrc, its plug-in registry (~/.config/GIMP/2.10/pluginrc). GIMP
//   asks every plug-in what it provides the first time it sees it, each one a
//   process: 106 of them. The registry names each plug-in by path (as
//   ${gimp_plug_in_dir}/...) with its file's modification time, and GIMP asks
//   again when the time differs. The installer writes files with their
//   package's times (src/gui/apps.ts unpack), so the times here are the
//   .deb's, the same in every tab.
// - gimp-babl-fishes, babl's conversion cache (~/.cache/babl/babl-fishes),
//   written when GIMP exits: which chain of conversions to use between pixel
//   formats, found by trying them. Its first line names babl's version, and
//   babl ignores a cache with another.
//
// Both ship as overlays written only when the user has no such file. Run this
// again when the manifest's gimp or babl packages change: a plug-in whose time
// no longer matches is asked again, and another babl ignores the cache, so
// stale files cost time, not correctness.
//
//   npx vite build && PORT=5391 STATIC_DIR=$PWD/dist node server.mjs &
//   node scripts/gui/make-gimp-caches.mjs http://localhost:5391/ [OUT_DIR]
//   python3 scripts/gui/gen-apps.py ...        # registers them in public/gui/apps.json
//
// PLAYWRIGHT=/path/to/playwright-core and CHROMIUM=/path/to/chrome pick the tools.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let pw;
for (const name of [process.env.PLAYWRIGHT, 'playwright', '/opt/node-tools/node_modules/playwright', 'playwright-core'].filter(Boolean)) {
  try { pw = require(name); break; } catch { /* next */ }
}
if (!pw) { console.error('playwright not found (set PLAYWRIGHT)'); process.exit(2); }
const url = process.argv[2] ?? 'http://localhost:5299/';
const out = process.argv[3] ?? join(dirname(fileURLToPath(import.meta.url)), 'overlays');
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 90_000 });
await page.waitForFunction(() => window.__tabcomputer.desktop.apps().some((a) => a.id === 'gimp'), null, { timeout: 30_000 });
// (without the shipped caches: this run is what makes them)
await page.evaluate(() => {
  window.__guiNoKeptOverlays = true;
  void window.__tabcomputer.desktop.openApp('gimp');
});
const t0 = Date.now();
await page.waitForFunction(() => window.__tabcomputer.desktop.windows().some((w) => w.appId === 'gimp' && w.surface && w.title.includes('GNU Image Manipulation Program')), null, { timeout: 900_000, polling: 500 });
const startMs = Date.now() - t0;
await page.waitForTimeout(5000);
// a clean quit: babl writes its cache as GIMP exits
await page.evaluate(() => { for (const w of window.__tabcomputer.desktop.windows()) if (w.appId === 'gimp' && !w.options.transientFor) w.close(); });
await page.waitForFunction(() => ![...window.__tabcomputer.kernel.procs.values()].some((p) => /gimp|script-fu/.test(p.comm ?? '')), null, { timeout: 120_000, polling: 200 });
await page.waitForTimeout(1000);
const r = await page.evaluate(async () => {
  const fs = window.__tabcomputer.fs;
  const text = await fs.readFile('/home/user/.config/GIMP/2.10/pluginrc', 'utf8');
  const fishes = await fs.readFile('/home/user/.cache/babl/babl-fishes', 'utf8').catch(() => '');
  // every plug-in's time in the registry is its file's
  const wrong = [];
  let n = 0;
  for (const m of text.matchAll(/\(plug-in-def "([^"]+)" (\d+)/g)) {
    n++;
    // (GIMP writes its own directories as variables, so the registry holds no machine's paths)
    const st = await fs.stat(m[1].replace('${gimp_plug_in_dir}', '/usr/lib/gimp/2.0')).catch(() => null);
    const mtime = st ? Math.floor(st.mtime.getTime() / 1000) : -1;
    if (mtime !== Number(m[2])) wrong.push(`${m[1]}: registry ${m[2]}, file ${mtime}`);
  }
  return { text, fishes, n, wrong };
});
await browser.close();
if (!r.n || r.wrong.length) { console.error(`pluginrc: ${r.n} plug-ins, ${r.wrong.length} with another time than their file:\n${r.wrong.slice(0, 5).join('\n')}`); process.exit(1); }
// the times must be the packages' (years old), not this run's
const newest = Math.max(...[...r.text.matchAll(/\(plug-in-def "[^"]+" (\d+)/g)].map((m) => Number(m[1])));
if (newest * 1000 > t0 - 86_400_000) { console.error(`pluginrc: a plug-in's time is this run's (${new Date(newest * 1000).toISOString()}): the installer didn't keep the packages' times`); process.exit(1); }
if (/\/home\/|\/tmp\//.test(r.text) || /\/home\/|\/tmp\//.test(r.fishes)) { console.error('a cache names a path under /home or /tmp: not one to ship'); process.exit(1); }
if (!/^#BABL_\S+ BABL_PATH_LENGTH=\d+ BABL_TOLERANCE=/.test(r.fishes)) { console.error(`babl-fishes: no cache was written, or not one this script knows (${JSON.stringify(r.fishes.slice(0, 80))})`); process.exit(1); }
writeFileSync(join(out, 'gimp-pluginrc'), r.text);
writeFileSync(join(out, 'gimp-babl-fishes'), r.fishes);
console.log(`${out}/gimp-pluginrc: ${r.text.length} bytes, ${r.n} plug-ins, newest file ${new Date(newest * 1000).toISOString()}`);
console.log(`${out}/gimp-babl-fishes: ${r.fishes.length} bytes, ${r.fishes.split('\n')[0]}`);
console.log(`(GIMP's main window came after ${Math.round(startMs / 1000)} s without them)`);
