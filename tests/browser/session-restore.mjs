// Session restore on reload (src/desktop/session.ts, src/desktop/last-session.ts):
// two terminals (one cd'd somewhere with an exported variable and output, one
// running a command that isn't known-safe), an mdview window and a fake agent
// job (a `codex` on PATH that writes its session file). A reload opens one
// Last session window and leaves the main terminal fresh. View draws the saved
// screen. Open brings mdview back. Resume is a button, and the agent is not
// started until it is used. Then the preference (Settings → Appearance) goes
// off and a reload shows nothing.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/session-restore.mjs [URL]
import { createRequire } from 'node:module';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const require = createRequire(import.meta.url);
let chromium;
({ chromium } = loadPlaywright());

const url = process.argv[2] ?? 'http://localhost:5299/';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
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
  await page.waitForTimeout(4500); // a save (every 3 s while terminals print)

  // ── reload: one window, the main terminal fresh ──
  await boot();
  await page.waitForTimeout(1500);
  const after = await terminals();
  const main = after.find((t) => t.id === 'terminal');
  const cards = await page.evaluate(() => [...document.querySelectorAll('.sd-last-card')].map((c) => ({ title: c.dataset.title, status: c.dataset.status, kind: c.dataset.kind, cmd: c.dataset.cmd ?? '', acts: [...c.querySelectorAll('button')].map((b) => b.dataset.act) })));
  check(after.length === 1 && main && main.cwd !== '/tmp' && main.foo === null && !main.screen.includes('hello-main') && !main.screen.includes('restored after reload'),
    `main terminal stays fresh (${main?.cwd}, FOO=${main?.foo})`);
  check(cards.some((c) => c.kind === 'terminal' && c.status === 'was running' && c.acts.includes('run')) && cards.some((c) => c.kind === 'agent' && c.status === 'can resume' && c.acts.includes('resume')) && cards.some((c) => c.cmd.startsWith('mdview')),
    `Last session lists the terminal, the agent and mdview (${JSON.stringify(cards)})`);
  check(!after.some((t) => (t.running ?? '').includes('codex')) && !(await page.evaluate(() => window.__shiroDesktop.windows().some((w) => w.appId === 'mdview'))),
    'nothing was resumed or reopened');
  // View draws the saved screen. It does not type the command.
  await page.evaluate(async () => {
    const card = [...document.querySelectorAll('.sd-last-card')].find((c) => c.dataset.detail === '/tmp');
    card?.querySelector('[data-act=view]')?.click();
    await (document.querySelector('.sd-last')?.__job ?? Promise.resolve());
  });
  await page.waitForTimeout(400);
  const viewed = (await terminals()).find((t) => t.id === 'terminal');
  check(viewed && viewed.cwd === '/tmp' && viewed.foo === 'bar' && viewed.screen.includes('hello-main') && viewed.screen.includes('restored after reload'),
    `View: directory, variable, scrollback, one note (${viewed?.cwd}, FOO=${viewed?.foo})`);
  await page.evaluate(async () => {
    const card = [...document.querySelectorAll('.sd-last-card')].find((c) => /sleep 300/.test(c.dataset.title ?? ''));
    card?.querySelector('[data-act=view]')?.click();
    await (document.querySelector('.sd-last')?.__job ?? Promise.resolve());
  });
  await page.waitForTimeout(400);
  const second = (await terminals()).find((t) => t.screen.includes('second-output'));
  check(second && second.cwd === '/home/user/proj' && second.running === null, `View: the other terminal, command not running (${second?.cwd}, ${second?.running})`);
  await page.evaluate(async () => {
    const card = [...document.querySelectorAll('.sd-last-card')].find((c) => (c.dataset.cmd ?? '').startsWith('mdview'));
    card?.querySelector('[data-act=open]')?.click();
    await (document.querySelector('.sd-last')?.__job ?? Promise.resolve());
  });
  await page.waitForFunction(() => window.__shiroDesktop.windows().some((w) => w.appId === 'mdview'), null, { timeout: 15_000 }).catch(() => {});
  check(await page.evaluate(() => window.__shiroDesktop.windows().some((w) => w.appId === 'mdview')), 'Open brings the mdview window back');

  // ── the preference off: nothing comes back ──
  await page.evaluate(() => window.__shiroDesktop.openApp('settings', { pane: 'appearance' }));
  await page.locator('[data-restore="0"]').click();
  check(await page.evaluate(() => localStorage.getItem('tabcomputer-restore-session')) === '0', 'Settings → Appearance: “Restore session on reload” off');
  await page.waitForTimeout(1000);
  await boot();
  await page.waitForTimeout(2500);
  const off = await terminals();
  check(off.length === 1 && off[0].cwd !== '/tmp' && !off[0].screen.includes('restored after reload')
    && !(await page.evaluate(() => window.__shiroDesktop.windows().some((w) => w.appId === 'mdview' || w.appId === 'settings' || w.appId === 'last-session'))),
  `with it off a reload restores nothing (${off.length} terminal, cwd ${off[0]?.cwd})`);
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message).split('\n')[0]}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
