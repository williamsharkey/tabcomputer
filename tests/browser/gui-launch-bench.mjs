// Launch timelines for a corpus of Debian GUI apps (docs/GUI_LAUNCH.md).
//
// Each app gets a fresh browser profile and three launches, opened the way a
// dock click opens it (desktop.openApp):
//   cold    first launch: install, then the first start
//   warm    after quitting it, a second start in the same page
//   reload  after reloading the page, a third start
// and with --engine-profile a fourth under SHIRO_BLINK_PROFILE (the engine's
// own counters: compiled against interpreted time, JIT compiles).
//
// Per launch: the timeline (install, process started, ld.so running, dynamic
// linking done, X connection, first window, usable window, quit → gone) and
// the kernel profiler's counts (syscalls by kind, file bytes read, paths
// opened, shared objects, processes, threads), plus the requests the page made.
//
//   npx vite build && PORT=5391 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/gui-launch-bench.mjs [URL] [--json FILE] [--md FILE] [--passes cold,warm,reload]
//        [--engine-profile DIR] [--env K=V,...] [--set localStorageKey=value,...] [--label TEXT] [APP...]
//
// PLAYWRIGHT=/path/to/playwright-core and CHROMIUM=/path/to/chrome pick the tools.
// Exits 1 when an app fails to show a usable window.
import { createRequire } from 'node:module';
import { writeFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let pw;
for (const name of [process.env.PLAYWRIGHT, 'playwright', '/opt/node-tools/node_modules/playwright', 'playwright-core'].filter(Boolean)) {
  try { pw = require(name); break; } catch { /* next */ }
}
if (!pw) { console.error('playwright not found (set PLAYWRIGHT)'); process.exit(2); }

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const jsonOut = opt('--json');
const mdOut = opt('--md');
const profDir = opt('--engine-profile');
const render = opt('--render'); // print the table of an earlier run's JSON, and stop
const label = opt('--label') ?? '';
const passes = (opt('--passes') ?? 'cold,warm,reload').split(',');
const kv = (s) => Object.fromEntries((s ?? '').split(',').filter(Boolean).map((p) => { const i = p.indexOf('='); return [p.slice(0, i), p.slice(i + 1)]; }));
const extraEnv = kv(opt('--env'));
const storage = kv(opt('--set'));
const url = args[0]?.includes('://') ? args.shift() : 'http://localhost:5299/';
/** The corpus: bare X11, small GTK 3, GTK 2, heavy GTK, Qt 5, FLTK (docs/GUI_LAUNCH.md) */
const CORPUS = ['xeyes', 'xclock', 'xterm', 'dillo', 'l3afpad', 'galculator', 'geany', 'mousepad', 'gpicview', 'featherpad', 'qterminal', 'gimp', 'inkscape'];
const apps = args.length ? args : CORPUS;
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const LIMIT = Number(process.env.GUI_LAUNCH_LIMIT_MS || 600_000);

/** Apps whose first windows aren't the usable one: the title of the window that is */
const READY = { gimp: 'GNU Image Manipulation Program' };

// ── in the page ──

/** Start a launch and sample it every 10 ms until stop() */
function pageStart([app, env, readyTitle]) {
  const T = window.__tabcomputer;
  const kernel = T.kernel;
  const desk = T.desktop;
  window.__guiLaunchEnv = env;
  const prevLast = window.__guiLast;
  const clients = () => window.__shiroX?.server?.clients?.size ?? 0;
  const clients0 = clients();
  const procs0 = new Set(kernel.procs.keys());
  const st = { app, t: {}, stages: [], windows: [], pid: 0, done: false, error: '', pids: [], install: null };
  window.__guiInstall = null;
  // (the session bus the first launch starts is counted in the timeline, not in the app's calls)
  const prof = kernel.startProfile({ paths: true, bucketMs: 0, keys: false, filter: (p) => !/dbus-daemon|Xshiro/.test(`${p.path} ${p.comm ?? ''}`) });
  const t0 = performance.now();
  const at = () => Math.round(performance.now() - t0);
  const mark = (k) => { if (st.t[k] === undefined) st.t[k] = at(); };
  let lastStage = '', drawCheck = 0;
  const seen = new Map();
  const drawn = (w) => {
    const c = w.surface.canvas;
    if (!c.width || !c.height) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    const first = (d[0] << 16) | (d[1] << 8) | d[2] | (d[3] << 24);
    for (let i = 0; i < d.length; i += 4 * 97) if (((d[i] << 16) | (d[i + 1] << 8) | d[i + 2] | (d[i + 3] << 24)) !== first) return true;
    return false;
  };
  const tick = () => {
    const stage = desk.launches?.get(app)?.stage ?? '';
    if (stage && stage !== lastStage) { lastStage = stage; st.stages.push([stage, at()]); }
    const last = window.__guiLast;
    const inst = window.__guiInstall;
    if (inst && inst.app === app && !st.install) { st.install = inst; mark('installed'); }
    if (last && last !== prevLast && !st.pid) { st.pid = last.pid; mark('spawn'); }
    if (st.pid) {
      if (clients() > clients0) mark('xConnect');
      // glibc's LD_DEBUG=statistics: printed when ld.so hands over to the program
      if (st.t.linked === undefined && /total startup time in dynamic loader/.test(last.output())) mark('linked');
    }
    for (const p of kernel.procs.keys()) if (!procs0.has(p) && !st.pids.includes(p)) st.pids.push(p);
    const now = performance.now();
    for (const w of desk.windows()) {
      if (w.appId !== app || !w.surface || w.id.startsWith('launching-')) continue;
      let rec = seen.get(w.id);
      if (!rec) {
        rec = { id: w.id, title: w.title, mapped: at(), drawn: null, splash: !!w.options.splash, override: !!w.options.override, dialog: !!w.options.transientFor, width: w.surface.canvas.width, height: w.surface.canvas.height };
        seen.set(w.id, rec);
        st.windows.push(rec);
        mark('firstWindow');
      }
      rec.title = w.title || rec.title;
      if (rec.drawn === null && now - drawCheck > 50) {
        drawCheck = now;
        try { if (drawn(w)) { rec.drawn = at(); mark('firstDrawn'); } } catch { /* a canvas without a 2d context */ }
      }
      const main = !rec.splash && !rec.override && (readyTitle ? rec.title.includes(readyTitle) : true);
      if (main && rec.drawn !== null && st.t.usable === undefined) { mark('usable'); st.mainWindow = rec.id; }
    }
  };
  const iv = setInterval(tick, 10);
  window.__glb = {
    st,
    stop() {
      clearInterval(iv);
      kernel.stopProfile(prof);
      const rep = prof.report(20000); // every path, not the top 50
      st.output = (window.__guiLast && window.__guiLast !== prevLast ? window.__guiLast.output() : '').slice(-20000);
      return { st, rep };
    },
  };
  void Promise.resolve(desk.openApp(app)).catch((e) => { st.error = String(e?.message ?? e); });
  return true;
}

/** Close the app's windows as the title bar's button does; time until its processes are gone */
async function pageQuit([app, pid, pids, limit]) {
  const T = window.__tabcomputer;
  const kernel = T.kernel;
  const t0 = performance.now();
  for (const w of T.desktop.windows()) if (w.appId === app && !w.options.transientFor) w.close();
  const state = () => pids.map((p) => kernel.procs.get(p)).filter(Boolean).map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm ?? p.argv?.[0] ?? '', state: p.state }));
  const helper = (p) => /dbus-daemon/.test(p.comm) || p.state === 'zombie';
  let windowsGone = null, procGone = null, allGone = null;
  while (performance.now() - t0 < limit) {
    const now = Math.round(performance.now() - t0);
    if (windowsGone === null && !T.desktop.windows().some((w) => w.appId === app)) windowsGone = now;
    const main = kernel.procs.get(pid);
    if (procGone === null && (!main || main.state === 'zombie')) procGone = now;
    if (allGone === null && !state().some((p) => !helper(p))) allGone = now;
    if (windowsGone !== null && allGone !== null) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  const left = state();
  // what a clean quit leaves is a bug to report, not to carry into the next launch
  for (const p of left) if (!helper(p)) { try { kernel.kill(p.pid, 9); } catch { /* gone */ } }
  for (const w of T.desktop.windows()) if (w.appId === app) w.close();
  await new Promise((r) => setTimeout(r, 300));
  return { windowsGone, procGone, allGone, left: left.filter((p) => !/dbus-daemon/.test(p.comm)), zombies: left.filter((p) => p.state === 'zombie').length, running: T.desktop.app?.(app)?.running ?? null, launch: T.desktop.launches?.get(app)?.stage ?? null };
}

