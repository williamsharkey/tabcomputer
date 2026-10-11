// Firefox ESR without the gfx.e10s.font-list.shared=false overlay: does it get a window, do content processes live?
//   node ff-noshm.mjs [URL] [--keep-overlay] [--app firefox-esr]
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const args = process.argv.slice(2);
const url = args.find((a) => a.includes('://')) ?? 'http://localhost:5299/';
const keep = args.includes('--keep-overlay');
const app = args.includes('--app') ? args[args.indexOf('--app') + 1] : 'firefox-esr';
const overlay = app === 'thunderbird' ? '/etc/thunderbird/pref/shared-memory.js' : '/etc/firefox-esr/shared-memory.js';
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
log(`install: ${(await sh(`gui install ${app}`)).code}`);
if (!keep) log(`rm overlay: ${(await sh(`rm -v ${overlay}; ls /etc/firefox-esr/ 2>&1`)).out.trim()}`);
const t1 = Date.now();
await sh(`printf '<html><body style="font: 40px serif"><h1>Hello tabcomputer</h1><p>The quick brown fox jumps over the lazy dog.</p></body></html>' > /home/user/t.html`);
log(`launch: ${(await sh(`gui ${app} ${process.env.FFARGS ?? ''}`)).code}`);
await page.evaluate(() => { window.__ex = null; window.__guiLast?.exited.then((s) => { window.__ex = s; }); });
let windowAt = null;
for (let i = 0; i < 160; i++) {
  await page.waitForTimeout(5000);
  const st = await page.evaluate((app) => ({
    ex: window.__ex,
    wins: window.__tabcomputer.desktop.windows().filter((w) => w.surface).map((w) => `${w.appId}:${w.title}`),
  }), app);
  if (!windowAt && st.wins.length) {
    windowAt = Date.now() - t1; log(`first window after ${Math.round(windowAt / 1000)} s: ${st.wins.join(' | ')}`);
    if (process.env.TYPEURL) {
      await page.waitForTimeout(20000);
      await page.evaluate(() => { const w = window.__tabcomputer.desktop.windows().find((w) => w.surface); w.focus(); w.surface.canvas.focus(); });
      await page.keyboard.press('Control+l'); await page.waitForTimeout(3000);
      await page.keyboard.type(process.env.TYPEURL, { delay: 80 }); await page.keyboard.press('Enter');
      log('typed the URL');
    }
  }
  if (i % 3 === 0 || st.ex !== null) {
    const ps = '' && (await sh('ps -eo pid,args 2>/dev/null | grep -E "firefox|thunderbird|dbus" | grep -v grep | sed "s/^ *//" | cut -c1-60 | tr "\\n" ";"')).out.trim();
    log(`windows ${JSON.stringify(st.wins)} procs ${ps} exited ${st.ex}`);
  }
  if (st.ex !== null) break;
  if (windowAt && Date.now() - t1 > windowAt + 240000) break;
}
const out = await page.evaluate(() => window.__guiLast?.output() ?? '');
console.log('--- output tail ---\n' + out.split('\n').slice(-40).join('\n'));
await page.screenshot({ path: `${process.env.OUT ?? '.'}/${app}${keep ? '-overlay' : '-noshm'}.png` });
await browser.close();
