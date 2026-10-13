// A gh extension that needs scopes the tab's sign-in lacks (src/github-needed.ts,
// tabcomputer#153) in Chromium, against a stand-in GitHub: no account is signed in to anything.
// Needs a build and a running server; no Debian and no network:
//   npx vite build && PORT=6641 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/gh-scopes.mjs [URL] [--shots DIR] [--theme light|dark]
//
// The extension is a script that prints what Classroom 50's `gh student` prints when its token
// has no admin:org. Typed at a terminal: the sheet opens and says in plain words what is added;
// "Not now" leaves the extension's own message; "Approve on GitHub" runs the device flow for
// exactly the scopes the sign-in had plus the new one, and the command runs again by itself.
// Exits 1 if any check fails.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';

const pw = loadPlaywright();
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const theme = opt('--theme') === 'light' ? 'light' : 'dark';
const url = args[0] || 'http://localhost:6641/';
if (shots) mkdirSync(shots, { recursive: true });
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${!ok && detail ? `: ${detail}` : ''}`); if (!ok) failures++; };

const OLD = 'gho_standin_old', NEW = 'gho_standin_more';
const HAD = ['gist', 'read:org', 'repo', 'user:email', 'workflow'];
const NEEDY = `#!/bin/sh
if [ "$GH_TOKEN" = "${NEW}" ]; then echo "needy: signed in with what it needs"; exit 0; fi
echo "gh-needy: your github.com token (source: GH_TOKEN) is missing scopes gh needy needs (admin:org, read:org, repo, workflow); it wasn't set by \\\`gh auth login\\\`, so re-running won't fix it. Re-issue the token with those scopes, or unset it and run \\\`gh needy login\\\`" >&2
exit 1
`;

const DEVICES = [{ name: '1280', viewport: { width: 1280, height: 800 } }, { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 }];

for (const device of DEVICES) {
  const D = device.name;
  const { name: _n, ...opts } = device;
  const browser = await pw.chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
  const ctx = await browser.newContext(opts);
  const asked = { scope: '', polls: 0, real: [] };
  // GitHub, as this site's proxy for it: who the token is and what it may do; the device flow
  await ctx.route('**/api/github/**', (route) => {
    const u = new URL(route.request().url());
    const token = (route.request().headers().authorization ?? '').replace(/^(Bearer|token) /i, '');
    if (u.pathname.endsWith('/api/github/user')) {
      return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'x-oauth-scopes': (token === NEW ? ['admin:org', ...HAD] : HAD).join(', ') }, body: JSON.stringify({ login: 'octocat', name: 'The Octocat', email: null }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
  });
  await ctx.route('**/api/github-login/**', (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    if (route.request().url().endsWith('/login/device/code')) {
      asked.scope = body.scope;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ device_code: 'dev-1', user_code: 'ABCD-1234', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(++asked.polls < 2 ? { error: 'authorization_pending' } : { access_token: NEW, token_type: 'bearer', scope: asked.scope.replace(/ /g, ',') }) });
  });
  // (nothing may go to the real GitHub from this check)
  await ctx.route(/^https:\/\/([a-z.]+\.)?github(usercontent)?\.com\//, (route) => { asked.real.push(route.request().url()); return route.abort(); });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.addInitScript(([theme, token]) => {
    try { if (window.top === window) { localStorage.setItem('tabcomputer-desktop-welcome', '1'); localStorage.setItem('tabcomputer-desktop-theme', theme); localStorage.setItem('tabcomputer_github_token', token); } } catch {}
  }, [theme, OLD]);
  await page.goto(url);
  await page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished') && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
  await page.evaluate(async (script) => {
    const fs = window.__tabcomputer.fs;
    const dir = '/home/user/.local/share/gh/extensions/gh-needy';
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/gh-needy`, script);
    await fs.chmod(`${dir}/gh-needy`, 0o755);
  }, NEEDY);
  const screen = () => page.evaluate(() => {
    const term = window.__needyTerm;
    const buf = term?.term.buffer.active;
    let t = '';
    if (buf) for (let i = 0; i < buf.length; i++) { const line = buf.getLine(i); t += line.translateToString(true) + (buf.getLine(i + 1)?.isWrapped ? '' : '\n'); }
    return t;
  });
  /** Enter a line at a Terminal window's prompt, as a person would; do not wait for it to end */
  const type = (line) => page.evaluate(async (line) => {
    const wm = window.__shiroDesktop;
    const term = () => wm.windows().map((w) => w.content?.activeTerminal?.()).find(Boolean);
    if (!term()) await wm.openApp('terminal');
    for (let i = 0; i < 100 && !term(); i++) await new Promise((r) => setTimeout(r, 50));
    window.__needyTerm = term();
    window.__needyTerm.injectInput(line + '\r');
  }, line);
  const idle = () => page.waitForFunction(() => window.__needyTerm.foregroundLine === null, null, { timeout: 30_000 }).then(() => true, () => false);
  const sheet = () => page.evaluate(() => {
    const el = document.querySelector('.sd-sheet');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { title: el.querySelector('h3')?.textContent ?? '', says: [...el.querySelectorAll('p')].map((p) => p.textContent.replace(/\s+/g, ' ').trim()), buttons: [...el.querySelectorAll('.sd-sheet-actions .sd-btn')].map((b) => b.textContent.trim()), code: el.querySelector('.sd-code')?.textContent ?? '', status: el.querySelector('.sd-status-line')?.textContent ?? '', fits: r.left >= 0 && r.right <= innerWidth + 1 && el.scrollWidth <= el.clientWidth + 1 };
  });
  const until = async (fn, ms = 15_000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(100); } };
  const press = (sel) => (device.hasTouch ? page.tap(sel) : page.click(sel));

  // ── "Not now": the extension's own message stands ──
  await type('gh needy whoami');
  let s = await until(async () => { const x = await sheet(); return x && /permission/.test(x.title) ? x : null; });
  check(`${D}: a command that names scopes its token lacks opens the sheet, which says in plain words what is added`, !!s && s.title === 'One more permission from GitHub'
    && s.says[0] === 'gh needy whoami needs a permission the GitHub sign-in on this computer does not have. This adds permission to manage your organizations, their teams and their members (admin:org).'
    && s.says[1] === 'gh needy whoami runs again by itself once GitHub has your approval.' && s.buttons.join() === 'Not now,Approve on GitHub' && s.fits, JSON.stringify(s));
  if (shots) { await page.waitForTimeout(500); await page.screenshot({ path: join(shots, `scopes-${D}-sheet.png`) }); }
  await press('.sd-sheet [data-act=later]');
  check(`${D}: "Not now" leaves the command as it failed, with the extension's own words`, await idle() && /is missing scopes gh needy needs \(admin:org, read:org, repo, workflow\)/.test((await screen()).replace(/\n/g, '')) && asked.scope === '', (await screen()).slice(-300));

  // ── Approve: the device flow for those scopes, then the command again ──
  await page.evaluate(() => window.__tabcomputer.live('src/github-needed.ts').resetGitHubNeedDecline());
  await type('gh needy whoami');
  await until(async () => { const x = await sheet(); return x && /permission/.test(x.title) ? x : null; });
  await press('.sd-sheet [data-act=github]');
  s = await until(async () => { const x = await sheet(); return x?.code ? x : null; });
  check(`${D}: Approve on GitHub asks GitHub for what the sign-in had and the one new permission, and shows its code`, !!s && s.code === 'ABCD-1234' && asked.scope.split(' ').sort().join() === ['admin:org', ...HAD].sort().join() && s.fits, JSON.stringify({ code: s?.code, scope: asked.scope }));
  if (shots) { await page.waitForTimeout(300); await page.screenshot({ path: join(shots, `scopes-${D}-code.png`) }); }
  const ran = await until(async () => (/needy: signed in with what it needs/.test(await screen()) ? true : null), 20_000);
  const text = (await screen()).replace(/\n/g, ' ');
  check(`${D}: once GitHub approved, the command runs again by itself and works`, !!ran && await idle()
    && /gh needy whoami needs a permission the GitHub sign-in here does not have \(admin:org\)\. A window opened to add it\./.test(text.replace(/\s+/g, ' ')) && /GitHub added it\. Running gh needy whoami again\./.test(text.replace(/\s+/g, ' ')), text.slice(-500));
  check(`${D}: the sign-in here is the new one, and nothing went to GitHub itself`, await page.evaluate(() => localStorage.getItem('tabcomputer_github_token')) === NEW && asked.real.length === 0, asked.real.join(' '));
  // a second run needs nothing (the sheet has said "Approved." and gone)
  await until(async () => await page.locator('.sd-sheet').count() === 0, 8000);
  await type('gh needy whoami');
  const twice = await until(async () => ((await screen()).match(/needy: signed in with what it needs/g) ?? []).length === 2, 10_000);
  check(`${D}: the next run asks nothing`, !!twice && await idle() && await page.locator('.sd-sheet').count() === 0, (await screen()).slice(-300));
  await ctx.close();
  await browser.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
