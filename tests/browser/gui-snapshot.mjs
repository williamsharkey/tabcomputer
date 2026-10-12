// Snapshots of started GUI apps (docs/research/GUI_SNAPSHOTS.md; src/gui/snapshot.ts).
// Per app, in a fresh browser profile with the setting on:
//   1. the first launch starts the program and, once it is up and quiet, keeps its snapshot;
//   2. after a reload of the page, the next launch is restored from it: timed click → window;
//   3. the restored app is used (the pointer for xeyes, typing for the editors) and must react;
//   4. it is closed, and its process must end and leave nothing behind;
//   5. another launch in the same page is restored again.
//
//   npx vite build && PORT=5391 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/gui-snapshot.mjs [URL] [--json FILE] [APP...]     (default: xeyes)
//
// PLAYWRIGHT=/path/to/playwright-core and CHROMIUM=/path/to/chrome pick the tools.
// Exits 1 when an app that was snapshotted doesn't come back working.
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
let pw;
for (const name of [process.env.PLAYWRIGHT, 'playwright', '/opt/node-tools/node_modules/playwright', 'playwright-core'].filter(Boolean)) {
  try { pw = require(name); break; } catch { /* next */ }
}
if (!pw) { console.error('playwright not found (set PLAYWRIGHT)'); process.exit(2); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const jsonOut = opt('--json');
const url = args[0]?.includes('://') ? args.shift() : 'http://localhost:5299/';
const apps = args.length ? args : ['xeyes'];
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIMIT = Number(process.env.GUI_LAUNCH_LIMIT_MS || 600_000);
/** Apps whose first windows aren't the usable one: the title of the window that is */
const READY = { gimp: 'GNU Image Manipulation Program' };
/** How each app is used after a restore: 'pointer' moves over it, 'type' types into it */
const USE = { xeyes: 'pointer', xclock: 'none', gpicview: 'none', xterm: 'type', geany: 'geany', l3afpad: 'type', mousepad: 'type', featherpad: 'type', galculator: 'type' };

const boot = async (page, app) => {
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 90_000 });
  await page.waitForFunction((app) => window.__tabcomputer.desktop.apps().some((a) => a.id === app), app, { timeout: 30_000 });
  await page.waitForTimeout(1500);
};

/** Open `app`; ms from the click to its usable window, and to its first drawn frame */
async function open(page, app) {
  const t0 = Date.now();
  await page.evaluate((app) => { window.__guiSnapshots = []; void window.__tabcomputer.desktop.openApp(app); }, app);
  const usable = ([app, title]) => window.__tabcomputer.desktop.windows().find((w) => w.appId === app && w.surface && !w.options.splash && !w.options.override && !w.id.startsWith('launching-') && (!title || w.title.includes(title)));
  await page.waitForFunction(usable, [app, READY[app] ?? ''], { timeout: LIMIT, polling: 20 });
  const windowMs = Date.now() - t0;
  await page.waitForFunction(([app, title]) => {
    const w = window.__tabcomputer.desktop.windows().find((w) => w.appId === app && w.surface && !w.options.splash && !w.options.override && (!title || w.title.includes(title)));
    if (!w) return false;
    const c = w.surface.canvas;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const first = (d[0] << 16) | (d[1] << 8) | d[2] | (d[3] << 24);
    for (let i = 0; i < d.length; i += 4 * 97) if (((d[i] << 16) | (d[i + 1] << 8) | d[i + 2] | (d[i + 3] << 24)) !== first) return true;
    return false;
  }, [app, READY[app] ?? ''], { timeout: LIMIT, polling: 20 });
  return { windowMs, drawnMs: Date.now() - t0 };
}

/** A hash of the app's window pixels, and where it is on the page */
const look = (page, app) => page.evaluate((app) => {
  const w = window.__tabcomputer.desktop.windows().find((w) => w.appId === app && w.surface && !w.options.override);
  if (!w) return null;
  const c = w.surface.canvas;
  const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
  let h = 0;
  for (let i = 0; i < d.length; i += 4) h = (Math.imul(h, 31) + d[i] + (d[i + 1] << 8) + (d[i + 2] << 16)) | 0;
  const r = c.getBoundingClientRect();
  return { hash: h, x: r.x, y: r.y, width: r.width, height: r.height, title: w.title };
}, app);

const snapshotLog = (page) => page.evaluate(() => window.__guiSnapshots ?? []);
const procs = (page, app) => page.evaluate((app) => [...window.__tabcomputer.kernel.procs.values()].filter((p) => (p.comm ?? '').includes(app) || (p.argv?.[0] ?? '').includes(app)).map((p) => ({ pid: p.pid, state: p.state })), app);

