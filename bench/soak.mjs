#!/usr/bin/env node
// Soak test: an agent-like command workload for a long time in one page,
// tracking what the kernel, the shell and the page keep. Claude's Bash tool
// drives the machine through short commands, either in the page's shell (the
// npm build's child_process) or as kernel `bash -c` processes (the native
// build): both are run here, interleaved. Every SOAK_EVERY commands, after a
// forced GC, it records the kernel process table, open fds and pipes, waiter
// and listener sets, the page shell's job tables and history, the JS heap and
// the renderer RSS; at the end it fits growth per 1000 commands.
//
//   node bench/soak.mjs [--minutes 60] [--every 300] [--out file.json] [--no-build]
//   (MODE=nonisolated for the fallback page)
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Harness, MB } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer, startTcpTestServer, hostAddress } from './lib/servers.mjs';
import { prepareFixtures } from './lib/fixtures.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const MINUTES = Number(arg('--minutes', process.env.SOAK_MINUTES ?? 60));
const EVERY = Number(arg('--every', process.env.SOAK_EVERY ?? 300));
const OUT = arg('--out', `bench/results/soak-${new Date().toISOString().slice(0, 16).replace(/:/g, '')}.json`);
if (!process.argv.includes('--no-build')) execFileSync('npm', ['run', 'build'], { stdio: 'inherit' });

// The commands: what an agent runs while working on a small repository
const PAGE = [
  'cd /home/user/proj && git status --short',
  'cd /home/user/proj && git diff --stat | tail -1',
  'cd /home/user/proj && git log --oneline -3',
  'ls -la /home/user/proj | head -5',
  'grep -rn TODO /home/user/proj/src | head -3',
  'cat /home/user/proj/README.md | wc -l',
  'find /home/user/proj -name "*.js" | wc -l',
  "printf 'b\\na\\nb\\n' | sort | uniq -c",
  'echo "$(date +%s) $RANDOM" > /tmp/soak/t.txt && cat /tmp/soak/t.txt',
  'timeout 0.2 sleep 5; echo "timeout $?"',
  'timeout 0.2 cat; echo "cat $?"',
  '(sleep 0.05; echo bg) & wait',
  'sleep 0.02 &',
  "bash -c 'for i in 1 2 3; do echo $i; done' | tail -1",
  "bash -c -l 'pwd; echo ok' < /dev/null",
  'node -e "console.log(1 + 1)"',
  'sed -i "s/v[0-9]*/v$RANDOM/" /home/user/proj/src/version.js && cat /home/user/proj/src/version.js',
];
// As kernel processes (native Claude's `bash -c CMD`): a sh -c each
const KERNEL = [
  'cd /home/user/proj && git status --short',
  'ls /home/user/proj/src | wc -l',
  'grep -c x /home/user/proj/src/a.js',
  "printf 'x\\ny\\n' | sort -r | head -1",
  'timeout 0.2 sleep 5; echo $?',
  'cat /home/user/proj/README.md | tr a-z A-Z | head -1',
];

const tcp = await startTcpTestServer();
const mode = process.env.MODE || 'isolated';
prepareFixtures({ cacheDir: 'bench/.cache', publishDir: 'dist/__bench' });
const server = await startShiroServer({ staticDir: join(process.cwd(), 'dist'), isolated: mode === 'isolated', tcpPorts: Object.values(tcp.ports), allowCidrs: [hostAddress() + '/32'] });
const h = new Harness({ mode, origin: server.origin, netcache: new NetCache('bench/.cache/net', { log: () => {} }), runs: 1, log: console.log, results: [] });
await h.launch();
await h.boot({ waitSettled: true });

await h.eval(async () => {
  const B = window.__bench;
  await B.sh('mkdir -p /home/user/proj/src /tmp/soak && cd /home/user/proj && git init -q . 2>/dev/null; git config user.email s@k; git config user.name soak');
  await B.writeFile('/home/user/proj/README.md', '# soak\nline\nline\n');
  await B.writeFile('/home/user/proj/src/a.js', 'x // TODO one\nx\n');
  await B.writeFile('/home/user/proj/src/version.js', 'export const v = "v1";\n');
  await B.sh('cd /home/user/proj && git add -A && git commit -qm init');
});

/** What the kernel, shell and page hold now (after a GC). */
async function probe() {
  const m = await h.memory({ uasm: false });
  const k = await h.eval(() => {
    const T = window.__tabcomputer, k = T.kernel, sh = T.shell, B = window.__bench;
    let fds = 0, pipes = new Set(), sockets = 0, waitersOnPipes = 0;
    for (const p of k.procs.values()) {
      for (const [, f] of p.fds.entries()) {
        fds++;
        if (f.kind === 'pipe' && f.pipe) { pipes.add(f.pipe); }
        if (f.kind === 'socket') sockets++;
      }
    }
    for (const pp of pipes) waitersOnPipes += (pp.readWaiters?.size ?? 0) + (pp.writeWaiters?.size ?? 0);
    const size = (x) => (x && typeof x.size === 'number' ? x.size : x && typeof x.length === 'number' ? x.length : null);
    let pt = null;
    try { pt = window.__processTable?.list?.().length ?? null; } catch {}
    return {
      ...B.kernelStats(),
      pipes: pipes.size, sockets, waitersOnPipes,
      stateWaiters: size(k.stateWaiters), spawnHooks: size(k.spawnHooks),
      shmobjs: k.shmobj?.list?.().length ?? null,
      locks: size(k.locks?.locks ?? k.locks?.byPath),
      processTable: pt,
      bgJobs: size(sh.backgroundJobs), history: size(sh.history),
      ...B.liveShared(),
    };
  });
  return { ...m, ...k, workers: h.page.workers().length };
}

