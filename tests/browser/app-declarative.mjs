// Apps that are their manifest (docs/APPS.md "The manifest alone") in Chromium, against a
// local server with no Debian: every command used is built in, and GitHub is stood in for.
//
//   npx vite build && PORT=6641 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/app-declarative.mjs [URL] [--shots DIR] [--only NAME[,NAME]] [--theme light|dark]
//
// Each kind at 1280 px and at a 390 x 844 touch screen:
//   files   app new → install → open; three files, two with one name and one the program
//           refuses; each result alone and all as a zip; a folder's structure; by keyboard only
//   form    Run, output as it is written, Stop; a live form (the jq playground example)
//   table   add, edit, sort, filter, total; a reload finds the data; another program's
//           change shows; CSV and SQLite
//   progress  a real program (gawk, from this server's own packages) whose result is its standard
//           output: what it says on stderr shows while it runs
//   links   ?app= on the phone is the app, with no Welcome card and a way to the desktop;
//           the key row shows only for a terminal; a gist with one app.json, asked first
//   share   the length of each example's link
// and 360 px: no page scrolls sideways. Times are printed for each kind.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';

const pw = loadPlaywright();
const ROOT = resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const only = opt('--only')?.split(',');
// The desktop's appearance for the whole run: dark (the default) or light
const theme = opt('--theme') === 'light' ? 'light' : 'dark';
const url = args[0] || 'http://localhost:6641/';
if (shots) mkdirSync(shots, { recursive: true });
const results = [];
const times = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const time = (name, ms) => { times.push([name, Math.round(ms)]); };
const wants = (name) => !only || only.includes(name);
const example = (id) => readFileSync(join(ROOT, 'apps/examples', id, 'app.json'), 'utf8');

// A browser that has run one part's checks is big, and a machine with little memory ends it: each part
// (each screen of each kind) gets a browser of its own.
const launch = async () => {
  const b = await pw.chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
  b.on('disconnected', () => { if (b === browser && !closing) console.log('the browser went away'); });
  return b;
};
let closing = false;
let browser = await launch();
const relaunch = async () => { closing = true; await browser.close().catch(() => {}); closing = false; browser = await launch(); };
const WIDE = { name: '1280', viewport: { width: 1280, height: 800 } };
const PHONE = { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

// ── a stand-in for GitHub: one gist holding one file ──
const GIST = 'abcdef0123456789abcdef0123456789';
const REV = 'beef'.padEnd(40, '1');
const GIST_APP = '{\n  "name": "Upper case",\n  "about": "Makes a copy of each text file with every a as a capital A.",\n  "accept": [".txt"],\n  "run": "sed -e s/a/A/g {in}"\n}\n';
// …and one repository: an app with a page of its own whose app.json names no `entry`
const COMMIT = 'c0ffee'.padEnd(40, '0');
const PAGE_APP = {
  'app.json': '{ "name": "Page app", "about": "A page of its own, with no entry written out." }\n',
  'public/index.html': '<!doctype html><title>Page app</title><h1 id="own">its own page</h1><script src="/__tabcomputer/tab.js"></script><script>tab.ready.then(() => document.documentElement.setAttribute("data-ready", "1"))</script>',
};
const touchPages = new WeakSet();
async function newTab(device, { welcome = false } = {}) {
  const { name: _n, ...opts } = device;
  const context = await browser.newContext({ ...opts, acceptDownloads: true });
  await context.route('https://raw.githubusercontent.com/**', (route) => {
    const file = PAGE_APP[route.request().url().replace(`https://raw.githubusercontent.com/someone/pageapp/${COMMIT}/`, '')];
    return route.fulfill(file === undefined ? { status: 404, headers: { 'access-control-allow-origin': '*' }, body: 'Not Found' } : { status: 200, contentType: 'text/plain; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body: file });
  });
  await context.route('https://api.github.com/**', (route) => {
    const u = route.request().url();
    const cors = { 'access-control-allow-origin': '*' };
    if (u === 'https://api.github.com/repos/someone/pageapp/commits/HEAD') return route.fulfill({ status: 200, contentType: 'text/plain', headers: cors, body: COMMIT });
    if (u === `https://api.github.com/repos/someone/pageapp/git/trees/${COMMIT}?recursive=1`) return route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ tree: Object.keys(PAGE_APP).map((path) => ({ path, type: 'blob', mode: '100644', size: PAGE_APP[path].length })) }) });
    if (u !== `https://api.github.com/gists/${GIST}`) return route.fulfill({ status: 404, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'Not Found' });
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ id: GIST, owner: { login: 'octocat' }, history: [{ version: REV }], files: { 'app.json': { filename: 'app.json', truncated: false, content: GIST_APP } } }),
    });
  });
  const page = await context.newPage();
  if (device.hasTouch) touchPages.add(page);
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('crash', () => console.log('the page crashed'));
  if (!welcome) await page.addInitScript(() => { try { if (window.top === window) localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  await page.addInitScript((theme) => { try { if (window.top === window) localStorage.setItem('tabcomputer-desktop-theme', theme); } catch {} }, theme);
  return page;
}
const booted = (page) => page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished') && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
const side = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__tabcomputer.shell.fork(); s.terminal = null; let o = '';
  const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  return { code, o: o.replace(/\r\n/g, '\n') };
}, cmd);
const until = async (page, fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(50); } };
const put = (page, files) => page.evaluate(async (files) => {
  const fs = window.__tabcomputer.fs;
  for (const [p, text] of Object.entries(files)) { await fs.mkdir(p.replace(/\/[^/]+$/, ''), { recursive: true }); await fs.writeFile(p, text); }
}, files);
const FRAME = (id) => `iframe[data-app="${id}"]`;
async function inner(page, id) {
  const outer = await (await page.$(FRAME(id)))?.contentFrame();
  if (!outer) return null;
  return /\/__tabcomputer\/frame\.html/.test(outer.url()) ? outer.childFrames()[0] ?? null : outer;
}
/** A real click on an element of the app's page, by its place on the screen */
async function clickIn(page, id, f, target) {
  await f.evaluate((target) => document.querySelector(target).scrollIntoView({ block: 'center' }), target);
  await page.waitForTimeout(60);
  const frame = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y }; }, FRAME(id));
  const el = await f.evaluate((target) => { const r = document.querySelector(target).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, target);
  // (a finger where the screen is a touch screen: a file picker opens only for a real tap)
  if (touchPages.has(page)) await page.touchscreen.tap(frame.x + el.x, frame.y + el.y);
  else await page.mouse.click(frame.x + el.x, frame.y + el.y);
}
const ready = (page, id, ms = 40_000) => until(page, async () => { const f = await inner(page, id); return (await f?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1')) ? f : null; }, ms);
const shot = async (page, name) => { if (shots) { await page.waitForTimeout(450); await page.screenshot({ path: join(shots, `${name}.png`) }); } };
/** What a prompt says at once (outside its disclosures), its buttons and its disclosures */
const promptSays = (page, sel = '.tc-app-prompt') => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    title: el.querySelector('h3')?.textContent ?? '', says: [...el.querySelectorAll(':scope > p')].map((p) => p.innerText.replace(/\s*\n\s*/g, ' ')),
    buttons: [...el.querySelectorAll('[class$=actions] button')].map((b) => b.textContent), more: [...el.querySelectorAll('summary')].map((x) => x.textContent),
    box: { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom) }, focus: document.activeElement?.getAttribute('data-act'),
  };
}, sel);
/** The page's modules, for stand-ins (the hot-swap registry): live('src/apps/runtime.ts') */
const standInPackages = (page, lines, ms = 700) => page.evaluate(async ([lines, ms]) => {
  const t = window.__tabcomputer;
  t.live('src/apps/runtime.ts').configureApps({
    fs: t.fs, shell: t.shell,
    packages: {
      installed: async () => ({}),
      // what the server and apt say while a set of packages is installed, slowly enough to read
      install: async (_names, onLine) => { for (const l of lines) { onLine(l); await new Promise((r) => setTimeout(r, ms)); } while (window.__holdInstall) await new Promise((r) => setTimeout(r, 100)); return 0; },
    },
  });
}, [lines, ms]);
const fits = (f) => f.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth }));
/** What a screen reader needs: every control named, a live region, a heading */
const named = (f) => f.evaluate(() => {
  const bad = [...document.querySelectorAll('input, select, textarea, button')].filter((e) => {
    if (e.type === 'hidden' || e.hidden) return false;
    const label = e.getAttribute('aria-label') || (e.id && document.querySelector(`label[for="${e.id}"]`)?.textContent) || (e.tagName === 'BUTTON' ? e.textContent : '');
    return !String(label || '').trim();
  }).map((e) => e.outerHTML.slice(0, 80));
  return { bad, live: !!document.querySelector('[role=status][aria-live]'), h1: document.querySelectorAll('h1').length, lang: document.documentElement.lang };
});
const zipNames = (path) => execFileSync('unzip', ['-Z1', path], { encoding: 'utf8' }).trim().split('\n').sort();
async function openApp(page, id) {
  const t0 = Date.now();
  await side(page, `app open ${id}`);
  const f = await ready(page, id);
  return { f, ms: Date.now() - t0 };
}

