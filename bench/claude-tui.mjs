#!/usr/bin/env node
// Interactive Claude Code in the real terminal: cold start, keystroke echo
// latency and renderer memory, for the native build (Blink) and the npm build.
//   node bench/claude-tui.mjs [--build native|npm] [--runs N] [--keys N]
//        [--env 'K=V K2=V2'] [--args '...'] [--tui fullscreen|default]
//        [--settle S] [--binary FILE] [--out file.json] [--shot file.png]
// Each run is a fresh profile booted at /?ui=terminal. ~/.claude.json is
// preset (onboarding done, the home directory trusted) so the session goes
// straight to its prompt; there is no sign-in, so nothing reaches the API.
// Native needs bench/.cache/fixtures/{claude-native,ld-musl-x86_64.so.1}
// (bench/README.md); npm installs the pinned build from the net cache.
// Metrics:
//   first_screen  `claude` typed + Enter to Claude's first frame (the
//                 alternate screen, its header or its input box)
//   prompt        to Claude's input box (a line starting with its prompt mark;
//                 --prompt RE overrides)
//   key           one printable key injected as typed input to its echo in
//                 xterm's buffer (write-parsed), keys 150 ms apart
//   rss           renderer RSS (pages + workers) at the prompt
import { Harness, MB } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer, hostAddress } from './lib/servers.mjs';
import { prepareFixtures } from './lib/fixtures.mjs';
import { summarize, round } from './lib/stats.mjs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync, mkdirSync, copyFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const build = opt('--build', 'native');
const runs = Number(opt('--runs', 1));
const keys = Number(opt('--keys', 20));
const extraEnv = opt('--env', '');
const extraArgs = opt('--args', '');
const out = opt('--out');
const shot = opt('--shot');
const binary = opt('--binary'); // another linux-x64-musl build, e.g. bench/.cache/fixtures/claude-native-2.1.112
const tui = opt('--tui'); // fullscreen | default: Claude's renderer (settings.json `tui`)
const promptRe = new RegExp(opt('--prompt', '^\\s*(❯|│ >|> )'), 'm');
const TIMEOUT = Number(opt('--timeout', 300)) * 1000;
const log = (...a) => console.log(...a);

const fx = prepareFixtures({ cacheDir: join(ROOT, 'bench/.cache'), publishDir: join(ROOT, 'dist/__bench'), log });
if (binary) copyFileSync(binary, join(ROOT, 'dist/__bench/claude-native-alt'));
if (build === 'native' && !binary && !fx['claude-native']) { log('no bench/.cache/fixtures/claude-native (bench/README.md)'); process.exit(2); }
const server = await startShiroServer({ staticDir: join(ROOT, 'dist'), isolated: true, tcpPorts: [], allowCidrs: [hostAddress() + '/32'], log: process.env.BENCH_SERVER_LOG ? (l) => log('[server]', l) : null });
const results = [];
const h = new Harness({ mode: 'isolated', origin: server.origin, netcache: new NetCache(join(ROOT, 'bench/.cache/net'), { log: process.env.BENCH_VERBOSE ? log : () => {} }), runs, log, results });
await h.launch();

