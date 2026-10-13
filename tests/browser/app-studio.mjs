// Two ways to make an app (docs/APPS.md "Studio" and "App mode in the Code app",
// docs/research/APP_AUTHORING.md), in Chromium against a local server with no Debian:
//
//   studio  the Studio window: the three example apps made from nothing (the jq playground, a
//           live form; Make pictures smaller, files with an option; Expenses, a table), each to a
//           shared link. The app runs beside the form and follows it; problems beside their field;
//           Try it (a table's rows, a picture through the built-in convert); Share with its QR
//           code; Install and the dock or Home; an installed app opened for editing
//   code    the same three in the Code app: `app new`, `code DIR`, app.json typed, saved, the app
//           in the pane, a problem underlined at its key as it is typed, Share in the bar
//
// at 1280 x 800 and on a 393 x 852 touch screen, light and dark. It counts the taps and keys each
// app took and the time to its link, and writes them to --shots DIR/measure-SIZE-THEME.json.
//
//   npx vite build && PORT=6951 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/app-studio.mjs [URL] [--shots DIR] [--only studio,code] [--size 1280x800,393x852] [--theme light,dark]
//
// One browser per size and appearance, one at a time (a machine with 8 GB).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';

const pw = loadPlaywright();
const ROOT = resolve(dirname(decodeURIComponent(new URL(import.meta.url).pathname)), '../..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const only = opt('--only')?.split(',');
const sizes = (opt('--size') ?? '1280x800,393x852').split(',').map((s) => s.split('x').map(Number));
const themes = (opt('--theme') ?? 'light,dark').split(',');
const url = args[0] || 'http://localhost:6951/';
const origin = new URL(url).origin;
if (shots) mkdirSync(shots, { recursive: true });
const wants = (name) => !only || only.includes(name);
const example = (id) => readFileSync(join(ROOT, 'apps/examples', id, 'app.json'), 'utf8');

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const until = async (page, fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(60); } };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';

/**
 * What a person does, counted: a tap (or click), a key, the parts of the form filled in (each a
 * decision), and a model of the time a person takes for them (Card, Moran and Newell's keystroke-level
 * model: 0.28 s a key on a keyboard, 0.4 s on a phone's; 1.1 s to point and click, 0.8 s to tap;
 * 1.35 s to think before each part). The scripted run's own time is the machine's.
 */
class Count {
  constructor(touch) { this.touch = touch; this.taps = 0; this.keys = 0; this.parts = 0; }
  model() { return this.keys * (this.touch ? 0.4 : 0.28) + this.taps * (this.touch ? 0.8 : 1.1) + this.parts * 1.35; }
}

async function session(W, H, theme) {
  const touch = W < 600;
  const browser = await pw.chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
  const context = await browser.newContext(touch
    ? { viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: theme }
    : { viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: theme });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {});
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log(`     pageerror ${String(e).slice(0, 240)}`));
  await page.addInitScript((theme) => { try { if (window.top === window) { localStorage.setItem('tabcomputer-desktop-welcome', '1'); localStorage.setItem('tabcomputer-desktop-theme', theme); } } catch {} }, theme);
  return { browser, page, W, H, theme, touch, tag: `${W}x${H} ${theme}` };
}
const booted = (page) => page.waitForFunction(() => !!window.__tabcomputer?.shell && window.__shiroDesktop && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
const side = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__tabcomputer.shell.fork(); s.terminal = null; let o = '';
  const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  return { code, o: o.replace(/\r\n/g, '\n') };
}, cmd);
const shot = async (s, name) => { if (!shots) return; await s.page.waitForTimeout(400); await s.page.screenshot({ path: join(shots, `${s.W}x${s.H}-${s.theme}-${name}.png`) }); };

