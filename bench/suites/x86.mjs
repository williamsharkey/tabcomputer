// x86-64 ELF: Blink (wasm, Worker kernel process) when isolated, src/x86
// (TS interpreter) otherwise or with TABCOMPUTER_X86_ENGINE=x86. Time and renderer
// RSS peak per program, run at the prompt via the shell (`./prog > file`).
import { execFileSync } from 'node:child_process';
import { MB } from '../lib/harness.mjs';

export const name = 'x86';

const PROGRAMS = [
  // [metric, fixture, args, expected output regexp]
  ['hello_musl', 'hello-musl', '', /hello/i],
  ['hello_glibc', 'hello-glibc', '', /hello/i],
  ['go_hello', 'hello-go', 'a b', /hello/i],
  ['go_cpuloop_5m', 'cpuloop', '5000000', /loop 5000000/],
  ['go_nethttp', 'nethttp', '', /pong/],
  ['gh_version', 'gh', '--version', /gh version/],
];
const FIXTURES = [...PROGRAMS.map(([, f]) => f), 'pbench'];

// perf-bench-style microbenchmarks (tests/tests/shiro-vitest/fixtures/x86/pbench.c),
// the same static binary in Blink and natively on this machine (the reference row).
// [metric, args, unit, value from pbench's key=values, in --quick, what it measures]
export const PBENCH = [
  ['syscall_rt', 'syscall', 'ns', (kv) => kv.ns_per_op, true, 'getppid() round trip (perf bench syscall basic)'],
  ['pipe_pingpong', 'pipe', 'µs', (kv) => kv.ns_per_op / 1e3, true, 'one byte each way between two processes over two pipes (perf bench sched pipe): wake-up cost'],
  ['messaging', 'messaging 1 10 50', 'µs', (kv) => kv.ns_per_op / 1e3, false, 'hackbench: 10 senders × 10 receivers (20 processes), 50 rounds of 100-byte pipe messages; µs per message (perf bench sched messaging -p -g 1 -l 50, fan-out of 10)'],
  ['memcpy_bw', 'memcpy 32 8', 'MB/s', (kv) => kv.MBps, true, 'glibc memcpy of a 32 MiB buffer, 8 copies after a warm-up copy (perf bench mem memcpy)'],
  ['fork_exec', 'forkexec', 'ms', (kv) => kv.ns_per_op / 1e6, true, 'fork + execv(pbench nop) + waitpid, static glibc binary'],
];
export const PBENCH_MS = 500;
export const kvOf = (out) => Object.fromEntries([...out.matchAll(/^(\w+)=([\d.]+)$/gm)].map((m) => [m[1], Number(m[2])]));

/** The pbench rows natively (no Blink, no browser): what this machine's Linux does. */
export function nativePbench(h) {
  const bin = h.fixtures.pbench;
  const taskset = (() => { try { execFileSync('taskset', ['-c', '0', 'true']); return true; } catch { return false; } })();
  for (const [metric, args, unit, value, quick, what] of PBENCH) {
    if (h.quick && !quick) continue;
    const nm = `x86.native.${metric}`;
    const variants = [[nm, [], '']];
    // one CPU: both processes on CPU 0, so a wake-up is a context switch, not an IPI to an idle CPU
    if (metric === 'pipe_pingpong' && taskset) variants.push([`x86.native.pipe_pingpong_1cpu`, ['taskset', '-c', '0'], ' Pinned to one CPU (taskset -c 0).']);
    for (const [name, pre, extra] of variants) {
      if (!h.wants(name)) continue;
      try {
        const res = [];
        for (let i = 0; i < h.runs; i++) {
          const argv = [...pre, bin, ...args.split(' ')];
          const out = execFileSync(argv[0], argv.slice(1), { encoding: 'utf8', env: { ...process.env, PBENCH_MS: String(PBENCH_MS) }, timeout: 60_000 });
          res.push(value(kvOf(out)));
        }
        h.sample(name, res, unit, { notes: `native reference: \`pbench ${args}\` on this machine's Linux, no emulator. ${what}.${extra}` });
      } catch (e) { h.skip(name, unit, `failed: ${String(e.message).split('\n')[0].slice(0, 160)}`); }
    }
  }
}

