// node ff-env.mjs URL 'ENV=1 ENV2=1' [extra firefox args]: Firefox ESR started from the shell with that environment,
// a page typed into its address bar once the window is up; then dmesg, the log, and a screenshot
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const [url, envs = '', extra = '', prep = ''] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
await page.goto(url + '?ui=desktop');
await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 120000 });
const sh = (cmd) => page.evaluate(async (cmd) => {
  const s = window.__s ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
const t0 = Date.now();
const log = (m) => console.log(`[${Math.round((Date.now() - t0) / 1000)} s] ${m}`);
log(`install ${(await sh('gui install firefox-esr')).code}`);
await sh(`printf '<html><body style="font: 40px serif"><h1>Hello tabcomputer</h1><p>The quick brown fox.</p></body></html>' > /home/user/t.html`);
if (prep) log('prep ' + (await sh(prep)).code);
// the session bus the launcher would start: launch xeyes through it first
await sh('gui install xeyes >/dev/null; gui xeyes');
await page.waitForTimeout(5000);
const bus = 'unix:path=/tmp/runtime-user/bus';
log('launch ' + (await sh(`cd /home/user && (DISPLAY=:0 HOME=/home/user XDG_RUNTIME_DIR=/tmp/runtime-user DBUS_SESSION_BUS_ADDRESS=${bus} NO_AT_BRIDGE=1 ${envs} /usr/lib/firefox-esr/firefox-esr ${extra} > /tmp/ff.log 2>&1 &); echo started`)).out.trim());
const isFx = () => page.evaluate(() => window.__tabcomputer.desktop.windows().some((w) => w.surface && /Firefox/.test(w.title)));
for (let i = 0; i < 200 && !(await isFx()); i++) await page.waitForTimeout(5000);
log(`window: ${await isFx()}`);
if (await isFx()) {
  await page.waitForTimeout(20000);
  await page.evaluate(() => { const w = window.__tabcomputer.desktop.windows().find((w) => w.surface && /Firefox/.test(w.title)); w.focus(); w.surface.canvas.focus(); });
  await page.keyboard.press('Control+l'); await page.waitForTimeout(3000);
  await page.keyboard.type('file:///home/user/t.html', { delay: 80 }); await page.keyboard.press('Enter');
  log('typed'); await page.waitForTimeout(150000);
}
console.log('--- dmesg ---\n' + (await sh('dmesg 2>&1 | tail -25')).out);
console.log('--- ps ---\n' + (await sh('ps -eo pid,ppid,stat,args 2>&1 | grep -i firefox | grep -v grep')).out);
console.log('--- log ---\n' + (await sh('tail -60 /tmp/ff.log | cat -v | cut -c1-300')).out);
await page.screenshot({ path: `${process.env.OUT ?? '.'}/ff-env.png` });
await browser.close();
