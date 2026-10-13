// Links written after the # of the address (src/link-fragment.ts, docs/RUN_LINKS.md
// "After the #", tabcomputer#147) in Chromium, at 1280 px and on a 390 x 844 touch screen.
// Needs a build and a running server; no relay and no Debian:
//   npx vite build && PORT=6871 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/link-is-computer.mjs [http://localhost:6871/] [--only NAME[,NAME]] [--shots DIR]
//
//   commands   #mkdir … typed by hand, from a fresh profile: the address is cleaned, the Run / Cancel
//              window shows the commands whole, Cancel has the focus, a click made by script does
//              nothing, Cancel runs nothing; Run runs them in the home folder and a cd stays; the
//              next visit asks nothing and runs nothing. #sh:, %0A, a # inside a command
//   app        #run=…&name=… : the install prompt shows the app's sentences, Cancel installs
//              nothing, Install opens it (as the app on the phone), the same link again does not
//              ask; a link whose key is wrong says which key; needs is named in the prompt
//   gist       #gist:ID against a stand-in GitHub: an app.json is an app, otherwise the first script
//   guards     a frame, ?safe=1, a link pasted into a tab that is already open
//   page       /link: the box, the address beside it and its length, the examples, Open
//   link       `link` after a short session, and its link opened in a second fresh profile
//   times      each /link example from its link to working (python and flask need the network)
//
// Every request of every page is recorded: none may carry a link's commands or its manifest.
// Exits 1 if any check fails.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';

const pw = loadPlaywright();
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const only = opt('--only')?.split(',');
const base = args[0] || 'http://localhost:6871/';
const origin = new URL(base).origin;
if (shots) mkdirSync(shots, { recursive: true });
const wants = (name) => !only || only.includes(name);

