// Apps that are their manifest (docs/APPS.md "The manifest alone") in Chromium, against a
// local server with no Debian: every command used is built in, and GitHub is stood in for.
//
//   npx vite build && PORT=6641 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/app-declarative.mjs [URL] [--shots DIR] [--only NAME]
//
// Each kind at 1280 px and at a 390 x 844 touch screen:
//   files   app new → install → open; three files, two with one name and one the program
//           refuses; each result alone and all as a zip; a folder's structure; by keyboard only
//   form    Run, output as it is written, Stop; a live form (the jq playground example)
//   table   add, edit, sort, filter, total; a reload finds the data; another program's
//           change shows; CSV and SQLite
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
const only = opt('--only');
const url = args[0] || 'http://localhost:6641/';
if (shots) mkdirSync(shots, { recursive: true });
const results = [];
const times = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const time = (name, ms) => { times.push([name, Math.round(ms)]); };
const wants = (name) => !only || only === name;
const example = (id) => readFileSync(join(ROOT, 'apps/examples', id, 'app.json'), 'utf8');

const browser = await pw.chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
const WIDE = { name: '1280', viewport: { width: 1280, height: 800 } };
const PHONE = { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

// ── a stand-in for GitHub: one gist holding one file ──
const GIST = 'abcdef0123456789abcdef0123456789';
const REV = 'beef'.padEnd(40, '1');
const GIST_APP = '{\n  "name": "Upper case",\n  "about": "Makes a copy of each text file with every a as a capital A.",\n  "accept": [".txt"],\n  "run": "sed -e s/a/A/g {in}"\n}\n';
const touchPages = new WeakSet();
async function newTab(device, { welcome = false } = {}) {
  const { name: _n, ...opts } = device;
  const context = await browser.newContext({ ...opts, acceptDownloads: true });
  await context.route('https://api.github.com/**', (route) => {
    const u = route.request().url();
    if (u !== `https://api.github.com/gists/${GIST}`) return route.fulfill({ status: 404, contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' }, body: 'Not Found' });
    return route.fulfill({
      status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.stringify({ id: GIST, owner: { login: 'octocat' }, history: [{ version: REV }], files: { 'app.json': { filename: 'app.json', truncated: false, content: GIST_APP } } }),
    });
  });
  const page = await context.newPage();
  if (device.hasTouch) touchPages.add(page);
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  if (!welcome) await page.addInitScript(() => { try { if (window.top === window) localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
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
  const frame = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y }; }, FRAME(id));
  const el = await f.evaluate((target) => { const e = typeof target === 'string' ? document.querySelector(target) : null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, target);
  // (a finger where the screen is a touch screen: a file picker opens only for a real tap)
  if (touchPages.has(page)) await page.touchscreen.tap(frame.x + el.x, frame.y + el.y);
  else await page.mouse.click(frame.x + el.x, frame.y + el.y);
}
const ready = (page, id, ms = 40_000) => until(page, async () => { const f = await inner(page, id); return (await f?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1')) ? f : null; }, ms);
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };
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
    check(`${D} files: says where the files stay`, /Your files stay on this computer\./.test(ui.text));
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
      await f.evaluate(() => { const i = document.querySelector('input[type=text]'); i.value = '.people['; i.dispatchEvent(new Event('input', { bubbles: true })); });
      const err = await until(page, () => f.evaluate(() => (/status/.test(document.querySelector('[role=status]').textContent) ? document.querySelector('pre').textContent : null)), 8000);
      check(`${D} live: a filter jq refuses shows jq's own words`, !!err && err.trim() !== '' && err !== '3\n', JSON.stringify(err).slice(0, 120));
      await shot(page, `${D}-form-live`);
      check(`${D} live: nothing scrolls sideways`, await fits(f).then((s) => s.sw <= s.w));
    }
    await page.context().close();
  }

  // ── table ──
  if (wants('table')) {
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
    if (touch) await side(page, 'app open expenses');
    f = await ready(page, 'expenses');
    const back = f ? await until(page, () => f.evaluate(() => (window.__app.rows.length === 4 ? window.__app.rows.map((r) => r[1]).join() : null))) : null;
    time(`${D} table: a reload to the table with its data${touch ? ' (opened again)' : ' (its window restored)'}`, Date.now() - t3);
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

// ── links: the phone, the Welcome card, the key row, a gist ──
if (wants('links')) {
  // a first visit on a phone, by an app link: the app, not the desktop
  let page = await newTab(PHONE, { welcome: true });
  const t0 = Date.now();
  await page.goto(`${url}?app=jq-playground`);
  let f = await ready(page, 'jq-playground', 90_000);
  time('phone link: ?app=jq-playground to usable page (first visit)', Date.now() - t0);
  const first = f ? await until(page, () => f.evaluate(() => (window.__app.runs >= 1 ? document.querySelector('pre').textContent : null))) : null;
  time('phone link: ?app=jq-playground to its first result (first visit)', Date.now() - t0);
  const mode = await page.evaluate(() => ({
    become: document.body.classList.contains('become-active'), path: location.pathname, search: location.search, title: document.title,
    welcome: !!document.querySelector('.sd-welcome'), back: document.querySelector('.tc-app-back a')?.textContent,
    frame: (() => { const r = document.querySelector('#become-container iframe')?.getBoundingClientRect(); return r ? { w: Math.round(r.width), top: Math.round(r.top), h: Math.round(r.height) } : null; })(),
  }));
  check('phone link: the tab is the app, at its own address', !!f && mode.become && mode.path === '/jq-playground' && mode.search === '' && mode.title === 'jq playground' && first === '"Ada"\n"Grace"\n', JSON.stringify(mode));
  check('phone link: no Welcome card over the app', !mode.welcome);
  check('phone link: a small control leads to the desktop', /tabcomputer/.test(mode.back ?? '') && mode.frame?.w === 390 && mode.frame.top <= 40, JSON.stringify(mode.frame));
  await shot(page, 'phone-link');
  await page.reload();
  f = await ready(page, 'jq-playground', 60_000);
  check('phone link: a reload comes back to the app, with the control', !!f && await page.evaluate(() => !!document.querySelector('.tc-app-back a')));
  await page.click('.tc-app-back a');
  await booted(page);
  const desk = await until(page, () => page.evaluate(() => (!document.body.classList.contains('become-active') && !!document.querySelector('.sd-welcome') ? location.pathname : null)), 15_000);
  check('phone link: the control opens the desktop, and the Welcome card shows now', desk === '/', String(desk));
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
  check('phone: the terminal key row shows for a terminal, not over an app\'s window', withTerminal && withApp && again, JSON.stringify({ withTerminal, withApp, again }));
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
      return { text: el.innerText, left: Math.round(r.left), right: Math.round(r.right), sw: el.scrollWidth, cw: el.clientWidth, focus: document.activeElement?.getAttribute('data-act'), installed: !!document.querySelector('iframe[data-app]') };
    });
    check(`${device.name} gist: asked first, in sentences: where from, the exact command`, !!prompt && !prompt.installed && prompt.focus === 'cancel'
      && prompt.text.includes(`From gist.github.com/${GIST} at revision ${REV.slice(0, 10)}`)
      && prompt.text.includes('Upper case runs this command once for each file you give it: sed -e s/a/A/g {in}')
      && prompt.text.includes('sed is an ordinary program in this tab'), prompt?.text.replace(/\n+/g, ' | ').slice(0, 300));
    check(`${device.name} gist: the prompt fits`, !!prompt && prompt.left >= 0 && prompt.right <= device.viewport.width && prompt.sw <= prompt.cw, JSON.stringify(prompt && { left: prompt.left, right: prompt.right, sw: prompt.sw, cw: prompt.cw }));
    await shot(page, `${device.name}-gist-prompt`);
    await page.waitForFunction(() => !document.querySelector('.tc-app-prompt [data-act=install]')?.disabled, null, { timeout: 5000 }).catch(() => {});
    const t3 = Date.now();
    await page.click('.tc-app-prompt [data-act=install]');
    f = await ready(page, 'upper-case', 40_000);
    time(`${device.name} gist link: Install to usable page`, Date.now() - t3);
    const src = (await side(page, 'app list')).o;
    check(`${device.name} gist: Install installs that revision, and it opens${device.hasTouch ? ' as the app' : ''}`, !!f && src.includes(`gist:${GIST}@${REV}`) && (await page.evaluate(() => document.body.classList.contains('become-active'))) === !!device.hasTouch, src.trim().split('\n').pop());
    const share = (await side(page, 'app share upper-case --print')).o.trim();
    check(`${device.name} gist: app share gives the gist's link`, share === `${new URL(url).origin}/?app=gist:${GIST}`, share);
    await page.context().close();
  }
}

// ── share: how long each example's link is ──
if (wants('share')) {
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
        reg.apps['searchable-pdf'] = { id: 'searchable-pdf', name: 'Make a scanned PDF searchable', version: '', dir: '/home/user/Apps/searchable-pdf', source: `dir:${dir}`, installedAt: Date.now(), icon: '' };
        await fs.mkdir('/var/lib/tabcomputer', { recursive: true });
        await fs.writeFile('/var/lib/tabcomputer/apps.json', JSON.stringify(reg));
        return { code: 0 };
      }, `/home/user/mine/${id}`)
      : await side(page, `app install /home/user/mine/${id}`);
    const link = (await side(page, `app share ${id} --print`)).o.trim();
    lengths[id] = link.length;
    check(`share: ${id}'s link carries its one file in a few hundred characters`, inst.code === 0 && /\?app=link#app=[A-Za-z0-9_-]+$/.test(link) && link.length < 700, `${link.length} characters (${example(id).length} bytes of app.json)`);
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
  check('app check prints the example as sentences', said.code === 0 && /runs this command once for each file you give it: ocrmypdf \{in\} \{out\}/.test(said.o) && /installs the Debian package ocrmypdf/.test(said.o), said.o.trim().split('\n')[2]);
  await page.context().close();
}

// ── 360 px: each kind fits ──
if (wants('narrow')) {
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

await browser.close();
console.log('\ntimes (ms):');
for (const [name, ms] of times) console.log(`  ${String(ms).padStart(6)}  ${name}`);
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