// ── doing things, counted ──
async function tap(s, c, sel, root = s.page) {
  const el = root.locator(sel).first();
  await el.scrollIntoViewIfNeeded();
  if (s.touch) await el.tap(); else await el.click();
  c.taps++;
}
/** Tap a part of the form and type into it (`replace`: select what it holds first, one key) */
async function fill(s, c, sel, text, { replace = false } = {}) {
  await tap(s, c, sel);
  if (replace) { await s.page.keyboard.press('ControlOrMeta+A'); c.keys++; }
  await s.page.keyboard.type(text);
  c.keys += text.length;
  c.parts++;
}
async function choose(s, c, sel, value) {
  await s.page.locator(sel).first().scrollIntoViewIfNeeded();
  await s.page.selectOption(sel, value);
  c.taps += 2;
  c.parts++;
}

// ── the app beside the form ──
const FRAME = (id) => `iframe[data-app="${id}"]`;
async function inner(page, id) {
  const outer = await (await page.$(FRAME(id)))?.contentFrame();
  if (!outer) return null;
  return /\/__tabcomputer\/frame\.html/.test(outer.url()) ? outer.childFrames()[0] ?? null : outer;
}
const pageSays = (page, id, fn) => until(page, async () => { const f = await inner(page, id); return f ? await f.evaluate(fn) : null; });

// ── the Studio ──
async function openStudio(s, c) {
  // (a tap on its dock entry, or its icon on Home)
  await s.page.evaluate(() => window.__shiroDesktop.openApp('studio'));
  c.taps++;
  await s.page.waitForSelector('.st-kinds', { timeout: 30_000 });
}
async function closeStudio(s) {
  await s.page.evaluate(() => { for (const w of window.__shiroDesktop.windows()) if (w.appId === 'studio' || w.appId === 'app-share') w.close(true); });
  await s.page.waitForTimeout(300);
}
async function shareLink(s, c) {
  await tap(s, c, '.st-bar [data-act=share]');
  await s.page.waitForSelector('.st-sheet textarea', { timeout: 15_000 });
  const link = await s.page.$eval('.st-sheet textarea', (t) => t.value);
  await tap(s, c, '.st-sheet [data-act=copy]');
  return link;
}

const measured = [];
function record(s, tool, app, c, ms, link) {
  const row = { tool, app, size: `${s.W}x${s.H}`, theme: s.theme, taps: c.taps, keys: c.keys, parts: c.parts, scripted: +(ms / 1000).toFixed(1), model: +c.model().toFixed(0), link: link.length };
  measured.push(row);
  console.log(`     ${tool} ${app} at ${row.size}: ${c.taps} taps, ${c.keys} keys, ${c.parts} parts; ${row.scripted} s scripted, about ${row.model} s for a person; link ${link.length} characters`);
}

