// Package layers in the real app (docs/DEBIAN.md "Package layers"): a one-file
// app that needs a Debian package, from its link to a finished job, and
// `apt install` at the prompt. The layer is a real one for tesseract-ocr.
//
//   npm run build
//   node tests/browser/package-layers.mjs --layers DIR [--dist DIR] [--only NAME] [--limit MS] [--shots DIR]
//
// DIR is a TABCOMPUTER_DEBIAN_LAYERS directory whose sets/ has the layer of
// tesseract-ocr for this build's Debian base: from scripts/debian/build-set.sh
// on a Linux host, or from tests/browser/capture-layer.mjs where there is none.
// The script starts server.mjs itself, once per case, each on a port of its own:
//
//   ready      the server has the layer. `?app=searchable-pdf` in a fresh
//              profile: the page is usable within --limit (default 10000 ms),
//              a scanned page becomes a PDF with a text layer, the first job
//              is not slower than the second by more than a few seconds, apt
//              never runs, and the placeholder says so in sentences. Then
//              again as over a 50 Mbit/s line with 40 ms of latency (what a
//              visitor has).
//   prompt     `apt install -y tree tesseract-ocr` typed before Debian mode
//              (#136): tree comes from tabcomputer's own packages,
//              tesseract-ocr from Debian by itself, in seconds; then a second
//              set in Debian mode when DIR has genisoimage's layer.
//   build      the server has no layer yet and builds it (a stand-in builder
//              that reports as the real one does and then puts the real layer
//              in place): the placeholder shows the server's progress,
//              "package N of M", and the app opens when the build ends.
//   fallback   the server has no layer and no builder: one sentence says so,
//              apt installs in the tab, and the app works. This is the time a
//              layer replaces; it takes over a minute. Needs deb.debian.org.
//
// The text tesseract reads from the page is printed, not judged: what the
// program computes is the emulator's business. When `ready` and `fallback`
// both run, the layer's tesseract and apt's must print the same text.
//
// Prints the times. Exits 1 if a check fails.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromiumPath, loadPlaywright } from './_browser.mjs';

const { chromium } = loadPlaywright();
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i < 0 ? dflt : args.splice(i, 2)[1]; };
const layers = opt('--layers', '');
const dist = resolve(opt('--dist', join(ROOT, 'dist')));
const only = opt('--only', '');
const LIMIT = Number(opt('--limit', '10000'));
const shots = opt('--shots', '');
const PORT0 = Number(opt('--port', '6480'));
if (!layers || !existsSync(join(layers, 'sets'))) { console.error('usage: package-layers.mjs --layers DIR   (DIR/sets holds the layer of tesseract-ocr)'); process.exit(2); }
if (shots) mkdirSync(shots, { recursive: true });
const APP = 'searchable-pdf';
const results = [];
const times = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const time = (name, ms) => { times.push([name, Math.round(ms)]); console.log(`     ${name}: ${(ms / 1000).toFixed(1)} s`); };
const wants = (name) => !only || only === name;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** server.mjs on its own port with `env`; resolves to { url, stop } */
async function serve(port, env) {
  const p = spawn('node', [join(ROOT, 'server.mjs')], { env: { ...process.env, PORT: String(port), STATIC_DIR: dist, TABCOMPUTER_LAYER_BUILDER: '0', ...env }, stdio: ['ignore', 'ignore', 'inherit'] });
  const url = `http://localhost:${port}/`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url + 'health')).ok) break; } catch { /* not up yet */ }
    await sleep(100);
  }
  return { url, stop: () => new Promise((done) => { p.on('exit', done); p.kill(); }) };
}

