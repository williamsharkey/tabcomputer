// node apps/converter/measure/measure-local-toolkit.mjs [URL]
// The toolkit's Converter (apps/converter: tab.js, no server) beside the first design
// (legacy/: a node server in the tab) and the hardwired window (legacy/hardwired.ts), on one
// local build, in one tab. No Debian: every converter is the same stand-in shell script, so
// what differs between the columns is the plumbing around it, which is what is being measured.
//
//   start     a booted tab to an interactive app, three loads each
//   per file  20 documents (4.0 MB), one at a time, three rounds: a shell, hardwired, legacy, toolkit
//   50 files  11.8 MB at 1, 2 and 4 at a time: legacy, toolkit
//   reload    app mode, from the reload to an interactive page, six times
//
// Results: $APPMAKER_OUT/measure-local-toolkit.json (and results/ in the repository, copied by hand).
import { pw, EXE, OUT, boot, sh, putApp, putToolkitApp, appFrame, until, hardwiredBundle } from './lib.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
const URL0 = process.argv[2] || 'http://localhost:5299/';
const out = { url: URL0, at: new Date().toISOString(), converters: 'stand-in shell scripts (no Debian)' };
const save = () => writeFileSync(join(OUT, 'measure-local-toolkit.json'), JSON.stringify(out, null, 2));
const log = (k, v) => { out[k] = v; console.log(k, JSON.stringify(v)); save(); };
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
const range = (a) => `${Math.min(...a)}–${Math.max(...a)}`;

const STUB = '#!/bin/sh\necho "<html><body><h1>stand-in</h1><p>$(wc -c < "$1") bytes</p></body></html>"\n';
const TOOLS = ['wpd2html', 'pub2xhtml', 'wps2html', 'wks2csv', 'mwaw2html', 'mdb-tables', 'mdb-export', 'mdb-schema'];
const pattern = (n, seed) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7 + seed) & 255));
// 20 documents, 4.0 MB; 50 documents, 11.8 MB: the sizes of the study's sample sets
const set = (count, total, tag) => Array.from({ length: count }, (_, i) => {
  const size = Math.round((total / count) * (0.25 + 1.5 * ((i * 7) % count) / count));
  return { name: `${tag}-${String(i).padStart(2, '0')}.wpd`, mimeType: 'application/octet-stream', buffer: pattern(size, i) };
});
const DOCS = set(20, 4.0e6, 'doc');
const FIFTY = set(50, 11.8e6, 'batch');