/** Use the app; true when its window changed because of it */
async function use(page, app) {
  const kind = USE[app] ?? 'type';
  const a = await look(page, app);
  if (!a) return { ok: false, why: 'no window' };
  if (kind === 'none') return { ok: true, kind };
  if (kind === 'geany') return useGeany(page, a);
  if (kind === 'pointer') {
    // (xeyes asks where the pointer is a few times a second; its window is the two eyes' shape,
    // so the pointer goes inside one eye, then the other)
    await page.mouse.move(a.x + a.width * 0.25, a.y + a.height * 0.3);
    await page.waitForTimeout(1200);
    const b = await look(page, app);
    await page.mouse.move(a.x + a.width * 0.75, a.y + a.height * 0.7);
    let c = b;
    for (let i = 0; i < 20 && c.hash === b.hash; i++) { await page.waitForTimeout(200); c = await look(page, app); }
    return { ok: b.hash !== c.hash, kind };
  }
  await page.mouse.click(a.x + a.width / 2, a.y + a.height * 0.6);
  await page.waitForTimeout(300);
  const before = await look(page, app);
  await page.keyboard.type('snapshot 12345', { delay: 30 });
  let after = before;
  for (let i = 0; i < 40 && after.hash === before.hash; i++) { await page.waitForTimeout(250); after = await look(page, app); }
  return { ok: after.hash !== before.hash, kind, title: after.title };
}

/**
 * Geany after a restore, as someone would use it: open a file through its file dialog (new
 * windows, the file system), type into it, save it, and quit from the keyboard.
 */
async function useGeany(page, a) {
  const title = () => page.evaluate(() => window.__tabcomputer.desktop.windows().filter((w) => w.appId === 'geany' && w.surface).map((w) => w.title));
  const until = async (what, test, ms = 30_000) => {
    for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await test()) return true; await page.waitForTimeout(150); }
    throw new Error(`geany: ${what} (windows: ${JSON.stringify(await title())})`);
  };
  await page.evaluate(() => window.__tabcomputer.fs.writeFile('/home/user/snap-test.txt', 'first line\n'));
  await page.mouse.click(a.x + a.width / 2, a.y + a.height * 0.5);
  await page.waitForTimeout(300);
  await page.keyboard.press('Control+o');
  await until('no Open File dialog', async () => (await title()).some((t) => /Open File/.test(t)));
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+l');
  await page.waitForTimeout(300);
  await page.keyboard.type('/home/user/snap-test.txt', { delay: 20 });
  await page.keyboard.press('Enter');
  await until('the file did not open', async () => (await title()).some((t) => /snap-test\.txt/.test(t)));
  await page.waitForTimeout(300);
  await page.keyboard.type('typed after the restore ', { delay: 20 });
  await until('typing did not mark the file changed', async () => (await title()).some((t) => /^\*snap-test\.txt/.test(t)));
  await page.keyboard.press('Control+s');
  const saved = () => page.evaluate(() => window.__tabcomputer.fs.readFile('/home/user/snap-test.txt', 'utf8').catch(() => ''));
  await until('the file was not saved', async () => /typed after the restore first line/.test(await saved()));
  const pid = await page.evaluate(() => window.__guiLast.pid);
  await page.keyboard.press('Control+q');
  await until('Ctrl+Q did not end it', () => page.evaluate((pid) => !window.__tabcomputer.kernel.procs.has(pid), pid));
  const status = await page.evaluate(() => window.__guiLast.exited);
  if (status !== 0) throw new Error(`geany: exit status ${status} after Ctrl+Q`);
  return { ok: true, kind: 'geany: opened a file, typed, saved, Ctrl+Q', quit: true };
}

/** Close the app's windows by the title bar; an editor with typed text asks first: answer "close without saving" */
async function quit(page, app) {
  const t0 = Date.now();
  await page.evaluate((app) => { for (const w of window.__tabcomputer.desktop.windows()) if (w.appId === app && !w.options.transientFor) w.close(); }, app);
  for (let i = 0; i < 100; i++) {
    const left = await procs(page, app);
    if (!left.length) return { ok: true, ms: Date.now() - t0 };
    // a "save changes?" dialog: its first button is the one that discards (GTK), else Escape won't do: kill
    if (i === 20) await page.evaluate((app) => { const k = window.__tabcomputer.kernel; for (const p of k.procs.values()) if ((p.comm ?? '').includes(app)) k.kill(p.pid, 15); }, app);
    if (i === 60) await page.evaluate((app) => { const k = window.__tabcomputer.kernel; for (const p of k.procs.values()) if ((p.comm ?? '').includes(app)) k.kill(p.pid, 9); }, app);
    await page.waitForTimeout(100);
  }
  return { ok: false, left: await procs(page, app) };
}