const browser = await chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
async function newTab({ slow = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  const asked = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/debian/')) asked.push(u.pathname + u.search); });
  await page.addInitScript(() => { try { if (window.top === window) localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  if (slow) {
    // 50 Mbit/s down, 10 up, 40 ms: a home line to a server in another city
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 40, downloadThroughput: 50e6 / 8, uploadThroughput: 10e6 / 8 });
  }
  return { page, asked };
}
const booted = (page) => page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished') && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
const side = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__plShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  let o = '';
  const t0 = performance.now();
  const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  return { code, o: o.replace(/\r\n/g, '\n'), ms: Math.round(performance.now() - t0) };
}, cmd);
const until = async (page, fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(50); } };
const FRAME = `iframe[data-app="${APP}"]`;
async function inner(page) {
  const outer = await (await page.$(FRAME))?.contentFrame();
  if (!outer) return null;
  return /\/__tabcomputer\/frame\.html/.test(outer.url()) ? outer.childFrames()[0] ?? null : outer;
}
const ready = (page, ms) => until(page, async () => { const f = await inner(page); return (await f?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1')) ? f : null; }, ms);
async function clickIn(page, f, sel) {
  const frame = await page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x, y: r.y }; }, FRAME);
  const el = await f.evaluate((s) => { const e = document.querySelector(s); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, sel);
  await page.mouse.click(frame.x + el.x, frame.y + el.y);
}
/** The sentences the launch placeholder shows, in order, each once (collected in the page from before it loads) */
const watchStages = (page) => page.addInitScript((app) => {
  if (window.top !== window) return;
  window.__stages = [];
  setInterval(() => {
    const t = document.querySelector(`.sd-launch-win[data-launch="${app}"] .sd-launch-stage`)?.textContent?.trim();
    if (t && window.__stages.at(-1) !== t) window.__stages.push(t);
  }, 50);
}, APP);
const stagesOf = (page) => page.evaluate(() => window.__stages ?? []);

/** A scanned page: black text on white, as a PNG */
const WORDS = ['tabcomputer makes scans searchable', 'The quick brown fox jumps over the lazy dog', 'Package layers install in seconds', 'Invoice 20417 total 1380 dollars'];
const scan = (page) => page.evaluate((words) => {
  const c = document.createElement('canvas');
  c.width = 1240; c.height = 1754; // A4 at 150 dots an inch
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = '#000'; g.font = '34px Helvetica, Arial, sans-serif';
  for (let i = 0; i < 30; i++) g.fillText(words[i % words.length], 110, 160 + i * 52);
  return c.toDataURL('image/png').split(',')[1];
}, WORDS);

/** From the app's link to a finished OCR of one page. Returns what happened. */
async function linkToOcr(url, name, { slow = false, usableWithin = 60_000 } = {}) {
  const { page, asked } = await newTab({ slow });
  await watchStages(page);
  const t0 = Date.now();
  await page.goto(`${url}?app=${APP}`);
  const f = await ready(page, usableWithin);
  const usable = Date.now() - t0;
  if (!f) {
    check(`${name}: the app opens`, false, `not usable after ${(usable / 1000).toFixed(0)} s; the placeholder said: ${(await stagesOf(page)).join(' | ')}`);
    if (shots) await page.screenshot({ path: join(shots, `${name}-stuck.png`) });
    return { page, asked, f: null };
  }
  time(`${name}: link to usable page`, usable);
  const png = Buffer.from(await scan(page), 'base64');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), clickIn(page, f, '#pick')]);
  const t1 = Date.now();
  await chooser.setFiles([{ name: 'page.png', mimeType: 'image/png', buffer: png }]);
  const row = await until(page, () => f.evaluate(() => { const r = window.__app.rows[0]; return r && !['waiting', 'working'].includes(r.status) ? { status: r.status, why: r.why, result: r.result } : null; }), 120_000);
  const ocr = Date.now() - t1;
  const total = Date.now() - t0;
  check(`${name}: a page of text becomes page.pdf`, row?.status === 'done' && row.result === 'page.pdf', JSON.stringify(row));
  time(`${name}: one page through tesseract`, ocr);
  time(`${name}: link to finished OCR of a page`, total);
  if (row?.status === 'done') {
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), clickIn(page, f, 'li.done button')]);
    const file = join(mkdtempSync(join(tmpdir(), 'tc-pl-')), 'page.pdf');
    await dl.saveAs(file);
    const pdf = readFileSync(file);
    // (tesseract's PDF: the scan as an image, and its text in an invisible font over it)
    check(`${name}: the PDF holds the page and its text`, pdf.subarray(0, 5).toString() === '%PDF-' && pdf.includes('GlyphLessFont') && pdf.length > 5000, `${pdf.length} bytes`);
  }
  if (shots) await page.screenshot({ path: join(shots, `${name}.png`) });
  return { page, asked, f, usable, ocr, total, stages: await stagesOf(page), png };
}
/** The same page once more through the open app: the job alone, with every file it needs here. Milliseconds. */
async function ocrAgain(page, f, png) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), clickIn(page, f, '#pick')]);
  const t0 = Date.now();
  await chooser.setFiles([{ name: 'again.png', mimeType: 'image/png', buffer: png }]);
  const row = await until(page, () => f.evaluate(() => { const r = window.__app.rows.find((x) => x.name === 'again.png'); return r && !['waiting', 'working'].includes(r.status) ? r.status : null; }), 120_000);
  return row === 'done' ? Date.now() - t0 : NaN;
}
/** What tesseract prints for the page, in a shell of the tab */
async function readText(page, png) {
  await page.evaluate(async (b64) => { await window.__tabcomputer.fs.writeFile('/tmp/page.png', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))); }, png.toString('base64'));
  return (await side(page, 'tesseract /tmp/page.png stdout 2>/dev/null')).o;
}
const texts = {};

