// The classroom workspace (docs/CLASSROOM.md, tabcomputer#130) in Chromium, against a stand-in
// GitHub: the REST API of tests/tests/shiro-vitest/git-github-api-fake.ts answers api.github.com
// from this script, and the device flow is stubbed. No real account, nothing pushed anywhere.
//
//   lab link    ?run=lab:ada/lab1 asks first; Cancel clones nothing; Open clones the private
//               repository (the tab is signed in, private network mode) and opens the Code app
//               beside a Terminal in the folder
//   buttons     Run and Test type the config's commands in that Terminal, after saving
//   the mark    an edit shows "Not saved to GitHub yet" (status bar, window title, tab title)
//               and the tab asks before it closes
//   Submit      commits and pushes; the bar says what went where; the stand-in has the edit
//   sign-in     `lab open` on a private repository in a tab that is not signed in runs the
//               device flow, then clones
//   sign-out    Settings, Accounts: the confirm names the sign-in and the unpushed work; after
//               it the origin stores nothing
//
//   npx vite build && PORT=5837 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/classroom.mjs http://localhost:5837/ [--shots DIR]
//
// Node 22.18+ (it imports the TypeScript stand-in as it is). CHROMIUM= picks the browser.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
import { fakeGitHub, parseCommit, parseTree } from '../tests/shiro-vitest/git-github-api-fake.ts';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright-core')); } catch { try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); } }

const argv = process.argv.slice(2);
const shotsAt = argv.indexOf('--shots');
const shots = shotsAt < 0 ? null : argv.splice(shotsAt, 2)[1];
const url = argv[0] ?? 'http://localhost:5837/';
if (shots) mkdirSync(shots, { recursive: true });
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const exe = process.env.CHROMIUM || (existsSync(MAC) ? MAC : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };

// ── The stand-in GitHub: two private repositories ──
const TOKEN = 'gho_' + 'c'.repeat(36);
const enc = new TextEncoder();
function seed(gh, files) {
  const tree = (entries) => {
    const sorted = Object.entries(entries).sort(([a, x], [b, y]) => Buffer.compare(Buffer.from(a + (typeof x === 'string' ? '' : '/')), Buffer.from(b + (typeof y === 'string' ? '' : '/'))));
    const parts = [];
    for (const [name, v] of sorted) {
      const dir = typeof v !== 'string';
      const sha = dir ? tree(v) : gh.put('blob', enc.encode(v));
      parts.push(Buffer.from(`${dir ? '40000' : '100644'} ${name}\0`), Buffer.from(sha, 'hex'));
    }
    return gh.put('tree', new Uint8Array(Buffer.concat(parts)));
  };
  const who = 'Ada Lovelace <ada@example.org> 1700000000 +0000';
  const tip = gh.put('commit', enc.encode(`tree ${tree(files)}\nauthor ${who}\ncommitter ${who}\n\nStarter code\n`));
  gh.refs.set('main', tip);
  return tip;
}
const CONFIG = JSON.stringify({ lab: 1, name: 'Lab 1', run: 'sh main.sh', test: 'sh test.sh' }, null, 2) + '\n';
const lab1 = fakeGitHub('ada', 'lab1');
lab1.private = true;
const lab1Start = seed(lab1, { 'main.sh': 'echo "answer $((40 + 2))"\n', 'test.sh': 'echo "tests: $((1 + 1)) passed"\n', '.tabcomputer': { 'lab.json': CONFIG } });
const secret = fakeGitHub('ada', 'secret');
secret.private = true;
seed(secret, { 'notes.txt': 'first line\n', '.tabcomputer': { 'lab.json': CONFIG } });
const fakes = { 'ada/lab1': lab1, 'ada/secret': secret };
const state = { polls: 0, deviceCodes: 0 };