let failures = 0;
const check = (what, ok, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `: ${detail}` : ''}`); if (!ok) failures++; };
const times = [];
const time = (what, ms) => { times.push([what, ms]); };

const WIDE = { name: '1280', viewport: { width: 1280, height: 800 } };
const PHONE = { name: 'phone', viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };
const DEVICES = [WIDE, PHONE];

const browser = await pw.chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });

// ── a stand-in for GitHub: a gist that is an app, and one that is a script ──
const GIST_APP = 'abcdef0123456789abcdef0123456789';
const GIST_SH = '0123456789abcdef0123456789abcdef';
const REV = 'beef'.padEnd(40, '1');
const GIST_APP_JSON = '{\n  "name": "Upper case",\n  "about": "Makes a copy of each text file with every a as a capital A.",\n  "accept": [".txt"],\n  "run": "sed -e s/a/A/g {in}"\n}\n';
const GIST_SCRIPT = 'echo "gist zqgistmark ran" >> log\n';

/** Every request a context made: its address, its headers and what it sent */
const requests = new WeakMap();
/** Words that are only ever in a link's part after the #: none may be in any request */
const SECRETS = new Set();
const secret = (word) => { SECRETS.add(word); return word; };

async function newContext(device, { welcome = false } = {}) {
  const { name: _n, ...opts } = device;
  const ctx = await browser.newContext({ ...opts, acceptDownloads: true });
  const seen = [];
  requests.set(ctx, seen);
  ctx.on('request', (r) => { seen.push(`${r.method()} ${r.url()}\n${JSON.stringify(r.headers())}\n${r.postData() ?? ''}`); });
  const cors = { 'access-control-allow-origin': '*' };
  await ctx.route('https://api.github.com/**', (route) => {
    const u = route.request().url();
    const gist = (id, files) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify({ id, owner: { login: 'octocat' }, history: [{ version: REV }], files }) });
    if (u === `https://api.github.com/gists/${GIST_APP}`) return gist(GIST_APP, { 'README.md': { filename: 'README.md', truncated: false, content: '# Upper case\n' }, 'app.json': { filename: 'app.json', truncated: false, content: GIST_APP_JSON } });
    if (u === `https://api.github.com/gists/${GIST_SH}`) return gist(GIST_SH, { 'notes.md': { filename: 'notes.md', truncated: false, content: 'notes\n' }, 'setup.sh': { filename: 'setup.sh', truncated: false, content: GIST_SCRIPT } });
    return route.fulfill({ status: 404, contentType: 'text/plain', headers: cors, body: 'Not Found' });
  });
  await ctx.route('https://gist.githubusercontent.com/**', (route) => (route.request().url() === `https://gist.githubusercontent.com/octocat/${GIST_SH}/raw/setup.sh`
    ? route.fulfill({ status: 200, contentType: 'text/plain; charset=utf-8', headers: cors, body: GIST_SCRIPT })
    : route.fulfill({ status: 404, contentType: 'text/plain', headers: cors, body: 'Not Found' })));
  if (!welcome) await ctx.addInitScript(() => { try { if (window.top === window) localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  return ctx;
}
/** Close a context after checking that none of its requests carried what only a link's # part held */
async function done(ctx, what) {
  const seen = requests.get(ctx) ?? [];
  const leaks = [];
  for (const word of SECRETS) for (const r of seen) if (r.includes(word) || r.includes(encodeURIComponent(word))) leaks.push(`${word} in ${r.split('\n')[0].slice(0, 120)}`);
  check(`${what}: none of its ${seen.length} requests carried the link`, leaks.length === 0 && seen.length > 0, leaks.slice(0, 3).join('; '));
  await ctx.close();
}

const booted = (page) => page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished') && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
async function open(ctx, address) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(address);
  return page;
}
const side = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__tabcomputer.shell.fork(); s.terminal = null; s.cwd = '/home/user'; let o = '';
  const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; });
  return { code, o: o.replace(/\r\n/g, '\n').trim() };
}, cmd);
const until = async (page, fn, ms = 20_000) => { const t0 = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t0 > ms) return v; await page.waitForTimeout(100); } };
/** Desktop windows: app, title, the active terminal's directory and what it shows */
const windows = (page) => page.evaluate(() => (window.__shiroDesktop?.windows() ?? []).map((w) => {
  const term = w.content?.activeTerminal?.();
  const buf = term?.term.buffer.active;
  let text = '';
  if (buf) for (let i = 0; i < buf.length; i++) text += buf.getLine(i).translateToString(true) + '\n';
  return { app: w.appId, title: w.title, cwd: w.content?.cwd?.(), text: text.trim() };
}));
const mainScreen = (page) => page.evaluate(() => {
  const buf = window.__tabcomputer.terminal.term.buffer.active;
  let text = '';
  for (let i = 0; i < buf.length; i++) text += buf.getLine(i).translateToString(true) + '\n';
  return text.trim();
});
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `link-${name}.png`) }); };
/** What a prompt window shows, where it is, and what has the focus */
const promptOf = (page, sel) => page.evaluate((sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return {
    text: el.innerText, title: el.querySelector('h3')?.textContent ?? '', box: el.querySelector('pre')?.textContent ?? '',
    left: Math.round(r.left), right: Math.round(r.right), sw: el.scrollWidth, cw: el.clientWidth,
    focus: document.activeElement?.getAttribute('data-act'), hash: location.hash, search: location.search,
  };
}, sel);
const RUN = '.tc-run-prompt', APP = '.tc-app-prompt';
/** A person's click on the button that agrees, once it is armed */
async function agree(page, sel, act) {
  await page.waitForFunction(([sel, act]) => { const b = document.querySelector(`${sel} [data-act=${act}]`); return b && !b.disabled; }, [sel, act], { timeout: 10_000 });
  await page.click(`${sel} [data-act=${act}]`);
}
const FRAME = (id) => `iframe[data-app="${id}"]`;
async function inner(page, id) {
  const outer = await (await page.$(FRAME(id)))?.contentFrame();
  if (!outer) return null;
  return /\/__tabcomputer\/frame\.html/.test(outer.url()) ? outer.childFrames()[0] ?? null : outer;
}
const ready = (page, id, ms = 60_000) => until(page, async () => { const f = await inner(page, id); return (await f?.evaluate(() => document.documentElement.getAttribute('data-ready') === '1')) ? f : null; }, ms);
/** The part after # as a browser gets it from a person: typed, blanks and all */
const typed = (text) => `${base}#${text}`;

