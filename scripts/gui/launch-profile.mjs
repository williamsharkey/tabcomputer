#!/usr/bin/env node
// Where a GUI app's launch spends its guest instructions, by library and by
// function (docs/GUI_LAUNCH.md). Reads what
//   node tests/browser/gui-launch-bench.mjs --engine-profile DIR APP...
// left in DIR: per app the engine's SHIRO_BLINK_PROFILE files (<pid>.txt:
// instructions run per compiled region, the most interpreted addresses),
// glibc's LD_DEBUG=files output (ld.<pid>: each library's base), and DIR/libs,
// the libraries themselves. Symbols are the libraries' own (.dynsym, .symtab
// when not stripped): an address inside a static function is named after the
// exported one before it, marked "~".
//
// --debuginfod fetches the libraries' debug files by build id instead.
//
//   node scripts/gui/launch-profile.mjs DIR [--json FILE] [--top N] [--debuginfod [URL]] [APP...]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const jsonOut = opt('--json');
const TOP = Number(opt('--top') ?? 25);
const dbgAt = args.indexOf('--debuginfod');
const debuginfod = dbgAt < 0 ? null : (args[dbgAt + 1]?.includes('://') ? args.splice(dbgAt, 2)[1] : (args.splice(dbgAt, 1), 'https://debuginfod.debian.net')).replace(/\/$/, '');
const dir = args.shift();
if (!dir) { console.error('usage: launch-profile.mjs DIR [--json FILE] [--top N] [APP...]'); process.exit(2); }
const apps = args.length ? args : readdirSync(dir).filter((d) => d !== 'libs' && readdirSync(join(dir, d)).some((f) => /^\d+\.txt$/.test(f)));

/** FUNC symbols of an ELF64 file, sorted by address */
function elfSymbols(path) {
  if (!existsSync(path)) return [];
  const b = readFileSync(path);
  if (b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2) return [];
  const shoff = Number(b.readBigUInt64LE(0x28)), shentsize = b.readUInt16LE(0x3a), shnum = b.readUInt16LE(0x3c);
  const sh = (i) => { const o = shoff + i * shentsize; return { type: b.readUInt32LE(o + 4), offset: Number(b.readBigUInt64LE(o + 24)), size: Number(b.readBigUInt64LE(o + 32)), link: b.readUInt32LE(o + 40), entsize: Number(b.readBigUInt64LE(o + 56)) }; };
  const syms = [];
  for (let i = 0; i < shnum; i++) {
    const s = sh(i);
    if (s.type !== 2 && s.type !== 11) continue; // SYMTAB, DYNSYM
    const str = sh(s.link);
    for (let o = s.offset; o + 24 <= s.offset + s.size; o += s.entsize || 24) {
      const info = b[o + 4], value = Number(b.readBigUInt64LE(o + 8)), size = Number(b.readBigUInt64LE(o + 16));
      if ((info & 15) !== 2 && (info & 15) !== 10 || !value) continue; // FUNC, GNU_IFUNC
      const n0 = str.offset + b.readUInt32LE(o);
      let n1 = n0;
      while (b[n1]) n1++;
      syms.push({ start: value, size, name: b.toString('latin1', n0, n1) });
    }
  }
  syms.sort((a, c) => a.start - c.start);
  return syms;
}
/** The GNU build id of an ELF64 file (hex), or null */
function buildId(path) {
  if (!existsSync(path)) return null;
  const b = readFileSync(path);
  if (b.length < 64 || b.readUInt32BE(0) !== 0x7f454c46 || b[4] !== 2) return null;
  const shoff = Number(b.readBigUInt64LE(0x28)), shentsize = b.readUInt16LE(0x3a), shnum = b.readUInt16LE(0x3c);
  for (let i = 0; i < shnum; i++) {
    const o = shoff + i * shentsize;
    if (b.readUInt32LE(o + 4) !== 7) continue; // NOTE
    const off = Number(b.readBigUInt64LE(o + 24)), size = Number(b.readBigUInt64LE(o + 32));
    for (let p = off; p + 12 <= off + size;) {
      const namesz = b.readUInt32LE(p), descsz = b.readUInt32LE(p + 4), type = b.readUInt32LE(p + 8);
      const desc = p + 12 + ((namesz + 3) & ~3);
      if (type === 3 && b.toString('latin1', p + 12, p + 15) === 'GNU') return b.toString('hex', desc, desc + descsz);
      p = desc + ((descsz + 3) & ~3);
    }
  }
  return null;
}
/**
 * With --debuginfod [URL]: a library's separate debug file (static functions
 * too), fetched once by build id into DIR/dbg (Debian's: debuginfod.debian.net)
 */
