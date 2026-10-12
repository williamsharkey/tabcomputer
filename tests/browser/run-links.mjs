// Run links (src/run-url.ts, docs/RUN_LINKS.md) in Chromium. Needs a build and a running
// server, no relay and no Debian:
//   npx vite build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/run-links.mjs [http://localhost:5299/] [--shots DIR]
//
// A test recipe is added to the site's list from here (routes), with a hostile argument value.
//   curated     ?run=<name> runs at once in a new Terminal in ~/run/<name>/ with RUN_* set, and
//               the address loses the link; a second load only runs its on-open line
//   refused     a name the list doesn't have, a traversal, a recipe changed after the list was
//               made, a recipe the server redirects off the site, a run link in a frame
//   gh: / sh:   the whole script in a window with Run and Cancel (markup in it stays text);
//               Cancel runs nothing, Run runs what was shown; it asks again on the next load
//   safe mode   ?safe=1 skips the link
//   terminal UI ?ui=terminal runs it in the page's terminal; the prompt is an overlay
//   phone       the prompt fits a 360 px wide screen
//   shipped     the site's own claude-sandbox and untrusted-repo recipes run (no arguments)
//
// Exits 1 if any check fails.
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
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
const base = args[0] || 'http://localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `: ${detail}` : ''}`); if (!ok) failures++; };
const sha = (s) => createHash('sha256').update(s).digest('hex');
const b64url = (s) => Buffer.from(s).toString('base64url');

const NAME = 'run-links-check';
const RECIPE = `#!/bin/bash
# title: Run links check
# for: tests/browser/run-links.mjs
# args: who, note
# on-open: cd ~/run/${NAME}/work && echo opened >> opens
set -e
mkdir -p work && cd work
pwd > where
echo "who=$RUN_WHO" > who
echo "note=\${RUN_NOTE-unset} extra=\${RUN_EXTRA-unset}" > note
echo ran >> runs
echo "recipe finished"
`;
const HOSTILE = '$(touch /tmp/pwned); echo "x" `touch /tmp/pwned` \'q\' && touch /tmp/pwned > /tmp/pwned #';
// A script whose text tries to become markup in its own prompt
const GH_SCRIPT = `#!/bin/sh
# args: who
# on-open: echo gh-opened >> ~/run/gh-someone-project/log
# </pre><img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script><button data-act="run">Run</button>
echo "gh ran for $RUN_WHO" >> log
`;
const SH_SCRIPT = 'echo "sh ran" >> log\n';

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });

/** A fresh profile whose site has the test recipes besides its own */
async function newContext(options = {}) {
  const ctx = await browser.newContext(options);
  // The welcome card is not part of this check
  await ctx.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  await ctx.route('**/recipes/index.json', async (route) => {
    const res = await route.fetch();
    const list = await res.json();
    list.recipes.push({ name: NAME, sha256: sha(RECIPE) }, { name: 'changed', sha256: sha(RECIPE) }, { name: 'moved', sha256: sha(RECIPE) });
    await route.fulfill({ response: res, json: list });
  });
  const text = (body) => ({ status: 200, contentType: 'text/plain; charset=utf-8', headers: { 'access-control-allow-origin': '*' }, body });
  await ctx.route(`**/recipes/${NAME}.sh`, (route) => route.fulfill(text(RECIPE)));
  await ctx.route('**/recipes/changed.sh', (route) => route.fulfill(text(RECIPE + 'touch /tmp/pwned\n')));
  await ctx.route('**/recipes/moved.sh', (route) => route.fulfill({ status: 302, headers: { location: 'https://elsewhere.example/moved.sh', 'access-control-allow-origin': '*' } }));
  await ctx.route('https://elsewhere.example/**', (route) => route.fulfill(text(RECIPE)));
  await ctx.route('https://raw.githubusercontent.com/**', (route) => {
    const url = route.request().url();
    return url === 'https://raw.githubusercontent.com/someone/project/HEAD/.tabcomputer/run.sh' ? route.fulfill(text(GH_SCRIPT)) : route.fulfill({ status: 404, body: 'Not found' });
  });
  return ctx;
}

