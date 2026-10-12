// node apps/converter/measure/measure-local-become.mjs [URL]
// Against a local build of this branch (no Debian): the address /converter in app mode, timed from
// the start of a reload to the app's page having talked to its restarted backend.
import { pw, EXE, boot, sh, putApp, until } from './lib.mjs';
const URL0 = process.argv[2] || 'http://localhost:5299/';
const browser = await pw.chromium.launch({ executablePath: EXE, args: ['--no-sandbox'] });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
await boot(page, URL0);
await putApp(page);
await sh(page, 'cd /home/user/apps/converter && node server.js 4780', false);
await until(page, () => page.evaluate(() => window.__iframeServer.isPortInUse(4780)), 20000);
await sh(page, 'cd /home/user/apps/converter && become 4780 converter --start node server.js 4780');
const ready = () => until(page, async () => (await (await page.$('#become-container iframe'))?.contentFrame())?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1').catch(() => false), 30000, 10);
await ready();
const runs = [];
for (let i = 0; i < 6; i++) {
  const t0 = Date.now();
  await page.reload({ waitUntil: 'commit' });
  const committed = Date.now() - t0;
  await page.waitForFunction(() => !!window.__tabcomputer?.shell, null, { timeout: 60000 });
  const shell = Date.now() - t0;
  await ready();
  runs.push({ committedMs: committed, shellMs: shell, appInteractiveMs: Date.now() - t0 });
}
console.log(JSON.stringify(runs));
const s = runs.map((r) => r.appInteractiveMs).sort((a, b) => a - b);
console.log('reload to interactive app: median', s[3], 'ms, range', s[0], '-', s[5]);
await browser.close();