/** Live objects by constructor (type) name in a heap snapshot: { name: [count, selfBytes] } (SOAK_HEAPDIFF=1). */
async function heapCounts() {
  const cdp = h.cdp;
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  const snap = JSON.parse(chunks.join(''));
  const f = snap.snapshot.meta.node_fields, types = snap.snapshot.meta.node_types[0];
  const iType = f.indexOf('type'), iName = f.indexOf('name'), iSize = f.indexOf('self_size'), w = f.length;
  const out = {};
  for (let i = 0; i < snap.nodes.length; i += w) {
    const t = types[snap.nodes[i + iType]];
    const name = t === 'object' || t === 'closure' || t === 'string' || t === 'array' ? `${t}:${t === 'string' ? '' : snap.strings[snap.nodes[i + iName]]}` : t;
    const e = (out[name] ??= [0, 0]);
    e[0]++; e[1] += snap.nodes[i + iSize];
  }
  return out;
}
let heapBase = null;

const series = [];
const t0 = Date.now();
let n = 0, failures = 0, slowest = 0;
const snap = async () => {
  const p = await probe();
  series.push({ n, minutes: (Date.now() - t0) / 60000, ...p });
  console.log(`[soak] ${n} cmds, ${((Date.now() - t0) / 60000).toFixed(1)} min: heap ${(p.jsHeapUsed / MB).toFixed(1)} MiB rss ${((p.rendererRss ?? 0) / MB).toFixed(0)} MiB procs ${p.procs} (zombies ${p.zombies}) fds ${p.fds} pipes ${p.pipes} stateWaiters ${p.stateWaiters} procTable ${p.processTable} bgJobs ${p.bgJobs} workers ${p.workers} sabs ${p.sabs} failures ${failures}`);
};
await snap();
while (Date.now() - t0 < MINUTES * 60000) {
  const batch = await h.eval(async ([page, kernel, count, start]) => {
    const B = window.__bench;
    let fails = 0, slow = 0;
    for (let i = 0; i < count; i++) {
      const j = start + i;
      const t = performance.now();
      if (j % 4 === 3) {
        const r = await B.runProcs([['sh', '-c', kernel[(j >> 2) % kernel.length]]]);
        if (r.codes.some((c) => c !== 0 && c !== 124 && c !== 143)) fails++;
      } else {
        const r = await B.shLimit(page[j % page.length], 20000);
        if (r.code === undefined) fails++;
      }
      slow = Math.max(slow, performance.now() - t);
    }
    return { fails, slow };
  }, [PAGE, KERNEL, EVERY, n]);
  n += EVERY;
  if (process.env.SOAK_HEAPDIFF && !heapBase && n >= EVERY * 2) heapBase = { n, counts: await heapCounts() };
  failures += batch.fails;
  slowest = Math.max(slowest, batch.slow);
  await snap();
}

let heapDiff = null;
if (heapBase) {
  const end = await heapCounts();
  heapDiff = Object.entries(end).map(([k, [c, b]]) => [k, c - (heapBase.counts[k]?.[0] ?? 0), b - (heapBase.counts[k]?.[1] ?? 0)])
    .filter(([, dc, db]) => dc > 0 || db > 0).sort((a, b) => b[2] - a[2]).slice(0, 30);
  console.log(`[soak] heap growth by type over commands ${heapBase.n}..${n} (count, bytes):`);
  for (const [k, dc, db] of heapDiff) console.log(`  ${String(dc).padStart(8)} ${String(db).padStart(10)}  ${k}`);
}

// Growth per 1000 commands: least squares over the snapshots after the first (warm-up)
const fit = (key) => {
  const pts = series.slice(1).filter((s) => typeof s[key] === 'number');
  if (pts.length < 3) return null;
  const mx = pts.reduce((a, s) => a + s.n, 0) / pts.length, my = pts.reduce((a, s) => a + s[key], 0) / pts.length;
  let num = 0, den = 0;
  for (const s of pts) { num += (s.n - mx) * (s[key] - my); den += (s.n - mx) ** 2; }
  return den ? (num / den) * 1000 : null;
};
const keys = ['jsHeapUsed', 'rendererRss', 'procs', 'zombies', 'fds', 'pipes', 'sockets', 'waitersOnPipes', 'stateWaiters', 'spawnHooks', 'shmobjs', 'processTable', 'bgJobs', 'history', 'workers', 'sabs', 'sharedMemories', 'listeners', 'nodes'];
const growth = Object.fromEntries(keys.map((k) => [k, fit(k)]).filter(([, v]) => v !== null));
console.log('\n[soak] growth per 1000 commands:');
for (const [k, v] of Object.entries(growth)) console.log(`  ${k.padEnd(16)} ${k === 'jsHeapUsed' || k === 'rendererRss' ? (v / MB).toFixed(2) + ' MiB' : v.toFixed(2)}`);
console.log(`[soak] ${n} commands in ${((Date.now() - t0) / 60000).toFixed(1)} min, ${failures} failed, slowest ${(slowest / 1000).toFixed(1)} s`);
writeFileSync(OUT, JSON.stringify({ minutes: MINUTES, every: EVERY, commands: n, failures, slowestMs: slowest, growthPer1000: growth, heapDiff, series }, null, 1));
console.log(`[soak] wrote ${OUT}`);
await h.close(); await server.close(); await tcp.close();