const browser = await pw.chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message.slice(0, 200)));
await page.addInitScript(() => { try { if (window.top === window) localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });

const LEGACY_SEL = '.sd-preview iframe[data-virtual-port="4780"]';
const TOOLKIT_SEL = '.sd-win .tc-app iframe[data-app="converter"]';
const BECOME_SEL = '#become-container iframe[data-app="converter"]';
const legacyFrame = async () => (await page.$(LEGACY_SEL))?.contentFrame();
const isReady = (f) => f?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1').catch(() => false);
const rowsDone = (f, n, ms = 900000) => until(page, () => f.evaluate((n) => {
  const s = window.__converter;
  return s.rows.length >= n && s.rows.every((r) => r.status === 'done' || r.status === 'failed') ? s.rows.map((r) => ({ rel: r.rel, status: r.status, totalMs: r.totalMs, uploadMs: r.uploadMs })) : null;
}, n).catch(() => null), ms, 20);

await boot(page, URL0);
await page.evaluate(async ([stub, tools]) => {
  const fs = window.__tabcomputer.fs;
  await fs.mkdir('/usr/local/bin', { recursive: true });
  for (const t of tools) await fs.writeFile(`/usr/local/bin/${t}`, stub);
  await fs.mkdir('/home/user/.local/share/apps/converter', { recursive: true });
  await fs.writeFile('/home/user/.local/share/apps/converter/.toolchains', 'rescue\n');
}, [STUB, TOOLS]);
await putApp(page);
await putToolkitApp(page);
log('install', (await sh(page, 'app install /home/user/src/converter')).out.trim().split('\n')[0]);

// ── start: a booted tab to an interactive app ──
const startLegacy = async (query = '') => {
  const t = {};
  let t0 = Date.now();
  if (!await page.evaluate(() => window.__iframeServer.isPortInUse(4780))) {
    await sh(page, 'cd /home/user/apps/converter && node server.js 4780', false);
    await until(page, () => page.evaluate(() => window.__iframeServer.isPortInUse(4780)), 30000, 5);
    t.backendUpMs = Date.now() - t0;
  }
  t0 = Date.now();
  await sh(page, `serve open 4780 '/${query}'`);
  await until(page, async () => isReady(await legacyFrame()), 30000, 5);
  t.pageInteractiveMs = Date.now() - t0;
  return t;
};
const startToolkit = async () => {
  const t0 = Date.now();
  await sh(page, 'app open converter');
  await until(page, async () => isReady(await appFrame(page, TOOLKIT_SEL)), 30000, 5);
  return { pageInteractiveMs: Date.now() - t0 };
};
// (a tab that restores no windows: each start is the app's own)
const fresh = async () => { await page.evaluate(() => { localStorage.setItem('tabcomputer-restore-session', '0'); }); await boot(page, URL0); };
const starts = { legacy: [], toolkit: [] };
for (let i = 0; i < 4; i++) {
  await fresh();
  let t0 = Date.now();
  const l = await startLegacy('?c=1');
  starts.legacy.push({ ...l, totalMs: Date.now() - t0 });
  await fresh();
  t0 = Date.now();
  const k = await startToolkit();
  starts.toolkit.push({ ...k, totalMs: Date.now() - t0 });
}
// (the first load of each registers a service worker: reported apart)
log('appStart', {
  legacy: { first: starts.legacy[0], later: starts.legacy.slice(1) },
  toolkit: { first: starts.toolkit[0], later: starts.toolkit.slice(1) },
});

// ── per file: one at a time, three rounds, in one tab ──
await fresh();
await startLegacy('?c=1');
await startToolkit();
let lf = await legacyFrame();
let tf = await appFrame(page, TOOLKIT_SEL);
await page.evaluate(hardwiredBundle());
await page.evaluate(() => { globalThis.__hwConverter.open(globalThis.__shiroDesktopCtx); });
const hwInput = '.sd-win input[type=file]';
const runShell = async (files) => {
  await page.evaluate(async (files) => {
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/tmp/measure-shell/in', { recursive: true });
    await fs.mkdir('/tmp/measure-shell/out', { recursive: true });
    for (const f of files) await fs.writeFile(`/tmp/measure-shell/in/${f.name}`, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
  }, files.map((f) => ({ name: f.name, b64: f.buffer.toString('base64') })));
  const ms = [];
  for (const f of files) ms.push((await sh(page, `wpd2html '/tmp/measure-shell/in/${f.name}' > '/tmp/measure-shell/out/${f.name}.html'`)).ms);
  return ms;
};
const runHardwired = async (files) => {
  const before = await page.evaluate(() => globalThis.__converterHW.rows.length);
  await page.setInputFiles(hwInput, files);
  await until(page, () => page.evaluate((n) => { const r = globalThis.__converterHW.rows; return r.length >= n && r.every((x) => x.status === 'done' || x.status === 'failed'); }, before + files.length), 900000, 20);
  return page.evaluate((b) => globalThis.__converterHW.rows.slice(b).map((x) => x.totalMs), before);
};
const runPage = async (f, files, concurrency) => {
  await f.evaluate((c) => { document.getElementById('reset').click(); if (c) window.__converter.concurrency = c; }, concurrency);
  const t0 = Date.now();
  await f.setInputFiles('#pick', files);
  const rows = await rowsDone(f, files.length);
  return { wallMs: Date.now() - t0, rows: rows ?? [] };
};
const perFile = { shell: [], hardwired: [], legacy: [], toolkit: [] };
for (let round = 0; round < 3; round++) {
  const s = await runShell(DOCS);
  const h = await runHardwired(DOCS);
  const l = await runPage(lf, DOCS, 0);
  const k = await runPage(tf, DOCS, 1);
  perFile.shell.push({ medianMs: median(s), totalMs: s.reduce((a, b) => a + b, 0) });
  perFile.hardwired.push({ medianMs: median(h), totalMs: h.reduce((a, b) => a + b, 0) });
  perFile.legacy.push({ medianMs: median(l.rows.map((r) => r.totalMs)), uploadMedianMs: median(l.rows.map((r) => r.uploadMs)), wallMs: l.wallMs, ok: l.rows.filter((r) => r.status === 'done').length });
  perFile.toolkit.push({ medianMs: median(k.rows.map((r) => r.totalMs)), uploadMedianMs: median(k.rows.map((r) => r.uploadMs)), wallMs: k.wallMs, ok: k.rows.filter((r) => r.status === 'done').length });
  console.log('round', round, JSON.stringify({ shell: perFile.shell[round], hardwired: perFile.hardwired[round], legacy: perFile.legacy[round], toolkit: perFile.toolkit[round] }));
}
log('perFile20', perFile);
log('perFileSummary', Object.fromEntries(Object.entries(perFile).map(([k, v]) => [k, `median per file ${range(v.map((r) => r.medianMs))} ms`])));

// ── 50 files at 1, 2 and 4 at a time ──
const fifty = { legacy: {}, toolkit: {} };
for (const c of [1, 2, 4]) {
  await sh(page, `serve open 4780 '/?c=${c}'`);
  await until(page, async () => isReady(await legacyFrame()), 30000, 5);
  lf = await legacyFrame();
  const l = await runPage(lf, FIFTY, 0);
  fifty.legacy[c] = { wallMs: l.wallMs, medianMs: median(l.rows.map((r) => r.totalMs)), ok: l.rows.filter((r) => r.status === 'done').length };
  const k = await runPage(tf, FIFTY, c);
  fifty.toolkit[c] = { wallMs: k.wallMs, medianMs: median(k.rows.map((r) => r.totalMs)), ok: k.rows.filter((r) => r.status === 'done').length };
  console.log('fifty', c, JSON.stringify({ legacy: fifty.legacy[c], toolkit: fifty.toolkit[c] }));
}
log('fifty', fifty);
// the zip of the last 50 results, to the real disk
{
  const got = page.waitForEvent('download', { timeout: 30000 }).catch(() => null);
  const t0 = Date.now();
  await tf.evaluate(() => document.getElementById('zip').click());
  const d = await got;
  log('zip50', d ? { ms: Date.now() - t0, name: d.suggestedFilename() } : null);
}

// ── app mode: a reload to an interactive page ──
await sh(page, 'app open converter --become');
const becomeReady = () => until(page, async () => isReady(await appFrame(page, BECOME_SEL)), 30000, 5);
await becomeReady();
const reloads = [];
for (let i = 0; i < 6; i++) {
  const t0 = Date.now();
  await page.reload({ waitUntil: 'commit' });
  await page.waitForFunction(() => !!window.__tabcomputer?.shell, null, { timeout: 60000 });
  const shell = Date.now() - t0;
  await becomeReady();
  reloads.push({ shellMs: shell, appInteractiveMs: Date.now() - t0 });
}
log('becomeReload', { runs: reloads, medianMs: median(reloads.map((r) => r.appInteractiveMs)), rangeMs: range(reloads.map((r) => r.appInteractiveMs)) });
await browser.close();