function debugFile(lib) {
  if (!debuginfod) return null;
  const id = buildId(join(dir, 'libs', lib));
  if (!id) return null;
  const dbg = join(dir, 'dbg', `${id}.debug`);
  if (!existsSync(dbg) && !existsSync(dbg + '.none')) {
    mkdirSync(join(dir, 'dbg'), { recursive: true });
    try { execFileSync('curl', ['-fsSL', '--max-time', '300', '-o', dbg, `${debuginfod}/buildid/${id}/debuginfo`], { stdio: 'ignore' }); } catch { writeFileSync(dbg + '.none', ''); }
  }
  return existsSync(dbg) ? dbg : null;
}
const symCache = new Map();
function symAt(lib, off) {
  if (!symCache.has(lib)) {
    const dbg = debugFile(lib);
    const own = elfSymbols(join(dir, 'libs', lib));
    const more = dbg ? elfSymbols(dbg) : [];
    symCache.set(lib, more.length > own.length ? more : own);
  }
  const s = symCache.get(lib);
  let lo = 0, hi = s.length - 1, best = null;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (s[mid].start <= off) { best = s[mid]; lo = mid + 1; } else hi = mid - 1; }
  if (!best) return `+0x${off.toString(16)}`;
  return off < best.start + Math.max(best.size, 1) ? best.name : `~${best.name}`;
}

/** Library ranges of a process from LD_DEBUG=files output */
function ldRanges(file) {
  if (!existsSync(file)) return [];
  const t = readFileSync(file, 'utf8');
  const out = [];
  const re = /file=(\S+) \[\d+\];\s+generating link map\s*\n\s*\d+:\s+dynamic: (0x[0-9a-f]+)\s+base: (0x[0-9a-f]+)\s+size: (0x[0-9a-f]+)/g;
  for (const m of t.matchAll(re)) out.push({ lib: m[1].split('/').pop(), base: Number(m[3]), end: Number(m[3]) + Number(m[4]) });
  // ld.so itself isn't listed: Blink loads the ELF interpreter at this base
  out.push({ lib: 'ld-linux-x86-64.so.2', base: 0x87000000, end: 0x87040000 });
  return out;
}

/** The last report in a profile file: threads' totals and the two address tables */
function parseProfile(text) {
  const at = text.lastIndexOf('\npid ');
  const last = at < 0 ? text : text.slice(at + 1);
  const lines = last.split('\n');
  const h = /^pid (\d+) \(([^)]*)\) wall ([\d.]+) ms: jit ([\d.]+) ms in (\d+) compiles, syscalls ([\d.]+) ms, rest \(running guest code\) (-?[\d.]+) ms/.exec(lines[0]);
  let runMs = 0, compiledMs = 0, interpreted = 0, gilWaitMs = 0, threads = 0;
  const th = lines.findIndex((l) => /^thread\s+run ms/.test(l));
  if (th >= 0) for (let i = th + 1; i < lines.length && /^\s*\d+\s/.test(lines[i]); i++) {
    const c = lines[i].trim().split(/\s+/).map(Number);
    threads++; runMs += c[1]; gilWaitMs += c[2]; interpreted += c[6]; compiledMs += Math.min(c[c.length - 1], c[1]);
  }
  const table = (headRe) => {
    const out = [];
    const i0 = lines.findIndex((l) => headRe.test(l));
    if (i0 < 0) return out;
    for (let i = i0 + 1; i < lines.length; i++) {
      const m = /^\s*(0x[0-9a-f]+)\s+(\d+)/.exec(lines[i]);
      if (!m) { if (/^\S/.test(lines[i]) || !lines[i].trim()) break; continue; }
      out.push([Number(m[1]), Number(m[2])]);
    }
    return out;
  };
  const why = /interpreted because: (\d+) not at a branch target, (\d+) first visit, (\d+) below the compile threshold/.exec(last);
  return {
    pid: h ? +h[1] : 0, wallMs: h ? +h[3] : 0, jitMs: h ? +h[4] : 0, compiles: h ? +h[5] : 0, syscallMs: h ? +h[6] : 0,
    threads, runMs, compiledMs, gilWaitMs, interpreted,
    compiledInsns: Number(/guest instructions run in compiled code: (\d+)/.exec(last)?.[1] ?? 0),
    why: why ? { notBranchTarget: +why[1], firstVisit: +why[2], belowThreshold: +why[3] } : null,
    compiled: table(/^guest instructions run in compiled code/),
    interp: table(/^most interpreted addresses/),
  };
}