async function runOnce(h, cmd, limit = 60) {
  const line = `cd /home/user/x && ${cmd} < /dev/null > /tmp/x86.out 2>&1; echo "exit=$?"`;
  const r = await h.withPeakRss(() => h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [line, limit * 1000]));
  const out = await h.sh('cat /tmp/x86.out');
  const code = r.result.code === 124 ? 124 : Number(/exit=(\d+)/.exec(r.result.out)?.[1] ?? -1);
  return { ms: r.result.ms, peak: r.peakDelta / MB, base: r.baseRss, peakRss: r.peakRss, out: out.out, code };
}

/**
 * After a run: ms until the renderer gives back three quarters of what the
 * process added (its Workers and wasm memory torn down), up to 15 s. Also
 * keeps the next run's baseline from including this one's leftovers.
 */
async function releaseMs(h, run) {
  const t0 = performance.now();
  const target = run.base + (run.peakRss - run.base) / 4;
  while (performance.now() - t0 < 15_000) {
    if ((await h.rendererRss()) <= target) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  return performance.now() - t0;
}

export async function run(h) {
  const engines = h.isolated ? (h.quick ? [['blink', '']] : [['blink', ''], ['x86', 'TABCOMPUTER_X86_ENGINE=x86 ']]) : [['x86', '']];
  await h.eval(async (names) => {
    for (const n of names) await window.__bench.fetchInto('/__bench/' + n, '/home/user/x/' + n);
  }, FIXTURES.filter((f) => h.fixtures[f]));
  for (const [engine, prefix] of engines) {
    for (const [metric, fixture, args, expect] of PROGRAMS) {
      const nm = `x86.${engine}.${metric}`;
      if (!h.wants(nm)) continue;
      if (h.quick && !['hello_musl', 'go_hello', 'go_nethttp'].includes(metric)) continue;
      if (!h.fixtures[fixture]) { h.skip(nm, 'ms', `fixture ${fixture} unavailable (go/gcc missing, or skipped in --quick)`); continue; }
      // The interpreter can't run Go or glibc (see docs/X86_ENGINES.md); try once and record why
      const heavy = metric === 'gh_version';
      if (engine === 'x86' && heavy) { h.skip(nm, 'ms', 'not attempted on src/x86 (Go)'); continue; }
      await h.try(nm, 'ms', async () => {
        const cmd = `${prefix}./${fixture} ${args}`.trim();
        const limit = heavy ? 120 : 60;
        const first = await runOnce(h, cmd, limit);
        if (first.code !== 0 || !expect.test(first.out)) throw new Error(`${first.code === 124 ? `timed out after ${limit} s` : `exit ${first.code}`}: ${(first.out.match(/^.*(fatal error|Unknown|panic|error).*$/m)?.[0] ?? first.out.trim().split('\n').slice(-1)[0] ?? '').trim().slice(0, 160)}`);
        const runs = heavy ? Math.min(h.runs, 5) : h.runs;
        if (heavy) await releaseMs(h, first);
        const res = [];
        for (let i = 0; i < runs; i++) {
          const r = await runOnce(h, cmd, limit);
          if (r.code !== 0) throw new Error(`exit ${r.code} on run ${i + 2}`);
          if (heavy) r.release = await releaseMs(h, r);
          res.push(r);
        }
        const inproc = /(\d+)ms/.exec(first.out);
        h.sample(nm, res.map((r) => r.ms), 'ms', { notes: `\`${cmd}\` wall time at the prompt; first run ${Math.round(first.ms)} ms${metric.startsWith('go_cpuloop') && inproc ? `; in-guest loop ${inproc[1]} ms` : ''}` });
        h.sample(`x86.${engine}.peak_rss.${metric}`, res.map((r) => r.peak), 'MiB', { notes: 'renderer RSS peak above the pre-run level' });
        if (heavy) h.sample(`x86.${engine}.release_ms.${metric}`, res.map((r) => r.release), 'ms', { notes: 'after exit, until the renderer RSS gave back 3/4 of the peak (Workers and wasm memory freed)' });
      });
    }
  }

  // perf-bench-style rows: Blink (isolated only: Blink needs SAB), then the native reference
  // blink_direct: Blink patch 0065's direct channels (opt-in TABCOMPUTER_BLINK_DIRECT=1), kernel calls only
  if (h.isolated && h.fixtures.pbench) {
    const variants = [['blink', '', ''], ['blink_direct', 'TABCOMPUTER_BLINK_DIRECT=1 ', ' With direct channels (TABCOMPUTER_BLINK_DIRECT=1).']];
    for (const [engine, prefix, extra] of variants) for (const [metric, args, unit, value, quick, what] of PBENCH) {
      const nm = `x86.${engine}.${metric}`;
      if (h.quick && !quick) continue;
      if (engine === 'blink_direct' && (h.quick || metric === 'memcpy_bw')) continue;
      await h.try(nm, unit, async () => {
        const cmd = `${prefix}PBENCH_MS=${PBENCH_MS} ./pbench ${args}`;
        const first = await runOnce(h, cmd, 120);
        if (first.code !== 0 || !/ns_per_op=/.test(first.out)) throw new Error(`${first.code === 124 ? 'timed out after 120 s' : `exit ${first.code}`}: ${first.out.trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''}`);
        const res = [];
        let ops = 0;
        for (let i = 0; i < h.runs; i++) {
          const r = await runOnce(h, cmd, 120);
          if (r.code !== 0) throw new Error(`exit ${r.code} on run ${i + 2}: ${r.out.trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''}`);
          const kv = kvOf(r.out);
          ops = kv.ops;
          res.push(value(kv));
        }
        h.sample(nm, res, unit, { notes: `\`${cmd}\` in Blink, guest clock (${ops} ops in the last run). ${what}.${extra}` });
      });
    }
    nativePbench(h);
  } else if (h.isolated) {
    for (const [metric] of PBENCH) h.skip(`x86.blink.${metric}`, '', 'fixture pbench unavailable (gcc missing)');
  }

  // Vim's startup in Blink: sourcing defaults.vim (filetype.vim is most of it),
  // what the dock's Vim and `vi` pay before the first screen. A package, not a fixture.
  const vim = 'x86.blink.vim_defaults';
  if (h.isolated && !h.quick && h.wants(vim)) {
    await h.try(vim, 'ms', async () => {
      const inst = await h.eval((c) => window.__bench.shLimit(c, 120_000), 'pkg install vim > /dev/null 2>&1; echo "exit=$?"');
      if (!/exit=0/.test(inst.out)) throw new Error(`pkg install vim: ${inst.out.trim().slice(-160)}`);
      const cmd = `vim -es -c 'source $VIMRUNTIME/defaults.vim' -c q x.txt`;
      const first = await runOnce(h, cmd);
      if (first.code !== 0) throw new Error(`exit ${first.code}: ${first.out.trim().slice(-160)}`);
      const res = [];
      for (let i = 0; i < h.runs; i++) res.push(await runOnce(h, cmd));
      h.sample(vim, res.map((r) => r.ms), 'ms', { notes: `\`${cmd}\` wall time at the prompt; first run ${Math.round(first.ms)} ms` });
    });
  }

  // Vim 9.2 (static, from public/pkg) opening a C file: mostly its startup
  // scripts (defaults.vim: filetype.vim, syntax) run by Vim's interpreter
  const vimStart = 'x86.blink.vim_startup';
  if (h.isolated && h.wants(vimStart) && !h.quick) {
    await h.try(vimStart, 'ms', async () => {
      const inst = await h.sh('pkg install vim 2>&1');
      if (inst.code !== 0) throw new Error(`pkg install vim: ${inst.out.trim().split('\n').pop()}`);
      await h.sh('echo "int main(void) { return 0; }" > /home/user/x/x.c');
      const cmd = 'vim --not-a-term -c qa x.c';
      const first = await runOnce(h, cmd);
      if (first.code !== 0) throw new Error(`exit ${first.code}: ${first.out.trim().slice(-160)}`);
      const res = [];
      for (let i = 0; i < h.runs; i++) {
        const r = await runOnce(h, cmd);
        if (r.code !== 0) throw new Error(`exit ${r.code} on run ${i + 2}`);
        res.push(r);
      }
      h.sample(vimStart, res.map((r) => r.ms), 'ms', { notes: `\`${cmd}\` wall time at the prompt (Blink); first run ${Math.round(first.ms)} ms` });
      h.sample('x86.blink.peak_rss.vim_startup', res.map((r) => r.peak), 'MiB', { notes: 'renderer RSS peak above the pre-run level' });
    });
  }
}
