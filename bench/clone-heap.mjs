#!/usr/bin/env node
// What the JS heap keeps after a big git clone, and after rm -rf of it.
// Heap is measured after a forced full GC (HeapProfiler.collectGarbage), so a
// number that stays high is retained, not garbage V8 has yet to collect. With
// CLONE_HEAP_SNAP=1, the live objects by constructor that grew most from the
// baseline are listed (heap snapshot diff).
//   [CLONE_HEAP_URL=https://github.com/axios/axios] [CLONE_HEAP_SRC=dist] [CLONE_HEAP_SNAP=1] node bench/clone-heap.mjs
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Harness } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer } from './lib/servers.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const URL_ = process.env.CLONE_HEAP_URL || 'https://github.com/williamsharkey/tabcomputer';
const server = await startShiroServer({ staticDir: process.env.CLONE_HEAP_SRC || join(ROOT, 'dist'), isolated: true });
const h = new Harness({ mode: 'isolated', origin: server.origin, netcache: new NetCache(join(ROOT, 'bench/.cache/net')), runs: 1, log: () => {}, results: [] });
await h.launch();
await h.boot({ path: '/?ui=terminal', keepNetwork: true });
const sh = (c) => h.eval(([c]) => window.__bench.shLimit(c, 1800000), [c]);
const MiB = (n) => (n / 1048576).toFixed(0);

async function heap() {
  await h.cdp.send('HeapProfiler.collectGarbage');
  await h.cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await h.cdp.send('Performance.getMetrics');
  return metrics.find((m) => m.name === 'JSHeapUsedSize').value;
}

/** { "type:name": [count, selfBytes] } of live objects. */
async function heapCounts() {
  await h.cdp.send('HeapProfiler.enable');
  await h.cdp.send('HeapProfiler.collectGarbage');
  const chunks = [];
  const onChunk = (e) => chunks.push(e.chunk);
  h.cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await h.cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  h.cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  const snap = JSON.parse(chunks.join(''));
  const f = snap.snapshot.meta.node_fields, types = snap.snapshot.meta.node_types[0];
  const iType = f.indexOf('type'), iName = f.indexOf('name'), iSize = f.indexOf('self_size'), w = f.length;
  const out = {};
  for (let i = 0; i < snap.nodes.length; i += w) {
    const t = types[snap.nodes[i + iType]];
    const name = t === 'object' || t === 'closure' || t === 'array' || t === 'native' ? `${t}:${snap.strings[snap.nodes[i + iName]].slice(0, 60)}` : t;
    const e = (out[name] ??= [0, 0]);
    e[0]++; e[1] += snap.nodes[i + iSize];
  }
  return out;
}

function diff(a, b, top = 20) {
  return Object.entries(b).map(([k, [n, s]]) => [k, n - (a[k]?.[0] ?? 0), s - (a[k]?.[1] ?? 0)])
    .sort((x, y) => y[2] - x[2]).slice(0, top)
    .map(([k, n, s]) => `    ${MiB(s).padStart(6)} MiB  ${String(n).padStart(8)}  ${k}`).join('\n');
}

const snap = !!process.env.CLONE_HEAP_SNAP;
const base = await heap();
const baseCounts = snap ? await heapCounts() : null;
console.log(`baseline: ${MiB(base)} MiB`);
const t0 = Date.now();
const r = await sh(`cd ~ && git clone --depth 1 ${URL_} clone 2>&1 | tail -1; echo exit=$?`);
console.log(`clone: ${((Date.now() - t0) / 1000).toFixed(1)} s; ${r.out.trim().split('\n').slice(-2).join(' | ')}`);
await h.eval(() => new Promise((res) => { const fs = window.__tabcomputer.fs; const tick = () => (!fs.pendingWrites ? res() : setTimeout(tick, 20)); tick(); }));
console.log(`after clone (GC): ${MiB(await heap())} MiB`);
if (snap) console.log(diff(baseCounts, await heapCounts()));
await sh('rm -rf ~/clone');
await h.eval(() => new Promise((res) => { const fs = window.__tabcomputer.fs; const tick = () => (!fs.pendingWrites ? res() : setTimeout(tick, 20)); tick(); }));
console.log(`after rm -rf (GC): ${MiB(await heap())} MiB`);
await h.eval(() => window.__tabcomputer.fs.sweepContent?.(Date.now() + 1e9));
console.log(`after content sweep (GC): ${MiB(await heap())} MiB`);
if (snap) console.log(diff(baseCounts, await heapCounts()));
await h.close();
await server.close();