// ── commands ────────────────────────────────────────────────────────
if (wants('commands')) for (const device of DEVICES) {
  const D = device.name;
  const mark = secret(`zqcmd${D}mark`);
  const commands = `mkdir -p ~/linked && cd ~/linked && echo ${mark} > note.txt # a note`;
  const ctx = await newContext(device);
  const t0 = Date.now();
  let page = await open(ctx, typed(commands));
  // the address is cleaned at the top of boot, long before the prompt
  const early = await page.evaluate(() => ({ hash: location.hash, href: location.href }));
  check(`${D} commands: the part after # is gone from the address before boot is over`, early.hash === '' && !early.href.includes('#'), early.href);
  await page.waitForSelector(RUN, { timeout: 90_000 }).catch(() => null);
  time(`${D} commands: link to the Run / Cancel window (fresh profile)`, Date.now() - t0);
  let p = await promptOf(page, RUN);
  check(`${D} commands: the window shows the commands whole, with Run and Cancel`, !!p && p.title === 'Run these commands?' && p.box === commands + '\n'
    && p.text.includes('From the link itself. tabcomputer has not reviewed it.') && p.text.includes('They run in a new Terminal, in your home folder.'), JSON.stringify(p && { title: p.title, box: p.box }));
  check(`${D} commands: Cancel has the focus, and the window fits`, !!p && p.focus === 'cancel' && p.left >= 0 && p.right <= device.viewport.width && p.sw <= p.cw, JSON.stringify(p && { focus: p.focus, left: p.left, right: p.right, sw: p.sw, cw: p.cw }));
  check(`${D} commands: the address has no link in it`, !!p && p.hash === '' && p.search === '', JSON.stringify(p && { hash: p.hash, search: p.search }));
  await shot(page, `${D}-commands-prompt`);
  // a click made by script, and a click before Run is armed, do nothing
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('.tc-run-prompt [data-act=run]').click());
  await page.waitForTimeout(600);
  check(`${D} commands: a click made by script runs nothing`, await page.locator(RUN).count() === 1 && (await side(page, 'ls ~/linked ~/run 2>&1')).o.includes('No such file'));
  await page.click(`${RUN} [data-act=cancel]`);
  await page.waitForTimeout(800);
  const after = await side(page, 'ls ~/linked ~/run 2>&1');
  check(`${D} commands: Cancel runs nothing and writes nothing`, await page.locator(RUN).count() === 0 && !/note\.txt|sh-/.test(after.o) && (await windows(page)).every((w) => w.title !== 'From a link'), after.o);
  await page.close();

  // again: asked again (nothing ran), then Run
  page = await open(ctx, typed(commands));
  await page.waitForSelector(RUN, { timeout: 90_000 });
  const t1 = Date.now();
  await agree(page, RUN, 'run');
  const note = await until(page, async () => { const r = await side(page, 'cat ~/linked/note.txt'); return r.o === mark ? r.o : null; }, 30_000);
  time(`${D} commands: Run to the file being there`, Date.now() - t1);
  check(`${D} commands: Run runs what was shown`, note === mark, String(note));
  const term = await until(page, async () => (await windows(page)).find((w) => w.title === 'From a link' && w.cwd === '/home/user/linked'), 15_000);
  check(`${D} commands: they ran in the Terminal's own shell, so its cd stayed`, !!term, JSON.stringify((await windows(page)).map((w) => [w.title, w.cwd])));
  const marker = await until(page, async () => { const r = await side(page, 'ls -a ~/run/*/'); return /\.done-/.test(r.o) ? r.o : null; }, 15_000);
  check(`${D} commands: the finished commands leave their marker in ~/run`, !!marker, String(marker));
  await page.close();

  // a third visit: nothing is asked and nothing runs
  page = await open(ctx, base);
  await booted(page);
  await side(page, 'echo changed > ~/linked/note.txt');
  await page.close();
  page = await open(ctx, typed(commands));
  await booted(page);
  const again = await until(page, async () => (await windows(page)).find((w) => w.title === 'From a link' && /already ran here/.test(w.text)), 30_000);
  check(`${D} commands: the next visit asks nothing and says they already ran here`, !!again && await page.locator(RUN).count() === 0, JSON.stringify((await windows(page)).map((w) => [w.title, w.text.slice(-120)])));
  check(`${D} commands: and it ran nothing`, (await side(page, 'cat ~/linked/note.txt')).o === 'changed');
  await page.close();

  // #sh:, a line break as %0A, an assignment first
  const two = secret(`zqsh${D}mark`);
  page = await open(ctx, `${base}#sh:name=${two}; echo $name > ~/two.txt%0Aecho three > ~/three.txt`);
  await page.waitForSelector(RUN, { timeout: 90_000 });
  p = await promptOf(page, RUN);
  check(`${D} commands: #sh: is commands whatever follows, and %0A is a line break`, p.box === `name=${two}; echo $name > ~/two.txt\necho three > ~/three.txt\n`, p.box);
  await agree(page, RUN, 'run');
  const both = await until(page, async () => { const r = await side(page, 'cat ~/two.txt ~/three.txt'); return r.o === `${two}\nthree` ? r.o : null; }, 30_000);
  check(`${D} commands: both lines ran`, !!both, String(both));
  await page.close();
  await done(ctx, `${D} commands`);
}

