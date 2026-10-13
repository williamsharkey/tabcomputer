// The app toolkit (docs/APPS.md) in Chromium, against a local server with no Debian:
// the templates need no toolchain, and GitHub is stood in for.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/app-toolkit.mjs [URL] [--shots DIR] [--only NAME]
//
//   loop      app new --page → app dev (a window on its own origin, the page reloads on save) →
//             app install → the dock entry → open → drop a file → the result → download
//   boundary  the app's page cannot read the tab's localStorage or script, cannot fetch the
//             tab's origin, and tab.js refuses what the manifest does not list
//   backend   an app with a node backend: restarted when it dies, restored with its window
//             by a reload, stopped with its last window; app mode and its reload; remove
//   links     the manifest prompt for a gh: app (Cancel focused, a scripted click does
//             nothing, Cancel installs nothing, Install installs); ?app=gh:… and ?app=<id>
//   share     app share ID: the share screen says each person gets their own copy and their
//             own data; the link opened in another profile asks first (Cancel installs nothing,
//             a scripted click does nothing), Install gives that profile its own copy without
//             the sharer's data; "Open in a guest" carries the link there
//   phone     360 px wide: the window, the page and the prompt fit
//
// PLAYWRIGHT=/path/to/playwright-core and CHROMIUM=/path/to/chrome pick the tools.
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumPath } from './_browser.mjs';
const require = createRequire(import.meta.url);
let pw;
for (const name of [process.env.PLAYWRIGHT, 'playwright', '/opt/node-tools/node_modules/playwright', 'playwright-core'].filter(Boolean)) {
  try { pw = require(name); break; } catch { /* next */ }
}
if (!pw) { console.error('playwright not found (set PLAYWRIGHT)'); process.exit(2); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const only = opt('--only');
const url = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => { results.push(!!ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };
const wants = (name) => !only || only === name;

const browser = await pw.chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });

// ── a stand-in for GitHub: one repository holding an app with a backend ──
const COMMIT = 'c0ffee'.padEnd(40, '1');
const GH_MANIFEST = JSON.stringify({
  manifest: 1, id: 'remote-tool', name: 'Remote Tool', description: 'An app from a repository.', version: '1.0.0', entry: 'public',
  backend: { start: 'node server.js', health: '/api/ping' }, access: { fs: ['~/Documents'], network: true, commands: ['zip'] },
}, null, 2);
const PING_SERVER = `const http = require('http');
const started = Date.now();
http.createServer((req, res) => {
  if (req.url === '/api/ping') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, started })); }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('no');
}).listen(Number(process.env.PORT), () => console.log('listening on ' + process.env.PORT));
`;
const PING_PAGE = (title) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head>
<body><h1>${title}</h1><p id="s">starting</p><script src="/__tabcomputer/tab.js"></script><script>
window.__ping = null;
async function ping() {
  try { const r = await fetch('/api/ping'); window.__ping = r.ok ? await r.json() : { ok: false, status: r.status }; }
  catch (e) { window.__ping = { ok: false, error: String(e) }; }
  document.getElementById('s').textContent = JSON.stringify(window.__ping);
  if (window.__ping.ok) document.documentElement.setAttribute('data-ready', '1');
}
ping(); setInterval(ping, 400);
</script></body></html>`;
const GH_FILES = { 'app.json': GH_MANIFEST, 'public/index.html': PING_PAGE('Remote Tool'), 'server.js': PING_SERVER };
const ghCalls = [];
async function stubGitHub(context) {
  const text = (route, body, status = 200) => route.fulfill({ status, contentType: 'text/plain; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body });
  await context.route('https://api.github.com/**', (route) => {
    const u = route.request().url();
    ghCalls.push(u);
    if (u === 'https://api.github.com/repos/someone/tool/commits/HEAD') return text(route, COMMIT);
    if (u === `https://api.github.com/repos/someone/tool/git/trees/${COMMIT}?recursive=1`) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ tree: Object.entries(GH_FILES).map(([path, t]) => ({ path, type: 'blob', mode: '100644', size: t.length })) }) });
    }
    return text(route, 'Not Found', 404);
  });
  await context.route('https://raw.githubusercontent.com/**', (route) => {
    const u = route.request().url();
    ghCalls.push(u);
    const prefix = `https://raw.githubusercontent.com/someone/tool/${COMMIT}/`;
    const body = u.startsWith(prefix) ? GH_FILES[u.slice(prefix.length)] : undefined;
    return body === undefined ? text(route, '404: Not Found', 404) : text(route, body);
  });
}

