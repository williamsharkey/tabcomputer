// Debian's own `perf bench` (linux-perf) in Blink, so tabcomputer's numbers
// line up with published ones (WSL, bare metal: docs/BENCHMARKS.md
// "tabcomputer vs native"). Opt-in, `--suites perfbench --modes isolated`:
// `debian install` + `apt-get install linux-perf` take ~8 min on a fresh
// profile (packages from server.mjs's mirror cache after the first run).
// pbench (the x86 suite's x86.blink.* rows) measures the same things in
// --quick without Debian.
export const name = 'perfbench';
export const ownPages = true;

// [metric, perf bench arguments, unit, value from perf's output, what it measures]
const ROWS = [
  ['syscall_basic', 'syscall basic -l 2000', 'µs', /([\d.]+) usecs\/op/, 'getppid() round trip'],
  ['sched_pipe', 'sched pipe -l 300', 'µs', /([\d.]+) usecs\/op/, 'two processes ping-ponging over two pipes, per round trip'],
  ['mem_memcpy', 'mem memcpy -f default -s 32MB -l 4', 'GB/s', /([\d.]+) ([KMG])B\/sec/, "glibc memcpy (perf's `default` function), 32 MB"],
  ['sched_messaging', 'sched messaging -p -g 1 -l 20', 's', /Total time: ([\d.]+) \[sec\]/, 'hackbench: 1 group of 20 senders × 20 receivers (processes, pipes), 20 loops; total'],
];

async function sh(h, cmd, limitS) {
  return h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [`${cmd} < /dev/null > /tmp/perf.out 2>&1; echo "exit=$?"`, limitS * 1000])
    .then(async (r) => ({ code: r.code === 124 ? 124 : Number(/exit=(\d+)/.exec(r.out)?.[1] ?? -1), ms: r.ms, out: (await h.sh('cat /tmp/perf.out')).out }));
}

export async function run(h) {
  if (!h.isolated) { h.skip('perf.suite', '', 'Blink needs a cross-origin isolated page'); return; }
  await h.page?.context().close().catch(() => {});
  await h.boot({ path: '/?ui=terminal' });
  const setup = [['debian install', 300], ['sudo apt-get update', 1800], ['sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends linux-perf', 3600]];
  for (const [cmd, limit] of setup) {
    const r = await sh(h, cmd, limit);
    if (r.code !== 0) { h.skip('perf.suite', '', `${cmd}: exit ${r.code}: ${r.out.trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`); return; }
  }
  const version = (await sh(h, 'perf --version', 60)).out.trim();
  for (const [metric, args, unit, re, what] of ROWS) {
    const nm = `perf.blink.${metric}`;
    await h.try(nm, unit, async () => {
      const res = [];
      for (let i = 0; i < h.runs; i++) {
        const r = await sh(h, `perf bench ${args}`, 300);
        const m = re.exec(r.out);
        if (r.code !== 0 || !m) throw new Error(`${r.code === 124 ? 'timed out' : `exit ${r.code}`}: ${r.out.trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''}`);
        // perf picks the prefix by size (561 MB/sec, 1.25 GB/sec): a second group is it, scaled to GB
        res.push(Number(m[1]) * (m[2] ? { K: 1e-6, M: 1e-3, G: 1 }[m[2]] : 1));
      }
      h.sample(nm, res, unit, { notes: `\`perf bench ${args}\` (${version}) in Blink: ${what}` });
    });
  }
}
