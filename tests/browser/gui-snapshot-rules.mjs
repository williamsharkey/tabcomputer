// What a snapshot of a started GUI app must respect, and its retake in the
// background (docs/research/GUI_SNAPSHOTS.md; src/gui/snapshot.ts, retake.ts).
// From a fresh browser profile, with the setting on (localStorage
// tabcomputer-gui-snapshots = 1; it is off unless set).
//
// rules (xeyes): a snapshot is restored when nothing changed, and never
//   across another engine, a changed binary, a changed library, a changed
//   setting in the home directory that the app reads at its start, another
//   display size (the usual start then lays its window out for the new one),
//   or by an app that read a sign-in; a restored process that ends at once is
//   followed by a usual start; the setting; what `doctor` reports.
// packed (l3afpad): an app that goes on sending X requests while its snapshot is
//   packed (L3afpad's caret blinks; the packing is made 1.5 s slower, as on a
//   loaded machine) is restored and keeps running: the requests kept are the
//   image's own (#142: those sent meanwhile were kept too, and the restored
//   process aborted in Xlib at its first event).
// retake (geany by default): after a quit that outdated the snapshot, the app
//   is started again where nobody sees it (no window, no mark in the dock)
//   once the tab is quiet, its snapshot is kept, and the next launch is a
//   restore that is fully live: a file opened through its dialog, typing, a
//   save, a second file, Ctrl+Q, and a relaunch that comes back with both. A
//   document that changed since is never shown stale. An app the person
//   starts ends a hidden start at once. It prints the retake's time and the
//   memory it took (the browser's renderer processes, from `ps`).
//
//   npx vite build && PORT=5391 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/gui-snapshot-rules.mjs [URL] [--only rules|packed|retake] [--retake APP,...] [--json FILE]
//
// PLAYWRIGHT=/path/to/playwright-core and CHROMIUM=/path/to/chrome pick the tools. Exits 1 on a failure.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const only = opt('--only');
const jsonOut = opt('--json');
const retakeApps = (opt('--retake') ?? 'geany').split(',').filter(Boolean);
const url = args[0]?.includes('://') ? args.shift() : 'http://localhost:5299/';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const LIMIT = Number(process.env.GUI_LAUNCH_LIMIT_MS || 600_000);
const READY = { gimp: 'GNU Image Manipulation Program' };

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const results = { rules: {}, packed: {}, retake: {} };
let failed = 0;

/** The setting on, in every document of the context (until a test says otherwise) */
const settingOn = (page) => page.addInitScript(() => { if (!sessionStorage.getItem('gs-leave-setting')) localStorage.setItem('tabcomputer-gui-snapshots', '1'); });
const boot = async (page, app) => {
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 120_000 });
  await page.waitForFunction((app) => window.__tabcomputer.desktop.apps().some((a) => a.id === app), app, { timeout: 30_000 });
  await page.waitForTimeout(1500);
};
const usableWindow = ([app, title]) => window.__tabcomputer.desktop.windows().find((w) => w.appId === app && w.surface && !w.options.splash && !w.options.override && !w.id.startsWith('launching-') && (!title || w.title.includes(title)));
/** Open `app` as a dock click does; ms to its usable window, and what the snapshot code said of this start */
async function open(page, app) {
  const t0 = Date.now();
  await page.evaluate((app) => { window.__guiSnapshots = []; void window.__tabcomputer.desktop.openApp(app); }, app);
  await page.waitForFunction(usableWindow, [app, READY[app] ?? ''], { timeout: LIMIT, polling: 20 });
  const ms = Date.now() - t0;
  await page.waitForTimeout(300);
  const log = await page.evaluate((app) => (window.__guiSnapshots ?? []).filter((e) => e.app === app), app);
  return { ms, restore: log.find((e) => e.restored !== undefined) ?? null };
}
const taken = (page, app, ms = 180_000) => page.waitForFunction((app) => (window.__guiSnapshots ?? []).find((e) => e.app === app && e.taken !== undefined), app, { timeout: ms, polling: 100 }).then((h) => h.jsonValue());
const procs = (page, app) => page.evaluate((app) => [...window.__tabcomputer.kernel.procs.values()].filter((p) => (p.comm ?? '').includes(app) || (p.argv?.[0] ?? '').includes(app)).map((p) => ({ pid: p.pid, state: p.state })), app);
/** Close the app's windows by the title bar and wait until no process of it is left */
async function quit(page, app) {
  await page.evaluate((app) => { for (const w of window.__tabcomputer.desktop.windows()) if (w.appId === app && !w.options.transientFor) w.close(); }, app);
  for (let i = 0; i < 150; i++) {
    if (!(await procs(page, app)).length) return;
    if (i === 40) await page.evaluate((app) => { const k = window.__tabcomputer.kernel; for (const p of k.procs.values()) if ((p.comm ?? '').includes(app)) k.kill(p.pid, 15); }, app);
    if (i === 90) await page.evaluate((app) => { const k = window.__tabcomputer.kernel; for (const p of k.procs.values()) if ((p.comm ?? '').includes(app)) k.kill(p.pid, 9); }, app);
    await page.waitForTimeout(100);
  }
  throw new Error(`${app} did not quit: ${JSON.stringify(await procs(page, app))}`);
}
const entry = (page, app) => page.evaluate(async (app) => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('tabcomputer-gui-snapshots'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  try {
    if (!db.objectStoreNames.contains('index')) return null;
    return await new Promise((res) => { const r = db.transaction('index').objectStore('index').get(app); r.onsuccess = () => res(r.result ?? null); r.onerror = () => res(null); });
  } finally { db.close(); }
}, app);
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const s = window.__gsShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return { code, out: out.replace(/\r\n/g, '\n') };
}, cmd);
/** Write a file with the bytes it has (a package upgrade that changed nothing else: a new time) */
const touch = (page, path) => page.evaluate(async (path) => { const fs = window.__tabcomputer.fs; const b = await fs.readFile(path); const st = await fs.stat(path); await fs.writeFile(path, b, { mode: st.mode & 0o7777, times: { mtime: Date.now() } }); }, path);