// ── a one-file app ──────────────────────────────────────────────────
if (wants('app')) for (const device of DEVICES) {
  const D = device.name;
  const phone = !!device.hasTouch;
  const ctx = await newContext(device);
  // (the app's id is the one thing of the link a server learns, once the app is open: it is in the
  // host name of the app page's own origin. So the mark is in everything but the name.)
  const mark = secret(`zqapp${D}mark`);
  secret('select(.age');
  // the jq playground, written by hand: a form that runs as it opens
  const link = typed(`name=Jq two&about=Try a jq filter. ${mark}&field.filter=Filter&field.filter.value=.people[] | select(.age > 30) | .name&field.json=JSON&field.json.type=long text&field.json.value={"people": [{"name": "Ada", "age": 36}, {"name": "Linus", "age": 21}, {"name": "Grace", "age": 45}], "note": "${mark}"}&run=jq {filter}&stdin={json}&live=true`);
  const id = 'jq-two';
  const t0 = Date.now();
  let page = await open(ctx, link);
  await page.waitForSelector(APP, { timeout: 90_000 }).catch(() => null);
  time(`${D} app: link to the install prompt (fresh profile)`, Date.now() - t0);
  let p = await promptOf(page, APP);
  check(`${D} app: the prompt shows the app's sentences: where from, the exact command`, !!p && p.title === "Install Jq two?"
    && p.text.includes('From the link itself, which holds the whole app. tabcomputer has not reviewed it.')
    && p.text.includes("Jq two runs this command as you type: jq {filter}") && p.text.includes(mark) && p.text.includes('jq is an ordinary program in this tab'), p?.text.replace(/\n+/g, ' | ').slice(0, 400));
  check(`${D} app: Cancel has the focus, the prompt fits, and the address has no link in it`, !!p && p.focus === 'cancel' && p.left >= 0 && p.right <= device.viewport.width && p.sw <= p.cw && p.hash === '' && p.search === '', JSON.stringify(p && { focus: p.focus, left: p.left, right: p.right, hash: p.hash }));
  await shot(page, `${D}-app-prompt`);
  await page.waitForTimeout(900);
  await page.evaluate(() => document.querySelector('.tc-app-prompt [data-act=install]').click());
  await page.waitForTimeout(500);
  check(`${D} app: a click made by script installs nothing`, await page.locator(APP).count() === 1 && !(await side(page, 'app list')).o.includes(id));
  await page.click(`${APP} [data-act=cancel]`);
  await page.waitForTimeout(800);
  check(`${D} app: Cancel installs nothing`, await page.locator(APP).count() === 0 && !(await side(page, 'app list; ls ~/Apps 2>&1')).o.includes(id) && !(await page.$(FRAME(id))));
  await page.close();

  page = await open(ctx, link);
  await page.waitForSelector(APP, { timeout: 90_000 });
  const t1 = Date.now();
  await agree(page, APP, 'install');
  let f = await ready(page, id);
  const first = f && await until(page, () => f.evaluate(() => (window.__app?.output ? window.__app.output : null)), 30_000);
  time(`${D} app: Install to its first result`, Date.now() - t1);
  const mode = await page.evaluate(() => ({ become: document.body.classList.contains('become-active'), path: location.pathname, hash: location.hash }));
  check(`${D} app: Install opens it${phone ? ' as the app' : ' in a window'}, and it works`, first === '"Ada"\n"Grace"\n' && mode.become === phone && (!phone || mode.path === `/${id}`) && mode.hash === '', JSON.stringify({ first, mode }));
  const installed = await side(page, `app list -l; cat ~/Apps/${id}/app.json`);
  check(`${D} app: what is installed is one app.json, from the link`, /link:[0-9a-f]{16}/.test(installed.o) && installed.o.includes('"run": "jq {filter}"') && (await side(page, `ls ~/Apps/${id}`)).o === 'app.json', installed.o.slice(0, 300));
  // app share gives the readable form back
  const share = (await side(page, `app share ${id} --print`)).o;
  check(`${D} app: app share gives a link of words`, share.startsWith(`${origin}/#name=Jq%20two&about=Try%20a%20jq%20filter.%20${mark}&`) && share.includes('&run=jq%20%7Bfilter%7D'), share.slice(0, 160));
  await shot(page, `${D}-app-open`);
  await page.close();

  // the same link again: no prompt
  const t2 = Date.now();
  page = await open(ctx, link);
  f = await ready(page, id);
  time(`${D} app: the same link again, to the usable app`, Date.now() - t2);
  check(`${D} app: the same link again opens the installed copy without asking`, !!f && await page.locator(APP).count() === 0);
  await page.close();
  // phone: leave app mode for what follows
  if (phone) { page = await open(ctx, `${base}?unbecome`); await booted(page); await page.close(); }

  // a table, and an app that needs a Debian package (shown, not installed here)
  page = await open(ctx, typed(`name=Costs&about=${mark}&table=costs.csv&columns=Date:date,What,Category:Food|Travel,Amount:number`));
  await page.waitForSelector(APP, { timeout: 90_000 });
  p = await promptOf(page, APP);
  check(`${D} app: a table's prompt says what it keeps and that it runs no program`, p.text.includes('keeps a table in costs.csv') && p.text.includes('It runs no program.'), p.text.replace(/\n+/g, ' | ').slice(0, 300));
  await agree(page, APP, 'install');
  f = await ready(page, "costs");
  const heads = f && await f.evaluate(() => [...document.querySelectorAll('th')].map((e) => e.textContent.trim()).filter(Boolean).join(','));
  check(`${D} app: the table opens with the link's columns`, !!f && /Date.*What.*Category.*Amount/.test(String(heads)), String(heads));
  await page.close();
  if (phone) { page = await open(ctx, `${base}?unbecome`); await booted(page); await page.close(); }

  page = await open(ctx, typed('run=tesseract {in} stdout pdf&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr'));
  await page.waitForSelector(APP, { timeout: 90_000 });
  p = await promptOf(page, APP);
  check(`${D} app: the issue's own example shows what it runs and what it installs`, p.text.includes('Make scans searchable runs this command once for each file you give it: tesseract {in} stdout pdf')
    && p.text.includes('Before its first start it installs the Debian package tesseract-ocr.'), p.text.replace(/\n+/g, ' | ').slice(0, 400));
  await page.click(`${APP} [data-act=cancel]`);
  await page.close();

  // a key that is wrong: no prompt, and the terminal names the key
  page = await open(ctx, typed(`run=cat {in}&name=Wrong one&about=${mark}&acept=.txt`));
  await booted(page);
  const said = await until(page, async () => { const s = await mainScreen(page); return /unknown key acept/.test(s) ? s : null; }, 20_000);
  check(`${D} app: a link with a wrong key installs nothing and names the key`, !!said && /link: the app in the link is not valid/.test(said) && await page.locator(APP).count() === 0, String(said).slice(-300));
  await page.close();
  await done(ctx, `${D} app`);
}