async function studio(s) {
  const { page } = s;
  const D = s.tag;

  // jq playground: a live form
  {
    const c = new Count(s.touch);
    const t0 = Date.now();
    await openStudio(s, c);
    await shot(s, 'studio-start');
    await tap(s, c, '[data-act=kind-form]');
    await fill(s, c, '[data-k=name]', 'jq playground');
    await fill(s, c, '[data-k=about]', 'Try a jq filter on some JSON. The result changes as you type.');
    await fill(s, c, '[data-k=run]', 'jq {filter}');
    await fill(s, c, '[data-k=stdin]', '{json}');
    await fill(s, c, '[data-k="input:filter:value"]', '.people[] | select(.age > 30) | .name');
    await fill(s, c, '[data-k="input:json:label"]', 'JSON', { replace: true });
    await choose(s, c, '[data-k="input:json:type"]', 'long text');
    await fill(s, c, '[data-k="input:json:value"]', '{"people": [{"name": "Ada", "age": 36}, {"name": "Linus", "age": 21}, {"name": "Grace", "age": 45}]}');
    await tap(s, c, '[data-k=live]'); c.parts++;
    const link = await shareLink(s, c);
    record(s, 'Studio', 'jq playground', c, Date.now() - t0, link);
    check(`${D} studio jq: the link is the app written after the #`, link.startsWith(`${origin}/#`) && /name=jq%20playground/.test(link) && /live/.test(link), link.slice(0, 120));
    check(`${D} studio jq: the share screen has the QR code`, await page.$('.st-sheet [data-part=qr] svg') !== null);
    await shot(s, 'studio-jq-share');
    await tap(s, new Count(s.touch), '.st-sheet [data-act=close]');
    const h1 = await pageSays(page, 'studio-preview', () => document.querySelector('main h1')?.textContent === 'jq playground' && document.querySelector('pre')?.textContent);
    check(`${D} studio jq: the app beside the form has its name and runs live`, typeof h1 === 'string' && /Ada/.test(h1) && /Grace/.test(h1) && !/Linus/.test(h1), String(h1).slice(0, 80));
    await shot(s, 'studio-jq');
    await closeStudio(s);
  }

  // Make pictures smaller: files, with a choice
  {
    const c = new Count(s.touch);
    const t0 = Date.now();
    await openStudio(s, c);
    await tap(s, c, '[data-act=kind-files]');
    await fill(s, c, '[data-k=name]', 'Make pictures smaller');
    await fill(s, c, '[data-k=about]', 'Shrinks each picture to fit a size, keeping its shape. A picture that is already smaller is left as it is.');
    await fill(s, c, '[data-k=run]', 'convert {in} -auto-orient -resize {size} {out}');
    const needs = await page.$eval('[data-k=needs]', (i) => i.value);
    check(`${D} studio pictures: the package is filled in from the command`, needs === 'imagemagick', needs);
    await fill(s, c, '[data-k=accept]', 'jpg jpeg png webp gif tif tiff');
    await fill(s, c, '[data-k=out]', '{name}-small.{ext}');
    await fill(s, c, '[data-k="input:size:label"]', 'Longest side', { replace: true });
    await fill(s, c, '[data-k="input:size:choices"]', '800 pixels: 800x800>\n1600 pixels: 1600x1600>\n2560 pixels: 2560x2560>');
    await choose(s, c, '[data-k="input:size:value"]', '1600 pixels');
    const link = await shareLink(s, c);
    record(s, 'Studio', 'Make pictures smaller', c, Date.now() - t0, link);
    check(`${D} studio pictures: the link carries the option`, /option\.size/.test(link) && /needs=imagemagick/.test(link), link.slice(0, 200));
    await tap(s, new Count(s.touch), '.st-sheet [data-act=close]');
    const opts = await pageSays(page, 'studio-preview', () => document.querySelector('main h1')?.textContent === 'Make pictures smaller' && [...document.querySelectorAll('select option')].map((o) => o.textContent).join('|'));
    check(`${D} studio pictures: the app beside the form shows the choice`, opts === '800 pixels|1600 pixels|2560 pixels', opts);
    await shot(s, 'studio-pictures');
    await closeStudio(s);
  }

  // Expenses: a table
  {
    const c = new Count(s.touch);
    const t0 = Date.now();
    await openStudio(s, c);
    await tap(s, c, '[data-act=kind-table]');
    await fill(s, c, '[data-k=name]', 'Expenses');
    await fill(s, c, '[data-k=about]', 'A list of what was spent, with a total.');
    const cols = [['Date', 'date', ''], ['What', 'text', ''], ['Category', 'choice', 'Food, Travel, Home, Other'], ['Amount', 'number', ''], ['Paid back', 'checkbox', '']];
    for (const [i, [name, type, choices]] of cols.entries()) {
      if (i) await tap(s, c, '[data-act=add-column]');
      await fill(s, c, `[data-k="column:${i}:name"]`, name);
      if (type !== 'text') await choose(s, c, `[data-k="column:${i}:type"]`, type);
      if (choices) await fill(s, c, `[data-k="column:${i}:choices"]`, choices);
    }
    const link = await shareLink(s, c);
    record(s, 'Studio', 'Expenses', c, Date.now() - t0, link);
    check(`${D} studio expenses: the link names the columns`, /columns=Date:date,What,Category:Food\|Travel\|Home\|Other,Amount:number,Paid%20back:checkbox/.test(decodeURIComponent(link).replace(/ /g, '%20')) || /columns=/.test(link), link.slice(0, 200));
    await tap(s, new Count(s.touch), '.st-sheet [data-act=close]');
    // Try it: three rows in the copy beside the form
    await tap(s, new Count(s.touch), '.st-bar [data-act=try]');
    const rows = await pageSays(page, 'studio-preview', () => { const n = document.querySelectorAll('tbody tr, .card').length; return n >= 3 ? n : null; });
    check(`${D} studio expenses: Try it puts three rows in the app beside the form`, rows === 3 || rows >= 3, rows);
    check(`${D} studio expenses: the line says they are a try-out`, /try it/i.test(await page.$eval('.st-say', (e) => e.textContent)), await page.$eval('.st-say', (e) => e.textContent));
    await shot(s, 'studio-expenses');
    // Install: in the dock, or on Home
    await tap(s, new Count(s.touch), '.st-bar [data-act=install]');
    const said = await until(page, () => page.$eval('.st-say', (e) => (/now/.test(e.textContent) ? e.textContent : null)), 20_000);
    check(`${D} studio expenses: Install says where it is`, s.touch ? /on Home now/.test(said ?? '') : /in the dock now/.test(said ?? ''), said);
    check(`${D} studio expenses: the desktop has it`, await page.evaluate(() => window.__shiroDesktop.apps().some((a) => a.id === 'expenses')));
    await closeStudio(s);
    // An installed app opened for editing (its App menu's Edit in Studio)
    await page.evaluate(() => window.__shiroDesktop.openApp('studio', { id: 'expenses' }));
    const name = await until(page, () => page.$eval('[data-k=name]', (i) => i.value));
    check(`${D} studio: an installed app opens for editing`, name === 'Expenses', name);
    await closeStudio(s);
  }

  // Problems beside their field, in app check's words; Try it on a picture through the built-in convert
  {
    const c = new Count(s.touch);
    await openStudio(s, c);
    await tap(s, c, '[data-act=kind-files]');
    await fill(s, c, '[data-k=run]', 'convert -resize 50% {out}');
    const p = await until(page, () => page.$eval('[data-problem=run]', (e) => (!e.hidden ? e.textContent : null)));
    check(`${D} studio: a problem shows beside the command`, p === 'run must say where the file goes: {in}', p);
    check(`${D} studio: no problem shows for a part not touched yet`, await page.$eval('[data-problem=name]', (e) => e.hidden));
    await tap(s, c, '.st-bar [data-act=share]');
    const named = await page.$eval('[data-problem=name]', (e) => (e.hidden ? '' : e.textContent));
    check(`${D} studio: Share shows every problem`, /^name is missing/.test(named), named);
    await shot(s, 'studio-problems');
    await fill(s, c, '[data-k=run]', 'convert {in} -resize 25% {out}', { replace: true });
    await fill(s, c, '[data-k=needs]', '', { replace: true });
    await page.keyboard.press('Backspace');
    await fill(s, c, '[data-k=accept]', 'png');
    await page.waitForTimeout(600);
    await tap(s, c, '.st-bar [data-act=try]');
    const row = await until(page, async () => { const f = await inner(page, 'studio-preview'); return f ? await f.evaluate(() => { const li = document.querySelector('li'); return li && /done|failed/.test(li.className) ? li.innerText.replace(/\s+/g, ' ') : null; }) : null; }, 120_000);
    check(`${D} studio: Try it gives the app a sample picture, and it is worked on`, /sample\.png/.test(row ?? '') && /done/.test(row ?? ''), row);
    await shot(s, 'studio-try');
    await closeStudio(s);
  }
}

