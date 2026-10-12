// apps/converter, the user-space app, and the hardwired Converter window, in Chromium.
// The plumbing only: Debian's converter programs are stood in for by shell scripts,
// so this runs against a local server with no Debian and no relay.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/app-converter.mjs [URL] [--shots DIR]
//
//   preview   node server.js + serve open: the page talks to its backend; picked and dropped
//             files arrive byte for byte; failures are listed; a result opens in the page;
//             "Download all" is a real zip on the real disk; a reloaded page shows the batch
//   become    become PORT SLUG --start CMD: the same page full-tab, bytes both ways; a
//             reload of the tab brings the backend and the page back
//   phone     360 px wide: nothing scrolls sideways
//   hardwired desktop open converter: the same conversion with no server in between
//
// PLAYWRIGHT=/path/to/playwright-core and CHROMIUM=/path/to/chrome pick the tools.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let pw;
for (const name of [process.env.PLAYWRIGHT, 'playwright', '/opt/node-tools/node_modules/playwright', 'playwright-core'].filter(Boolean)) {
  try { pw = require(name); break; } catch { /* next */ }
}
if (!pw) { console.error('playwright not found (set PLAYWRIGHT)'); process.exit(2); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });
const APP = join(dirname(fileURLToPath(import.meta.url)), '../../apps/converter');
const PORT = 4780;
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

// Stand-ins for libwpd-tools, libmspub-tools, libwps-tools, libmwaw-tools and mdbtools
const STUBS = {
  wpd2html: '#!/bin/sh\necho "<html><body><h1>stub wpd2html</h1><p>$(wc -c < "$1") bytes</p></body></html>"\n',
  pub2xhtml: '#!/bin/sh\ncase "$1" in *broken*) echo "ERROR: Unsupported file format!" >&2; exit 1;; esac\necho "<html><body><h1>stub pub2xhtml</h1></body></html>"\n',
  wps2html: '#!/bin/sh\necho "<html><body><h1>stub wps2html</h1></body></html>"\n',
  wks2csv: '#!/bin/sh\necho "a,b,c"\necho "1,2,3"\n',
  mwaw2html: '#!/bin/sh\necho "<html><body><h1>stub mwaw2html</h1></body></html>"\n',
  mwaw2csv: '#!/bin/sh\necho "a,b"\n',
  'mdb-tables': '#!/bin/sh\necho People\necho Orders\n',
  'mdb-export': '#!/bin/sh\necho "id,name"\necho "1,$2"\n',
  'mdb-schema': '#!/bin/sh\necho "CREATE TABLE People (id int);"\n',
};
const walk = (dir, base = dir, out = []) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, base, out); else out.push(p.slice(base.length + 1)); } return out; };
const appFiles = walk(APP).map((rel) => ({ rel, b64: readFileSync(join(APP, rel)).toString('base64') }));
const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) & 255));
const file = (name, n) => ({ name, mimeType: 'application/octet-stream', buffer: pattern(n) });

const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

async function newTab(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  return page;
}
const booted = (page) => page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished') && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
const side = (page, cmd, wait = true) => page.evaluate(async ([cmd, wait]) => {
  const s = window.__tabcomputer.shell.fork(); s.terminal = null; let o = '';
  const p = s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  if (!wait) return { code: 0, o: '' };
  return { code: await p, o };
}, [cmd, wait]);
const until = async (page, fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(100); } };