// ── a gist ──────────────────────────────────────────────────────────
if (wants('gist')) for (const device of DEVICES) {
  const D = device.name;
  const ctx = await newContext(device);
  let page = await open(ctx, `${base}#gist:${GIST_APP}`);
  await page.waitForSelector(APP, { timeout: 90_000 }).catch(() => null);
  let p = await promptOf(page, APP);
  check(`${D} gist: a gist with an app.json is an app, asked for like any app from a gist`, !!p && p.text.includes(`From gist.github.com/${GIST_APP} at revision ${REV.slice(0, 10)}`)
    && p.text.includes('Upper case runs this command once for each file you give it: sed -e s/a/A/g {in}') && p.focus === 'cancel' && p.hash === '', p?.text.replace(/\n+/g, ' | ').slice(0, 300));
  const asked = (requests.get(ctx) ?? []).filter((r) => r.startsWith(`GET https://api.github.com/gists/${GIST_APP}`)).length;
  check(`${D} gist: GitHub was asked for the gist once`, asked === 1, `${asked} requests`);
  await agree(page, APP, 'install');
  const f = await ready(page, 'upper-case');
  check(`${D} gist: Install installs that revision`, !!f && (await side(page, 'app list -l')).o.includes(`gist:${GIST_APP}@${REV}`));
  await page.close();
  if (device.hasTouch) { page = await open(ctx, `${base}?unbecome`); await booted(page); await page.close(); }

  page = await open(ctx, `${base}#gist:${GIST_SH}`);
  await page.waitForSelector(RUN, { timeout: 90_000 }).catch(() => null);
  p = await promptOf(page, RUN);
  check(`${D} gist: any other gist shows its first script, with Run and Cancel`, !!p && p.title === 'Run this script?' && p.box === GIST_SCRIPT
    && p.text.includes(`From gist.github.com/octocat/${GIST_SH}, setup.sh`) && p.focus === 'cancel' && p.hash === '', JSON.stringify(p && { title: p.title, box: p.box, text: p.text.slice(0, 200) }));
  await page.click(`${RUN} [data-act=cancel]`);
  await page.waitForTimeout(600);
  check(`${D} gist: Cancel runs nothing`, (await side(page, 'ls ~/run 2>&1')).o.includes('No such file'));
  await page.close();
  page = await open(ctx, `${base}#gist:octocat/${GIST_SH}`);
  await page.waitForSelector(RUN, { timeout: 90_000 });
  await agree(page, RUN, 'run');
  const log = await until(page, async () => { const r = await side(page, `cat ~/run/gist-octocat-${GIST_SH.slice(0, 12)}-setup-sh/log`); return /zqgistmark/.test(r.o) ? r.o : null; }, 30_000);
  check(`${D} gist: Run runs it in its own folder under ~/run`, !!log, String(log));
  await page.close();
  await ctx.close();
}