for (const device of [WIDE, PHONE]) {
  const D = device.name;
  await relaunch();
  const touch = !!device.hasTouch;

  // ── files ──
  if (wants('files')) {
    const page = await newTab(device);
    await page.goto(url);
    await booted(page);
    const made = await side(page, 'cd /home/user && app new tidy');
    const listed = (await side(page, 'ls /home/user/tidy')).o.trim();
    check(`${D} files: app new asks nothing and writes one file`, made.code === 0 && listed === 'app.json' && /That one file is the whole app/.test(made.o), listed);
    const inst = await side(page, 'cd /home/user && app install tidy');
    check(`${D} files: installs`, inst.code === 0 && /Installed Tidy \(tidy\)/.test(inst.o), inst.o.trim().split('\n')[0]);
    const { f, ms } = await openApp(page, 'tidy');
    check(`${D} files: opens with the page tabcomputer supplies`, !!f, `${ms} ms`);
    time(`${D} files: app open to usable page`, ms);
    if (!f) { await page.context().close(); continue; }
    const origin = await f.evaluate(() => location.origin);
    check(`${D} files: its page is on an origin of its own`, /^http:\/\/app--tidy--[0-9a-f]{16}\./.test(origin), origin);
    const ui = await f.evaluate(() => ({ text: document.body.innerText, pickdir: !!document.getElementById('pickdir'), theme: document.documentElement.dataset.theme }));
    // (an app from a folder is not one this site reviewed: the page says where the work happens, and promises no more)
    check(`${D} files: says where the files are worked on`, /Your files are worked on in this tab\./.test(ui.text) && !/stay on this computer/.test(ui.text), ui.text.split('\n').pop());
    if (touch) check('phone files: "Choose files", nothing to drop on, no folder button', /Choose files/.test(ui.text) && !/Drop/.test(ui.text) && !ui.pickdir, ui.text.replace(/\n+/g, ' | ').slice(0, 120));
    else check('1280 files: "Drop files or a folder here", and a folder button', /Drop files or a folder here/.test(ui.text) && ui.pickdir);
    const a11y = await named(f);
    check(`${D} files: every control has a name; a live region; one heading`, !a11y.bad.length && a11y.live && a11y.h1 === 1 && a11y.lang === 'en', JSON.stringify(a11y));
    await shot(page, `${D}-files-empty`);

    // two picks: data.json, then data.json again with a file jq refuses
    const pick = async (files) => {
      const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10_000 }), clickIn(page, 'tidy', f, '#pick')]);
      await chooser.setFiles(files.map(([name, text]) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) })));
    };
    const t0 = Date.now();
    await pick([['data.json', '{"n":1,"list":[1,2,3]}']]);
    await pick([['data.json', '{"n":2}'], ['broken.json', '{"n": oops'], ['notes.txt', 'not json']]);
    const rows = await until(page, () => f.evaluate(() => (window.__app.rows.length === 4 && window.__app.rows.every((r) => !['waiting', 'working'].includes(r.status)) ? window.__app.rows.map((r) => ({ name: r.name, status: r.status, why: r.why, result: r.result })) : null)));
    time(`${D} files: three files chosen to all rows settled`, Date.now() - t0);
    const by = (name, n = 0) => (rows || []).filter((r) => r.name === name)[n];
    check(`${D} files: two inputs named data.json give data.json and data (2).json`, by('data.json')?.status === 'done' && by('data.json', 1)?.status === 'done' && by('data.json')?.result === 'data.json' && by('data.json', 1)?.result === 'data (2).json', JSON.stringify(rows));
    check(`${D} files: the file the program refuses says the program's own last line`, by('broken.json')?.status === 'failed' && /^jq: error \(at broken\.json:1\): Cannot parse input/.test(by('broken.json')?.why ?? ''), by('broken.json')?.why);
    check(`${D} files: a file of another kind is skipped, with why`, by('notes.txt')?.status === 'skipped' && by('notes.txt')?.why === 'This is not a .json file.');
    const status = await f.evaluate(() => document.querySelector('[role=status]').textContent);
    check(`${D} files: the summary says it`, status === '2 done, 1 failed, 1 skipped.', status);
    await shot(page, `${D}-files-done`);
    check(`${D} files: nothing scrolls sideways`, await fits(f).then((s) => s.sw <= s.w));
    const dir = mkdtempSync(join(tmpdir(), 'tc-decl-'));
    const [zip] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), clickIn(page, 'tidy', f, '#all')]);
    await zip.saveAs(join(dir, 'all.zip'));
    const names = zipNames(join(dir, 'all.zip'));
    check(`${D} files: Download all is a zip with both results`, zip.suggestedFilename() === 'tidy.zip' && names.join() === 'data (2).json,data.json', names.join());
    const [one] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), clickIn(page, 'tidy', f, 'li.done button')]);
    await one.saveAs(join(dir, 'one.json'));
    check(`${D} files: each result downloads alone`, one.suggestedFilename() === 'data.json' && JSON.parse(readFileSync(join(dir, 'one.json'), 'utf8')).n === 1 && readFileSync(join(dir, 'one.json'), 'utf8').includes('\n  '), one.suggestedFilename());

    if (!touch) {
      // a dropped folder: the page's own path from imported files to results (a real drag cannot be made here)
      await f.evaluate(async () => {
        const file = (name, text) => ({ file: new File([text], name.split('/').pop()), rel: name });
        window.__app.take(await tab.files.import([file('scans/2024/a.json', '[1]'), file('scans/2025/a.json', '[2]'), file('scans/.DS_Store', 'x')], { dir: window.__app.dirs.in + '/folder' }));
      });
      const deep = await until(page, () => f.evaluate(() => { const r = window.__app.rows.filter((x) => x.name.startsWith('scans/')); return r.length === 2 && r.every((x) => x.status === 'done') ? r.map((x) => x.result) : null; }));
      const [zip2] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), clickIn(page, 'tidy', f, '#all')]);
      await zip2.saveAs(join(dir, 'tree.zip'));
      const tree = zipNames(join(dir, 'tree.zip')).filter((n) => !n.endsWith('/'));
      check('1280 files: a folder keeps its structure in the results and the zip; hidden files are left out', deep?.join() === 'scans/2024/a.json,scans/2025/a.json' && tree.includes('scans/2024/a.json') && tree.includes('scans/2025/a.json') && tree.length === 4, tree.join());

      // by keyboard only, in a page loaded again: Tab to "Choose files", Enter, then Tab to a result's Download
      await side(page, 'app stop tidy');
      const again = (await openApp(page, 'tidy')).f;
      // (the keyboard is in the app's page once: a click on its heading, which takes no focus of its own)
      await until(page, async () => { await clickIn(page, 'tidy', again, 'h1'); return again.evaluate(() => document.hasFocus()); }, 5000);
      const order = [];
      let chooser = null;
      page.once('filechooser', (c) => { chooser = c; });
      for (let i = 0; i < 6 && !chooser; i++) {
        await page.keyboard.press('Tab');
        const at = await again.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
        order.push(at);
        if (at === 'pick') { await page.keyboard.press('Enter'); await until(page, async () => chooser, 5000); }
      }
      if (chooser) await chooser.setFiles([{ name: 'keys.json', mimeType: 'application/json', buffer: Buffer.from('{"k":true}') }]);
      await until(page, () => again.evaluate(() => window.__app.rows[0]?.status === 'done'));
      let got = null;
      page.once('download', (d) => { got = d; });
      for (let i = 0; i < 8 && !got; i++) {
        await page.keyboard.press('Tab');
        const at = await again.evaluate(() => document.activeElement?.getAttribute('aria-label') || document.activeElement?.id || '');
        order.push(at);
        if (at === 'Download keys.json') { await page.keyboard.press('Enter'); await until(page, async () => got, 5000); }
      }
      const ring = await again.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
      check('1280 files: by keyboard only: choose a file, then download its result; the focus shows', !!chooser && got?.suggestedFilename() === 'keys.json' && ring !== 'none', `${order.join(' > ')} (${ring})`);

      // the desktop's appearance reaches the page
      const before = await again.evaluate(() => document.documentElement.dataset.theme);
      await page.evaluate(() => { const d = window.__tabcomputer.desktop; d.setTheme(d.theme() === 'dark' ? 'light' : 'dark'); });
      const after = await until(page, () => again.evaluate((b) => (document.documentElement.dataset.theme !== b ? document.documentElement.dataset.theme : null), before), 5000);
      check('1280 files: the page follows the desktop\'s light or dark appearance', !!after && after === await page.evaluate(() => window.__tabcomputer.desktop.theme()), `${before} to ${after}`);
      await shot(page, `${D}-files-${after}`);
    }
    await page.context().close();
  }

  // ── form ──
  if (wants('form')) {
    await relaunch();
    const page = await newTab(device);
    await page.goto(url);
    await booted(page);
    const made = await side(page, 'cd /home/user && app new count --template form && ls count && app install count');
    check(`${D} form: app new writes one file; it installs`, made.code === 0 && /\napp\.json\n/.test(made.o) && /Installed Count/.test(made.o), made.o.trim().split('\n').pop());
    let { f, ms } = await openApp(page, 'count');
    time(`${D} form: app open to usable page`, ms);
    check(`${D} form: opens`, !!f, `${ms} ms`);
    if (f) {
      const a11y = await named(f);
      check(`${D} form: every field has its label`, !a11y.bad.length && a11y.live, JSON.stringify(a11y));
      const t0 = Date.now();
      await clickIn(page, 'count', f, '#run');
      const ran = await until(page, () => f.evaluate(() => window.__app.code === 0 && window.__app.output === '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n'));
      time(`${D} form: Run to Done (seq 1 1 10)`, Date.now() - t0);
      check(`${D} form: Run fills the command from the fields and shows its output`, ran, await f.evaluate(() => document.querySelector('[role=status]').textContent));
      check(`${D} form: Stop shows only while the program runs`, await until(page, () => f.evaluate(() => !window.__app.running && document.getElementById('stop').offsetParent === null && document.querySelector('[role=status]').textContent === 'Done.'), 5000));
      await shot(page, `${D}-form`);
      check(`${D} form: nothing scrolls sideways`, await fits(f).then((s) => s.sw <= s.w));
    }
    // output as it is written, and Stop
    await put(page, { '/home/user/slow/app.json': JSON.stringify({ name: 'Slow', about: 'Counts slowly.', fields: { n: { label: 'How many', type: 'number', value: 30 } }, run: 'sh -c \'i=0; while [ $i -lt "$0" ]; do i=$((i+1)); echo line $i; sleep 0.4; done\' {n}' }) });
    await side(page, 'app install /home/user/slow');
    f = (await openApp(page, 'slow')).f;
    if (f) {
      await clickIn(page, 'slow', f, '#run');
      const mid = await until(page, () => f.evaluate(() => { const t = document.querySelector('pre').textContent; return window.__app.running && /line 2\n/.test(t) && !/line 20/.test(t) ? t.trim().split('\n').length : 0; }), 15_000);
      check(`${D} form: output shows as it is written`, mid >= 2 && mid < 20, `${mid} lines while it runs`);
      const t0 = Date.now();
      await clickIn(page, 'slow', f, '#stop');
      const stopped = await until(page, () => f.evaluate(() => (!window.__app.running && window.__app.runs === 1 ? { status: document.querySelector('[role=status]').textContent, lines: document.querySelector('pre').textContent.trim().split('\n').length, code: window.__app.code } : null)), 8000);
      check(`${D} form: Stop ends the program`, !!stopped && stopped.lines < 30 && stopped.code !== 0, `${JSON.stringify(stopped)} after ${Date.now() - t0} ms`);
    }
    // live: the jq playground example, installed from this site by its id
    const inst = await side(page, 'app install examples/jq-playground');
    check(`${D} form: an example installs by examples/NAME, without a prompt`, inst.code === 0 && /Installed jq playground/.test(inst.o), inst.o.trim().split('\n').slice(-2).join(' | '));
    const t1 = Date.now();
    f = (await openApp(page, 'jq-playground')).f;
    if (f) {
      const first = await until(page, () => f.evaluate(() => (window.__app.runs >= 1 ? document.querySelector('pre').textContent : null)));
      time(`${D} form (live): app open to the first result`, Date.now() - t1);
      check(`${D} live: it runs when it opens`, first === '"Ada"\n"Grace"\n', JSON.stringify(first));
      const t2 = Date.now();
      await f.evaluate(() => { const i = document.querySelector('input[type=text]'); i.value = '.people | length'; i.dispatchEvent(new Event('input', { bubbles: true })); });
      const typed = await until(page, () => f.evaluate(() => (document.querySelector('pre').textContent === '3\n' ? true : null)), 8000);
      time(`${D} form (live): a keystroke to the new result`, Date.now() - t2);
      check(`${D} live: typing runs it again`, typed, await f.evaluate(() => document.querySelector('pre').textContent));
      // a live form has no Run, no Stop and no "Done.": only the program's own words, when it refuses what was typed
      const quiet = await f.evaluate(() => ({ run: document.getElementById('run').offsetParent !== null, stop: document.getElementById('stop').offsetParent !== null, status: document.querySelector('[role=status]').textContent, height: document.querySelector('[role=status]').offsetHeight }));
      check(`${D} live: no Run, no Stop and no "Done." line`, !quiet.run && !quiet.stop && quiet.status === '' && quiet.height === 0, JSON.stringify(quiet));
      await shot(page, `${D}-form-live`);
      await f.evaluate(() => { const i = document.querySelector('input[type=text]'); i.value = '.people['; i.dispatchEvent(new Event('input', { bubbles: true })); });
      const err = await until(page, () => f.evaluate(() => { const s = document.querySelector('[role=status]'); return s.textContent ? { said: s.textContent, bad: s.classList.contains('bad'), pre: document.querySelector('pre').textContent, stale: document.querySelector('pre').classList.contains('stale') } : null; }), 8000);
      check(`${D} live: a filter jq refuses shows jq's own words, and the last result stays, dimmed`, !!err && /^jq: /.test(err.said) && err.bad && err.pre === '3\n' && err.stale, JSON.stringify(err).slice(0, 200));
      await shot(page, `${D}-form-live-error`);
      await f.evaluate(() => { const i = document.querySelector('input[type=text]'); i.value = '.people | length'; i.dispatchEvent(new Event('input', { bubbles: true })); });
      const cleared = await until(page, () => f.evaluate(() => { const s = document.querySelector('[role=status]'); return !s.textContent && !document.querySelector('pre').classList.contains('stale'); }), 8000);
      check(`${D} live: the words go when the typing is something jq takes`, cleared);
      check(`${D} live: nothing scrolls sideways`, await fits(f).then((s) => s.sw <= s.w));
    }
    await page.context().close();
  }

  // ── table ──
  if (wants('table')) {
    await relaunch();
    const page = await newTab(device);
    await page.goto(url);
    await booted(page);
    const inst = await side(page, 'app install examples/expenses');
    check(`${D} table: the example installs`, inst.code === 0, inst.o.trim().split('\n').slice(-2).join(' | '));
    let { f, ms } = await openApp(page, 'expenses');
    time(`${D} table: app open to usable page`, ms);
    check(`${D} table: opens`, !!f, `${ms} ms`);
    const FILE = '/home/user/.local/share/apps/expenses/expenses.csv';
    if (f) {
      const t0 = Date.now();
      const fillRow = async (values) => {
        await clickIn(page, 'expenses', f, '#add');
        await until(page, () => f.evaluate((n) => window.__app.saves >= n, 1));
        await f.evaluate((values) => {
          const tr = document.querySelector('tbody').lastElementChild;
          [...tr.querySelectorAll('input, select')].forEach((box, i) => {
            if (box.type === 'checkbox') { if (box.checked !== !!values[i]) box.click(); return; }
            box.value = values[i];
            box.dispatchEvent(new Event('change', { bubbles: true }));
          });
        }, values);
      };
      await fillRow(['2026-10-01', 'Train to Leeds', 'Travel', '42.5', true]);
      time(`${D} table: Add a row and fill it, to saved`, Date.now() - t0);
      await fillRow(['2026-10-03', 'Lunch, with "Sam"', 'Food', '18', false]);
      await fillRow(['2026-09-28', 'Light bulbs', 'Home', '7.25', false]);
      await until(page, () => f.evaluate(() => window.__app.rows.length === 3 && window.__app.rows[2][3] === '7.25'));
      await page.waitForTimeout(300);
      const csv = (await side(page, `cat ${FILE}`)).o;
      check(`${D} table: every edit is saved to the CSV file, as CSV`, csv === 'Date,What,Category,Amount,Paid back\n2026-10-01,Train to Leeds,Travel,42.5,yes\n2026-10-03,"Lunch, with ""Sam""",Food,18,\n2026-09-28,Light bulbs,Home,7.25,\n', JSON.stringify(csv));
      const total = () => f.evaluate(() => document.querySelector('tfoot td.num')?.textContent);
      check(`${D} table: a total for the number column`, await total() === '67.75', await total());
      // sort: the header's button at 1280, the "Sort by" list on a phone
      if (touch) await f.evaluate(() => { const s = document.querySelector('.sortby select'); s.value = '3'; s.dispatchEvent(new Event('change', { bubbles: true })); });
      else await clickIn(page, 'expenses', f, 'thead th:nth-child(4) button');
      const sorted = await f.evaluate(() => [...document.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('input')[2].value));
      check(`${D} table: sorts by a column, numbers as numbers`, sorted.join() === '7.25,18,42.5', sorted.join());
      await f.evaluate(() => { const i = document.querySelector('input[type=search]'); i.value = 'food'; i.dispatchEvent(new Event('input', { bubbles: true })); });
      const filtered = await f.evaluate(() => ({ rows: document.querySelectorAll('tbody tr').length, total: document.querySelector('tfoot td.num').textContent }));
      check(`${D} table: filters, and the total follows`, filtered.rows === 1 && filtered.total === '18', JSON.stringify(filtered));
      await f.evaluate(() => { const i = document.querySelector('input[type=search]'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); });
      const a11y = await named(f);
      check(`${D} table: every cell and button has a name`, !a11y.bad.length && a11y.live, JSON.stringify(a11y));
      await shot(page, `${D}-table`);
      check(`${D} table: nothing scrolls sideways`, await fits(f).then((s) => s.sw <= s.w), JSON.stringify(await fits(f)));
      // another program changes the file
      await side(page, `echo '2026-10-05,Stamps,Other,3,' >> ${FILE}`);
      check(`${D} table: another program's change shows`, await until(page, () => f.evaluate(() => window.__app.rows.length === 4 && window.__app.rows[3][1] === 'Stamps'), 8000));
      // delete, and undo
      await clickIn(page, 'expenses', f, 'tbody tr:last-child td.act button');
      await until(page, () => f.evaluate(() => window.__app.rows.length === 3 && !!document.querySelector('[role=status] button')));
      await clickIn(page, 'expenses', f, '[role=status] button');
      check(`${D} table: a row is deleted, and Undo brings it back`, await until(page, () => f.evaluate(() => window.__app.rows.length === 4), 5000));
      const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), clickIn(page, 'expenses', f, '#export')]);
      check(`${D} table: exports as CSV`, dl.suggestedFilename() === 'expenses.csv', dl.suggestedFilename());
    }
    // a reload: the window comes back and the data is there (a phone's desktop restores no windows: opened again there)
    const t3 = Date.now();
    await page.reload();
    await booted(page);
    // (a phone's desktop brings back the apps that were open, and nothing else)
    f = await ready(page, 'expenses');
    if (touch) check('phone table: the app\'s window comes back after a reload by itself; a terminal that was open does not', !!f && await page.evaluate(() => window.__tabcomputer.desktop.windows().filter((w) => w.appId === 'terminal').length === 1));
    const back = f ? await until(page, () => f.evaluate(() => (window.__app.rows.length === 4 ? window.__app.rows.map((r) => r[1]).join() : null))) : null;
    time(`${D} table: a reload to the table with its data${' (its window restored)'}`, Date.now() - t3);
    check(`${D} table: a reload finds the data`, back === 'Train to Leeds,Lunch, with "Sam",Light bulbs,Stamps', String(back));

    if (!touch) {
      // SQLite: the same table in a database file
      await put(page, { '/home/user/stock/app.json': JSON.stringify({ name: 'Stock', table: 'stock.sqlite', columns: ['Item', { name: 'Count', type: 'number' }] }) });
      const si = await side(page, 'app install /home/user/stock && app check /home/user/stock');
      const s = (await openApp(page, 'stock')).f;
      check('1280 table: a SQLite table opens', !!s && /It runs the program sqlite3 on that file/.test(si.o));
      if (s) {
        await clickIn(page, 'stock', s, '#add');
        await until(page, () => s.evaluate(() => window.__app.saves >= 1));
        await s.evaluate(() => { const [a, b] = document.querySelectorAll('tbody tr:last-child input'); a.value = "O'Brien's nails"; a.dispatchEvent(new Event('change', { bubbles: true })); b.value = '12'; b.dispatchEvent(new Event('change', { bubbles: true })); });
        await until(page, () => s.evaluate(() => window.__app.saves >= 3));
        await page.waitForTimeout(500);
        const q = await side(page, 'sqlite3 /home/user/.local/share/apps/stock/stock.sqlite \'select "Item", "Count" from stock\'');
        check('1280 table: edits are in the database', /O'Brien's nails\|12/.test(q.o), q.o.trim().split('\n').pop());
        await side(page, 'sqlite3 /home/user/.local/share/apps/stock/stock.sqlite "insert into stock values (\'Screws\', 400)"');
        check('1280 table: a row another program inserts shows', await until(page, () => s.evaluate(() => window.__app.rows.length === 2 && window.__app.rows[1][0] === 'Screws'), 8000), JSON.stringify(await s.evaluate(() => window.__app.rows)));
        const quiet = await s.evaluate(async () => { const n = window.__app.loads; await new Promise((r) => setTimeout(r, 1500)); return window.__app.loads - n; });
        check('1280 table: its own reads do not make it read again', quiet === 0, `${quiet} loads in 1.5 s`);
      }
    }
    await page.context().close();
  }
}