async function load(ctx, query) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(new URL(query, base).toString());
  await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 60_000 });
  return page;
}
/** A command in a shell of the check's own; its output */
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const s = Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  s.cwd = '/home/user';
  await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return out.replace(/\r\n/g, '\n').trim();
}, cmd);
const waitFor = async (page, cmd, want, ms = 20_000) => {
  const end = Date.now() + ms;
  let out = '';
  while (Date.now() < end) {
    out = await sh(page, cmd);
    if (want instanceof RegExp ? want.test(out) : out === want) return out;
    await page.waitForTimeout(250);
  }
  return out;
};
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
const prompt = (page) => page.locator('.tc-run-prompt');
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `run-links-${name}.png`) }); };

// ── A curated recipe ────────────────────────────────────────────────
{
  const ctx = await newContext();
  const q = `?run=${NAME}&who=${encodeURIComponent(HOSTILE)}&extra=1&utm_source=mail&profile=tabcomputer`;
  let page = await load(ctx, q);
  const runs = await waitFor(page, `cat ~/run/${NAME}/work/runs`, 'ran');
  check(runs === 'ran', 'curated: the recipe ran once, without a prompt', runs);
  check(await prompt(page).count() === 0, 'curated: no prompt window');
  check(await sh(page, `cat ~/run/${NAME}/work/where`) === `/home/user/run/${NAME}/work`, 'curated: it ran in ~/run/<name>/');
  const who = await sh(page, `cat ~/run/${NAME}/work/who`);
  check(who === `who=${HOSTILE}`, 'curated: RUN_WHO is the link’s value, byte for byte', who);
  check(await sh(page, 'ls /tmp/pwned 2>&1') !== '/tmp/pwned', 'curated: nothing in the value ran');
  const note = await sh(page, `cat ~/run/${NAME}/work/note`);
  check(note === 'note=unset extra=unset', 'curated: an absent argument is unset, an undeclared one is not passed', note);
  await waitFor(page, `cat ~/run/${NAME}/work/opens`, 'opened');
  let wins = await windows(page);
  let win = wins.find((w) => w.cwd === `/home/user/run/${NAME}/work`);
  check(!!win && win.app === 'terminal', 'curated: a new Terminal, left in the on-open directory', JSON.stringify(wins.map((w) => [w.app, w.cwd])));
  check(wins.filter((w) => w.app === 'terminal').length === 2, 'curated: the first Terminal is still there', String(wins.length));
  check(!!win && new RegExp(`running recipe ${NAME} \\(${new URL(base).host}/recipes/${NAME}\\.sh\\)`).test(win.text.replace(/\n/g, '')), 'curated: the Terminal says what runs and from where', win?.text.slice(0, 300));
  check(!!win && /ignored extra, utm_source/.test(win.text.replace(/\n/g, '')), 'curated: it names the parameters it ignored', win?.text.slice(0, 400));
  check(win?.title === 'Run links check', 'curated: the window carries the recipe’s title', win?.title);
  const search = await page.evaluate(() => location.search);
  check(search === '?profile=tabcomputer', 'curated: the address lost the link and its arguments', search);
  await shot(page, 'curated');

  // A reload of the cleaned address runs nothing
  await page.reload();
  await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 60_000 });
  await page.waitForTimeout(2500);
  check(await sh(page, `cat ~/run/${NAME}/work/runs ~/run/${NAME}/work/opens`) === 'ran\nopened', 'curated: a reload runs nothing');
  await page.close();

  // The link again: only on-open
  page = await load(ctx, `?run=${NAME}&who=second`);
  const opens = await waitFor(page, `cat ~/run/${NAME}/work/opens`, 'opened\nopened');
  check(opens === 'opened\nopened', 'second load: on-open ran', opens);
  check(await sh(page, `cat ~/run/${NAME}/work/runs`) === 'ran', 'second load: the recipe did not run again');
  check(await sh(page, `cat ~/run/${NAME}/work/who`) === `who=${HOSTILE}`, 'second load: its files are as the first run left them');
  wins = await windows(page);
  check(wins.some((w) => /is already set up here/.test(w.text.replace(/\n/g, ''))), 'second load: the Terminal says it is already set up');
  await page.close();

  // ── Refused ──
  for (const [q, why, what] of [
    ['?run=not-a-recipe', /run link: no such recipe/, 'a name the list does not have'],
    [`?run=${encodeURIComponent('../' + NAME)}`, /run link: no such recipe/, 'a traversal'],
    [`?run=${encodeURIComponent(`${NAME}.sh`)}`, /run link: no such recipe/, 'a file name'],
    ['?run=changed', /run link: the recipe does not match/, 'a recipe changed after the list was made'],
    ['?run=moved', /run link: could not fetch the recipe/, 'a recipe the server redirects off the site'],
    ['?run=gh:someone/missing', /run link: github.com\/someone\/missing, .tabcomputer\/run.sh does not exist/, 'a repository without a script'],
  ]) {
    page = await load(ctx, q);
    await page.waitForFunction((re) => {
      const buf = window.__tabcomputer.terminal.term.buffer.active;
      let t = '';
      for (let i = 0; i < buf.length; i++) t += buf.getLine(i).translateToString(true);
      return new RegExp(re).test(t);
    }, why.source, { timeout: 15_000 }).catch(() => {});
    const text = (await mainScreen(page)).replace(/\n/g, '');
    check(why.test(text), `refused: ${what}`, text.slice(-300));
    check(await prompt(page).count() === 0, `refused: ${what} shows no prompt`);
    check(!/run=/.test(await page.evaluate(() => location.search)), `refused: ${what} leaves the address clean`);
    await page.close();
  }
  page = await load(ctx, '?ui=terminal');
  check(await sh(page, 'ls /tmp/pwned ~/run/changed ~/run/moved 2>/dev/null') === '', 'refused: none of them ran or left a directory');
  await page.close();

  // In a frame: ignored
  page = await ctx.newPage();
  await page.route('**/framer.html', (route) => route.fulfill({ contentType: 'text/html', body: `<iframe id=f src="/?run=${encodeShLinkPlaceholder()}" style="width:900px;height:600px"></iframe>` }));
  await page.goto(new URL('framer.html', base).toString());
  const frame = page.frameLocator('#f');
  await frame.locator('.xterm').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(4000);
  check(await frame.locator('.tc-run-prompt').count() === 0, 'framed: no prompt inside a frame');
  await page.close();
  await ctx.close();
}
function encodeShLinkPlaceholder() { return 'sh:' + b64url(SH_SCRIPT); }

