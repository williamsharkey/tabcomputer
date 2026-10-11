#!/usr/bin/env node
// Buckets the blinkprof suite's raw files by library (perf-blink's recipe):
//   node bench/blinkprof-report.mjs [bench/.cache/blinkprof] [--json out.json]
// Per process (one SHIRO_BLINK_PROFILE file per pid):
// - compiled code: every region's guest instructions, by its entry pc;
// - interpreter: the interpreted-address table (sampled, scaled);
// each bucketed by address, then weighted by time: compiled share × "in
// compiled code ms" + interpreted share × (run ms − compiled ms).
// Addresses map to libraries by glibc's LD_DEBUG=files bases (ld.<pid>), and
// inside libc to functions by its full symbols (fetched by build-id from
// debuginfod.debian.net into bench/.cache/blinkprof/dbg; the .so's own dynsym
// otherwise). Buckets: libz, liblzma, libc mem*/str*, libc other, ld.so,
// other named libraries, and the program itself (or unmapped).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'bench/.cache/blinkprof';
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const hex = (s) => BigInt(s);

/** Symbols (start offset, size, name) of a library: the debug file when debuginfod has it, else dynsym. */
function symbols(lib) {
  const path = join(dir, 'libs', lib);
  if (!existsSync(path)) return [];
  let src = path;
  try {
    const id = /Build ID: ([0-9a-f]+)/.exec(execFileSync('readelf', ['-n', path], { encoding: 'utf8' }))?.[1];
    if (id) {
      const dbg = join(dir, 'dbg', `${id}.debug`);
      if (!existsSync(dbg)) {
        mkdirSync(join(dir, 'dbg'), { recursive: true });
        try { execFileSync('curl', ['-fsSL', '-o', dbg, `https://debuginfod.debian.net/buildid/${id}/debuginfo`], { stdio: 'ignore', timeout: 120000 }); } catch {}
      }
      if (existsSync(dbg)) src = dbg;
    }
  } catch {}
  const out = execFileSync('nm', ['-S', '--defined-only', ...(src === path ? ['-D'] : []), src], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const syms = [];
  for (const l of out.split('\n')) {
    const m = /^([0-9a-f]+) ([0-9a-f]+) [tTwWiI] (\S+)/.exec(l);
    if (m) syms.push({ start: parseInt(m[1], 16), size: parseInt(m[2], 16), name: m[3] });
  }
  syms.sort((a, b) => a.start - b.start);
  return syms;
}
const symCache = new Map();
function symAt(lib, off) {
  if (!symCache.has(lib)) symCache.set(lib, symbols(lib));
  const s = symCache.get(lib);
  let lo = 0, hi = s.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid].start <= off) { best = s[mid]; lo = mid + 1; } else hi = mid - 1; }
  return best && off < best.start + Math.max(best.size, 1) ? best.name : null;
}
const MEMSTR = /^(__)?(mem|str|wmem|wcs|stp|rawmem|bcopy|bzero)[a-z_]*/;

/** Library ranges of a process from LD_DEBUG=files output. */
function ldRanges(file) {
  const ranges = [];
  if (!existsSync(file)) return { ranges, prog: null };
  const t = readFileSync(file, 'utf8');
  const prog = /initialize program: (\S+)/.exec(t)?.[1] ?? null;
  const re = /file=(\S+) \[\d+\];\s+generating link map\s*\n\s*\d+:\s+dynamic: (0x[0-9a-f]+)\s+base: (0x[0-9a-f]+)\s+size: (0x[0-9a-f]+)/g;
  for (const m of t.matchAll(re)) ranges.push({ lib: m[1].split('/').pop(), base: hex(m[3]), end: hex(m[3]) + hex(m[4]) });
  return { ranges, prog };
}

function bucketOf(pc, ranges) {
  for (const r of ranges) {
    if (pc >= r.base && pc < r.end) {
      if (/^libz\.so/.test(r.lib)) return 'libz';
      if (/^liblzma\.so/.test(r.lib)) return 'liblzma';
      if (/^libc\.so/.test(r.lib)) { const s = symAt(r.lib, Number(pc - r.base)); return s && MEMSTR.test(s) ? 'libc mem*/str*' : 'libc other'; }
      if (/^ld-linux/.test(r.lib)) return 'ld.so';
      return `lib:${r.lib}`;
    }
  }
  return 'program/unmapped';
}