// ── ready: the layer exists ──
if (wants('ready')) {
  const s = await serve(PORT0, { TABCOMPUTER_DEBIAN_LAYERS: layers });
  try {
    const r = await linkToOcr(s.url, 'ready');
    if (r.f) {
      check(`ready: under ${LIMIT / 1000} s from link to a usable page`, r.usable < LIMIT, `${(r.usable / 1000).toFixed(1)} s`);
      const again = await ocrAgain(r.page, r.f, r.png);
      time('ready: the same page a second time', again);
      check('ready: the first job waits at most 5 s longer than the second (its files are fetched as it starts)', r.ocr - again < 5000, `${((r.ocr - again) / 1000).toFixed(1)} s`);
      const mirror = r.asked.filter((p) => p.startsWith('/debian/mirror/'));
      check('ready: apt never ran (nothing was fetched from the package mirror)', mirror.length === 0, `${mirror.length} mirror requests`);
      const asks = r.asked.filter((p) => p.startsWith('/debian/layers/set?'));
      check('ready: the tab asked the server for the set once, by its names', asks.length === 1 && /packages=tesseract-ocr(&|$)/.test(asks[0]) && /base=[0-9a-f]+/.test(asks[0]), asks.join(' '));
      check('ready: the placeholder said what happened in sentences, and never "a few minutes"', r.stages.length > 0 && r.stages.every((t) => /[.…]$/.test(t)) && !r.stages.some((t) => /few minutes|apt/.test(t)), r.stages.join(' | '));
      // What the program read, as text (after the timing)
      texts.ready = await readText(r.page, r.png);
      const got = WORDS.filter((w) => texts.ready.replace(/\s+/g, ' ').includes(w)).length;
      console.log(`     ready: tesseract's text has ${got} of the page's ${WORDS.length} sentences; it starts: ${JSON.stringify(texts.ready.slice(0, 70))}`);
      const dpkg = await side(r.page, "dpkg-query -W -f='${Status}' tesseract-ocr");
      check('ready: dpkg has tesseract-ocr as installed', dpkg.o === 'install ok installed', dpkg.o);
      const chunks = r.asked.filter((p) => p.startsWith('/debian/layers/sets/chunks/')).length;
      console.log(`     ready: ${chunks} chunks of the layer fetched so far`);
      // A second visit: nothing to install
      const t0 = Date.now();
      await r.page.goto(`${s.url}?app=${APP}`);
      const second = await ready(r.page, 30_000);
      check('ready: a second visit opens the app with nothing to install', !!second);
      if (second) time('ready: link to usable page, second visit', Date.now() - t0);
    }
    await r.page.context().close();
    const slow = await linkToOcr(s.url, 'ready, 50 Mbit/s and 40 ms', { slow: true });
    if (slow.f) check(`ready, 50 Mbit/s and 40 ms: under ${LIMIT / 1000} s from link to a usable page`, slow.usable < LIMIT, `${(slow.usable / 1000).toFixed(1)} s`);
    await slow.page.context().close();
  } finally { await s.stop(); }
}

