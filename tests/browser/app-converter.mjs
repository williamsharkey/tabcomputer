// apps/converter, the Converter app on the app toolkit (docs/APPS.md), in Chromium.
// The plumbing only: Debian's converter programs are stood in for by shell scripts and
// the `rescue` toolchain set is marked installed, so this runs against a local server
// with no Debian and no relay.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/app-converter.mjs [URL] [--shots DIR]
//
//   window    app install + app open: a window of its own on its own origin; picked and
//             dropped files arrive byte for byte; failures are listed; a result opens in the
//             page; "Download all" is a real zip on the real disk; reopened, it shows the batch
//   become    app open converter --become: the same page full-tab; a reload of the tab
//             brings it back with the batch
//   site      ?app=converter: the copy this site ships installs without a prompt
//   phone     360 px wide: nothing scrolls sideways
//
// PLAYWRIGHT=/path/to/playwright-core and CHROMIUM=/path/to/chrome pick the tools.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

// Stand-ins for libwpd-tools, libmspub-tools, libwps-tools, libmwaw-tools and mdbtools.
// pub2xhtml's says the sha256 of what it was given: the dropped bytes arrived whole or they did not.
const STUBS = {
  wpd2html: '#!/bin/sh\necho "<html><body><h1>stub wpd2html</h1><p>$(wc -c < "$1") bytes</p></body></html>"\n',
  pub2xhtml: '#!/bin/sh\ncase "$1" in *broken*) echo "ERROR: Unsupported file format!" >&2; exit 1;; esac\necho "<html><body><h1>stub pub2xhtml</h1><p id=sum>$(sha256sum < "$1")</p></body></html>"\n',
  wps2html: '#!/bin/sh\necho "<html><body><h1>stub wps2html</h1></body></html>"\n',
  wks2csv: '#!/bin/sh\necho "a,b,c"\necho "1,2,3"\n',
  mwaw2html: '#!/bin/sh\necho "<html><body><h1>stub mwaw2html</h1></body></html>"\n',
  mwaw2csv: '#!/bin/sh\necho "a,b"\n', // optional in the app; here so both paths run
  'mdb-tables': '#!/bin/sh\necho People\necho Orders\n',
  'mdb-export': '#!/bin/sh\necho "id,name"\necho "1,$2"\n',
  'mdb-schema': '#!/bin/sh\necho "CREATE TABLE People (id int);"\n',
};
const walk = (dir, base = dir, out = []) => { for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p, base, out); else out.push(p.slice(base.length + 1)); } return out; };
// The app as a build ships it: its manifest and its page (not what measures it)
const appFiles = walk(APP).filter((rel) => rel === 'app.json' || rel.startsWith('public/')).map((rel) => ({ rel, b64: readFileSync(join(APP, rel)).toString('base64') }));
const pattern = (n) => Buffer.from(Array.from({ length: n }, (_, i) => (i * 7) & 255));
const file = (name, n) => ({ name, mimeType: 'application/octet-stream', buffer: pattern(n) });
const sha = (n) => createHash('sha256').update(pattern(n)).digest('hex');

const browser = await pw.chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

