// Links written after the # of the address (src/link-fragment.ts, docs/RUN_LINKS.md
// "After the #", tabcomputer#147) in Chromium, at 1280 px and on a 390 x 844 touch screen.
// Needs a build and a running server; no relay and no Debian:
//   npx vite build && PORT=6871 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/link-is-computer.mjs [http://localhost:6871/] [--only NAME[,NAME]] [--shots DIR] [--theme light|dark]
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
//   link       `link` after a short session (with two lines that cancel out and a file that came from
//              outside), its QR code read back by the browser's own reader, and its link opened in a
//              second fresh profile
//   relay      (only when asked for by name, on a server with the relay on) what link says the
//              setup sent through the relay
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
// The desktop's appearance for the whole run: dark (the default) or light
const theme = opt('--theme') === 'light' ? 'light' : 'dark';
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

// A browser that has run one part's checks is big, and a machine with little memory ends it: each part
// (each screen of each kind) gets a browser of its own.
const launch = async () => {
  const b = await pw.chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
  b.on('disconnected', () => { if (b === browser && !closing) console.log('the browser went away'); });
  return b;
};
let closing = false;
let browser = await launch();
const relaunch = async () => { closing = true; await browser.close().catch(() => {}); closing = false; browser = await launch(); };

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
  await ctx.addInitScript((theme) => { try { if (window.top === window) localStorage.setItem('tabcomputer-desktop-theme', theme); } catch {} }, theme);
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
    // what a person reads at once: the sentences outside the disclosures, and the buttons
    says: [...el.querySelectorAll(':scope > p')].map((p) => p.innerText.replace(/\s*\n\s*/g, ' ')), buttons: [...el.querySelectorAll('[class$=actions] button')].map((b) => b.textContent),
    more: [...el.querySelectorAll('summary')].map((s) => s.textContent), guest: el.querySelector('details [data-act=guest]')?.textContent ?? '',
    left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), sw: el.scrollWidth, cw: el.clientWidth,
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
  await relaunch();
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
    && p.says.join(' | ') === 'From this link. Not reviewed by tabcomputer. | The commands: 1 line. | They run as you: they can read and change every file in this tab and use its sign-ins (Claude, GitHub).', JSON.stringify(p && { title: p.title, box: p.box, says: p.says }));
  // a phone has no room for a desktop around a question: the prompt is the screen
  if (device.hasTouch) check('phone commands: the prompt fills the screen, with nothing of the desktop around it', !!p && p.left === 0 && p.right === device.viewport.width && p.top === 0 && p.bottom === device.viewport.height && p.buttons.join() === 'Cancel,Run', JSON.stringify(p && { left: p.left, right: p.right, top: p.top, bottom: p.bottom }));
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
  await relaunch();
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
    && p.says.join(' | ') === `From this link. Not reviewed by tabcomputer. | The app says: Try a jq filter. ${mark} | Jq two runs this command as you type: jq {filter} | The app fills the command with these: | jq is an ordinary program in this tab: it can read and change every file here.`, p?.says.join(' | '));
  // two buttons; the rest, and a guest where the server has them, is one click away
  check(`${D} app: Cancel and Install are the only buttons, and the rest is under two disclosures`, !!p && p.buttons.join() === 'Cancel,Install' && p.more.join(' | ') === 'What it can reach | app.json, as it will be installed' && (p.guest === '' || p.guest === 'open it in a guest'), JSON.stringify(p && { buttons: p.buttons, more: p.more, guest: p.guest }));
  if (phone) check('phone app: the prompt fills the screen, with nothing of the desktop around it', !!p && p.left === 0 && p.right === device.viewport.width && p.top === 0 && p.bottom === device.viewport.height, JSON.stringify(p && { left: p.left, right: p.right, top: p.top, bottom: p.bottom }));
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
  const mode = await page.evaluate((id) => {
    const wm = window.__shiroDesktop, w = wm?.focused?.(), r = w?.element?.getBoundingClientRect?.();
    return { become: document.body.classList.contains('become-active'), path: location.pathname, hash: location.hash,
      // the desktop's phone layout (#154) shows the app on the whole screen, with the pill, instead
      layout: !!document.getElementById('shiro-desktop')?.classList.contains('sd-phone'), focused: w?.appId ?? null, whole: !!r && Math.round(r.width) === innerWidth };
  }, id);
  const asApp = mode.layout ? !mode.become && mode.focused === id && mode.whole : mode.become && mode.path === `/${id}`;
  check(`${D} app: Install opens it${phone ? ' as the app' : ' in a window'}, and it works`, first === '"Ada"\n"Grace"\n' && (phone ? asApp : !mode.become) && mode.hash === '', JSON.stringify({ first, mode }));
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
  check(`${D} app: a table's prompt says what it keeps and that it runs no program`, p.says.slice(2).join(' | ') === 'Costs keeps a table in costs.csv, in its own data folder. | It runs no program, and its page may use only its own data folder.', p.says.join(' | '));
  await shot(page, `${D}-table-prompt`);
  await agree(page, APP, 'install');
  f = await ready(page, "costs");
  const heads = f && await f.evaluate(() => [...document.querySelectorAll('th')].map((e) => e.textContent.trim()).filter(Boolean).join(','));
  check(`${D} app: the table opens with the link's columns`, !!f && /Date.*What.*Category.*Amount/.test(String(heads)), String(heads));
  await page.close();
  if (phone) { page = await open(ctx, `${base}?unbecome`); await booted(page); await page.close(); }

  page = await open(ctx, typed('run=tesseract {in} stdout pdf&accept=.png,.jpg&name=Make scans searchable&needs=tesseract-ocr'));
  await page.waitForSelector(APP, { timeout: 90_000 });
  p = await promptOf(page, APP);
  // (the link the coordinator opened on production: five things to read, where there were eight sentences)
  check(`${D} app: the issue's own example: the question, where from, the command, what it installs, what it can touch`, p.title === 'Install Make scans searchable?' && p.says.join(' | ') === [
    'From this link. Not reviewed by tabcomputer.', 'Make scans searchable runs this command once for each file you give it: tesseract {in} stdout pdf',
    'Before its first start it installs the Debian package tesseract-ocr.', 'tesseract is an ordinary program in this tab: it can read and change every file here.',
  ].join(' | '), p.says.join(' | '));
  await shot(page, `${D}-needs-prompt`);
  await page.click(`${APP} summary`);
  await shot(page, `${D}-needs-prompt-reach`);
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
  await relaunch();
  const ctx = await newContext(device);
  let page = await open(ctx, `${base}#gist:${GIST_APP}`);
  await page.waitForSelector(APP, { timeout: 90_000 }).catch(() => null);
  let p = await promptOf(page, APP);
  check(`${D} gist: a gist with an app.json is an app, asked for like any app from a gist`, !!p && p.text.includes(`From gist.github.com/${GIST_APP} at revision ${REV.slice(0, 10)}`)
    && p.says.includes('Upper case runs this command once for each file you give it: sed -e s/a/A/g {in}') && p.focus === 'cancel' && p.hash === '', p?.says.join(' | '));
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
  await relaunch();
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

