// node pagesh.mjs 'cmd' ['cmd' ...]: each command in one shell of a fresh tabcomputer page (localhost:5299), output printed
import { createRequire } from 'node:module';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await page.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
await page.goto('http://localhost:5299/?ui=desktop');
await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 120000 });
for (const cmd of process.argv.slice(2)) {
  const r = await page.evaluate(async (cmd) => {
    const s = window.__s ??= window.__tabcomputer.shell.fork();
    let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
  }, cmd);
  console.log(`$ ${cmd}  [${r.code}]\n${r.out.slice(-6000)}`);
}
await browser.close();