// ── a frame, safe mode, a tab that is already open ─────────────────
if (wants('guards')) {
  const ctx = await newContext(WIDE);
  const mark = secret('zqguardmark');
  let page = await ctx.newPage();
  await page.route('**/framer.html', (route) => route.fulfill({ contentType: 'text/html', body: `<iframe id=f src="/#echo ${mark} > ~/framed.txt" style="width:900px;height:600px"></iframe>` }));
  await page.goto(new URL('framer.html', base).toString());
  const frame = page.frameLocator('#f');
  await frame.locator('.xterm').first().waitFor({ timeout: 90_000 });
  await page.waitForTimeout(5000);
  const inFrame = page.frames().find((fr) => fr !== page.mainFrame() && fr.url().startsWith(origin));
  const framed = await inFrame.evaluate(() => ({ prompt: !!document.querySelector('.tc-run-prompt, .tc-app-prompt'), hash: location.hash, said: (() => { const b = window.__tabcomputer.terminal.term.buffer.active; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i).translateToString(true) + '\n'; return t; })() }));
  check('guards: a framed page takes no link, cleans its address and says why', !framed.prompt && framed.hash === '' && /ignored inside a frame/.test(framed.said), JSON.stringify({ prompt: framed.prompt, hash: framed.hash, said: framed.said.trim().slice(-160) }));
  await page.close();

  page = await open(ctx, `${base}?safe=1#echo ${mark} > ~/safe.txt`);
  await page.waitForFunction(() => !!window.__tabcomputer?.terminal, null, { timeout: 90_000 });
  await page.waitForTimeout(4000);
  const safe = await page.evaluate(() => ({ prompt: !!document.querySelector('.tc-run-prompt, .tc-app-prompt'), hash: location.hash }));
  check('guards: ?safe=1 skips the link, and the link still leaves the address', !safe.prompt && safe.hash === '' && (await side(page, 'ls ~/safe.txt ~/framed.txt ~/run 2>&1')).o.split('\n').every((l) => l.includes('No such file')), JSON.stringify(safe));
  await page.close();

  // a tab that is already open: the link pasted into its address changes only the part after #
  page = await open(ctx, base);
  await booted(page);
  await page.waitForTimeout(1500);
  await page.evaluate((m) => { location.hash = `#echo ${m} > ~/pasted.txt`; }, mark);
  await page.waitForSelector(RUN, { timeout: 30_000 }).catch(() => null);
  const p = await promptOf(page, RUN);
  check('guards: a link pasted into an open tab is taken from the address and asked for', !!p && p.box === `echo ${mark} > ~/pasted.txt\n` && p.hash === '' && p.focus === 'cancel', JSON.stringify(p && { box: p.box, hash: p.hash, focus: p.focus }));
  await page.click(`${RUN} [data-act=cancel]`);
  await page.waitForTimeout(500);
  check('guards: and Cancel runs nothing', (await side(page, 'ls ~/pasted.txt 2>&1')).o.includes('No such file'));
  // the Welcome card: not on a visit that came for a link, there on the next one
  await page.close();
  const fresh = await newContext(WIDE, { welcome: true });
  page = await open(fresh, typed(`echo ${mark}`));
  await page.waitForSelector(RUN, { timeout: 90_000 });
  await page.waitForTimeout(2500);
  check('guards: a visit that came for a link shows no Welcome card', !(await page.$('.sd-welcome')));
  await page.close();
  page = await open(fresh, base);
  await booted(page);
  check('guards: the Welcome card shows on the next visit without a link', !!(await until(page, () => page.evaluate(() => !!document.querySelector('.sd-welcome')), 10_000)));
  await done(fresh, 'guards (welcome)');
  await done(ctx, 'guards');
}

