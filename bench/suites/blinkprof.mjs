// Where Blink's time goes, by library (opt-in: --suites blinkprof; isolated only).
// For perf-blink's zlib/xz thunk decision: each workload runs once in a fresh
// Debian with SHIRO_BLINK_PROFILE=/tmp/prof/%p.txt (Blink 0143+: one file per
// process, every compiled region listed) and glibc's LD_DEBUG=files (each
// library's base, per process), timed end to end. The raw files go to
// bench/.cache/blinkprof/<workload>/ with the guest's libraries, and
// bench/blinkprof-report.mjs buckets them (libz, liblzma, libc mem*/str*, ...).
// Workloads: apt-get update; dpkg --unpack of linux-perf and
// gcc-14-x86-64-linux-gnu (.xz); git clone of a tmux mirror (git:// through
// the TCP relay to this machine's git daemon); native Claude Code to its prompt.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const name = 'blinkprof';
export const ownPages = true;

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', '.cache', 'blinkprof');
// exported, and through `sudo -E`: tabcomputer's sudo drops a plain prefix (and `sudo env X=…`)
const VARS = 'SHIRO_BLINK_PROFILE=/tmp/prof/%p.txt SHIRO_BLINK_PROFILE_REGIONS=100000 SHIRO_BLINK_PROFILE_TOP=5000';
const PROF = `export ${VARS} LD_DEBUG=files LD_DEBUG_OUTPUT=/tmp/prof/ld DEBIAN_FRONTEND=noninteractive PATH=$PATH:/usr/sbin:/sbin;`;
const APT = 'sudo -E apt-get';
const LIBS = ['/usr/lib/x86_64-linux-gnu/libz.so.1', '/usr/lib/x86_64-linux-gnu/liblzma.so.5', '/usr/lib/x86_64-linux-gnu/libc.so.6', '/lib/ld-musl-x86_64.so.1'];

/** A shell command with a limit; { code, ms, out }. */
async function shRun(h, cmd, limitS) {
  const r = await h.eval(([c, ms]) => window.__bench.shLimit(c, ms), [`${cmd} > /tmp/bp.out 2>&1`, limitS * 1000]);
  const out = (await h.sh('cat /tmp/bp.out')).out;
  if (r.code !== 0) throw new Error(`${cmd.slice(0, 80)}: ${r.code === 124 ? `timed out after ${limitS} s` : `exit ${r.code}`}: ${out.trim().split('\n').slice(-3).join(' | ').slice(0, 300)}`);
  return { ms: r.ms, out };
}

/** Copies a guest file to `dest` (binary-safe). */
async function pull(h, path, dest) {
  const b64 = await h.eval(async (p) => {
    const d = await window.__tabcomputer.fs.readFile(p);
    const u = typeof d === 'string' ? new TextEncoder().encode(d) : d;
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
    return btoa(s);
  }, path).catch(() => null);
  if (b64 == null) return false;
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(b64, 'base64'));
  return true;
}