const report = {};
for (const app of apps) {
  const d = join(dir, app);
  const procs = readdirSync(d).filter((f) => /^\d+\.txt$/.test(f)).map((f) => parseProfile(readFileSync(join(d, f), 'utf8'))).filter((p) => p.pid);
  const libs = {}, funcs = {};
  let compiledInsns = 0, interpInsns = 0;
  const tot = { wallMs: 0, runMs: 0, compiledMs: 0, jitMs: 0, compiles: 0, interpreted: 0, compiledInsns: 0, gilWaitMs: 0, threads: 0, notBranchTarget: 0, belowThreshold: 0 };
  for (const p of procs) {
    const ranges = ldRanges(join(d, `ld.${p.pid}`));
    for (const k of ['runMs', 'compiledMs', 'jitMs', 'compiles', 'interpreted', 'compiledInsns', 'gilWaitMs', 'threads']) tot[k] += p[k];
    tot.wallMs = Math.max(tot.wallMs, p.wallMs);
    tot.notBranchTarget += p.why?.notBranchTarget ?? 0;
    tot.belowThreshold += p.why?.belowThreshold ?? 0;
    const add = (rows, kind) => {
      for (const [pc, n] of rows) {
        const r = ranges.find((x) => pc >= x.base && pc < x.end);
        const lib = r ? r.lib : (pc < 0x10000000 ? app : 'unmapped');
        const fn = r ? symAt(r.lib, pc - r.base) : (lib === app ? symAt(app.replace(/^gimp$/, 'gimp-2.10'), pc) : `0x${pc.toString(16)}`);
        const L = (libs[lib] ??= { compiled: 0, interp: 0 });
        L[kind] += n;
        const F = (funcs[`${lib} ${fn}`] ??= { compiled: 0, interp: 0 });
        F[kind] += n;
        if (kind === 'compiled') compiledInsns += n; else interpInsns += n;
      }
    };
    add(p.compiled, 'compiled');
    add(p.interp, 'interp');
  }
  // instructions: compiled ones are counted exactly per region; the interpreted table is the top addresses, scaled to the threads' total
  const scale = interpInsns ? tot.interpreted / interpInsns : 0;
  const all = compiledInsns + tot.interpreted;
  const row = ([k, v]) => ({ name: k, compiled: v.compiled, interpreted: Math.round(v.interp * scale), share: +(((v.compiled + v.interp * scale) / all) * 100).toFixed(1) });
  const byShare = (a, b) => b.share - a.share || b.compiled - a.compiled;
  report[app] = { processes: procs.length, ...tot, libs: Object.entries(libs).map(row).sort(byShare), funcs: Object.entries(funcs).map(row).sort(byShare).slice(0, TOP) };
}

const M = (n) => (n / 1e6).toFixed(n < 9.95e6 ? 1 : 0);
for (const [app, r] of Object.entries(report)) {
  console.log(`\n## ${app}: ${r.processes} process(es), ${r.threads} threads; ran ${Math.round(r.runMs)} ms: ${Math.round(r.compiledMs)} ms in compiled code (${M(r.compiledInsns)} M instructions; ${Math.round(r.jitMs)} ms of it compiling ${r.compiles} regions), ${M(r.interpreted)} M instructions interpreted (${M(r.notBranchTarget)} M not at a branch target, ${M(r.belowThreshold)} M below the threshold); ${Math.round(r.gilWaitMs)} ms waiting for the engine lock\n`);
  console.log('| Library | Instructions (M) | interpreted (M) | Share |\n|---|---:|---:|---:|');
  for (const l of r.libs.slice(0, TOP)) console.log(`| ${l.name} | ${M(l.compiled + l.interpreted)} | ${M(l.interpreted)} | ${l.share}% |`);
  console.log('\n| Function | Instructions (M) | Share |\n|---|---:|---:|');
  for (const f of r.funcs) console.log(`| ${f.name} | ${M(f.compiled + f.interpreted)} | ${f.share}% |`);
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(report, null, 1));