// ── link: a link from what was done, opened in a second fresh profile ──
/** Enter a line at a Terminal window's prompt, as a person would, and wait for it to end */
async function typeLine(page, line, ms = 30_000) {
  await page.evaluate(async (line) => {
    const wm = window.__shiroDesktop;
    const term = () => wm.windows().map((w) => w.content?.activeTerminal?.()).find(Boolean);
    if (!term()) await wm.openApp('terminal');
    for (let i = 0; i < 100 && !term(); i++) await new Promise((r) => setTimeout(r, 50));
    window.__linkTerm = term();
    window.__linkTerm.injectInput(line + '\r');
  }, line);
  await page.waitForTimeout(150);
  await page.waitForFunction(() => window.__linkTerm.foregroundLine === null, null, { timeout: ms });
}
/** Keys for a program that reads them one at a time (an editor) */
const keys = async (page, text) => { for (const ch of text) { await page.evaluate((c) => window.__linkTerm.injectInput(c), ch); await page.waitForTimeout(25); } };
const linkWindow = (page) => page.evaluate(() => {
  const el = document.querySelector('.tc-link');
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const part = (n) => el.querySelector(`[data-part=${n}]`);
  return {
    script: part('script').value, size: part('size').textContent, downloads: part('downloads')?.textContent ?? '', link: part('link').value,
    dropped: part('dropped')?.querySelector('summary')?.textContent ?? '', why: [...(part('dropped')?.querySelectorAll('li') ?? [])].map((li) => li.textContent),
    gist: !el.querySelector('[data-act=gist]').hidden, left: Math.round(r.left), right: Math.round(r.right), sw: el.scrollWidth, cw: el.clientWidth,
  };
});