// ── the /link page ──────────────────────────────────────────────────
if (wants('page')) for (const device of DEVICES) {
  const D = device.name;
  const ctx = await newContext(device);
  let page = await open(ctx, new URL('link', base).toString());
  await page.waitForFunction(() => document.querySelectorAll('#examples button').length >= 5 && document.getElementById('address').textContent.length > 10, null, { timeout: 30_000 });
  const read = () => page.evaluate(() => ({
    box: document.getElementById('box').value, address: document.getElementById('address').textContent, reads: document.getElementById('reads').textContent,
    size: document.getElementById('size').textContent, href: document.getElementById('open').getAttribute('href'), off: document.getElementById('open').getAttribute('aria-disabled'),
    w: innerWidth, sw: document.documentElement.scrollWidth, examples: [...document.querySelectorAll('#examples button')].map((b) => b.textContent),
    side: (() => { const a = document.getElementById('box').getBoundingClientRect(), b = document.getElementById('address').getBoundingClientRect(); return b.left >= a.right - 1; })(),
  }));
  let s = await read();
  check(`${D} page: it opens with an example, its address beside it${device.hasTouch ? ' (below it on a phone)' : ''} and its length`, s.box === 'python3 -c "print(sum(range(101)))"'
    && s.address === `${origin}/#python3%20-c%20%22print(sum(range(101)))%22` && s.size === `The address is ${s.address.length} characters long.` && s.reads === 'The box is read as commands.' && s.side === !device.hasTouch, JSON.stringify(s));
  check(`${D} page: it fits the screen`, s.sw <= s.w, `${s.sw} > ${s.w}`);
  check(`${D} page: five examples`, s.examples.join('|') === 'A Python one-liner|A Flask hello|The jq playground|An expenses table|A C hello', s.examples.join('|'));
  // typing changes the address at once
  const mark = secret(`zqpage${D}mark`);
  await page.fill('#box', `echo ${mark} > ~/from-page.txt`);
  s = await read();
  check(`${D} page: typing changes the address and its length`, s.address === `${origin}/#echo%20${mark}%20%3E%20~/from-page.txt` && s.href === s.address && s.off === 'false' && s.size.includes(`${s.address.length} characters`), s.address);
  await page.fill('#box', `name=Tidy ${mark}\nrun=jq . {in}\naccept=.json`);
  s = await read();
  check(`${D} page: an app is one key on each line, and the page says how it is read`, s.address === `${origin}/#name=Tidy%20${mark}&run=jq%20.%20%7Bin%7D&accept=.json` && s.reads === 'The box is read as an app, because it starts with name=.', `${s.address} / ${s.reads}`);
  await page.fill('#box', '');
  s = await read();
  check(`${D} page: an empty box has no address, and Open is off`, s.address === '' && s.off === 'true' && s.href === null && s.reads === 'The box is empty.', JSON.stringify(s));
  const lengths = {};
  for (const name of s.examples) {
    await page.click(`#examples button:text-is("${name}")`);
    const e = await read();
    lengths[name] = e.address.length;
  }
  console.log(`${D} /link example addresses, in characters (origin ${origin}): ${JSON.stringify(lengths)}`);
  await shot(page, `${D}-page`);
  // Open: the address the page wrote is one the app takes
  await page.fill('#box', `echo ${mark} > ~/from-page.txt`);
  const href = (await read()).href;
  await page.goto(href);
  await page.waitForSelector(RUN, { timeout: 90_000 }).catch(() => null);
  const p = await promptOf(page, RUN);
  check(`${D} page: Open leads to the Run / Cancel window with what was typed`, !!p && p.box === `echo ${mark} > ~/from-page.txt\n` && p.hash === '', JSON.stringify(p && { box: p.box, hash: p.hash }));
  await page.click(`${RUN} [data-act=cancel]`);
  await page.close();
  await done(ctx, `${D} page`);
}