async function check(group, name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results[group][name] = { ok: true, note };
    console.log(`ok    ${name}  ${((Date.now() - t0) / 1000).toFixed(1)} s${note ? `  (${note})` : ''}`);
    return true;
  } catch (e) {
    failed++;
    results[group][name] = { ok: false, error: String(e?.message ?? e) };
    console.log(`FAIL  ${name}  ${((Date.now() - t0) / 1000).toFixed(1)} s\n      ${String(e?.message ?? e).split('\n').slice(0, 6).join('\n      ')}`);
    return false;
  }
}

// ── the rules ──
if (!only || only === 'rules') {
  const app = 'xeyes';
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await settingOn(page);
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await boot(page, app);
  /** A reload, then a launch that must not be a restore, for `why`; its new snapshot is kept, and it is quit */
  const refused = async (why, { expectTaken = true } = {}) => {
    const o = await open(page, app);
    if (o.restore?.restored) throw new Error(`it was restored (${JSON.stringify(o.restore)})`);
    if (!o.restore || !why.test(o.restore.why ?? '')) throw new Error(`not restored, but for another reason: ${JSON.stringify(o.restore)}`);
    const t = await taken(page, app);
    if (expectTaken && !t.taken) throw new Error(`no new snapshot after it: ${t.why}`);
    await quit(page, app);
    return { why: o.restore.why, ms: o.ms, taken: t };
  };
  const again = async () => { await page.reload(); await boot(page, app); };

  const first = await check('rules', 'with the setting on: the first start is a usual one and keeps a snapshot; after a reload it is restored', async () => {
    const cold = await open(page, app);
    if (cold.restore) throw new Error(`a first start said ${JSON.stringify(cold.restore)}`);
    const t = await taken(page, app);
    if (!t.taken) throw new Error(`no snapshot: ${t.why}`);
    await quit(page, app);
    await again();
    const o = await open(page, app);
    if (!o.restore?.restored) throw new Error(`not restored: ${JSON.stringify(o.restore)}`);
    await quit(page, app);
    const e = await entry(page, app);
    if (!e.meta.opened.some(([p]) => p === '/usr/bin/xeyes')) throw new Error('its binary is not among the files the snapshot is checked against');
    return `usual start ${cold.ms} ms, restored ${o.ms} ms; ${(t.bytes.stored / 1e6).toFixed(1)} MB stored; checked against ${e.meta.opened.length} paths`;
  });

  if (first) {
    await check('rules', 'never across an engine change', async () => {
      await again();
      await page.evaluate(() => { window.__guiSnapshotEngine = 'engines/blink/v-rebuilt/'; });
      const r = await refused(/^the engine changed$/);
      // (the snapshot it took names the stand-in engine: this page's real one refuses that too, and takes its own)
      await again();
      await refused(/^the engine changed$/);
      await again();
      const o = await open(page, app);
      if (!o.restore?.restored) throw new Error(`not restored once the engine was the snapshot's again: ${JSON.stringify(o.restore)}`);
      await quit(page, app);
      return r.why;
    });
    await check('rules', "never with a changed binary of the app", async () => {
      await again();
      await touch(page, '/usr/bin/xeyes');
      return (await refused(/^\/usr\/bin\/xeyes changed$/)).why;
    });
    await check('rules', 'never with a changed library', async () => {
      await again();
      const e = await entry(page, app);
      // (one that is there: the loader also looks for each library where it is not)
      const there = e.meta.opened.filter(([, sig]) => sig !== '' && sig !== 'dir').map(([p]) => p);
      const lib = there.find((p) => /\/libX11\.so[.\d]*$/.test(p)) ?? there.find((p) => /\.so[.\d]*$/.test(p));
      if (!lib) throw new Error('no library among the opened paths');
      const real = await page.evaluate((p) => window.__tabcomputer.fs.realpath(p), lib);
      await touch(page, real);
      const r = await refused(/\.so[.\d]* changed$/);
      return r.why;
    });
    let setting = '';
    await check('rules', 'never with a changed setting in the home directory that the app reads at its start', async () => {
      await again();
      const e = await entry(page, app);
      // a file under home it looked for and did not find (Xt reads the user's X resources)
      const looked = e.meta.opened.filter(([p, sig]) => /^\/home\/user\/\.[^/]+$/.test(p) && sig === '').map(([p]) => p);
      setting = looked.find((p) => /Xdefaults|Xresources/.test(p)) ?? looked[0];
      if (!setting) throw new Error(`xeyes looked for no settings file under home: ${JSON.stringify(e.meta.opened.filter(([p]) => p.startsWith('/home')))}`);
      await page.evaluate((p) => window.__tabcomputer.fs.writeFile(p, 'xeyes*foreground: red\n'), setting);
      const r = await refused(new RegExp(`^${setting.replace(/[.]/g, '\\.')} changed$`));
      // ... and with what that file says changed
      await again();
      await page.evaluate((p) => window.__tabcomputer.fs.writeFile(p, 'xeyes*foreground: blue\n'), setting);
      await refused(new RegExp(`^${setting.replace(/[.]/g, '\\.')} changed$`));
      return r.why;
    });
    await check('rules', 'no snapshot of an app that read a sign-in', async () => {
      if (!setting) throw new Error('needs the settings file of the step before');
      await again();
      await page.evaluate((p) => window.__tabcomputer.fs.writeFile(p, `xeyes*foreground: red\n! token ghp_${'a1B2'.repeat(9)}\n`), setting);
      const o = await open(page, app);
      if (o.restore?.restored) throw new Error('it was restored');
      const t = await taken(page, app);
      if (t.taken || !/^it read a sign-in \(/.test(t.why ?? '')) throw new Error(`a snapshot was taken, or refused for another reason: ${JSON.stringify(t)}`);
      await quit(page, app);
      if (await entry(page, app)) throw new Error('a snapshot is stored');
      // (nothing is started in the background for it either: it is known not to take one)
      const skipped = await page.evaluate(() => JSON.parse(localStorage.getItem('tabcomputer-gui-snapshot-skip') ?? '{}').xeyes?.why ?? '');
      if (!/sign-in/.test(skipped)) throw new Error(`not remembered as an app without a snapshot: ${skipped}`);
      await page.evaluate((p) => window.__tabcomputer.fs.unlink(p), setting);
      await again();
      const o2 = await open(page, app);
      const t2 = await taken(page, app);
      if (!t2.taken) throw new Error(`no snapshot once the sign-in was gone: ${t2.why}`);
      await quit(page, app);
      void o2;
      return t.why;
    });
    await check('rules', 'never on another display size: a usual start, laid out for the new one', async () => {
      await page.setViewportSize({ width: 1100, height: 720 });
      await again();
      const o = await open(page, app);
      if (o.restore?.restored || !/^the screen changed$/.test(o.restore?.why ?? '')) throw new Error(`expected "the screen changed": ${JSON.stringify(o.restore)}`);
      const box = await page.evaluate((app) => { const w = window.__tabcomputer.desktop.windows().find((w) => w.appId === app && w.surface); const r = w.surface.canvas.getBoundingClientRect(); return { x: r.x, y: r.y, right: r.right, bottom: r.bottom }; }, app);
      if (box.x < 0 || box.y < 0 || box.right > 1100 || box.bottom > 720) throw new Error(`its window is not inside the smaller screen: ${JSON.stringify(box)}`);
      await taken(page, app);
      await quit(page, app);
      // the same size again: the snapshot taken at this size is restored
      await again();
      const o2 = await open(page, app);
      if (!o2.restore?.restored) throw new Error(`not restored at the size it was taken at: ${JSON.stringify(o2.restore)}`);
      await quit(page, app);
      await page.setViewportSize({ width: 1440, height: 900 });
      return `${o.restore.why}; window within ${JSON.stringify(box)}`;
    });
    await check('rules', 'after a page load, a snapshot that is outdated is taken again in the background, with no window, and the next launch is a restore', async () => {
      // (the snapshot stored now was made at the smaller screen, and a setting changes as well)
      if (setting) await page.evaluate((p) => window.__tabcomputer.fs.writeFile(p, 'xeyes*foreground: green\n'), setting);
      await again();
      await page.evaluate(() => { window.__guiSnapshots = []; });
      const t0 = Date.now();
      let seen = null, shown = '';
      for (;;) {
        const s = await page.evaluate((app) => ({
          log: (window.__guiSnapshots ?? []).filter((e) => e.app === app),
          windows: window.__tabcomputer.desktop.windows().filter((w) => w.appId === app || w.id === `launching-${app}`).length,
        }), app);
        if (s.windows) shown = `${s.windows} window(s) of it on the desktop`;
        seen = s.log.find((e) => e.retaken !== undefined);
        if (seen) break;
        if (Date.now() - t0 > 90_000) throw new Error(`no retake within 90 s of the page's load: ${JSON.stringify(s.log)}`);
        await page.waitForTimeout(500);
      }
      if (!seen.retaken) throw new Error(`the hidden start kept no snapshot: ${seen.why}`);
      if (shown) throw new Error(shown);
      const waited = Date.now() - t0;
      await page.waitForTimeout(500);
      if ((await procs(page, app)).length) throw new Error('a process of it was left');
      const o = await open(page, app);
      if (!o.restore?.restored || !o.restore.hidden) throw new Error(`the launch after it was not a restore of that snapshot: ${JSON.stringify(o.restore)}`);
      await quit(page, app);
      if (setting) await page.evaluate((p) => window.__tabcomputer.fs.unlink(p), setting);
      return `retaken ${(waited / 1000).toFixed(0)} s after the load, in ${seen.ms} ms; the launch after it: restored in ${o.ms} ms`;
    });
    await check('rules', 'doctor counts the snapshots in its storage line', async () => {
      const r = await sh(page, 'doctor 2>&1 | grep -i "storage"');
      if (!/app snapshots [\d.]+ MB of at most [\d.]+ MB \(xeyes [\d.]+ MB\)/.test(r.out)) throw new Error(`no snapshots in:\n${r.out}`);
      return r.out.trim().split('\n')[0].replace(/^.*?(app snapshots[^)]*\)).*$/, '$1');
    });
    await check('rules', 'a restored process that ends at once: the app is started the usual way, its snapshot is dropped, and none is taken in the background', async () => {
      // (a snapshot that is good now, whatever the steps before left)
      await again();
      const before = await open(page, app);
      if (!before.restore?.restored) { const t = await taken(page, app); if (!t.taken) throw new Error(`no snapshot to start from: ${t.why}`); }
      await quit(page, app);
      await again();
      await page.evaluate(() => { window.__guiSnapshotKillRestored = true; });
      await page.evaluate((app) => { window.__guiSnapshots = []; void window.__tabcomputer.desktop.openApp(app); }, app);
      // the restored one is killed at once (the stand-in for an image that doesn't run); a usual start follows
      await page.waitForFunction((app) => (window.__guiSnapshots ?? []).some((e) => e.app === app && e.restored === false && /ended at once/.test(e.why ?? '')), app, { timeout: 30_000, polling: 50 });
      await page.waitForFunction((app) => {
        const p = window.__tabcomputer.kernel.procs.get(window.__guiLast?.pid);
        return !!p && p.state === 'running' && !!window.__tabcomputer.desktop.windows().find((w) => w.appId === app && w.surface && !w.id.startsWith('launching-'));
      }, app, { timeout: 60_000, polling: 50 });
      const log = await page.evaluate((app) => (window.__guiSnapshots ?? []).filter((e) => e.app === app), app);
      if (!log[0]?.restored || log[0].pid === await page.evaluate(() => window.__guiLast.pid)) throw new Error(`not a restore followed by another process: ${JSON.stringify(log)}`);
      await page.waitForTimeout(3000);
      if ((await procs(page, app)).length !== 1) throw new Error(`not exactly one process of it: ${JSON.stringify(await procs(page, app))}`);
      if (await entry(page, app)) throw new Error('the snapshot that did not run is still stored');
      // what it left is kept past the page: its status in words, for the next report (#142)
      const failure = log.find((e) => e.restored === false);
      if (!/killed by SIGABRT/.test(failure?.how ?? '')) throw new Error(`the failure's status is not said: ${JSON.stringify(failure)}`);
      const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('tabcomputer-gui-snapshot-failures') ?? '[]'));
      if (!kept.some((f) => f.app === app && /SIGABRT/.test(f.how))) throw new Error(`the failure is not kept in the profile: ${JSON.stringify(kept).slice(0, 300)}`);
      await quit(page, app);
      await page.evaluate(() => { window.__guiSnapshotKillRestored = false; });
      // nothing is started in the background for it (it is remembered until the build or a setting changes) ...
      const skipped = await page.evaluate((app) => JSON.parse(localStorage.getItem('tabcomputer-gui-snapshot-skip') ?? '{}')[app]?.why ?? '', app);
      if (!/ended at once/.test(skipped)) throw new Error(`not remembered: ${skipped}`);
      // ... and the next start the person makes is a usual one that keeps a new snapshot
      const o = await open(page, app);
      if (o.restore?.restored) throw new Error('the next launch was a restore');
      const t = await taken(page, app);
      if (!t.taken) throw new Error(`the next usual start kept no snapshot: ${t.why}`);
      await quit(page, app);
      return log.find((e) => e.restored === false).why;
    });
    await check('rules', 'the setting: off unless set (nothing is restored or taken, Settings has no switch); set, Settings shows the switch and Off forgets what was kept', async () => {
      await page.evaluate(() => { sessionStorage.setItem('gs-leave-setting', '1'); localStorage.removeItem('tabcomputer-gui-snapshots'); });
      await again();
      const o = await open(page, app);
      await page.waitForTimeout(4000);
      const log = await page.evaluate(() => window.__guiSnapshots ?? []);
      if (o.restore || log.length) throw new Error(`the snapshot code ran with the setting unset: ${JSON.stringify(log)}`);
      await quit(page, app);
      await page.evaluate(() => { void window.__tabcomputer.desktop.openApp('settings', { pane: 'storage' }); });
      await page.waitForFunction(() => /Persistent/.test(document.body.innerText), null, { timeout: 15_000 });
      await page.waitForTimeout(500);
      if (await page.evaluate(() => !!document.querySelector('[data-snap]'))) throw new Error('Settings shows the switch to someone who never set it');
      await page.evaluate(() => { for (const w of window.__tabcomputer.desktop.windows()) if (w.appId === 'settings') w.close(); });
      // set: a snapshot is kept again, the switch is there and says On
      await page.evaluate(() => localStorage.setItem('tabcomputer-gui-snapshots', '1'));
      await again();
      const on = await open(page, app);
      if (!on.restore?.restored) { const t = await taken(page, app); if (!t.taken) throw new Error(`no snapshot with the setting on: ${t.why}`); }
      await quit(page, app);
      if (!(await entry(page, app))) throw new Error('no snapshot is stored with the setting on');
      await page.evaluate(() => { void window.__tabcomputer.desktop.openApp('settings', { pane: 'storage' }); });
      await page.waitForFunction(() => document.querySelector('[data-snap="1"]')?.classList.contains('sd-active'), null, { timeout: 15_000 });
      // Off from Settings forgets what was kept, and stays off
      await page.evaluate(() => document.querySelector('[data-snap="0"]').click());
      await page.waitForTimeout(1000);
      if (await entry(page, app)) throw new Error('Off left the stored snapshot');
      const stored = await page.evaluate(() => localStorage.getItem('tabcomputer-gui-snapshots'));
      if (stored !== '0') throw new Error(`Off left the setting at ${stored}`);
      await page.evaluate(() => { for (const w of window.__tabcomputer.desktop.windows()) if (w.appId === 'settings') w.close(); });
    });
  }
  if (errors.length) { failed++; console.log(`FAIL  page errors: ${errors.join('; ').slice(0, 400)}`); }
  await context.close();
}

