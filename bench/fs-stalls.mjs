#!/usr/bin/env node
// Main-thread stalls under a Claude-like load (tabcomputer#19): npm installs,
// many small writes, git add/status/commit, rm -rf. The page's main thread is
// sampled by the CPU profiler; every long task of FS_STALL_MS or
// more is reported with the functions it spent its time in (self and
// inclusive), so a filesystem commit, clone or sweep shows by name. The long
// tasks are the browser's (PerformanceObserver 'longtask'). Use an
// unminified build for readable names:
//   npx vite build --minify false && cp -r dist /tmp/dist-nomin
//   [FS_STALL_SRC=/tmp/dist-nomin] [FS_STALL_MS=50] [FS_STALL_TOP=6] node bench/fs-stalls.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer } from './lib/servers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STALL_MS = Number(process.env.FS_STALL_MS || 50);
const TOP = Number(process.env.FS_STALL_TOP || 6);
const server = await startShiroServer({ staticDir: process.env.FS_STALL_SRC || join(ROOT, 'dist'), isolated: true });
const h = new Harness({ mode: 'isolated', origin: server.origin, netcache: new NetCache(join(ROOT, 'bench/.cache/net')), runs: 1, log: () => {}, results: [] });
await h.launch();
const sh = (c, s = 1800) => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [c, s * 1000]);

const steps = [
  ['npm i (express, lodash, react, react-dom, typescript)', 'mkdir -p ~/proj && cd ~/proj && npm init -y >/dev/null && printf "node_modules\\n" > .gitignore && npm i express lodash react react-dom typescript >/tmp/npm.out 2>&1'],
  ['300 small writes', 'cd ~/proj && mkdir -p src && for i in $(seq 300); do echo "export const v$i = $i;" > src/m$i.ts; echo "line $i" >> notes.txt; done'],
  ['git init + add + commit', 'cd ~/proj && git init -q && git add -A && git commit -qm init'],
  ['edit 20 files + git status + commit, x5', 'cd ~/proj && for r in 1 2 3 4 5; do for i in $(seq 20); do echo "// edit $r" >> src/m$i.ts; done; git status --short | wc -l; git add -A && git commit -qm "round $r"; done'],
  ['rm -rf node_modules', 'cd ~/proj && rm -rf node_modules'],
  ['npm i again', 'cd ~/proj && npm i >/tmp/npm.out 2>&1'],
];
// FS_STALL_CLONE=URL: a shallow git clone of a big repository (tabcomputer#28: 16 s in one task)
if (process.env.FS_STALL_CLONE) steps.push([`git clone --depth 1 ${process.env.FS_STALL_CLONE}`, `cd ~ && git clone --depth 1 ${process.env.FS_STALL_CLONE} clone 2>&1 | tail -2`]);
// FS_STALL_ONLY=re: only the steps whose label matches
if (process.env.FS_STALL_ONLY) { const re = new RegExp(process.env.FS_STALL_ONLY); for (let i = steps.length - 1; i >= 0; i--) if (!re.test(steps[i][0])) steps.splice(i, 1); }
// FS_STALL_BIG=N: a big store too (N files in 100 directories), then what scans every key
const BIG = Number(process.env.FS_STALL_BIG || 0);
if (BIG) steps.push(
  [`write ${BIG} small files`, `__write ${BIG}`],
  ['ls of a new directory (child index)', 'ls /tmp/big/d7 | wc -l'],
  ['find /tmp/big | wc -l', 'find /tmp/big | wc -l'],
  ['rm -rf /tmp/big/d1', 'rm -rf /tmp/big/d1'],
  ['reload, then ls (key index)', '__reload'],
  ['rm -rf /tmp/big', 'rm -rf /tmp/big'],
);

/**
 * The browser's long tasks (PerformanceObserver), each with where its samples
 * went: `tasks` are [start, duration] in ms on the page clock, `offset` the
 * page clock's ms at the profile's start.
 */
