// Quitting Debian GUI apps (#118): after a quit nothing of the app is left: no process (running
// or zombie), no window, no X client, no running mark in the dock, no launch in flight.
// Geany is quit three ways (the title bar's close button, Ctrl+Q, File → Quit), xeyes by its
// close button. From a fresh browser profile; the apps are installed from the server's mirror.
//
//   npx vite build && PORT=5391 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/gui-quit.mjs [URL] [APP...]        (default: xeyes geany)
//
// PLAYWRIGHT=/path/to/playwright-core and CHROMIUM=/path/to/chrome pick the tools. Exits 1 on a failure.
import { createRequire } from 'node:module';
import { chromiumPath } from './_browser.mjs';
const require = createRequire(import.meta.url);
let pw;
for (const name of [process.env.PLAYWRIGHT, 'playwright', '/opt/node-tools/node_modules/playwright', 'playwright-core'].filter(Boolean)) {
  try { pw = require(name); break; } catch { /* next */ }
}
if (!pw) { console.error('playwright not found (set PLAYWRIGHT)'); process.exit(2); }
const args = process.argv.slice(2);
const url = args[0]?.includes('://') ? args.shift() : 'http://localhost:5299/';
const apps = args.length ? args : ['xeyes', 'geany'];
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const WAYS = { geany: ['close button', 'Ctrl+Q', 'File → Quit'] };

const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 90_000 });

/** What is left of `app`: its processes with their state, windows, the dock's mark, the launch, the display's clients */
const left = (app) => page.evaluate((app) => {
  const T = window.__tabcomputer;
  const tile = document.querySelector(`.sd-dock [data-app="${app}"]`);
  return {
    procs: [...T.kernel.procs.values()].filter((p) => (p.comm ?? '').includes(app)).map((p) => `${p.pid}:${p.state}`),
    windows: T.desktop.windows().filter((w) => w.appId === app).map((w) => w.title),
    dockRunning: !!tile?.classList.contains('sd-running'),
    dockStarting: !!tile?.classList.contains('sd-starting'),
    launch: T.desktop.launches?.get(app)?.stage ?? null,
    xClients: window.__shiroX ? window.__shiroX.server.clients.size : 0,
  };
}, app);

let failed = 0;
for (const app of apps) {
  await page.waitForFunction((app) => window.__tabcomputer.desktop.apps().some((a) => a.id === app), app, { timeout: 30_000 });
  for (const way of WAYS[app] ?? ['close button']) {
    try {
      const x0 = (await left(app)).xClients;
      await page.evaluate((app) => { void window.__tabcomputer.desktop.openApp(app); }, app);
      await page.waitForFunction((app) => window.__tabcomputer.desktop.windows().some((w) => w.appId === app && w.surface && !w.id.startsWith('launching-')), app, { timeout: 300_000, polling: 100 });
      await page.waitForTimeout(2500); // drawn and idle
      const up = await left(app);
      if (!up.procs.length || !up.dockRunning) throw new Error(`while it runs: ${JSON.stringify(up)}`);
      const box = await page.evaluate((app) => { const w = window.__tabcomputer.desktop.windows().find((w) => w.appId === app && w.surface); const r = w.surface.canvas.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }, app);
      const t0 = Date.now();
      if (way === 'close button') {
        await page.evaluate((app) => { for (const w of window.__tabcomputer.desktop.windows()) if (w.appId === app) w.close(); }, app);
      } else {
        await page.mouse.click(box.x + box.w / 2, box.y + box.h * 0.5); // the keyboard goes to it
        await page.waitForTimeout(300);
        if (way === 'Ctrl+Q') await page.keyboard.press('Control+q');
        else { await page.keyboard.press('Alt+f'); await page.waitForTimeout(800); await page.keyboard.press('q'); }
      }
      let now;
      for (let i = 0; i < 100; i++) {
        now = await left(app);
        if (!now.procs.length && !now.windows.length && !now.dockRunning && !now.launch && now.xClients <= Math.max(1, x0)) break;
        await page.waitForTimeout(100);
      }
      if (now.procs.length || now.windows.length || now.dockRunning || now.dockStarting || now.launch || now.xClients > Math.max(1, x0)) throw new Error(`10 s after the quit: ${JSON.stringify(now)}`);
      console.log(`ok   ${app}: ${way}: gone in ${Date.now() - t0} ms (no process, window, X client or dock mark)`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${app}: ${way}: ${String(e.message).split('\n')[0]}`);
      await page.evaluate((app) => { const k = window.__tabcomputer.kernel; for (const p of k.procs.values()) if ((p.comm ?? '').includes(app)) k.kill(p.pid, 9); }, app);
      await page.waitForTimeout(1000);
    }
  }
}
if (errors.length) { failed++; console.log(`FAIL page errors: ${errors.join('; ').slice(0, 400)}`); }
await browser.close();
process.exit(failed ? 1 : 0);
