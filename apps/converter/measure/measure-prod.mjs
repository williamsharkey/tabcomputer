// node apps/converter/measure/measure-prod.mjs [URL]   (samples first: fetch-samples.mjs)
// Production measurement, part 1: cold boot, install the app, first-use setup, a batch of real files,
// the same commands directly in the shell, a warm batch, the hardwired window. Persistent profile.
import { pw, EXE, OUT, boot, sh, putApp, until, walk, memMB, hardwiredBundle } from './lib.mjs';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const SP = OUT;
const PROFILE = join(SP, 'profile-prod');
const URL0 = process.argv[2] || 'https://tabcomputer.com/';
const out = { url: URL0, at: new Date().toISOString() };
const save = () => writeFileSync(join(SP, 'measure1.json'), JSON.stringify(out, null, 2));
rmSync(PROFILE, { recursive: true, force: true });
const ctx = await pw.chromium.launchPersistentContext(PROFILE, { executablePath: EXE, headless: true, args: ['--no-sandbox'], viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = ctx.pages()[0] || await ctx.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
const mem = () => memMB(page);
const log = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); save(); };

log('bootFirstMs', await boot(page, URL0));
log('build', (await sh(page, 'cat /etc/tabcomputer-release 2>/dev/null; uname -a')).out.trim());
log('isolated', await page.evaluate(() => crossOriginIsolated));
log('memBootMB', await mem());