// ── each /link example, from its link to working ───────────────────
if (wants('times')) {
  const ctx0 = await newContext(WIDE);
  const pg = await open(ctx0, new URL('link', base).toString());
  await pg.waitForFunction(() => document.querySelectorAll('#examples button').length >= 5, null, { timeout: 30_000 });
  const links = {};
  for (const name of ['A Python one-liner', 'A Flask hello', 'The jq playground', 'An expenses table', 'A C hello']) {
    await pg.click(`#examples button:text-is("${name}")`);
    links[name] = await pg.evaluate(() => document.getElementById('open').getAttribute('href'));
  }
  await ctx0.close();
  for (const device of DEVICES) {
    const D = device.name;
    // commands: from the link to their result, the person's click included
    for (const [name, works, ms] of [
      ['A Python one-liner', async (page) => (await windows(page)).some((w) => w.title === 'From a link' && /^5050$/m.test(w.text)), 240_000],
      ['A Flask hello', async (page) => /Hello from a link/.test((await side(page, `python3 -c 'import urllib.request as u; print(u.urlopen("http://127.0.0.1:5000/", timeout=5).read().decode())' 2>&1`)).o), 300_000],
    ]) {
      const ctx = await newContext(device);
      const t0 = Date.now();
      const page = await open(ctx, links[name]);
      await page.waitForSelector(RUN, { timeout: 90_000 }).catch(() => null);
      const tPrompt = Date.now() - t0;
      await agree(page, RUN, 'run').catch(() => {});
      const t1 = Date.now();
      const ok = await until(page, () => works(page), ms);
      check(`${D} times: ${name} works from its link (needs the network)`, !!ok, JSON.stringify((await windows(page)).filter((w) => w.title === 'From a link').map((w) => w.text.slice(-400))));
      if (ok) time(`${D} ${name}: link to the window ${tPrompt} ms, Run to working`, Date.now() - t1);
      await ctx.close();
    }
    for (const [name, id, works] of [
      ['The jq playground', 'jq-playground', (f) => f.evaluate(() => window.__app?.output === '"Ada"\n"Grace"\n')],
      ['An expenses table', 'expenses', (f) => f.evaluate(() => document.querySelectorAll('th').length >= 5)],
    ]) {
      const ctx = await newContext(device);
      const t0 = Date.now();
      const page = await open(ctx, links[name]);
      await page.waitForSelector(APP, { timeout: 90_000 }).catch(() => null);
      const tPrompt = Date.now() - t0;
      await agree(page, APP, 'install').catch(() => {});
      const t1 = Date.now();
      const f = await ready(page, id);
      const ok = f && await until(page, () => works(f), 30_000);
      check(`${D} times: ${name} works from its link`, !!ok);
      if (ok) time(`${D} ${name}: link to the prompt ${tPrompt} ms, Install to working`, Date.now() - t1);
      await ctx.close();
    }
    // the C hello needs gcc from Debian (needs=c): its prompt is checked, its install is not run here
    const ctx = await newContext(device);
    const page = await open(ctx, links['A C hello']);
    await page.waitForSelector(APP, { timeout: 90_000 }).catch(() => null);
    const p = await promptOf(page, APP);
    check(`${D} times: the C hello's prompt shows its shell line and what it installs (not installed here: it needs Debian)`, !!p && p.text.includes('C hello runs this shell line when you choose Run: cat > hello.c && gcc -o hello hello.c && ./hello')
      && p.text.includes('Before its first start it installs the Debian package c.'), p?.text.replace(/\n+/g, ' | ').slice(0, 400));
    await ctx.close();
  }
}

await browser.close();
if (times.length) {
  console.log('\ntimes (ms):');
  for (const [what, ms] of times) console.log(`  ${String(ms).padStart(7)}  ${what}`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
