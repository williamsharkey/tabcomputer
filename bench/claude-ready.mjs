#!/usr/bin/env node
/**
 * Cold-cache timings for one origin (a local server of dist/, or a deployed site).
 *
 *   node bench/claude-ready.mjs [--origin URL] [--runs N]
 *
 * page_quiet_ms   desktop (/) from navigation until the dock is up, the page's
 *                 own resources have finished (the Claude layout download does
 *                 not count), and a second has passed since the last long task
 * claude_open_ms  terminal UI, fresh profile, from navigation until Claude's
 *                 prompt. `claude` is typed at the shell's first prompt
 * claude_cmd_ms   from that Enter until the prompt
 *
 * Prints one JSON object per run. Exits 1 if a run does not finish.
 */
import { chromium } from 'playwright-core';
import { existsSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const origin = (opt('--origin', 'http://127.0.0.1:5299')).replace(/\/+$/, '');
const runs = Number(opt('--runs', 1));
const chrome = process.env.CHROMIUM
  || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');

const CLAUDE_JSON = JSON.stringify({
  hasCompletedOnboarding: true, lastOnboardingVersion: '9.9.9', numStartups: 5,
  hasSeenTasksHint: true, tipsHistory: {}, theme: 'dark', bypassPermissionsModeAccepted: true,
  projects: { '/home/user': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } },
});

function pageQuiet() {
  const dock = document.querySelector('.sd-dock, .sd-desktop');
  if (!dock) return null;
  const own = performance.getEntriesByType('resource').filter((e) => !/claude-vm-layout|claude-releases/.test(e.name));
  if (own.some((e) => e.responseEnd === 0)) return null;
  const last = (window.__lt || []).reduce((m, t) => Math.max(m, t), 0);
  const nav = performance.getEntriesByType('navigation')[0];
  const now = performance.now();
  if (now - Math.max(last, nav?.domContentLoadedEventEnd || 0) < 1000) return null;
  return Math.round(now);
}

async function openClaude(json) {
  const fs = window.__tabcomputer.fs;
  await fs.mkdir('/home/user/.claude', { recursive: true }).catch(() => {});
  await fs.writeFile('/home/user/.claude.json', json);
  await fs.writeFile('/home/user/.claude/settings.json', '{"tui":"fullscreen"}');
  const t = window.__tabcomputer.terminal;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const screen = () => {
    const b = t.term.buffer.active;
    let s = '';
    for (let i = 0; i < b.length; i++) { const line = b.getLine(i); s += (line ? line.translateToString(true) : '') + '\n'; }
    return s;
  };
  const deadline = performance.now() + 180000;
  while (performance.now() < deadline) {
    const b = t.term.buffer.active;
    const line = b.getLine(b.baseY + b.cursorY);
    const text = line ? line.translateToString(false).slice(0, b.cursorX) : '';
    if (/\$ $/.test(text)) break;
    await sleep(20);
  }
  const shell = performance.now();
  t.injectInput('claude\r');
  const typed = performance.now();
  while (performance.now() < deadline) {
    if (/^\s*(❯|│ >|> )/m.test(screen())) return { shell: Math.round(shell), typed: Math.round(typed), prompt: Math.round(performance.now()) };
    await sleep(50);
  }
  return { shell: Math.round(shell), typed: Math.round(typed), prompt: null, screen: screen().slice(-1500) };
}

const browser = await chromium.launch({ executablePath: chrome, args: ['--no-sandbox'] });
for (let i = 0; i < runs; i++) {
  const desk = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await desk.addInitScript(() => {
    window.__lt = [];
    try {
      new PerformanceObserver((list) => {
        for (const e of list.getEntries()) window.__lt.push(e.startTime + e.duration);
      }).observe({ type: 'longtask', buffered: true });
    } catch { /* no long tasks */ }
  });
  const page = await desk.newPage();
  await page.goto(origin + '/', { waitUntil: 'commit' });
  const pageMs = await page.waitForFunction(pageQuiet, null, { timeout: 120000, polling: 100 }).then((h) => h.jsonValue()).catch(() => null);
  await desk.close();

  const term = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const tp = await term.newPage();
  await tp.goto(origin + '/?ui=terminal', { waitUntil: 'commit' });
  await tp.waitForFunction(() => window.__tabcomputer && window.__tabcomputer.terminal && window.__tabcomputer.fs, null, { timeout: 120000 });
  const claude = await tp.evaluate(openClaude, CLAUDE_JSON);
  await term.close();
  const row = {
    run: i,
    page_quiet_ms: pageMs,
    claude_open_ms: claude && claude.prompt,
    claude_cmd_ms: claude && claude.prompt != null ? claude.prompt - claude.typed : null,
    shell_ms: claude && claude.shell,
  };
  console.log(JSON.stringify(row));
  if (claude && claude.screen) console.error(claude.screen);
  if (row.page_quiet_ms == null || row.claude_open_ms == null) {
    await browser.close();
    process.exit(1);
  }
}
await browser.close();