/** Runs `cmd` profiled, then copies /tmp/prof/* out to OUT/<label>/; returns its wall ms. */
async function profiled(h, label, cmd, limitS) {
  await h.sh('rm -rf /tmp/prof && mkdir -p /tmp/prof');
  const r = await shRun(h, `${PROF} ${cmd}`, limitS);
  const dir = join(OUT, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = (await h.sh('ls /tmp/prof')).out.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
  for (const f of files) await pull(h, `/tmp/prof/${f}`, join(dir, f));
  writeFileSync(join(dir, 'wall.json'), JSON.stringify({ cmd, wallMs: r.ms, files: files.length }));
  h.log(`    ${label}: ${Math.round(r.ms)} ms, ${files.length} files`);
  if (!files.some((f) => /^\d+\.txt$/.test(f))) throw new Error(`${label}: no profile files (did the variables reach Blink?)`);
  return r.ms;
}

export async function run(h) {
  if (!h.isolated) { h.skip('blinkprof.suite', '', 'Blink needs a cross-origin isolated page'); return; }
  const W = {};
  await h.try('blinkprof.setup', '', async () => {
    await h.page?.context().close().catch(() => {});
    await h.boot({ path: '/?ui=terminal' });
    await shRun(h, 'debian install', 600);
    // untimed: the indexes the profiled update refreshes, and the tools
    await shRun(h, `export DEBIAN_FRONTEND=noninteractive; ${APT} update`, 1800);
    await shRun(h, `export DEBIAN_FRONTEND=noninteractive; ${APT} install -y git`, 1800);
    await shRun(h, `mkdir -p /tmp/debs && cd /tmp/debs && apt-get download linux-perf gcc-14-x86-64-linux-gnu`, 1800);
    for (const l of LIBS) await pull(h, l, join(OUT, 'libs', l.split('/').pop()));
    // apt-get update again from scratch: drop the lists so it fetches and decompresses them all
    await shRun(h, 'sudo rm -rf /var/lib/apt/lists/*', 300);
    W.apt_update = await profiled(h, 'apt_update', `${APT} update`, 1800);
    W.dpkg_linux_perf = await profiled(h, 'dpkg_linux_perf', 'cd /tmp/debs && sudo -E dpkg --unpack linux-perf_*.deb', 1800);
    W.dpkg_gcc = await profiled(h, 'dpkg_gcc', 'cd /tmp/debs && sudo -E dpkg --unpack gcc-14-x86-64-linux-gnu_*.deb', 1800);
    const g = h.gitServer;
    if (g) W.git_clone = await profiled(h, 'git_clone', `cd /tmp && rm -rf tmux && git clone -q git://${g.host}:${g.port}/tmux.git tmux`, 1800);
    else h.skip('blinkprof.git_clone', '', 'no git daemon');
  });
  await h.try('blinkprof.claude', '', async () => {
    if (!h.fixtures['claude-native']) { h.skip('blinkprof.claude', '', 'no native Claude fixture'); return; }
    await h.eval(async () => {
      await window.__bench.fetchInto('/__bench/claude-native', '/home/user/.local/bin/claude');
      await window.__bench.fetchInto('/__bench/ld-musl-x86_64.so.1', '/lib/ld-musl-x86_64.so.1');
    });
    // the profile is written when Claude first reads its terminal (its prompt is up), and at exit
    await h.sh('rm -rf /tmp/prof && mkdir -p /tmp/prof && mkdir -p ~/w');
    const t0 = Date.now();
    await h.eval((c) => window.__tabcomputer.terminal.term.input(c, true), `cd ~/w && export ${VARS}; ANTHROPIC_API_KEY=sk-ant-api03-bench-not-a-real-key-000000000000000000000000 DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 claude --native\r`);
    for (;;) {
      // Claude's prompt on screen: its profile was written at that first terminal read
      const screen = await h.eval(() => { const b = window.__tabcomputer.terminal.term.buffer.active; const r = []; for (let y = b.viewportY; y < b.viewportY + 40; y++) r.push(b.getLine(y)?.translateToString(true) ?? ''); return r.join('\n'); });
      if (/for shortcuts|\? for|shift\+tab to cycle/.test(screen)) break;
      if (Date.now() - t0 > 600000) throw new Error('no profile from claude in 600 s');
      await h.page.waitForTimeout(500);
    }
    W.claude_start = Date.now() - t0;
    await h.page.waitForTimeout(2000);
    const dir = join(OUT, 'claude_start');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const files = (await h.sh('ls /tmp/prof')).out.split(/\r?\n/).map((f) => f.trim()).filter(Boolean);
    for (const f of files) await pull(h, `/tmp/prof/${f}`, join(dir, f));
    writeFileSync(join(dir, 'wall.json'), JSON.stringify({ cmd: 'claude --native → its first terminal read (prompt)', wallMs: W.claude_start, files: files.length }));
  });
  for (const [k, ms] of Object.entries(W)) h.sample(`blinkprof.${k}`, [ms], 'ms', { notes: `end to end, profiled (raw files in bench/.cache/blinkprof/${k}; bench/blinkprof-report.mjs buckets them)` });
}
