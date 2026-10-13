// Export and import of an app with its data (src/apps/export.ts, docs/APPS.md "Export and
// import", tabcomputer#138) in Chromium, at 1280 px and on a 390 x 844 touch screen. Needs a
// build and a running server; no Debian and no network:
//   npx vite build && PORT=6641 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/app-export.mjs [URL] [--shots DIR] [--theme light|dark]
//
//   mark      an app that was only opened says nothing; after its first row its window says
//             "Not backed up", with Export beside it; Export saves one file and the mark goes;
//             a later change brings it back with the time of the export
//   file      the file is a zip: a header, the app's files, its data
//   import    app import FILE on a computer without the app: an app this site ships is installed
//             from the site without a question, another app is shown first; the data is there
//   replace   the file dropped on the desktop over other data: the question names each file that
//             would be replaced and when it changed; Cancel changes nothing; Replace restores
// Exits 1 if any check fails.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';

const pw = loadPlaywright();
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const theme = opt('--theme') === 'light' ? 'light' : 'dark';
const url = args[0] || 'http://localhost:6641/';
if (shots) mkdirSync(shots, { recursive: true });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`); if (!ok) failures++; };

let browser;
const WIDE = { name: '1280', viewport: { width: 1280, height: 800 } };
const PHONE = { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const touchPages = new WeakSet();

async function newTab(device) {
  const { name: _n, ...opts } = device;
  const context = await browser.newContext({ ...opts, acceptDownloads: true });
  const page = await context.newPage();
  if (device.hasTouch) touchPages.add(page);
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  page.on('crash', () => console.log('the page crashed'));
  await page.addInitScript((theme) => { try { if (window.top === window) { localStorage.setItem('tabcomputer-desktop-welcome', '1'); localStorage.setItem('tabcomputer-desktop-theme', theme); } } catch {} }, theme);
  return page;
}
const booted = (page) => page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished') && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
const side = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__tabcomputer.shell.fork(); s.terminal = null; s.cwd = '/home/user'; let o = '';
  const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  return { code, o: o.replace(/\r\n/g, '\n') };
}, cmd);
const until = async (page, fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(80); } };
const FRAME = (id) => `iframe[data-app="${id}"]`;
async function inner(page, id) {
  const outer = await (await page.$(FRAME(id)))?.contentFrame();
  if (!outer) return null;
  return /\/__tabcomputer\/frame\.html/.test(outer.url()) ? outer.childFrames()[0] ?? null : outer;
}
const ready = (page, id, ms = 40_000) => until(page, async () => { const f = await inner(page, id); return (await f?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1')) ? f : null; }, ms);
const shot = async (page, name) => { if (shots) { await page.waitForTimeout(450); await page.screenshot({ path: join(shots, `${name}.png`) }); } };
const openApp = async (page, id) => { await side(page, `app open ${id}`); return ready(page, id); };
/** A real click or tap on something in the tab's own page */
const press = (page, sel) => (touchPages.has(page) ? page.tap(sel) : page.click(sel));
/** The mark under an app's page: its words and its button, or null while it says nothing */
const mark = (page) => page.evaluate(() => { const el = document.querySelector('.tc-app-backup:not([hidden])'); return el ? { says: el.querySelector('span').textContent, button: el.querySelector('button').textContent, bottom: Math.round(el.getBoundingClientRect().bottom), fits: el.scrollWidth <= el.clientWidth } : null; });
/** Add a row to a table app and fill its first text cell */
async function addRow(page, f, what) {
  const before = await f.evaluate(() => window.__app.saves);
  await f.evaluate(() => document.getElementById('add').click());
  await until(page, () => f.evaluate((b) => window.__app.saves > b, before));
  await f.evaluate((what) => { const box = [...document.querySelectorAll('tbody tr:last-child input[type=text]')][0]; box.value = what; box.dispatchEvent(new Event('change', { bubbles: true })); }, what);
  await until(page, () => f.evaluate((b) => window.__app.saves > b + 1, before));
}
const rowsOf = (f) => f.evaluate(() => window.__app.rows.map((r) => r.find((c) => c && !/^\d{4}-/.test(c)) ?? '').join());
/** A prompt of the toolkit: what it says at once, its buttons, where it is */
const prompt = (page) => page.evaluate(() => {
  const el = document.querySelector('.tc-app-prompt');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    title: el.querySelector('h3')?.textContent ?? '', says: [...el.querySelectorAll(':scope > p')].map((p) => p.innerText.replace(/\s*\n\s*/g, ' ')), lines: [...el.querySelectorAll('li')].map((li) => li.textContent),
    buttons: [...el.querySelectorAll('[class$=actions] button')].map((b) => b.textContent), focus: document.activeElement?.textContent,
    box: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)], fits: el.scrollWidth <= el.clientWidth,
  };
});
const agree = async (page) => {
  await page.waitForFunction(() => { const b = document.querySelector('.tc-app-prompt [data-act=install]'); return b && !b.disabled; }, null, { timeout: 10_000 });
  await press(page, '.tc-app-prompt [data-act=install]');
};
/** Drop a file on the desktop, as a person does with one from their own disk */
const drop = (page, name, bytes) => page.evaluate(([name, b64]) => {
  const data = new DataTransfer();
  data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], name, { type: 'application/zip' }));
  const target = document.querySelector('.sd-desktop') ?? document.body;
  for (const type of ['dragover', 'drop']) target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
}, [name, Buffer.from(bytes).toString('base64')]);
const CSV = '/home/user/.local/share/apps/expenses/expenses.csv';
const TODAY = /^\d\d:\d\d$/;

for (const device of [WIDE, PHONE]) {
  const D = device.name;
  const touch = !!device.hasTouch;
  browser = await pw.chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
  const page = await newTab(device);
  await page.goto(url);
  await booted(page);
  const dir = mkdtempSync(join(tmpdir(), 'tc-export-'));

  // ── the mark ──
  await side(page, 'app install examples/expenses');
  let f = await openApp(page, 'expenses');
  check(`${D} mark: an app that was only opened says nothing about a backup`, !!f && await mark(page) === null);
  await addRow(page, f, 'Train to Leeds');
  await addRow(page, f, 'Lunch');
  let m = await until(page, () => mark(page), 8000);
  check(`${D} mark: with data that is in no file, the window says "Not backed up", with Export beside it`, m?.says === 'Not backed up' && m.button === 'Export' && m.fits, JSON.stringify(m));
  await shot(page, `${D}-not-backed-up`);

  // ── Export: one file, and the mark goes ──
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 15_000 }), press(page, '.tc-app-backup button')]);
  const saved = join(dir, file.suggestedFilename());
  await file.saveAs(saved);
  const names = execFileSync('unzip', ['-Z1', saved], { encoding: 'utf8' }).trim().split('\n');
  check(`${D} file: Export saves one zip: a header, the app's files, its data`, /^expenses-\d{4}-\d\d-\d\d\.app\.zip$/.test(file.suggestedFilename()) && names.join() === 'tabcomputer-app.json,app/app.json,data/expenses.csv', `${file.suggestedFilename()}: ${names.join()}`);
  const header = JSON.parse(execFileSync('unzip', ['-p', saved, 'tabcomputer-app.json'], { encoding: 'utf8' }));
  const data = execFileSync('unzip', ['-p', saved, 'data/expenses.csv'], { encoding: 'utf8' });
  check(`${D} file: the header names the app and where it came from; the data is the table`, header.format === 1 && header.id === 'expenses' && header.name === 'Expenses' && header.source === 'site' && /Train to Leeds/.test(data) && /Lunch/.test(data), JSON.stringify(header));
  check(`${D} mark: after the export the window says nothing`, await until(page, async () => await mark(page) === null, 5000));
  await addRow(page, f, 'Stamps');
  m = await until(page, () => mark(page), 8000);
  check(`${D} mark: a change after it brings the mark back, with when the export was`, !!m && /^Not backed up since \d\d:\d\d$/.test(m.says), JSON.stringify(m));
  await shot(page, `${D}-not-backed-up-since`);

  // ── the command, and another computer ──
  const exp = await side(page, 'app export expenses backups/mine');
  check(`${D} file: app export ID FILE writes the file here and says how to bring it back`, exp.code === 0 && /^Exported Expenses with its data to ~\/backups\/mine\.app\.zip: 1 file of the app, 1 file of data, \d+ KB\.\nTo bring it back, here or on another computer: app import ~\/backups\/mine\.app\.zip, or drop the file on the desktop\.\n$/.test(exp.o), exp.o);
  check(`${D} mark: and the mark is gone again`, await until(page, async () => await mark(page) === null, 5000));
  await side(page, 'app remove expenses --data');
  const gone = await side(page, `ls ${CSV} ~/Apps/expenses 2>&1`);
  const imp = await side(page, 'app import backups/mine.app.zip');
  // (an app this site ships is installed from the site: no question; nothing was here to replace)
  check(`${D} import: on a computer without it, an app this site ships comes back with its data and no question`, !/expenses\.csv$/m.test(gone.o) && imp.code === 0 && /^Installed Expenses \(expenses\) and restored its data \(1 file\)\./.test(imp.o) && await prompt(page) === null, imp.o);
  f = await openApp(page, 'expenses');
  check(`${D} import: the rows are there, and the window says nothing about a backup`, !!f && await rowsOf(f) === 'Train to Leeds,Lunch,Stamps' && await mark(page) === null, f ? await rowsOf(f) : 'no window');

  // ── dropped on the desktop over other data ──
  await addRow(page, f, 'Light bulbs');
  await until(page, () => mark(page), 8000);
  await drop(page, file.suggestedFilename(), readFileSync(saved));
  await page.waitForSelector('.tc-app-prompt', { timeout: 15_000 }).catch(() => null);
  let q = await prompt(page);
  check(`${D} replace: the question says what the file holds and names the file that would be replaced, with when it changed`, !!q && q.title === 'Replace the data Expenses has here?'
    && /^The file holds 1 file of data, exported today at \d\d:\d\d\. Importing it replaces what Expenses has here:$/.test(q.says[0]) && q.lines.length === 1 && /^expenses\.csv, changed today at \d\d:\d\d$/.test(q.lines[0])
    && q.buttons.join() === 'Cancel,Replace' && q.focus === 'Cancel' && q.fits, JSON.stringify(q));
  if (touch) check('phone replace: the question fills the screen', !!q && q.box.join() === `0,0,${device.viewport.width},${device.viewport.height}`, JSON.stringify(q?.box));
  await shot(page, `${D}-replace-question`);
  await press(page, '.tc-app-prompt [data-act=cancel]');
  await page.waitForTimeout(600);
  check(`${D} replace: Cancel changes nothing`, await prompt(page) === null && /Light bulbs/.test((await side(page, `cat ${CSV}`)).o));
  await drop(page, file.suggestedFilename(), readFileSync(saved));
  await page.waitForSelector('.tc-app-prompt', { timeout: 15_000 }).catch(() => null);
  await agree(page);
  // (the window that was open closes, the data is restored, and the app opens again: its page then holds the file's rows)
  const back = await until(page, async () => { const now = await ready(page, 'expenses', 2000); return now && await rowsOf(now) === 'Train to Leeds,Lunch' ? now : null; }, 30_000);
  // (the window that closed takes a moment to leave the page, with the mark it had)
  const quiet = await until(page, async () => await mark(page) === null, 5000);
  check(`${D} replace: Replace makes the data what the file holds, and the app opens with nothing to back up`, !!back && !/Stamps|Light bulbs/.test((await side(page, `cat ${CSV}`)).o) && !!quiet, `${(await side(page, `cat ${CSV}`)).o} mark: ${JSON.stringify(await mark(page))}`);
  // a file that is no export, dropped: nothing is asked and nothing changes
  await drop(page, 'holiday.app.zip', Buffer.from('not a zip at all'));
  const said = await until(page, () => page.evaluate(() => { const buf = window.__tabcomputer.terminal.term.buffer.active; let t = ''; for (let i = 0; i < buf.length; i++) t += buf.getLine(i).translateToString(true); return /appimport:holiday\.app\.zipwasnotimported:thefileisnotanappexportedfromtabcomputer/.test(t.replace(/\s+/g, '')); }), 8000);
  check(`${D} import: a file that is no export says so in the terminal`, !!said && await prompt(page) === null);

  // ── an app that is not this site's: shown before it is installed ──
  await page.evaluate(async () => {
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/home/user/mine/notes', { recursive: true });
    await fs.writeFile('/home/user/mine/notes/app.json', JSON.stringify({ name: 'Reading notes', about: 'Books, and what I thought of them.', table: 'books.csv', columns: ['Title', 'Thought'] }));
  });
  await side(page, 'app install /home/user/mine/notes');
  f = await openApp(page, 'notes');
  await addRow(page, f, 'Middlemarch');
  await side(page, 'app export notes backups/notes; app remove notes --data');
  const importing = side(page, 'app import backups/notes.app.zip --open');
  await page.waitForSelector('.tc-app-prompt', { timeout: 15_000 }).catch(() => null);
  q = await prompt(page);
  check(`${D} import: an app that is not this site's is shown first, from the file it came in`, !!q && q.title === 'Install Reading notes?' && q.says.join(' | ') === [
    'From the file notes.app.zip. Not reviewed by tabcomputer.', 'Books, and what I thought of them.', 'Reading notes keeps a table in books.csv, in its own data folder.', 'It runs no program, and its page may use only its own data folder.',
  ].join(' | ') && q.buttons.join() === 'Cancel,Install' && q.focus === 'Cancel', JSON.stringify(q));
  await shot(page, `${D}-import-prompt`);
  await agree(page);
  const done = await importing;
  f = await ready(page, 'notes');
  check(`${D} import: Install installs it and its data is there`, done.code === 0 && /^Installed Reading notes \(notes\) and restored its data \(1 file\)\./.test(done.o) && !!f && await until(page, async () => (await rowsOf(f) === 'Middlemarch' ? true : null), 8000), done.o);
  await page.context().close();
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
