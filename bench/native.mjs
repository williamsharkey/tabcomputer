#!/usr/bin/env node
// The native reference rows on their own, for any Linux machine (WSL included):
// builds pbench with gcc -static and runs the same rows as the x86 suite's
// x86.native.* (no browser, no repository build).
//   node bench/native.mjs [--runs N] [--label wsl2] [--out file.json]
// Prints a markdown table; --out also writes the samples (bench/results/ format).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { summarize, round } from './lib/stats.mjs';
import { nativePbench } from './suites/x86.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const runs = Number(opt('--runs', 5));
const label = opt('--label', os.hostname());

const tmp = mkdtempSync(join(os.tmpdir(), 'pbench-'));
const bin = join(tmp, 'pbench');
try {
  execFileSync('gcc', ['-O2', '-static', '-o', bin, join(ROOT, 'tests/tests/shiro-vitest/fixtures/x86/pbench.c')], { stdio: 'inherit' });
  const results = [];
  const h = {
    fixtures: { pbench: bin }, runs, quick: false, wants: () => true,
    sample(name, samples, unit, { notes = '' } = {}) {
      const s = summarize(samples);
      results.push({ name, suite: 'x86', mode: 'native', unit, median: round(s.median), p90: round(s.p90), n: s.n, samples: samples.map((x) => round(x)), notes });
    },
    skip(name, unit, notes) { results.push({ name, unit, median: null, notes, error: true }); },
  };
  nativePbench(h);
  const cpu = os.cpus();
  console.log(`\n${label}: ${cpu[0]?.model} × ${cpu.length}, ${os.type()} ${os.release()}, ${runs} runs\n`);
  console.log('| metric | median | p90 |\n|---|---:|---:|');
  for (const r of results) console.log(`| ${r.name} | ${r.median ?? 'failed'} ${r.unit} | ${r.p90 ?? ''} |`);
  const out = opt('--out');
  if (out) writeFileSync(out, JSON.stringify({ env: { label, date: new Date().toISOString(), cpu: { model: cpu[0]?.model, count: cpu.length }, os: `${os.type()} ${os.release()}` }, results }, null, 2) + '\n');
} finally { rmSync(tmp, { recursive: true, force: true }); }
