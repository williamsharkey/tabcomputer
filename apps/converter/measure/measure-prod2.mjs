// node apps/converter/measure/measure-prod2.mjs [URL]   (after measure-prod.mjs: same profile, converters installed)
// Part 2: second-visit start, per-file cost with one conversion at a time (user space, a shell, the
// hardwired window, in one session), then 50 files at 1, 2 and 4 at a time, and memory.
import { pw, EXE, OUT, boot, sh, putApp, until, walk, memMB, hardwiredBundle } from './lib.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const URL0 = process.argv[2] || 'https://tabcomputer.com/';
const out = { url: URL0, at: new Date().toISOString() };
const save = () => writeFileSync(join(OUT, 'measure2.json'), JSON.stringify(out, null, 2));
const log = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); save(); };
const ctx = await pw.chromium.launchPersistentContext(join(OUT, 'profile-prod'), { executablePath: EXE, headless: true, args: ['--no-sandbox'], viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));

// ── second visit: the tab, then the app ──
const boots = [];
for (let i = 0; i < 3; i++) boots.push(await boot(page, URL0));
log('bootSecondMs', boots);
log('deployed', (await (await fetch(new URL('/deployed.txt', URL0))).text()).trim());
const SEL = '.sd-preview iframe[data-virtual-port="4780"]';
const frame = async () => (await page.$(SEL))?.contentFrame();
const openApp = async (query = '') => {
  const t = {};
  let t0 = Date.now();
  if (!await page.evaluate(() => window.__iframeServer.isPortInUse(4780))) {
    await sh(page, 'cd /home/user/apps/converter && node server.js 4780', false);
    await until(page, () => page.evaluate(() => window.__iframeServer.isPortInUse(4780)), 30000, 10);
    t.backendUpMs = Date.now() - t0;
  }
  t0 = Date.now();
  await sh(page, `serve open 4780 '/${query}'`);
  await until(page, async () => (await frame())?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1').catch(() => false), 30000, 10);
  t.pageInteractiveMs = Date.now() - t0;
  return t;
};
await putApp(page);
const starts = [];
for (let i = 0; i < 3; i++) {
  if (i) await boot(page, URL0);
  const t0 = Date.now();
  const t = await openApp('?c=1');
  starts.push({ ...t, totalMs: Date.now() - t0 });
}
log('appStartSecondVisit', starts);
let f = await frame();
log('statusReady', await f.evaluate(() => ({ ready: window.__converter.status.ready, checkMs: window.__converter.status.checkMs })));
log('memStartMB', await memMB(page));

// ── the files ──
const SAMPLES = join(OUT, 'samples');
const STAGE = join(OUT, 'stage2'); rmSync(STAGE, { recursive: true, force: true }); mkdirSync(STAGE, { recursive: true });
const prev = JSON.parse(readFileSync(join(OUT, 'measure1.json'), 'utf8'));
const good = new Set(prev.batchWarmRows.filter((r) => r.status === 'done').map((r) => r.rel));
const docs = walk(SAMPLES).map((rel) => ({ rel, name: rel.replace(/\//g, '__') })).filter((s) => good.has(s.name) && /\.(wpd|wp|pub|wps|cwk)$/i.test(s.name));
for (const s of docs) { s.staged = join(STAGE, s.name); writeFileSync(s.staged, readFileSync(join(SAMPLES, s.rel))); }
log('docSet', { n: docs.length, bytes: docs.reduce((a, s) => a + readFileSync(s.staged).length, 0) });
const TOOL = { wpd: 'wpd2html', wp: 'wpd2html', pub: 'pub2xhtml', wps: 'wps2html', cwk: 'mwaw2html' };
const rowsDone = (n, ms = 900000) => until(page, () => f.evaluate((n) => { const s = window.__converter; return s.rows.length >= n && s.rows.every((r) => r.status === 'done' || r.status === 'failed') ? s.rows.map((r) => ({ rel: r.rel, status: r.status, totalMs: r.totalMs, uploadMs: r.uploadMs, serverMs: r.result?.ms, toolMs: r.result?.toolMs })) : null; }, n).catch(() => null), ms, 100);
const runUser = async (files) => {
  await f.click('#reset').catch(() => {});
  const t0 = Date.now();
  await f.setInputFiles('#pick', files);
  const rows = await rowsDone(files.length);
  return { wallMs: Date.now() - t0, done: rows?.filter((r) => r.status === 'done').length, rows };
};
const hwRows = () => page.evaluate(() => globalThis.__converterHW.rows.map((x) => ({ name: x.name, status: x.status, writeMs: x.writeMs, toolMs: x.toolMs, totalMs: x.totalMs })));
const runHW = async (files) => {
  const before = await page.evaluate(() => globalThis.__converterHW.rows.length);
  const t0 = Date.now();
  await page.setInputFiles('.sd-win input[type=file]:not(#pick)', files);
  await until(page, () => page.evaluate((n) => { const r = globalThis.__converterHW.rows; return r.length >= n && r.every((x) => x.status === 'done' || x.status === 'failed'); }, before + files.length), 900000, 100);
  const rows = (await hwRows()).slice(before);
  return { wallMs: Date.now() - t0, done: rows.filter((r) => r.status === 'done').length, rows };
};
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

// warm everything once, then three rounds of each, interleaved
await runUser(docs.map((s) => s.staged));
const job = await f.evaluate(() => window.__converter.job);
await page.evaluate(hardwiredBundle());
await page.evaluate(() => globalThis.__hwConverter.open(globalThis.__shiroDesktopCtx));
await page.waitForSelector('.sd-conv-drop');
const rounds = { user: [], shell: [], hardwired: [] };
for (let i = 0; i < 3; i++) {
  const d = [];
  const t0 = Date.now();
  for (const s of docs) d.push((await sh(page, `${TOOL[s.name.split('.').pop().toLowerCase()]} '/tmp/converter/${job}/in/${s.name}' > /tmp/direct.out`)).ms);
  rounds.shell.push({ wallMs: Date.now() - t0, sumMs: d.reduce((a, b) => a + b, 0), medianMs: med(d) });
  const u = await runUser(docs.map((s) => s.staged));
  rounds.user.push({ wallMs: u.wallMs, done: u.done, sumTotalMs: u.rows.reduce((a, r) => a + r.totalMs, 0), medianTotalMs: med(u.rows.map((r) => r.totalMs)), medianToolMs: med(u.rows.map((r) => r.toolMs)), medianUploadMs: med(u.rows.map((r) => r.uploadMs)), medianBridgeMs: med(u.rows.map((r) => r.totalMs - r.toolMs)) });
  const h = await runHW(docs.map((s) => s.staged));
  rounds.hardwired.push({ wallMs: h.wallMs, done: h.done, sumTotalMs: h.rows.reduce((a, r) => a + r.totalMs, 0), medianTotalMs: med(h.rows.map((r) => r.totalMs)), medianToolMs: med(h.rows.map((r) => r.toolMs)), medianWriteMs: med(h.rows.map((r) => r.writeMs)) });
  out.lastRoundRows = { user: u.rows, hardwired: h.rows, shell: d }; save();
}
log('oneAtATime', rounds);

// ── 50 files ──
const fifty = [];
for (let i = 0; i < 50; i++) { const s = docs[i % docs.length]; const p = join(STAGE, `n${String(i).padStart(2, '0')}-${s.name}`); writeFileSync(p, readFileSync(s.staged)); fifty.push(p); }
log('fiftyBytes', fifty.reduce((a, p) => a + readFileSync(p).length, 0));
const fiftyRuns = {};
for (const c of [1, 2, 4]) {
  await sh(page, `serve open 4780 '/?c=${c}'`);
  await until(page, async () => (await frame())?.evaluate((c) => document.documentElement.getAttribute('data-ready') === '1' && new URLSearchParams(location.search).get('c') === String(c), c).catch(() => false), 30000, 20);
  f = await frame();
  const before = await memMB(page);
  const u = await runUser(fifty);
  fiftyRuns[`user c=${c}`] = { wallMs: u.wallMs, done: u.done, medianTotalMs: med(u.rows.map((r) => r.totalMs)), maxTotalMs: Math.max(...u.rows.map((r) => r.totalMs)), memBeforeMB: before, memAfterMB: await memMB(page) };
  log('fifty', fiftyRuns);
}
{
  const before = await memMB(page);
  const h = await runHW(fifty);
  fiftyRuns.hardwired = { wallMs: h.wallMs, done: h.done, medianTotalMs: med(h.rows.map((r) => r.totalMs)), maxTotalMs: Math.max(...h.rows.map((r) => r.totalMs)), memBeforeMB: before, memAfterMB: await memMB(page) };
  log('fifty', fiftyRuns);
}
// the zip of 50 results, and the page's responsiveness while 50 convert (longest gap between timers)
const dl = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
let t0 = Date.now();
await f.click('#zip');
log('zipFifty', { downloaded: !!(await dl), wallMs: Date.now() - t0, marks: await f.evaluate(() => ({ zipMs: window.__converter.marks.zipMs, zipBytes: window.__converter.marks.zipBytes })) });
await page.evaluate(() => { globalThis.__gap = 0; let last = performance.now(); globalThis.__gapTimer = setInterval(() => { const n = performance.now(); globalThis.__gap = Math.max(globalThis.__gap, n - last); last = n; }, 10); });
await f.evaluate(() => { window.__gap = 0; let last = performance.now(); setInterval(() => { const n = performance.now(); window.__gap = Math.max(window.__gap, n - last); last = n; }, 10); });
const u = await runUser(fifty);
log('responsivenessFifty', { wallMs: u.wallMs, longestPageStallMs: Math.round(await page.evaluate(() => globalThis.__gap)), longestAppStallMs: Math.round(await f.evaluate(() => window.__gap)) });
log('memEndMB', await memMB(page));
log('storage', await page.evaluate(async () => { const e = await navigator.storage.estimate(); return { usedMB: Math.round(e.usage / 1e6) }; }));
await ctx.close();
console.log('DONE');