/** The app's files and the stand-in converters into the tab, then its backend */
async function install(page) {
  await page.evaluate(async ([files, stubs]) => {
    const fs = window.__tabcomputer.fs;
    const put = async (p, bytes) => { await fs.mkdir(p.replace(/\/[^/]+$/, ''), { recursive: true }); await fs.writeFile(p, bytes); };
    for (const f of files) await put(`/home/user/apps/converter/${f.rel}`, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
    for (const [name, text] of Object.entries(stubs)) await put(`/usr/local/bin/${name}`, text);
  }, [appFiles, STUBS]);
  await side(page, `cd /home/user/apps/converter && node server.js ${PORT}`, false);
  return until(page, () => page.evaluate((p) => window.__iframeServer.isPortInUse(p), PORT));
}
const frame = async (page, sel) => (await page.$(sel))?.contentFrame() ?? null;
const ready = (page, sel, ms) => until(page, async () => (await frame(page, sel))?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1' && !!window.__converter), ms);
const settled = (page, f, n, ms = 30_000) => until(page, () => f.evaluate((n) => {
  const s = window.__converter;
  return s.rows.length >= n && s.rows.every((r) => r.status === 'done' || r.status === 'failed') ? s.rows.map((r) => ({ rel: r.rel, status: r.status, error: r.result?.error ?? '' })) : null;
}, n), ms);
const tabBytes = (page, name, n) => page.evaluate(async ([name, n]) => {
  const fs = window.__tabcomputer.fs;
  for (const job of await fs.readdir('/tmp/converter').catch(() => [])) {
    const u = await fs.readFile(`/tmp/converter/${job}/in/${name}`).catch(() => null);
    if (!u) continue;
    let ok = u.length === n;
    for (let i = 0; i < u.length && ok; i++) if (u[i] !== ((i * 7) & 255)) ok = false;
    return ok ? 'same' : `differs (${u.length} bytes)`;
  }
  return 'missing';
}, [name, n]);
async function zipOf(page, f) {
  const got = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
  await f.click('#zip');
  const d = await got;
  if (!d) return null;
  const bytes = readFileSync(await d.path());
  const names = [];
  // central directory entries: PK\x01\x02, name length at +28, name at +46
  for (let i = 0; i + 46 < bytes.length; i++) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2) names.push(bytes.subarray(i + 46, i + 46 + bytes.readUInt16LE(i + 28)).toString());
  return { name: d.suggestedFilename(), magic: bytes.subarray(0, 2).toString(), names };
}

// ── preview ──
{
  const page = await newTab({ width: 1440, height: 900 });
  await page.goto(url);
  await booted(page);
  check('the backend listens', await install(page));
  const opened = await side(page, `serve open ${PORT}`);
  const SEL = `.sd-preview iframe[data-virtual-port="${PORT}"]`;
  check('serve open: the page reaches its backend', opened.code === 0 && await ready(page, SEL));
  let f = await frame(page, SEL);
  check('the page is a real document', /\/__preview\/\w+\/4780\/$/.test(f.url()), f.url());

  await f.setInputFiles('#pick', [file('letter.wpd', 3000), file('newsletter.pub', 70_000), file('broken.pub', 10), file('ledger.wk1', 500), file('club.mdb', 200_000), file('notes.txt', 5)]);
  const rows = await settled(page, f, 6);
  const by = Object.fromEntries((rows || []).map((r) => [r.rel, r]));
  check('picked files convert', ['letter.wpd', 'newsletter.pub', 'ledger.wk1', 'club.mdb'].every((n) => by[n]?.status === 'done'), JSON.stringify(rows));
  check('a converter error is reported with its message', by['broken.pub']?.status === 'failed' && /Unsupported file format/.test(by['broken.pub'].error), by['broken.pub']?.error);
  check('an unknown kind of file is refused', by['notes.txt']?.status === 'failed' && /not a format/.test(by['notes.txt'].error));
  check('the failed list names both', await f.evaluate(() => !document.getElementById('failed').hidden && document.querySelectorAll('#failed-list li').length === 2));
  check('bytes arrive unchanged (70 KB, 200 KB)', await tabBytes(page, 'newsletter.pub', 70_000) === 'same' && await tabBytes(page, 'club.mdb', 200_000) === 'same');
  const tree = (await side(page, 'cd /home/user/Converted/* && find . -type f | sort')).o.trim().split(/\r?\n/);
  check('the results folder', ['./letter.html', './newsletter.html', './ledger.html', './club/People.html', './club/Orders.html', './club/schema.sql'].every((n) => tree.includes(n)), tree.join(' '));

  // a drop (no folder entries on a synthetic DataTransfer: its files)
  await f.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(1234)], 'dropped.wps'));
    document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const after = await settled(page, f, 7);
  check('a dropped file converts', after?.find((r) => r.rel === 'dropped.wps')?.status === 'done');

  await f.click('#list li.ok .link');
  check('a result opens in the page', await until(page, () => f.evaluate(() => !document.getElementById('viewer').hidden && /stub wpd2html/.test(document.querySelector('#viewer-body iframe')?.srcdoc ?? ''))));
  await f.click('#viewer-close');

  const zip = await zipOf(page, f);
  check('Download all: a zip on the real disk', zip?.magic === 'PK' && /^converted-.*\.zip$/.test(zip.name) && zip.names.includes('letter.html') && zip.names.includes('club/People.html'), JSON.stringify(zip));
  if (shots) await page.screenshot({ path: join(shots, 'converter-preview.png') });

  // the window's Reload: the page comes back showing the batch
  await page.click('.sd-preview [data-act=reload]');
  await ready(page, SEL);
  f = await frame(page, SEL);
  check('a reloaded page lists the results folder', await until(page, () => f.evaluate(() => window.__converter.marks.restored >= 6)), String(await f.evaluate(() => window.__converter.marks.restored)));

  // ── become ──
  const became = await side(page, `cd /home/user/apps/converter && become ${PORT} converter --start node server.js ${PORT}`);
  const BSEL = '#become-container iframe';
  check('become: the page full-tab, a real document', became.code === 0 && await ready(page, BSEL) && /\/__preview\//.test((await frame(page, BSEL)).url()) && new URL(page.url()).pathname === '/converter', became.o.trim());
  f = await frame(page, BSEL);
  await f.click('#reset');
  await f.setInputFiles('#pick', [file('second.wpd', 4000), file('big.pub', 70_000)]);
  check('become: files convert', (await settled(page, f, 2))?.every((r) => r.status === 'done'));
  check('become: bytes arrive unchanged', await tabBytes(page, 'big.pub', 70_000) === 'same');
  const zip2 = await zipOf(page, f);
  check('become: Download all', zip2?.magic === 'PK' && zip2.names.includes('second.html'), JSON.stringify(zip2));

  // a reload of the tab: the backend is a node process, gone with the page
  const t0 = Date.now();
  await page.reload();
  const back = await ready(page, BSEL, 60_000);
  check('become: a reload brings back the backend and the page', !!back, `${Date.now() - t0} ms`);
  f = await frame(page, BSEL);
  check('become: the reloaded page lists the batch', !!f && await until(page, () => f.evaluate(() => window.__converter.marks.restored >= 2)));
  if (shots) await page.screenshot({ path: join(shots, 'converter-become.png') });
  await page.context().close();
}