// ── the Code app ──
const editorFrame = (page) => until(page, async () => {
  for (const f of page.frames()) if (f.url() === 'about:srcdoc' && await f.$('.cm-content').catch(() => null)) return f;
  return null;
}, 60_000);
async function codeFlow(s, app, id, template, name, opts = {}) {
  const { page } = s;
  const D = s.tag;
  const c = new Count(s.touch);
  const t0 = Date.now();
  // At the Terminal: two commands (typed there; run here through the shell, keys counted)
  for (const cmd of [`app new ${id}${template ? ` --template ${template}` : ''}`, `code ${id}`]) {
    const r = await side(page, cmd);
    if (r.code) console.log(`     ${cmd}: ${r.o.trim()}`);
    c.keys += cmd.length + 1;
    c.parts++;
  }
  const f = await editorFrame(page);
  if (!f) { check(`${D} code ${app}: the editor opened`, false); return; }
  const pane = await until(page, () => page.$('.tc-pane'), 10_000);
  check(`${D} code ${app}: the folder has an app.json, so the app runs in a pane beside the editor`, !!pane);
  const text = example(app);
  await f.click('.cm-content'); c.taps++;
  await page.keyboard.press('ControlOrMeta+A'); c.keys++;
  if (opts.typo) {
    // A key misspelt, as it is typed: underlined at the key, and listed under the app
    await page.keyboard.insertText(text.replace('"accept"', '"acept"'));
    const mark = await until(page, () => f.$eval('.cm-app-problem', (e) => `${e.textContent} ${e.title}`), 10_000);
    check(`${D} code ${app}: a misspelt key is underlined as it is typed, in app check's words`, /^"acept" unknown key acept/.test(mark ?? ''), mark);
    const listed = await page.$eval('.tc-pane-log', (e) => e.innerText).catch(() => '');
    check(`${D} code ${app}: the pane lists the problem`, /app\.json: unknown key acept/.test(listed), listed.slice(0, 120));
    await shot(s, `code-${id}-problem`);
    await page.keyboard.press('ControlOrMeta+A');
  }
  await page.keyboard.insertText(text);
  c.keys += text.length; c.parts++;
  await page.keyboard.press('ControlOrMeta+S'); c.keys++;
  const h1 = await pageSays(page, id, () => document.querySelector('main h1')?.textContent);
  check(`${D} code ${app}: saving reloads the app in the pane`, h1 === name, h1);
  check(`${D} code ${app}: no problem is underlined`, await f.$('.cm-app-problem') === null);
  await f.click('#lab-app-share'); c.taps++;
  await page.waitForSelector('.tc-app-share textarea', { timeout: 15_000 });
  const link = await page.$eval('.tc-app-share textarea', (t) => t.value);
  await tap(s, c, '.tc-app-share [data-act=copy]');
  record(s, 'Code', app === 'resize-pictures' ? 'Make pictures smaller' : name, c, Date.now() - t0, link);
  check(`${D} code ${app}: Share in the bar gives the readable link`, link.startsWith(`${origin}/#`), link.slice(0, 100));
  await shot(s, `code-${id}`);
  await page.evaluate(() => { for (const w of window.__shiroDesktop.windows()) if (w.appId === 'code' || w.appId === 'app-share') w.close(true); });
  await page.waitForTimeout(400);
  check(`${D} code ${app}: closing the window stops the app`, await page.evaluate((id) => !document.querySelector(`iframe[data-app="${id}"]`), id));
}
async function code(s) {
  await codeFlow(s, 'jq-playground', 'jq-playground', 'form', 'jq playground');
  await codeFlow(s, 'resize-pictures', 'resize-pictures', '', 'Make pictures smaller', { typo: true });
  await codeFlow(s, 'expenses', 'my-expenses', 'table', 'Expenses');
}

for (const [W, H] of sizes) {
  for (const theme of themes) {
    const s = await session(W, H, theme);
    try {
      await s.page.goto(url);
      await booted(s.page);
      await s.page.waitForTimeout(800);
      if (W >= 1000) {
        const dock = await s.page.evaluate(() => [...document.querySelectorAll('.sd-dock [data-app]')].map((e) => e.dataset.app));
        check(`${s.tag}: the dock has Studio`, dock.includes('studio'), dock.join(' '));
        await shot(s, 'desktop');
      }
      if (wants('studio')) await studio(s);
      if (wants('code')) await code(s);
    } catch (e) {
      check(`${s.tag}: the run went on to the end`, false, String(e?.message ?? e).slice(0, 300));
      await shot(s, 'error').catch(() => {});
    } finally {
      await s.browser.close().catch(() => {});
    }
    if (shots) writeFileSync(join(shots, `measure-${W}x${H}-${theme}.json`), JSON.stringify(measured.filter((m) => m.size === `${W}x${H}` && m.theme === theme), null, 1));
  }
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} of ${results.length} checks passed`);
process.exit(failed ? 1 : 0);