/** One profile file → { pid, runMs, compiledMs, compiled: [[pc, n]], interp: [[pc, n]] }. */
function parseProfile(text) {
  const pid = Number(/^pid (\d+)/m.exec(text)?.[1]);
  let runMs = 0, compiledMs = 0;
  const tids = [];
  const blocks = Number(/^total: (\d+) compiled blocks/m.exec(text)?.[1] ?? 0);
  const lines = text.split('\n');
  const th = lines.findIndex((l) => /^thread\s+run ms/.test(l));
  if (th >= 0) for (let i = th + 1; i < lines.length && /^\s*\d+\s/.test(lines[i]); i++) {
    const c = lines[i].trim().split(/\s+/).map(Number);
    // the compiled-code time is sampled and scaled (1 in SHIRO_BLINK_PROFILE_EVERY): capped at the thread's run time
    // a real pid and its blocks run: files of one instance repeat it (a finished thread's count no
    // longer moves; ids from 262144 are reused across instances, rows with no blocks are other
    // instances' children listed before they ran)
    if (c[0] < 262144 && c[5] > 0) tids.push(`${c[0]}:${c[5]}`);
    runMs += c[1]; compiledMs += Math.min(c[c.length - 1], c[1]);
  }
  const table = (headRe, stopRe) => {
    const out = [];
    const i0 = lines.findIndex((l) => headRe.test(l));
    if (i0 < 0) return out;
    for (let i = i0 + 1; i < lines.length; i++) {
      const m = /^\s*(0x[0-9a-f]+)\s+(\d+)/.exec(lines[i]);
      if (!m) { if (stopRe.test(lines[i]) || !lines[i].trim()) break; continue; }
      out.push([hex(m[1]), Number(m[2])]);
    }
    return out;
  };
  return { pid, tids, blocks, runMs, compiledMs, compiled: table(/^guest instructions run in compiled code/, /^\S/), interp: table(/^most interpreted addresses/, /^most interpreted opcodes/) };
}

const report = {};
for (const w of readdirSync(dir).filter((d) => existsSync(join(dir, d, 'wall.json')))) {
  const wall = JSON.parse(readFileSync(join(dir, w, 'wall.json'), 'utf8'));
  const B = {};
  let run = 0;
  const procs = [];
  // A file covers its whole Blink instance (every process and thread in it), and each process of
  // the instance writes one: files that repeat a pid with the same blocks run are one instance; keep the most
  // complete (most blocks run)
  const all = readdirSync(join(dir, w)).filter((f) => /^\d+\.txt$/.test(f)).map((f) => parseProfile(readFileSync(join(dir, w, f), 'utf8'))).sort((a, b) => b.blocks - a.blocks || b.runMs - a.runMs);
  const kept = [], seen = new Set();
  for (const p of all) { if (p.tids.some((t) => seen.has(t))) continue; p.tids.forEach((t) => seen.add(t)); kept.push(p); }
  for (const p of kept) {
    // a child forked without exec has no LD_DEBUG output of its own but the parent's mappings:
    // take the nearest lower pid that has one (its forking parent, in these workloads), marked "fork of"
    let ld = ldRanges(join(dir, w, `ld.${p.pid}`)), inherited = null;
    if (!ld.ranges.length) {
      const lower = readdirSync(join(dir, w)).map((f) => /^ld\.(\d+)$/.exec(f)?.[1]).filter(Boolean).map(Number).filter((x) => x < p.pid).sort((a, b) => b - a)[0];
      if (lower != null) { ld = ldRanges(join(dir, w, `ld.${lower}`)); inherited = lower; }
    }
    const { ranges } = ld;
    const prog = inherited != null ? `fork of ${inherited} (${ld.prog ?? '?'})` : ld.prog;
    const share = (rows) => { const s = {}; let t = 0; for (const [pc, n] of rows) { const b = bucketOf(pc, ranges); s[b] = (s[b] || 0) + n; t += n; } return { s, t }; };
    const c = share(p.compiled), it = share(p.interp);
    const interpMs = Math.max(0, p.runMs - p.compiledMs);
    const pb = {};
    for (const [b, n] of Object.entries(c.s)) pb[b] = (pb[b] || 0) + (c.t ? n / c.t * p.compiledMs : 0);
    for (const [b, n] of Object.entries(it.s)) pb[b] = (pb[b] || 0) + (it.t ? n / it.t * interpMs : 0);
    for (const [b, ms] of Object.entries(pb)) B[b] = (B[b] || 0) + ms;
    run += p.runMs;
    procs.push({ pid: p.pid, prog: prog ?? '?', runMs: p.runMs, compiledMs: p.compiledMs, libs: ranges.length, top: Object.entries(pb).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([b, ms]) => `${b} ${Math.round(ms)}`) });
  }
  report[w] = { wallMs: Math.round(wall.wallMs), guestRunMs: Math.round(run), buckets: Object.fromEntries(Object.entries(B).sort((a, b) => b[1] - a[1]).map(([b, ms]) => [b, { ms: Math.round(ms), ofRun: +(ms / run * 100).toFixed(1), ofWall: +(ms / wall.wallMs * 100).toFixed(1) }])), procs: procs.sort((a, b) => b.runMs - a.runMs) };
}

for (const [w, r] of Object.entries(report)) {
  const z = (k) => r.buckets[k]?.ofRun ?? 0;
  console.log(`\n${w}: wall ${r.wallMs} ms, guest run ${r.guestRunMs} ms over ${r.procs.length} processes; libz+liblzma ${(z('libz') + z('liblzma')).toFixed(1)}% of run`);
  for (const [b, v] of Object.entries(r.buckets)) console.log(`  ${b.padEnd(28)} ${String(v.ms).padStart(8)} ms  ${String(v.ofRun).padStart(5)}% of run  ${String(v.ofWall).padStart(5)}% of wall`);
  for (const p of r.procs.slice(0, 6)) console.log(`    pid ${p.pid} ${p.prog}: run ${p.runMs} ms (compiled ${p.compiledMs}), ${p.libs} libs; ${p.top.join(', ')}`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 2));
