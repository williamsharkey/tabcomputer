import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
const require = createRequire('/opt/node-tools/node_modules/');
const { chromium } = require('/opt/node-tools/node_modules/playwright');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
await page.goto('http://localhost:5299/?ui=desktop');
await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel, null, { timeout: 120000 });
const b64 = readFileSync(process.argv[2]).toString('base64');
await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  await window.__tabcomputer.fs.writeFile('/home/user/forkexec', bin, { mode: 0o755 });
}, b64);
const r = await page.evaluate(async () => { const s = window.__tabcomputer.shell.fork(); let o = ''; const code = await s.execute('chmod +x /home/user/forkexec; /home/user/forkexec', (x) => { o += x; }, (x) => { o += x; }); return { code, out: o }; });
console.log(r.code, '\n' + r.out);
await browser.close();