// ── phone ──
{
  const page = await newTab({ width: 360, height: 740 });
  await page.goto(url);
  await booted(page);
  await install(page);
  await side(page, `cd /home/user/apps/converter && become ${PORT} converter --start node server.js ${PORT}`);
  const BSEL = '#become-container iframe';
  await ready(page, BSEL);
  const f = await frame(page, BSEL);
  await f.setInputFiles('#pick', [file('a-rather-long-file-name-from-the-church-newsletter-archive-2009.pub', 2000), file('broken.pub', 10)]);
  await settled(page, f, 2);
  const m = await f.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth, btn: Math.min(...[...document.querySelectorAll('.btn')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height)) }));
  check('360 px: nothing scrolls sideways, buttons are finger sized', m.sw <= m.w && m.btn >= 36, JSON.stringify(m));
  if (shots) await page.screenshot({ path: join(shots, 'converter-phone.png') });
  await page.goto(new URL('/?unbecome', url).toString());
  await booted(page);
  check('?unbecome leaves app mode', await page.evaluate(() => !localStorage.getItem('tabcomputer-become') && !document.body.classList.contains('become-active')));
  await page.context().close();
}

// ── hardwired ──
{
  const page = await newTab({ width: 1440, height: 900 });
  await page.goto(url);
  await booted(page);
  await page.evaluate(async (stubs) => {
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/usr/local/bin', { recursive: true });
    for (const [name, text] of Object.entries(stubs)) await fs.writeFile(`/usr/local/bin/${name}`, text);
  }, STUBS);
  const opened = await side(page, 'desktop open converter');
  const input = await until(page, () => page.$('.sd-win .sd-conv-drop'));
  check('desktop open converter: a window', opened.code === 0 && !!input, opened.o.trim());
  await page.setInputFiles('.sd-win input[type=file]', [file('letter.wpd', 3000), file('broken.pub', 10)]);
  const rows = await until(page, () => page.evaluate(() => { const r = globalThis.__converterHW?.rows; return r?.length === 2 && r.every((x) => x.status === 'done' || x.status === 'failed') ? r.map((x) => `${x.name}:${x.status}:${x.error ?? ''}`) : null; }));
  check('hardwired: converts, and reports a failure', /letter\.wpd:done/.test(rows?.[0] ?? '') && /broken\.pub:failed:.*Unsupported/.test(rows?.[1] ?? ''), JSON.stringify(rows));
  check('hardwired: the result is in the results folder', /stub wpd2html/.test((await side(page, 'cat /home/user/Converted/*/letter.html')).o));
  if (shots) await page.screenshot({ path: join(shots, 'converter-hardwired.png') });
  await page.context().close();
}

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
