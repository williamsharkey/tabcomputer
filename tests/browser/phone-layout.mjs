// The phone layout (docs/DESKTOP.md "Phone layout", tabcomputer#154), in Chromium with a
// touch screen at 393 x 852, 375 x 667 and 852 x 393, light and dark:
//   home      Home's pages (a swipe), a folder, the search, an icon held down, the status line
//   apps      Terminal on the whole screen (its share of the screen, its columns), a command typed,
//             Files, Code, Notebook and a one-file app, each with no title bar, border or dock
//   pill      tap (Home), swipe up and hold (the switcher), sideways (the next app), two taps (the menu sheet)
//   switcher  the open apps as cards with their names, the busy mark, a card closed by a swipe up
//   terminal  one finger scrolls long output; pinch changes the text size; two fingers tap for another
//             terminal and swipe between them
//   keyboard  the on-screen keyboard, simulated through visualViewport (no real phone is used): the
//             key row is one row on top of it, the terminal keeps its rows and columns, the cursor's
//             line stays in view
//   sheets    a prompt (the network sign-in) comes from the bottom; the Welcome is a sheet over Home
//   gui       a native GUI app's window (a canvas stands in for it): a large screen's size, panned and
//             pinched with two fingers, the first-open line
//   rotate    the screen turned with apps open, and back
//   link      a link to an app: the install question on the whole screen, then the app with the pill
//             and no "‹ tabcomputer" bar; a reload comes back to it; a tab an earlier build left in
//             app mode opens the same way
//   python    taps from a cold start to a running python3
//   desktop   1280 x 800 and a tablet upright (820 x 1180): the desktop, with no part of the phone
//             layout loaded; with --baseline URL, the 1280 x 800 desktop pixel for pixel against
//             another build's (main's)
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/phone-layout.mjs [URL] [--shots DIR] [--only PART,…] [--size 393x852,…]
//        [--theme light,dark] [--baseline URL]
//
// It prints the measurements the issue asks for and every target under 44 px. Exits 1 if a check fails.
// Each size and appearance gets a browser of its own, one at a time (a machine with 8 GB).
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';

const { chromium } = loadPlaywright();
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const only = opt('--only')?.split(',');
const sizes = (opt('--size') ?? '393x852,375x667,852x393').split(',').map((s) => s.split('x').map(Number));
const themes = (opt('--theme') ?? 'light,dark').split(',');
const baseline = opt('--baseline');
const url = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });
const part = (name) => !only || only.includes(name);

const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail !== '' ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`); };
const measured = [];
const measure = (name, value) => { measured.push([name, value]); console.log(`     ${name}: ${value}`); };
/** Targets under 44 px, by screen: `where` → Set of "label WxH" */
const small = new Map();

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1';

async function start(width, height, theme, { touch = true, init = true } = {}) {
  const browser = await chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium') });
  const ctx = await browser.newContext(touch
    ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, userAgent: UA, colorScheme: theme }
    : { viewport: { width, height }, deviceScaleFactor: 1, colorScheme: theme });
  // The Welcome is its own part
  if (init) await ctx.addInitScript(() => { try { if (!sessionStorage.getItem('show-welcome')) localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch { /* no storage */ } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log(`     pageerror ${String(e).slice(0, 200)}`));
  const cdp = await ctx.newCDPSession(page);
  return { browser, ctx, page, cdp, W: width, H: height, tag: `${width}x${height} ${theme}` };
}
async function boot(page, to = url) {
  const t0 = Date.now();
  await page.goto(to);
  await page.waitForFunction(() => window.__tabcomputer?.terminal && window.__shiroDesktop && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  await page.waitForTimeout(700);
  return Date.now() - t0;
}

// ── Fingers (CDP touch events: they scroll, and they are pointer events too) ──
const pt = (p) => ({ x: Math.round(p[0]), y: Math.round(p[1]) });
async function drag(s, path, { steps = 8, hold = 0, end = true } = {}) {
  await s.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [pt(path[0])] });
  if (hold) await s.page.waitForTimeout(hold);
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1], b = path[k];
    for (let i = 1; i <= steps; i++) {
      await s.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [pt([a[0] + (b[0] - a[0]) * i / steps, a[1] + (b[1] - a[1]) * i / steps])] });
      await s.page.waitForTimeout(10);
    }
  }
  if (end) await s.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const tap = (s, x, y) => drag(s, [[x, y]]);
/** Two fingers: from points a to points b ([[x, y], [x, y]] each), or held still when b is absent */
async function fingers(s, a, b, { steps = 8, hold = 40 } = {}) {
  await s.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: a.map((p, id) => ({ ...pt(p), id })) });
  await s.page.waitForTimeout(hold);
  if (b) for (let i = 1; i <= steps; i++) {
    await s.cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: a.map((p, id) => ({ ...pt([p[0] + (b[id][0] - p[0]) * i / steps, p[1] + (b[id][1] - p[1]) * i / steps]), id })) });
    await s.page.waitForTimeout(12);
  }
  await s.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
const centre = (s, sel) => s.page.evaluate((q) => { const e = document.querySelector(q); if (!e) return null; const r = e.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, sel);
async function tapOn(s, sel) {
  const c = await centre(s, sel);
  if (!c) throw new Error(`nothing matches ${sel}`);
  await tap(s, c[0], c[1]);
}
/** The pill: its middle, a few px above the bottom of the screen */
const pillAt = (s) => [s.W / 2, s.H - 8];
const pillTap = async (s) => { await tap(s, ...pillAt(s)); await s.page.waitForTimeout(450); };
const pillTwice = async (s) => { await tap(s, ...pillAt(s)); await s.page.waitForTimeout(70); await tap(s, ...pillAt(s)); await s.page.waitForTimeout(350); };
const pillUp = async (s) => { const [x, y] = pillAt(s); await drag(s, [[x, y], [x, y - 130]]); await s.page.waitForTimeout(350); };
const pillSide = async (s, dx) => { const [x, y] = pillAt(s); await drag(s, [[x - dx / 2, y], [x + dx / 2, y]]); await s.page.waitForTimeout(350); };
const shot = async (s, name) => { if (!shots) return; await s.page.waitForTimeout(350); await s.page.screenshot({ path: join(shots, `${s.W}x${s.H}-${s.theme ?? ''}${name}.png`) }); };

// ── What the page shows ──
const state = (s) => s.page.evaluate(() => {
  const root = document.getElementById('shiro-desktop'), wm = window.__shiroDesktop;
  const vis = (q) => { const e = document.querySelector(q); if (!e) return false; const r = e.getBoundingClientRect(), cs = getComputedStyle(e); return r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden'; };
  const f = wm.focused();
  const fr = f?.element.getBoundingClientRect();
  return {
    phone: root.classList.contains('sd-phone'), home: root.classList.contains('sd-at-home'), switching: root.classList.contains('sd-switching'),
    menubar: vis('.sd-menubar'), dock: vis('.sd-dock'), titlebar: vis('.sd-win.sd-focused > .sd-titlebar'), pill: vis('.sd-pill'), homeEl: vis('.sd-home'),
    focused: f?.appId ?? null, wins: wm.visibleOrder().map((w) => w.appId),
    rect: fr ? [Math.round(fr.left), Math.round(fr.top), Math.round(fr.width), Math.round(fr.height)] : null,
    frame: f ? (() => { const cs = getComputedStyle(f.element); return `${cs.borderRadius} ${cs.boxShadow} ${cs.borderTopWidth}`; })() : '',
    vw: innerWidth, vh: innerHeight,
  };
});
const home = (s) => s.page.evaluate(() => ({
  pages: [...document.querySelectorAll('.sd-home-page')].map((p) => [...p.children].map((b) => b.dataset.app || `[${b.dataset.folder}]`)),
  page: [...document.querySelectorAll('.sd-home-dot')].findIndex((d) => d.getAttribute('aria-current') === 'true'),
  cols: (() => { const tiles = [...(document.querySelector('.sd-home-page')?.children ?? [])]; const top = tiles[0]?.getBoundingClientRect().top; return tiles.filter((t) => Math.abs(t.getBoundingClientRect().top - top) < 2).length; })(),
  names: [...(document.querySelector('.sd-home-page')?.querySelectorAll('.sd-home-name') ?? [])].map((n) => n.textContent),
  status: document.querySelector('.sd-home-net')?.textContent ?? '',
  tools: [...document.querySelectorAll('.sd-home-tools > *')].map((b) => b.getAttribute('aria-label') ?? ''),
}));
/** Run a command in a shell of its own (no terminal) */
const side = (s, cmd) => s.page.evaluate(async (c) => {
  const sh = window.__tabcomputer.shell.fork();
  sh.cwd = '/home/user';
  let o = '';
  const code = await sh.execute(c, (x) => { o += x; }, (x) => { o += x; });
  return { code, o };
}, cmd);
/** The terminal in front: its size and what it shows */
const term = (s) => s.page.evaluate(() => {
  const w = window.__shiroDesktop.focused();
  const t = w?.content?.activeTerminal?.();
  if (!t) return null;
  const b = t.term.buffer.active;
  const lines = [];
  for (let i = Math.max(0, b.length - 80); i < b.length; i++) lines.push(b.getLine(i)?.translateToString(true) ?? '');
  const scr = t.term.element.querySelector('.xterm-screen').getBoundingClientRect();
  const win = w.element.getBoundingClientRect(), body = w.body.getBoundingClientRect();
  return {
    cols: t.term.cols, rows: t.term.rows, font: t.term.options.fontSize, text: lines.join('\n'), viewportY: b.viewportY, baseY: b.baseY, cursorY: b.cursorY,
    screen: [scr.left, scr.top, scr.width, scr.height], win: [win.left, win.top, win.width, win.height], body: [body.left, body.top, body.width, body.height],
    tabs: w.content.terminals().length,
  };
});
const waitText = async (s, re, timeout = 30_000) => {
  const t0 = Date.now();
  for (;;) {
    const t = await term(s);
    if (t && re.test(t.text)) return t;
    if (Date.now() - t0 > timeout) return null;
    await s.page.waitForTimeout(150);
  }
};
/** Controls on screen that a finger would miss: under 44 px either way. `scope`: selectors to look in. */
async function targets(s, where, scope) {
  const found = await s.page.evaluate((scopes) => {
    const out = [];
    const seen = new Set();
    const CONTROLS = 'button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem], [role=option], [tabindex]:not([tabindex="-1"])';
    /** `doc`: the page, or a frame's document that the page can read (the Code editor's), `at` its place on screen */
    const look = (root, doc, at) => {
      const view = doc.defaultView;
      for (const e of root.querySelectorAll(CONTROLS)) {
        if (seen.has(e)) continue;
        seen.add(e);
        const r = e.getBoundingClientRect(), cs = view.getComputedStyle(e);
        if (r.width < 1 || r.height < 1 || cs.visibility === 'hidden' || cs.display === 'none' || cs.pointerEvents === 'none' || e.disabled) continue;
        if (r.right <= 0 || r.bottom <= 0 || r.left >= view.innerWidth || r.top >= view.innerHeight) continue;
        if (at.left + r.left >= innerWidth || at.top + r.top >= innerHeight) continue;
        // (what a finger at its middle would reach)
        const hit = doc.elementFromPoint(Math.min(view.innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(view.innerHeight - 1, Math.max(0, r.top + r.height / 2)));
        if (!hit || !(e === hit || e.contains(hit) || hit.contains(e))) continue;
        if (e.classList.contains('xterm-helper-textarea') || e.closest('.xterm') || e.classList.contains('cm-content')) continue;
        if (r.width >= 43.5 && r.height >= 43.5) continue;
        const label = (e.getAttribute('aria-label') || e.title || e.textContent || e.placeholder || e.className || e.tagName).trim().replace(/\s+/g, ' ').slice(0, 28);
        out.push(`${label} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
      for (const f of root.querySelectorAll('iframe')) {
        let inner = null;
        try { inner = f.contentDocument; } catch { /* another origin */ }
        const fr = f.getBoundingClientRect();
        if (inner?.body) look(inner, inner, { left: at.left + fr.left, top: at.top + fr.top });
        else if (fr.width > 0) out.push('(a frame of another origin: not measured)');
      }
    };
    for (const q of scopes) for (const root of document.querySelectorAll(q)) look(root, document, { left: 0, top: 0 });
    return out;
  }, scope);
  if (!small.has(where)) small.set(where, new Set());
  for (const f of found) small.get(where).add(f);
  return found;
}