async function newTab(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.addInitScript(() => { try { if (window.top === window) localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  return page;
}
const booted = (page) => page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished') && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
const side = (page, cmd, wait = true) => page.evaluate(async ([cmd, wait]) => {
  const s = window.__tabcomputer.shell.fork(); s.terminal = null; let o = '';
  const p = s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  if (!wait) return { code: 0, o: '' };
  return { code: await p, o: o.replace(/\r\n/g, '\n') };
}, [cmd, wait]);
const until = async (page, fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(100); } };

/** The stand-in converters into the tab, and the toolchain set marked as there */
async function stubs(page) {
  await page.evaluate(async (stubs) => {
    const fs = window.__tabcomputer.fs;
    const put = async (p, bytes) => { await fs.mkdir(p.replace(/\/[^/]+$/, ''), { recursive: true }); await fs.writeFile(p, bytes); };
    for (const [name, text] of Object.entries(stubs)) await put(`/usr/local/bin/${name}`, text);
    await put('/home/user/.local/share/apps/converter/.toolchains', 'rescue\n');
  }, STUBS);
}
/** The app's folder into the tab, then `app install` */
async function install(page) {
  await stubs(page);
  await page.evaluate(async (files) => {
    const fs = window.__tabcomputer.fs;
    for (const f of files) {
      const p = `/home/user/src/converter/${f.rel}`;
      await fs.mkdir(p.replace(/\/[^/]+$/, ''), { recursive: true });
      await fs.writeFile(p, Uint8Array.from(atob(f.b64), (c) => c.charCodeAt(0)));
    }
  }, appFiles);
  return side(page, 'app install /home/user/src/converter');
}
const WIN = '.sd-win .tc-app iframe[data-app="converter"]';
const BSEL = '#become-container iframe[data-app="converter"]';
/** The app's page: the frame inside the frame of its own origin */
async function inner(page, sel) {
  const outer = await (await page.$(sel))?.contentFrame();
  if (!outer) return null;
  return /\/__tabcomputer\/frame\.html/.test(outer.url()) ? outer.childFrames()[0] ?? null : outer;
}
const ready = (page, sel, ms = 30_000) => until(page, async () => { const f = await inner(page, sel); return (await f?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1' && !!window.__converter)) ? f : null; }, ms);
const settled = (page, f, n, ms = 30_000) => until(page, () => f.evaluate((n) => {
  const s = window.__converter;
  return s.rows.length >= n && s.rows.every((r) => r.status === 'done' || r.status === 'failed') ? s.rows.map((r) => ({ rel: r.rel, status: r.status, error: r.result?.error ?? '' })) : null;
}, n), ms);
/** A real click by its place on the screen (see app-toolkit.mjs) */
async function clickIn(page, sel, f, target) {
  const frame = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y }; }, sel);
  const el = await f.evaluate((target) => { const e = document.querySelector(target); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, target);
  await page.mouse.click(frame.x + el.x, frame.y + el.y);
}
async function zipOf(page, sel, f) {
  const got = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
  await clickIn(page, sel, f, '#zip');
  const d = await got;
  if (!d) return null;
  const bytes = readFileSync(await d.path());
  const names = [];
  // central directory entries: PK\x01\x02, name length at +28, name at +46
  for (let i = 0; i + 46 < bytes.length; i++) if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 1 && bytes[i + 3] === 2) names.push(bytes.subarray(i + 46, i + 46 + bytes.readUInt16LE(i + 28)).toString());
  return { name: d.suggestedFilename(), magic: bytes.subarray(0, 2).toString(), names };
}

// ── window ──
{
  const page = await newTab({ width: 1440, height: 900 });
  await page.goto(url);
  await booted(page);
  const inst = await install(page);
  check('app install: the converter is in ~/Apps and in the dock', inst.code === 0 && /Installed Converter \(converter\)/.test(inst.o) && await page.evaluate(() => !!document.querySelector('.sd-dock-item[data-app="converter"]')), inst.o.trim().split('\n')[0]);
  const t0 = Date.now();
  const opened = await side(page, 'app open converter');
  let f = await ready(page, WIN);
  check('app open: its own window, the page ready', opened.code === 0 && !!f, `${Date.now() - t0} ms`);
  check('the page is on an origin of its own, with no server behind it', !!f && /^http:\/\/app--converter--[0-9a-f]{16}\./.test(f.url()) && /converter +Converter +open /.test((await side(page, 'app list')).o), f?.url());
  check('the window has the app\'s name and size, and no preview toolbar', await page.evaluate(() => {
    const w = window.__tabcomputer.desktop.windows().find((x) => x.appId === 'converter');
    const g = w.geometry();
    return w.title === 'Converter' && g.width === 620 && g.height === 640 && !w.element.querySelector('.sd-toolbar');
  }));

  await f.setInputFiles('#pick', [file('letter.wpd', 3000), file('newsletter.pub', 70_000), file('broken.pub', 10), file('ledger.wk1', 500), file('club.mdb', 200_000), file('notes.txt', 5)]);
  const rows = await settled(page, f, 6);
  const by = Object.fromEntries((rows || []).map((r) => [r.rel, r]));
  check('picked files convert', ['letter.wpd', 'newsletter.pub', 'ledger.wk1', 'club.mdb'].every((n) => by[n]?.status === 'done'), JSON.stringify(rows));
  check('a converter error is reported with its message', by['broken.pub']?.status === 'failed' && /Unsupported file format/.test(by['broken.pub'].error), by['broken.pub']?.error);
  check('an unknown kind of file is refused', by['notes.txt']?.status === 'failed' && /not a format/.test(by['notes.txt'].error));
  check('the failed list names both', await f.evaluate(() => !document.getElementById('failed').hidden && document.querySelectorAll('#failed-list li').length === 2));
  const sums = (await side(page, 'cat /home/user/Converted/*/newsletter.html /home/user/Converted/*/letter.html')).o;
  check('bytes arrive unchanged (3 KB, 70 KB)', sums.includes(sha(70_000)) && /<p>3000 bytes<\/p>/.test(sums), sums.slice(0, 160));
  const tree = (await side(page, 'cd /home/user/Converted/* && find . -type f | sort')).o.trim().split(/\r?\n/);
  check('the results folder', ['./letter.html', './newsletter.html', './ledger.html', './club/People.html', './club/Orders.html', './club/schema.sql'].every((n) => tree.includes(n)), tree.join(' '));
  check('the dropped originals are not kept once converted', await until(page, async () => !(await side(page, 'find /home/user/.local/share/apps/converter/in -type f 2>/dev/null')).o.trim()));
  check('the window\'s title follows the batch and returns', await until(page, () => page.evaluate(() => window.__tabcomputer.desktop.windows().find((x) => x.appId === 'converter').title === 'Converter')));

  // a drop (no folder entries on a synthetic DataTransfer: its files)
  await f.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(1234)], 'dropped.wps'));
    document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  const after = await settled(page, f, 7);
  check('a dropped file converts', after?.find((r) => r.rel === 'dropped.wps')?.status === 'done');

  await clickIn(page, WIN, f, '#list li.ok .link');
  check('a result opens in the page', await until(page, () => f.evaluate(() => !document.getElementById('viewer').hidden && /stub wpd2html/.test(document.querySelector('#viewer-body iframe')?.srcdoc ?? ''))));
  await clickIn(page, WIN, f, '#viewer-close');

  const zip = await zipOf(page, WIN, f);
  check('Download all: a zip on the real disk', zip?.magic === 'PK' && /^converted-.*\.zip$/.test(zip.name) && zip.names.includes('letter.html') && zip.names.includes('club/People.html'), JSON.stringify(zip));
  if (shots) await page.screenshot({ path: join(shots, 'converter-window.png') });

  // closed and opened again: the page comes back showing the batch
  await side(page, 'app stop converter');
  check('app stop closes its window', await page.evaluate(() => !window.__tabcomputer.desktop.windows().some((x) => x.appId === 'converter')));
  await side(page, 'app open converter');
  f = await ready(page, WIN);
  check('opened again, it lists the results folder', !!f && await until(page, () => f.evaluate(() => window.__converter.marks.restored >= 6)), String(await f?.evaluate(() => window.__converter.marks.restored)));

  // a reload of the tab: the session brings the window back
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.reload();
  await booted(page);
  f = await ready(page, WIN, 60_000);
  check('a reload of the tab restores the window and the batch', !!f && await until(page, () => f.evaluate(() => window.__converter.marks.restored >= 6)));

  // ── become ──
  const became = await side(page, 'app open converter --become');
  f = await ready(page, BSEL);
  check('app open --become: the page full-tab, at /converter', became.code === 0 && !!f && new URL(page.url()).pathname === '/converter', became.o.trim());
  await clickIn(page, BSEL, f, '#reset');
  await f.setInputFiles('#pick', [file('second.wpd', 4000), file('big.pub', 70_000), file('twin.wks', 300), file('twin.wdb', 300)]);
  check('become: files convert', (await settled(page, f, 4))?.every((r) => r.status === 'done'));
  check('become: bytes arrive unchanged', (await side(page, 'cat /home/user/Converted/*/big.html')).o.includes(sha(70_000)));
  const zip2 = await zipOf(page, BSEL, f);
  check('become: Download all', zip2?.magic === 'PK' && zip2.names.includes('second.html'), JSON.stringify(zip2));
  check('two inputs with one name keep both results', zip2?.names.includes('twin.html') && zip2.names.includes('twin.wdb.html'));

  const t1 = Date.now();
  await page.reload();
  f = await ready(page, BSEL, 60_000);
  check('become: a reload brings the page back', !!f, `${Date.now() - t1} ms`);
  check('become: the reloaded page lists the batch', !!f && await until(page, () => f.evaluate(() => window.__converter.marks.restored >= 4)));
  if (shots) await page.screenshot({ path: join(shots, 'converter-become.png') });
  await page.context().close();
}

// ── site: the copy a build ships ──
{
  const page = await newTab({ width: 1440, height: 900 });
  await page.goto(url);
  await booted(page);
  await stubs(page);
  await page.goto(new URL('/?app=converter', url).toString());
  await booted(page);
  const f = await ready(page, WIN, 40_000);
  check('?app=converter: the site\'s copy installs without a prompt and opens', !!f && !await page.$('.tc-app-prompt') && / site$/m.test((await side(page, 'app list')).o) && !/app=/.test(page.url()));
  if (f) {
    await f.setInputFiles('#pick', [file('letter.wpd', 3000)]);
    check('the site\'s copy converts', (await settled(page, f, 1))?.[0]?.status === 'done');
  }
  await page.context().close();
}

// ── phone ──
{
  const page = await newTab({ width: 360, height: 740 });
  await page.goto(url);
  await booted(page);
  await install(page);
  await side(page, 'app open converter --become');
  const f = await ready(page, BSEL);
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

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