async function newTab(viewport) {
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  await stubGitHub(context);
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
const put = (page, files) => page.evaluate(async (files) => {
  const fs = window.__tabcomputer.fs;
  for (const [p, text] of Object.entries(files)) { await fs.mkdir(p.replace(/\/[^/]+$/, ''), { recursive: true }); await fs.writeFile(p, text); }
}, files);
const WIN = (id) => `.sd-win .tc-app iframe[data-app="${id}"]`;
/** The app's page: the frame inside the frame of its own origin (or the frame itself where the page is not confined) */
async function inner(page, sel) {
  const outer = await (await page.$(sel))?.contentFrame();
  if (!outer) return null;
  return /\/__tabcomputer\/frame\.html/.test(outer.url()) ? outer.childFrames()[0] ?? null : outer;
}
/**
 * A real click on an element of the app's page, by its place on the screen. (Playwright's own
 * click waits for two animation frames of the app's frame, a frame of another origin, and in
 * headless Chromium that wait sometimes never ends.)
 */
async function clickIn(page, sel, f, target) {
  const frame = await page.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y }; }, sel);
  const el = await f.evaluate((target) => { const e = document.querySelector(target); e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, target);
  await page.mouse.click(frame.x + el.x, frame.y + el.y);
}
const ready = (page, sel, ms = 30_000) => until(page, async () => { const f = await inner(page, sel); return (await f?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1')) ? f : null; }, ms);
const dockHas = (page, id) => page.evaluate((id) => !!document.querySelector(`.sd-dock-item[data-app="${id}"]`), id);
const windowsOf = (page, id) => page.evaluate((id) => window.__tabcomputer.desktop.windows().filter((w) => w.appId === id && !w.id.startsWith('launching-')).map((w) => ({ id: w.id, title: w.title, state: w.state })), id);

async function makePinger(page, dir = '/home/user/pinger', id = 'pinger', name = 'Pinger') {
  await put(page, {
    [`${dir}/app.json`]: JSON.stringify({ manifest: 1, id, name, entry: 'public', window: { width: 420, height: 300 }, backend: { start: 'node server.js', health: '/api/ping' }, access: { fs: [], network: false } }),
    [`${dir}/public/index.html`]: PING_PAGE(name),
    [`${dir}/server.js`]: PING_SERVER,
  });
}
const appList = async (page) => (await side(page, 'app list')).o;
const portOf = async (page, id) => { const m = new RegExp(`^${id} .*? (running|starting|backoff|stopped|failed) :(\\d+)`, 'm').exec(await appList(page)); return m ? { state: m[1], port: +m[2] } : null; };

// ── loop + boundary ──
if (wants('loop') || wants('boundary')) {
  const page = await newTab({ width: 1440, height: 900 });
  await page.goto(url);
  await booted(page);
  await page.evaluate(() => { localStorage.setItem('shiro_github_token', 'CANARY-TOKEN'); });
  await put(page, { '/home/user/.claude/.credentials.json': '{"secret":"CANARY-FILE"}' });

  const made = await side(page, 'cd /home/user && app new shrink --page --name "Shrink"');
  check('app new: a folder from the template', made.code === 0 && /Created shrink in ~\/shrink/.test(made.o), made.o.trim().split('\n')[0]);

  // app dev: runs until its window closes; its output is the log
  await page.evaluate(() => {
    window.__dev = { out: '', done: null };
    const s = window.__tabcomputer.shell.fork(); s.terminal = null;
    s.execute('app dev /home/user/shrink', (x) => { window.__dev.out += x; }, (x) => { window.__dev.out += x; }).then((c) => { window.__dev.done = c; });
  });
  let f = await ready(page, WIN('shrink'));
  check('app dev: the app in a window', !!f);
  const origin = f ? await f.evaluate(() => location.origin) : '';
  check('its page is on an origin of its own', /^http:\/\/app--shrink--[0-9a-f]{16}\.localhost(:\d+)?$/.test(origin) && origin !== new URL(url).origin, origin);
  await put(page, { '/home/user/shrink/public/app.js': (await page.evaluate(async () => await window.__tabcomputer.fs.readFile('/home/user/shrink/public/app.js', 'utf8'))) + '\nwindow.__edited = 1;\n' });
  const reloaded = await until(page, async () => (await inner(page, WIN('shrink')))?.evaluate(() => window.__edited === 1 && document.documentElement.getAttribute('data-ready') === '1'));
  check('app dev: a saved file reloads the page', !!reloaded);
  await page.evaluate(() => window.__tabcomputer.desktop.windows().find((w) => w.appId === 'shrink').close(true));
  // (this shell has no terminal, so the log comes when the command ends; at a terminal it is written as it happens)
  check('app dev: closing the window ends it; its log says what happened', await until(page, () => page.evaluate(() => window.__dev.done === 0 && /app dev: shrink stopped/.test(window.__dev.out)))
    && /changed: public\/app\.js: reloading the page/.test(await page.evaluate(() => window.__dev.out)), JSON.stringify(await page.evaluate(() => window.__dev.done)));

  const inst = await side(page, 'app install /home/user/shrink');
  check('app install: copied to ~/Apps and listed', inst.code === 0 && /Installed Shrink \(shrink\) in ~\/Apps\/shrink/.test(inst.o) && /shrink +Shrink/.test(await appList(page)), inst.o.trim().split('\n')[0]);
  check('the dock has its entry, with its icon', await until(page, () => page.evaluate(() => { const b = document.querySelector('.sd-dock-item[data-app="shrink"]'); return !!b && !!b.querySelector('img[src^="data:image/svg+xml"], svg, .sd-ic'); })));

  await page.click('.sd-dock-item[data-app="shrink"]');
  f = await ready(page, WIN('shrink'));
  const w = (await windowsOf(page, 'shrink'))[0];
  const chrome = await page.evaluate(() => {
    const win = [...document.querySelectorAll('.sd-win')].find((x) => x.querySelector('.tc-app iframe[data-app="shrink"]'));
    return { toolbar: !!win?.querySelector('.sd-toolbar'), icon: !!win?.querySelector('.sd-titlebar img.tc-app-titleicon'), note: !!win?.querySelector('.tc-app-note'), sandbox: win?.querySelector('iframe')?.getAttribute('sandbox') };
  });
  check('the dock opens the app in its own window: its name, its icon, no preview toolbar', !!f && w?.title === 'Shrink' && !chrome.toolbar && chrome.icon && !chrome.note, JSON.stringify({ w, chrome }));
  // (a click on the dock entry of the focused app minimizes it, as for any app; `app open` brings it back)
  await page.click('.sd-dock-item[data-app="shrink"]');
  await until(page, async () => (await windowsOf(page, 'shrink'))[0]?.state === 'minimized', 3000);
  await side(page, 'app open shrink');
  const again = await windowsOf(page, 'shrink');
  check('one window: asking again focuses it', again.length === 1 && again[0].state === 'normal', JSON.stringify(again));

  if (f && wants('boundary')) {
    const b = await f.evaluate(async (tabOrigin) => {
      const tryIt = (fn) => { try { return String(fn()); } catch (e) { return `blocked: ${e.name}`; } };
      const out = {
        tabGlobal: tryIt(() => typeof window.top.__tabcomputer),
        parentGlobal: tryIt(() => typeof window.parent.parent.__tabcomputer),
        tabStorage: tryIt(() => window.top.localStorage.getItem('shiro_github_token')),
        tabDocument: tryIt(() => window.top.document.title),
        ownStorage: tryIt(() => localStorage.getItem('shiro_github_token')),
        ownKeys: tryIt(() => Object.keys(localStorage).join(',')),
        cookie: tryIt(() => document.cookie),
        sandboxed: tryIt(() => { window.top.location = 'https://example.com/'; return 'navigated'; }),
      };
      out.fetchTab = await fetch(tabOrigin + '/apps/index.json').then((r) => `status ${r.status}`, (e) => `blocked: ${e.name}`);
      out.fetchOther = await fetch('https://example.com/').then((r) => `status ${r.status}`, (e) => `blocked: ${e.name}`);
      out.ownServer = await fetch('/apps/config.json').then((r) => `status ${r.status}`, (e) => `blocked: ${e.name}`);
      const refused = async (p) => p.then(() => 'allowed', (e) => e.code);
      out.readSecret = await refused(tab.fs.read('~/.claude/.credentials.json'));
      out.readDotDot = await refused(tab.fs.read('../../../.claude/.credentials.json'));
      out.listHome = await refused(tab.fs.list('~'));
      out.writeApp = await refused(tab.fs.write(tab.app.dir + '/public/app.js', 'x'));
      out.runSh = await refused(tab.run(['sh', '-c', 'cat ~/.claude/.credentials.json']));
      out.runLine = await refused(tab.run('cat ~/.claude/.credentials.json'));
      out.downloadSecret = await refused(tab.download('~/.claude/.credentials.json'));
      out.toolchain = await refused(tab.toolchain.ensure(['c']));
      out.allowed = await refused(tab.fs.write('probe.txt', 'ok').then(() => tab.fs.readText('probe.txt')));
      out.confined = tab.app.confined;
      return out;
    }, new URL(url).origin);
    check('the page cannot reach the tab\'s script, document or localStorage', /^blocked: SecurityError/.test(b.tabGlobal) && /^blocked: SecurityError/.test(b.parentGlobal) && /^blocked: SecurityError/.test(b.tabStorage) && /^blocked: SecurityError/.test(b.tabDocument), JSON.stringify({ tabGlobal: b.tabGlobal, parentGlobal: b.parentGlobal, tabStorage: b.tabStorage, tabDocument: b.tabDocument }));
    check('its own storage holds nothing of the tab\'s', b.ownStorage === 'null' && !/token|claude|shiro/i.test(b.ownKeys) && b.cookie === '', JSON.stringify({ ownStorage: b.ownStorage, ownKeys: b.ownKeys, cookie: b.cookie }));
    check('without network access it cannot fetch the tab\'s origin or another site', /^blocked/.test(b.fetchTab) && /^blocked/.test(b.fetchOther), `${b.fetchTab}; ${b.fetchOther}`);
    check('its own origin serves it nothing of tabcomputer', b.ownServer === 'status 404', b.ownServer);
    await page.waitForTimeout(300);
    check('it cannot move the tab somewhere else', new URL(page.url()).origin === new URL(url).origin, `${b.sandboxed}; ${page.url()}`);
    check('tab.js refuses files outside its folders', b.readSecret === 'EACCES' && b.readDotDot === 'EACCES' && b.listHome === 'EACCES' && b.writeApp === 'EACCES' && b.downloadSecret === 'EACCES' && b.allowed === 'allowed', JSON.stringify(b));
    check('tab.js refuses commands and toolchains the manifest does not list', b.runSh === 'EACCES' && b.runLine === 'EACCES' && b.toolchain === 'EACCES' && b.confined === true, JSON.stringify({ runSh: b.runSh, runLine: b.runLine, toolchain: b.toolchain, confined: b.confined }));
    check('the tab\'s secrets are where they were', await page.evaluate(async () => localStorage.getItem('shiro_github_token') === 'CANARY-TOKEN' && /CANARY-FILE/.test(await window.__tabcomputer.fs.readFile('/home/user/.claude/.credentials.json', 'utf8'))));
  }

  if (f && wants('loop')) {
    // a drop (no folder entries on a synthetic DataTransfer: its files)
    await f.evaluate(() => {
      const dt = new DataTransfer();
      dt.items.add(new File(['hello, tab\n'], 'greeting.txt'));
      dt.items.add(new File([new Uint8Array(70_000).map((_, i) => (i * 7) & 255)], 'big.bin'));
      document.getElementById('drop').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    });
    const rows = await until(page, () => f.evaluate(() => { const r = window.__app.rows; return r.length === 2 && r.every((x) => x.status === 'done' || x.status === 'failed') ? r.map((x) => `${x.rel}:${x.status}:${x.error}`) : null; }));
    check('a dropped file is taken in and run through the program', rows?.[0] === 'greeting.txt:done:' && rows?.[1] === 'big.bin:done:', JSON.stringify(rows));
    const outDir = await f.evaluate(() => window.__app.out);
    const result = await side(page, `cat '${outDir}/greeting.txt.b64'; ls /home/user/.local/share/apps/shrink/imports/*/`);
    check('the result is in the app\'s data folder, the dropped bytes arrived whole', /^aGVsbG8sIHRhYgo=/.test(result.o) && /big\.bin/.test(result.o)
      && await page.evaluate(async () => { const fs = window.__tabcomputer.fs; const d = '/home/user/.local/share/apps/shrink/imports'; const b = await fs.readFile(`${d}/${(await fs.readdir(d))[0]}/big.bin`); return b.length === 70000 && b.every((v, i) => v === ((i * 7) & 255)); }), result.o.trim().slice(0, 80));
    const chooser = page.waitForEvent('filechooser', { timeout: 10_000 }).catch(() => null);
    await clickIn(page, WIN('shrink'), f, '#pick');
    const fc = await chooser;
    if (fc) await fc.setFiles([{ name: 'picked.txt', mimeType: 'text/plain', buffer: Buffer.from('picked') }]);
    check('a picked file too', !!fc && !!await until(page, () => f.evaluate(() => window.__app.rows.find((r) => r.rel === 'picked.txt')?.status === 'done')), `chooser ${!!fc}; ${await f.evaluate(() => JSON.stringify(window.__app.rows.map((r) => [r.rel, r.status, r.error])))}`);
    const got = page.waitForEvent('download', { timeout: 20_000 }).catch(() => null);
    await clickIn(page, WIN('shrink'), f, '#zip');
    const d = await got;
    const bytes = d ? readFileSync(await d.path()) : Buffer.alloc(0);
    check('Download all: a zip on the real disk', !!d && d.suggestedFilename() === 'results.zip' && bytes.subarray(0, 2).toString() === 'PK' && bytes.includes('greeting.txt.b64') && bytes.includes('big.bin.b64'), d ? `${d.suggestedFilename()} ${bytes.length} bytes` : 'no download');
    if (shots) await page.screenshot({ path: join(shots, 'toolkit-window.png') });
  }
  await page.context().close();
}

// ── backend: supervised, restored, app mode, remove ──
if (wants('backend')) {
  const page = await newTab({ width: 1440, height: 900 });
  await page.goto(url);
  await booted(page);
  await makePinger(page);
  await side(page, 'cd /home/user && app new shrink --page --name Shrink && app install shrink');
  const inst = await side(page, 'app install /home/user/pinger');
  check('an app with a backend installs', inst.code === 0, inst.o.trim().split('\n')[0]);
  const t0 = Date.now();
  const opened = await side(page, 'app open pinger');
  let f = await ready(page, WIN('pinger'));
  check('app open: the backend is started by the app and the page reaches it', opened.code === 0 && !!f && (await f.evaluate(() => window.__ping.ok)), `${Date.now() - t0} ms`);
  let st = await portOf(page, 'pinger');
  check('app list shows it running on its port', st?.state === 'running' && st.port >= 4800, JSON.stringify(st));
  const first = f ? await f.evaluate(() => window.__ping.started) : 0;

  // the backend dies: the window says so, the supervisor starts it again
  await page.evaluate((p) => window.__iframeServer.close(p), st.port);
  const cover = await until(page, () => page.evaluate(() => { const c = document.querySelector('.sd-win .tc-app-cover:not([hidden])'); return c ? c.textContent : null; }), 3000);
  f = await until(page, async () => { const x = await inner(page, WIN('pinger')); return (await x?.evaluate((first) => window.__ping?.ok && window.__ping.started !== first, first)) ? x : null; }, 15_000);
  check('a backend that dies is started again, and the window says so meanwhile', /Restarting Pinger/.test(cover ?? '') && !!f && (await portOf(page, 'pinger'))?.state === 'running' && !await page.evaluate(() => !!document.querySelector('.sd-win .tc-app-cover:not([hidden])')), cover ?? 'no cover seen');

  // a reload: the session brings back both windows, and the backend with its window
  await side(page, 'app open shrink');
  await ready(page, WIN('shrink'));
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const r0 = Date.now();
  await page.reload();
  await booted(page);
  const bootMs = Date.now() - r0;
  f = await ready(page, WIN('pinger'), 60_000);
  const backMs = Date.now() - r0;
  const g = await ready(page, WIN('shrink'), 30_000);
  check('a reload restores the windows, and the backend with its window', !!f && !!g && (await f.evaluate(() => window.__ping.ok)) && (await portOf(page, 'pinger'))?.state === 'running', `desktop ${bootMs} ms, app interactive ${backMs} ms`);
  check('the dock entries are there after the reload', await dockHas(page, 'pinger') && await dockHas(page, 'shrink'));

  // the last window closes: the backend stops
  st = await portOf(page, 'pinger');
  await page.evaluate(() => window.__tabcomputer.desktop.windows().find((w) => w.appId === 'pinger').close());
  check('closing the last window stops the backend', await until(page, () => page.evaluate((p) => !window.__iframeServer.isPortInUse(p), st.port)) && !/pinger .*running/.test(await appList(page)));

  // app mode
  const became = await side(page, 'app open pinger --become');
  const BSEL = '#become-container iframe[data-app="pinger"]';
  f = await ready(page, BSEL);
  check('app open --become: the tab is the app, at /pinger', became.code === 0 && !!f && new URL(page.url()).pathname === '/pinger' && (await page.title()) === 'Pinger' && /^http:\/\/app--pinger--/.test(await f.evaluate(() => location.origin)), became.o.trim());
  const times = [];
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    await page.reload({ waitUntil: 'commit' });
    f = await ready(page, BSEL, 60_000);
    times.push(Date.now() - t);
    if (!f) break;
  }
  check('a reload in app mode brings the app and its backend back', !!f && (await f.evaluate(() => window.__ping.ok)), `${times.join(', ')} ms from the reload to the page talking to its backend`);
  if (shots) await page.screenshot({ path: join(shots, 'toolkit-become.png') });
  await page.goto(new URL('/?unbecome', url).toString());
  await booted(page);
  check('?unbecome leaves app mode, back to the desktop', await page.evaluate(() => !localStorage.getItem('tabcomputer-become') && !document.body.classList.contains('become-active') && !!window.__tabcomputer.desktop) && await dockHas(page, 'pinger'));

  const rm = await side(page, 'app remove pinger');
  check('app remove: gone from the dock, the list and ~/Apps', rm.code === 0 && await until(page, async () => !await dockHas(page, 'pinger')) && !/pinger/.test(await appList(page)) && !await page.evaluate(() => window.__tabcomputer.fs.exists('/home/user/Apps/pinger')), rm.o.trim());
  check('another app is untouched', await dockHas(page, 'shrink') && /shrink/.test(await appList(page)), `dock ${await dockHas(page, 'shrink')}; ${(await appList(page)).trim()}`);
  await page.context().close();
}

// ── links: the manifest prompt, ?app= ──
if (wants('links')) {
  const page = await newTab({ width: 1440, height: 900 });
  await page.goto(url);
  await booted(page);
  ghCalls.length = 0;
  await page.evaluate(() => {
    window.__inst = { out: '', done: null };
    const s = window.__tabcomputer.shell.fork(); s.terminal = null;
    s.execute('app install gh:someone/tool', (x) => { window.__inst.out += x; }, (x) => { window.__inst.out += x; }).then((c) => { window.__inst.done = c; });
  });
  const P = '.tc-app-prompt';
  await page.waitForSelector(P, { timeout: 20_000 }).catch(() => null);
  const shown = await page.evaluate((P) => {
    const el = document.querySelector(P);
    if (!el) return null;
    return {
      title: el.querySelector('h3')?.textContent, text: el.textContent,
      focus: document.activeElement?.getAttribute('data-act'), installDisabled: el.querySelector('[data-act=install]').disabled,
      manifest: el.querySelector('pre').textContent, guest: !!el.querySelector('[data-act=guest]'),
    };
  }, P);
  check('an app from GitHub is shown before anything is installed', shown?.title === 'Install Remote Tool?' && /From github\.com\/someone\/tool at commit c0ffee1111\. Not reviewed by tabcomputer\./.test(shown.text), shown?.title);
  check('the prompt says what it runs and may touch, and shows the manifest', !!shown && /node server\.js/.test(shown.text) && /~\/Documents/.test(shown.text) && /its page may reach other sites/.test(shown.text) && /zip/.test(shown.text) && shown.manifest === GH_MANIFEST && /ordinary programs in this tab/.test(shown.text));
  check('Cancel has the focus and Install is off at first', shown?.focus === 'cancel' && shown.installDisabled === true, JSON.stringify({ focus: shown?.focus, disabled: shown?.installDisabled }));
  check('only the commit and the manifest were fetched so far', ghCalls.length === 2 && ghCalls[0].endsWith('/commits/HEAD') && ghCalls[1].endsWith(`/${COMMIT}/app.json`), ghCalls.join(' '));
  await page.waitForTimeout(900);
  // a click made by script, and Enter on the focused Cancel's neighbour: nothing installs
  await page.evaluate((P) => { document.querySelector(`${P} [data-act=install]`).click(); document.querySelector(`${P} [data-act=install]`).dispatchEvent(new MouseEvent('click', { bubbles: true })); }, P);
  await page.waitForTimeout(300);
  check('a scripted click on Install does nothing', await page.evaluate((P) => !!document.querySelector(P) && window.__inst.done === null, P) && !await page.evaluate(() => window.__tabcomputer.fs.exists('/home/user/Apps/remote-tool')));
  await page.click(`${P} [data-act=cancel]`);
  check('Cancel installs nothing', await until(page, () => page.evaluate(() => window.__inst.done === 1 && /Cancelled: nothing was installed/.test(window.__inst.out)))
    && !await page.evaluate(() => window.__tabcomputer.fs.exists('/home/user/Apps/remote-tool')) && !await dockHas(page, 'remote-tool') && ghCalls.length === 2);

  // the same app by a link
  await page.goto(new URL('/?app=gh:someone/tool&utm_source=mail', url).toString());
  await booted(page);
  await page.waitForSelector(P, { timeout: 20_000 }).catch(() => null);
  check('?app=gh:… asks too, and the address is cleaned', await page.evaluate((P) => document.querySelector(`${P} h3`)?.textContent === 'Install Remote Tool?', P) && !/app=|utm/.test(page.url()), page.url());
  if (shots) await page.screenshot({ path: join(shots, 'toolkit-prompt.png') });
  await page.waitForTimeout(900);
  await page.click(`${P} [data-act=install]`);
  const f = await ready(page, WIN('remote-tool'), 40_000);
  check('Install installs that commit and opens it: its backend runs', !!f && (await f.evaluate(() => window.__ping.ok)) && await dockHas(page, 'remote-tool')
    && /gh:someone\/tool@c0ffee1/.test(await appList(page)) && (await page.evaluate(async () => await window.__tabcomputer.fs.readFile('/home/user/Apps/remote-tool/app.json', 'utf8'))) === GH_MANIFEST, (await appList(page)).split('\n')[1]);
  check('an app with network access may open links; one without may not', (await page.evaluate(() => document.querySelector('iframe[data-app="remote-tool"]').getAttribute('sandbox'))).includes('allow-popups'));
  // again by the link: the same commit is already here, so it only opens
  await page.goto(new URL('/?app=gh:someone/tool', url).toString());
  await booted(page);
  check('the link again opens it without asking (the same commit)', !!await ready(page, WIN('remote-tool'), 40_000) && !await page.$(P));

  // an app the site ships: no prompt. (Its converters are stood in for: the toolchain is marked installed.)
  await put(page, { '/home/user/.local/share/apps/converter/.toolchains': 'rescue\n' });
  await page.goto(new URL('/?app=converter', url).toString());
  await booted(page);
  const c = await ready(page, WIN('converter'), 40_000);
  check('?app=<id>: an app of this site installs and opens without a prompt', !!c && !await page.$(P) && await dockHas(page, 'converter') && /converter +Convert Old Files .* site/.test(await appList(page)) && !/app=/.test(page.url()), (await appList(page)).split('\n').find((l) => /^converter/.test(l)));
  const refusedLink = await (async () => { await page.goto(new URL('/?app=..%2F..%2Fetc', url).toString()); await booted(page); return until(page, () => page.evaluate(() => /app link: no such app/.test(window.__tabcomputer.terminal.term.buffer.active.getLine(window.__tabcomputer.terminal.term.buffer.active.cursorY - 1)?.translateToString() + [...Array(window.__tabcomputer.terminal.term.rows).keys()].map((i) => window.__tabcomputer.terminal.term.buffer.active.getLine(i)?.translateToString() ?? '').join('\n'))), 8000); })();
  check('a bad app link is refused and says why', !!refusedLink && !/app=/.test(page.url()));
  await page.context().close();
}

// ── share: an app as a link ──
if (wants('share')) {
  const page = await newTab({ width: 1440, height: 900 });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => {});
  await page.goto(url);
  await booted(page);
  // (a second file beside app.json: this is the link that carries files. An app that is one app.json
  // gets a link of words instead, which tests/browser/link-is-computer.mjs opens.)
  const made = await side(page, 'cd /home/user && app new sharer --template table --name "Shared Table" && echo "About Shared Table." > sharer/README.txt && app install /home/user/sharer');
  await put(page, { '/home/user/.local/share/apps/sharer/own.csv': 'the,sharer,own,data\n' });
  const said = await side(page, 'app share sharer');
  const PROMISE = ['Each person who opens this link gets their own copy of Shared Table, with their own data.', 'Nobody sees your data, and you do not see theirs.'];
  check('app share prints the link and what it means', made.code === 0 && said.code === 0 && PROMISE.every((l) => said.o.includes(l)) && /\?app=link#app=[A-Za-z0-9_-]+/.test(said.o), (made.o + said.o).trim().split('\n').pop());
  const S = '.tc-app-share';
  await page.waitForSelector(S, { timeout: 10_000 }).catch(() => null);
  const screen = await page.evaluate((S) => {
    const el = document.querySelector(S);
    if (!el) return null;
    return { title: el.querySelector('h3').textContent, promise: el.querySelector('.tc-app-share-promise').textContent, details: el.querySelector('.tc-app-share-details').textContent, link: el.querySelector('textarea').value };
  }, S);
  const link = screen?.link ?? '';
  check('the share screen says each person gets their own copy and their own data, nothing shared', screen?.title === 'Share Shared Table' && screen.promise === PROMISE.join(' ')
    && /No server stores them\./.test(screen.details) && /Each person sees what it does before it is installed\./.test(screen.details), JSON.stringify(screen?.promise));
  check('the link is this site\'s, with the app after the #', link.startsWith(new URL('/?app=link#app=', url).toString()) && said.o.includes(link), `${link.length} characters`);
  await page.bringToFront();
  await page.click(`${S} [data-act=copy]`);
  const copied = await until(page, () => page.evaluate((S) => document.querySelector(`${S} [role=status]`).textContent || null, S), 5000);
  check('Copy link says what happened', copied === 'Copied.' || /did not allow the copy/.test(copied ?? ''), String(copied));
  if (shots) await page.screenshot({ path: join(shots, 'toolkit-share.png') });

  // another person: a profile of their own opens the link
  const other = await newTab({ width: 1440, height: 900 });
  const requests = [];
  other.on('request', (r) => requests.push(r.url()));
  await other.goto(link);
  await booted(other);
  const P = '.tc-app-prompt';
  await other.waitForSelector(P, { timeout: 20_000 }).catch(() => null);
  const shown = await other.evaluate((P) => {
    const el = document.querySelector(P);
    return el ? { title: el.querySelector('h3')?.textContent, text: el.textContent, focus: document.activeElement?.getAttribute('data-act'), installDisabled: el.querySelector('[data-act=install]').disabled, guest: !!el.querySelector('[data-act=guest]') } : null;
  }, P);
  check('the link asks first in a profile that never saw the app', shown?.title === 'Install Shared Table?' && /From this link \(\d+ files?, \d+ KB\)\. Not reviewed by tabcomputer\./.test(shown.text) && shown.focus === 'cancel' && shown.installDisabled === true, shown?.title);
  check('the address is cleaned, and the app\'s files went to no server', !/app=/.test(other.url()) && !new URL(other.url()).hash && !requests.some((u) => u.includes(link.split('#app=')[1].slice(0, 40))), other.url());
  if (shots) await other.screenshot({ path: join(shots, 'toolkit-share-prompt.png') });
  await other.waitForTimeout(900);
  await other.evaluate((P) => { document.querySelector(`${P} [data-act=install]`).click(); }, P);
  await other.waitForTimeout(300);
  check('a scripted click on Install does nothing', !!await other.$(P) && !await other.evaluate(() => window.__tabcomputer.fs.exists('/home/user/Apps/sharer')));
  await other.click(`${P} [data-act=cancel]`);
  await other.waitForTimeout(500);
  check('Cancel installs nothing', !await other.$(P) && !await other.evaluate(() => window.__tabcomputer.fs.exists('/home/user/Apps/sharer')) && !await dockHas(other, 'sharer'));

  if (shown?.guest) {
    await other.goto(link);
    await booted(other);
    await other.waitForSelector(P, { timeout: 20_000 }).catch(() => null);
    await other.waitForTimeout(900);
    const popup = other.context().waitForEvent('page', { timeout: 15_000 }).catch(() => null);
    await other.evaluate((P) => { document.querySelector(`${P} details`).open = true; }, P);
    await other.click(`${P} details [data-act=guest]`);
    const g = await popup;
    const inGuest = g && await g.waitForSelector(P, { timeout: 60_000 }).then(() => g.evaluate((P) => document.querySelector(`${P} h3`)?.textContent, P)).catch(() => null);
    check('"Open in a guest" carries the link to a guest, which asks there', !!g && /^guest--/.test(new URL(g.url()).hostname) && inGuest === 'Install Shared Table?' && !await other.evaluate(() => window.__tabcomputer.fs.exists('/home/user/Apps/sharer')), g ? new URL(g.url()).hostname : 'no tab');
    await g?.close();
  }

  await other.goto(link);
  await booted(other);
  await other.waitForSelector(P, { timeout: 20_000 }).catch(() => null);
  await other.waitForTimeout(900);
  await other.click(`${P} [data-act=install]`);
  const f = await ready(other, WIN('sharer'), 40_000);
  const theirs = await other.evaluate(async () => {
    const fs = window.__tabcomputer.fs;
    return { manifest: await fs.readFile('/home/user/Apps/sharer/app.json', 'utf8').catch(() => ''), own: await fs.exists('/home/user/.local/share/apps/sharer/own.csv') };
  });
  const mine = await page.evaluate(() => window.__tabcomputer.fs.readFile('/home/user/Apps/sharer/app.json', 'utf8'));
  check('Install gives that profile its own copy: the same app, none of the sharer\'s data', !!f && theirs.manifest === mine && theirs.own === false && await dockHas(other, 'sharer') && / link:[0-9a-f]{16}/.test(await appList(other)), (await appList(other)).split('\n')[1]);
  await other.goto(link);
  await booted(other);
  check('the same link again opens the copy it installed', !!await ready(other, WIN('sharer'), 40_000) && !await other.$(P));
  await other.context().close();
  check('the sharer\'s data is where it was', (await side(page, 'cat /home/user/.local/share/apps/sharer/own.csv')).o === 'the,sharer,own,data\n');
  await page.context().close();
}

// ── phone ──
if (wants('phone')) {
  const page = await newTab({ width: 360, height: 740 });
  await page.goto(url);
  await booted(page);
  await side(page, 'cd /home/user && app new shrink --page --name Shrink && app install shrink && app new sheet --template table && app install sheet && app new ask --template form && app install ask');
  await side(page, 'app open shrink');
  let f = await ready(page, WIN('shrink'));
  const m = f ? await f.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth, btn: Math.min(...[...document.querySelectorAll('.btn')].filter((b) => b.offsetParent).map((b) => b.getBoundingClientRect().height)) })) : null;
  const frame = await page.evaluate(() => { const r = document.querySelector('iframe[data-app="shrink"]').getBoundingClientRect(); return { w: Math.round(r.width), x: Math.round(r.x) }; });
  check('360 px: the window fills the screen, the page does not scroll sideways, buttons are finger sized', !!m && frame.w === 360 && frame.x === 0 && m.w === 360 && m.sw <= m.w && m.btn >= 36, JSON.stringify({ m, frame }));
  if (shots) await page.screenshot({ path: join(shots, 'toolkit-phone.png') });
  for (const id of ['sheet', 'ask']) {
    await side(page, `app open ${id}`);
    f = await ready(page, WIN(id));
    const s = f ? await f.evaluate(() => ({ w: innerWidth, sw: document.documentElement.scrollWidth })) : null;
    check(`360 px: the ${id === 'sheet' ? 'table' : 'form'} template runs and fits`, !!s && s.sw <= s.w, JSON.stringify(s));
  }
  // the form runs its command; the table saves its file
  f = await inner(page, WIN('ask'));
  await clickIn(page, WIN('ask'), f, '#run');
  check('the form template runs its command and shows the output', await until(page, () => f.evaluate(() => window.__app.code === 0 && window.__app.output === '1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n')));
  await side(page, 'app open sheet');
  f = await inner(page, WIN('sheet'));
  await clickIn(page, WIN('sheet'), f, '#add');
  check('the table template saves to its CSV file', await until(page, () => f.evaluate(() => window.__app.saves >= 1)) && /^Name,Email,Joined,Member\n,,,\n$/.test((await side(page, 'cat /home/user/.local/share/apps/sheet/people.csv')).o));
  await side(page, "echo 'Ada,ada@example.com,2024-01-02,yes' >> /home/user/.local/share/apps/sheet/people.csv");
  check('the table reloads when something else changes the file', await until(page, () => f.evaluate(() => window.__app.rows.some((r) => r[0] === 'Ada'))));

  await page.evaluate(() => {
    const s = window.__tabcomputer.shell.fork(); s.terminal = null;
    void s.execute('app install gh:someone/tool', () => {}, () => {});
  });
  await page.waitForSelector('.tc-app-prompt', { timeout: 20_000 }).catch(() => null);
  const p = await page.evaluate(() => {
    const el = document.querySelector('.tc-app-prompt');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const btns = [...el.querySelectorAll('.tc-app-prompt-actions button')].map((b) => b.getBoundingClientRect());
    return { left: Math.round(r.left), right: Math.round(r.right), sw: el.scrollWidth, cw: el.clientWidth, buttons: btns.every((b) => b.left >= 0 && b.right <= innerWidth), focus: document.activeElement?.getAttribute('data-act') };
  });
  check('360 px: the install prompt fits, Cancel focused', !!p && p.left >= 0 && p.right <= 360 && p.sw <= p.cw && p.buttons && p.focus === 'cancel', JSON.stringify(p));
  if (shots) await page.screenshot({ path: join(shots, 'toolkit-phone-prompt.png') });
  await page.context().close();
}

await browser.close();
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