// ── reading the results ──

const LD_NOISE = /(^|\/)(ld\.so\.(cache|preload)|[^/]*\.so(\.[0-9.]+)?)$|glibc-hwcaps|\/tls(\/|$)|\/x86_64(\/|$)/;

/** One launch's numbers from the sampler's state and the kernel profile */
function summarize(pass, { st, rep }, net) {
  const t = st.t;
  const stage = (s) => st.stages.find(([n]) => n === s)?.[1];
  const sys = [...rep.syscalls].sort((a, b) => b.calls - a.calls);
  const kinds = rep.byKind ?? {};
  const fileRead = Object.entries(kinds).filter(([k]) => /^(read|pread64):file/.test(k)).reduce((a, [, v]) => a + v.bytes, 0);
  const paths = rep.paths ?? [];
  const opened = paths.filter((p) => p.nrs.some((n) => /^open/.test(n)));
  const libs = opened.filter((p) => /\.so(\.[0-9.]+)?$/.test(p.path) && p.calls > p.errors);
  // (from the app's own start: a cold launch runs the installer's triggers first)
  const from = (t.spawn ?? 0) - 20;
  const first = (re) => { let m; for (const p of paths) if (re.test(p.path)) for (const x of p.times) if (x >= from && (m === undefined || x < m)) m = x; return m; };
  // ld.so's first lookup; and the first path that isn't a library search: the program (or an initializer) is running
  const ldStart = first(/\/ld\.so\.(cache|preload)$/);
  const afterLd = (() => { let m; for (const p of paths) if (!LD_NOISE.test(p.path)) for (const x of p.times) if (ldStart !== undefined && x > ldStart && (m === undefined || x < m)) m = x; return m; })();
  const ld = /total startup time in dynamic loader/.test(st.output ?? '') ? {
    relocations: Number(/number of relocations:\s*(\d+)/.exec(st.output)?.[1] ?? NaN),
    relative: Number(/number of relative relocations:\s*(\d+)/.exec(st.output)?.[1] ?? NaN),
  } : null;
  const install = st.install && { ms: st.install.ms.total, fetchMs: st.install.ms.fetch, unpackMs: st.install.ms.unpack, triggersMs: st.install.ms.triggers, packages: st.install.packages, fetched: st.install.fetched, bytes: st.install.bytes || net.debBytes };
  const threads = rep.threads ?? [];
  const main = threads.find((x) => x.pid === st.pid && x.tid === st.pid) ?? threads.find((x) => x.pid === st.pid);
  return {
    pass, pid: st.pid, error: st.error || undefined,
    install,
    // ms from the click
    t: {
      installed: install ? t.installed : undefined,
      spawn: t.spawn ?? stage('starting'),
      ldStart: ldStart === undefined ? undefined : Math.round(ldStart),
      linked: t.linked ?? (afterLd === undefined ? undefined : Math.round(afterLd)),
      xConnect: t.xConnect, firstWindow: t.firstWindow, firstDrawn: t.firstDrawn, usable: t.usable,
    },
    ld: { libs: libs.length, ...(ld ?? {}) },
    windows: st.windows,
    kernel: {
      calls: rep.totals.calls, cpuMs: Math.round(rep.totals.cpuMs), wallMs: Math.round(rep.totals.wallMs), blockedMs: Math.round(rep.totals.blockedMs),
      top: sys.slice(0, 15).map((s) => ({ name: s.name, calls: s.calls, errors: s.errors, cpuMs: +(s.cpuUs / 1000).toFixed(1), wallMs: +(s.wallUs / 1000).toFixed(1) })),
      fileReadBytes: fileRead,
      byKind: Object.fromEntries(Object.entries(kinds).sort((a, b) => b[1].wallUs - a[1].wallUs).slice(0, 12).map(([k, v]) => [k, { calls: v.calls, bytes: v.bytes, wallMs: +(v.wallUs / 1000).toFixed(1) }])),
      paths: rep.pathCount, opened: opened.length, openErrors: opened.reduce((a, p) => a + p.errors, 0),
      slowPaths: [...paths].sort((a, b) => b.wallUs - a.wallUs).slice(0, 12).map((p) => ({ path: p.path, calls: p.calls, errors: p.errors, ms: +(p.wallUs / 1000).toFixed(1) })),
      busyPaths: [...paths].sort((a, b) => b.calls - a.calls).slice(0, 12).map((p) => ({ path: p.path, calls: p.calls, errors: p.errors })),
    },
    procs: rep.procs.filter((p) => st.pids.includes(p.pid)).map((p) => ({ pid: p.pid, comm: p.comm, calls: p.calls, wallMs: Math.round(p.wallMs) })),
    processes: st.pids.length,
    threads: threads.filter((x) => st.pids.includes(x.pid)).length,
    // the app's main thread: in kernel calls, computing (the engine), asleep
    mainThread: main && { calls: main.calls, inKernelMs: Math.round(main.inKernelMs), outsideMs: Math.round(main.outsideMs), sleepMs: Math.round(main.sleepMs) },
    net,
  };
}

