// Seed links (/s/<id>) and repository links (/<user>/<repo>), tabcomputer#116, and the
// reinstall offer after the browser deleted the filesystem, tabcomputer#71, in Chromium.
// Needs a build and a server that keeps shared seeds; no relay, no Debian, no network:
//   npx vite build && PORT=5417 STATIC_DIR=$PWD/dist TABCOMPUTER_SEED_SHARE=1 SEED_DIR=/tmp/seeds node server.mjs &
//   node tests/browser/inbound-links.mjs [PORT] [--shots DIR]
//
// The same server is opened under two names: 127.0.0.1 (no guests there, as on a server
// without them) and app.localhost (guests on; Chromium resolves *.localhost itself).
//   no guests   the app starts at /s/<id> and /<user>/<repo> at all (the base element); each
//               asks in the run links' window before anything is fetched into the machine;
//               Cancel and a script's click change nothing; Load replaces the files; the
//               address loses the link; ?safe=1 and a frame do nothing
//   guests      the main origin sends the link to a guest of its own, which goes ahead
//               without a question; a guest kept under another name asks
//   after loss  the list of what was installed survives the filesystem's deletion, and the
//               next load offers it again: Reinstall types the commands into a Terminal
//
// Exits 1 if any check fails. CHROMIUM= picks the browser.
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch {
  try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright-core'); }
}
const { chromium } = pw;
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const port = args[0] || '5417';
const PLAIN = `http://127.0.0.1:${port}`;
const GUESTS = `http://app.localhost:${port}`;
if (shots) mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `: ${detail}` : ''}`); if (!ok) failures++; };

// ── A shared seed: three files, one of them a startup script ──
const now = Date.now();
const node = (path, type, text) => ({ path, type, content: text === undefined ? null : Buffer.from(text).toString('base64'), mode: type === 'dir' ? 0o755 : 0o644, mtime: now, ctime: now, size: text?.length ?? 0 });
const NODES = [
  node('/', 'dir'), node('/home', 'dir'), node('/home/user', 'dir'), node('/tmp', 'dir'),
  node('/home/user/from-seed.txt', 'file', 'the seed was loaded\n'),
  node('/home/user/.profile', 'file', 'echo ran > /home/user/seed-profile-ran\n'),
];
const envelope = { version: 1, hostname: 'elsewhere.example', timestamp: now, files: 2, dirs: 4, totalBytes: 60, ndjson: NODES.map((n) => JSON.stringify(n)).join('\n'), storage: JSON.stringify({ 'seed-check-setting': '1' }) };
const up = await fetch(`${PLAIN}/api/seed`, { method: 'POST', body: gzipSync(JSON.stringify(envelope)) });
if (!up.ok) { console.log(`FAIL the server keeps no shared seeds (start it with TABCOMPUTER_SEED_SHARE=1): HTTP ${up.status}`); process.exit(1); }
const { id: SEED } = await up.json();

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
async function newContext(options = {}) {
  const ctx = await browser.newContext(options);
  await ctx.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  // No clone leaves this machine: the check is what happens before one
  await ctx.route('**/git-proxy/**', (route) => route.fulfill({ status: 404, body: 'not here' }));
  await ctx.route('https://api.github.com/**', (route) => route.fulfill({ status: 404, body: '{}' }));
  return ctx;
}
const booted = (page) => page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
async function open(ctx, url) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(url);
  await booted(page);
  return page;
}
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const s = Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  s.cwd = '/home/user';
  await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return out.replace(/\r\n/g, '\n').trim();
}, cmd);
const mainScreen = (page) => page.evaluate(() => {
  const buf = window.__tabcomputer.terminal.term.buffer.active;
  let text = '';
  for (let i = 0; i < buf.length; i++) text += buf.getLine(i).translateToString(true) + '\n';
  return text.trim();
});
const windowTexts = (page) => page.evaluate(() => (window.__shiroDesktop?.windows() ?? []).map((w) => {
  const buf = w.content?.activeTerminal?.()?.term.buffer.active;
  let text = '';
  if (buf) for (let i = 0; i < buf.length; i++) text += buf.getLine(i).translateToString(true) + '\n';
  return `${w.title}\n${text.trim()}`;
}));
const prompt = (page) => page.locator('.tc-run-prompt');
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `inbound-links-${name}.png`) }); };
const until = async (fn, ms = 20_000) => { const end = Date.now() + ms; let v; while (Date.now() < end) { v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); } return v; };

// ── No guests: a seed link in a profile that has files of its own ──
{
  const ctx = await newContext();
  let page = await open(ctx, `${PLAIN}/`);
  check((await (await fetch(`${PLAIN}/guest/config.json`)).json()).origin === null, 'no guests: 127.0.0.1 has none');
  await sh(page, 'echo mine > ~/mine.txt; sync');
  await page.close();

  page = await open(ctx, `${PLAIN}/s/${SEED}`);
  check(true, 'no guests: the app starts at /s/<id>');
  await prompt(page).waitFor({ timeout: 30_000 });
  const text = await prompt(page).textContent();
  check(text.includes(`Load the shared seed "${SEED}"?`) && text.includes('replaces every file in this tabcomputer'), 'seed: the window asks, and says it replaces every file', text.slice(0, 200));
  check(/Runs when it starts:\s+\/home\/user\/\.profile/.test(await prompt(page).locator('pre').textContent()), 'seed: the startup script it carries is listed first');
  check(text.includes('made on elsewhere.example'), 'seed: where it was made is shown');
  check(new URL(page.url()).pathname === '/', 'seed: the link has left the address', page.url());
  check(await sh(page, 'cat ~/mine.txt; ls ~/from-seed.txt 2>/dev/null') === 'mine', 'seed: nothing is loaded while the window is open');
  await shot(page, 'seed-prompt');
  const load = prompt(page).locator('button[data-act=run]');
  check(await load.textContent() === 'Load', 'seed: the agreeing button says Load');
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('.tc-run-prompt button[data-act=run]').click());
  await page.waitForTimeout(700);
  check(await sh(page, 'cat ~/mine.txt; ls ~/from-seed.txt 2>/dev/null') === 'mine' && await prompt(page).count() === 1, 'seed: a click made by a script loads nothing');
  await prompt(page).locator('button[data-act=cancel]').click();
  await page.waitForTimeout(700);
  check(await sh(page, 'cat ~/mine.txt; ls ~/from-seed.txt ~/seed-profile-ran 2>/dev/null') === 'mine', 'seed: Cancel changes nothing');
  check(/Cancelled\. Nothing was changed\./.test(await mainScreen(page)), 'seed: the terminal says it was cancelled');
  await page.reload();
  await booted(page);
  await page.waitForTimeout(2500);
  check(await prompt(page).count() === 0, 'seed: a reload does not ask again');
  await page.close();

  // Safe mode and a frame: nothing
  page = await open(ctx, `${PLAIN}/s/${SEED}?safe=1`);
  await page.waitForTimeout(3000);
  check(await prompt(page).count() === 0 && await sh(page, 'cat ~/mine.txt') === 'mine', 'seed: ?safe=1 ignores the link');
  await page.close();
  page = await ctx.newPage();
  await page.route('**/framer.html', (route) => route.fulfill({ contentType: 'text/html', body: `<iframe id=f src="/s/${SEED}" style="width:900px;height:600px"></iframe>` }));
  await page.goto(`${PLAIN}/framer.html`);
  const frame = page.frameLocator('#f');
  await frame.locator('.xterm').first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(5000);
  check(await frame.locator('.tc-run-prompt').count() === 0, 'seed: no window inside a frame');
  await page.close();
  page = await open(ctx, `${PLAIN}/`);
  check(await sh(page, 'cat ~/mine.txt; ls ~/from-seed.txt 2>/dev/null') === 'mine', 'seed: the framed link loaded nothing');
  await page.close();

  // Load
  page = await open(ctx, `${PLAIN}/s/${SEED}`);
  await prompt(page).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(900);
  await prompt(page).locator('button[data-act=run]').click();
  await page.waitForURL(`${PLAIN}/`, { timeout: 30_000 });
  await booted(page);
  const after = await until(async () => (await sh(page, 'cat ~/from-seed.txt 2>/dev/null')) === 'the seed was loaded' && sh(page, 'cat ~/from-seed.txt; ls ~/mine.txt 2>/dev/null'));
  check(after === 'the seed was loaded', 'seed: Load replaces the files with the seed\'s', String(after));
  await page.close();
  await ctx.close();
}

// ── No guests: a repository link ──
{
  const ctx = await newContext();
  let page = await open(ctx, `${PLAIN}/someone/repo`);
  check(true, 'no guests: the app starts at /<user>/<repo>');
  await prompt(page).waitFor({ timeout: 30_000 });
  const text = await prompt(page).textContent();
  check(text.includes('Clone and run someone/repo?') && text.includes('From github.com/someone/repo.'), 'repo: the window asks, and names the repository', text.slice(0, 200));
  check((await prompt(page).locator('pre').textContent()).startsWith('git clone https://github.com/someone/repo ~/repo\n'), 'repo: it shows what will run');
  check(new URL(page.url()).pathname === '/', 'repo: the link has left the address', page.url());
  await shot(page, 'repo-prompt');
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('.tc-run-prompt button[data-act=run]').click());
  await page.waitForTimeout(500);
  check(!/Cloning/.test(await mainScreen(page)), 'repo: a click made by a script clones nothing');
  await prompt(page).locator('button[data-act=cancel]').click();
  await page.waitForTimeout(1500);
  check(!/Cloning/.test(await mainScreen(page)) && await sh(page, 'ls -d ~/repo 2>/dev/null') === '', 'repo: Cancel clones nothing');
  await page.close();

  page = await open(ctx, `${PLAIN}/someone/repo/`);
  await prompt(page).waitFor({ timeout: 30_000 });
  await page.waitForTimeout(900);
  await prompt(page).locator('button[data-act=run]').click();
  check(await until(async () => /Cloning https:\/\/github\.com\/someone\/repo\.\.\./.test(await mainScreen(page))), 'repo: Clone and run starts the clone');
  await page.close();

  page = await open(ctx, `${PLAIN}/someone/.claude`);
  check(await until(async () => /link: that address is not a GitHub repository this page clones/.test(await mainScreen(page))) && await prompt(page).count() === 0, 'repo: a name that would be cloned over ~/.claude is refused');
  await page.close();

  // A phone: the window fits
  const phone = await newContext({ viewport: { width: 360, height: 740 }, hasTouch: true, isMobile: true });
  page = await open(phone, `${PLAIN}/someone/repo`);
  await prompt(page).waitFor({ timeout: 30_000 });
  const fits = await page.evaluate(() => {
    const inside = (el) => { const r = el.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth + 1 && r.top >= 0 && r.bottom <= innerHeight + 1; };
    const p = document.querySelector('.tc-run-prompt');
    return inside(p.querySelector('[data-act=run]')) && inside(p.querySelector('[data-act=cancel]'));
  });
  check(fits, 'repo: on a 360 px screen both buttons are on screen');
  await shot(page, 'repo-phone');
  await phone.close();
  await ctx.close();
}

// ── Guests: the link goes to a guest of its own ──
{
  const ctx = await newContext();
  let page = await ctx.newPage();
  await page.goto(`${GUESTS}/someone/repo`);
  await page.waitForURL(/^http:\/\/guest--[a-z0-9]{10}--t\.app\.localhost/, { timeout: 30_000 });
  await booted(page);
  check(true, `guests: a repository link opens in a thrown-away guest (${new URL(page.url()).host})`);
  check(await until(async () => /Cloning https:\/\/github\.com\/someone\/repo\.\.\./.test(await mainScreen(page))) && await prompt(page).count() === 0, 'guests: it goes ahead there without a question');
  await page.close();

  page = await ctx.newPage();
  await page.goto(`${GUESTS}/s/${SEED}`);
  await page.waitForURL(new RegExp(`^http://guest--seed${SEED}\\.app\\.localhost:${port}/$`), { timeout: 60_000 });
  await booted(page);
  const got = await until(async () => (await sh(page, 'cat ~/from-seed.txt 2>/dev/null')) === 'the seed was loaded');
  check(got, `guests: a seed link loads in its own kept guest (${new URL(page.url()).host}) without a question`);
  await page.close();

  // A guest someone keeps under another name may hold work and sign-ins: it asks
  page = await open(ctx, `http://guest--work.app.localhost:${port}/`);
  await sh(page, 'echo work > ~/work.txt; sync');
  await page.close();
  page = await open(ctx, `http://guest--work.app.localhost:${port}/s/${SEED}`);
  await prompt(page).waitFor({ timeout: 30_000 });
  check((await prompt(page).textContent()).includes('replaces every file in this guest'), 'guests: a guest kept under another name is asked first');
  await prompt(page).locator('button[data-act=cancel]').click();
  check(await sh(page, 'cat ~/work.txt; ls ~/from-seed.txt 2>/dev/null') === 'work', 'guests: and Cancel leaves it as it was');
  await page.close();
  await ctx.close();
}