// ── prompt: apt install typed at the prompt ──
if (wants('prompt')) {
  const s = await serve(PORT0 + 1, { TABCOMPUTER_DEBIAN_LAYERS: layers });
  try {
    const { page, asked } = await newTab();
    await page.goto(s.url);
    await booted(page);
    const before = await side(page, 'debian status');
    check('prompt: Debian is not installed yet', /Debian is not installed/.test(before.o));
    const r = await side(page, 'apt install -y tree tesseract-ocr');
    time('prompt: apt install -y tree tesseract-ocr, before Debian mode', r.ms);
    check('prompt: one command installs both, and says where each came from (#136)',
      r.code === 0 && /^tree: from tabcomputer's own packages\.$/m.test(r.o) && /^tesseract-ocr: not in tabcomputer's own packages; installing from Debian \(Debian is set up first, once\)\.$/m.test(r.o)
      && /^tesseract-ocr: \d+ packages installed in \d+\.\d s \(\d+ paths; files load on first use\)\.$/m.test(r.o), r.o.trim().split('\n').slice(-4).join(' / '));
    check('prompt: it took seconds, and apt never ran', r.ms < LIMIT && !asked.some((p) => p.startsWith('/debian/mirror/')), `${(r.ms / 1000).toFixed(1)} s`);
    const v = await side(page, 'tesseract --version 2>&1 | head -1; tree --version | head -1');
    check('prompt: both programs run', /^tesseract \d/.test(v.o) && /tree v/.test(v.o), v.o.trim().replace(/\n/g, ' / '));
    time('prompt: first run of tesseract (its files are fetched now)', v.ms);
    // A second set, now in Debian mode, when the server has its layer (asked without starting anything)
    const has = await (await fetch(`${s.url}debian/layers/set?packages=genisoimage&build=0`)).json();
    if (has.state === 'ready') {
      const genisoimage = await side(page, 'apt install -y genisoimage');
      time('prompt: apt install -y genisoimage, in Debian mode', genisoimage.ms);
      const g = await side(page, 'genisoimage --version 2>&1 | head -1');
      check('prompt: a second set in Debian mode installs from its layer and runs', genisoimage.code === 0 && /packages? installed in /.test(genisoimage.o) && /genisoimage \d/.test(g.o), g.o.trim());
      const dpkg = await side(page, "dpkg-query -W -f='${Package} ${Status}\\n' genisoimage tesseract-ocr");
      check('prompt: dpkg has both sets', dpkg.o === 'genisoimage install ok installed\ntesseract-ocr install ok installed\n', dpkg.o.trim());
    } else console.log(`     prompt: no genisoimage layer in ${layers}; skipped`);
    await page.context().close();
  } finally { await s.stop(); }
}