async function stubGitHub(context) {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, DELETE', 'access-control-expose-headers': '*' };
  const answer = async (route) => {
    const req = route.request();
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const u = new URL(req.url());
    // (through this site's /api/github proxy the path keeps GitHub's)
    const path = u.pathname.replace(/^\/api\/github/, '');
    const json = (status, body) => route.fulfill({ status, headers: cors, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/user') return (req.headers()['authorization'] ?? '').endsWith(TOKEN) ? json(200, { login: 'ada', name: 'Ada Lovelace', id: 9999 }) : json(401, { message: 'Bad credentials' });
    if (path === '/user/emails') return json(200, [{ email: 'ada@example.org', primary: true, verified: true }]);
    const m = /^\/(?:repos\/)?([^/]+\/[^/]+)(?:\/|$)/.exec(path);
    const gh = m && fakes[m[1]];
    if (!gh) return json(404, { message: 'Not Found' });
    const res = await gh.fetch(`https://${u.host === 'raw.githubusercontent.com' ? u.host : 'api.github.com'}${path}${u.search}`, { method: req.method(), headers: req.headers(), body: req.postData() ?? undefined });
    const headers = { ...cors };
    res.headers.forEach((v, k) => { headers[k] = v; });
    route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
  };
  await context.route('https://api.github.com/**', answer);
  await context.route('https://raw.githubusercontent.com/**', answer);
  await context.route('**/api/github/**', answer);
  // github.com's device flow, through this site's /api/github-login proxy
  await context.route('**/api/github-login/login/device/code', (route) => { state.deviceCodes++; route.fulfill({ contentType: 'application/json', body: JSON.stringify({ device_code: 'dc', user_code: 'WDJB-MJHT', verification_uri: 'https://github.com/login/device', expires_in: 900, interval: 1 }) }); });
  await context.route('**/api/github-login/login/oauth/access_token', (route) => {
    state.polls++;
    route.fulfill({ contentType: 'application/json', body: JSON.stringify(state.polls < 2 ? { error: 'authorization_pending' } : { access_token: TOKEN, scope: 'repo', token_type: 'bearer' }) });
  });
  // The sign-in page itself is never opened for real
  await context.route('https://github.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>stand-in</title>' }));
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 760 } });
await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
await stubGitHub(context);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
// A "leave site?" question is accepted, and counted
let leaveQuestions = 0;
page.on('dialog', (d) => { if (d.type() === 'beforeunload') leaveQuestions++; void d.accept().catch(() => {}); });

const boot = async (target) => {
  await page.goto(target);
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && window.__tabcomputer.terminal && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
};
const withUi = (extra = '') => url + (url.includes('?') ? '&' : '?') + 'ui=desktop' + extra;
const sh = (cmd) => page.evaluate(async (cmd) => {
  const s = window.__clShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
/** The Code window on `dir`: title, the frame's bar and status */
const editor = (dir) => page.evaluate((dir) => {
  const w = window.__shiroDesktop.windows().find((w) => w.appId === 'code' && w.codeDir === dir);
  const doc = w?.iframe?.contentDocument;
  if (!w || !doc?.getElementById('lab')) return null;
  const shown = (id) => { const e = doc.getElementById(id); return !!e && !e.hidden && !doc.getElementById('lab').hidden; };
  return {
    title: w.title, bar: !doc.getElementById('lab').hidden, name: doc.getElementById('lab-name').textContent,
    run: shown('lab-run'), test: shown('lab-test'), submit: shown('lab-submit'),
    msg: doc.getElementById('lab-msg').textContent, msgClass: doc.getElementById('lab-msg').className,
    git: doc.getElementById('status-git').textContent, gitClass: doc.getElementById('status-git').className, gitDetail: doc.getElementById('status-git').title,
    editorLoaded: !!doc.querySelector('.cm-content'), sidebar: doc.getElementById('sidebar').innerText,
  };
}, dir);
const frameOf = async (dir) => {
  const handle = await page.evaluateHandle((dir) => window.__shiroDesktop.windows().find((w) => w.appId === 'code' && w.codeDir === dir)?.iframe ?? null, dir);
  return handle.asElement().contentFrame();
};
/** Every Terminal window's screen text, joined */
const terminals = () => page.evaluate(() => window.__shiroDesktop.windows().filter((w) => w.kind === 'terminal').map((w) => {
  const out = [];
  for (const t of w.content?.terminals?.() ?? []) {
    const b = t.term.buffer.active;
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i)?.translateToString(true) ?? ''; if (l.trim()) out.push(l); }
  }
  return { cwd: w.content?.cwd?.(), text: out.join('\n') };
}));
const until = async (fn, ms = 60_000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v || Date.now() > end) return v; await page.waitForTimeout(250); } };
const shot = async (name) => { if (shots) await page.screenshot({ path: `${shots}/${name}.png` }); };
const wouldAsk = () => page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; });