if (wants('link')) for (const device of DEVICES) {
  const D = device.name;
  await relaunch();
  const mark = secret(`zqlink${D}mark`);
  const vim = secret(`zqvim${D}mark`);
  const ctx = await newContext(device);
  let page = await open(ctx, base);
  await booted(page);
  // a short session with what a person does: a mistake, a look around, a cd that nets out, an editor
  await typeLine(page, 'mkdir zqsite && cd zqsite');
  await typeLine(page, `echo '<h1>${mark}</h1>' > index.html`);
  await typeLine(page, 'ls');
  await typeLine(page, 'cat nope.txt');
  await typeLine(page, 'cd /tmp');
  await typeLine(page, 'cd ~/zqsite');
  // vi: insert a line, save, quit
  await page.evaluate(() => window.__linkTerm.injectInput('vi notes.txt\r'));
  await page.waitForTimeout(1500);
  await keys(page, `i${vim}\x1b:wq\r`);
  const edited = await until(page, async () => { const r = await side(page, 'cat ~/zqsite/notes.txt'); return r.o.includes(vim) ? r.o : null; }, 15_000);
  check(`${D} link: the editor wrote its file (the session has an edited file)`, !!edited, String(edited));
  await page.waitForFunction(() => window.__linkTerm.foregroundLine === null, null, { timeout: 15_000 }).catch(() => {});
  await typeLine(page, `echo '<h1>${mark}</h1>' > index.html`);
  await typeLine(page, 'pwd');
  // two lines that cancel out, and a file that came from the person's own computer
  await typeLine(page, 'touch scratch.txt');
  await typeLine(page, 'rm scratch.txt');
  await page.evaluate(async () => {
    await window.__tabcomputer.fs.writeFile('/home/user/zqsite/photo.bin', new Uint8Array(2300));
    // (what the upload command and a drop on the file manager do after writing the file: src/session-log.ts)
    window.__tabcomputer.live('src/session-log.ts').noteArrived('/home/user/zqsite/photo.bin');
  });

  // (the line entered twice stays where it was entered last, after the editor's file)
  const want = `mkdir zqsite && cd zqsite\ncat > notes.txt <<'EOF'\n${vim}\nEOF\necho '<h1>${mark}</h1>' > index.html\n`;
  const script = await side(page, 'link --script');
  check(`${D} link: the script keeps what changed something, in the folder it ran in, with the editor's file as it is now`, script.o === want + 'cd ~', script.o);
  const why = (await side(page, 'link --why')).o;
  check(`${D} link: link --why says why each other line went`, /cat nope\.txt\n\s+left out: it failed \(status 1\)/.test(why) && /ls\n\s+left out: looking around/.test(why) && /cd \/tmp\n\s+left out: a change of folder/.test(why)
    && /vi notes\.txt\n\s+left out: an editor/.test(why) && /left out: entered again later/.test(why), why);
  check(`${D} link: a file made and then removed is in neither line of the script`, /touch scratch\.txt\n\s+left out: undone later \(rm scratch\.txt\)/.test(why) && /rm scratch\.txt\n\s+left out: it only undid an earlier line \(touch scratch\.txt\)/.test(why) && !script.o.includes('scratch'), why);
  const said = (await side(page, 'link | cat')).o;
  check(`${D} link: a file that came from the person's computer is named as not in the link`, said.includes('~/zqsite/photo.bin (3 KB, from your computer) is not in the link.'), said.slice(-600));
  const printed = (await side(page, 'link --print')).o;
  check(`${D} link: link --print is an address with the script after its #, readable`, printed.startsWith(`${origin}/#mkdir%20zqsite%20&&%20cd%20zqsite%0Acat%20%3E%20notes.txt%20`) && printed.endsWith('%0Acd%20~') && printed.length < 2000, printed);

  // typed at the prompt: the window, with the script to edit
  await typeLine(page, 'link');
  await page.waitForSelector('.tc-link', { timeout: 15_000 }).catch(() => null);
  let w = await linkWindow(page);
  // (typed in ~/zqsite, so the script ends there and needs no last cd)
  check(`${D} link: the Link window shows the script, the form it fits and what it downloaded`, !!w && w.script === want && /^The script fits in a link a person can read: \d+ characters\.$/.test(w.size)
    && w.downloads === 'What the script downloaded here: The commands in the link downloaded nothing here.' && w.link === `${origin}/#${printed.slice(origin.length + 2).replace(/%0Acd%20~$/, '')}`, JSON.stringify(w));
  check(`${D} link: it says how many lines were left out, and why`, !!w && /^\d+ lines were left out$/.test(w.dropped) && w.why.some((x) => x === 'cat nope.txt: it failed (status 1)') && w.why.some((x) => x === 'link: the link command itself'), JSON.stringify(w && [w.dropped, w.why]));
  check(`${D} link: the window fits`, !!w && w.left >= 0 && w.right <= device.viewport.width && w.sw <= w.cw, JSON.stringify(w && { left: w.left, right: w.right, sw: w.sw, cw: w.cw }));
  await shot(page, `${D}-link-window`);
  // the link as a QR code, read back by the browser's own reader (not by anything of ours)
  const readQr = () => page.evaluate(async () => {
    const svg = document.querySelector('.tc-link [data-part=qr] svg');
    if (!svg) return { error: 'no code is drawn' };
    if (!('BarcodeDetector' in window)) return { error: 'this browser has no BarcodeDetector' };
    const img = new Image();
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg.outerHTML);
    await img.decode();
    const canvas = document.createElement('canvas');
    canvas.width = img.width; canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
    try {
      const found = await new BarcodeDetector({ formats: ['qr_code'] }).detect(canvas);
      return { text: found[0]?.rawValue ?? '', found: found.length, side: img.width, link: document.querySelector('.tc-link [data-part=link]').value };
    } catch (e) { return { error: String(e) }; }
  });
  await page.click('.tc-link [data-act=qr]');
  let qr = await readQr();
  if (qr.error && /BarcodeDetector/.test(qr.error)) console.log(`skip ${D} link: the QR code was not read back: ${qr.error}`);
  else check(`${D} link: the QR code reads back as the link, by the browser's reader`, qr.found === 1 && qr.text === qr.link && qr.text.length > 60, JSON.stringify({ ...qr, text: qr.text?.slice(0, 80), link: qr.link?.length }));
  await shot(page, `${D}-link-qr`);
  // the person changes the script: the link follows
  await page.fill('.tc-link [data-part=script]', want + `echo ${mark} > edited.txt\n`);
  const made = await until(page, async () => { const x = await linkWindow(page); return x.link.endsWith('edited.txt') ? x : null; }, 5000);
  check(`${D} link: an edit in the window changes the link and its length`, !!made && made.size === `The script fits in a link a person can read: ${made.link.length} characters.`, JSON.stringify(made && [made.size, made.link.length]));
  const link = made?.link ?? '';
  // the code follows the link too; a dense one still reads back (words that do not repeat, so
  // that the link stays long however it is written)
  qr = await readQr();
  if (!qr.error) check(`${D} link: the QR code follows the edited link`, qr.text === link, JSON.stringify({ found: qr.found, side: qr.side }));
  let rnd = 20261013;
  const word = (n) => Array.from({ length: n }, () => 'abcdefghijklmnopqrstuvwxyz0123456789'[(rnd = (rnd * 1103515245 + 12345) % 2147483648) >> 16 & 31]).join('');
  await page.fill('.tc-link [data-part=script]', Array.from({ length: 34 }, () => `echo ${word(44)}`).join('\n') + '\n');
  const dense = await until(page, async () => { const x = await linkWindow(page); return x.link.length > 1200 ? x : null; }, 5000);
  qr = await readQr();
  if (!qr.error) check(`${D} link: a link of ${dense?.link.length} characters reads back from its code too`, !!dense && qr.found === 1 && qr.text === dense.link, JSON.stringify({ found: qr.found, side: qr.side, got: qr.text?.length }));
  await shot(page, `${D}-link-qr-dense`);
  await page.fill('.tc-link [data-part=script]', want + `echo ${mark} > edited.txt\n`);
  await until(page, async () => { const x = await linkWindow(page); return x.link === link ? x : null; }, 5000);
  // a script too long for any link: only then is a gist offered, and it needs the person's click
  check(`${D} link: no gist is offered for a script that fits a link`, !!made && !made.gist);
  await page.evaluate(() => { try { localStorage.setItem('tabcomputer_github_token', 'gho_standin'); } catch {} });
  let posted = null;
  // (this site's GitHub proxy, or GitHub itself where the network mode is private)
  for (const where of ['**/api/github/gists', 'https://api.github.com/gists']) await ctx.route(where, (route) => {
    posted = { method: route.request().method(), auth: route.request().headers().authorization, body: JSON.parse(route.request().postData() ?? '{}') };
    return route.fulfill({ status: 201, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ id: GIST_SH, owner: { login: 'octocat' } }) });
  });
  let noise = '', seed = 7;
  while (noise.length < 70_000) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; noise += seed.toString(36); }
  await page.fill('.tc-link [data-part=script]', `echo ${noise}\n`);
  const long = await until(page, async () => { const x = await linkWindow(page); return x.gist ? x : null; }, 8000);
  check(`${D} link: a script too long for a link says so, has no link, and offers a gist`, !!long && long.link === '' && /^The script is too long for a link: [\d,]+ characters compressed, and a link holds up to 48,000\. A gist can hold it\. Making a gist needs a GitHub sign-in\.$/.test(long.size), JSON.stringify(long && [long.size, long.link.length]));
  check(`${D} link: nothing was sent to GitHub before the button`, posted === null);
  await page.click('.tc-link [data-act=gist]');
  const gisted = await until(page, async () => { const x = await linkWindow(page); return x.link.includes('#gist:') ? x : null; }, 8000);
  check(`${D} link: Make a gist sends the script to GitHub as a secret gist and gives #gist:USER/ID`, !!gisted && gisted.link === `${origin}/#gist:octocat/${GIST_SH}` && posted?.method === 'POST' && posted.auth === 'Bearer gho_standin'
    && posted.body.public === false && posted.body.files['setup.sh'].content === `echo ${noise}\n`, JSON.stringify(gisted && gisted.link));
  await page.click('.tc-link [data-act=close]');
  // (gone before the next one opens: a window still closing is read first otherwise)
  await page.waitForSelector('.tc-link', { state: 'detached', timeout: 10_000 }).catch(() => {});
  // the System menu's item opens the same window
  if (!device.hasTouch) {
    await page.click('[aria-label="System menu"]');
    await page.click('text=Share This Setup as a Link…');
    await page.waitForSelector('.tc-link', { timeout: 10_000 }).catch(() => null);
    w = await linkWindow(page);
    check(`${D} link: System → Share This Setup as a Link… opens the window with the same script`, !!w && w.script.startsWith(want), JSON.stringify(w && w.script));
  }
  // the session is the tab's: a reload keeps it
  await page.waitForTimeout(1200);
  await page.reload();
  await booted(page);
  const kept = (await side(page, 'link --script')).o;
  check(`${D} link: a reload of the tab keeps the session, so link still has the script`, kept === want + 'cd ~', kept);
  await page.close();
  await done(ctx, `${D} link`);

  // a second fresh profile opens the link: asked, then the same place
  const other = await newContext(device);
  const t0 = Date.now();
  page = await open(other, link);
  await page.waitForSelector(RUN, { timeout: 90_000 }).catch(() => null);
  const p = await promptOf(page, RUN);
  check(`${D} link: in a second fresh profile the link shows the same script, and asks`, !!p && p.box === want + `echo ${mark} > edited.txt\n` && p.focus === 'cancel' && p.hash === '', JSON.stringify(p && { box: p.box, focus: p.focus }));
  await agree(page, RUN, 'run');
  const same = await until(page, async () => {
    const r = await side(page, 'cat ~/zqsite/index.html ~/zqsite/notes.txt ~/zqsite/edited.txt');
    return r.o === `<h1>${mark}</h1>\n${vim}\n${mark}` ? r.o : null;
  }, 30_000);
  time(`${D} link: its link in a second profile, from opening it to the same files (the click included)`, Date.now() - t0);
  check(`${D} link: Run there makes the same files`, !!same, (await side(page, 'ls -la ~/zqsite; cat ~/zqsite/*')).o);
  const where = await until(page, async () => (await windows(page)).find((x) => x.title === 'From a link' && x.cwd === '/home/user/zqsite'), 10_000);
  check(`${D} link: and leaves the Terminal in the same folder`, !!where, JSON.stringify((await windows(page)).map((x) => [x.title, x.cwd])));
  await page.close();
  await done(other, `${D} link (second profile)`);
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
    await relaunch();
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
    check(`${D} times: the C hello's prompt shows its shell line and what it installs (not installed here: it needs Debian)`, !!p && p.text.replace(/\s+/g, ' ').includes('C hello runs this shell line when you choose Run: cat > hello.c && gcc -o hello hello.c && ./hello')
      && p.text.includes('Before its first start it installs the C and C++ toolchain.'), p?.text.replace(/\n+/g, ' | ').slice(0, 400));
    await ctx.close();
  }
}