// ── build: the first request ever for the set ──
if (wants('build')) {
  const empty = mkdtempSync(join(tmpdir(), 'tc-pl-layers-'));
  const s = await serve(PORT0 + 2, {
    TABCOMPUTER_DEBIAN_LAYERS: empty, TABCOMPUTER_LAYER_BUILDER: '1', TABCOMPUTER_LAYER_BUILDER_WORK: join(empty, 'work'),
    TABCOMPUTER_LAYER_BUILDER_CMD: JSON.stringify(['node', join(ROOT, 'tests/browser/package-layers-builder.mjs')]), FIXTURE: join(layers, 'sets'),
  });
  try {
    const r = await linkToOcr(s.url, 'build');
    if (r.f) {
      const st = r.stages;
      const at = (re) => st.findIndex((t) => re.test(t));
      const nums = st.map((t) => /installing package (\d+) of (\d+)/.exec(t)).filter(Boolean).map((m) => [Number(m[1]), Number(m[2])]);
      check('build: the placeholder shows the server downloading, installing package N of M, then packing',
        at(/^The server is downloading package \d+ of \d+ for tesseract-ocr\./) >= 0 && nums.length >= 3 && at(/^The server is packing tesseract-ocr\./) > at(/installing package/),
        `${st.length} sentences; ${st.filter((_, i) => i < 2 || i > st.length - 4).join(' | ')}`);
      check('build: N rises to M, and M is the number of packages', nums.every(([n, m], i) => m === nums[0][1] && n <= m && (i === 0 || n > nums[i - 1][0])) && nums.at(-1)[0] > nums[0][1] / 2, `${nums[0]?.join(' of ')} … ${nums.at(-1)?.join(' of ')}`);
      check('build: each sentence says the wait happens once; none says "a few minutes"', st.filter((t) => /^The server is /.test(t)).every((t) => /This build happens once: the next person gets these programs in seconds\.$/.test(t)) && !st.some((t) => /few minutes/.test(t)));
      check('build: apt never ran in the tab', !r.asked.some((p) => p.startsWith('/debian/mirror/')));
      await r.page.context().close();
      // The next person: the set is there
      const next = await linkToOcr(s.url, 'build, the next visitor');
      if (next.f) check('build, the next visitor: a usable page in seconds, with no build', next.usable < LIMIT && !next.stages.some((t) => /^The server is /.test(t)), `${(next.usable / 1000).toFixed(1)} s`);
      await next.page.context().close();
    } else await r.page.context().close();
  } finally { await s.stop(); }
}

// ── fallback: no layer and no builder ──
if (wants('fallback')) {
  const s = await serve(PORT0 + 3, {});
  try {
    const r = await linkToOcr(s.url, 'fallback (apt in the tab)', { usableWithin: 600_000 });
    if (r.f) {
      const said = 'No ready-made copy of tesseract-ocr (this server keeps none): apt installs it here, which takes a few minutes.';
      check('fallback: one sentence says why apt does it', r.stages.includes(said), r.stages.join(' | '));
      check('fallback: apt installed it in the tab', r.asked.some((p) => /\/debian\/mirror\/.*tesseract-ocr_/.test(p)), `${r.asked.filter((p) => p.startsWith('/debian/mirror/')).length} mirror requests`);
      time('fallback (apt in the tab): the same page a second time', await ocrAgain(r.page, r.f, r.png));
      texts.fallback = await readText(r.page, r.png);
      console.log(`     fallback: tesseract's text starts: ${JSON.stringify(texts.fallback.slice(0, 70))}`);
      if (texts.ready !== undefined) check("the layer's tesseract and apt's print the same text for the page", texts.ready === texts.fallback && texts.ready.length > 0, `${texts.ready.length} and ${texts.fallback.length} characters`);
    }
    await r.page.context().close();
  } finally { await s.stop(); }
}

await browser.close();
console.log('\nTimes:');
for (const [name, ms] of times) console.log(`  ${(ms / 1000).toFixed(1).padStart(6)} s  ${name}`);
const failed = results.filter((r) => !r).length;
console.log(failed ? `\n${failed} of ${results.length} checks failed` : `\n${results.length} checks passed`);
process.exit(failed ? 1 : 0);