// ── gh: and sh: ─────────────────────────────────────────────────────
{
  const ctx = await newContext();
  let page = await load(ctx, '?run=gh:someone/project&who=me');
  await prompt(page).waitFor({ timeout: 20_000 });
  check(await prompt(page).locator('pre').textContent() === GH_SCRIPT, 'gh: the prompt shows the whole script');
  const from = await prompt(page).textContent();
  check(/github\.com\/someone\/project, \.tabcomputer\/run\.sh/.test(from) && /not reviewed/.test(from), 'gh: it says where the script is from and that it is not reviewed');
  check(/RUN_WHO/.test(from) && /me/.test(from), 'gh: it shows what the link sets');
  check(await page.evaluate(() => window.__pwned) === undefined && await prompt(page).locator('img, script').count() === 0 && await prompt(page).locator('button').count() === 2,
    'gh: markup in the script stays text');
  check(await sh(page, 'ls ~/run 2>/dev/null') === '', 'gh: nothing is written before the answer');
  check(!/run=/.test(await page.evaluate(() => location.search)), 'gh: the address is clean while it asks');
  await page.waitForTimeout(1000);
  check(await page.evaluate(() => document.activeElement?.dataset.act) === 'cancel', 'gh: Cancel has the focus');
  await shot(page, 'prompt');
  // Enter is Cancel
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  check(await prompt(page).count() === 0, 'gh: Cancel closes the prompt');
  check(await sh(page, 'ls ~/run 2>/dev/null') === '' && (await windows(page)).filter((w) => w.app === 'terminal').length === 1, 'gh: Cancel runs nothing and opens no Terminal');
  await page.close();

  // Closing the window is Cancel too
  page = await load(ctx, '?run=gh:someone/project&who=me');
  await prompt(page).waitFor({ timeout: 20_000 });
  await page.evaluate(() => window.__shiroDesktop.windows().find((w) => w.appId === 'run-link').close());
  await page.waitForTimeout(1500);
  check(await sh(page, 'ls ~/run 2>/dev/null') === '', 'gh: closing the window runs nothing');
  await page.close();

  // Run
  page = await load(ctx, '?run=gh:someone/project&who=me');
  await prompt(page).waitFor({ timeout: 20_000 });
  const runBtn = prompt(page).locator('button[data-act=run]');
  check(await runBtn.isDisabled(), 'gh: Run is off for a moment after the window appears');
  await page.evaluate(() => document.querySelector('.tc-run-prompt button[data-act=run]').click());
  await page.waitForTimeout(300);
  check(await sh(page, 'ls ~/run 2>/dev/null') === '', 'gh: a click made by a script does not run it');
  await page.waitForTimeout(800);
  await runBtn.click();
  let log = await waitFor(page, 'cat ~/run/gh-someone-project/log', 'gh ran for me\ngh-opened');
  check(log === 'gh ran for me\ngh-opened', 'gh: Run runs the script with RUN_WHO, then on-open', log);
  check(await sh(page, 'cat ~/run/gh-someone-project/.recipe.sh') === GH_SCRIPT.trim(), 'gh: what ran is what was shown');
  await page.close();

  // The same link again asks again, and Run only does on-open
  page = await load(ctx, '?run=gh:someone/project&who=me');
  await prompt(page).waitFor({ timeout: 20_000 });
  check(/already ran here/.test(await prompt(page).textContent()), 'gh: the same script asks again on the next load');
  await page.waitForTimeout(900);
  await prompt(page).locator('button[data-act=run]').click();
  log = await waitFor(page, 'cat ~/run/gh-someone-project/log', 'gh ran for me\ngh-opened\ngh-opened');
  check(log === 'gh ran for me\ngh-opened\ngh-opened', 'gh: then only its on-open line runs', log);
  await page.close();

  // sh:
  const shDir = `sh-${sha(SH_SCRIPT).slice(0, 12)}`;
  page = await load(ctx, `?run=sh:${b64url(SH_SCRIPT)}`);
  await prompt(page).waitFor({ timeout: 20_000 });
  check(await prompt(page).locator('pre').textContent() === SH_SCRIPT, 'sh: the prompt shows the script');
  await prompt(page).locator('button[data-act=cancel]').click();
  await page.waitForTimeout(1200);
  check(await sh(page, `ls ~/run/${shDir} 2>/dev/null`) === '', 'sh: Cancel runs nothing');
  await page.close();
  page = await load(ctx, `?run=sh:${b64url(SH_SCRIPT)}`);
  await prompt(page).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(900);
  await prompt(page).locator('button[data-act=run]').click();
  log = await waitFor(page, `cat ~/run/${shDir}/log`, 'sh ran');
  check(log === 'sh ran', 'sh: Run runs it in ~/run/sh-<hash>/', log);
  await page.close();

  // ── Safe mode ──
  page = await load(ctx, `?safe=1&run=sh:${b64url('echo safe >> ~/safe-ran\n')}`);
  await page.waitForTimeout(3000);
  check(await prompt(page).count() === 0 && await sh(page, 'cat ~/safe-ran 2>/dev/null') === '', 'safe mode: the link is skipped');
  await page.close();
  await ctx.close();
}

