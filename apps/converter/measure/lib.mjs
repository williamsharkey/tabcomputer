// Shared by the measurement scripts (docs/research/APP_MAKER.md has the numbers they produced).
//   PLAYWRIGHT=/path/to/playwright-core  CHROMIUM=/path/to/chrome  APPMAKER_OUT=/a/scratch/dir
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let found;
for (const name of [process.env.PLAYWRIGHT, 'playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) {
  try { found = require(name); break; } catch { /* next */ }
}
if (!found) throw new Error('playwright not found: set PLAYWRIGHT');
export const pw = found;
export const EXE = process.env.CHROMIUM || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const HERE = dirname(fileURLToPath(import.meta.url));
export const APP = join(HERE, '..');
export const REPO = join(HERE, '../../..');
export const OUT = process.env.APPMAKER_OUT || join(tmpdir(), 'appmaker');
mkdirSync(OUT, { recursive: true });

export async function boot(page, url, timeout = 180000) {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'commit' });
  await page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished') && !document.querySelector('.sd-booting'), null, { timeout });
  return Date.now() - t0;
}
/** One command line in a terminal-less fork of the tab's shell */
export const sh = (page, cmd, wait = true) => page.evaluate(async ([cmd, wait]) => {
  let out = '';
  const s = Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const t0 = performance.now();
  const p = s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  if (!wait) return { code: 0, out: '', ms: 0 };
  const code = await p;
  return { code, out: out.replace(/\r\n/g, '\n'), ms: Math.round(performance.now() - t0) };
}, [cmd, wait]);
export function walk(dir, base = dir, out = []) {
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push(p.slice(base.length + 1));
  }
  return out;
}
/** Copy the app (server.js, public/) into the tab's filesystem */
export async function putApp(page, tabDir = '/home/user/apps/converter') {
  const files = walk(APP).filter((rel) => rel === 'server.js' || rel === 'app.json' || rel === 'package.json' || rel.startsWith('public/')).map((rel) => ({ rel, b64: readFileSync(join(APP, rel)).toString('base64') }));
  await page.evaluate(async ([files, tabDir]) => {
    const fs = window.__tabcomputer.fs;
    for (const f of files) {
      const p = `${tabDir}/${f.rel}`;
      await fs.mkdir(p.replace(/\/[^/]+$/, ''), { recursive: true });
      await fs.writeFile(p, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
    }
  }, [files, tabDir]);
  return files.length;
}
export const until = async (page, fn, ms = 15000, step = 100) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(step); } };
/** Total memory of the page, its frames and workers, in MB (the page must be cross-origin isolated) */
export const memMB = (page) => page.evaluate(async () => { try { const m = await performance.measureUserAgentSpecificMemory(); return Math.round(m.bytes / 1e6); } catch (e) { return String(e); } });
/** The hardwired window's module (src/desktop/apps/converter.ts) as a script that defines __hwConverter */
export function hardwiredBundle() {
  const esbuild = require(join(REPO, 'node_modules/esbuild'));
  const r = esbuild.buildSync({ entryPoints: [join(REPO, 'src/desktop/apps/converter.ts')], bundle: true, format: 'iife', globalName: '__hwConverter', write: false });
  return r.outputFiles[0].text + '; globalThis.__hwConverter = __hwConverter;';
}