// ── One phone, one appearance ──
async function phone(width, height, theme, first) {
  const s = await start(width, height, theme);
  s.theme = `${theme}-`;
  const T = s.tag;
  const landscape = width > height;
  try {
    const ms = await boot(s.page);
    if (first) measure(`${T} boot to Home`, `${ms} ms`);
    let st = await state(s);

    if (part('home')) {
      check(`${T} home: the phone layout, at Home, with no dock, menu bar or title bar`, st.phone && st.home && st.homeEl && st.pill && !st.menubar && !st.dock && !st.titlebar, st);
      let h = await home(s);
      check(`${T} home: page one is Terminal, Files, Code, Notebook, Browser, Python, Claude, Settings, Convert Old Files`, h.pages[0]?.join() === 'terminal,files,code,notebook,browser,python3,claude,settings,converter', h.pages[0]?.join());
      check(`${T} home: ${landscape ? 'more than four' : 'four'} icons across, each with its name`, (landscape ? h.cols > 4 : h.cols === 4) && h.names.every((n) => n), `${h.cols} across`);
      check(`${T} home: later pages hold the rest, the dock's stacks as folders`, h.pages.length >= 2 && ['[editors]', '[developer]', '[agents]', '[debian]'].every((f) => h.pages.slice(1).flat().includes(f)) && !h.pages.slice(1).flat().includes('terminal'), h.pages.slice(1).map((p) => p.join(' ')).join(' | '));
      check(`${T} home: one status line: the network and sign-in in words, appearance and network buttons`, /online|offline|sign|internet/i.test(h.status) && h.tools.length === 2, `${h.status} | ${h.tools.join(', ')}`);
      await shot(s, '01-home');
      await targets(s, 'Home', ['.sd-home', '.sd-pill']);
      // The appearance button on the status line
      const themeWas = await s.page.evaluate(() => document.getElementById('shiro-desktop').dataset.theme);
      await tapOn(s, '.sd-home-tools > :first-child');
      await s.page.waitForTimeout(250);
      const themeNow = await s.page.evaluate(() => document.getElementById('shiro-desktop').dataset.theme);
      check(`${T} home: the appearance button changes light to dark and back`, themeNow !== themeWas, `${themeWas} → ${themeNow}`);
      await tapOn(s, '.sd-home-tools > :first-child');
      await s.page.waitForTimeout(250);
      // A swipe turns the page
      await drag(s, [[s.W - 30, s.H / 2], [30, s.H / 2]]);
      await s.page.waitForTimeout(600);
      h = await home(s);
      check(`${T} home: a swipe sideways turns to page two, and the dots say so`, h.page === 1, `page ${h.page + 1}`);
      await shot(s, '02-home-page-two');
      // A folder
      await tapOn(s, '.sd-home-folder[data-folder=editors] .sd-home-icon');
      await s.page.waitForTimeout(350);
      const folder = await s.page.evaluate(() => ({ title: document.querySelector('.sd-folder-veil h2')?.textContent, apps: [...document.querySelectorAll('.sd-folder .sd-home-app')].map((b) => b.dataset.app) }));
      check(`${T} home: a folder opens over Home with its apps`, folder.title === 'Text Editors' && folder.apps.includes('vim') && folder.apps.length >= 3, folder);
      await shot(s, '03-folder');
      await targets(s, 'A folder', ['.sd-folder-veil']);
      await tap(s, 8, s.H - 70);
      await s.page.waitForTimeout(250);
      check(`${T} home: a tap outside closes the folder`, !(await s.page.$('.sd-folder-veil')));
      // An icon held down
      const act = await centre(s, '.sd-home-app[data-app=activity] .sd-home-icon');
      await drag(s, [act], { hold: 650 });
      await s.page.waitForTimeout(300);
      const held = await s.page.evaluate(() => ({ title: document.querySelector('.sd-psheet h2')?.textContent, items: [...document.querySelectorAll('.sd-psheet-item')].map((b) => b.textContent) }));
      check(`${T} home: an icon held down offers Open, Info and Remove`, held.title === 'Activity' && ['Open', 'Info', 'Remove from Home'].every((x) => held.items.includes(x)), held);
      await shot(s, '04-icon-held');
      await targets(s, 'A sheet', ['.sd-psheet']);
      await tapOn(s, '.sd-psheet-item:nth-child(2)');
      await s.page.waitForTimeout(300);
      const info = await s.page.evaluate(() => [...document.querySelectorAll('.sd-psheet p')].map((p) => p.textContent).join(' '));
      check(`${T} home: Info says what the app is`, /Activity is part of tabcomputer/.test(info), info);
      await tapOn(s, '.sd-psheet-item');
      await s.page.waitForTimeout(250);
      // The search field is the existing search
      await pillTap(s);
      await tapOn(s, '.sd-home-search');
      await s.page.waitForTimeout(600);
      await s.page.keyboard.type('sett');
      await s.page.waitForTimeout(400);
      const found = await s.page.evaluate(() => ({ open: !!document.querySelector('.sd-spot'), first: document.querySelector('.sd-spot-item .sd-spot-title')?.textContent, w: document.querySelector('.sd-spot')?.getBoundingClientRect().width }));
      check(`${T} home: the search field opens the search, and it finds Settings`, found.open && found.first === 'Settings' && found.w <= s.W, found);
      await shot(s, '05-search');
      await targets(s, 'Search', ['.sd-spot']);
      await s.page.keyboard.press('Escape');
      await s.page.waitForTimeout(250);
      h = await home(s);
      check(`${T} home: a tap on the pill at Home goes back to page one`, h.page === 0, `page ${h.page + 1}`);
    }

    // ── Apps on the whole screen ──
    let taps = 0;
    const openFromHome = async (id) => {
      const where = await s.page.evaluate((app) => [...document.querySelectorAll('.sd-home-page')].findIndex((p) => p.querySelector(`[data-app="${app}"]`)), id);
      if (where > 0) { await tapOn(s, `.sd-home-dot:nth-child(${where + 1})`); await s.page.waitForTimeout(600); }
      await tapOn(s, `.sd-home-page .sd-home-app[data-app="${id}"] .sd-home-icon`);
      await s.page.waitForFunction((app) => window.__shiroDesktop.focused()?.appId === app, id, { timeout: 30_000 }).catch(() => {});
      await s.page.waitForTimeout(700);
    };
    const whole = (x) => x.rect && x.rect[0] === 0 && x.rect[1] === 0 && x.rect[2] === x.vw && x.rect[3] >= x.vh - 23 && x.rect[3] <= x.vh - 17;
    const bare = (x) => !x.titlebar && !x.menubar && !x.dock && /^0px none 0px$/.test(x.frame);

    if (part('apps') || part('pill') || part('switcher') || part('terminal') || part('keyboard') || part('rotate')) {
      await openFromHome('terminal');
      taps++;
      st = await state(s);
      const t = await term(s);
      check(`${T} apps: Terminal is the whole screen down to the pill's strip, with no title bar, buttons, border or shadow`, st.focused === 'terminal' && !st.home && whole(st) && bare(st), st);
      const share = t.body[3] / s.H;
      check(`${T} apps: the terminal has 95% of the screen's height`, share >= 0.95, `${Math.round(t.body[3])} of ${s.H} px, ${(share * 100).toFixed(1)}%`);
      if (theme === themes[0]) {
        measure(`${T} terminal's share of the screen`, `${Math.round(t.body[3])} of ${s.H} px = ${(share * 100).toFixed(1)}% (width ${Math.round(t.body[2])} of ${s.W})`);
        measure(`${T} terminal at the default size`, `${t.cols} columns x ${t.rows} rows at ${t.font} px`);
      }
      if (width === 393) check(`${T} apps: at least 48 columns at the default text size`, t.cols >= 48, `${t.cols} columns at ${t.font} px`);
      await s.page.keyboard.type('echo phone-$((6*7))\n', { delay: 4 });
      const typed = await waitText(s, /^phone-42$/m);
      check(`${T} apps: a command typed in the terminal runs`, !!typed);
      await shot(s, '06-terminal');
      await targets(s, 'In Terminal', ['.sd-win.sd-focused', '.sd-pill']);
    }

    if (part('apps')) {
      for (const id of ['files', 'code', 'notebook']) {
        await pillTap(s);
        st = await state(s);
        if (id === 'files') check(`${T} pill: a tap goes Home, the app stays open`, st.home && st.wins.includes('terminal'), st);
        await openFromHome(id);
        st = await state(s);
        check(`${T} apps: ${id} is the whole screen, with no title bar, border or dock`, st.focused === id && !st.home && whole(st) && bare(st), st);
        await shot(s, `07-${id}`);
        await targets(s, `In ${id[0].toUpperCase()}${id.slice(1)} (the app's own controls)`, ['.sd-win.sd-focused']);
      }
      // A one-file app (docs/APPS.md): made, installed, then opened from Home's first page
      const made = await side(s, 'cd /home/user && app new count --template form && app install count');
      await s.page.waitForTimeout(500);
      await pillTap(s);
      const h = await home(s);
      check(`${T} apps: an installed one-file app is on Home's first page`, made.code === 0 && h.pages[0].includes('count'), `${made.o.trim().split('\n').pop()} | ${h.pages[0].join()}`);
      await openFromHome('count');
      await s.page.waitForSelector('.sd-win[data-app=count] iframe', { timeout: 30_000 }).catch(() => {});
      await s.page.waitForTimeout(1200);
      st = await state(s);
      check(`${T} apps: the one-file app is the whole screen`, st.focused === 'count' && whole(st) && bare(st), st);
      await shot(s, '08-one-file-app');
      await targets(s, 'In a one-file app (its own page)', ['.sd-win.sd-focused']);
      await pillTap(s);
      const c = await centre(s, '.sd-home-app[data-app=count] .sd-home-icon');
      await drag(s, [c], { hold: 650 });
      await s.page.waitForTimeout(300);
      const items = await s.page.evaluate(() => [...document.querySelectorAll('.sd-psheet-item')].map((b) => b.textContent));
      check(`${T} apps: held down, an installed app offers Share and Remove as well`, ['Open', 'Share as a Link…', 'Info', 'Remove…'].every((x) => items.includes(x)), items.join(', '));
      await tap(s, s.W / 2, 30);
      await s.page.waitForTimeout(250);
      await openFromHome('terminal');
    }

    if (part('pill') || part('switcher')) {
      // Two more apps beside Terminal
      if (!part('apps')) { await pillTap(s); await openFromHome('files'); await pillTap(s); await openFromHome('terminal'); }
      st = await state(s);
      const openNow = st.wins.length;
      // Two taps: the menus as a sheet
      await pillTwice(s);
      const sheet = await s.page.evaluate(() => ({
        title: document.querySelector('.sd-psheet h2')?.textContent,
        sections: [...document.querySelectorAll('.sd-psheet h3')].map((x) => x.textContent),
        items: [...document.querySelectorAll('.sd-psheet-item')].map((b) => b.textContent),
        bottom: Math.round(document.querySelector('.sd-psheet')?.getBoundingClientRect().bottom ?? 0),
      }));
      check(`${T} pill: two taps open the app's menus as a sheet from the bottom: File, Edit, View, Window, Help`, sheet.title === 'Terminal' && ['File', 'Edit', 'View', 'Window', 'Help'].every((x) => sheet.sections.includes(x)) && sheet.bottom === s.H, `${sheet.sections.join(', ')} | bottom ${sheet.bottom}`);
      check(`${T} pill: the sheet holds the menus' commands, without the ones that move windows`, ['New Tab', 'Paste', 'Close Window', 'Getting Started', 'Settings…', 'Restart'].every((x) => sheet.items.includes(x)) && !sheet.items.some((x) => /Tile|Quarter|Minimize|Zoom/.test(x)), sheet.items.join(', '));
      await shot(s, '09-menu-sheet');
      await targets(s, 'The menu sheet', ['.sd-psheet']);
      // A command from it: New Tab
      const before = (await term(s)).tabs;
      await s.page.evaluate(() => [...document.querySelectorAll('.sd-psheet-item')].find((b) => b.textContent === 'New Tab').scrollIntoView({ block: 'center' }));
      const nt = await s.page.evaluate(() => { const r = [...document.querySelectorAll('.sd-psheet-item')].find((b) => b.textContent === 'New Tab').getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; });
      await tap(s, ...nt);
      await s.page.waitForTimeout(600);
      const after = await term(s);
      check(`${T} pill: a command chosen in the sheet runs (New Tab) and the sheet goes`, after?.tabs === before + 1 && !(await s.page.$('.sd-psheet')), `${before} → ${after?.tabs} terminals`);
      // Sideways: the next and the previous open app
      const a0 = (await state(s)).focused;
      await pillSide(s, -90);
      const a1 = (await state(s)).focused;
      await pillSide(s, 90);
      const a2 = (await state(s)).focused;
      check(`${T} pill: a swipe sideways goes to the next open app, and back`, a1 !== a0 && a2 === a0 && openNow >= 2, `${a0} → ${a1} → ${a2}`);
      if (first) measure(`${T} gestures to switch between two open apps`, '1 (a swipe sideways on the pill); 2 by the switcher (swipe up, tap the card)');
      // Up: the switcher
      await s.page.keyboard.type('sleep 300\n', { delay: 4 });
      await s.page.waitForTimeout(500);
      await pillUp(s);
      const sw = await s.page.evaluate(() => ({
        on: document.getElementById('shiro-desktop').classList.contains('sd-switching'),
        cards: [...document.querySelectorAll('.sd-win[data-phone-card]')].sort((a, b) => Number(a.style.order) - Number(b.style.order)).map((c) => { const r = c.getBoundingClientRect(); return { app: c.dataset.app, name: c.dataset.phoneCard, busy: c.hasAttribute('data-phone-busy'), w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) }; }),
      }));
      check(`${T} switcher: a swipe up from the pill shows the open apps as cards in a row, each with its app's name`, sw.on && sw.cards.length === openNow && sw.cards.every((c) => c.name && c.w < s.W && c.h < s.H) && new Set(sw.cards.map((c) => c.y)).size === 1, sw.cards.map((c) => `${c.name} ${c.w}x${c.h}@${c.x}`).join(' | '));
      check(`${T} switcher: the card of the app that is running a command is marked`, sw.cards.find((c) => c.app === 'terminal')?.busy === true && sw.cards.filter((c) => c.busy).length === 1, sw.cards.filter((c) => c.busy).map((c) => c.name).join());
      await shot(s, '10-switcher');
      // A card swiped up closes its app
      const victim = sw.cards.find((c) => c.app === 'files');
      const cardAt = (app) => s.page.evaluate((a) => { const c = document.querySelector(`.sd-win[data-phone-card][data-app="${a}"]`); if (!c) return null; c.scrollIntoView({ inline: 'center', block: 'nearest' }); const r = c.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, app);
      if (victim) {
        const p = await cardAt('files');
        await drag(s, [p, [p[0], p[1] - 260]], { steps: 10 });
        await s.page.waitForTimeout(700);
        st = await state(s);
        check(`${T} switcher: a card swiped up closes its app`, !st.wins.includes('files') && st.switching, st.wins.join());
      }
      // A tap on a card opens it
      const p = await cardAt('terminal');
      await tap(s, ...p);
      await s.page.waitForTimeout(400);
      st = await state(s);
      check(`${T} switcher: a tap on a card opens that app`, !st.switching && st.focused === 'terminal' && whole(st), st);
      // Held: the switcher too; a tap beside the cards goes back
      await drag(s, [pillAt(s)], { hold: 600 });
      await s.page.waitForTimeout(300);
      const heldOn = (await state(s)).switching;
      // (under the cards, above the pill: a notification may sit at the top)
      await tap(s, s.W / 2, s.H - 56);
      await s.page.waitForTimeout(300);
      st = await state(s);
      check(`${T} pill: held, it opens the switcher too; a tap beside the cards goes back to the app`, heldOn && !st.switching && st.focused === 'terminal', { heldOn, ...st });
      await s.page.keyboard.press('Control+c');
      await s.page.waitForTimeout(300);
    }

    if (part('terminal')) {
      if ((await state(s)).focused !== 'terminal') { await pillTap(s); await openFromHome('terminal'); }
      // Long output scrolls with one finger
      await s.page.keyboard.type('seq 400\n', { delay: 4 });
      await waitText(s, /^400$/m);
      const t0 = await term(s);
      await drag(s, [[s.W / 2, s.H * 0.35], [s.W / 2, s.H * 0.8]], { steps: 12 });
      await s.page.waitForTimeout(300);
      const t1 = await term(s);
      check(`${T} terminal: long output scrolls with one finger`, t1.viewportY < t0.viewportY, `line ${t0.viewportY} → ${t1.viewportY}`);
      await s.page.evaluate(() => window.__shiroDesktop.focused().content.activeTerminal().term.scrollToBottom());
      // Pinch: the text size, remembered
      const mid = [s.W / 2, s.H * 0.45];
      await fingers(s, [[mid[0] - 40, mid[1]], [mid[0] + 40, mid[1]]], [[mid[0] - 70, mid[1]], [mid[0] + 70, mid[1]]]);
      await s.page.waitForTimeout(400);
      const big = await term(s);
      const saved = await s.page.evaluate(() => localStorage.getItem('tabcomputer-phone-font'));
      check(`${T} terminal: a pinch changes the text size, and it is remembered`, big.font > t0.font && big.cols < t0.cols && saved === String(big.font), `${t0.font} px, ${t0.cols} columns → ${big.font} px, ${big.cols} columns; saved ${saved}`);
      await fingers(s, [[mid[0] - 70, mid[1]], [mid[0] + 70, mid[1]]], [[mid[0] - 70 * t0.font / big.font, mid[1]], [mid[0] + 70 * t0.font / big.font, mid[1]]]);
      await s.page.waitForTimeout(400);
      const back = await term(s);
      check(`${T} terminal: pinching back gives the size and the columns it had`, back.font === t0.font && back.cols === t0.cols, `${back.font} px, ${back.cols} columns`);
      // Two fingers: a tap for another terminal, a swipe between them
      const n0 = back.tabs;
      await fingers(s, [[mid[0] - 30, mid[1]], [mid[0] + 30, mid[1]]], null, { hold: 60 });
      await s.page.waitForTimeout(700);
      const two = await term(s);
      const said = await s.page.evaluate(() => document.querySelector('.sd-phone-note')?.textContent ?? '');
      check(`${T} terminal: a tap with two fingers opens another terminal, and a line says which one`, two.tabs === n0 + 1 && /Terminal \d+ of \d+/.test(said) && !/400/.test(two.text), `${n0} → ${two.tabs}; "${said}"`);
      await shot(s, '11-second-terminal');
      await fingers(s, [[mid[0] + 60, mid[1] - 20], [mid[0] + 60, mid[1] + 20]], [[mid[0] - 80, mid[1] - 20], [mid[0] - 80, mid[1] + 20]]);
      await s.page.waitForTimeout(500);
      const swapped = await term(s);
      check(`${T} terminal: a sideways swipe with two fingers moves to another terminal`, swapped.text !== two.text && swapped.tabs === two.tabs, `${swapped.tabs} terminals`);
      check(`${T} terminal: every terminal has the same size, and no tab bar takes rows`, swapped.cols === t0.cols && swapped.rows === t0.rows, `${swapped.cols}x${swapped.rows}`);
    }

    if (part('keyboard')) {
      if ((await state(s)).focused !== 'terminal') { await pillTap(s); await openFromHome('terminal'); }
      await s.page.keyboard.type('seq 200\n', { delay: 4 });
      await waitText(s, /^200$/m);
      const t0 = await term(s);
      const barBefore = await s.page.evaluate(() => { const b = document.querySelector('.sd-keybar'); return !b || b.hidden || b.getBoundingClientRect().height === 0; });
      check(`${T} keyboard: no key row while the keyboard is down`, barBefore);
      // The keyboard, simulated: the visual viewport loses its lower part (no real phone is used)
      const kb = Math.round(s.H * (landscape ? 0.5 : 0.4));
      await s.page.evaluate((h) => {
        const vv = window.visualViewport;
        Object.defineProperty(vv, 'height', { configurable: true, get: () => h });
        vv.dispatchEvent(new Event('resize'));
        // what the row's keys send
        const t = window.__shiroDesktop.focused().content.activeTerminal();
        window.__sent = [];
        const real = t.injectInput.bind(t);
        t.injectInput = (d) => { window.__sent.push(d); return real(d); };
      }, s.H - kb);
      await s.page.waitForTimeout(600);
      const up = await s.page.evaluate(() => {
        const b = document.querySelector('.sd-keybar'), r = b.getBoundingClientRect();
        const keys = [...b.querySelectorAll('.sd-key')];
        return {
          shown: !b.hidden, rows: b.querySelectorAll('.sd-keyrow').length, top: Math.round(r.top), bottom: Math.round(r.bottom), h: Math.round(r.height),
          // (it scrolls sideways where the keys do not all fit: a phone upright)
          scrolls: b.scrollWidth > b.clientWidth || keys.every((k) => k.getBoundingClientRect().right <= innerWidth), labels: keys.map((k) => k.textContent).join(' '),
          tops: new Set(keys.map((k) => Math.round(k.getBoundingClientRect().top))).size,
          small: keys.filter((k) => { const q = k.getBoundingClientRect(); return q.width < 44 || q.height < 44; }).length,
          shift: getComputedStyle(document.getElementById('shiro-desktop')).getPropertyValue('--sd-kb-shift'),
        };
      });
      check(`${T} keyboard: the key row is one row on top of the keyboard, scrolling sideways where it has to`, up.shown && up.rows === 1 && up.tops === 1 && up.bottom === s.H - kb && up.scrolls && up.small === 0, up);
      check(`${T} keyboard: esc, tab, ctrl, alt, the arrows, then the symbols`, up.labels.startsWith('esc tab ctrl alt ← ↓ ↑ → | ~ / - $ & ;'), up.labels);
      const t1 = await term(s);
      check(`${T} keyboard: the terminal keeps its rows and columns when the keyboard opens`, t1.cols === t0.cols && t1.rows === t0.rows && Math.round(t1.body[3]) === Math.round(t0.body[3]), `${t0.cols}x${t0.rows} → ${t1.cols}x${t1.rows}`);
      const cursorBottom = t1.screen[1] + (t1.cursorY + 1) * (t1.screen[3] / t1.rows);
      check(`${T} keyboard: the cursor's line is in view above the key row`, cursorBottom <= up.top + 1 && cursorBottom > up.top - 3 * (t1.screen[3] / t1.rows), `line ends at ${Math.round(cursorBottom)}, key row starts at ${up.top}, moved ${up.shift.trim()}`);
      await shot(s, '12-keyboard-up');
      // Its keys reach the terminal; ctrl latches for one key
      const key = (label) => s.page.evaluate((l) => { const k = [...document.querySelectorAll('.sd-key')].find((x) => x.textContent === l); const r = k.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2]; }, label);
      await tap(s, ...(await key('esc')));
      await tap(s, ...(await key('ctrl')));
      await s.page.waitForTimeout(150);
      const latched = await s.page.evaluate(() => [...document.querySelectorAll('.sd-key')].find((x) => x.textContent === 'ctrl').classList.contains('sd-on'));
      await s.page.keyboard.insertText('c');
      await s.page.waitForTimeout(200);
      const sent = await s.page.evaluate(() => ({ sent: window.__sent.map((d) => [...d].map((c) => c.charCodeAt(0)).join('.')), on: [...document.querySelectorAll('.sd-key')].find((x) => x.textContent === 'ctrl').classList.contains('sd-on') }));
      check(`${T} keyboard: esc sends Escape; ctrl latches for the next key typed (ctrl then c is ^C) and lets go`, sent.sent[0] === '27' && latched && sent.sent.includes('3') && !sent.on, sent);
      // More output while the keyboard is up: the line stays in view
      await s.page.keyboard.type('seq 30\n', { delay: 4 });
      await waitText(s, /^30$/m);
      await s.page.waitForTimeout(400);
      const t2 = await term(s);
      const cb2 = t2.screen[1] + (t2.cursorY + 1) * (t2.screen[3] / t2.rows);
      check(`${T} keyboard: it stays in view as output arrives`, cb2 <= up.top + 1, `line ends at ${Math.round(cb2)}`);
      // The keyboard goes down
      await s.page.evaluate(() => { delete window.visualViewport.height; window.visualViewport.dispatchEvent(new Event('resize')); });
      await s.page.waitForTimeout(500);
      const down = await s.page.evaluate(() => ({ hidden: document.querySelector('.sd-keybar').hidden, shift: getComputedStyle(document.getElementById('shiro-desktop')).getPropertyValue('--sd-kb-shift').trim() }));
      const t3 = await term(s);
      check(`${T} keyboard: down again, the row goes and the terminal is where it was, the same size`, down.hidden && (down.shift === '0px' || down.shift === '') && t3.cols === t0.cols && t3.rows === t0.rows && Math.round(t3.win[1]) === Math.round(t0.win[1]), { ...down, size: `${t3.cols}x${t3.rows}` });
    }

    if (part('sheets')) {
      // A prompt: the network sign-in (src/net-signin.ts) asks from the bottom
      await s.page.evaluate(() => { void window.__shiroRequireNetwork({ host: 'example.com', port: 443, reason: 'curl wants to connect' }); });
      await s.page.waitForSelector('.sd-sheet', { timeout: 10_000 }).catch(() => {});
      await s.page.waitForTimeout(500);
      const sheet = await s.page.evaluate(() => { const e = document.querySelector('.sd-sheet'); if (!e) return null; const r = e.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), top: Math.round(r.top), text: e.textContent.replace(/\s+/g, ' ').slice(0, 60) }; });
      check(`${T} sheets: a prompt is a sheet from the bottom, as wide as the screen`, !!sheet && sheet.left === 0 && sheet.right === s.W && sheet.bottom === s.H && sheet.top > 0, sheet);
      await shot(s, '13-prompt-sheet');
      await targets(s, 'The sign-in sheet', ['.sd-sheet']);
      await s.page.evaluate(() => [...document.querySelectorAll('.sd-sheet button')].find((b) => /not now/i.test(b.textContent))?.click());
      await s.page.waitForTimeout(400);
    }

    if (part('gui')) {
      // A native GUI app's window, stood in for by a canvas client (docs/DESKTOP.md "Surfaces"): no Debian app is installed here
      await s.page.evaluate(() => {
        const d = window.__tabcomputer.desktop;
        const w = d.createWindow({ title: 'xeyes', appId: 'xeyes', width: 300, height: 200, content: { kind: 'surface' } });
        const ctx = w.surface.canvas.getContext('2d');
        const draw = () => { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w.surface.width, w.surface.height); ctx.fillStyle = '#c33'; ctx.fillRect(0, 0, 80, 80); ctx.fillStyle = '#000'; ctx.font = '40px sans-serif'; ctx.fillText('a window drawn for a large screen', 120, 80); };
        w.surface.onConfigure(draw);
        window.__gui = { w, got: [] };
        w.surface.onInput((e) => { if (e.type === 'pointerdown' || e.type === 'pointerup') window.__gui.got.push([e.type, e.x, e.y]); });
        draw();
      });
      await s.page.waitForTimeout(700);
      const g = () => s.page.evaluate(() => { const w = window.__gui.w, c = w.surface.canvas, r = c.getBoundingClientRect(); return { css: [c.offsetWidth, c.offsetHeight], rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)], buffer: [c.width, c.height], note: document.querySelector('.sd-phone-note')?.textContent ?? '', got: window.__gui.got.splice(0) }; });
      const g0 = await g();
      check(`${T} gui: a Linux app's window keeps a large screen's size (its buffer too), shown whole across the phone's width`, g0.css[0] >= 1024 && g0.css[1] >= 720 && g0.buffer[0] === g0.css[0] * 2 && g0.rect[0] === 0 && Math.abs(g0.rect[2] - s.W) <= 1, g0);
      check(`${T} gui: the first time, a line says it was made for a large screen and how to move it`, /made for a large screen/.test(g0.note) && /two fingers/.test(g0.note), g0.note);
      await shot(s, '19-gui-app');
      // Pinch: larger. Two fingers moved: it pans. One finger: the app's pointer, where the finger is.
      const mid = [s.W / 2, Math.min(s.H * 0.3, 200)];
      await fingers(s, [[mid[0] - 30, mid[1]], [mid[0] + 30, mid[1]]], [[mid[0] - 90, mid[1]], [mid[0] + 90, mid[1]]]);
      await s.page.waitForTimeout(300);
      const g1 = await g();
      check(`${T} gui: a pinch makes it larger`, g1.rect[2] > g0.rect[2] * 2 && g1.rect[2] <= g0.css[0] * 3 + 1, `${g0.rect[2]} → ${g1.rect[2]} px wide`);
      await fingers(s, [[mid[0] + 40, mid[1] - 20], [mid[0] + 40, mid[1] + 20]], [[mid[0] - 100, mid[1] - 20], [mid[0] - 100, mid[1] + 20]]);
      await s.page.waitForTimeout(300);
      const g2 = await g();
      check(`${T} gui: two fingers moved sideways pan across it, and its edge stops at the screen's`, g2.rect[0] < g1.rect[0] - 100 && g2.rect[0] + g2.rect[2] >= s.W - 1 && g2.rect[2] === g1.rect[2] && g2.got.filter((e) => e[0] === 'pointerdown').length <= 1 && g2.got.at(-1)?.[0] !== 'pointerdown', `left ${g1.rect[0]} → ${g2.rect[0]}; the app's pointer got ${JSON.stringify(g2.got)}`);
      await tap(s, 100, mid[1]);
      await s.page.waitForTimeout(300);
      const g3 = await g();
      const want = [Math.round((100 - g2.rect[0]) * g2.buffer[0] / g2.rect[2]), Math.round((mid[1] - g2.rect[1]) * g2.buffer[1] / g2.rect[3])];
      const down = g3.got.find((e) => e[0] === 'pointerdown');
      check(`${T} gui: one finger is the app's pointer, at the place under it`, !!down && Math.abs(down[1] - want[0]) <= 3 && Math.abs(down[2] - want[1]) <= 3, `got ${JSON.stringify(down)}, the finger is at ${want.join(',')} of its ${g2.buffer.join('x')} pixels`);
      await shot(s, '20-gui-app-larger');
      // In the switcher its card is as wide as the others
      await pillUp(s);
      const cards = await s.page.evaluate(() => [...document.querySelectorAll('.sd-win[data-phone-card]')].map((c) => [c.dataset.phoneCard, Math.round(c.getBoundingClientRect().width)]));
      check(`${T} gui: in the switcher its card is as wide as the others`, new Set(cards.map((c) => c[1])).size === 1, cards);
      await shot(s, '21-gui-switcher');
      await pillUp(s);
      await s.page.evaluate(() => window.__gui.w.close(true));
      await s.page.waitForTimeout(400);
    }

    if (part('rotate')) {
      if ((await state(s)).focused !== 'terminal') { await pillTap(s); await openFromHome('terminal'); }
      const before = await state(s);
      await s.page.setViewportSize({ width: s.H, height: s.W });
      await s.page.waitForTimeout(900);
      const turned = { ...s, W: s.H, H: s.W };
      const st2 = await state(turned);
      const t2 = await term(turned);
      check(`${T} rotate: turned with apps open, it is still the phone layout with the same apps and the same one in front`, st2.phone && st2.wins.join() === before.wins.join() && st2.focused === 'terminal' && whole(st2) && bare(st2), st2);
      check(`${T} rotate: the terminal has the full height there too`, t2.body[3] / turned.H >= 0.95, `${Math.round(t2.body[3])} of ${turned.H} px`);
      const [px, py] = pillAt(turned);
      await tap(turned, px, py);
      await s.page.waitForTimeout(500);
      const h2 = await home(turned);
      const pill = await s.page.evaluate(() => { const r = document.querySelector('.sd-pill > i').getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(innerHeight - r.bottom)]; });
      check(`${T} rotate: the pill is at the middle of the bottom edge, and Home lays its icons out for the new shape`, Math.abs(pill[0] - turned.W / 2) <= 1 && pill[1] >= 0 && pill[1] < 12 && (turned.W > turned.H ? h2.cols > 4 : h2.cols === 4), `pill at ${pill.join(', ')} from the bottom; ${h2.cols} across`);
      if (shots) await s.page.screenshot({ path: join(shots, `${s.W}x${s.H}-${theme}-14-turned-home.png`) });
      await s.page.setViewportSize({ width: s.W, height: s.H });
      await s.page.waitForTimeout(800);
      const st3 = await state(s);
      check(`${T} rotate: turned back, nothing was lost`, st3.phone && st3.wins.join() === before.wins.join(), st3.wins.join());
    }
  } finally {
    await s.browser.close();
  }
}