// ── what #141 left: the appearance, Stop, progress, streamed output, Share, the placeholder ──
if (wants('polish')) for (const device of [WIDE, PHONE]) {
  const D = device.name;
  await relaunch();
  const touch = !!device.hasTouch;
  const page = await newTab(device);
  await page.goto(url);
  await booted(page);
  const BG = theme === 'dark' ? 'rgb(27, 29, 41)' : 'rgb(255, 255, 255)';

  // nothing white in the dark appearance: the frame, the frame's own document, and the page as it is served
  await side(page, 'cd /home/user && app new tidy && app install tidy');
  let { f } = await openApp(page, 'tidy');
  const paint = f ? {
    frame: await page.evaluate((sel) => getComputedStyle(document.querySelector(sel)).backgroundColor, FRAME('tidy')),
    around: await page.evaluate((sel) => getComputedStyle(document.querySelector(sel).closest('.tc-app')).backgroundColor, FRAME('tidy')),
    // (the document of the app's origin that holds the page: it has no background of its own)
    holder: await (await (await page.$(FRAME('tidy'))).contentFrame()).evaluate(() => getComputedStyle(document.documentElement).backgroundColor + ' / ' + getComputedStyle(document.body).backgroundColor),
    page: await f.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
    served: await f.evaluate(async () => (await (await fetch('/')).text()).match(/<html[^>]*>[\s\S]*?<style>[^<]*<\/style>/)?.[0] ?? ''),
  } : null;
  check(`${D} ${theme}: the frame is the page's color before the page paints, and at the window's corners`, !!paint && paint.frame === BG && paint.page === BG && paint.holder === 'rgba(0, 0, 0, 0) / rgba(0, 0, 0, 0)'
    && paint.served.includes(`data-theme="${theme}"`) && paint.served.includes(`color-scheme: ${theme}`) && (theme === 'light' || paint.around === BG), JSON.stringify(paint));

  // a files run: Stop, the program's last line while a file is worked on, "1 of 3" in the window's title
  await put(page, { '/home/user/slowfiles/app.json': JSON.stringify({ name: 'Slow files', about: 'Works on each file for a while.', run: 'sh -c \'i=0; while [ $i -lt 40 ]; do i=$((i+1)); echo "page $i of 40" >&2; sleep 0.25; done; cat "$0" > "$1"\' {in} {out}', out: '{name}.txt' }) });
  await side(page, 'app install /home/user/slowfiles');
  f = (await openApp(page, 'slowfiles')).f;
  if (f) {
    await f.evaluate(async () => {
      const file = (name) => ({ file: new File(['x'], name), rel: name });
      window.__app.take(await tab.files.import([file('a.txt'), file('b.txt'), file('c.txt')], { dir: window.__app.dirs.in + '/1' }));
    });
    const during = await until(page, () => f.evaluate(() => {
      const rows = window.__app.rows.map((r) => ({ status: r.status, says: r.li.querySelector('.why')?.textContent ?? '' }));
      return rows.filter((r) => r.status === 'working' && /^page \d+ of 40$/.test(r.says)).length === 2
        ? { rows, stop: document.getElementById('stop').offsetParent !== null, status: document.querySelector('[role=status]').textContent, all: document.getElementById('all').offsetParent === null } : null;
    }), 15_000);
    check(`${D} files: while a file is worked on its row shows the program's last line, and Stop is there`, !!during && during.stop && during.all && during.status === '0 of 3 done.' && during.rows[2].status === 'waiting', JSON.stringify(during));
    const title = () => page.evaluate(() => (document.body.classList.contains('become-active') ? document.title : window.__tabcomputer.desktop.windows().find((w) => w.appId === 'slowfiles')?.title));
    check(`${D} files: the window's title says how far the run is`, await title() === 'Slow files — 0 of 3', String(await title()));
    await shot(page, `${D}-files-working`);
    await clickIn(page, 'slowfiles', f, '#stop');
    const stopped = await until(page, () => f.evaluate(() => (window.__app.rows.every((r) => r.status === 'stopped') ? { status: document.querySelector('[role=status]').textContent, stop: document.getElementById('stop').offsetParent !== null } : null)), 10_000);
    check(`${D} files: Stop ends the files being worked on and starts no more`, !!stopped && stopped.status === '0 done, 3 stopped.' && !stopped.stop, JSON.stringify(stopped ?? await f.evaluate(() => window.__app.rows.map((r) => r.status))));
    check(`${D} files: the title is the app's name again`, await until(page, async () => await title() === 'Slow files', 5000), String(await title()));
    await shot(page, `${D}-files-stopped`);
  }

  // a result without `out` is named for what it is
  await put(page, { '/home/user/topdf/app.json': JSON.stringify({ name: 'To PDF', run: 'sh -c \'printf "%%PDF-1.4\\n"; cat "$0"\' {in}' }) });
  await side(page, 'app install /home/user/topdf');
  f = (await openApp(page, 'topdf')).f;
  if (f) {
    await f.evaluate(async () => { window.__app.take(await tab.files.import([{ file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])], 'p.png'), rel: 'p.png' }], { dir: window.__app.dirs.in + '/1' })); });
    const named = await until(page, () => f.evaluate(() => (window.__app.rows[0]?.status === 'done' ? { result: window.__app.rows[0].result, said: window.__app.rows[0].li.querySelector('.why')?.textContent, zip: document.getElementById('all').offsetParent !== null, one: !!window.__app.rows[0].li.querySelector('button') } : null)), 15_000);
    check(`${D} files: without out, a PDF made from p.png is named p.pdf, and the row says so`, named?.result === 'p.pdf' && named.said === 'Saved as p.pdf', JSON.stringify(named));
    check(`${D} files: one result has its own Download and no zip button`, !!named && named.one && !named.zip, JSON.stringify(named));
    await shot(page, `${D}-files-named`);
    // (windows that are done with are closed: each open app is a page of its own, and memory is short here)
    await side(page, 'app stop tidy; app stop slowfiles; app stop topdf');
  }

  // markdown and html output: drawn while the program still writes; tables, images, links
  const DOT = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  await put(page, {
    '/home/user/report/app.json': JSON.stringify({ name: 'Report', about: 'Writes a report as Markdown.', output: 'markdown', fields: { title: { label: 'Title', value: 'Totals' } },
      run: `sh -c 'echo "# $0"; echo; echo "| Item | Cost |"; echo "|:-----|-----:|"; echo "| Train | **42.50** |"; echo "| Lunch | 18 |"; sleep 3; echo; echo "![a dot](${DOT}) ![plot](plot.png) ![far](https://example.com/far.png)"; echo; echo "See [the site](https://example.com/page) for more."; sleep 2; echo; echo "- done"' {title}` }),
    '/home/user/webpage/app.json': JSON.stringify({ name: 'Web page', output: 'html', fields: { who: { label: 'Who', value: 'you' } },
      run: 'sh -c \'echo "<h1 id=one>Hello $0</h1><script>parent.postMessage(1, String.fromCharCode(42))</script>"; sleep 3; echo "<p id=two>and more</p>"; sleep 2; echo "<p id=three>the end</p>"\' {who}' }),
  });
  await page.evaluate(async (b64) => {
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/home/user/.local/share/apps/report', { recursive: true });
    await fs.writeFile('/home/user/.local/share/apps/report/plot.png', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }, DOT.split(',')[1]);
  await side(page, 'app install /home/user/report && app install /home/user/webpage');
  f = (await openApp(page, 'report')).f;
  if (f) {
    await clickIn(page, 'report', f, '#run');
    const early = await until(page, () => f.evaluate(() => (window.__app.running && document.querySelector('.rendered table') ? {
      heading: document.querySelector('.rendered h2')?.textContent, cells: [...document.querySelectorAll('.rendered td')].map((td) => td.textContent), right: document.querySelectorAll('.rendered td')[1]?.style.textAlign,
      strong: !!document.querySelector('.rendered td strong'), more: !!document.querySelector('.rendered img'), stop: document.getElementById('stop').offsetParent !== null,
    } : null)), 10_000);
    check(`${D} markdown: the output is drawn while the program still writes: a heading and a table`, !!early && early.heading === 'Totals' && early.cells.join() === 'Train,42.50,Lunch,18' && early.right === 'right' && early.strong && !early.more && early.stop, JSON.stringify(early));
    await shot(page, `${D}-markdown-streaming`);
    const whole = await until(page, () => f.evaluate(() => (!window.__app.running && window.__app.runs === 1 && [...document.querySelectorAll('.rendered img')].every((i) => i.complete && i.naturalWidth) ? {
      imgs: [...document.querySelectorAll('.rendered img')].map((i) => [i.alt, i.src.slice(0, 5), i.naturalWidth]), text: document.querySelector('.rendered').innerText.replace(/\s+/g, ' '),
      links: document.querySelectorAll('.rendered a').length, status: document.querySelector('[role=status]').textContent, scrolls: document.documentElement.scrollWidth > innerWidth,
    } : null)), 15_000);
    // (an image written into the output, and one in the app's own data folder, where the command runs; another site's is its words)
    check(`${D} markdown: images that are data: or the app's own are shown, another site's is its words`, !!whole && JSON.stringify(whole.imgs) === JSON.stringify([['a dot', 'data:', 1], ['plot', 'blob:', 1]]) && / far /.test(whole.text), JSON.stringify(whole?.imgs ?? await f.evaluate(() => [...document.querySelectorAll('.rendered img')].map((i) => [i.alt, i.src.slice(0, 30), i.complete, i.naturalWidth]))));
    // (this app may not reach other sites: a link is its words and its address, not something to click)
    check(`${D} markdown: a link is plain text in an app that is kept from other sites`, !!whole && whole.links === 0 && whole.text.includes('See the site (https://example.com/page) for more.') && whole.status === 'Done.' && !whole.scrolls, JSON.stringify(whole && { links: whole.links, text: whole.text.slice(-120) }));
    await shot(page, `${D}-markdown`);
  }
  f = (await openApp(page, 'webpage')).f;
  if (f) {
    await f.evaluate(() => addEventListener('message', (e) => { if (e.data === 1) window.__ran = (window.__ran || 0) + 1; }));
    await clickIn(page, 'webpage', f, '#run');
    const doc = () => f.evaluate(() => { const fr = document.querySelector('iframe.rendered:not(.next)'); return fr ? { srcdoc: fr.srcdoc, sandbox: fr.getAttribute('sandbox'), frames: document.querySelectorAll('iframe.rendered').length } : null; });
    const early = await until(page, async () => { const d = await doc(); return d && d.srcdoc.includes('id=one') && !d.srcdoc.includes('id=three') && await f.evaluate(() => window.__app.running) ? d : null; }, 10_000);
    check(`${D} html: the document shows while the program still writes, in a frame that runs no script`, !!early && early.sandbox === '' && !early.srcdoc.includes('id=three'), JSON.stringify(early && { sandbox: early.sandbox, has: early.srcdoc.slice(0, 40) }));
    const whole = await until(page, async () => { const d = await doc(); return d && d.srcdoc.includes('id=three') && d.frames === 1 && !(await f.evaluate(() => window.__app.running)) ? d : null; }, 15_000);
    check(`${D} html: the whole document at the end, one frame, and its script never ran`, !!whole && await f.evaluate(() => !window.__ran), JSON.stringify(whole && { frames: whole.frames }));
    await shot(page, `${D}-html`);
    await side(page, 'app stop report; app stop webpage');
  }

  // Share, from the app's own window (app mode on a phone has it in the bar: below)
  if (!touch) {
    await side(page, 'app install examples/expenses');
    f = (await openApp(page, 'expenses')).f;
    const btn = await page.evaluate(() => { const w = window.__tabcomputer.desktop.windows().find((x) => x.appId === 'expenses'); const b = w?.element.querySelector('.sd-titlebar .tc-app-tb'); return b ? { label: b.getAttribute('aria-label'), title: b.title } : null; });
    check('1280 share: the app\'s window has a Share button in its title bar', btn?.label === 'Share Expenses' && btn.title === 'Share', JSON.stringify(btn));
    await page.click('.sd-win[data-app="expenses"] .tc-app-tb');
    await page.waitForSelector('.tc-app-share', { timeout: 10_000 }).catch(() => null);
    const shared = await page.evaluate(() => { const el = document.querySelector('.tc-app-share'); return el ? { title: el.querySelector('h3').textContent, says: [...el.querySelectorAll('p')].map((p) => p.textContent), link: el.querySelector('textarea').value, buttons: [...el.querySelectorAll('button')].map((b) => b.textContent) } : null; });
    check('1280 share: the screen has the link, Copy, and what a person who opens it gets, as app share says it', !!shared && shared.title === 'Share Expenses' && shared.link === `${new URL(url).origin}/?app=expenses` && shared.buttons.join() === 'Close,Copy link'
      && shared.says.join(' | ') === 'Each person who opens this link gets their own copy of Expenses, with their own data. Nobody sees your data, and you do not see theirs. | This site ships Expenses, so it installs without a question.', JSON.stringify(shared));
    const printed = (await side(page, 'app share expenses --print')).o.trim();
    check('1280 share: it is the link app share prints', shared?.link === printed, printed);
    await shot(page, `${D}-share`);
    await page.click('.tc-app-share [data-act=close]');
    // the same in the menu bar, with Export beside it
    const menu = await page.evaluate(() => window.__tabcomputer.desktop.apps().find((a) => a.id === 'expenses')?.menus?.().map((m) => [m.title, m.items.map((i) => i.label)]));
    check('1280 share: the menu bar has the same under App', JSON.stringify(menu) === JSON.stringify([['App', ['Share as a Link…', 'Export with Its Data']]]), JSON.stringify(menu));
  }

  // the placeholder while what an app needs is installed: its name whole, sentences with the installer's own count
  const LINES = [
    'The server is building other programs first: 1 build is ahead of tesseract-ocr.', 'The server is installing package 12 of 71 for tesseract-ocr.',
    'No ready-made copy of tesseract-ocr (this server keeps none): apt installs it here, which takes a few minutes.',
    '0 upgraded, 5 newly installed, 0 to remove and 0 not upgraded.', 'Get:1 http://deb.debian.org/debian trixie/main amd64 liblept5 amd64 1.84 [1,027 kB]', 'Get:2 http://deb.debian.org/debian trixie/main amd64 libtesseract5 amd64 5.5 [1,407 kB]',
    'Selecting previously unselected package liblept5:amd64.', 'Unpacking liblept5:amd64 (1.84) ...', 'Unpacking libtesseract5:amd64 (5.5) ...', 'Setting up liblept5:amd64 (1.84) ...',
  ];
  await put(page, {
    '/home/user/ocr/app.json': JSON.stringify({ name: 'Make a scanned PDF searchable, page by page', about: 'Reads the text on scanned pages.', accept: ['.png'], run: 'tesseract {in} stdout pdf', out: '{name}.pdf', needs: ['tesseract-ocr'] }),
    '/usr/local/bin/tesseract': '#!/bin/sh\nprintf "%%PDF-1.4\\n"; cat "$1"\n',
  });
  await side(page, 'chmod +x /usr/local/bin/tesseract; app list');
  await standInPackages(page, LINES);
  await page.evaluate(() => { window.__holdInstall = true; });
  const seen = [];
  const reading = (async () => {
    for (let i = 0; i < 300 && !seen.includes('__over'); i++) {
      const t = await page.evaluate(() => document.querySelector('#become-container .tc-app-cover:not([hidden])')?.innerText ?? document.querySelector('.sd-launch .sd-launch-stage')?.textContent ?? '').catch(() => '');
      const said = t.replace(/\s*\n\s*/g, ' ').trim();
      if (said && seen[seen.length - 1] !== said) seen.push(said);
      await page.waitForTimeout(120);
    }
  })();
  if (touch) {
    // an app link on a phone installs what it needs as the app: its name over the sentences, no desktop frame
    await page.evaluate(async () => {
      const t = window.__tabcomputer;
      await t.live('src/apps/install.ts').installDir('/home/user/ocr');
      const w = t.live('src/apps/window.ts');
      void w.becomeApp((await w.installedRef('ocr')).ref, { back: true });
    });
  } else void side(page, 'app install /home/user/ocr --open');
  await until(page, async () => seen.some((x) => /Package 1 of 5 is being set up\./.test(x)), 25_000);
  const holder = await page.evaluate(() => {
    const name = document.querySelector('.sd-launch-name');
    const cover = document.querySelector('#become-container .tc-app-cover:not([hidden])');
    const r = (e) => { const b = e.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), sw: e.scrollWidth, cw: e.clientWidth }; };
    return { become: document.body.classList.contains('become-active'), placeholders: document.querySelectorAll('.sd-launch-win').length, name: name ? { text: name.textContent, ...r(name) } : null, cover: cover ? { title: cover.querySelector('b')?.textContent, ...r(cover) } : null };
  });
  // (the placeholder opens behind the other windows: in front for its picture)
  if (!touch) await page.evaluate(() => window.__tabcomputer.desktop.windows().find((w) => w.element.classList.contains('sd-launch-win'))?.focus());
  await shot(page, `${D}-needs-installing`);
  if (touch) check('phone needs: what it needs is installed as the app, under its whole name, with no desktop frame', holder.become && holder.placeholders === 0 && holder.cover?.title === 'Starting Make a scanned PDF searchable, page by page…' && holder.cover.sw <= holder.cover.cw, JSON.stringify(holder));
  else check('1280 needs: the placeholder shows the name whole', !!holder.name && holder.name.text === 'Make a scanned PDF searchable, page by page' && holder.name.sw <= holder.name.cw, JSON.stringify(holder.name));
  await page.evaluate(() => { window.__holdInstall = false; });
  const opened = await ready(page, 'ocr', 30_000);
  seen.push('__over');
  await reading;
  const said = seen.filter((x) => x !== '__over').map((x) => x.replace(/^Starting Make a scanned PDF searchable, page by page… ?/, '')).filter(Boolean);
  const want = [
    'Make a scanned PDF searchable, page by page needs some programs. They are being downloaded. This happens once.',
    'The server is building other programs first: 1 build is ahead of tesseract-ocr. This build happens once: the next person gets these programs in seconds.',
    'The server is installing package 12 of 71 for tesseract-ocr. This build happens once: the next person gets these programs in seconds.',
    'No ready-made copy of tesseract-ocr (this server keeps none): apt installs it here, which takes a few minutes.',
    'Package 1 of 5 is being downloaded.', 'Package 2 of 5 is being downloaded.', 'Package 1 of 5 is being unpacked.', 'Package 2 of 5 is being unpacked.', 'Package 1 of 5 is being set up.',
  ];
  // (a sentence shown for a moment can be missed by the reader here: each one seen must be one of these, in their order)
  const known = said.filter((x) => want.includes(x));
  const inOrder = known.map((x) => want.indexOf(x)).every((n, i, a) => i === 0 || n >= a[i - 1]);
  check(`${D} needs: the sentences are the server's and apt's own, with the count of what is left`, inOrder && known.includes(want[2]) && known.some((x) => /^Package \d of 5 is being /.test(x)) && known.length >= 5, JSON.stringify(said));
  check(`${D} needs: the app opens when its programs are there`, !!opened);
  // an app this site did not review says where the work happens; (the site's own files app says the files stay: app-converter.mjs)
  if (opened) check(`${D} needs: its page says where the files are worked on`, await opened.evaluate(() => document.querySelector('.note').textContent) === 'Your files are worked on in this tab.');

  if (touch) {
    // app mode: the bar follows the page's appearance, and has Share
    const bar = await page.evaluate(() => { const b = document.querySelector('.tc-app-back'); const s = getComputedStyle(b); return { bg: s.backgroundColor, color: getComputedStyle(b.querySelector('a')).color, items: [...b.children].map((c) => c.textContent), theme: document.getElementById('become-container').dataset.tcTheme, title: document.title }; });
    const light = (rgb) => { const [r, g, b] = rgb.match(/\d+/g).map(Number); return (r + g + b) / 3 > 128; };
    check(`phone ${theme}: the bar above the app follows the page's appearance`, bar.theme === theme && light(bar.bg) === (theme === 'light') && light(bar.color) !== light(bar.bg) && bar.items.join() === '‹ tabcomputer,Share', JSON.stringify(bar));
    await shot(page, `${D}-app-mode`);
    await page.tap('.tc-app-back button');
    await page.waitForSelector('.tc-overlay .tc-app-share', { timeout: 10_000 }).catch(() => null);
    const shared = await page.evaluate(() => { const el = document.querySelector('.tc-overlay .tc-app-share'); if (!el) return null; const r = el.getBoundingClientRect(); return { title: el.querySelector('h3').textContent, link: el.querySelector('textarea')?.value ?? '', fits: r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, theme: el.parentElement.dataset.tcTheme }; });
    check('phone share: Share in the bar shows the link over the app, in the same appearance', !!shared && shared.title === 'Share Make a scanned PDF searchable, page by page' && /#name=|\?app=link#app=/.test(shared.link) && shared.fits && shared.theme === theme, JSON.stringify(shared));
    await shot(page, `${D}-share`);
    await page.tap('.tc-app-share [data-act=close]');
    await page.goto(`${url}?unbecome`);
    await booted(page);
  }

  // a table: no file until the first row; and it says so when saving has become slow
  await side(page, 'app install examples/expenses; rm -f /home/user/.local/share/apps/expenses/expenses.csv');
  await side(page, 'app stop expenses');
  f = (await openApp(page, 'expenses')).f;
  if (f) {
    const FILE = '/home/user/.local/share/apps/expenses/expenses.csv';
    const fresh = { rows: await f.evaluate(() => window.__app.rows.length), file: (await side(page, `ls ${FILE} 2>&1`)).o.trim(), note: await f.evaluate(() => document.querySelector('.note').textContent), mark: await page.evaluate(() => document.querySelector('.sd-win[data-app="expenses"] .tc-app-backup:not([hidden])')?.textContent ?? '') };
    check(`${D} table: an app that was only opened has no file yet, and nothing to back up`, fresh.rows === 0 && /No such file/.test(fresh.file) && fresh.mark === '' && fresh.note === 'The table is kept on this computer, in ~/.local/share/apps/expenses/expenses.csv.', JSON.stringify(fresh));
    const sizes = [];
    for (const n of [1000, 5000, 20_000]) {
      await page.evaluate(async ([file, n]) => { await window.__tabcomputer.fs.writeFile(file, 'Date,What,Category,Amount,Paid back\n' + Array.from({ length: n }, (_, i) => `2026-10-01,Thing number ${i},Food,${i % 90}.5,\n`).join('')); }, [FILE, n]);
      const t1 = Date.now();
      await until(page, () => f.evaluate((n) => window.__app.rows.length === n, n), 120_000);
      const drawn = Date.now() - t1;
      const t0 = Date.now();
      const before = await f.evaluate(() => window.__app.saves);
      await f.evaluate(() => { const box = document.querySelector('tbody tr input[type=text]'); box.value = 'changed'; box.dispatchEvent(new Event('change', { bubbles: true })); });
      await until(page, () => f.evaluate((b) => window.__app.saves > b, before), 120_000);
      sizes.push([n, Date.now() - t0, await f.evaluate(() => document.querySelector('[role=status]').textContent), drawn]);
    }
    console.log(`  ${D} table: ${sizes.map(([n, ms, , drawn]) => `${n.toLocaleString('en')} rows: shown in ${drawn} ms, one edit saved in ${ms} ms`).join('; ')}`);
    time(`${D} table: one edit of 20,000 rows, to saved`, sizes[2][1]);
    const slow = sizes.find(([, , note]) => / Each change saves all /.test(note));
    check(`${D} table: the note says the cost of an edit only once it is slow, with the time it took`, sizes[0][2] === 'Saved.' && (!slow || /^Saved\. Each change saves all [\d,]+ rows, which took \d+\.\d seconds: a table this large is slow to edit here\.$/.test(slow[2]))
      && await f.evaluate(() => { const s = document.querySelector('[role=status]'), t = document.querySelector('table'); return s.getBoundingClientRect().top < t.getBoundingClientRect().top; }), JSON.stringify(sizes.map(([n, ms, said]) => [n, ms, said])));
    if (slow) await shot(page, `${D}-table-large`);
    await side(page, `app stop expenses; rm -f ${FILE}`);
  }

  // an app in a repository whose app.json names no page: the index.html in public/ is its page, as for a gist
  await page.goto(`${url}?app=gh:someone/pageapp`);
  await page.waitForSelector('.tc-app-prompt', { timeout: 60_000 }).catch(() => null);
  const asked = await promptSays(page);
  check(`${D} gh: an app with its own page and no entry is shown like any app from a repository`, asked?.title === 'Install Page app?' && asked.says[0] === `From github.com/someone/pageapp at commit ${COMMIT.slice(0, 10)}. Not reviewed by tabcomputer.` && asked.buttons.join() === 'Cancel,Install'
    && asked.says.at(-1) === 'Its page runs on an address of its own: it cannot read this tab\'s files or sign-ins.', JSON.stringify(asked));
  if (touch) check('phone gh: the prompt fills the screen', asked?.box.left === 0 && asked.box.top === 0 && asked.box.right === device.viewport.width && asked.box.bottom === device.viewport.height, JSON.stringify(asked?.box));
  await shot(page, `${D}-page-app-prompt`);
  await page.waitForFunction(() => !document.querySelector('.tc-app-prompt [data-act=install]')?.disabled, null, { timeout: 5000 }).catch(() => {});
  await page.click('.tc-app-prompt [data-act=install]');
  const own = await ready(page, 'pageapp', 40_000);
  check(`${D} gh: Install opens its own page`, !!own && await own.evaluate(() => document.getElementById('own')?.textContent) === 'its own page' && (await side(page, 'cat ~/Apps/pageapp/app.json')).o.includes('"Page app"'), (await side(page, 'ls -R ~/Apps/pageapp 2>&1')).o);
  await page.context().close();
}