// ── After the browser deleted the filesystem: the offer to install again ──
{
  const ctx = await newContext();
  let page = await open(ctx, `${PLAIN}/`);
  await sh(page, 'mkdir -p /var/lib/pkg; echo \'{"zz-not-a-package":{"name":"zz-not-a-package"}}\' > /var/lib/pkg/status.json; sync');
  const saved = await until(() => page.evaluate(() => { try { return JSON.parse(localStorage.getItem('tabcomputer-installed') || 'null')?.pkg?.includes('zz-not-a-package'); } catch { return false; } }), 15_000);
  check(saved, 'after loss: the list of what is installed is kept outside the filesystem');
  // The browser evicts the origin's IndexedDB; localStorage survives
  await page.evaluate(() => new Promise((resolve) => { const r = indexedDB.deleteDatabase('tabcomputer-fs'); r.onsuccess = r.onerror = r.onblocked = () => resolve(); }));
  await page.locator('.tabcomputer-storage-lost').first().waitFor({ timeout: 20_000 });
  check(true, 'after loss: the page says its storage was deleted');
  await page.waitForTimeout(3000);
  check(await page.evaluate(() => JSON.parse(localStorage.getItem('tabcomputer-installed')).pkg.includes('zz-not-a-package')), 'after loss: the list is not overwritten by the page that lost its files');
  page.on('dialog', (d) => d.accept());
  await page.reload();
  await booted(page);
  const offer = page.locator('.tabcomputer-storage-previous');
  await offer.waitFor({ timeout: 20_000 });
  await until(async () => /It had installed/.test(await offer.textContent()));
  const text = await offer.textContent();
  check(/previous files are gone/.test(text) && text.includes('It had installed: the package zz-not-a-package.'), 'after loss: the next load says what the lost disk had installed', text);
  await shot(page, 'reinstall-offer');
  await offer.locator('button', { hasText: 'Reinstall' }).click();
  const typed = await until(async () => (await windowTexts(page)).find((t) => t.includes('pkg install zz-not-a-package')) || (/pkg install zz-not-a-package/.test(await mainScreen(page)) && 'main'));
  check(typed, 'after loss: Reinstall types the commands into a Terminal');
  check(await offer.count() === 0 && await page.evaluate(() => localStorage.getItem('tabcomputer-installed-lost')) === null, 'after loss: the offer is gone once taken');
  await page.reload();
  await booted(page);
  await page.waitForTimeout(3000);
  check(await offer.count() === 0, 'after loss: and is not made again on the next load');
  await ctx.close();
}

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