// ── install the app's files, start its backend, open it ──
let t0 = Date.now();
await putApp(page);
log('copyAppMs', Date.now() - t0);
t0 = Date.now();
await sh(page, 'cd /home/user/apps/converter && node server.js 4780', false);
await until(page, () => page.evaluate(() => window.__iframeServer.isPortInUse(4780)), 30000, 20);
log('backendUpMs', Date.now() - t0);
t0 = Date.now();
await sh(page, 'serve open 4780');
const SEL = '.sd-preview iframe[data-virtual-port="4780"]';
const frame = async () => (await page.$(SEL))?.contentFrame();
await until(page, async () => (await frame())?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1'), 30000, 20);
log('pageInteractiveMs', Date.now() - t0);
let f = await frame();
log('pageMarks', await f.evaluate(() => window.__converter.marks));
log('statusBefore', await f.evaluate(() => ({ ready: window.__converter.status.ready, outputs: window.__converter.status.outputs, checkMs: window.__converter.status.checkMs })));
// bridge latency: a ping through the service worker, and a direct call into the same handler
log('pingMs', await f.evaluate(async () => { const a = []; for (let i = 0; i < 30; i++) { const t = performance.now(); await (await fetch('/api/ping')).json(); a.push(performance.now() - t); } a.sort((x, y) => x - y); return { median: +a[15].toFixed(1), p90: +a[27].toFixed(1), min: +a[0].toFixed(1) }; }));
log('pingDirectMs', await page.evaluate(async () => { const a = []; for (let i = 0; i < 30; i++) { const t = performance.now(); await window.__iframeServer.fetch(4780, '/api/ping'); a.push(performance.now() - t); } a.sort((x, y) => x - y); return { median: +a[15].toFixed(1), p90: +a[27].toFixed(1) }; }));

// ── the samples ──
const SAMPLES = join(SP, 'samples');
const all = walk(SAMPLES).filter((r) => !/bug129090|nwind/.test(r)).map((rel) => ({ rel, path: join(SAMPLES, rel), name: rel.replace(/\//g, '__') }));
// flat names (setInputFiles gives no folders): copy under unique names
const STAGE = join(SP, 'stage'); rmSync(STAGE, { recursive: true, force: true }); mkdirSync(STAGE, { recursive: true });
for (const s of all) { s.staged = join(STAGE, s.name); writeFileSync(s.staged, readFileSync(s.path)); }
log('sampleCount', all.length);

// first drop: one file, which triggers setup
t0 = Date.now();
const first = all.find((s) => /testWordPerfect\.wpd$/.test(s.name));
await f.setInputFiles('#pick', [first.staged]);
const rowsDone = (n, ms) => until(page, () => f.evaluate((n) => { const s = window.__converter; return s.rows.length >= n && s.rows.every((r) => r.status === 'done' || r.status === 'failed') ? s.rows.map((r) => ({ rel: r.rel, status: r.status, totalMs: r.totalMs, uploadMs: r.uploadMs, serverMs: r.result?.ms, toolMs: r.result?.toolMs, error: r.result?.error, outs: r.result?.outputs })) : null; }, n).catch(() => null), ms, 250);
const r1 = await rowsDone(1, 900000);
log('firstUse', { dropToFirstConvertedMs: Date.now() - t0, rows: r1, marks: await f.evaluate(() => window.__converter.marks) });
log('setupLogTail', (await f.evaluate(() => document.getElementById('setup-log').textContent)).split('\n').slice(-25).join('\n'));
log('statusAfter', await f.evaluate(() => ({ ready: window.__converter.status.ready, outputs: window.__converter.status.outputs })));
log('memAfterSetupMB', await mem());
if (!r1 || r1[0].status !== 'done') { console.log('setup failed; stopping'); await ctx.close(); process.exit(1); }

// ── batch 1: every sample (cold: each program's first run) ──
await f.click('#reset');
t0 = Date.now();
await f.setInputFiles('#pick', all.map((s) => s.staged));
const b1 = await rowsDone(all.length, 900000);
log('batchCold', { wallMs: Date.now() - t0, n: all.length, done: b1?.filter((r) => r.status === 'done').length, failed: b1?.filter((r) => r.status === 'failed').map((r) => `${r.rel}: ${r.error}`), marks: await f.evaluate(() => window.__converter.marks) });
out.batchColdRows = b1; save();
const job1 = await f.evaluate(() => window.__converter.job);

// ── the same commands directly in a shell fork (warm) ──
const TOOL = { wpd: 'wpd2html', wp: 'wpd2html', pub: 'pub2xhtml', wps: 'wps2html', wks: 'wks2csv', wk1: 'wks2csv', wk3: 'wks2csv', wk4: 'wks2csv', 123: 'wks2csv', wq1: 'wks2csv', wq2: 'wks2csv', wdb: 'wdb2csv', cwk: 'mwaw2html', mdb: 'mdb-tables -1' };
const direct = [];
for (const s of all) {
  const ext = s.name.split('.').pop().toLowerCase();
  const r = await sh(page, `${TOOL[ext]} '/tmp/converter/${job1}/in/${s.name}' > /tmp/direct.out; echo "exit=$?"`);
  direct.push({ rel: s.name, ms: r.ms, exit: /exit=(\d+)/.exec(r.out)?.[1] });
}
out.direct = direct; save();
log('directTotalMs', direct.reduce((a, d) => a + d.ms, 0));
log('shellNoopMs', (await sh(page, 'true')).ms);
log('shellEchoMs', await (async () => { const a = []; for (let i = 0; i < 10; i++) a.push((await sh(page, 'echo hi > /tmp/x')).ms); return a.sort((x, y) => x - y)[5]; })());

// ── batch 2: warm ──
await f.click('#reset');
t0 = Date.now();
await f.setInputFiles('#pick', all.map((s) => s.staged));
const b2 = await rowsDone(all.length, 900000);
log('batchWarm', { wallMs: Date.now() - t0, done: b2?.filter((r) => r.status === 'done').length, marks: await f.evaluate(() => window.__converter.marks) });
out.batchWarmRows = b2; save();

// ── zip to the real disk ──
const dl = page.waitForEvent('download', { timeout: 60000 }).catch(() => null);
t0 = Date.now();
await f.click('#zip');
const d = await dl;
if (d) { await d.saveAs(join(SP, 'prod-converted.zip')); }
log('zip', { downloaded: !!d, wallMs: Date.now() - t0, marks: await f.evaluate(() => ({ zipMs: window.__converter.marks.zipMs, zipBytes: window.__converter.marks.zipBytes })) });
log('memAfterBatchesMB', await mem());

// ── results to the host, for the quality check ──
const job2 = await f.evaluate(() => window.__converter.job);
const files = await page.evaluate(async (job) => {
  const fs = window.__tabcomputer.fs; const outp = [];
  const rec = async (d) => { for (const n of await fs.readdir(d)) { const p = `${d}/${n}`; const st = await fs.stat(p); if (st.isDirectory()) await rec(p); else { const u = await fs.readFile(p); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); outp.push({ p: p.slice(`/home/user/Converted/${job}/`.length), b64: btoa(s) }); } } };
  await rec(`/home/user/Converted/${job}`); return outp;
}, job2);
for (const x of files) { const p = join(SP, 'results', x.p); mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, Buffer.from(x.b64, 'base64')); }
log('resultsSaved', files.length);

// ── hardwired: the built-in app's path, same files (warm) ──
await page.evaluate(hardwiredBundle());
t0 = Date.now();
await page.evaluate(() => { const t = performance.now(); globalThis.__hwConverter.open(globalThis.__shiroDesktopCtx); globalThis.__hwOpenMs = performance.now() - t; });
await page.waitForSelector('.sd-conv-drop');
log('hwOpen', { wallMs: Date.now() - t0, openMs: await page.evaluate(() => +globalThis.__hwOpenMs.toFixed(1)) });
const hwSet = all.filter((s) => /\.(wpd|pub|wps|cwk)$/i.test(s.name));
t0 = Date.now();
await page.setInputFiles('.sd-conv-drop ~ * input[type=file], .sd-win input[type=file]', hwSet.map((s) => s.staged));
const hw = await until(page, () => page.evaluate((n) => { const r = globalThis.__converterHW.rows; return r.length >= n && r.every((x) => x.status === 'done' || x.status === 'failed') ? { rows: r.map((x) => ({ name: x.name, status: x.status, writeMs: x.writeMs, toolMs: x.toolMs, totalMs: x.totalMs, error: x.error })), marks: globalThis.__converterHW.marks } : null; }, hwSet.length), 900000, 250);
log('hardwired', { wallMs: Date.now() - t0, n: hwSet.length, marks: hw?.marks });
out.hardwiredRows = hw?.rows; save();
// csv ones in the hardwired window
await page.selectOption('.sd-win select', 'csv');
const csvSet = all.filter((s) => /\.(wks|wk1|wk4)$/i.test(s.name));
await page.setInputFiles('.sd-win input[type=file]', csvSet.map((s) => s.staged));
const hw2 = await until(page, () => page.evaluate((n) => { const r = globalThis.__converterHW.rows; return r.length >= n && r.every((x) => x.status === 'done' || x.status === 'failed') ? r.slice(-4).map((x) => ({ name: x.name, status: x.status, writeMs: x.writeMs, toolMs: x.toolMs, totalMs: x.totalMs })) : null; }, hwSet.length + csvSet.length), 300000, 250);
out.hardwiredCsvRows = hw2; save();
log('memEndMB', await mem());
await page.screenshot({ path: join(SP, 'prod-end.png') });
await ctx.close();
console.log('DONE');