// ── The terminal UI ─────────────────────────────────────────────────
{
  const ctx = await newContext();
  let page = await load(ctx, `?ui=terminal&run=${NAME}&who=term`);
  const who = await waitFor(page, `cat ~/run/${NAME}/work/who`, 'who=term');
  check(who === 'who=term', 'terminal UI: a curated recipe runs in the page’s terminal', who);
  await waitFor(page, `cat ~/run/${NAME}/work/opens`, 'opened');
  check(await page.evaluate(() => window.__tabcomputer.shell.cwd) === `/home/user/run/${NAME}/work`, 'terminal UI: on-open left the terminal in its directory');
  check(await page.evaluate(() => location.search) === '?ui=terminal', 'terminal UI: the address keeps ?ui=terminal only');
  await page.close();
  page = await load(ctx, `?ui=terminal&run=sh:${b64url(SH_SCRIPT)}`);
  await prompt(page).waitFor({ timeout: 20_000 });
  check(await page.locator('.tc-run-overlay').count() === 1, 'terminal UI: the prompt is an overlay');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(800);
  check(await prompt(page).count() === 0 && await sh(page, 'ls ~/run') === NAME, 'terminal UI: Escape cancels');
  await page.close();
  await ctx.close();
}

// ── A phone ─────────────────────────────────────────────────────────
for (const [name, ui] of [['desktop', ''], ['terminal UI', '&ui=terminal']]) {
  const ctx = await newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const long = '#!/bin/sh\n' + Array.from({ length: 60 }, (_, i) => `echo "line ${i} ${'x'.repeat(40)}"`).join('\n') + '\n';
  const page = await load(ctx, `?run=sh:${b64url(long)}${ui}`);
  await prompt(page).waitFor({ timeout: 20_000 });
  await page.waitForTimeout(800);
  const fit = await page.evaluate(() => {
    const W = innerWidth, H = innerHeight;
    const inside = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.left >= -1 && r.right <= W + 1 && r.top >= -1 && r.bottom <= H + 1; };
    const p = document.querySelector('.tc-run-prompt');
    return {
      prompt: inside(p), run: inside(p.querySelector('[data-act=run]')), cancel: inside(p.querySelector('[data-act=cancel]')),
      scroll: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= W, pre: p.querySelector('pre').scrollHeight > p.querySelector('pre').clientHeight,
    };
  });
  check(fit.prompt && fit.run && fit.cancel && fit.scroll, `phone (${name}): the prompt and both buttons fit 360 px`, JSON.stringify(fit));
  check(fit.pre, `phone (${name}): a long script scrolls inside the prompt`);
  await shot(page, `phone-${name.replace(/\W+/g, '-')}`);
  await prompt(page).locator('button[data-act=cancel]').tap();
  await page.waitForTimeout(800);
  check(await prompt(page).count() === 0, `phone (${name}): Cancel works by touch`);
  await ctx.close();
}