// ── an app that talks while its snapshot is packed ──
if (!only || only === 'packed') {
  const app = 'l3afpad';
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await settingOn(page);
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await boot(page, app);
  await check('packed', 'an app that sends X requests while its snapshot is packed is restored and keeps running', async () => {
    const notes = [];
    // three rounds: the caret blinks about every 0.6 s, so 1.5 s of packing takes in a blink or two
    for (let round = 0; round < 3; round++) {
      await page.evaluate(() => { window.__guiSnapshotPackDelayMs = 1500; });
      const first = await open(page, app);
      if (first.restore?.restored) throw new Error('a start that should keep a snapshot was a restore');
      const t = await taken(page, app);
      if (!t.taken) throw new Error(`no snapshot: ${t.why}`);
      // killed, not closed: a quit would rewrite its settings and outdate the snapshot
      await page.evaluate((app) => { const k = window.__tabcomputer.kernel; for (const p of k.procs.values()) if ((p.comm ?? '').includes(app)) k.kill(p.pid, 9); }, app);
      for (let i = 0; i < 100 && (await procs(page, app)).some((p) => p.state !== 'zombie'); i++) await page.waitForTimeout(100);
      await page.waitForFunction(() => (window.__shiroX?.server.clients.size ?? 0) <= 1, null, { timeout: 30_000, polling: 100 });
      await page.reload();
      await boot(page, app);
      const o = await open(page, app);
      if (!o.restore?.restored) throw new Error(`round ${round + 1}: not restored: ${JSON.stringify(o.restore)}`);
      await page.waitForTimeout(6000);
      const log = await page.evaluate((app) => (window.__guiSnapshots ?? []).filter((e) => e.app === app), app);
      const ended = log.find((e) => e.restored === false);
      if (ended) throw new Error(`round ${round + 1}: ${ended.why} (${ended.how ?? ''}): ${String(ended.output ?? '').slice(-300)}`);
      if (!(await procs(page, app)).some((p) => p.state === 'running')) throw new Error(`round ${round + 1}: the restored process is gone`);
      notes.push(`${o.ms} ms`);
      // and it is snapshotted again from a usual start next round
      await page.evaluate((app) => { const k = window.__tabcomputer.kernel; for (const p of k.procs.values()) if ((p.comm ?? '').includes(app)) k.kill(p.pid, 9); }, app);
      for (let i = 0; i < 100 && (await procs(page, app)).some((p) => p.state !== 'zombie'); i++) await page.waitForTimeout(100);
      await page.evaluate(async (app) => {
        await new Promise((res) => { const r = indexedDB.open('tabcomputer-gui-snapshots'); r.onsuccess = () => { const db = r.result; const t = db.transaction(['snapshots', 'index'], 'readwrite'); t.objectStore('snapshots').delete(app); t.objectStore('index').delete(app); t.oncomplete = () => { db.close(); res(); }; }; r.onerror = () => res(); });
      }, app);
      await page.waitForFunction(() => (window.__shiroX?.server.clients.size ?? 0) <= 1, null, { timeout: 30_000, polling: 100 });
    }
    return `restored and running three times; windows after ${notes.join(', ')}`;
  });
  if (errors.length) { failed++; console.log(`FAIL  page errors: ${errors.join('; ').slice(0, 400)}`); }
  await context.close();
}