// ── progress: a real program whose result is its standard output ──
// gawk, from this server's own packages (no Debian, no other site): what it says on stderr shows
// while it runs, also when it says one line and then works in silence, as an OCR program does.
if (wants('progress')) {
  await relaunch();
  const page = await newTab(WIDE);
  await page.goto(url);
  await booted(page);
  const got = await side(page, 'pkg install gawk && which gawk');
  if (got.code !== 0) console.log(`skip progress: gawk did not install from this server: ${got.o.slice(-200)}`);
  else {
    const busy = 'for (j = 0; j < 1500000; j++) x = j';
    const watch = async (id, run) => {
      await put(page, { [`/home/user/${id}/app.json`]: JSON.stringify({ name: id, run }) });
      await side(page, `app install /home/user/${id}`);
      const { f } = await openApp(page, id);
      if (!f) return null;
      await f.evaluate(async () => { window.__app.take(await tab.files.import([{ file: new File(['one\ntwo\n'], 'a.txt'), rel: 'a.txt' }], { dir: window.__app.dirs.in + '/1' })); });
      const dirs = await f.evaluate(() => window.__app.dirs);
      const seen = [];
      const t0 = Date.now();
      for (;;) {
        const row = await f.evaluate(() => { const r = window.__app.rows[0]; return r ? { status: r.status, says: r.li.querySelector('.why')?.textContent ?? '' } : null; });
        if (row?.status === 'working' && row.says && seen.at(-1)?.says !== row.says) seen.push({ says: row.says, at: Date.now() - t0 });
        if ((row && row.status !== 'working' && row.status !== 'waiting') || Date.now() - t0 > 90_000) return { seen, status: row?.status, ms: Date.now() - t0, out: (await side(page, `cat ${dirs.out}/a.txt; ls -A ${dirs.in}`)).o };
        await page.waitForTimeout(40);
      }
    };
    const steps = await watch('steps', `gawk 'BEGIN { for (i = 1; i <= 6; i++) { print "page " i " of 6" > "/dev/stderr"; ${busy} } } { print }' {in}`);
    check('1280 progress: a program that writes its result to standard output shows each line it says while it runs', !!steps && steps.status === 'done' && steps.seen.length >= 4 && steps.seen.every((x) => /^page \d of 6$/.test(x.says)) && steps.out === 'one\ntwo\n1\n', JSON.stringify(steps));
    const once = await watch('once', `gawk 'BEGIN { print "Reading the page" > "/dev/stderr"; for (i = 1; i <= 3; i++) { ${busy} } } { print }' {in}`);
    check('1280 progress: one line and then silence: the line shows while the program works', !!once && once.status === 'done' && once.seen.length === 1 && once.seen[0].says === 'Reading the page' && once.seen[0].at < once.ms - 1000, JSON.stringify(once));
    if (steps) time('1280 progress: six steps of a real program, to done', steps.ms);
  }
  await page.context().close();
}