// ── The Welcome, and python3 from a cold start ──
async function fresh(width, height, theme) {
  const s = await start(width, height, theme, { init: false });
  s.theme = `${theme}-`;
  const T = s.tag;
  try {
    await boot(s.page);
    if (part('sheets')) {
      await s.page.waitForSelector('.sd-welcome', { timeout: 15_000 }).catch(() => {});
      await s.page.waitForTimeout(600);
      const w = await s.page.evaluate(() => { const e = document.querySelector('.sd-welcome'); if (!e) return null; const r = e.getBoundingClientRect(); return { left: Math.round(r.left), right: Math.round(r.right), bottom: Math.round(r.bottom), top: Math.round(r.top), home: document.getElementById('shiro-desktop').classList.contains('sd-at-home') }; });
      check(`${T} sheets: on a first visit the Welcome is a sheet over Home`, !!w && w.home && w.left === 0 && w.right === s.W && w.bottom === s.H && w.top > 0, w);
      await shot(s, '15-welcome');
      await targets(s, 'The Welcome', ['.sd-welcome']);
      await tapOn(s, '.sd-welcome-demo[data-demo=python]');
      await s.page.waitForTimeout(1500);
      const st = await state(s);
      check(`${T} sheets: a demo chosen closes it, and the Terminal is in front with nothing over it`, !(await s.page.$('.sd-welcome:not(.sd-leaving)')) && st.focused === 'terminal' && !st.home, st);
      await pillTap(s);
    }
    if (part('python')) {
      // From a cold start: Home, one tap on Python, and python3 is running
      const t0 = Date.now();
      await tapOn(s, '.sd-home-page .sd-home-app[data-app=python3] .sd-home-icon');
      const got = await waitText(s, /^>>> /m, 180_000);
      check(`${T} python: one tap on Home's Python icon gets a running python3`, !!got, got ? '' : (await term(s))?.text.slice(-300));
      if (got) {
        await s.page.keyboard.type('print(6 * 7)\n', { delay: 4 });
        const ran = await waitText(s, /^42$/m, 20_000);
        check(`${T} python: it answers`, !!ran);
        measure(`${T} taps from a cold start to a running python3`, `1 (Home → Python; the first time it installs, ${Math.round((Date.now() - t0) / 1000)} s here; before: dock scrolled, then tapped)`);
        await shot(s, '16-python');
      }
    }
  } finally {
    await s.browser.close();
  }
}