/**
 * SHIRO_BLINK_PROFILE's file for one process (its last report: at exit, or the
 * latest 5-second one): the header's split and the threads' table
 */
function parseEngineProfile(text) {
  const at = text.lastIndexOf('\npid ');
  const last = at < 0 ? text : text.slice(at + 1);
  const h = /^pid (\d+) \(([^)]*)\) wall ([\d.]+) ms: jit ([\d.]+) ms in (\d+) compiles, syscalls ([\d.]+) ms, rest \(running guest code\) (-?[\d.]+) ms/.exec(last);
  if (!h) return null;
  const threads = [];
  const tab = /thread\s+run ms[^\n]*\n((?:\s*\d+(?:\s+[\d.]+)+\n)+)/.exec(last);
  for (const line of (tab?.[1] ?? '').trim().split('\n')) {
    const f = line.trim().split(/\s+/).map(Number);
    if (f.length >= 8) threads.push({ tid: f[0], runMs: f[1], gilWaitMs: f[2], syscallMs: f[3], futexMs: f[4], blocks: f[5], interpreted: f[6], compiledMs: f[7] });
  }
  const why = /interpreted because: (\d+) not at a branch target, (\d+) first visit, (\d+) below the compile threshold/.exec(last);
  const sum = (k) => threads.reduce((a, x) => a + x[k], 0);
  return {
    when: h[2], wallMs: +h[3], jitMs: +h[4], compiles: +h[5], syscallMs: +h[6], guestMs: +h[7],
    threads: threads.length, runMs: sum('runMs'), compiledMs: sum('compiledMs'), gilWaitMs: sum('gilWaitMs'), interpreted: sum('interpreted'),
    compiledInsns: Number(/guest instructions run in compiled code: (\d+)/.exec(last)?.[1] ?? NaN),
    notBranchTarget: why ? +why[1] : undefined, firstVisit: why ? +why[2] : undefined, belowThreshold: why ? +why[3] : undefined,
  };
}

