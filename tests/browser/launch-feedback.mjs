// Launch feedback (docs/DESKTOP.md "Launch feedback"), in Chromium:
//   dock          an app that was asked for has a pulsing mark on its dock tile (its own tile, a
//                 tile that appears for an app not in the dock, its stack's tile and its entry in
//                 the stack), labelled "NAME is starting", until its first window; the same mark
//                 in every icon set; a steady one with reduced motion
//   once          asking again (the dock, `desktop open`, `gui APP`) starts nothing and brings
//                 the placeholder forward
//   placeholder   a partly transparent window behind the others, not focused, with the stage in
//                 words, a bar that is a real fraction or indeterminate, the newest output line
//                 and "Show details"; the app's first window takes its place in the same task
//                 (a splash screen doesn't); its last geometry is reserved next time
//   failure       the process ending without a window: the error (selectable), Close and Retry;
//                 half an hour of nothing is not a failure
//   cancel        closing the placeholder, and what it says
//   restore       an app the saved session reopens gets its placeholder where its window was
//   phone         at 360 px the placeholder is in front and inside the viewport
//
// The Debian apps themselves can't run without the package mirror, so the installer and the
// process are a stand-in the test drives (configureGuiLaunch in src/gui/launch.ts): everything
// from the app's dock entry and the `gui` command down to the launch state machine, the dock and
// the placeholder is the real code. The app's "window" is a surface window the test creates.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/launch-feedback.mjs [URL] [--shots DIR]
//
// Exits 1 if any check fails.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const require = createRequire(import.meta.url);
let pw;
pw = loadPlaywright();
const { chromium } = pw;
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? `: ${detail}` : ''}`); if (!ok) failed++; };
const shot = async (page, name, clip) => { if (shots) await page.screenshot({ path: join(shots, `launch-${name}.png`), ...(clip ? { clip } : {}) }); };

/** Before the page's scripts: the stand-in installer and process, handed to src/gui/launch.ts as it loads */
const standIn = () => {
  try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {}
  const fake = window.__fakeGui = { installed: false, installs: 0, spawns: 0, configured: false };
  fake.apps = {
    isAppInstalled: async () => fake.installed,
    installApp: (_fs, _kernel, _name, onProgress, log) => {
      fake.installs++;
      fake.progress = onProgress;
      fake.log = log;
      return new Promise((res, rej) => { fake.finishInstall = (err) => { if (err) rej(new Error(err)); else { fake.installed = true; res({}); } }; });
    },
    launchApp: async (_kernel, _name, _args, _env, o) => {
      fake.spawns++;
      fake.output = o?.onOutput;
      // (an app restored from a snapshot: its window is up before the launcher has its process)
      if (fake.windowFirst) window.__shiroDesktop.createWindow({ appId: 'gimp', title: 'GNU Image Manipulation Program', width: 520, height: 340, content: { kind: 'surface' } });
      return { pid: 900000 + fake.spawns, exited: new Promise((r) => { fake.exit = r; }), output: () => '' };
    },
  };
  // the page's live modules (src/hotswap/live.ts) register here as they load
  class Live extends Map {
    set(key, ns) {
      if (key === 'src/gui/launch.ts') { try { ns.configureGuiLaunch({ apps: fake.apps }); fake.configured = true; } catch (e) { fake.error = String(e); } }
      return super.set(key, ns);
    }
  }
  globalThis.__tabcomputerLive = new Live();
};

const boot = async (page) => {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.terminal && window.__tabcomputer.kernel && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  // the Debian apps are registered (and with them src/gui/launch.ts is loaded)
  await page.waitForFunction(() => window.__shiroDesktop.apps().some((a) => a.id === 'gimp') && window.__fakeGui.configured, null, { timeout: 60_000 });
  await page.waitForTimeout(600);
};

/** State of the launch, its dock tile and its placeholder */
const look = (page, id = 'gimp') => page.evaluate((id) => {
  const wm = window.__shiroDesktop;
  const l = wm.launches.get(id);
  const tile = document.querySelector(`.sd-dock > .sd-dock-item[data-app="${id}"]`);
  const dot = tile ? getComputedStyle(tile, '::after') : null;
  const ph = document.querySelector(`.sd-launch-win[data-launch="${id}"]`);
  const q = (sel) => ph?.querySelector(sel);
  const shownText = (sel) => { const e = q(sel); return e && !e.hidden ? e.textContent : null; };
  const zs = [...document.querySelectorAll('.sd-win')].filter((w) => w !== ph && getComputedStyle(w).display !== 'none').map((w) => Number(w.style.zIndex));
  const r = ph?.getBoundingClientRect();
  const bar = q('.sd-launch-bar');
  const line = ph?.querySelector(':scope > .sd-launch-line');
  return {
    stage: l?.stage ?? null,
    tile: tile ? {
      cls: [...tile.classList].filter((c) => /starting|start-failed|running/.test(c)).join(' '),
      label: tile.getAttribute('aria-label'), busy: tile.getAttribute('aria-busy'), tip: tile.querySelector('.sd-dock-tip')?.textContent,
      dot: { w: dot.width, opacity: dot.opacity, anim: dot.animationName, shadow: dot.boxShadow, bg: dot.backgroundColor, border: dot.borderTopWidth },
    } : null,
    ph: ph ? {
      rect: { x: ph.offsetLeft, y: ph.offsetTop, w: ph.offsetWidth, h: ph.offsetHeight },
      title: ph.querySelector('.sd-title')?.textContent,
      line: line ? { shown: getComputedStyle(line).display !== 'none', indeterminate: line.classList.contains('sd-indeterminate'), width: line.firstElementChild.style.width } : null,
      inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      behind: zs.length > 0 && zs.every((z) => Number(ph.style.zIndex) < z),
      front: zs.every((z) => Number(ph.style.zIndex) > z),
      bg: getComputedStyle(ph).backgroundColor,
      flash: ph.classList.contains('sd-launch-flash'),
      label: ph.getAttribute('aria-label'),
      name: shownText('.sd-launch-name'), stageText: shownText('.sd-launch-stage'), error: shownText('.sd-launch-error'),
      amount: shownText('.sd-launch-amount'), note: shownText('.sd-launch-note'), last: shownText('.sd-launch-last'), log: shownText('.sd-launch-log'),
      bar: bar && !bar.hidden ? { indeterminate: bar.classList.contains('sd-indeterminate'), now: bar.getAttribute('aria-valuenow'), width: bar.firstElementChild.style.width, anim: getComputedStyle(bar.firstElementChild).animationName } : null,
      buttons: [...ph.querySelectorAll('.sd-launch-actions button')].filter((b) => !b.hidden).map((b) => b.textContent),
      errorSelect: q('.sd-launch-error') ? getComputedStyle(q('.sd-launch-error')).userSelect : null,
      scrolls: q('.sd-launch').scrollWidth > q('.sd-launch').clientWidth + 1,
    } : null,
    focused: wm.focused()?.id ?? null,
    activeInTerminal: !!document.activeElement?.closest?.('[data-id="terminal"]'),
    installs: window.__fakeGui.installs, spawns: window.__fakeGui.spawns,
  };
}, id);
/** The background's alpha (rgba(...) or color(srgb ... / a)) */
const alpha = (css) => { const m = /\/\s*([\d.]+)\)$/.exec(css) ?? /rgba\([^)]*,\s*([\d.]+)\)$/.exec(css); return m ? Number(m[1]) : 1; };
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__lfShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
/** The app's first window: a surface window of its own, as the X server would make */
const appWindow = (page, o = {}) => page.evaluate((o) => {
  const wm = window.__shiroDesktop;
  const ph = document.querySelector('.sd-launch-win[data-launch="gimp"]');
  const before = ph ? { x: ph.offsetLeft, y: ph.offsetTop, w: ph.offsetWidth, h: ph.offsetHeight } : null;
  const w = wm.createWindow({ appId: 'gimp', title: o.title ?? 'GNU Image Manipulation Program', width: o.width ?? 520, height: o.height ?? 340, content: { kind: 'surface' }, ...(o.splash ? { splash: true, decorations: 'none' } : {}) });
  // read in the same task the window was created in: nothing was painted in between
  const el = w.element, r = el.getBoundingClientRect(), cs = getComputedStyle(el);
  const still = [...document.querySelectorAll('.sd-launch-win[data-launch="gimp"]')].filter((e) => getComputedStyle(e).display !== 'none').length;
  return {
    id: w.id, before,
    // as drawn: a window still animating in would be smaller and see-through here
    rect: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
    placeholders: still, opening: el.classList.contains('sd-opening') || cs.opacity !== '1' || cs.transform !== 'none', stage: wm.launches.get('gimp')?.stage ?? null, focused: wm.focused()?.id,
  };
}, o);
const closeApp = (page) => page.evaluate(() => { for (const w of window.__shiroDesktop.windows()) if (w.appId === 'gimp' && w.kind === 'surface') w.close(true); });
const dockClip = async (page) => {
  const r = await page.evaluate(() => { const b = document.querySelector('.sd-dock').getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
  const vp = page.viewportSize();
  const x = Math.max(0, r.x - 12), y = Math.max(0, r.y - 30);
  return { x, y, width: Math.min(vp.width - x, r.w + 24), height: Math.min(vp.height - y, r.h + 40) };
};

const browser = await chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
try {
  // ── Desktop, dark ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    await context.addInitScript(standIn);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await boot(page);

    // An app that isn't installed, asked for like a click (the launcher, `desktop open`)
    await page.evaluate(() => { void window.__shiroDesktop.openApp('gimp'); });
    await page.waitForSelector('.sd-launch-win[data-launch="gimp"]', { timeout: 5000 });
    let s = await look(page);
    check(s.stage === 'installing' && s.installs === 1, 'asked for: the launch is installing', `${s.stage}, ${s.installs} install`);
    check(s.tile?.cls === 'sd-starting' && s.tile.label === 'GIMP is starting' && s.tile.busy === 'true' && s.tile.tip === 'GIMP — Installing…',
      'dock: a tile for it with the starting mark and label', JSON.stringify(s.tile && { cls: s.tile.cls, label: s.tile.label, busy: s.tile.busy, tip: s.tile.tip }));
    check(s.tile?.dot.anim === 'sd-start-pulse' && s.tile.dot.w === '6px' && s.tile.dot.opacity === '1', 'dock: the mark is a 6 px dot that pulses', JSON.stringify(s.tile?.dot));
    check(s.ph?.behind && s.focused === 'terminal' && s.activeInTerminal, 'placeholder: behind the other windows, the Terminal keeps the focus and the keyboard', `behind ${s.ph?.behind}, focused ${s.focused}`);
    check(alpha(s.ph?.bg ?? '') < 0.9, 'placeholder: partly transparent', s.ph?.bg);
    check(s.ph?.name === 'GIMP' && s.ph.stageText === 'Installing…' && s.ph.bar?.indeterminate && s.ph.bar.now === null && s.ph.bar.anim === 'sd-launch-slide',
      'placeholder: name, "Installing…", an indeterminate bar while the amount is unknown', JSON.stringify(s.ph && { stage: s.ph.stageText, bar: s.ph.bar }));
    check(s.ph?.label === 'GIMP — Installing…' && s.ph.title === s.ph.label && s.ph.line?.shown && s.ph.line.indeterminate && s.ph.buttons.join() === 'Cancel',
      'placeholder: its title bar says the stage too, with a progress line; Cancel', `${s.ph?.label} [${s.ph?.buttons}] ${JSON.stringify(s.ph?.line)}`);

    // A real amount: bytes unpacked of bytes to install
    await page.evaluate(() => {
      window.__fakeGui.progress({ phase: 'unpack', done: 31, total: 83, bytes: 9e6, totalBytes: 53e6, doneBytes: 21.2e6 });
      window.__fakeGui.log('trigger glib-compile-schemas: status 0 in 812 ms');
    });
    await page.waitForTimeout(450);
    s = await look(page);
    check(s.ph?.stageText === 'Installing 53 MB…' && s.ph.amount === '21 of 53 MB' && s.ph.bar?.indeterminate === false && s.ph.bar.now === '40' && parseFloat(s.ph.bar.width) === 40,
      'placeholder: "Installing 53 MB…", 21 of 53 MB, the bar at 40%', JSON.stringify(s.ph && { stage: s.ph.stageText, amount: s.ph.amount, bar: s.ph.bar }));
    check(s.ph?.last === 'trigger glib-compile-schemas: status 0 in 812 ms', 'placeholder: the newest output line', s.ph?.last ?? '');
    check(s.ph?.title === 'GIMP — Installing 53 MB…' && parseFloat(s.ph.line?.width) === 40 && !s.ph.line.indeterminate && s.tile?.tip === 'GIMP — Installing 53 MB…',
      'placeholder: the title bar and its line follow, and the dock tile\'s tooltip', `${s.ph?.title} ${JSON.stringify(s.ph?.line)} tip ${s.tile?.tip}`);
    await shot(page, 'installing-dark');
    await shot(page, 'dock-dark', await dockClip(page));

    // Asked for again, three ways: nothing new starts, the placeholder comes forward
    await page.locator('.sd-dock > .sd-dock-item[data-app="gimp"]').click();
    await page.waitForTimeout(150);
    s = await look(page);
    check(s.installs === 1 && s.focused === 'launching-gimp' && s.ph?.flash && s.ph.front, 'again (dock click): no second install; the placeholder is focused, in front, flashing', `${s.installs} install, focused ${s.focused}, flash ${s.ph?.flash}`);
    await page.evaluate(() => window.__shiroDesktop.get('terminal').focus());
    const open2 = await sh(page, 'desktop open gimp');
    s = await look(page);
    check(s.installs === 1 && s.focused === 'launching-gimp' && /launching-gimp/.test(open2.out), 'again (desktop open gimp): the placeholder again', `${s.installs} install, ${open2.out.trim()}`);
    await page.evaluate(() => window.__shiroDesktop.get('terminal').focus());
    const gui2 = await sh(page, 'gui gimp');
    s = await look(page);
    check(s.installs === 1 && s.spawns === 0 && /already starting/.test(gui2.out) && gui2.code === 0 && s.focused === 'launching-gimp', 'again (gui gimp): "already starting", nothing started', gui2.out.trim());

    // Details, then the install finishes and the process starts
    await page.locator('.sd-launch-win[data-launch="gimp"] .sd-launch-more').click();
    s = await look(page);
    check(s.ph?.log === 'trigger glib-compile-schemas: status 0 in 812 ms' && s.ph.last === null, 'Show details opens the log', s.ph?.log ?? '');
    await page.locator('.sd-launch-win[data-launch="gimp"] .sd-launch-more').click();
    await page.evaluate(() => { window.__fakeGui.progress({ phase: 'triggers', done: 83, total: 83, bytes: 53e6, totalBytes: 53e6, doneBytes: 53e6 }); });
    await page.waitForTimeout(100);
    s = await look(page);
    check(s.ph?.stageText === 'Setting up…' && s.ph.bar?.indeterminate && s.ph.amount === '', 'setting up: no amount, an indeterminate bar', JSON.stringify(s.ph && { stage: s.ph.stageText, amount: s.ph.amount }));
    await page.evaluate(() => { window.__fakeGui.finishInstall(); });
    await page.waitForFunction(() => window.__shiroDesktop.launches.get('gimp')?.stage === 'starting', null, { timeout: 5000 });
    await page.evaluate(() => { window.__fakeGui.output('gimp: loading plug-ins\n'); });
    await page.waitForTimeout(150);
    s = await look(page);
    check(s.spawns === 1 && s.ph?.stageText === 'Starting…' && s.ph.note === 'takes a while to start' && s.ph.last === 'gimp: loading plug-ins' && s.ph.bar?.indeterminate,
      'starting: "Starting…", the app\'s note, its output line, an indeterminate bar', JSON.stringify(s.ph && { stage: s.ph.stageText, note: s.ph.note, last: s.ph.last }));
    check(s.tile?.cls === 'sd-starting', 'dock: still marked after the dock re-rendered', s.tile?.cls ?? '');
    await page.evaluate(() => window.__shiroDesktop.get('terminal').focus());
    await shot(page, 'starting-dark');

    // A splash screen is not the app's window
    const splash = await appWindow(page, { splash: true, title: 'GIMP Startup', width: 300, height: 180 });
    await page.waitForTimeout(100);
    s = await look(page);
    check(splash.stage === 'window' && splash.placeholders === 1 && s.ph?.stageText === 'Opening window…' && /sd-starting/.test(s.tile?.cls ?? ''), 'a splash screen: "Opening window…", the placeholder and the mark stay', `${splash.stage}, ${s.ph?.stageText}`);
    await page.evaluate((id) => window.__shiroDesktop.get(id).close(true), splash.id);

    // Its first window takes the placeholder's place
    const first = await appWindow(page);
    check(first.placeholders === 0 && !first.opening && first.stage === null, 'first window: the placeholder is gone in the same task, the window is there without an opening animation', JSON.stringify({ placeholders: first.placeholders, opening: first.opening }));
    check(first.before && first.rect.x === first.before.x && first.rect.y === first.before.y, 'first window: at the placeholder\'s position', `${JSON.stringify(first.before)} → ${JSON.stringify(first.rect)}`);
    check(first.rect.w === 520 && first.rect.h === 340 + 38 && first.focused === first.id, 'first window: its own size (the placeholder\'s was a guess), focused', `${first.rect.w} wide`);
    await page.waitForTimeout(200);
    s = await look(page);
    check(s.stage === null && s.tile?.cls === 'sd-running' && s.tile.label === 'GIMP' && s.tile.busy === null && s.tile.dot.anim === 'none', 'dock: running, the ordinary dot', JSON.stringify(s.tile && { cls: s.tile.cls, label: s.tile.label }));
    await shot(page, 'running-dark');

    // Where the window is now is where the next placeholder goes, and the app gets that size
    await page.evaluate((id) => window.__shiroDesktop.get(id).setGeometry({ x: 420, y: 90, width: 600, height: 380 }), first.id);
    await page.waitForTimeout(600);
    await closeApp(page);
    await page.waitForTimeout(300);
    await page.evaluate(() => { void window.__shiroDesktop.openApp('gimp'); });
    await page.waitForSelector('.sd-launch-win[data-launch="gimp"]', { timeout: 5000 });
    s = await look(page);
    const wa = await page.evaluate(() => window.__shiroDesktop.workArea());
    check(s.ph?.rect.x === 420 && s.ph.rect.y === wa.y + 90 && s.ph.rect.w === 600 && s.ph.rect.h === 380 + 38 && s.installs === 1 && s.stage === 'starting',
      'second start: the placeholder is where the window was, no install', `${JSON.stringify(s.ph?.rect)} remembered ${await page.evaluate(() => localStorage.getItem('tabcomputer-launch-geometry'))}`);
    const second = await appWindow(page);
    check(second.rect.x === 420 && second.rect.w === 600 && second.rect.h === 380 + 38 && second.placeholders === 0, 'second start: the window takes the same place and size', JSON.stringify(second.rect));
    await closeApp(page);
    await page.waitForTimeout(300);

    // A window that is up before the launcher has its process (an app restored from a snapshot:
    // docs/research/GUI_SNAPSHOTS.md) is a start, not a cancelled launch: nothing is stopped
    await page.evaluate(() => {
      const k = window.__tabcomputer.kernel, kill = k.kill.bind(k);
      window.__fakeGui.windowFirst = true;
      window.__fakeGui.kills = 0;
      k.kill = (pid, sig, ...rest) => { if (pid >= 900000) window.__fakeGui.kills++; return kill(pid, sig, ...rest); };
    });
    const early = await sh(page, 'gui gimp');
    await page.waitForTimeout(2300); // (a stopped process would get SIGKILL two seconds after SIGTERM)
    s = await look(page);
    const kills = await page.evaluate(() => { window.__fakeGui.windowFirst = false; return window.__fakeGui.kills; });
    check(early.code === 0 && /gimp started \(pid 9\d+\)/.test(early.out) && kills === 0 && s.stage === null && s.ph === null && s.tile?.cls === 'sd-running',
      'a window before the process is known: started, running, nothing stopped', `${early.out.trim()} (exit ${early.code}), ${kills} kills, ${s.tile?.cls}`);
    await closeApp(page);
    await page.waitForTimeout(300);

    // The process ends without a window
    await page.evaluate(() => { void window.__shiroDesktop.openApp('gimp'); });
    await page.waitForFunction(() => window.__shiroDesktop.launches.get('gimp')?.stage === 'starting', null, { timeout: 5000 });
    await page.evaluate(() => { window.__fakeGui.output('gimp: error while loading shared libraries: libgegl-0.4.so.0: cannot open shared object file\n'); window.__fakeGui.exit(127 << 8); });
    await page.waitForFunction(() => window.__shiroDesktop.launches.get('gimp')?.stage === 'failed', null, { timeout: 5000 });
    await page.waitForTimeout(150);
    s = await look(page);
    check(s.ph?.error === 'GIMP quit before opening a window (exit status 127).' && s.ph.errorSelect === 'text' && /libgegl/.test(s.ph.log ?? '') && s.ph.bar === null,
      'failure: the placeholder says why, selectable, with the output', JSON.stringify(s.ph && { error: s.ph.error, select: s.ph.errorSelect }));
    check(s.ph?.buttons.join() === 'Close,Retry' && s.ph.front && s.focused !== 'launching-gimp' && s.ph.label === 'GIMP did not start' && !s.ph.line?.shown, 'failure: Close and Retry; in front without taking the focus', `[${s.ph?.buttons}] focused ${s.focused}`);
    check(s.tile?.cls === 'sd-start-failed' && s.tile.label === 'GIMP did not start' && s.tile.dot.anim === 'none', 'dock: a different, steady mark and label', JSON.stringify(s.tile && { cls: s.tile.cls, label: s.tile.label }));
    await shot(page, 'failed-dark');
    const spawnsBefore = s.spawns;
    await page.locator('.sd-dock > .sd-dock-item[data-app="gimp"]').click();
    s = await look(page);
    check(s.spawns === spawnsBefore && s.focused === 'launching-gimp', 'failure: asking again shows the failure, it doesn\'t retry by itself', `${s.spawns} starts`);
    await page.locator('.sd-launch-win[data-launch="gimp"] [data-act=retry]').click();
    await page.waitForFunction((n) => window.__fakeGui.spawns === n + 1 && window.__shiroDesktop.launches.get('gimp')?.stage === 'starting', spawnsBefore, { timeout: 5000 });
    check(true, 'Retry starts it again');

    // A slow start is not a failure: half an hour later it is still starting
    let clockOk = false;
    try {
      await page.clock.install();
      await page.clock.fastForward(30 * 60 * 1000);
      await page.waitForTimeout(1200);
      clockOk = true;
    } catch (e) { console.log(`skip slow start (no page.clock: ${e.message.split('\n')[0]})`); }
    if (clockOk) {
      await page.waitForSelector('.sd-launch-win[data-launch="gimp"]', { timeout: 5000 });
      s = await look(page);
      check(s.stage === 'starting' && s.ph?.stageText === 'Starting…' && /^30:\d\d$/.test(s.ph.amount ?? '') && s.ph.buttons.join() === 'Cancel',
        'half an hour without a window: still starting, the time shown, nothing killed', `${s.stage}, ${s.ph?.amount}`);
    }

    // Cancel while it starts
    await page.evaluate(() => window.__shiroDesktop.get('launching-gimp').focus());
    await page.locator('.sd-launch-win[data-launch="gimp"] [data-act=cancel]').click();
    await page.waitForTimeout(400);
    s = await look(page);
    const toast = await page.evaluate(() => [...document.querySelectorAll('.sd-toast')].map((t) => t.textContent).join(' | '));
    check(s.stage === null && s.ph === null && s.tile === null && /GIMP was stopped before it opened a window/.test(toast), 'cancel while starting: placeholder and mark gone, a note says the app was stopped', toast);
    await page.evaluate(() => document.querySelectorAll('.sd-toast').forEach((t) => t.remove()));
    await context.close();
  }

  // ── Desktop, light: cancel during an install, stacks, icon sets ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
    await context.addInitScript(standIn);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await boot(page);
    await page.evaluate(() => { void window.__shiroDesktop.openApp('gimp'); });
    await page.waitForSelector('.sd-launch-win[data-launch="gimp"]', { timeout: 5000 });
    await page.evaluate(() => { window.__fakeGui.progress({ phase: 'unpack', done: 50, total: 83, bytes: 30e6, totalBytes: 53e6, doneBytes: 33e6 }); });
    await page.waitForTimeout(450);
    let s = await look(page);
    check(alpha(s.ph?.bg ?? '') < 0.9 && s.ph?.behind && s.tile?.dot.anim === 'sd-start-pulse', 'light: the same placeholder and mark', s.ph?.bg);
    await shot(page, 'installing-light');
    await shot(page, 'dock-light', await dockClip(page));

    // The mark is on the dock, outside the tile: the same in every icon set
    const marks = {};
    for (const set of ['classic', 'brutal', 'pixel', 'drafting']) {
      await page.evaluate((set) => window.__shiroDesktopCtx.setIconSet(set), set);
      await page.waitForTimeout(500);
      const t = (await look(page)).tile;
      marks[set] = t && `${t.cls} ${t.dot.w} ${t.dot.anim} ${t.dot.bg}`;
      await shot(page, `dock-light-${set}`, await dockClip(page));
    }
    check(new Set(Object.values(marks)).size === 1 && /sd-starting 6px sd-start-pulse/.test(marks.classic ?? ''), 'icon sets (Classic, Neo-brutalist, One-bit, Drafting): the same mark', JSON.stringify(marks));

    // Closing the placeholder during the install
    await page.locator('.sd-launch-win[data-launch="gimp"] .sd-close').click({ force: true });
    await page.waitForTimeout(400);
    s = await look(page);
    const toast = await page.evaluate(() => [...document.querySelectorAll('.sd-toast')].map((t) => t.textContent).join(' | '));
    check(s.stage === null && s.ph === null && /install finishes in the background/.test(toast), 'cancel while installing: the note says the install finishes in the background', toast);
    await shot(page, 'cancel-light');
    await page.evaluate(() => { window.__fakeGui.finishInstall(); });
    await page.waitForTimeout(300);
    s = await look(page);
    check(s.spawns === 0 && s.stage === null, 'the install it left running finished; the app was not started', `${s.spawns} starts`);

    // An app inside a dock stack
    await page.evaluate(() => {
      const wm = window.__shiroDesktop, live = globalThis.__tabcomputerLive.get('src/gui/launch.ts'), t = window.__tabcomputer;
      wm.registerGroup({ id: 'slow', name: 'Slow apps', order: 70, collapse: 'always' });
      for (const [id, name] of [['slowone', 'Slow One'], ['slowtwo', 'Slow Two']]) {
        wm.registerApp({ id, name, group: 'slow', order: 70, launch: () => { void live.startGuiApp(t.fs, t.kernel, id, { name }); return null; } });
      }
    });
    await page.waitForTimeout(200);
    await page.locator('.sd-stack-tile[data-group="slow"]').click();
    await page.locator('.sd-stack-item', { hasText: 'Slow Two' }).click();
    await page.waitForSelector('.sd-launch-win[data-launch="slowtwo"]', { timeout: 5000 });
    await page.waitForTimeout(400);
    // Its guessed spot was under the Terminal: it is reserved where its title bar shows instead
    const peek = await page.evaluate(() => {
      const ph = document.querySelector('.sd-launch-win[data-launch="slowtwo"]'), r = ph.getBoundingClientRect();
      const seen = [0.08, 0.3, 0.5, 0.7, 0.92].some((f) => ph.contains(document.elementFromPoint(r.left + r.width * f, r.top + 19)));
      return { seen, top: Math.round(r.top), title: ph.querySelector('.sd-title').textContent, behind: Number(ph.style.zIndex) < Number(document.querySelector('.sd-win[data-id="terminal"]').style.zIndex) };
    });
    check(peek.seen && peek.behind && peek.title === 'Slow Two — Starting…', 'a placeholder whose guessed spot is under another window: moved so its title bar, with the stage, shows', JSON.stringify(peek));
    await page.locator('.sd-stack-tile[data-group="slow"]').click();
    await page.waitForSelector('.sd-stack[data-group="slow"]', { timeout: 5000 });
    const stack = await page.evaluate(() => {
      const tile = document.querySelector('.sd-stack-tile[data-group="slow"]');
      const items = [...document.querySelectorAll('.sd-stack[data-group="slow"] .sd-stack-item')].map((i) => ({ name: i.querySelector('.sd-stack-name').textContent, starting: i.classList.contains('sd-starting'), label: i.getAttribute('aria-label'), anim: getComputedStyle(i, '::after').animationName }));
      return { tile: tile.classList.contains('sd-starting'), label: tile.getAttribute('aria-label'), items };
    });
    check(stack.tile && stack.label === 'Slow apps (2): Slow Two is starting', 'stack: its tile has the mark and says which app is starting', stack.label);
    check(stack.items.find((i) => i.name === 'Slow Two')?.starting && stack.items.find((i) => i.name === 'Slow Two').anim === 'sd-start-pulse' && !stack.items.find((i) => i.name === 'Slow One').starting, 'stack: the app\'s entry has the mark, its neighbour doesn\'t', JSON.stringify(stack.items));
    await page.waitForTimeout(1500);
    check(await page.locator('.sd-stack[data-group="slow"]').count() === 1, 'stack: it stays open while the app starts');
    await shot(page, 'stack-light');
    await context.close();
  }

  // ── Reduced motion ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', reducedMotion: 'reduce' });
    await context.addInitScript(standIn);
    const page = await context.newPage();
    await boot(page);
    await page.evaluate(() => { window.__fakeGui.installed = true; void window.__shiroDesktop.openApp('gimp'); });
    await page.waitForSelector('.sd-launch-win[data-launch="gimp"]', { timeout: 5000 });
    const s = await look(page);
    const running = await page.evaluate(() => { const d = getComputedStyle(document.querySelector('.sd-dock > .sd-dock-item.sd-running'), '::after'); return { w: d.width, shadow: d.boxShadow }; });
    check(s.tile?.dot.anim === 'none' && s.tile.dot.w === '6px' && s.tile.dot.shadow !== 'none' && running.w === '4px' && running.shadow === 'none',
      'reduced motion: no pulse; a larger dot with a ring, unlike the running dot', `starting ${s.tile?.dot.w} ${s.tile?.dot.shadow} / running ${running.w} ${running.shadow}`);
    check(s.ph?.bar?.anim === 'none' && s.ph.bar.indeterminate, 'reduced motion: the indeterminate bar is still', s.ph?.bar?.anim ?? '');
    await shot(page, 'reduced-motion-dark');
    await shot(page, 'dock-reduced-motion', await dockClip(page));
    await context.close();
  }

  // ── Session restore: the app comes back with its placeholder where its window was ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark' });
    await context.addInitScript(standIn);
    await context.addInitScript(() => {
      window.__fakeGui.installed = true;
      try {
        localStorage.setItem('tabcomputer-desktop-session', JSON.stringify({ v: 2, windows: [
          { id: 'w7', app: 'gimp', g: { x: 380, y: 110, width: 640, height: 400 }, state: 'normal', restore: { cmd: 'gui gimp', cwd: '/home/user' } },
        ] }));
      } catch {}
    });
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await boot(page);
    await page.waitForSelector('.sd-launch-win[data-launch="gimp"]', { timeout: 30_000 });
    let s = await look(page);
    const wa = await page.evaluate(() => window.__shiroDesktop.workArea());
    check(s.stage === 'starting' && s.spawns === 1 && s.tile?.cls === 'sd-starting', 'restore: the saved app is starting, with its mark', `${s.stage}, ${s.spawns} start`);
    check(s.ph?.rect.x === 380 && s.ph.rect.y === wa.y + 110 && s.ph.rect.w === 640 && s.ph.rect.h === 400 + 38 && s.ph.behind && s.focused === 'terminal',
      'restore: its placeholder is where its window was, behind, the Terminal focused', JSON.stringify(s.ph?.rect));
    await shot(page, 'restore-dark');
    const w = await appWindow(page);
    check(w.rect.x === 380 && w.rect.y === wa.y + 110 && w.rect.w === 640 && w.rect.h === 400 + 38 && w.placeholders === 0, 'restore: the window takes that place', JSON.stringify(w.rect));
    await context.close();
  }

  // ── A phone: 360 px ──
  for (const scheme of ['dark', 'light']) {
    const context = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
    await context.addInitScript(standIn);
    const page = await context.newPage();
    page.on('pageerror', (e) => console.log('pageerror', e.message));
    await boot(page);
    await page.evaluate(() => { void window.__shiroDesktop.openApp('gimp'); });
    await page.waitForSelector('.sd-launch-win[data-launch="gimp"]', { timeout: 5000 });
    await page.evaluate(() => {
      window.__fakeGui.progress({ phase: 'unpack', done: 31, total: 83, bytes: 9e6, totalBytes: 53e6, doneBytes: 21.2e6 });
      window.__fakeGui.log('trigger gdk-pixbuf-query-loaders: status 0 in 1630 ms, a line long enough that it has to be cut short on a phone');
    });
    await page.waitForTimeout(450);
    let s = await look(page);
    const over = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, w: innerWidth, dock: (() => { const t = document.querySelector('.sd-dock > .sd-dock-item[data-app="gimp"]'); const r = t?.getBoundingClientRect(); return r ? r.right <= innerWidth && r.left >= 0 : null; })() }));
    check(s.ph?.inside && s.ph.front && s.focused === 'launching-gimp' && !s.ph.scrolls && over.sw <= over.w, `phone ${scheme}: the placeholder is in front, inside the viewport, nothing scrolls sideways`, JSON.stringify(s.ph?.rect));
    check(s.ph?.stageText === 'Installing 53 MB…' && s.ph.amount === '21 of 53 MB' && s.ph.buttons.join() === 'Cancel', `phone ${scheme}: stage, amount and Cancel show`, `${s.ph?.stageText} ${s.ph?.amount}`);
    check(s.tile?.cls === 'sd-starting', `phone ${scheme}: the dock tile has the mark`, s.tile?.cls ?? 'no tile');
    await page.evaluate(() => document.querySelector('.sd-dock > .sd-dock-item[data-app="gimp"]')?.scrollIntoView({ inline: 'center' }));
    await shot(page, `phone-${scheme}`);
    if (scheme === 'dark') {
      await page.evaluate(() => { window.__fakeGui.finishInstall(); });
      await page.waitForFunction(() => window.__shiroDesktop.launches.get('gimp')?.stage === 'starting', null, { timeout: 5000 });
      await page.evaluate(() => { window.__fakeGui.output('Gtk-WARNING **: cannot open display\n(gimp:412): GLib-GObject-CRITICAL **: g_object_unref: assertion failed\n'); window.__fakeGui.exit(1 << 8); });
      await page.waitForFunction(() => window.__shiroDesktop.launches.get('gimp')?.stage === 'failed', null, { timeout: 5000 });
      await page.waitForTimeout(200);
      s = await look(page);
      check(s.ph?.inside && !s.ph.scrolls && s.ph.buttons.join() === 'Close,Retry' && /quit before opening a window/.test(s.ph.error ?? ''), 'phone: the failure fits too, with Close and Retry', JSON.stringify(s.ph?.rect));
      await shot(page, 'phone-failed-dark');
    }
    await context.close();
  }
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