const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = {};
let failed = 0;
for (const app of apps) {
  const r = results[app] = {};
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem('tabcomputer-gui-snapshots', '1'));
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  try {
    await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
    await boot(page, app);
    r.first = await open(page, app);
    // its snapshot is kept once it is quiet
    const whenTaken = () => page.waitForFunction(() => (window.__guiSnapshots ?? []).find((e) => e.taken !== undefined), null, { timeout: 120_000, polling: 100 }).then((h) => h.jsonValue());
    let taken = await whenTaken();
    r.taken = taken;
    if (!taken.taken) { console.log(`skip ${app}: no snapshot (${taken.why}); first launch ${r.first.windowMs} ms`); await context.close(); continue; }
    await page.waitForTimeout(300);
    r.quitFirst = await quit(page, app);
    // An app that writes its settings when it first quits has changed what its snapshot was made
    // from: that launch starts the usual way and keeps a new one. Two such rounds at most.
    r.retaken = [];
    for (let round = 0; ; round++) {
      await page.reload();
      await boot(page, app);
      r.restored = await open(page, app);
      r.restoreLog = (await snapshotLog(page)).find((e) => e.restored !== undefined) ?? null;
      if (r.restoreLog?.restored) break;
      if (round === 2 || !/ changed$/.test(r.restoreLog?.why ?? '')) throw new Error(`not restored after the reload: ${r.restoreLog?.why ?? 'no snapshot was tried'}`);
      r.retaken.push(r.restoreLog.why);
      taken = await whenTaken();
      if (!taken.taken) throw new Error(`no second snapshot: ${taken.why}`);
      await page.waitForTimeout(300);
      await quit(page, app);
    }
    await page.waitForTimeout(1500);
    if (!(await procs(page, app)).some((p) => p.state === 'running')) throw new Error('the restored process is gone');
    r.use = await use(page, app);
    if (!r.use.ok) throw new Error(`the restored app did not react (${r.use.kind})`);
    r.quit = r.use.quit ? { ok: true, ms: 0 } : await quit(page, app);
    if (!r.quit.ok) throw new Error(`the restored app did not quit: ${JSON.stringify(r.quit.left)}`);
    if ((await procs(page, app)).length) throw new Error(`a process was left after it quit: ${JSON.stringify(await procs(page, app))}`);
    await page.waitForTimeout(500);
    // Again in the same page. An app that saved new settings as it quit (what was typed changed
    // them) has outdated its snapshot: then this launch starts the usual way, which is right.
    r.again = await open(page, app);
    r.againLog = (await snapshotLog(page)).find((e) => e.restored !== undefined) ?? null;
    if (!r.againLog?.restored && !/ changed$/.test(r.againLog?.why ?? '')) throw new Error(`not restored the second time: ${r.againLog?.why ?? 'no snapshot was tried'}`);
    await page.waitForTimeout(500);
    if (r.againLog.restored && USE[app] !== 'geany') {
      r.useAgain = await use(page, app);
      if (!r.useAgain.ok) throw new Error(`the app restored a second time did not react (${r.useAgain.kind})`);
    }
    await quit(page, app);
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    const mb = (b) => (b / 1e6).toFixed(1);
    console.log(`ok   ${app.padEnd(11)} first launch ${r.first.windowMs} ms; snapshot ${mb(taken.bytes.image)} MB (${mb(taken.bytes.stored)} MB stored, ${mb(taken.bytes.x)} MB of X requests) in ${taken.ms} ms; restored: window ${r.restored.windowMs} ms, drawn ${r.restored.drawnMs} ms (X ${r.restoreLog.x} ms, image ${r.restoreLog.image} ms); again ${r.again.windowMs} ms${r.againLog.restored ? '' : ' (not restored: ' + r.againLog.why + ')'}; used: ${r.use.kind}; quit ${r.quit.ms} ms${r.retaken.length ? `; retaken ${r.retaken.length}x (${r.retaken.join('; ')})` : ''}`);
  } catch (e) {
    failed++;
    r.error = String(e.message);
    r.log = await snapshotLog(page).catch(() => []);
    console.log(`FAIL ${app}  ${String(e.message).split('\n')[0]}  ${JSON.stringify(r.log).slice(0, 400)}${errors.length ? '  page errors: ' + errors.join('; ').slice(0, 300) : ''}`);
  }
  await context.close();
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
}
await browser.close();
process.exit(failed ? 1 : 0);