// ── The site's own recipes that need neither Debian nor the network ──
{
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  const load2 = async (q) => {
    const page = await ctx.newPage();
    await page.goto(new URL(q, base).toString());
    await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 60_000 });
    return page;
  };
  let page = await load2('?run=claude-sandbox');
  let done = await waitFor(page, 'ls -a ~/run/claude-sandbox', /\.done-/);
  let wins = await windows(page);
  let win = wins.find((w) => w.cwd === '/home/user/run/claude-sandbox/work');
  check(/\.done-/.test(done) && !!win && /Start with: claude/.test(win.text), 'shipped: claude-sandbox runs and leaves a Terminal in its work directory', JSON.stringify(wins.map((w) => [w.cwd, w.text.slice(-200)])));
  await page.close();
  page = await load2('?run=untrusted-repo');
  done = await waitFor(page, 'ls -a ~/run/untrusted-repo', /\.done-/);
  wins = await windows(page);
  win = wins.find((w) => w.cwd === '/home/user/run/untrusted-repo' && /Inspect with/.test(w.text));
  check(/\.done-/.test(done) && !!win && /\(none\)/.test(win.text), 'shipped: untrusted-repo runs with nothing to look at', JSON.stringify(wins.map((w) => [w.cwd, w.text.slice(-300)])));
  await page.close();

  // The gallery
  page = await ctx.newPage();
  await page.goto(new URL('recipes', base).toString());
  await page.waitForSelector('.card', { timeout: 15_000 });
  const cards = await page.evaluate(() => [...document.querySelectorAll('.card')].map((c) => [c.querySelector('h2').firstChild.textContent, c.querySelector('a.run').getAttribute('href')]));
  check(cards.length >= 6 && cards.some(([t, h]) => t === 'C programming class' && h === '/?run=c-class'), 'gallery: /recipes has a card and a Run link per recipe', JSON.stringify(cards));
  await shot(page, 'gallery');
  await ctx.close();
}

await browser.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
