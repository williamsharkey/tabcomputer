#!/usr/bin/env node
// Kernel profile of native Claude Code (linux-x64-musl in Blink) in headless
// Chromium: the syscalls and kernel paths it spends time in while it starts
// and while it echoes keystrokes (src/kernel/profiler.ts, `strace -c`).
//   npm run build && node bench/claude-profile.mjs [--keys 20] [--out file.json] [--cpu-profile dir]
// Needs bench/.cache/fixtures/claude-native and ld-musl-x86_64.so.1
// (bench/README.md). Phases:
//   startup: `claude` typed at the prompt → its input box on the screen
//   idle:    --idle MS (default 5000) with no input
//   keys:    N printable keystrokes, each typed once the last one is drawn
// Prints each phase's report (formatReport) and the screen-side keystroke
// latency (page keypress → the character on xterm's screen).
// --cpu-profile DIR also saves the page's main-thread CPU profile of each
// phase (.cpuprofile, open in Chrome DevTools): the kernel's own JS cost.
import { Harness } from './lib/harness.mjs';
import { NetCache } from './lib/netcache.mjs';
import { startShiroServer, startTcpTestServer, hostAddress } from './lib/servers.mjs';
import { prepareFixtures } from './lib/fixtures.mjs';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { join } from 'node:path';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const nKeys = Number(opt('--keys', 20));
const out = opt('--out');
const cpuDir = opt('--cpu-profile');
const readyRe = new RegExp(opt('--ready', '^❯ |shift\\+tab to cycle|\\? for shortcuts'), 'm');
const startupTimeout = Number(opt('--timeout', 600)) * 1000;
const claudeCmd = opt('--cmd', 'claude');