// ── the retake ──

/** The renderer processes' resident memory now, MB (the page, its Workers and the engine's memory are there) */
async function rendererMb(cdp) {
  try {
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const pids = processInfo.filter((p) => p.type === 'renderer').map((p) => String(p.id));
    if (!pids.length) return 0;
    const out = execFileSync('ps', ['-o', 'rss=', '-p', pids.join(',')], { encoding: 'utf8' });
    return Math.round(out.trim().split('\n').reduce((a, l) => a + (Number(l.trim()) || 0), 0) / 1024);
  } catch { return 0; }
}

/** Wait for the hidden start of `app` and its end; what is shown of it meanwhile, and what it took */
async function watchRetake(page, cdp, app, { timeout = 300_000 } = {}) {
  const t0 = Date.now();
  const before = await rendererMb(cdp);
  let started = 0, peak = before, shown = null;
  for (;;) {
    const s = await page.evaluate((app) => {
      const T = window.__tabcomputer;
      const log = (window.__guiSnapshots ?? []).filter((e) => e.app === app);
      const tile = document.querySelector(`.sd-dock [data-app="${app}"]`);
      return {
        started: log.find((e) => e.retake === 'started') ?? null,
        ended: log.find((e) => e.retaken !== undefined) ?? null,
        windows: T.desktop.windows().filter((w) => w.appId === app || w.id === `launching-${app}`).map((w) => w.title || w.id),
        dock: !!tile && (tile.classList.contains('sd-running') || tile.classList.contains('sd-starting')),
        launch: T.desktop.launches?.get(app)?.stage ?? null,
        procs: [...T.kernel.procs.values()].filter((p) => (p.comm ?? '').includes(app)).length,
        current: window.__guiRetakes?.current ?? null,
      };
    }, app);
    if (s.started && !started) started = Date.now();
    if (started && !s.ended && (s.windows.length || s.dock || s.launch)) shown = shown ?? JSON.stringify({ windows: s.windows, dock: s.dock, launch: s.launch });
    if (started) peak = Math.max(peak, await rendererMb(cdp));
    if (s.ended) {
      await page.waitForTimeout(1500);
      const left = await procs(page, app);
      return { waitedMs: started - t0, why: s.started?.why, ended: s.ended, shown, left, mb: { before, peak, after: await rendererMb(cdp) } };
    }
    if (Date.now() - t0 > timeout) throw new Error(`no retake of ${app} within ${timeout / 1000} s (started: ${JSON.stringify(s.started)}, queue: ${JSON.stringify(await page.evaluate(() => ({ current: window.__guiRetakes?.current, waiting: window.__guiRetakes?.waiting })))})`);
    await page.waitForTimeout(started ? 250 : 500);
  }
}

