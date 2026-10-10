// Vite's React template end to end in Chromium, from a fresh profile, typing
// into the real terminal: npm create vite, npm i, npm run dev, the preview
// renders the app, an edit to src/App.jsx reaches it by HMR (no reload).
// APP=astro|next|sveltekit: a minimal site of that framework instead, the same checks
// (APPS below says how each is made, edited and built).
// REDIRECT=1: the dev server runs as agents start one, `npm run dev > dev.log 2>&1 &`
// (ready when its log says so), and the build is typed with its output to a file.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/vite-react.mjs [URL] [--shots DIR]
//
// Prints each step's time and the page's JS heap after each; exits 1 on a
// failure. External requests go through $HTTPS_PROXY when it is set.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium';
const LIMIT = Number(process.env.STEP_LIMIT_MS || 600_000);
// VITE=7 for vite 7's template (esbuild and Rollup as their WebAssembly builds)
const VITE = process.env.VITE || 'latest';
const APP_NAME = process.env.APP || 'vite';
const REDIRECT = process.env.REDIRECT === '1';
if (shots) mkdirSync(shots, { recursive: true });

const bufferOf = (page) => page.evaluate(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
});
const heapMB = (page) => page.evaluate(() => Math.round((performance.memory?.usedJSHeapSize ?? 0) / 1048576));

const times = [];
const record = async (page, name, t0) => {
  const ms = Date.now() - t0;
  times.push([name, ms, await heapMB(page)]);
  console.log(`  ok   ${(ms / 1000).toFixed(1).padStart(6)} s  ${String(times.at(-1)[2]).padStart(5)} MB  ${name}`);
};
/** Wait for `re` in the terminal buffer after `from` (a buffer length) */
async function waitBuffer(page, re, from, what) {
  const t0 = Date.now();
  for (;;) {
    const s = (await bufferOf(page)).slice(from);
    const m = re.exec(s);
    if (m) return m;
    if (Date.now() - t0 > LIMIT) throw new Error(`timed out waiting for ${what}:\n${s.split('\n').slice(-25).join('\n')}`);
    await page.waitForTimeout(250);
  }
}
let marks = 0;
/** Type `cmd` and wait for it to exit 0 */
async function step(page, cmd, strict = true) {
  const mark = `@@step${++marks}`;
  const t0 = Date.now();
  // (at the prompt: keys typed before it came lost their first ones, "command not found: d")
  for (let i = 0; i < 100 && !/\$ ?$/.test((await bufferOf(page)).trimEnd() + ' '); i++) await page.waitForTimeout(100);
  const from = (await bufferOf(page)).length;
  await page.keyboard.type(`${cmd}; echo "${mark} $?"\r`, { delay: 2 });
  const m = await waitBuffer(page, new RegExp(`^${mark} (\\d+)$`, 'm'), from, cmd);
  // (not strict: the exit status, for the caller to judge)
  if (!strict) return Number(m[1]);
  if (m[1] !== '0') throw new Error(`exit ${m[1]}: ${cmd}\n${(await bufferOf(page)).slice(from).split('\n').slice(-25).join('\n')}`);
  await record(page, cmd, t0);
}
/** Run a command in a shell of its own (the terminal's is running vite) */
const side = (page, cmd) => page.evaluate(async (cmd) => {
  const sh = window.__tabcomputer.shell.fork(); sh.terminal = null;
  let out = '';
  const code = await sh.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { code, out };
}, cmd);
/** The preview of port 5173's frame, once it has loaded the app's page */
async function preview(page) {
  for (let i = 0; i < 300; i++) {
    for (const el of await page.$$(`iframe[data-virtual-port="${app.port}"]`)) {
      const f = await el.contentFrame();
      if (f && f.url() !== 'about:blank' && f.url() !== '') return f;
    }
    await page.waitForTimeout(100);
  }
  throw new Error(`no preview of :${app.port}`);
}

/** A heap snapshot of the page (where the memory goes): HEAPSNAP (dev up), HEAPSNAP_AFTER_BUILD */
async function heapSnapshot(page, file) {
  const cdp = await page.context().newCDPSession(page);
  const chunks = [];
  cdp.on('HeapProfiler.addHeapSnapshotChunk', (e) => chunks.push(e.chunk));
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  (await import('node:fs')).writeFileSync(file, chunks.join(''));
}

