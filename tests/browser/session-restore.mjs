// Session restore on reload (src/desktop/session.ts, docs/DESKTOP.md "Layout after a reload"):
// two terminals (one cd'd somewhere with an exported variable and output, one
// running a command that isn't known-safe), an mdview window and a fake agent
// job (a `codex` on PATH that writes its session file) come back after a
// reload: directory, variable, scrollback and the separator, the command
// offered but not run, the window reopened, the agent resumed. Then the
// preference (Settings → Appearance) goes off and a reload restores nothing.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/session-restore.mjs [URL]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const url = process.argv[2] ?? 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const boot = async () => {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
};
const sh = (cmd) => page.evaluate(async (cmd) => {
  const s = window.__srShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
/** Every terminal: its window, cwd, a variable, what runs, and its screen */
const terminals = () => page.evaluate(() => window.__shiroDesktop.windows().filter((w) => typeof w.content?.activeTerminal === 'function').map((w) => {
  const t = w.content.activeTerminal();
  return { id: w.id, title: w.title, cwd: t?.shell.cwd, foo: t?.shell.env.FOO ?? null, running: t?.foregroundLine ?? null, screen: t?.getBufferContent() ?? '' };
}));
const type = (pred, text) => page.evaluate(([pred, text]) => {
  const w = window.__shiroDesktop.windows().find((w) => typeof w.content?.activeTerminal === 'function' && new Function('w', `return ${pred}`)(w));
  w.content.activeTerminal().injectInput(text);
}, [pred, text]);

try {
  await boot();
  // a fake Codex: writes today's session file, then runs until stopped
  const d = new Date();
  const day = `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
  const ID = '11111111-2222-3333-4444-555555555555';
  await sh(`mkdir -p /usr/local/bin && printf '%s\\n' '#!/bin/sh' 'mkdir -p ~/.codex/sessions/${day}' 'echo "{}" > ~/.codex/sessions/${day}/rollout-2026-01-01T00-00-00-${ID}.jsonl' 'echo "fake codex: $*"' 'sleep 600' > /usr/local/bin/codex && chmod +x /usr/local/bin/codex`);
  await sh('printf "# Notes\\n\\nhello\\n" > ~/n.md && mkdir -p ~/proj');

  // 1. the main terminal: cd, a variable, output
  await type("w.id === 'terminal'", 'cd /tmp && export FOO=bar && echo hello-main\r');
  // 2. a second terminal running a command that isn't known-safe
  await page.evaluate(() => window.__shiroDesktopCtx.openTerminal({ cwd: '/home/user/proj' }));
  await page.waitForTimeout(800);
  await type("w.id !== 'terminal' && !w.__used", 'echo second-output && sleep 300\r');
  await page.evaluate(() => { for (const w of window.__shiroDesktop.windows()) if (typeof w.content?.activeTerminal === 'function' && w.id !== 'terminal') w.__used = true; });
  // 3. an mdview window
  void sh('mdview ~/n.md');
  // 4. a terminal running the agent
  await page.evaluate(() => window.__shiroDesktopCtx.openTerminal({ cwd: '/home/user/proj' }));
  await page.waitForTimeout(800);
  await type('!w.__used', 'codex --sandbox danger-full-access\r');
  const tracked = await page.waitForFunction(() => {
    const ar = window.__tabcomputer.agentResume;
    return window.__shiroDesktop.windows().some((w) => w.content?.activeTerminal && ar?.forTerminal(w.content.activeTerminal()));
  }, null, { timeout: 30_000 }).then(() => true, () => false);
  check(tracked, 'the fake codex run is tracked (agent-resume finds its session file)');
  await page.waitForFunction(() => window.__shiroDesktop.windows().some((w) => w.appId === 'mdview'), null, { timeout: 15_000 }).catch(() => {});
  const before = await terminals();
  await page.waitForTimeout(4500); // a save (every 3 s while terminals print)

  // ── reload ──
  await boot();
  await page.waitForTimeout(3000);
  const after = await terminals();
  const main = after.find((t) => t.id === 'terminal');
  check(main && main.cwd === '/tmp' && main.foo === 'bar', `main terminal: its directory and variable (${main?.cwd}, FOO=${main?.foo})`);
  check(main && main.screen.includes('hello-main') && main.screen.includes('restored after reload'), 'main terminal: its scrollback, then the separator');
  const second = after.find((t) => t.screen.includes('second-output'));
  check(second && second.cwd === '/home/user/proj', `second terminal: back, in its directory (${second?.cwd})`);
  check(second && second.screen.includes('was running: echo second-output && sleep 300') && second.running === null,
    `its command is offered, not run (running: ${second?.running})`);
  const offered = await page.evaluate(() => {
    const w = window.__shiroDesktop.windows().find((w) => w.content?.activeTerminal?.()?.getBufferContent().includes('second-output'));
    return w?.content.activeTerminal().getBufferContent().trimEnd().split('\n').pop();
  });
  check(!!offered && offered.endsWith('$ echo second-output && sleep 300'), `…typed on its prompt line (“${offered}”)`);
  check(await page.evaluate(() => window.__shiroDesktop.windows().some((w) => w.appId === 'mdview')), 'the mdview window reopened');
  const agent = after.find((t) => t.screen.includes('resuming Codex'));
  check(!!agent && (agent.running ?? '').startsWith('codex resume') && agent.running.includes(ID), `the agent resumes its session (${agent?.running})`);
  check(after.length === before.length, `as many terminals as before (${before.length} → ${after.length})`);

  // ── the preference off: nothing comes back ──
  await page.evaluate(() => window.__shiroDesktop.openApp('settings', { pane: 'appearance' }));
  await page.locator('[data-restore="0"]').click();
  check(await page.evaluate(() => localStorage.getItem('tabcomputer-restore-session')) === '0', 'Settings → Appearance: “Restore session on reload” off');
  await page.waitForTimeout(1000);
  await boot();
  await page.waitForTimeout(2500);
  const off = await terminals();
  check(off.length === 1 && off[0].cwd !== '/tmp' && !off[0].screen.includes('restored after reload')
    && !(await page.evaluate(() => window.__shiroDesktop.windows().some((w) => w.appId === 'mdview' || w.appId === 'settings'))),
  `with it off a reload restores nothing (${off.length} terminal, cwd ${off[0]?.cwd})`);
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message).split('\n')[0]}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