// ── the relay's bytes in link's downloads line: needs a server with the relay on ──
// The server under test must allow this machine's own address and the stand-in's port:
//   TABCOMPUTER_TCP_RELAY=1 TABCOMPUTER_TCP_ORIGINS=<the site's origin> TABCOMPUTER_TCP_PORTS=80,443,6877 \
//   TABCOMPUTER_TCP_ALLOW_CIDRS=<this machine's address>/32
// and the check is asked for by name: --only relay
if (only?.includes('relay')) {
  const [{ createServer }, { networkInterfaces }] = await Promise.all([import('node:http'), import('node:os')]);
  const address = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address;
  const PORT = 6877, BYTES = 6_000_000;
  // a site that sends no CORS headers: the page's fetch cannot have it, so curl goes over the relay
  const standIn = createServer((req, res) => {
    const size = req.url === '/big.bin' ? BYTES : 2000;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(size) });
    res.end(Buffer.alloc(size, 0x61));
  });
  await new Promise((r) => standIn.listen(PORT, '0.0.0.0', r));
  const ctx = await newContext(WIDE);
  const page = await open(ctx, base);
  await booted(page);
  await typeLine(page, `curl -s -o small.txt http://${address}:${PORT}/small.txt`, 60_000);
  let said = (await side(page, 'link | cat')).o;
  const got = (await side(page, 'wc -c < ~/small.txt')).o.trim();
  check('relay: curl of a site without CORS headers went over the relay and wrote the file', got === '2000', `${got} bytes; ${(await mainScreen(page)).slice(-300)}`);
  const line = (text) => text.split('\n').find((l) => l.startsWith('What the script downloaded here:')) ?? '';
  check('relay: link says what went through the relay, by host and size', new RegExp(`Through this site's relay: ${address.replace(/\./g, '\\.')} \\d+(\\.\\d+)? KB\\.`).test(line(said)) && !/costs this site/.test(said), line(said));
  // (the browser tried first and was refused: that is no download, and is not said as one)
  check('relay: a file the browser refused is not said to have come straight from the browser', !/Straight from the browser/.test(line(said)), line(said));
  console.log(`  relay, small: ${line(said)}`);
  await typeLine(page, `curl -s -o big.bin http://${address}:${PORT}/big.bin`, 120_000);
  said = (await side(page, 'link | cat')).o;
  check('relay: more than 5 MB through the relay gets the warning', /Through this site's relay: [\d.]+ 6\.\d MB\./.test(line(said)) && /MB went through this site's relay\. The relay is the part that costs this site each time someone opens the link\./.test(said), said.split('\n').filter((l) => /relay/.test(l)).join(' | '));
  console.log(`  relay, 6 MB: ${said.split('\n').filter((l) => /relay/.test(l)).join(' | ')}`);
  await typeLine(page, 'link');
  await page.waitForSelector('.tc-link', { timeout: 15_000 }).catch(() => null);
  const w = await page.evaluate(() => ({ downloads: document.querySelector('.tc-link [data-part=downloads]')?.textContent, warning: document.querySelector('.tc-link [data-part=warning]')?.textContent }));
  check('relay: the Link window shows the same line and the warning', /Through this site's relay/.test(w.downloads ?? '') && /costs this site/.test(w.warning ?? ''), JSON.stringify(w));
  await shot(page, 'relay-link-window');
  await ctx.close();
  standIn.close();
}

closing = true;
await browser.close();
if (times.length) {
  console.log('\ntimes (ms):');
  for (const [what, ms] of times) console.log(`  ${String(ms).padStart(7)}  ${what}`);
}
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