// ── A link to an app ──
async function link(width, height, theme) {
  // The link: an app made in one profile, shared as `?app=link#app=…` (docs/APPS.md "Sharing")
  let s = await start(width, height, theme);
  let shared = '';
  try {
    await boot(s.page);
    await side(s, 'cd /home/user && app new count --template form && app install count');
    shared = (await side(s, 'app share count --print')).o.trim().split('\n').pop();
  } finally { await s.browser.close(); }
  const T = `${width}x${height} ${theme}`;
  check(`${T} link: app share prints a link`, /[?#]app=/.test(shared), shared.slice(0, 80));
  if (!/[?#]app=/.test(shared)) return;
  s = await start(width, height, theme);
  s.theme = `${theme}-`;
  try {
    await s.page.goto(new URL(shared.replace(/^https?:\/\/[^/]+/, ''), url).href);
    await s.page.waitForSelector('.tc-overlay', { timeout: 120_000 }).catch(() => {});
    await s.page.waitForTimeout(500);
    const q = await s.page.evaluate(() => { const e = document.querySelector('.tc-overlay'); if (!e) return null; const r = e.getBoundingClientRect(); return { full: e.classList.contains('tc-full'), w: Math.round(r.width), h: Math.round(r.height), buttons: [...e.querySelectorAll('button')].map((b) => b.textContent.trim()) }; });
    check(`${T} link: the install question is the whole screen, with Cancel and Install`, !!q && q.full && q.w === s.W && q.h === s.H && q.buttons.includes('Install') && q.buttons.includes('Cancel'), q);
    await shot(s, '17-link-question');
    await targets(s, 'The install question', ['.tc-overlay']);
    await s.page.evaluate(() => [...document.querySelectorAll('.tc-overlay button')].find((b) => b.textContent.trim() === 'Install').click());
    await s.page.waitForFunction(() => window.__shiroDesktop?.focused()?.appId === 'count', null, { timeout: 60_000 }).catch(() => {});
    await s.page.waitForSelector('.sd-win[data-app=count] iframe', { timeout: 30_000 }).catch(() => {});
    await s.page.waitForTimeout(1200);
    let st = await state(s);
    const mode = () => s.page.evaluate(() => ({ become: document.body.classList.contains('become-active'), bar: !!document.querySelector('.tc-app-back'), path: location.pathname, welcome: !!document.querySelector('.sd-welcome') }));
    let m = await mode();
    check(`${T} link: the link opens as the app on the whole screen, with the pill and no "‹ tabcomputer" bar`, st.focused === 'count' && !st.home && st.pill && st.rect?.[2] === s.W && !st.titlebar && !m.become && !m.bar && !m.welcome, { ...st, ...m });
    await shot(s, '18-link-app');
    await pillTap(s);
    st = await state(s);
    check(`${T} link: the pill leaves it for Home, where the app now has its icon`, st.home && (await home(s)).pages[0].includes('count'), st);
    await tapOn(s, '.sd-home-page .sd-home-app[data-app=count] .sd-home-icon');
    await s.page.waitForTimeout(800);
    // A reload comes back to the app
    await s.page.waitForTimeout(3500);
    await boot(s.page, new URL('/', url).href);
    await s.page.waitForFunction(() => window.__shiroDesktop?.focused()?.appId === 'count', null, { timeout: 30_000 }).catch(() => {});
    st = await state(s);
    check(`${T} link: a reload comes back to the app, not to Home`, st.focused === 'count' && !st.home && st.pill, st);
    // A tab an earlier build's link left in app mode (the bar "‹ tabcomputer"): it opens in the phone layout now
    await s.page.evaluate(() => {
      localStorage.setItem('tabcomputer-become', JSON.stringify({ directory: '/home/user/Apps/count', port: 0, slug: 'count', title: 'Count', app: 'count', back: true }));
      localStorage.removeItem('tabcomputer-desktop-session');
    });
    await boot(s.page, new URL('/count', url).href);
    await s.page.waitForFunction(() => window.__shiroDesktop?.focused()?.appId === 'count', null, { timeout: 30_000 }).catch(() => {});
    await s.page.waitForTimeout(600);
    st = await state(s);
    m = await mode();
    check(`${T} link: a tab an earlier build left as the app, with its bar, is the phone layout with the app open`, st.phone && st.focused === 'count' && st.pill && !m.become && !m.bar && m.path === '/', { ...st, ...m });
  } finally {
    await s.browser.close();
  }
}

// ── The desktop on larger screens: untouched ──
async function desktopShot(to, width, height) {
  const s = await start(width, height, 'dark', { touch: false });
  try {
    // One moment for both builds: the menu bar's clock is in the picture
    await s.page.clock.setFixedTime(new Date('2026-10-13T10:10:00'));
    await boot(s.page, to);
    await s.page.evaluate(() => { for (const t of document.querySelectorAll('.xterm-cursor-blink')) t.classList.remove('xterm-cursor-blink'); window.__tabcomputer.terminal.term.options.cursorBlink = false; window.__tabcomputer.terminal.term.blur(); });
    await s.page.mouse.move(640, 300);
    await s.page.waitForTimeout(1200);
    return { png: await s.page.screenshot(), st: await state(s) };
  } finally { await s.browser.close(); }
}
async function desktop() {
  for (const [width, height, touch, name] of [[1280, 800, false, 'a large screen'], [820, 1180, true, 'a tablet upright'], [1180, 820, true, 'a tablet on its side']]) {
    const s = await start(width, height, 'dark', { touch });
    try {
      await boot(s.page);
      const st = await state(s);
      const d = await s.page.evaluate(() => ({
        loaded: !!document.getElementById('sd-phone-style') || !!document.querySelector('.sd-home, .sd-pill, .sd-phone-back'),
        chunk: performance.getEntriesByType('resource').some((r) => /\/phone[-.][^/]*\.(js|ts)|desktop\/phone\.ts/.test(r.name)),
        state: window.__shiroDesktop.focused()?.state, compact: window.__shiroDesktop.compact, phone: window.__shiroDesktop.phone,
        font: window.__tabcomputer.terminal.term.options.fontSize,
      }));
      check(`${width}x${height} desktop: ${name} keeps the desktop: menu bar, dock, a window with its title bar`, !st.phone && st.menubar && st.dock && st.titlebar && !st.pill && !st.homeEl && d.state === 'normal' && !d.compact && !d.phone && d.font === 14, { ...st, ...d });
      check(`${width}x${height} desktop: no part of the phone layout is loaded`, !d.loaded && !d.chunk, d);
      if (shots) await s.page.screenshot({ path: join(shots, `${width}x${height}-desktop.png`) });
      if (width === 1280) {
        // A window made narrow becomes the phone layout with its apps, and wide again the desktop
        await s.page.evaluate(() => window.__shiroDesktop.openApp('files'));
        await s.page.waitForTimeout(900);
        const wins = (await state(s)).wins.join();
        await s.page.setViewportSize({ width: 520, height: 800 });
        await s.page.waitForFunction(() => document.querySelector('.sd-pill'), null, { timeout: 20_000 }).catch(() => {});
        await s.page.waitForTimeout(700);
        const narrow = await state(s);
        check('1280x800 desktop: the window made 520 px wide becomes the phone layout, the same apps open and the same one in front', narrow.phone && narrow.pill && !narrow.menubar && !narrow.dock && !narrow.titlebar && narrow.wins.join() === wins && narrow.focused === 'files' && !narrow.home, narrow);
        if (shots) await s.page.screenshot({ path: join(shots, '520x800-narrow-window.png') });
        // (a mouse works the pill: a click is its tap)
        await s.page.mouse.click(260, 792);
        await s.page.waitForTimeout(500);
        check('1280x800 desktop: there, a click on the pill goes Home', (await state(s)).home);
        if (shots) await s.page.screenshot({ path: join(shots, '520x800-narrow-window-home.png') });
        await s.page.setViewportSize({ width: 1280, height: 800 });
        await s.page.waitForTimeout(900);
        const wide = await state(s);
        const back = await s.page.evaluate(() => ({ font: window.__tabcomputer.terminal.term.options.fontSize, tools: document.querySelectorAll('.sd-menubar .sd-mb-status').length, home: !!document.querySelector('.sd-home, .sd-pill') }));
        check('1280x800 desktop: wide again it is the desktop, with its menu bar\'s buttons back, the apps open and one in front', !wide.phone && wide.menubar && wide.dock && wide.titlebar && wide.wins.join() === wins && !!wide.focused && back.font === 14 && back.tools >= 3 && !back.home, { ...wide, ...back });
        // ?ui=phone and ?ui=desktop force either
        await boot(s.page, new URL('/?ui=phone', url).href);
        check('1280x800 desktop: ?ui=phone forces the phone layout', (await state(s)).phone);
        if (shots) await s.page.screenshot({ path: join(shots, '1280x800-ui-phone.png') });
      }
    } finally { await s.browser.close(); }
  }
  // …and a phone with ?ui=desktop gets the desktop
  const s = await start(393, 852, 'dark');
  try {
    await boot(s.page, new URL('/?ui=desktop', url).href);
    const st = await state(s);
    check('393x852: ?ui=desktop forces the desktop on a phone', !st.phone && st.menubar && st.dock && !st.pill, st);
    // The setting does the same, at once
    await boot(s.page, url);
    await s.page.evaluate(() => window.__shiroDesktop.openApp('settings', { pane: 'appearance' }));
    await s.page.waitForSelector('[data-layout=desktop]', { timeout: 20_000 });
    await s.page.evaluate(() => document.querySelector('[data-layout=desktop]').click());
    await s.page.waitForTimeout(700);
    const set = await state(s);
    check('393x852: Settings → Appearance → Layout: Desktop switches at once, and is remembered', !set.phone && set.menubar && (await s.page.evaluate(() => localStorage.getItem('tabcomputer-layout'))) === 'desktop', set);
    await s.page.evaluate(() => document.querySelector('[data-layout=auto]').click());
    await s.page.waitForTimeout(700);
    check('393x852: Automatic gives the phone its layout back', (await state(s)).phone);
  } finally { await s.browser.close(); }

  if (baseline) {
    const mine = await desktopShot(url, 1280, 800);
    const theirs = await desktopShot(baseline, 1280, 800);
    const same = Buffer.compare(mine.png, theirs.png) === 0;
    let detail = 'the two pictures are the same bytes';
    if (!same) {
      // Count the pixels that differ, in a page
      const b = await chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium') });
      try {
        const p = await b.newPage();
        const n = await p.evaluate(async ([a, c]) => {
          const load = async (u) => { const i = new Image(); i.src = u; await i.decode(); const k = document.createElement('canvas'); k.width = i.width; k.height = i.height; const x = k.getContext('2d'); x.drawImage(i, 0, 0); return x.getImageData(0, 0, i.width, i.height); };
          const [x, y] = [await load(a), await load(c)];
          if (x.width !== y.width || x.height !== y.height) return -1;
          let d = 0, box = [1e9, 1e9, 0, 0];
          for (let i = 0; i < x.data.length; i += 4) if (x.data[i] !== y.data[i] || x.data[i + 1] !== y.data[i + 1] || x.data[i + 2] !== y.data[i + 2]) { d++; const px = (i / 4) % x.width, py = Math.floor(i / 4 / x.width); box = [Math.min(box[0], px), Math.min(box[1], py), Math.max(box[2], px), Math.max(box[3], py)]; }
          return d ? `${d} pixels differ, within ${box.join(',')}` : 0;
        }, [`data:image/png;base64,${mine.png.toString('base64')}`, `data:image/png;base64,${theirs.png.toString('base64')}`]);
        detail = n === 0 ? 'the same pixels (the files differ in their encoding only)' : String(n);
        check('1280x800 desktop: pixel for pixel the same as the other build', n === 0, detail);
      } finally { await b.close(); }
    } else check('1280x800 desktop: pixel for pixel the same as the other build', true, detail);
    if (shots) { writeFileSync(join(shots, '1280x800-desktop-this-build.png'), mine.png); writeFileSync(join(shots, '1280x800-desktop-other-build.png'), theirs.png); }
  }
}

let n = 0;
for (const [w, h] of sizes) for (const theme of themes) {
  if (['home', 'apps', 'pill', 'switcher', 'terminal', 'keyboard', 'sheets', 'gui', 'rotate'].some(part)) await phone(w, h, theme, n === 0);
  n++;
}
if (part('sheets') || part('python')) await fresh(sizes[0][0], sizes[0][1], themes[0]);
if (part('link')) await link(sizes[0][0], sizes[0][1], themes[0]);
if (part('desktop')) await desktop();

if (measured.length) { console.log('\nMeasured'); for (const [k, v] of measured) console.log(`  ${k}: ${v}`); }
if (small.size) {
  console.log('\nTargets under 44 px (width x height in CSS px)');
  for (const [where, set] of small) console.log(`  ${where}: ${set.size ? [...set].sort().join('; ') : 'none'}`);
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
