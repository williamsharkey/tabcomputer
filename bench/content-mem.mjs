#!/usr/bin/env node
// Renderer memory of long-running work once its files go idle: what the
// FileSystem's content cache keeps (src/filesystem.ts "Content cache").
//   [CM_SRC=dir] [CM_SCENARIOS=vite,session] [CM_SESSION_MIN=10] node bench/content-mem.mjs
// - vite: `npm create vite@7`, `npm i`, `npm run dev` typed at the terminal,
//   the preview opened (vite transforms the app's modules), an edit by HMR.
// - session: the long agent session, compressed: Claude Code's npm build
//   (installed in the background at boot), then CM_SESSION_MIN minutes of
//   the work an agent does in a project: grep, find, cat, edits, git status,
//   diff and commits, node scripts, `claude --npm --version`, with pauses.
// After each, the page idles past CONTENT_IDLE_MS and the renderer's RSS
// (all its processes, after a GC) and the cache's content bytes by file
// size are read. CM_SRC measures another checkout's dist/ (an A/B: run once
// per tree). npm and the registry come from bench/.cache/net.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness, MB } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer } from './lib/servers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = process.env.CM_SRC || ROOT;
const scenarios = (process.env.CM_SCENARIOS || 'vite,session').split(',');
const SESSION_MIN = Number(process.env.CM_SESSION_MIN || 10);
const IDLE_S = Number(process.env.CM_IDLE_S || 50);

