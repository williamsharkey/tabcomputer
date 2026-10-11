// The Git app's home and Files' Repositories (docs/DESKTOP.md "Git"), in Chromium against a
// stubbed api.github.com and github.com device flow (no real account):
//   signed out   Git opens to its home: Sign in with GitHub, the repositories on this computer
//   sign in      the device flow in place (code, then signed in) and the lists without a reload:
//                your repositories (Open for the one cloned here, Clone for the rest), filter,
//                notifications (unread first), pull requests
//   repo view    Open shows the repository; Home goes back
//   expiry       a 401 signs out with a message
//   Files        Repositories (~/src) always opens, even before anything is cloned, with New
//                Repository, Clone from URL and your GitHub repositories above the listing
//   phone        360 px wide: nothing wider than the screen
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/git-home.mjs [URL] [--shots DIR]
//
// CHROMIUM=/path/to/chrome picks the browser. Exits 1 if any check fails.
import { createRequire } from 'node:module';
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
const url = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, detail = '') => { results.push(ok); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`); };

// ── The fake GitHub ──
const now = Date.now();
const ago = (h) => new Date(now - h * 3600e3).toISOString();
const repo = (full, o = {}) => ({ id: full.length * 1000 + full.charCodeAt(0), name: full.split('/')[1], full_name: full, owner: { login: full.split('/')[0] }, private: false, description: null, language: null, pushed_at: ago(30), updated_at: ago(30), stargazers_count: 0, html_url: `https://github.com/${full}`, clone_url: `https://github.com/${full}.git`, ...o });
const REPOS = [
  repo('ada/engine', { private: true, description: 'The analytical engine, in Rust', language: 'Rust', pushed_at: ago(1), stargazers_count: 12 }),
  repo('ada/notes', { description: 'Notes on the engine', language: 'Markdown', pushed_at: ago(50) }),
  repo('ada/website', { description: 'ada.dev', language: 'TypeScript', pushed_at: ago(200), stargazers_count: 3 }),
  repo('babbage/difference', { description: 'Difference engine No. 2: gears and columns', language: 'Python', pushed_at: ago(400), fork: true }),
  repo('ada/punchcards', { private: true, description: 'Card reader experiments', language: 'C', pushed_at: ago(900) }),
];
const NOTES = [
  { id: '1', unread: false, reason: 'mention', updated_at: ago(3), subject: { title: 'Bernoulli numbers overflow', url: 'https://api.github.com/repos/ada/engine/issues/7', type: 'Issue' }, repository: { full_name: 'ada/engine', html_url: 'https://github.com/ada/engine' } },
  { id: '2', unread: true, reason: 'review_requested', updated_at: ago(5), subject: { title: 'Faster carry propagation', url: 'https://api.github.com/repos/ada/engine/pulls/12', type: 'PullRequest' }, repository: { full_name: 'ada/engine', html_url: 'https://github.com/ada/engine' } },
];
const PRS = [{ id: 9, number: 12, title: 'Faster carry propagation', html_url: 'https://github.com/ada/engine/pull/12', repository_url: 'https://api.github.com/repos/ada/engine', updated_at: ago(5), pull_request: {} }];
const ISSUES = [{ id: 10, number: 3, title: 'Document the card format', html_url: 'https://github.com/ada/punchcards/issues/3', repository_url: 'https://api.github.com/repos/ada/punchcards', updated_at: ago(20) }];
const USER = { login: 'ada', name: 'Ada Lovelace', avatar_url: 'https://avatars.githubusercontent.com/u/9999?v=4', html_url: 'https://github.com/ada' };
const AVATAR = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#7c5cff"/><text x="20" y="27" font-size="20" text-anchor="middle" fill="#fff" font-family="sans-serif">A</text></svg>`;

async function stubGitHub(context, state) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'Authorization, Content-Type, X-GitHub-Api-Version', 'access-control-allow-methods': 'GET, POST, PATCH' };
  await context.route('https://api.github.com/**', async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    state.requests.push(`${req.method()} ${req.url()}`);
    const auth = req.headers()['authorization'] || '';
    if (state.expired || !auth.startsWith('Bearer ')) return route.fulfill({ status: 401, headers: cors, contentType: 'application/json', body: '{"message":"Bad credentials"}' });
    const u = new URL(req.url());
    const body = u.pathname === '/user' ? USER
      : u.pathname === '/user/repos' ? REPOS
      : u.pathname === '/notifications' ? NOTES
      : u.pathname === '/search/issues' ? { items: /author/.test(u.searchParams.get('q')) ? PRS : ISSUES }
      : null;
    if (req.method() === 'PATCH') return route.fulfill({ status: 205, headers: cors, body: '' });
    route.fulfill({ status: body ? 200 : 404, headers: cors, contentType: 'application/json', body: JSON.stringify(body ?? { message: 'Not Found' }) });
  });
  await context.route('https://avatars.githubusercontent.com/**', (route) => route.fulfill({ status: 200, contentType: 'image/svg+xml', headers: { 'cross-origin-resource-policy': 'cross-origin', 'access-control-allow-origin': '*' }, body: AVATAR }));
  // github.com's device flow, through this site's /api/github-login proxy
  await context.route('**/api/github-login/login/device/code', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }) }));
  await context.route('**/api/github-login/login/oauth/access_token', (route) => {
    state.polls++;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.polls < 2 ? { error: 'authorization_pending' } : { access_token: 'gho_fake_token_for_tests' }) });
  });
}

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
async function open(viewport, theme, init = {}) {
  const context = await browser.newContext({ viewport, colorScheme: theme, ...(viewport.width < 500 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
  const state = { requests: [], polls: 0, expired: false };
  await stubGitHub(context, state);
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.addInitScript((token) => {
    try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); if (token && !sessionStorage.getItem('seeded')) { localStorage.setItem('tabcomputer_github_token', token); sessionStorage.setItem('seeded', '1'); } } catch {}
  }, init.token ?? null);
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
  await page.waitForTimeout(1200);
  const sh = (cmd) => page.evaluate(async (cmd) => { let o = ''; const s = window.__tabcomputer.shell.fork(); s.cwd = '/home/user'; const code = await s.execute(cmd, x => { o += x; }, x => { o += x; }); return { code, o }; }, cmd);
  return { context, page, state, sh };
}
/** A window's picture (a clip of the page: windows animate, so no element screenshot) */
const shot = async (page, sel, name) => {
  if (!shots) return;
  await page.waitForTimeout(400);
  const r = await page.evaluate((sel) => {
    const els = [...document.querySelectorAll(sel)];
    const e = els[els.length - 1];
    if (!e) return null;
    const b = e.getBoundingClientRect();
    return { x: Math.max(0, b.x), y: Math.max(0, b.y), width: Math.min(b.width, innerWidth), height: Math.min(b.height, innerHeight - Math.max(0, b.y)) };
  }, sel);
  if (r) await page.screenshot({ path: join(shots, `${name}.png`), clip: r });
};
const GITWIN = '.sd-win:has(.sd-gh-home)';
const FILESWIN = '.sd-win:has(.sd-files-repos:not([hidden]))';
const overflowX = (page, sel) => page.$$eval(sel, els => els.map(e => e.scrollWidth - e.clientWidth).filter(d => d > 1));

// ── Desktop: signed out, sign in, the lists, the repo view, expiry ──
{
  const { context, page, state, sh } = await open({ width: 1280, height: 820 }, 'dark');
  // Files first, on a fresh computer: Repositories opens though ~/src doesn't exist yet
  const before = await sh('test -d /home/user/src && echo yes || echo no');
  check('~/src missing on a fresh computer', before.o.trim() === 'no', before.o.trim());
  await page.evaluate(() => window.__shiroDesktop.openApp('files', { newWindow: true }));
  await page.waitForSelector('.sd-win.sd-focused .sd-side-item');
  await page.click('.sd-win.sd-focused .sd-side-item:has-text("Repositories")');
  await page.waitForSelector('.sd-win.sd-focused .sd-files-repos:not([hidden]) [data-gh-signin]', { timeout: 15_000 }).catch(() => {});
  const files0 = await page.$eval('.sd-win.sd-focused', w => ({ path: w.querySelector('.sd-path')?.textContent, empty: w.querySelector('.sd-empty')?.textContent, signin: !!w.querySelector('.sd-files-repos:not([hidden]) [data-gh-signin]'), newRepo: !!w.querySelector('.sd-files-repos [data-gh-act=new]') }));
  check('Files: Repositories opens an empty ~/src', files0.path === '/home/user/src' && /No repositories on this computer yet/.test(files0.empty), JSON.stringify(files0));
  check('Files: New Repository and Sign in above the listing', files0.signin && files0.newRepo);
  await shot(page, FILESWIN, 'files-repos-signed-out-desktop');
  // A folder that can't be opened says so
  await page.evaluate(() => window.__shiroDesktop.focused().content.navigate({ path: '/no/such/folder' }));
  await page.waitForTimeout(500);
  const err = await page.$eval('.sd-win.sd-focused .sd-empty', e => ({ text: e.textContent, shown: getComputedStyle(e).display !== 'none', cls: e.className }));
  check('Files: an error is shown, not swallowed', err.shown && /Can't open \/no\/such\/folder/.test(err.text) && err.cls.includes('sd-files-error'), err.text);
  await page.evaluate(() => window.__shiroDesktop.focused().close());

  // New Repository from Files (local only, signed out)
  const mk = await sh('mkdir -p /home/user/src/engine && cd /home/user/src/engine && git init -q && echo "# engine" > README.md && git add . && git commit -q -m init && git remote add origin https://github.com/ada/engine.git && echo change >> README.md');
  check('a clone of ada/engine on this computer', mk.code === 0, mk.o.slice(-200));

  await page.evaluate(() => window.__shiroDesktop.openApp('git'));
  await page.waitForSelector('.sd-gh-home [data-gh-signin]', { timeout: 20_000 });
  await page.waitForSelector('.sd-gh-home [data-sec=local] [data-gh-open]', { timeout: 15_000 }).catch(() => {});
  await page.waitForFunction(() => /changed|clean/.test(document.querySelector('.sd-gh-home [data-sec=local] .sd-gh-changed')?.textContent || ''), null, { timeout: 10_000 }).catch(() => {});
  const out = await page.$eval('.sd-gh-home', h => ({ local: [...h.querySelectorAll('[data-sec=local] .sd-gh-local')].map(r => r.textContent.replace(/\s+/g, ' ').trim()), title: h.querySelector('.sd-gh-head h2')?.textContent }));
  check('Git, signed out: home with Sign in and local repositories', out.local.some(t => /engine.*main.*~\/src\/engine.*1 changed/.test(t)), JSON.stringify(out));
  await shot(page, GITWIN, 'git-home-signed-out-desktop');

  // Sign in, in place
  await page.click('.sd-gh-home [data-gh-signin]');
  await page.waitForSelector('.sd-gh-home .sd-gh-code', { timeout: 10_000 });
  const code = await page.$eval('.sd-gh-home .sd-gh-code', e => e.textContent);
  check('sign in shows the code', code === 'WDJB-MJHT', code);
  await shot(page, GITWIN, 'git-home-code-desktop');
  await page.waitForSelector('.sd-gh-home .sd-gh-repo', { timeout: 20_000 });
  await page.waitForFunction(() => document.querySelectorAll('.sd-gh-home .sd-gh-note').length > 0 && document.querySelector('.sd-gh-avatar')?.tagName === 'IMG', null, { timeout: 10_000 }).catch(() => {});
  const home = await page.$eval('.sd-gh-home', h => ({
    login: h.querySelector('.sd-gh-who')?.textContent.replace(/\s+/g, ' ').trim(),
    repos: [...h.querySelectorAll('.sd-gh-repo')].map(r => `${r.dataset.full}:${r.querySelector('[data-gh-open]') ? 'open' : r.querySelector('[data-gh-clone]') ? 'clone' : '?'}`),
    notes: [...h.querySelectorAll('.sd-gh-note')].map(n => `${n.classList.contains('sd-gh-unread') ? '*' : ''}${n.querySelector('.sd-gh-title').textContent}`),
    prs: [...h.querySelectorAll('[data-sec=prs] .sd-gh-issue')].map(n => n.getAttribute('href')),
    issues: h.querySelectorAll('[data-sec=issues] .sd-gh-issue').length,
  }));
  check('signed in without a reload: account', /Ada Lovelace.*@ada/.test(home.login), home.login);
  check('your repositories, newest push first; Open for the local one', home.repos.join(' ') === 'ada/engine:open ada/notes:clone ada/website:clone babbage/difference:clone ada/punchcards:clone', home.repos.join(' '));
  check('notifications, unread first', home.notes[0] === '*Faster carry propagation' && home.notes.length === 2, home.notes.join(' | '));
  check('pull requests and assigned issues', home.prs[0] === 'https://github.com/ada/engine/pull/12' && home.issues === 1, JSON.stringify(home.prs));
  check('the token went to GitHub as a Bearer header', state.requests.some(r => r.includes('/user/repos?sort=pushed')));
  const saved = await page.evaluate(() => localStorage.getItem('tabcomputer_github_token'));
  check('the token is saved for git and gh', saved === 'gho_fake_token_for_tests');
  await shot(page, GITWIN, 'git-home-signed-in-desktop');

  // Filter and visibility
  await page.fill('.sd-gh-home .sd-gh-filter', 'gears');
  await page.waitForTimeout(150);
  const filtered = await page.$$eval('.sd-gh-home .sd-gh-repo', els => els.map(e => e.dataset.full));
  check('filter', filtered.join() === 'babbage/difference', filtered.join());
  await page.fill('.sd-gh-home .sd-gh-filter', '');
  await page.click('.sd-gh-home [data-vis=private]');
  const priv = await page.$$eval('.sd-gh-home .sd-gh-repo', els => els.map(e => e.dataset.full));
  check('private only', priv.join() === 'ada/engine,ada/punchcards', priv.join());
  await page.click('.sd-gh-home [data-vis=all]');

  // Open the local one: the repository view; Home comes back
  await page.click('.sd-gh-home .sd-gh-repo[data-full="ada/engine"] [data-gh-open]');
  await page.waitForSelector('.sd-gitui .sd-toolbar [data-act=home]', { timeout: 10_000 });
  const view = await page.$eval('.sd-gitui .sd-path', e => e.textContent);
  check('Open shows the repository', view === '~/src/engine', view);
  await page.click('.sd-gitui .sd-toolbar [data-act=home]');
  await page.waitForSelector('.sd-gh-home .sd-gh-repo', { timeout: 10_000 });
  check('Home goes back to the lists', true);

  // Light theme screenshot of the same window
  if (shots) {
    await page.evaluate(() => { document.querySelector('.sd-desktop')?.setAttribute('data-theme', 'light'); });
    await page.waitForTimeout(300);
    await shot(page, GITWIN, 'git-home-signed-in-desktop-light');
    await page.evaluate(() => { document.querySelector('.sd-desktop')?.setAttribute('data-theme', 'dark'); });
  }

  // Files: Repositories, signed in
  await page.evaluate(() => window.__shiroDesktop.openApp('files', { path: '/home/user/src', newWindow: true }));
  await page.waitForSelector('.sd-win.sd-focused .sd-files-repos .sd-gh-repo', { timeout: 15_000 });
  await page.waitForTimeout(800);
  const fr = await page.$eval('.sd-win.sd-focused', w => ({ rows: w.querySelectorAll('.sd-files-repos .sd-gh-repo').length, open: [...w.querySelectorAll('.sd-files-repos [data-gh-open]')].map(b => b.dataset.ghOpen), tag: w.querySelector('tr[data-path="/home/user/src/engine"] .sd-git-tag')?.textContent }));
  check('Files: your GitHub repositories above ~/src, Open for the local one; the listing keeps its badges', fr.rows === 5 && fr.open.join() === '/home/user/src/engine' && fr.tag === 'main', JSON.stringify(fr));
  await shot(page, FILESWIN, 'files-repos-signed-in-desktop');
  await page.click('.sd-win.sd-focused .sd-files-repos [data-gh-open="/home/user/src/engine"]');
  await page.waitForTimeout(600);
  const into = await page.$eval('.sd-win.sd-focused .sd-path', e => e.textContent);
  check('Files: Open goes into the folder', into === '/home/user/src/engine', into);
  await page.evaluate(() => window.__shiroDesktop.focused().close());

  // Expiry: a 401 on refresh signs out with a message
  state.expired = true;
  await page.evaluate(() => window.__shiroDesktop.openApp('git'));
  await page.click('.sd-gh-home [data-gh-act=refresh]');
  await page.waitForSelector('.sd-gh-home [data-gh-signin]', { timeout: 10_000 }).catch(() => {});
  const exp = await page.$eval('.sd-gh-home', h => ({ notice: h.querySelector('.sd-gh-notice')?.textContent, signin: !!h.querySelector('[data-gh-signin]') }));
  const tok = await page.evaluate(() => localStorage.getItem('tabcomputer_github_token'));
  check('an expired token signs out with a message', exp.signin && /expired or was revoked/.test(exp.notice || '') && tok === null, JSON.stringify(exp));
  await shot(page, GITWIN, 'git-home-expired-desktop');
  await context.close();
}

// ── Phone, 360 px: signed in (cached token), Git home and Files' Repositories ──
{
  const { context, page, sh } = await open({ width: 360, height: 780 }, 'dark', { token: 'gho_fake_token_for_tests' });
  await sh('mkdir -p /home/user/src/engine && cd /home/user/src/engine && git init -q && echo x > a && git add . && git commit -q -m init && git remote add origin https://github.com/ada/engine.git');
  await page.evaluate(() => window.__shiroDesktop.openApp('git'));
  await page.waitForSelector('.sd-gh-home .sd-gh-repo', { timeout: 20_000 });
  await page.waitForTimeout(1200);
  const max = await page.$eval('.sd-win.sd-focused', w => w.getBoundingClientRect().width);
  check('phone: the Git window fills the width', max <= 361 && max > 300, String(max));
  const ox = await overflowX(page, '.sd-gh-home, .sd-gh-row, .sd-gh-head');
  check('phone: nothing wider than the window in Git home', ox.length === 0, ox.join(','));
  check('phone: no sideways page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await shot(page, GITWIN, 'git-home-signed-in-phone');
  await page.evaluate(() => window.__shiroDesktop.openApp('files', { path: '/home/user/src', newWindow: true }));
  await page.waitForSelector('.sd-win.sd-focused .sd-files-repos .sd-gh-repo', { timeout: 15_000 });
  await page.waitForTimeout(800);
  const ox2 = await overflowX(page, '.sd-win.sd-focused .sd-files-repos, .sd-win.sd-focused .sd-gh-row');
  check('phone: nothing wider than the window in Files Repositories', ox2.length === 0, ox2.join(','));
  await shot(page, FILESWIN, 'files-repos-signed-in-phone');
  await page.evaluate(() => window.__shiroDesktop.focused().close());
  // Signed out on the phone
  await page.evaluate(() => { localStorage.removeItem('tabcomputer_github_token'); window.dispatchEvent(new StorageEvent('storage', { key: 'tabcomputer_github_token' })); });
  await page.waitForSelector('.sd-gh-home [data-gh-signin]', { timeout: 5_000 }).catch(() => {});
  check('phone: signing out elsewhere shows Sign in', !!(await page.$('.sd-gh-home [data-gh-signin]')));
  await shot(page, GITWIN, 'git-home-signed-out-phone');
  await context.close();
}

await browser.close();
const failed = results.filter(x => !x).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