/** With MEM=1: resident memory of the browser's processes (Linux), by process type */
async function rss(when) {
  if (!process.env.MEM) return;
  const { execSync } = await import('node:child_process');
  const by = {};
  for (const line of execSync('ps -eo rss=,args=').toString().split('\n')) {
    const m = /^\s*(\d+)\s+(\S*chrom\S*)(.*)$/.exec(line);
    if (!m) continue;
    const type = /--type=(\S+)/.exec(m[3])?.[1] ?? 'browser';
    by[type] = (by[type] ?? 0) + Number(m[1]) / 1024;
  }
  const page = globalThis.__page;
  let workers = '';
  if (page) {
    const ws = page.workers();
    workers = `; ${ws.length} workers`;
  }
  console.log(`  RSS, ${when}:`, Object.entries(by).map(([k, v]) => `${k} ${Math.round(v)} MB`).join(', ') + workers);
}

const proxy = process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';

/** Write files into tabcomputer's filesystem (path → text) */
const writeFiles = (page, files) => page.evaluate(async (files) => {
  const fs = window.__tabcomputer.fs;
  for (const [path, text] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true }).catch(() => {});
    await fs.writeFile(path, text);
  }
}, files);
const H = '/home/user/app';
const editH1 = (file) => `sed -i 's|<h1>[^<]*</h1>|<h1>Edited by HMR</h1>|' ${file}`;
const builtH1 = (out) => /<h1>Edited (live|by HMR)<\/h1>/.test(out);