if (!only || only === 'retake') {
  for (const app of retakeApps) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const cdp = await browser.newBrowserCDPSession();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await settingOn(page);
    const R = results.retake;
    const title = () => page.evaluate((app) => window.__tabcomputer.desktop.windows().filter((w) => w.appId === app && w.surface).map((w) => w.title), app);
    const until = async (what, test, ms = 40_000) => {
      for (const t0 = Date.now(); Date.now() - t0 < ms;) { if (await test()) return true; await page.waitForTimeout(150); }
      throw new Error(`${app}: ${what} (windows: ${JSON.stringify(await title())})`);
    };
    /** Open a file through the app's own dialog (Ctrl+O, the path typed, Enter) */
    const openFile = async (path) => {
      await page.keyboard.press('Control+o');
      await until('no Open File dialog', async () => (await title()).some((t) => /Open File/.test(t)));
      const name = path.split('/').pop();
      for (let tries = 0; ; tries++) {
        await page.waitForTimeout(1500);
        await page.keyboard.press('Control+l');
        await page.waitForTimeout(800);
        await page.keyboard.press('Control+a');
        await page.keyboard.type(path, { delay: 30 });
        await page.keyboard.press('Enter');
        const opened = async () => (await title()).some((t) => t.includes(name));
        if (await until(`${name} did not open`, opened, 15_000).catch(() => false)) break;
        if (tries === 2 || !(await title()).some((t) => /Open File/.test(t))) { await until(`${name} did not open`, opened); break; }
      }
      await page.waitForTimeout(2000);
    };
    await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
    await boot(page, app);

    let cold = null;
    const ready = await check('retake', `${app}: a quit that outdates the snapshot is followed by a hidden start that keeps a new one`, async () => {
      cold = await open(page, app);
      const t = await taken(page, app);
      if (!t.taken) throw new Error(`no first snapshot: ${t.why}`);
      await page.waitForTimeout(300);
      await quit(page, app);
      // (the first quit writes the app's settings for the first time; an app that writes none is given a changed setting)
      await page.evaluate(() => { window.__guiSnapshots = []; });
      let r;
      try { r = await watchRetake(page, cdp, app, { timeout: 45_000 }); }
      catch {
        // its settings did not change at that quit: change one it read, as a session that changed a preference does
        const home = (await entry(page, app))?.meta.opened.filter(([p, sig]) => /^\/home\/user\/\.config\//.test(p) && sig.startsWith('h')).map(([p]) => p) ?? [];
        if (!home.length) throw new Error(`${app} reads no settings file under ~/.config, and its quit left its snapshot good: nothing to retake`);
        await page.evaluate(async (p) => { const fs = window.__tabcomputer.fs; await fs.writeFile(p, (await fs.readFile(p, 'utf8')) + '\n# changed by the test\n'); }, home[0]);
        // (asked for as a quit asks)
        await page.evaluate((app) => { window.__guiSnapshots = []; window.__guiRetakes.request(app); }, app);
        r = await watchRetake(page, cdp, app);
      }
      if (!r.ended.retaken) throw new Error(`the hidden start kept no snapshot: ${r.ended.why}`);
      if (r.shown) throw new Error(`something of it was shown while it ran: ${r.shown}`);
      if (r.left.length) throw new Error(`a process was left: ${JSON.stringify(r.left)}`);
      const x = await page.evaluate(() => window.__shiroX?.server.clients.size ?? 0);
      if (x > 1) throw new Error(`${x} X clients left`);
      R[`${app} numbers`] = { coldMs: cold.ms, firstSnapshot: t.bytes, takeMs: t.ms, retake: r };
      return `needed because ${r.why}; started ${(r.waitedMs / 1000).toFixed(1)} s after the quit; took ${(r.ended.ms / 1000).toFixed(1)} s (a usual start to the window: ${(cold.ms / 1000).toFixed(1)} s); stored ${(r.ended.bytes.stored / 1e6).toFixed(1)} MB; renderer memory ${r.mb.before} MB before, ${r.mb.peak} MB at its peak, ${r.mb.after} MB after`;
    });

    if (ready) {
      const restoredOk = await check('retake', `${app}: the next launch is restored from the snapshot taken in the background`, async () => {
        const o = await open(page, app);
        if (!o.restore?.restored) throw new Error(`not restored: ${JSON.stringify(o.restore)}`);
        if (!o.restore.hidden) throw new Error('restored, but not from the hidden start\'s snapshot');
        await page.waitForTimeout(1500);
        if (!(await procs(page, app)).some((p) => p.state === 'running')) throw new Error('the restored process is gone');
        R[`${app} numbers`].restoredMs = o.ms;
        return `window after ${o.ms} ms (a usual start: ${cold.ms} ms)`;
      });
      if (restoredOk && app === 'geany') {
        await check('retake', 'geany restored from it is fully live: a file through its dialog, typing, save, a second file, Ctrl+Q', async () => {
          await page.evaluate(() => Promise.all([window.__tabcomputer.fs.writeFile('/home/user/retake-one.txt', 'first line\n'), window.__tabcomputer.fs.writeFile('/home/user/retake-two.txt', 'the second file\n')]));
          const box = await page.evaluate(() => { const w = window.__tabcomputer.desktop.windows().find((w) => w.appId === 'geany' && w.surface); const r = w.surface.canvas.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
          await page.mouse.click(box.x + box.w / 2, box.y + box.h * 0.5);
          await page.waitForTimeout(300);
          await openFile('/home/user/retake-one.txt');
          await page.keyboard.type('typed after the restore ', { delay: 30 });
          await until('typing did not mark the file changed', async () => (await title()).some((t) => /^\*retake-one\.txt/.test(t)));
          await page.keyboard.press('Control+s');
          const saved = () => page.evaluate(() => window.__tabcomputer.fs.readFile('/home/user/retake-one.txt', 'utf8').catch(() => ''));
          await until('the file was not saved', async () => /typed after the restore first line/.test(await saved()), 15_000);
          await page.waitForTimeout(800);
          await openFile('/home/user/retake-two.txt');
          const pid = await page.evaluate(() => window.__guiLast.pid);
          await page.evaluate(() => { window.__guiSnapshots = []; });
          await page.keyboard.press('Control+q');
          await until('Ctrl+Q did not end it', () => page.evaluate((pid) => !window.__tabcomputer.kernel.procs.has(pid), pid));
          const status = await page.evaluate(() => window.__guiLast.exited);
          if (status !== 0) throw new Error(`exit status ${status} after Ctrl+Q`);
        });
        await check('retake', 'geany: that session outdated the snapshot again; retaken, the relaunch is a restore that comes back with both files', async () => {
          const r = await watchRetake(page, cdp, app);
          if (!r.ended.retaken) throw new Error(`no retake: ${r.ended.why}`);
          if (r.shown) throw new Error(`something of it was shown: ${r.shown}`);
          const o = await open(page, app);
          if (!o.restore?.restored) throw new Error(`not restored: ${JSON.stringify(o.restore)}`);
          await until('the session\'s files are not in its window', async () => (await title()).some((t) => /retake-(one|two)\.txt/.test(t)), 20_000);
          // (alive: a key marks the file changed)
          const box = await page.evaluate(() => { const w = window.__tabcomputer.desktop.windows().find((w) => w.appId === 'geany' && w.surface); const r = w.surface.canvas.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
          await page.mouse.click(box.x + box.w * 0.6, box.y + box.h * 0.4);
          await page.waitForTimeout(400);
          await page.keyboard.type('x', { delay: 30 });
          await until('a key typed after the second restore changed nothing', async () => (await title()).some((t) => /^\*retake-/.test(t)));
          await page.keyboard.press('Control+z');
          await page.waitForTimeout(500);
          const titles = JSON.stringify(await title());
          await page.evaluate(() => { window.__guiSnapshots = []; });
          await quit(page, app);
          // (an unsaved change asks first: answered by the kill in quit(); either way it is gone)
          return `retake needed because ${r.why}; ${(r.ended.ms / 1000).toFixed(1)} s; restored in ${o.ms} ms with ${titles}`;
        });
        await check('retake', 'geany: a document that changed since the snapshot is never shown stale', async () => {
          // let the queue settle (that quit may or may not have outdated the snapshot)
          await page.waitForTimeout(2000);
          await page.waitForFunction(() => { const q = window.__guiRetakes; return !q || (!q.current && !q.waiting.length); }, null, { timeout: 300_000, polling: 250 });
          const e = await entry(page, app);
          if (!e) throw new Error('no snapshot is stored');
          const doc = e.meta.opened.find(([p]) => /retake-(one|two)\.txt$/.test(p));
          if (!doc) throw new Error(`the open documents are not among what the snapshot is checked against: ${JSON.stringify(e.meta.opened.filter(([p]) => p.startsWith('/home/user/') && !p.startsWith('/home/user/.')))}`);
          if (!doc[1].startsWith('c')) throw new Error(`the document is not checked by its bytes: ${doc}`);
          // edited elsewhere: two lines swapped, the same size (a setting would count as unchanged; a document does not)
          await page.evaluate((p) => window.__tabcomputer.fs.writeFile(p, 'edited in the terminal\nafter the snapshot was taken\n'), doc[0]);
          const o = await open(page, app);
          if (o.restore?.restored) throw new Error('it was restored with the old contents in memory');
          if (o.restore?.why !== `${doc[0]} changed`) throw new Error(`not restored, but for another reason: ${JSON.stringify(o.restore)}`);
          await page.evaluate(() => { window.__guiSnapshots = []; });
          await quit(page, app);
          return o.restore.why;
        });
      } else if (restoredOk) {
        await check('retake', `${app}: restored from it, it runs on and quits`, async () => { await page.waitForTimeout(2000); await page.evaluate(() => { window.__guiSnapshots = []; }); await quit(page, app); });
      }
      await check('retake', `${app}: an app the person starts ends a hidden start at once, which is tried again afterwards`, async () => {
        // (whatever the steps before left running)
        if ((await procs(page, app)).length) await quit(page, app);
        // a hidden start in flight: ask for one as a quit does, with a setting changed so that it is needed
        await page.waitForTimeout(1500);
        await page.waitForFunction(() => { const q = window.__guiRetakes; return q && !q.current && !q.waiting.length; }, null, { timeout: 300_000, polling: 250 });
        const e = await entry(page, app);
        const home = e?.meta.opened.filter(([p, sig]) => /^\/home\/user\/\.config\//.test(p) && sig.startsWith('h')).map(([p]) => p) ?? [];
        if (e && !home.length) throw new Error('no settings file to change');
        if (e) await page.evaluate(async (p) => { const fs = window.__tabcomputer.fs; await fs.writeFile(p, (await fs.readFile(p, 'utf8')) + '\n# changed again by the test\n'); }, home[0]);
        await page.evaluate((app) => { window.__guiSnapshots = []; window.__guiRetakes.request(app); }, app);
        await page.waitForFunction((app) => window.__guiRetakes.current === app && [...window.__tabcomputer.kernel.procs.values()].some((p) => (p.comm ?? '').includes(app)), app, { timeout: 120_000, polling: 100 });
        await page.waitForTimeout(700);
        const t0 = Date.now();
        await page.evaluate(() => { void window.__tabcomputer.desktop.openApp('xeyes'); });
        await page.waitForFunction((app) => ![...window.__tabcomputer.kernel.procs.values()].some((p) => (p.comm ?? '').includes(app)), app, { timeout: 10_000, polling: 20 });
        const goneMs = Date.now() - t0;
        await page.waitForFunction(usableWindow, ['xeyes', ''], { timeout: LIMIT, polling: 50 });
        const log = await page.evaluate((app) => (window.__guiSnapshots ?? []).filter((e) => e.app === app && e.retaken !== undefined), app);
        if (!log.length || log[0].retaken || !log[0].cancelled) throw new Error(`the hidden start was not ended as cancelled: ${JSON.stringify(log)}`);
        if (await page.evaluate((app) => window.__tabcomputer.desktop.windows().some((w) => w.appId === app), app)) throw new Error(`a window of ${app} is on the desktop`);
        // xeyes quits; the hidden start is asked for again and now finishes
        await page.waitForTimeout(2500);
        await page.evaluate(() => { window.__guiSnapshots = (window.__guiSnapshots ?? []).filter((e) => e.retaken === undefined && e.retake === undefined); });
        await quit(page, 'xeyes');
        const r = await watchRetake(page, cdp, app);
        if (!r.ended.retaken) throw new Error(`not retaken after the person's app quit: ${r.ended.why}`);
        return `its processes were gone ${goneMs} ms after the click; retaken ${(r.waitedMs / 1000).toFixed(0)} s after xeyes quit`;
      });
    }
    if (errors.length) { failed++; console.log(`FAIL  page errors: ${errors.join('; ').slice(0, 400)}`); }
    await context.close();
  }
}

if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
await browser.close();
process.exit(failed ? 1 : 0);