const sec = (ms) => (ms === undefined || ms === null ? '—' : (ms / 1000).toFixed(ms < 9950 ? 1 : 0));
const mbs = (b) => (b / 1e6).toFixed(b < 9.95e6 ? 1 : 0);

function markdown(results) {
  const out = [];
  const head = '| App | Toolkit | Pass | Install | Process | Linked (libs) | X connection | First window | Usable | Quit → gone | Syscalls | File bytes read | Procs / threads |';
  out.push(head, head.replace(/[^|]+/g, (c) => (c.trim() === 'App' || c.trim() === 'Toolkit' || c.trim() === 'Pass' ? '---' : '---:')));
  for (const [app, r] of Object.entries(results.apps)) {
    for (const p of r.passes ?? []) {
      const q = p.quit;
      const gone = !q ? '—' : q.allGone === null ? `not gone (${q.left.filter((x) => x.state !== 'zombie').map((x) => x.comm.split('/').pop()).join(', ')})` : sec(q.allGone) + (q.zombies ? ` (${q.zombies} zombie${q.zombies > 1 ? 's' : ''})` : '');
      out.push(`| ${app} | ${r.toolkit} | ${p.pass} | ${p.install ? `${sec(p.install.ms)} (${mbs(p.install.bytes || p.net.debBytes)} MB)` : '—'} | ${sec(p.t.spawn)} | ${sec(p.t.linked)} (${p.ld.libs}) | ${sec(p.t.xConnect)} | ${sec(p.t.firstWindow)} | **${sec(p.t.usable)}** | ${gone} | ${p.kernel.calls} | ${mbs(p.kernel.fileReadBytes)} MB | ${p.processes} / ${p.threads} |`);
    }
    if (r.error) out.push(`| ${app} | ${r.toolkit} | failed: ${r.error.split('\n')[0].slice(0, 120)} | | | | | | | | | | |`);
  }
  return out.join('\n') + '\n';
}