/** The apps: how each is made, when its dev server is up, its edit and its build */
const APPS = {
  vite: {
    label: `vite@${VITE} react template`, port: 5173,
    async setup(page) {
      await step(page, `npm create vite@${VITE} app -- --template react --no-interactive`);
      await step(page, 'cd app && npm i');
    },
    ready: /ready in \d+ ms|Local:\s+http/,
    edit: { cmd: editH1('~/app/src/App.jsx'), shows: /Edited by HMR/, hmr: true, label: 'edit App.jsx → HMR update' },
    build: { cmd: 'cd ~/app && npm run build && ls dist/assets', ok: (out) => /\.css\b/.test(out) && /\.js\b/.test(out), label: 'npm run build (vite build)' },
  },
  // (written here: create-astro fetches its template from codeload.github.com); its page edits reload
  astro: {
    label: 'astro@5 minimal site', port: 4321,
    async setup(page) {
      const t0 = Date.now();
      await writeFiles(page, {
        [`${H}/package.json`]: JSON.stringify({ name: 'app', type: 'module', scripts: { dev: 'astro dev', build: 'astro build' }, dependencies: { astro: '^5' } }),
        [`${H}/astro.config.mjs`]: 'import { defineConfig } from "astro/config";\nexport default defineConfig({});\n',
        [`${H}/src/pages/index.astro`]: '---\nconst title = "Hello Astro";\n---\n<html><body><h1>{title}</h1><p>count is 0</p></body></html>\n',
      });
      await record(page, 'write a minimal Astro site', t0);
      await step(page, 'cd app && npm i');
    },
    ready: /Local\s+http:\/\/localhost:\d+/,
    edit: { cmd: "sed -i 's|Hello Astro|Edited live|' ~/app/src/pages/index.astro", shows: /Edited live/, hmr: false, label: 'edit index.astro → preview updates' },
    build: { cmd: 'cd ~/app && npm run build && cat dist/index.html', ok: builtH1, label: 'npm run build (astro build)' },
  },
  // `next dev --webpack` with node in a Worker, then `next build --webpack`
  next: {
    label: 'next@16 minimal site', port: 3000,
    async setup(page) {
      // (Next's SWC is its wasm build: NEXT_TEST_WASM_DIR, since the relay can't fetch
      // its download; jest-worker's child processes would need fork IPC, so worker threads)
      await step(page, 'export TABCOMPUTER_NODE_WORKER=1 NEXT_TELEMETRY_DISABLED=1 NEXT_TEST_WASM_DIR=$HOME/app/node_modules/@next/swc-wasm-nodejs');
      const t0 = Date.now();
      await writeFiles(page, {
        [`${H}/package.json`]: JSON.stringify({ name: 'app', private: true, scripts: { dev: 'next dev --webpack -p 3000', build: 'next build --webpack' } }),
        [`${H}/next.config.mjs`]: 'export default { experimental: { webpackBuildWorker: false, workerThreads: true, cpus: 1 } };\n',
        [`${H}/app/layout.js`]: 'export const metadata = { title: "app" };\nexport default function RootLayout({ children }) { return <html lang="en"><body>{children}</body></html>; }\n',
        [`${H}/app/page.js`]: '"use client";\nimport { useState } from "react";\nexport default function Page() { const [n, setN] = useState(0); return <main><h1>Hello Next</h1><button onClick={() => setN(n + 1)}>count is {n}</button></main>; }\n',
      });
      await record(page, 'write a minimal Next.js site', t0);
      await step(page, 'cd ~/app && npm i next@16 react@19 react-dom@19 && npm i @next/swc-wasm-nodejs@$(node -p "require(\'next/package.json\').version")');
      // Behind a proxy the relay can't fetch Next's download of its native SWC (which
      // couldn't load anyway): an empty one, so Next goes on to the wasm build. (A failed
      // download rejects inside Next's loadBindings promise executor: it never settles.)
      if (proxy) await side(page, 'mkdir -p ~/app/node_modules/next/next-swc-fallback/@next/swc-linux-x64-gnu ~/app/node_modules/next/next-swc-fallback/@next/swc-linux-x64-musl');
    },
    ready: /Ready in/,
    edit: { cmd: editH1('~/app/app/page.js'), shows: /Edited by HMR/, hmr: true, label: 'edit app/page.js → HMR update' },
    build: { cmd: 'cd ~/app && npm run build && cat .next/server/app/index.html', ok: builtH1, label: 'npm run build (next build)' },
  },
  // SvelteKit 2 + Svelte 5 on Vite 7, prerendered by adapter-static
  sveltekit: {
    label: 'sveltekit@2 minimal site', port: 5173,
    async setup(page) {
      const t0 = Date.now();
      await writeFiles(page, {
        [`${H}/package.json`]: JSON.stringify({ name: 'app', private: true, type: 'module', scripts: { dev: 'vite dev', build: 'vite build' },
          devDependencies: { '@sveltejs/kit': '^2', '@sveltejs/adapter-static': '^3', '@sveltejs/vite-plugin-svelte': '^6', svelte: '^5', vite: '^7' } }),
        [`${H}/svelte.config.js`]: 'import adapter from "@sveltejs/adapter-static";\nexport default { kit: { adapter: adapter() } };\n',
        [`${H}/vite.config.js`]: 'import { sveltekit } from "@sveltejs/kit/vite";\nimport { defineConfig } from "vite";\nexport default defineConfig({ plugins: [sveltekit()] });\n',
        [`${H}/src/app.html`]: '<!doctype html>\n<html lang="en"><head><meta charset="utf-8" />%sveltekit.head%</head><body><div style="display: contents">%sveltekit.body%</div></body></html>\n',
        [`${H}/src/routes/+layout.js`]: 'export const prerender = true;\n',
        [`${H}/src/routes/+page.svelte`]: '<script>\n  let n = $state(0);\n</script>\n\n<h1>Hello Svelte</h1>\n<button onclick={() => n++}>count is {n}</button>\n',
      });
      await record(page, 'write a minimal SvelteKit site', t0);
      await step(page, 'cd app && npm i');
    },
    ready: /ready in \d+ ms|Local:\s+http/,
    edit: { cmd: editH1('~/app/src/routes/+page.svelte'), shows: /Edited by HMR/, hmr: true, label: 'edit +page.svelte → HMR update' },
    build: { cmd: 'cd ~/app && npm run build && cat build/index.html', ok: builtH1, label: 'npm run build (vite build, prerendered)' },
  },
};
const app = APPS[APP_NAME];
if (!app) { console.error(`APP=${APP_NAME}: one of ${Object.keys(APPS).join(', ')}`); process.exit(2); }
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', '--enable-precise-memory-info', ...(proxy ? [`--proxy-server=${proxy}`] : [])] });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 }, ignoreHTTPSErrors: !!proxy });
const page = await context.newPage();
globalThis.__page = page;
// The page's esbuild.wasm (src/commands/build.ts) comes from tabcomputer's own origin:
// a request for it to a CDN fails the run (unpkg.com is refused in the cloud containers)
const cdnRequests = [];
await context.route(/^https:\/\/(unpkg\.com|cdn\.jsdelivr\.net)\/esbuild-wasm/, (r) => { cdnRequests.push(r.request().url()); return r.abort(); });
let previewNavs = 0;
page.on('framenavigated', (f) => { if (/\/__preview\//.test(f.url())) previewNavs++; });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message + (process.env.VERBOSE ? ' @ ' + (e.stack || '').split('\n').slice(1, 6).join(' | ') : '')));
const consoleErrors = [];
const responses = [];
// DUMP_DEPS: the optimized dependencies as the page got them (vite may write them again since)
const depBodies = new Map();
if (process.env.DUMP_DEPS) context.on('response', (r) => { if (/\/\.vite\/deps\//.test(r.url())) r.text().then((t) => depBodies.set(`${depBodies.size}_${r.url()}`, t), () => {}); });
page.on('response', (r) => { if (!/localhost:5299\/(assets|$)/.test(r.url())) responses.push(`${r.status()} ${r.headers()['content-type'] ?? ''} ${r.url().slice(0, 150)}`); });
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
let failed = false;
const T = Date.now();
try {
  let t0 = Date.now();
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.terminal?.term && window.__tabcomputer?.kernel, null, { timeout: 90_000 });
  for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf(page)); i++) await page.waitForTimeout(100);
  await record(page, 'boot to prompt', t0);
  await rss('booted');
  // Everything written to the terminal (vite clears the screen), for a failure report
  await page.evaluate(() => {
    const t = window.__tabcomputer.terminal.term, w = t.write.bind(t);
    window.__termLog = '';
    t.write = (d, cb) => { window.__termLog += typeof d === 'string' ? d : new TextDecoder().decode(d); return w(d, cb); };
  });
  await page.evaluate(() => window.__tabcomputer.terminal.term.focus());

  await app.setup(page);
  await rss('installed');

  t0 = Date.now();
  const from = (await bufferOf(page)).length;
  if (REDIRECT) {
    await page.keyboard.type('npm run dev > /home/user/app/dev.log 2>&1 &\r', { delay: 2 });
    for (let log = ''; !app.ready.test(log); await page.waitForTimeout(250)) {
      if (Date.now() - t0 > LIMIT) throw new Error(`timed out waiting for dev server ready in dev.log:\n${log.slice(-2000)}`);
      log = (await side(page, 'cat ~/app/dev.log')).out;
    }
    await record(page, 'npm run dev > dev.log 2>&1 & → ready (in the log)', t0);
  } else {
    await page.keyboard.type('npm run dev\r', { delay: 2 });
    await waitBuffer(page, app.ready, from, 'dev server ready');
    await record(page, 'npm run dev → ready', t0);
  }
  await rss('dev up');
  if (process.env.HEAPSNAP) await heapSnapshot(page, process.env.HEAPSNAP);

  t0 = Date.now();
  const opened = await side(page, `serve open ${app.port}`);
  if (opened.code !== 0) throw new Error(`serve open ${app.port}: ${opened.out}`);
  let frame = await preview(page);
  await frame.waitForFunction(() => /count is \d/i.test(document.body?.innerText ?? ''), null, { timeout: LIMIT });
  frame = await preview(page);
  await record(page, 'preview renders the app', t0);
  // Vite reloads the page once if it optimized more dependencies on the first load:
  // the edit is made once the preview has gone 3 s without navigating
  for (let quiet = Date.now(), n = previewNavs; Date.now() - quiet < 3000; await page.waitForTimeout(250)) {
    if (previewNavs !== n) { n = previewNavs; quiet = Date.now(); }
  }
  frame = await preview(page);
  await frame.waitForFunction(() => /count is \d/i.test(document.body?.innerText ?? ''), null, { timeout: LIMIT });
  await frame.evaluate(() => { window.__notReloaded = true; });

  // The edit, from a shell of its own (the terminal's is running the dev server)
  t0 = Date.now();
  await side(page, app.edit.cmd);
  if (app.edit.hmr) {
    await frame.waitForFunction((src) => new RegExp(src).test(document.body?.innerText ?? ''), app.edit.shows.source, { timeout: 60_000 });
    if (!await frame.evaluate(() => window.__notReloaded === true)) throw new Error('the preview reloaded instead of hot-updating');
  } else {
    // (a full reload: the frame is a new one)
    for (let i = 0; ; i++) {
      frame = await preview(page);
      if (await frame.evaluate((src) => new RegExp(src).test(document.body?.innerText ?? ''), app.edit.shows.source).catch(() => false)) break;
      if (i > 240) throw new Error('the preview never showed the edit');
      await page.waitForTimeout(250);
    }
  }
  await record(page, app.edit.label, t0);

  t0 = Date.now();
  // (REDIRECT: typed at the terminal, the dev server being in the background, its output to a file)
  const built = REDIRECT
    ? { code: await step(page, `(${app.build.cmd}) > /home/user/app/build.log 2>&1`, false), out: (await side(page, 'cat ~/app/build.log')).out }
    : await side(page, app.build.cmd);
  if (built.code !== 0 || !app.build.ok(built.out)) throw new Error(`npm run build: ${built.out.slice(-1500)}`);
  await record(page, app.build.label + (REDIRECT ? ' > build.log' : ''), t0);
  await rss('after build');
  if (process.env.MEM) {
    await page.waitForTimeout(20_000);
    await rss('20 s after the build');
    // The dev server stopped: what it loaded is let go once nothing uses it
    // (30 s), and the page's esbuild after 60 s without a build
    await page.evaluate(() => window.__tabcomputer.terminal.term.focus());
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(70_000);
    await rss('70 s after stopping the dev server');
    // (what is still referenced: V8 hasn't necessarily collected the rest yet)
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    await page.waitForTimeout(2_000);
    await rss('then after a full GC');
    if (process.env.HEAPSNAP_END) await heapSnapshot(page, process.env.HEAPSNAP_END);
  }
  if (process.env.HEAPSNAP_AFTER_BUILD) await heapSnapshot(page, process.env.HEAPSNAP_AFTER_BUILD);
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  if (cdnRequests.length) throw new Error(`esbuild.wasm requested from a CDN: ${cdnRequests.join(', ')}`);
} catch (e) {
  failed = true;
  console.log(`FAIL ${String(e.message).replace(/\n/g, '\n  ')}`);
  if (process.env.DUMP_DEPS) for (const [u, body] of depBodies) {
    (await import('node:fs')).writeFileSync(`${process.env.DUMP_DEPS}/served_${u.replace(/^.*\//, '').replace(/[^\w.=-]/g, '_')}`, body);
    console.log(`  saved as served: ${u}`);
  }
  if (process.env.DUMP_DEPS) for (const m of new Set(String(e.message).match(/node_modules\/\.vite\/deps\/[\w.-]+\.js/g) ?? [])) {
    const r = await side(page, `ls -la ~/app/${m} ~/app/node_modules/.vite/deps | head -50; cat ~/app/${m}`).catch((x) => ({ out: String(x) }));
    (await import('node:fs')).writeFileSync(`${process.env.DUMP_DEPS}/${m.replace(/\//g, '_')}`, r.out);
    console.log(`  dumped ${m}`);
  }
  for (const f of page.frames()) {
    const text = await f.evaluate(() => document.body?.innerText.slice(0, 200) ?? '').catch((err) => `(${err.message})`);
    console.log(`  frame ${f.url()}: ${JSON.stringify(text)}`);
  }
  for (const m of consoleErrors.slice(-15)) console.log(`  console: ${m}`);
  if (process.env.VERBOSE) {
    const log = await page.evaluate(() => window.__termLog ?? '').catch(() => '');
    console.log('  terminal (last 3000 chars):\n' + log.slice(-3000).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    for (const r of responses.slice(-40)) console.log(`  response: ${r}`);
    for (const f of page.frames()) if (f.url() === 'about:srcdoc') console.log((await f.content().catch(() => '')).slice(0, 2000));
  }
}
if (shots) await page.screenshot({ path: `${shots}/vite-react.png` }).catch(() => {});
console.log(`${failed ? 'FAIL' : 'ok  '} ${app.label}  ${((Date.now() - T) / 1000).toFixed(0)} s`);
await browser.close();
process.exit(failed ? 1 : 0);