const CLAUDE_JSON = (home) => JSON.stringify({
  hasCompletedOnboarding: true, lastOnboardingVersion: '9.9.9', numStartups: 5,
  hasSeenTasksHint: true, tipsHistory: {}, theme: 'dark', bypassPermissionsModeAccepted: true,
  projects: { [home]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
});

// In the page: patch xterm's write so every parsed chunk can be checked, and helpers.
const SETUP = () => {
  const T = window.__tabcomputer.terminal;
  const term = T.term;
  const B = window.__claudeBench = { waiters: [], writes: 0 };
  const screen = () => {
    const b = term.buffer.active, rows = [];
    for (let y = 0; y < term.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    return rows.join('\n');
  };
  B.screen = screen;
  B.alt = () => term.buffer.active.type === 'alternate';
  const orig = term.write.bind(term);
  term.write = (data, cb) => orig(data, () => {
    B.writes++;
    if (B.waiters.length) {
      const now = performance.now();
      const s = screen();
      B.waiters = B.waiters.filter((w) => { if (w.test(s)) { w.resolve(now); return false; } return true; });
    }
    cb?.();
  });
  B.until = (test, ms) => new Promise((resolve, reject) => {
    if (test(screen())) return resolve(performance.now());
    const w = { test, resolve };
    B.waiters.push(w);
    setTimeout(() => { B.waiters = B.waiters.filter((x) => x !== w); reject(new Error('timeout')); }, ms);
  });
  B.inject = (d) => T.injectInput(d);
};

const M = { first_screen: [], prompt: [], key: [], key_p90: [], rss: [], heap: [] };
try {
  for (let run = 0; run < runs; run++) {
    await h.page?.context().close().catch(() => {});
    // npm: boot's background preinstall puts the build in place (not timed, and not run)
    await h.boot({ path: '/?ui=terminal', waitSettled: build === 'npm' });
    const home = '/home/user';
    await h.eval(async ({ build, json, home, tui, binary }) => {
      if (build === 'native') {
        await window.__bench.fetchInto(binary ? '/__bench/claude-native-alt' : '/__bench/claude-native', home + '/.local/bin/claude');
        await window.__bench.fetchInto('/__bench/ld-musl-x86_64.so.1', '/lib/ld-musl-x86_64.so.1');
      }
      await window.__tabcomputer.fs.writeFile(home + '/.claude.json', json);
      if (tui) {
        await window.__tabcomputer.fs.mkdir(home + '/.claude', { recursive: true }).catch(() => {});
        await window.__tabcomputer.fs.writeFile(home + '/.claude/settings.json', JSON.stringify({ tui }));
      }
    }, { build, json: CLAUDE_JSON(home), home, tui, binary: !!binary });
    await h.eval(SETUP);
    const cmd = `${extraEnv ? extraEnv + ' ' : ''}claude --${build}${extraArgs ? ' ' + extraArgs : ''}`;
    const rss0 = await h.rendererRss();
    const t = await h.eval(async ({ cmd, promptSrc, TIMEOUT }) => {
      const B = window.__claudeBench;
      const promptRe = new RegExp(promptSrc, 'm');
      window.__tabcomputer.terminal.term.clear();
      const t0 = performance.now();
      B.inject(cmd + '\r');
      // The alternate screen (fullscreen renderer), else Claude's header or input box
      const first = await B.until((s) => B.alt() || /Claude Code|^\s*(❯|│ >)/m.test(s), TIMEOUT);
      const prompt = await B.until((s) => promptRe.test(s), TIMEOUT).catch(() => null);
      return { first: first - t0, prompt: prompt == null ? null : prompt - t0 };
    }, { cmd, promptSrc: promptRe.source, TIMEOUT });
    if (t.prompt == null) {
      log(await h.eval(() => window.__claudeBench.screen()));
      throw new Error('no prompt within the timeout');
    }
    const m = await h.memory({ uasm: false });
    log(`run ${run}: first screen ${(t.first / 1000).toFixed(1)} s, prompt ${(t.prompt / 1000).toFixed(1)} s, rss ${(m.rendererRss / MB).toFixed(0)} MiB (+${((m.rendererRss - rss0) / MB).toFixed(0)}), heap ${(m.jsHeapUsed / MB).toFixed(0)} MiB`);
    M.first_screen.push(t.first); M.prompt.push(t.prompt); M.rss.push(m.rendererRss / MB); M.heap.push(m.jsHeapUsed / MB);
    // Let the startup burst die down a little, then type
    await h.page.waitForTimeout(Number(opt('--settle', 5)) * 1000);
    const lat = await h.eval(async ({ keys, promptSrc }) => {
      const B = window.__claudeBench;
      const promptRe = new RegExp(promptSrc);
      const text = 'thequickbrownfoxjumpsoverthelazydog'.repeat(4).slice(0, keys);
      const out = [];
      for (let i = 0; i < text.length; i++) {
        const want = text.slice(0, i + 1);
        const t0 = performance.now();
        B.inject(text[i]);
        // the input line itself (the screen may hold the same letters elsewhere)
        const t1 = await B.until((s) => s.split('\n').some((l) => promptRe.test(l) && l.replace(promptRe, '').trim().startsWith(want)), 30000).catch(() => null);
        out.push(t1 == null ? 30000 : t1 - t0);
        await new Promise((r) => setTimeout(r, 150));
      }
      return out;
    }, { keys, promptSrc: promptRe.source });
    const s = summarize(lat);
    log(`  keys: median ${s.median.toFixed(0)} ms, p90 ${s.p90.toFixed(0)} ms, max ${s.max.toFixed(0)} ms  [${lat.map((x) => x.toFixed(0)).join(' ')}]`);
    M.key.push(...lat); M.key_p90.push(s.p90);
    if (shot) await h.page.screenshot({ path: shot });
    await h.eval(() => { window.__claudeBench.inject('\x03'); setTimeout(() => window.__claudeBench.inject('\x03'), 300); });
    await h.page.waitForTimeout(1500);
  }
  const rec = (name, samples, unit, notes) => { const s = summarize(samples); results.push({ name, unit, median: round(s.median), p90: round(s.p90), min: round(s.min), max: round(s.max), n: s.n, samples: samples.map(round), notes }); };
  rec(`claude_tui.${build}.first_screen`, M.first_screen, 'ms', '`claude` + Enter to its first screen');
  rec(`claude_tui.${build}.prompt`, M.prompt, 'ms', 'to the input box');
  rec(`claude_tui.${build}.key`, M.key, 'ms', 'key to echo, all keys of all runs');
  rec(`claude_tui.${build}.rss`, M.rss, 'MiB', 'renderer RSS at the prompt');
  log('\n| metric | median | p90 | n |\n|---|---:|---:|---:|');
  for (const r of results) log(`| ${r.name} | ${r.median} ${r.unit} | ${r.p90} | ${r.n} |`);
  if (out) { mkdirSync(join(out, '..'), { recursive: true }); writeFileSync(out, JSON.stringify({ env: { build, binary, tui, extraEnv, extraArgs, date: new Date().toISOString() }, results }, null, 2) + '\n'); }
} catch (e) {
  log('FAILED:', e.message);
  if (h.page) await h.page.screenshot({ path: shot || 'bench/.cache/claude-tui-fail.png' }).catch(() => {});
  process.exitCode = 1;
} finally {
  await h.close(); await server.close();
}