const DIR = '/home/user/src/lab1';
try {
  // ── A signed-in student in private network mode (the transport this script can answer) ──
  await boot(withUi());
  await page.evaluate((token) => { localStorage.setItem('tabcomputer_github_token', token); localStorage.setItem('tabcomputer_network_mode', 'private'); }, TOKEN);

  // ── The lab link: the question, and Cancel ──
  await boot(withUi('&run=lab:ada/lab1'));
  await page.waitForSelector('.tc-run-prompt', { timeout: 30_000 });
  const prompt = await page.locator('.tc-run-prompt').innerText();
  check(/Open ada\/lab1\?/.test(prompt), 'the lab link asks "Open ada/lab1?"');
  check(/git clone https:\/\/github\.com\/ada\/lab1 ~\/src\/lab1/.test(prompt) && /Nothing in it runs until you press Run or Test/.test(prompt), 'it says what opening does, and that nothing runs yet');
  check(!new URL(page.url()).searchParams.has('run'), 'the link has left the address');
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-act')) === 'cancel', 'Cancel has the focus');
  await page.click('.tc-run-prompt [data-act=cancel]');
  await page.waitForTimeout(1000);
  check((await sh('ls ~/src/lab1 2>&1')).code !== 0 && lab1.calls.length === 0, 'Cancel cloned nothing and asked GitHub nothing');

  // ── Open: clone, the Code app, the Terminal ──
  await boot(withUi('&run=lab:ada/lab1'));
  await page.waitForSelector('.tc-run-prompt', { timeout: 30_000 });
  await page.waitForTimeout(900);
  await page.click('.tc-run-prompt [data-act=run]');
  const opened = await until(async () => { const e = await editor(DIR); return e?.bar ? e : null; }, 120_000);
  check(!!opened, `the Code app opened on ~/src/lab1 with the lab bar${opened ? '' : ` (terminals: ${JSON.stringify(await terminals()).slice(0, 600)})`}`);
  check(opened?.name === 'Lab 1' && opened.run && opened.test && opened.submit, `the bar has Run, Test and Submit (${JSON.stringify(opened && { name: opened.name, run: opened.run, test: opened.test, submit: opened.submit })})`);
  check(opened?.title === 'lab1', `the window is named after the folder (${opened?.title})`);
  const saved0 = await until(async () => { const e = await editor(DIR); return e?.git === 'Saved to GitHub' ? e : null; });
  check(saved0?.gitClass === 'saved', `a fresh clone says "Saved to GitHub" (${(await editor(DIR))?.git})`);
  const term0 = await until(async () => (await terminals()).find((t) => t.cwd === DIR && /ada\/lab1 is open in ~\/src\/lab1/.test(t.text)));
  check(!!term0, 'a Terminal is in the folder and says the lab is open');
  check(lab1.calls.every((c) => !c.startsWith('RAW')) && lab1.calls.length > 0, 'the private repository came through the API with the sign-in');
  check(await wouldAsk() === false, 'nothing to warn about yet');
  const frame = await frameOf(DIR);

  // ── Run and Test ──
  await frame.click('#lab-run');
  const ran = await until(async () => (await terminals()).find((t) => /answer 42/.test(t.text)));
  check(!!ran, 'Run typed the run command in the Terminal: "answer 42"');
  check(/Run started in the Terminal: sh main\.sh/.test((await editor(DIR)).msg), 'the bar says Run started');
  await frame.click('#lab-test');
  check(!!(await until(async () => (await terminals()).find((t) => /tests: 2 passed/.test(t.text)))), 'Test typed the test command: "tests: 2 passed"');
  check((await page.evaluate(() => window.__shiroDesktop.windows().filter((w) => w.kind === 'terminal').length)) === (await terminals()).length && (await terminals()).filter((t) => t.cwd === DIR).length === 1, 'both ran in the one Terminal of the folder');

  // ── An edit: the mark, the titles, the question before the tab closes ──
  const cm = await until(async () => (await editor(DIR)).editorLoaded, 30_000);
  if (cm) {
    const files = (await editor(DIR)).sidebar;
    check(/main\.sh/.test(files) && /test\.sh/.test(files), 'the cloned files are in the file list');
    await shot('1-opened');
    await frame.click('.cm-content');
    await page.keyboard.press('Control+End');
    await page.keyboard.type('echo "edited in the editor"');
    const dirty = await until(async () => { const e = await editor(DIR); return e.git === 'Not saved to GitHub yet' ? e : null; }, 10_000);
    check(/1 file with edits not saved/.test(dirty?.gitDetail ?? ''), `typing shows "Not saved to GitHub yet" before the file is saved (${dirty?.gitDetail})`);
    // Run saves first: the new line's output appears
    await frame.click('#lab-run');
    check(!!(await until(async () => (await terminals()).find((t) => /edited in the editor\n/.test(t.text + '\n') && /answer 42[\s\S]*answer 42/.test(t.text)))), 'Run saved the edit before running it');
  } else {
    console.log('note the editor component did not load (esm.sh): the edit is made from the shell instead');
    await sh(`echo 'echo "edited in the editor"' >> ${DIR}/main.sh`);
  }
  const unsaved = await until(async () => { const e = await editor(DIR); return e.git === 'Not saved to GitHub yet' && /1 changed file/.test(e.gitDetail) ? e : null; }, 20_000);
  check(!!unsaved && unsaved.gitClass === 'unsaved', `the status bar says "Not saved to GitHub yet" (${JSON.stringify(unsaved && { git: unsaved.git, detail: unsaved.gitDetail })})`);
  check((await editor(DIR)).title === 'lab1 · Not saved to GitHub yet', `the window's title says so (${(await editor(DIR)).title})`);
  await shot('2-not-saved');
  check((await page.title()).startsWith('● '), `the tab's title has the dot (${await page.title()})`);
  check(await wouldAsk() === true, 'the tab asks before it closes');
  check((await sh(`cd ${DIR} && lab status`)).out.includes('Not saved to GitHub yet: 1 changed file (github.com/ada/lab1).'), 'lab status says the same');

  // ── Submit ──
  await frame.click('#lab-submit');
  const done = await until(async () => { const e = await editor(DIR); return /^(Submitted|Not submitted|Nothing)/.test(e.msg) ? e : null; }, 60_000);
  check(/^Submitted\. 1 changed file went to github\.com\/ada\/lab1, branch main\. The newest commit there is [0-9a-f]{7}\.$/.test(done?.msg ?? '') && done.msgClass === 'ok', `Submit says what went where (${done?.msg})`);
  const tip = lab1.refs.get('main');
  const commit = tip && parseCommit(lab1.objects.get(tip).bytes);
  const blob = commit && parseTree(lab1.objects.get(commit.tree).bytes).find((e) => e.path === 'main.sh');
  check(tip !== lab1Start && commit?.parents[0] === lab1Start && /edited in the editor/.test(new TextDecoder().decode(lab1.objects.get(blob.sha).bytes)), 'the stand-in GitHub has a new commit with the edit');
  check(/^Submit \d{4}-\d\d-\d\d \d\d:\d\d UTC$/.test(commit?.message.trim() ?? ''), `the commit message is the date (${commit?.message.trim()})`);
  const saved1 = await until(async () => { const e = await editor(DIR); return e.git === 'Saved to GitHub' ? e : null; }, 20_000);
  check(!!saved1 && saved1.title === 'lab1', 'the mark clears: "Saved to GitHub"');
  await shot('3-submitted');
  check(!(await page.title()).startsWith('● ') && await wouldAsk() === false, 'the dot is gone and the tab closes without a question');
  await frame.click('#lab-submit');
  check(!!(await until(async () => /^Nothing to submit\. GitHub already has this work/.test((await editor(DIR)).msg), 30_000)), 'a second Submit says there is nothing to submit');

  // ── Not signed in: lab open runs the device flow, then clones ──
  // (a reload: the shells of this page still carry the sign-in they started with)
  await page.evaluate(() => { localStorage.removeItem('tabcomputer_github_token'); localStorage.removeItem('tabcomputer_network_mode'); });
  await boot(withUi());
  check(leaveQuestions === 0, 'a reload with everything pushed asked nothing');
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__shiroDesktopCtx.openTerminal({ cwd: '/home/user', command: 'export TABCOMPUTER_GIT_TRANSPORT=api; lab open ada/secret', title: 'sign-in' }); });
  const code = await until(() => page.evaluate(() => /WDJB-MJHT/.test(document.body.innerText)), 60_000);
  check(!!code && state.deviceCodes === 1, 'a private repository in a tab that is not signed in starts the GitHub device flow (the code is shown)');
  const SECRET = '/home/user/src/secret';
  const opened2 = await until(async () => { const e = await editor(SECRET); return e?.bar ? e : null; }, 120_000);
  check(!!opened2 && await page.evaluate((t) => localStorage.getItem('tabcomputer_github_token') === t, TOKEN), 'after the sign-in it clones and opens the Code app');
  // (the terminal wraps lines: compare without the white space)
  const squash = (s) => s.replace(/\s+/g, '');
  const said = (await terminals()).map((t) => squash(t.text)).find((t) => t.includes(squash('the repository is private, or the name is wrong')));
  check(!!said && said.indexOf(squash('the repository is private')) < said.indexOf('WDJB-MJHT'), 'the Terminal says why it asks before it asks');
  check(!(await terminals()).some((t) => squash(t.text).includes(TOKEN)), 'and never shows the token');

  // ── Sign-out for a shared computer ──
  await sh(`echo "second line, never pushed" >> ${SECRET}/notes.txt`);
  await until(async () => (await editor(SECRET))?.git === 'Not saved to GitHub yet', 20_000);
  const plan = await sh('signout');
  check(plan.code === 1 && /The GitHub sign-in/.test(plan.out) && /~\/src\/secret: 1 changed file/.test(plan.out) && /Nothing was deleted/.test(plan.out) && !plan.out.includes(TOKEN), 'signout lists the sign-in and the unpushed work, and deletes nothing without --yes');
  await sh('desktop open settings accounts');
  await page.waitForSelector('[data-act=signout-all]', { timeout: 30_000 });
  await page.click('[data-act=signout-all]');
  await page.waitForSelector('.sd-signout-confirm', { timeout: 30_000 });
  const confirm = await page.locator('.sd-signout-confirm').innerText();
  await shot('4-sign-out');
  check(/Sign out of this computer\?/.test(confirm) && /The GitHub sign-in/.test(confirm) && /Every file in this tab computer: the home folder \(\d+ items?\)/.test(confirm), 'Settings, Accounts: the confirm says what is deleted');
  check(/GitHub does not have this work yet\. Signing out deletes it\. Submit or push it first\./.test(confirm) && /~\/src\/secret: 1 changed file/.test(confirm) && !/src\/lab1/.test(confirm), 'it warns about the unpushed work, and only about that');
  check(await page.evaluate(() => document.activeElement?.getAttribute('data-act')) === 'signout-cancel' && !confirm.includes(TOKEN), 'Cancel has the focus, and no token is shown');
  await page.click('[data-act=signout-cancel]');
  check(await page.locator('[data-act=signout-all]').count() === 1 && await page.evaluate((t) => localStorage.getItem('tabcomputer_github_token') === t, TOKEN), 'Cancel deletes nothing');
  await page.click('[data-act=signout-all]');
  await page.waitForSelector('[data-act=signout-confirm]', { timeout: 30_000 });
  const questionsBefore = leaveQuestions;
  await page.click('[data-act=signout-confirm]');
  await page.waitForSelector('#signed-out', { timeout: 60_000 });
  const farewell = await page.locator('body').innerText();
  check(/This computer is signed out/.test(farewell) && /are deleted\. You can close this tab\./.test(farewell), `the tab says it is signed out (${farewell.replace(/\n+/g, ' | ').slice(0, 160)})`);
  check(leaveQuestions === questionsBefore, 'signing out with unpushed work did not also ask "leave site?"');
  const left = await page.evaluate(async () => ({
    local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    dbs: (await indexedDB.databases?.() ?? []).map((d) => d.name), caches: typeof caches === 'undefined' ? [] : await caches.keys(),
  }));
  check(left.local.length === 0 && left.session.length === 0 && left.dbs.length === 0 && left.caches.length === 0, `the origin stores nothing afterwards (${JSON.stringify(left)})`);

  // ── The next student gets an empty computer ──
  await boot(withUi());
  const fresh = await sh('ls ~/src 2>&1; gh auth token 2>&1; echo end');
  check(!/lab1|secret/.test(fresh.out) && !fresh.out.includes(TOKEN), `a new session has no files and no sign-in from before (${fresh.out.trim().replace(/\n/g, ' | ').slice(0, 160)})`);
  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
} catch (e) {
  failed++;
  console.log(`FAIL the script stopped: ${e?.stack ?? e}`);
  try { console.log('terminals:', JSON.stringify(await terminals()).slice(0, 1500)); } catch {}
} finally {
  await browser.close();
}
console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