// ── the run ──

if (render) {
  const md = markdown(JSON.parse(readFileSync(render, "utf8")));
  if (mdOut) writeFileSync(mdOut, md);
  console.log(md);
  process.exit(0);
}

const browser = await pw.chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const manifest = await (await fetch(new URL('gui/apps.json', url))).json();
const results = { url, label, date: new Date().toISOString(), passes, env: extraEnv, storage, apps: {} };
let failed = 0;
for (const app of apps) {
  const r = { toolkit: manifest.apps[app]?.toolkit ?? '?', passes: [] };
  results.apps[app] = r;
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } }); // a fresh profile
  const page = await context.newPage();
  if (Object.keys(storage).length) await page.addInitScript((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); }, storage);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let net = { requests: 0, bytes: 0, debs: 0, debBytes: 0, chunks: 0, chunkBytes: 0 };
  page.on('requestfinished', async (req) => {
    const u = req.url();
    const size = (await req.sizes().catch(() => null))?.responseBodySize ?? 0;
    net.requests++; net.bytes += size;
    if (/\/debian\/pool\//.test(u)) { net.debs++; net.debBytes += size; }
    else if (/\/chunks\/|\/gui\/(overlay|readahead)\//.test(u)) { net.chunks++; net.chunkBytes += size; }
  });
  const boot = async () => {
    await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 90_000 });
    await page.waitForFunction((app) => window.__tabcomputer.desktop.apps().some((a) => a.id === app), app, { timeout: 30_000 });
    await page.waitForTimeout(1500); // boot's background work
  };
  const one = async (pass, env) => {
    net = { requests: 0, bytes: 0, debs: 0, debBytes: 0, chunks: 0, chunkBytes: 0 };
    await page.evaluate(pageStart, [app, { LD_DEBUG: 'statistics', ...extraEnv, ...env }, READY[app] ?? '']);
    await page.waitForFunction(() => window.__glb.st.t.usable !== undefined || window.__glb.st.error
      || (window.__glb.st.pid && !window.__tabcomputer.kernel.procs.has(window.__glb.st.pid) && window.__glb.st.t.firstWindow === undefined), null, { timeout: LIMIT, polling: 100 });
    await page.waitForTimeout(400); // the calls just after the window
    const raw = await page.evaluate(() => window.__glb.stop());
    const s = summarize(pass, raw, { ...net });
    if (s.t.usable === undefined) throw new Error(`${pass}: no usable window (${raw.st.error || 'the process ended'}): ${(raw.st.output ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
    s.quit = await page.evaluate(pageQuit, [app, raw.st.pid, raw.st.pids, 20_000]);
    r.passes.push(s);
    const q = s.quit;
    console.log(`ok   ${app.padEnd(11)} ${pass.padEnd(6)} usable ${sec(s.t.usable)} s  (install ${s.install ? sec(s.install.ms) : '—'}, process ${sec(s.t.spawn)}, ld.so ${sec(s.t.ldStart)}, linked ${sec(s.t.linked)} [${s.ld.libs} libs], X ${sec(s.t.xConnect)}, window ${sec(s.t.firstWindow)})  ${s.kernel.calls} calls, ${mbs(s.kernel.fileReadBytes)} MB read, ${s.processes} procs/${s.threads} threads; quit ${q.allGone === null ? 'NOT GONE: ' + JSON.stringify(q.left) : sec(q.allGone) + ' s' + (q.zombies ? `, ${q.zombies} zombie(s)` : '')}`);
    return s;
  };
  try {
    await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
    await boot();
    if (passes.includes('cold')) await one('cold', {});
    if (passes.includes('warm')) { await page.waitForTimeout(500); await one('warm', {}); }
    if (passes.includes('reload')) { await page.reload(); await boot(); await one('reload', {}); }
    if (profDir) {
      const dir = join(profDir, app);
      mkdirSync(dir, { recursive: true });
      await page.evaluate(async () => { const fs = window.__tabcomputer.fs; await fs.rm('/tmp/glb-prof', { recursive: true }).catch(() => {}); await fs.mkdir('/tmp/glb-prof', { recursive: true }); });
      const s = await one('profile', { SHIRO_BLINK_PROFILE: '/tmp/glb-prof/%p.txt', SHIRO_BLINK_PROFILE_REGIONS: '100000', SHIRO_BLINK_PROFILE_TOP: '5000', LD_DEBUG: 'files,statistics', LD_DEBUG_OUTPUT: '/tmp/glb-prof/ld' });
      await page.waitForTimeout(1500); // the profile is written as the process ends
      const files = await page.evaluate(async () => {
        const fs = window.__tabcomputer.fs;
        const out = {};
        for (const f of await fs.readdir('/tmp/glb-prof').catch(() => [])) out[f] = await fs.readFile(`/tmp/glb-prof/${f}`, 'utf8').catch(() => '');
        return out;
      });
      for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
      // The libraries the profile's addresses fall in (scripts/gui/launch-profile.mjs names them), once each
      const libDir = join(profDir, 'libs');
      mkdirSync(libDir, { recursive: true });
      const wanted = new Set([manifest.apps[app].bin]);
      for (const [f, text] of Object.entries(files)) if (/^ld\.\d+$/.test(f)) for (const m of text.matchAll(/calling init: (\S+)/g)) wanted.add(m[1]);
      for (const path of wanted) {
        const dest = join(libDir, path.split('/').pop());
        if (existsSync(dest)) continue;
        const b64 = await page.evaluate(async (p) => {
          const d = await window.__tabcomputer.fs.readFile(p).catch(() => null);
          if (!d || typeof d === 'string') return null;
          let s = '';
          for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode(...d.subarray(i, i + 0x8000));
          return btoa(s);
        }, path);
        if (b64) writeFileSync(dest, Buffer.from(b64, 'base64'));
      }
      s.engine = Object.fromEntries(Object.entries(files).filter(([f]) => /^\d+\.txt$/.test(f)).map(([f, text]) => [f.replace('.txt', ''), parseEngineProfile(text)]));
    }
    if (errors.length) r.pageErrors = errors.slice(0, 5);
  } catch (e) {
    failed++;
    r.error = String(e.message);
    console.log(`FAIL ${app}  ${String(e.message).split('\n')[0]}`);
  }
  await context.close();
  if (jsonOut) writeFileSync(jsonOut, JSON.stringify(results, null, 1));
}
await browser.close();
const md = markdown(results);
if (mdOut) writeFileSync(mdOut, md);
console.log('\n' + md);
process.exit(failed ? 1 : 0);
