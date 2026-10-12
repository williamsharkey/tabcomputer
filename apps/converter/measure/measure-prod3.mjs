// node apps/converter/measure/measure-prod3.mjs [URL]   (after measure-prod.mjs: same profile)
// Part 3, behaviour rather than speed: a reload with the app in a Preview window, a 360 px phone
// viewport, offline, and app mode (become) with its reload.
import { pw, EXE, OUT, boot, sh, putApp, until, walk } from './lib.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const URL0 = process.argv[2] || 'https://tabcomputer.com/';
const out = { url: URL0, at: new Date().toISOString() };
const log = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); writeFileSync(join(OUT, 'measure3.json'), JSON.stringify(out, null, 2)); };
const ctx = await pw.chromium.launchPersistentContext(join(OUT, 'profile-prod'), { executablePath: EXE, headless: true, args: ['--no-sandbox'], viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
const SEL = '.sd-preview iframe[data-virtual-port="4780"]';
const BSEL = '#become-container iframe';
const frame = async (sel = SEL) => (await page.$(sel))?.contentFrame();
const ready = (sel = SEL, ms = 20000) => until(page, async () => (await frame(sel))?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1').catch(() => false), ms, 50);
const portUp = () => page.evaluate(() => window.__iframeServer.isPortInUse(4780));
const samples = walk(join(OUT, 'stage2')).filter((n) => !/^n\d\d-/.test(n)).map((n) => join(OUT, 'stage2', n));
const convert = async (f, files, ms = 60000) => {
  await f.click('#reset').catch(() => {});
  await f.setInputFiles('#pick', files);
  return until(page, () => f.evaluate((n) => { const s = window.__converter; return s.rows.length >= n && s.rows.every((r) => r.status === 'done' || r.status === 'failed') ? s.rows.map((r) => `${r.status}${r.result?.error ? ': ' + r.result.error : ''}`) : null; }, files.length).catch(() => null), ms, 100);
};
const windows = () => page.evaluate(() => (window.__shiroDesktop?.visibleOrder?.() ?? []).map((w) => `${w.appId}:${w.state}:${w.title}`));

log('deployed', (await (await fetch(new URL('/deployed.txt', URL0))).text()).trim());
await boot(page, URL0);
await putApp(page);

// ── a reload with the app in a Preview window, backend started from the Terminal as a person would ──
await page.click('.sd-win .xterm, #terminal');
await page.keyboard.type('cd ~/apps/converter && node server.js 4780 &\n', { delay: 5 });
await until(page, portUp, 20000);
await page.keyboard.type('serve open 4780\n', { delay: 5 });
log('previewTyped', { ready: !!await ready(), windows: await windows() });
let f = await frame();
log('previewConverted', await convert(f, samples.slice(0, 3)));
await page.waitForTimeout(5000); // the session is saved every 3 s
let t0 = Date.now();
await boot(page, URL0);
await page.waitForTimeout(8000); // session restore runs after the first prompt
log('previewAfterReload', { ms: Date.now() - t0, portUp: await portUp(), windows: await windows(), stoppedNotice: !!await page.$('.sd-preview-stopped'), frameReady: !!await ready(SEL, 3000), terminalTail: await page.evaluate(() => { const t = window.__tabcomputer.terminal?.term; if (!t) return ''; const b = t.buffer.active; const lines = []; for (let i = Math.max(0, b.length - 12); i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? ''); return lines.filter(Boolean).slice(-6).join(' | '); }) });
await page.screenshot({ path: join(OUT, 'prod-preview-after-reload.png') });

// ── phone ──
await page.setViewportSize({ width: 360, height: 740 });
await boot(page, URL0);
if (!await portUp()) { await sh(page, 'cd /home/user/apps/converter && node server.js 4780', false); await until(page, portUp, 20000); }
await sh(page, 'serve open 4780');
await ready();
f = await frame();
const rows = await convert(f, samples.slice(0, 2));
log('phone', { rows, app: await f.evaluate(() => ({ w: innerWidth, h: innerHeight, scrollW: document.documentElement.scrollWidth })), page: await page.evaluate(() => ({ w: innerWidth, scrollW: document.documentElement.scrollWidth })), windows: await windows() });
await page.screenshot({ path: join(OUT, 'prod-phone-preview.png') });
await page.setViewportSize({ width: 1440, height: 900 });

// ── offline ──
await boot(page, URL0);
await sh(page, 'cd /home/user/apps/converter && node server.js 4780', false); await until(page, portUp, 20000);
await sh(page, 'serve open 4780'); await ready(); f = await frame();
await ctx.setOffline(true);
t0 = Date.now();
log('offlineConvert', { rows: await convert(f, samples.slice(0, 6)), ms: Date.now() - t0 });
const dl = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
await f.click('#zip').catch(() => {});
log('offlineZip', !!(await dl));
// a program never run in this profile: its bytes are still on the server
const never = await Promise.race([sh(page, 'mdb-json 2>&1 | head -2; echo rc=$?'), new Promise((r) => setTimeout(() => r({ timeout: true }), 20000))]);
log('offlineNeverUsedProgram', never);
t0 = Date.now();
const reloaded = await page.goto(URL0, { waitUntil: 'commit', timeout: 20000 }).then(() => page.waitForFunction(() => !!window.__tabcomputer?.shell, null, { timeout: 20000 })).then(() => 'booted', (e) => `no: ${String(e.message).split('\n')[0]}`);
log('offlineReload', { result: reloaded, ms: Date.now() - t0 });
await ctx.setOffline(false);

// ── app mode on the deployed build ──
await boot(page, URL0);
await sh(page, 'cd /home/user/apps/converter && node server.js 4780', false); await until(page, portUp, 20000);
t0 = Date.now();
const became = await sh(page, 'cd /home/user/apps/converter && become 4780 converter');
const bReady = !!await ready(BSEL);
f = await frame(BSEL);
log('become', { out: became.out.trim(), ready: bReady, ms: Date.now() - t0, address: page.url(), frameUrl: f?.url(), title: await page.title() });
if (bReady) {
  log('becomeConverted', await convert(f, samples.slice(0, 3)));
  const dl2 = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
  await f.click('#zip').catch(() => {});
  const d2 = await dl2;
  let magic = null;
  if (d2) { const p = join(OUT, 'prod-become.zip'); await d2.saveAs(p); magic = readFileSync(p).subarray(0, 2).toString(); }
  log('becomeZip', { downloaded: !!d2, magic });
  await page.screenshot({ path: join(OUT, 'prod-become.png') });
}
t0 = Date.now();
await page.reload({ waitUntil: 'commit' });
await page.waitForFunction(() => !!window.__tabcomputer?.shell, null, { timeout: 60000 });
const again = !!await ready(BSEL, 15000);
f = await frame(BSEL);
log('becomeAfterReload', { ms: Date.now() - t0, appReady: again, address: page.url(), frameText: (await f?.evaluate(() => document.body.innerText.slice(0, 160)).catch(() => null)), servers: (await sh(page, 'serve list')).out.trim() });
await page.screenshot({ path: join(OUT, 'prod-become-after-reload.png') });
await page.goto(new URL('/?unbecome', URL0).toString());
await page.waitForFunction(() => !!window.__tabcomputer?.shell, null, { timeout: 60000 });
log('unbecome', await page.evaluate(() => !localStorage.getItem('tabcomputer-become')));
await ctx.close();
console.log('DONE');