// ── links: the phone, the Welcome card, the key row, a gist ──
if (wants('links')) {
  await relaunch();
  // a first visit on a phone, by an app link: the app, not the desktop
  let page = await newTab(PHONE, { welcome: true });
  const t0 = Date.now();
  await page.goto(`${url}?app=jq-playground`);
  let f = await ready(page, 'jq-playground', 90_000);
  time('phone link: ?app=jq-playground to usable page (first visit)', Date.now() - t0);
  const first = f ? await until(page, () => f.evaluate(() => (window.__app.runs >= 1 ? document.querySelector('pre').textContent : null))) : null;
  time('phone link: ?app=jq-playground to its first result (first visit)', Date.now() - t0);
  // On a phone the app opens on the whole screen of the phone layout, with the pill (docs/DESKTOP.md "Phone";
  // tests/browser/phone-layout.mjs checks the layout itself)
  const mode = await page.evaluate(() => {
    const w = window.__tabcomputer.desktop.windows().find((x) => x.appId === 'jq-playground');
    const r = w?.el?.getBoundingClientRect?.();
    return { welcome: !!document.querySelector('.sd-welcome'), pill: !!document.querySelector('.sd-pill, [class*=pill]'), w: r ? Math.round(r.width) : null, vw: innerWidth };
  });
  check('phone link: the app opens on the whole screen and works', !!f && first === '"Ada"\n"Grace"\n' && (mode.w === null || mode.w === mode.vw), JSON.stringify(mode));
  check('phone link: no Welcome card over the app', !mode.welcome);
  check('phone link: the pill is there to leave it', mode.pill, JSON.stringify(mode));
  await shot(page, 'phone-link');
  await page.reload();
  f = await ready(page, 'jq-playground', 60_000);
  check('phone link: a reload comes back to the app', !!f);
  await page.context().close();

  // the key row belongs to terminals
  page = await newTab(PHONE);
  await page.goto(url);
  await booted(page);
  const bar = () => page.evaluate(() => { const b = document.querySelector('.sd-keybar'); return !!b && !b.hidden && b.offsetHeight > 0; });
  const withTerminal = await until(page, bar, 8000);
  await side(page, 'app install examples/expenses');
  await side(page, 'app open expenses');
  await ready(page, 'expenses');
  const withApp = await until(page, async () => !(await bar()), 5000);
  await shot(page, 'phone-window');
  await page.evaluate(() => window.__tabcomputer.desktop.windows().find((w) => w.appId === 'terminal').focus());
  const again = await until(page, bar, 5000);
  // (in the phone layout the key row rides on the on-screen keyboard, so with no keyboard it is never shown;
  //  tests/browser/phone-layout.mjs checks it with the keyboard up)
  check('phone: the terminal key row is never over an app\'s window', withApp, JSON.stringify({ withTerminal, withApp, again }));
  await page.context().close();

  // 1280: a first visit by an app link: the app in a window, and no Welcome card
  page = await newTab(WIDE, { welcome: true });
  const t1 = Date.now();
  await page.goto(`${url}?app=expenses`);
  f = await ready(page, 'expenses', 90_000);
  time('1280 link: ?app=expenses to usable page (first visit)', Date.now() - t1);
  await page.waitForTimeout(1500);
  const wide = await page.evaluate(() => ({ welcome: !!document.querySelector('.sd-welcome'), become: document.body.classList.contains('become-active'), win: !!document.querySelector('.sd-win iframe[data-app="expenses"]') }));
  check('1280 link: the app in a window on the desktop, no Welcome card', !!f && !wide.welcome && !wide.become && wide.win, JSON.stringify(wide));
  await shot(page, '1280-link');
  await page.goto(url);
  await booted(page);
  check('1280 link: the Welcome card shows on the next visit without a link', await until(page, () => page.evaluate(() => !!document.querySelector('.sd-welcome')), 10_000));
  await page.context().close();

  // a gist that holds one app.json
  for (const device of [WIDE, PHONE]) {
    page = await newTab(device);
    const t2 = Date.now();
    await page.goto(`${url}?app=gist:${GIST}`);
    await page.waitForSelector('.tc-app-prompt', { timeout: 60_000 }).catch(() => null);
    time(`${device.name} gist link: to the install prompt`, Date.now() - t2);
    const prompt = await page.evaluate(() => {
      const el = document.querySelector('.tc-app-prompt');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { text: el.innerText.replace(/\s*\n\s*/g, ' '), left: Math.round(r.left), right: Math.round(r.right), sw: el.scrollWidth, cw: el.clientWidth, focus: document.activeElement?.getAttribute('data-act'), installed: !!document.querySelector('iframe[data-app]') };
    });
    check(`${device.name} gist: asked first, in sentences: where from, the exact command`, !!prompt && !prompt.installed && prompt.focus === 'cancel'
      && prompt.text.includes(`From gist.github.com/${GIST} at revision ${REV.slice(0, 10)}`)
      && prompt.text.includes('Upper case runs this command once for each file you give it: sed -e s/a/A/g {in}')
      && prompt.text.includes('sed is an ordinary program in this tab'), prompt?.text.slice(0, 300));
    check(`${device.name} gist: the prompt fits`, !!prompt && prompt.left >= 0 && prompt.right <= device.viewport.width && prompt.sw <= prompt.cw, JSON.stringify(prompt && { left: prompt.left, right: prompt.right, sw: prompt.sw, cw: prompt.cw }));
    await shot(page, `${device.name}-gist-prompt`);
    await page.waitForFunction(() => !document.querySelector('.tc-app-prompt [data-act=install]')?.disabled, null, { timeout: 5000 }).catch(() => {});
    const t3 = Date.now();
    await page.click('.tc-app-prompt [data-act=install]');
    f = await ready(page, 'upper-case', 40_000);
    time(`${device.name} gist link: Install to usable page`, Date.now() - t3);
    const src = (await side(page, 'app list')).o;
    // (on a phone it opens on the whole screen of the phone layout, not in app mode: tests/browser/phone-layout.mjs)
    check(`${device.name} gist: Install installs that revision, and it opens`, !!f && src.includes(`gist:${GIST}@${REV}`), src.trim().split('\n').pop());
    const share = (await side(page, 'app share upper-case --print')).o.trim();
    check(`${device.name} gist: app share gives the gist's link`, share === `${new URL(url).origin}/?app=gist:${GIST}`, share);
    await page.context().close();
  }
}