if (!existsSync('bench/.cache/fixtures/claude-native') || !existsSync('bench/.cache/fixtures/ld-musl-x86_64.so.1')) {
  console.error('put the linux-x64-musl claude at bench/.cache/fixtures/claude-native and musl\'s loader at bench/.cache/fixtures/ld-musl-x86_64.so.1 (bench/README.md)');
  process.exit(2);
}
prepareFixtures({ cacheDir: 'bench/.cache', publishDir: 'dist/__bench' });
const tcp = await startTcpTestServer();
// A stand-in for api.anthropic.com over the TCP relay (plain HTTP): 200 to
// everything, so startup's connectivity and bootstrap calls finish at once
// instead of waiting on DNS that the bench page can't do
const api = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}'); });
});
await new Promise((r) => api.listen(0, '0.0.0.0', r));
const apiUrl = `http://${hostAddress()}:${api.address().port}`;
const server = await startShiroServer({ staticDir: join(process.cwd(), 'dist'), isolated: true, tcpPorts: [...Object.values(tcp.ports), api.address().port], allowCidrs: [hostAddress() + '/32'], log: null });
const log = (s) => console.log(s);
const h = new Harness({ mode: 'isolated', origin: server.origin, netcache: new NetCache('bench/.cache/net', { log: () => {} }), runs: 1, log, results: [] });
const result = { date: new Date().toISOString(), phases: {} };
try {
  await h.launch();
  await h.boot({ path: '/?ui=terminal' });
  const page = h.page;
  await h.eval(async () => {
    await window.__bench.fetchInto('/__bench/claude-native', '/home/user/.local/bin/claude');
    await window.__bench.fetchInto('/__bench/ld-musl-x86_64.so.1', '/lib/ld-musl-x86_64.so.1');
  });
  const screen = () => page.evaluate(() => {
    const t = window.__tabcomputer.terminal.term, b = t.buffer.active, rows = [];
    for (let y = 0; y < t.rows; y++) rows.push(b.getLine(b.viewportY + y)?.translateToString(true) ?? '');
    return rows.join('\n');
  });
  const until = async (cond, what, ms) => {
    const t0 = Date.now();
    for (;;) {
      const s = await screen();
      if (cond(s)) return Date.now() - t0;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}\n${s}`);
      await page.waitForTimeout(25);
    }
  };
  const cpu = async (phase, fn) => {
    if (!cpuDir) return fn();
    await h.cdp.send('Profiler.enable');
    await h.cdp.send('Profiler.setSamplingInterval', { interval: 200 });
    await h.cdp.send('Profiler.start');
    try { return await fn(); } finally {
      const { profile } = await h.cdp.send('Profiler.stop');
      mkdirSync(cpuDir, { recursive: true });
      writeFileSync(join(cpuDir, `${phase}.cpuprofile`), JSON.stringify(profile));
      log(`(main-thread CPU profile: ${join(cpuDir, `${phase}.cpuprofile`)})`);
    }
  };
  const startProfile = () => page.evaluate(() => { window.__tabcomputer.kernel.startProfile({ bucketMs: 1000 }); });
  const report = () => page.evaluate(() => {
    const k = window.__tabcomputer.kernel;
    const p = k.profiler;
    k.stopProfile(p);
    return { r: p.report(100), text: p.format(30) };
  });

  await page.evaluate(() => window.__tabcomputer.terminal.term.focus());
  // Signed in with an API key, onboarding and the folder's trust done
  const key = 'sk-ant-api03-bench-not-a-real-key-0000000000';
  await h.eval(async ({ key }) => {
    const fs = window.__tabcomputer.fs;
    const path = '/home/user/.claude.json';
    let c = {};
    try { c = JSON.parse(await fs.readFile(path, 'utf8')); } catch {}
    Object.assign(c, { hasCompletedOnboarding: true, theme: c.theme ?? 'dark', bypassPermissionsModeAccepted: true,
      customApiKeyResponses: { approved: [key.slice(-20)], rejected: [] } });
    c.projects = { ...c.projects, '/home/user': { ...(c.projects?.['/home/user'] ?? {}), hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } };
    await fs.writeFile(path, JSON.stringify(c, null, 2));
  }, { key });
  await page.keyboard.type(`export ANTHROPIC_API_KEY=${key} ANTHROPIC_BASE_URL=${apiUrl} DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1; clear`, { delay: 5 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);

  // ── startup ──
  await startProfile();
  const t0 = Date.now();
  await cpu('startup', async () => {
    await page.keyboard.type(claudeCmd, { delay: 5 });
    await page.keyboard.press('Enter');
    await until((s) => readyRe.test(s.split('\n').slice(2).join('\n')) && !s.includes(`$ ${claudeCmd}\n`) || /Do you want to use this API key|Choose the text style|trust the files|Unable to connect/.test(s), 'claude\'s input box', startupTimeout);
    if (/Unable to connect/.test(await screen())) throw new Error(`claude quit at startup:\n${await screen()}`);
    // first-run questions: take the defaults
    for (let i = 0; i < 4; i++) {
      const s = await screen();
      if (/Do you want to use this API key/.test(s)) { await page.keyboard.press('ArrowUp'); await page.keyboard.press('Enter'); }
      else if (/Choose the text style|trust the files|Press Enter to continue/.test(s)) await page.keyboard.press('Enter');
      else break;
      await page.waitForTimeout(2000);
    }
  });
  const startupMs = Date.now() - t0;
  let rep = await report();
  log(`\n=== startup: ${(startupMs / 1000).toFixed(1)} s to the input box ===\n${rep.text}`);
  log(await screen());
  result.phases.startup = { ms: startupMs, report: rep.r };
  // let the startup's background work settle
  await page.waitForTimeout(Number(opt('--settle', 5000)));

  // ── idle: what it does with no input (timers, file polling) ──
  const idleMs = Number(opt('--idle', 5000));
  if (idleMs > 0) {
    await startProfile();
    await page.waitForTimeout(idleMs);
    rep = await report();
    log(`\n=== idle ${(idleMs / 1000).toFixed(1)} s ===\n${rep.text}`);
    result.phases.idle = { ms: idleMs, report: rep.r };
  }

  // ── keystrokes ──
  await startProfile();
  const word = 'the quick brown fox jumps over the lazy dog '.repeat(4);
  const lat = [];
  await cpu('keys', async () => {
    let typed = '';
    for (let i = 0; i < nKeys; i++) {
      const c = word[i];
      typed += c;
      const want = typed.trimEnd();
      const k0 = Date.now();
      await page.keyboard.type(c);
      await until((s) => s.split('\n').some((l) => l.startsWith('❯') && l.slice(1).trim() === want), `"${want}" in the input box`, 60_000);
      lat.push(Date.now() - k0);
    }
  });
  rep = await report();
  const sorted = [...lat].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1], p90 = sorted[Math.floor(sorted.length * 0.9)];
  log(`\n=== ${nKeys} keystrokes: keypress → drawn median ${med} ms, p90 ${p90} ms (screen polled every 25 ms) ===\n${rep.text}`);
  result.phases.keys = { latencyMs: lat, median: med, p90, report: rep.r };
  if (out) { writeFileSync(out, JSON.stringify(result, null, 1) + '\n'); log(`(report: ${out})`); }
} finally {
  await h.close();
  await server.close();
  await tcp.close();
  api.close();
}