function stalls(profile, tasks, offset) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const name = (n) => {
    const f = n.callFrame;
    return `${f.functionName || '(anonymous)'} ${String(f.url).split('/').pop()}:${f.lineNumber + 1}`;
  };
  const runs = tasks.map(([start, dur]) => ({ start, dur, self: new Map(), incl: new Map() }));
  let t = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    const dt = profile.timeDeltas[i] ?? 0;
    t += dt;
    const at = offset + (t - profile.startTime) / 1000; // page clock, ms
    const cur = runs.find((r) => at >= r.start && at < r.start + r.dur);
    if (!cur) continue;
    const n = byId.get(profile.samples[i]);
    const step = (profile.timeDeltas[i + 1] ?? dt) / 1000;
    cur.self.set(name(n), (cur.self.get(name(n)) ?? 0) + step);
    const seen = new Set();
    for (let id = n.id; id !== undefined; id = parent.get(id)) {
      const k = name(byId.get(id));
      if (seen.has(k)) continue;
      seen.add(k);
      cur.incl.set(k, (cur.incl.get(k) ?? 0) + step);
    }
  }
  return runs.map((r) => ({ ms: r.dur, self: r.self, incl: r.incl })).filter((r) => r.ms >= STALL_MS);
}
const top = (m, skip) => [...m].filter(([k]) => !skip.test(k)).sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([k, v]) => `${v.toFixed(0)} ${k}`).join(' | ');
const GENERIC = /^\((root|program|garbage collector)\)|^\(anonymous\) :0/;

try {
  await h.boot({ path: '/?ui=terminal', waitSettled: true });
  await h.cdp.send('Profiler.enable');
  await h.cdp.send('Profiler.setSamplingInterval', { interval: 250 });
  for (const [label, cmd] of steps) {
    await h.cdp.send('Profiler.start');
    let offset = await h.eval(() => { window.__bench.longTasks.length = 0; return performance.now(); });
    const t0 = Date.now();
    let r = { code: 0 };
    if (cmd.startsWith('__write ')) {
      await h.eval(async (n) => {
        const fs = window.__tabcomputer.fs;
        for (let d = 0; d < 100; d++) await fs.mkdir(`/tmp/big/d${d}`, { recursive: true });
        for (let i = 0; i < n; i += 500) {
          await Promise.all(Array.from({ length: Math.min(500, n - i) }, (_, j) => fs.writeFile(`/tmp/big/d${(i + j) % 100}/f${i + j}.txt`, `file ${i + j}\n`.repeat(20))));
        }
      }, Number(cmd.split(' ')[1]));
    } else if (cmd === '__reload') {
      await h.eval(() => window.__tabcomputer.fs.sync());
      await h.cdp.send('Profiler.stop');
      await h.page.reload();
      await h.page.waitForFunction(() => window.__bench?.marks.firstPrompt, null, { timeout: 120000 });
      await h.cdp.send('Profiler.enable');
      await h.cdp.send('Profiler.start');
      offset = await h.eval(() => { window.__bench.longTasks.length = 0; return performance.now(); });
      r = await sh('ls /tmp/big/d3 | wc -l; ls -la /tmp/big | wc -l');
    } else r = await sh(cmd);
    await h.eval(() => window.__tabcomputer.fs.sync());
    const { profile } = await h.cdp.send('Profiler.stop');
    const tasks = await h.eval(() => window.__bench.longTasks.slice());
    const s = stalls(profile, tasks, offset).sort((a, b) => b.ms - a.ms);
    const total = s.reduce((a, b) => a + b.ms, 0);
    console.log(`\n== ${label}: ${((Date.now() - t0) / 1000).toFixed(1)} s, exit ${r.code}; ${s.length} stalls >= ${STALL_MS} ms (${total.toFixed(0)} ms), longest ${s[0]?.ms.toFixed(0) ?? 0} ms`);
    for (const x of s.slice(0, 5)) {
      const sum = (re) => [...x.self].filter(([k]) => re.test(k)).reduce((a, [, v]) => a + v, 0);
      console.log(`  ${x.ms.toFixed(0)} ms  (gc ${sum(/^\(garbage collector\)/).toFixed(0)}, program ${sum(/^\(program\)/).toFixed(0)}, idle ${sum(/^\(idle\)/).toFixed(0)})  self: ${top(x.self, GENERIC)}`);
      console.log(`         incl: ${top(x.incl, /^\((root|program|garbage collector)\)/)}`);
    }
  }
} finally {
  await h.close(); await server.close();
}