// ── share: how long each example's link is ──
if (wants('share')) {
  await relaunch();
  const page = await newTab(WIDE);
  await page.goto(url);
  await booted(page);
  const lengths = {};
  for (const id of ['searchable-pdf', 'jq-playground', 'expenses']) {
    // installed from a folder, as its author has it: the link carries the one file
    await put(page, { [`/home/user/mine/${id}/app.json`]: example(id) });
    // (searchable-pdf needs a Debian package, which this run does not install: registered without preparing)
    const inst = id === 'searchable-pdf'
      ? await page.evaluate(async (dir) => {
        const fs = window.__tabcomputer.fs;
        await fs.mkdir('/home/user/Apps/searchable-pdf', { recursive: true });
        await fs.writeFile('/home/user/Apps/searchable-pdf/app.json', await fs.readFile(`${dir}/app.json`));
        const reg = JSON.parse(await fs.readFile('/var/lib/tabcomputer/apps.json', 'utf8').catch(() => '{"v":1,"apps":{}}'));
        reg.apps['searchable-pdf'] = { id: 'searchable-pdf', name: 'Make scans searchable', version: '', dir: '/home/user/Apps/searchable-pdf', source: `dir:${dir}`, installedAt: Date.now(), icon: '' };
        await fs.mkdir('/var/lib/tabcomputer', { recursive: true });
        await fs.writeFile('/var/lib/tabcomputer/apps.json', JSON.stringify(reg));
        return { code: 0 };
      }, `/home/user/mine/${id}`)
      : await side(page, `app install /home/user/mine/${id}`);
    const link = (await side(page, `app share ${id} --print`)).o.trim();
    lengths[id] = link.length;
    // (an app that is one app.json is shared as words after the #: src/link-fragment.ts)
    check(`share: ${id}'s link is its one file, written out, in a few hundred characters`, inst.code === 0 && /\/#name=[A-Za-z0-9\-._~!$'()*+,;=:@/?&%]+$/.test(link) && link.length < 700, `${link.length} characters (${example(id).length} bytes of app.json)`);
  }
  // for comparison: an app with a page of its own (what every such app was before)
  await side(page, 'cd /home/user && app new own --page && app install own && app new one && app install one');
  lengths['app new --page (five files)'] = (await side(page, 'app share own --print')).o.trim().length;
  lengths['app new (one file)'] = (await side(page, 'app share one --print')).o.trim().length;
  // an app this site ships is shared by its id
  await side(page, 'app install examples/expenses');
  lengths['expenses, installed from the site'] = (await side(page, 'app share expenses --print')).o.trim().length;
  console.log('share link lengths, in characters (origin ' + new URL(url).origin + '):');
  for (const [k, v] of Object.entries(lengths)) console.log(`  ${String(v).padStart(5)}  ${k}`);
  const said = await side(page, 'app check /home/user/mine/searchable-pdf');
  check('app check prints the example as sentences', said.code === 0 && /runs this command once for each file you give it: tesseract \{in\} stdout pdf/.test(said.o) && /installs the Debian package tesseract-ocr/.test(said.o), said.o.trim().split('\n')[2]);
  await page.context().close();
}

// ── 360 px: each kind fits ──
if (wants('narrow')) {
  await relaunch();
  const page = await newTab({ name: '360', viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
  await page.goto(url);
  await booted(page);
  await side(page, 'cd /home/user && app new tidy && app install tidy && app install examples/jq-playground && app install examples/expenses');
  await put(page, { '/home/user/.local/share/apps/expenses/expenses.csv': 'Date,What,Category,Amount,Paid back\n2026-10-01,A long description of something that was bought on a long day,Travel,1234567.89,yes\n' });
  for (const id of ['tidy', 'jq-playground', 'expenses']) {
    const { f } = await openApp(page, id);
    const s = f ? await f.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth, small: [...document.querySelectorAll('button, input:not([type=checkbox]), select')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 36).length })) : null;
    check(`360 px: ${id} fits, and its controls are finger sized`, !!s && s.w === 360 && s.sw <= s.w && s.small === 0, JSON.stringify(s));
    await shot(page, `360-${id}`);
  }
  await page.context().close();
}

closing = true;
await browser.close();
console.log('\ntimes (ms):');
for (const [name, ms] of times) console.log(`  ${String(ms).padStart(6)}  ${name}`);
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