const server = await startShiroServer({ staticDir: join(src, 'dist'), isolated: true });
const h = new Harness({ mode: 'isolated', origin: server.origin, netcache: new NetCache(join(ROOT, 'bench/.cache/net')), runs: 1, log: () => {}, results: [] });
await h.launch();
const sh = (c, s = 1800) => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [c, s * 1000]);
const side = (cmd) => h.eval(async (c) => {
  const s = window.__tabcomputer.shell.fork(); s.terminal = null;
  let out = '';
  const code = await s.execute(c, (x) => { out += x; }, (x) => { out += x; });
  return { code, out };
}, cmd);
const termText = () => h.eval(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) rows.push(b.getLine(y)?.translateToString(true) ?? '');
  return rows.join('\n');
});
async function typeAndWait(line, re, limitMs, what) {
  const from = (await termText()).length;
  const t0 = Date.now();
  await h.eval((l) => window.__tabcomputer.terminal.term.input(l, true), line);
  for (;;) {
    const s = (await termText()).slice(from);
    if (re.test(s)) return Date.now() - t0;
    if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}: ${s.split('\n').slice(-6).join(' | ').slice(0, 400)}`);
    await h.page.waitForTimeout(100);
  }
}
/** Wait until some preview frame of :5173 shows `re` (frames come and go while it loads). */
async function previewShows(re, limitMs, what) {
  const t0 = Date.now();
  let seen = [];
  for (;;) {
    seen = [];
    for (const el of await h.page.$$('iframe[data-virtual-port="5173"]')) {
      const f = await el.contentFrame().catch(() => null);
      const text = f ? await f.evaluate(() => document.body?.innerText ?? '').catch(() => '') : '';
      if (re.test(text)) return;
      seen.push(`${f?.url()}: ${text.slice(0, 120)}`);
    }
    if (Date.now() - t0 > limitMs) throw new Error(`timed out waiting for ${what}; frames: ${seen.join(' | ') || 'none'}; terminal: ${(await termText()).split('\n').filter(Boolean).slice(-4).join(' | ').slice(0, 300)}`);
    await h.page.waitForTimeout(200);
  }
}
let marks = 0;
async function term(cmd, limitMs = 600000) {
  const mark = `@@cm${++marks}`;
  await typeAndWait(`${cmd}; echo "${mark} $?"\r`, new RegExp(`^${mark} 0$`, 'm'), limitMs, cmd);
}

/** Content bytes in the FileSystem's cache by file size, and the nodes kept without their bytes. */
const cacheReport = () => h.eval(() => {
  const fs = window.__tabcomputer.fs;
  const r = { small: 0, smallN: 0, mid: 0, midN: 0, big: 0, bigN: 0, nodes: 0, meta: fs._meta?.size ?? 0 };
  for (const n of fs.cache.values()) {
    if (!n) continue;
    r.nodes++;
    const b = n.type === 'file' ? n.content?.byteLength ?? 0 : 0;
    if (!b) continue;
    if (b < 64 << 10) { r.small += b; r.smallN++; } else if (b < 8 << 20) { r.mid += b; r.midN++; } else { r.big += b; r.bigN++; }
  }
  return r;
});
const mib = (b) => (b / MB).toFixed(1);
async function measure(label) {
  const m = await h.memory({ uasm: false });
  const c = await cacheReport();
  console.log(`${label.padEnd(30)} RSS ${mib(m.rendererRss).padStart(7)} MiB  heap ${mib(m.jsHeapUsed).padStart(6)} MiB  cache: <64K ${mib(c.small)} MiB (${c.smallN}), 64K-8M ${mib(c.mid)} MiB (${c.midN}), big ${mib(c.big)} MiB (${c.bigN}); ${c.nodes} nodes, ${c.meta} without bytes`);
  return { rss: m.rendererRss, ...c };
}
async function idle(label) {
  await h.page.waitForTimeout(IDLE_S * 1000);
  return measure(label);
}

try {
  if (scenarios.includes('vite')) {
    await h.boot({ path: '/?ui=terminal' });
    await term('cd ~ && npm create vite@7 app -- --template react --no-interactive', 300000);
    await term('cd ~/app && npm i', 900000);
    await typeAndWait('npm run dev\r', /ready in \d+ ms|Local:\s+http/, 300000, 'vite ready');
    const opened = await side('serve open 5173');
    if (opened.code !== 0) throw new Error(`serve open 5173: ${opened.out.slice(0, 200)}`);
    await previewShows(/count is \d/i, 300000, 'the preview');
    await measure('vite: preview up');
    await idle(`vite: idle ${IDLE_S} s`);
    await side("sed -i 's|count is|Edited by HMR, count is|' ~/app/src/App.jsx");
    const t0 = Date.now();
    await previewShows(/Edited by HMR/, 60000, 'the HMR update');
    console.log(`vite: HMR after idle ${Date.now() - t0} ms`);
    await idle(`vite: idle again ${IDLE_S} s`);
    await h.page.context().close();
  }

  if (scenarios.includes('session')) {
    await h.boot({ path: '/?ui=terminal', waitSettled: true });
    let r = await sh('claude --npm --version 2>&1 | tail -1');
    console.log(`session: claude --npm --version: ${r.out.trim()}`);
    await sh('mkdir -p ~/proj && cd ~/proj && npm init -y >/dev/null && npm i lodash@4 express@4 >/tmp/npm.out 2>&1; echo $?', 900);
    await sh('cd ~/proj && git init -q && git add -A >/dev/null && git commit -qm init; echo $?', 300);
    await measure('session: set up');
    const work = [
      'cd ~/proj && grep -rn "function" node_modules/express/lib | wc -l',
      'cd ~/proj && find . -name "*.js" | wc -l',
      'cd ~/proj && cat node_modules/lodash/package.json node_modules/express/lib/router/index.js | wc -c',
      'cd ~/proj && printf "const _ = require(\'lodash\');\\nconsole.log(_.chunk([1,2,3,4,5], %d).length);\\n" $RANDOM > index.js && node index.js',
      'cd ~/proj && git status --short | head -5 && git diff --stat | tail -1',
      'cd ~/proj && git add -A && git commit -qm "step" && git log --oneline | wc -l',
      'cd ~/proj && node -e "const e=require(\'express\'); console.log(typeof e())"',
      'cd ~/proj && sed -i "s/chunk/chunk/" index.js && ls -la node_modules | wc -l',
      'claude --npm --version >/dev/null 2>&1; echo $?',
    ];
    const t0 = Date.now();
    let n = 0;
    while (Date.now() - t0 < SESSION_MIN * 60000) {
      r = await sh(work[n % work.length], 600);
      if (r.code !== 0) console.log(`  step ${n % work.length} exit ${r.code}: ${r.out.trim().slice(0, 200)}`);
      n++;
      if (n % work.length === 0) await h.page.waitForTimeout(5000); // a pause between rounds (the model thinking)
    }
    console.log(`session: ${n} commands in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
    await measure('session: end of work');
    await idle(`session: idle ${IDLE_S} s`);
    await h.page.context().close();
  }
} finally {
  await h.close(); await server.close();
}
