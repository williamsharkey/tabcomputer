// How Your Data Flows (src/data-flow.ts, src/desktop/apps/dataflow.ts, docs/DATA_FLOW.md) in
// Chromium. Needs a build and a running server, no relay and no Debian:
//   npx vite build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/data-flow.mjs [http://app.localhost:5299/] [--shots DIR]
//
// The base is app.localhost, as in guest-profile.mjs: its guests (guest--x.app.localhost) are
// other origins of the same site.
//
//   welcome     the first-run card has a "How your data flows" button, and it opens the window
//   main        the diagram says main profile, no sign-ins; every part explains itself on hover,
//               tap and from the keyboard; text is DOM text, not an image
//   planted     a fake GitHub token, Claude credential, API key and a relay URL with a secret in
//               it show as present (or as a host), and none of their values is anywhere in the
//               DOM, in an attribute, or in `dataflow`'s output
//   elsewhere   System → How Your Data Flows, Help, Settings → Network; the actions go where
//               they say
//   guest       a guest (network, then no network) says so, shows no sign-ins, and marks what
//               is off; the main profile's fake token is not there
//   360 px      the lanes stack, nothing scrolls sideways, light and dark
//   terminal    ?ui=terminal has no card: `dataflow` prints the same state
//
// Exits 1 if any check fails.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const require = createRequire(import.meta.url);
let pw;
pw = loadPlaywright();
const { chromium } = pw;
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const base = args[0] || 'http://app.localhost:5299/';
if (shots) mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `: ${detail}` : ''}`); if (!ok) failures++; };
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

const TOKEN = 'ghp_FAKEdataflowcheck7f3a9cFAKEdataflow00';
const CLAUDE = 'sk-ant-oat01-FAKE-dataflow-check-access';
const APIKEY = 'sk-ant-api03-FAKE-dataflow-check-key';
const RELAY_SECRET = 'RELAYQUERYSECRETFAKE';
const SECRETS = [TOKEN, CLAUDE, APIKEY, RELAY_SECRET];

const browser = await chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });

async function load(ctx, url) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(new URL(url, base).toString());
  await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
  return page;
}
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const s = Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  s.cwd = '/home/user';
  const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return `${out.replace(/\r\n/g, '\n').trim()}\n[exit ${code}]`;
}, cmd);
const openFlow = async (page) => {
  await page.evaluate(() => window.__tabcomputer.desktop.openApp('dataflow'));
  await page.waitForSelector('.sd-df[data-ready] .sd-df-lane', { timeout: 20_000 });
};
/** What the window shows, read from the DOM */
const read = (page) => page.evaluate(() => {
  const df = document.querySelector('.sd-df');
  const lanes = [...df.querySelectorAll('.sd-df-lane')].map((l) => ({
    id: l.dataset.flow, status: l.dataset.status, reads: l.dataset.reads, text: l.innerText,
    carries: [...l.querySelectorAll('.sd-df-carries')].map((c) => c.textContent),
  }));
  return {
    headline: df.querySelector('.sd-df-headline')?.textContent ?? '',
    profile: df.querySelector('.sd-df-headline')?.dataset.profile ?? '',
    tab: [...df.querySelectorAll('.sd-df-place[data-place=tab] li')].map((li) => li.textContent),
    places: [...df.querySelectorAll('.sd-df-place-title')].map((t) => t.textContent),
    lanes,
    actions: [...df.querySelectorAll('.sd-df-actions [data-act]')].map((b) => b.dataset.act),
    unavailable: [...df.querySelectorAll('[data-unavailable]')].map((b) => b.textContent),
    detail: df.querySelector('.sd-df-detail')?.textContent ?? '',
    images: df.querySelectorAll('img, canvas, image').length,
    text: df.innerText,
  };
});
/** Every place a value could hide: the whole document's markup (text and attributes) */
const domHas = (page, secrets) => page.evaluate((secrets) => {
  const html = document.documentElement.outerHTML;
  const values = [...document.querySelectorAll('input, textarea')].map((i) => i.value).join('\n');
  return secrets.filter((s) => html.includes(s) || values.includes(s));
}, secrets);
const sideways = (page) => page.evaluate(() => {
  const s = document.querySelector('.sd-df .sd-scroll');
  return { page: document.documentElement.scrollWidth - innerWidth, win: s.scrollWidth - s.clientWidth };
});
const lane = (state, id) => state.lanes.find((l) => l.id === id);

// ── welcome: a fresh profile's card has the button ──
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const main = await load(ctx, '/');
await main.waitForSelector('.sd-welcome', { timeout: 30_000 });
const btn = main.locator('.sd-welcome [data-act=dataflow]');
check(await btn.count() === 1 && (await btn.textContent()).trim() === 'How your data flows', 'welcome: the card has a "How your data flows" button');
await main.waitForFunction(() => !document.querySelector('.sd-welcome').getAnimations().length, null, { timeout: 5000 }).catch(() => {});
await shot(main, 'welcome-card');
await btn.click();
await main.waitForSelector('.sd-df[data-ready] .sd-df-lane', { timeout: 20_000 });
check(await main.locator('.sd-welcome').count() === 1, 'welcome: the card stays up beside the window');
await main.locator('.sd-welcome .sd-btn[data-act=close]').click();
await main.waitForTimeout(300);

// ── main: no sign-ins ──
let s = await read(main);
check(s.profile === 'main' && s.headline.startsWith('Your files stay in this browser'), 'main: says main profile, no sign-ins', s.headline);
check(s.places.length === 3 && s.places[0] === 'This tab' && /server$/.test(s.places[1]) && s.places[2] === 'The internet', 'main: three places: this tab, the server, the internet', s.places.join(' | '));
check(s.tab.includes('GitHub: not signed in') && s.tab.includes('Claude: not signed in') && !s.tab.some((l) => l.startsWith('API keys')), 'main: no token, no Claude credentials, no API keys', s.tab.join(' | '));
check(s.tab.some((l) => /^Files: saved in this browser( \(it may delete them\))?$/.test(l)), 'main: says where the files are, and when the browser may delete them', s.tab.join(' | '));
// (this server runs without TABCOMPUTER_TCP_RELAY: the window must say so rather than assume one)
const relayLine = s.tab.find((l) => l.startsWith('Relay:')) ?? '';
const relayOn = await main.evaluate(async () => { try { const r = await fetch('/tcp/token', { method: 'POST', credentials: 'omit' }); return typeof (await r.json()).token === 'string'; } catch { return false; } });
check(relayOn ? relayLine === '' : relayLine === 'Relay: none', `main: the relay line matches this server (relay ${relayOn ? 'on' : 'off'})`, relayLine);
check(lane(s, 'tcp').status === (relayOn ? 'on' : 'off'), 'main: the connections lane is on only when there is a relay');
check(s.lanes.length === 8 && s.lanes.map((l) => l.reads).join() === 'nothing,requests,requests,endpoints,contents,contents,nothing,contents', 'main: eight lanes, each with what the server can read', s.lanes.map((l) => `${l.id}:${l.reads}`).join(' '));
check(lane(s, 'api').text.includes('Can read it') && lane(s, 'tcp').text.includes('Sees the address only'), 'main: "Can read it" on the API lane, "Sees the address only" on the relay lane');
check(s.lanes.every((l) => l.carries.length === 0), 'main: no lane carries a sign-in');
check(s.images === 0, 'main: no images: the diagram is DOM text');
check(s.actions.includes('guest') && s.actions.includes('guest-nonet') && s.actions.includes('network') && !s.actions.includes('accounts'), 'main: offers a guest (localhost has them) and network settings; no sign-out with nothing signed in', s.actions.join());
const side = await sideways(main);
check(side.page <= 0 && side.win <= 0, 'main: nothing scrolls sideways', JSON.stringify(side));
// columns: a lane's three cells sit under the three places
const cols = await main.evaluate(() => {
  const x = (el) => Math.round(el.getBoundingClientRect().left);
  const places = [...document.querySelectorAll('.sd-df-place')].map(x);
  const cells = [...document.querySelectorAll('.sd-df-lane[data-flow=api] .sd-df-node')].map(x);
  return { places, cells };
});
await main.evaluate(() => window.__tabcomputer.desktop.setTheme('dark'));
await main.waitForTimeout(200);
check(cols.cells.length === 3 && cols.cells.every((c, i) => Math.abs(c - cols.places[i]) < 30) && cols.places[0] < cols.places[1] && cols.places[1] < cols.places[2], 'main: side by side, a lane\'s cells under their places', JSON.stringify(cols));
await shot(main, 'main-dark');

// hover, tap, keyboard
await main.locator('.sd-df-lane[data-flow=api]').hover();
check((await read(main)).detail.includes('can read your prompts'), 'hover: pointing at a lane explains it');
await main.locator('.sd-df-place[data-place=tab]').hover();
check((await read(main)).detail.includes('Any program you run in this tab can read'), 'hover: pointing at a place explains it');
await main.locator('.sd-df-lane[data-flow=tcp]').click();
await main.locator('.sd-df h2').hover();
s = await read(main);
check(s.detail.includes('cannot read https or ssh') && await main.locator('.sd-df-lane[data-flow=tcp]').getAttribute('aria-pressed') === 'true', 'click: a chosen lane stays explained');
await shot(main, 'main-dark-lane-chosen');
await main.locator('.sd-df-place[data-place=tab]').focus();
for (let i = 0; i < 3; i++) await main.keyboard.press('Tab');
const focused = await main.evaluate(() => document.activeElement?.dataset?.key ?? '');
check(focused === 'flow:local', 'keyboard: Tab goes from the places to the lanes', focused);
await main.keyboard.press('Tab');
await main.keyboard.press('Enter');
s = await read(main);
check(s.detail.includes('Our server sees which files are downloaded') && await main.locator('.sd-df-lane[data-flow=site]').getAttribute('aria-pressed') === 'true', 'keyboard: Enter on a lane explains it', s.detail);

// light
await main.evaluate(() => window.__tabcomputer.desktop.setTheme('light'));
await main.waitForTimeout(200);
await shot(main, 'main-light');
await main.evaluate(() => window.__tabcomputer.desktop.setTheme('dark'));
await main.waitForTimeout(200);

// ── planted: fake sign-ins show as present, their values nowhere ──
await main.evaluate(async ([TOKEN, CLAUDE, APIKEY, RELAY_SECRET]) => {
  const fs = window.__tabcomputer.fs;
  await fs.mkdir('/home/user/.claude', { recursive: true }).catch(() => {});
  await fs.writeFile('/home/user/.claude/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: CLAUDE, refreshToken: CLAUDE + '-refresh' } }));
  localStorage.setItem('tabcomputer_github_token', TOKEN);
  localStorage.setItem('tabcomputer_anthropic_key', APIKEY);
  // (written without the setter: nothing here should try to connect to it)
  localStorage.setItem('tabcomputer_relay', JSON.stringify({ url: `wss://someone:${RELAY_SECRET}@relay.example.com/tcp?t=${RELAY_SECRET}` }));
  window.dispatchEvent(new StorageEvent('storage', { key: 'tabcomputer_github_token' }));
}, [TOKEN, CLAUDE, APIKEY, RELAY_SECRET]);
await main.waitForFunction(() => [...document.querySelectorAll('.sd-df-place[data-place=tab] li')].some((li) => li.textContent === 'GitHub: signed in'), null, { timeout: 15_000 });
await main.waitForFunction(() => [...document.querySelectorAll('.sd-df-place[data-place=tab] li')].some((li) => li.textContent === 'Claude: signed in'), null, { timeout: 15_000 });
s = await read(main);
check(s.tab.includes('GitHub: signed in') && s.tab.includes('Claude: signed in') && s.tab.includes('API keys: Anthropic'), 'planted: the token, the Claude credential and the API key show as present', s.tab.join(' | '));
check(s.headline.includes('passes through our server, which can read it'), 'planted: the headline says what the server can read', s.headline);
check(s.tab.includes('Relay: your own (relay.example.com)'), 'planted: the relay shows as the user\'s own, by host only', s.tab.join(' | '));
check(lane(s, 'tcp').text.includes('your relay') && lane(s, 'tcp').reads === 'nothing', 'planted: programs\' connections go to that relay, not through this server');
check(lane(s, 'github').carries.join() === 'Sends your GitHub token' && lane(s, 'api').carries.join() === 'Sends your Claude credentials,Sends your Anthropic API key', 'planted: the lanes say which sign-ins travel on them', JSON.stringify([lane(s, 'github').carries, lane(s, 'api').carries]));
check(s.actions.includes('accounts'), 'planted: sign-out is offered');
for (const key of ['flow:api', 'flow:github', 'flow:shared', 'flow:tcp', 'place:tab']) await main.locator(`.sd-df [data-key="${key}"]`).hover();
let found = await domHas(main, SECRETS);
check(found.length === 0, 'planted: no secret value anywhere in the DOM (text, attributes, inputs)', found.join(', '));
await shot(main, 'main-signed-in');
const cmdOut = await sh(main, 'dataflow') + await sh(main, 'dataflow --json');
check(cmdOut.includes('GitHub: signed in') && cmdOut.includes('Claude: signed in') && cmdOut.includes('"github": true'), '`dataflow`: the text version says present');
check(!SECRETS.some((x) => cmdOut.includes(x)), '`dataflow`: no secret value in its output');
const logs = await main.evaluate(() => { try { return localStorage.getItem('tabcomputer-console-log') ?? ''; } catch { return ''; } });
check(!SECRETS.some((x) => logs.includes(x)), 'planted: no secret value in the saved console log');

// ── elsewhere: the menus, Settings, and where the actions go ──
await main.locator('.sd-df .sd-df-actions [data-act=accounts]').click();
await main.waitForSelector('.sd-settings .sd-accounts', { timeout: 15_000 }).catch(() => {});
check(await main.locator('.sd-settings .sd-accounts').count() === 1, 'action: Accounts… opens Settings → Accounts (where Sign Out is)');
found = await domHas(main, SECRETS);
check(found.length === 0, 'action: Accounts shows no secret value either', found.join(', '));
await main.evaluate(() => window.__tabcomputer.desktop.openApp('dataflow'));
await main.locator('.sd-df .sd-df-actions [data-act=network]').click();
await main.waitForSelector('.sd-settings [data-act=dataflow]', { timeout: 15_000 });
check(true, 'action: Network Settings… opens Settings → Network');
// (the relay form shows the URL the person saved there: that is their own input, in its own field)
await main.evaluate(() => { localStorage.removeItem('tabcomputer_relay'); for (const w of window.__tabcomputer.desktop.windows()) if (w.appId === 'dataflow') w.close(); });
await main.waitForFunction(() => !document.querySelector('.sd-df'), null, { timeout: 5000 });
await main.locator('.sd-settings [data-act=dataflow]').click();
await main.waitForSelector('.sd-df[data-ready] .sd-df-lane', { timeout: 20_000 });
check(true, 'Settings → Network: its link opens the window');
await main.evaluate(() => { for (const w of window.__tabcomputer.desktop.windows()) w.close(); });
await main.waitForFunction(() => !document.querySelector('.sd-df'), null, { timeout: 5000 });
await main.locator('[aria-label="System menu"]').click();
await main.locator('.sd-menu-item', { hasText: 'How Your Data Flows' }).click();
await main.waitForSelector('.sd-df[data-ready] .sd-df-lane', { timeout: 20_000 });
check(true, 'System → How Your Data Flows opens the window');
await main.locator('.sd-mb-menus button', { hasText: /^Help$/ }).click();
check(await main.locator('.sd-menu-item', { hasText: 'How Your Data Flows' }).count() === 1, 'Help has it too');
await main.keyboard.press('Escape');

// ── guest: another origin, no sign-ins ──
const guestOrigin = (await sh(main, 'guest url --keep flowlab')).split('\n')[0];
check(/^http:\/\/guest--flowlab\.app\.localhost/.test(guestOrigin), 'guest: this server has guests', guestOrigin);
await ctx.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
const guest = await load(ctx, guestOrigin);
await openFlow(guest);
s = await read(guest);
check(s.profile === 'guest' && s.headline.startsWith('Guest, kept as "flowlab"'), 'guest: says guest, kept under its name', s.headline);
check(s.tab.includes('GitHub: not signed in') && s.tab.includes('Claude: not signed in') && !s.tab.some((l) => l.startsWith('API keys')), 'guest: the main profile\'s sign-ins are not here', s.tab.join(' | '));
check(s.lanes.every((l) => l.carries.length === 0), 'guest: no lane carries a sign-in');
check(s.actions.includes('about-guest') && s.actions.includes('network') && !s.actions.includes('guest') && !s.actions.includes('accounts'), 'guest: offers its own statement, not another guest, and no sign-out', s.actions.join());
await guest.locator('.sd-df-place[data-place=tab]').hover();
check((await read(guest)).detail.includes('cannot see your main files or sign-ins'), 'guest: the tab\'s explanation says what it cannot read');
found = await domHas(guest, SECRETS);
check(found.length === 0, 'guest: the main profile\'s fake values are nowhere in its DOM', found.join(', '));
await shot(guest, 'guest-network');
await guest.locator('.sd-df .sd-df-actions [data-act=about-guest]').click();
await guest.waitForSelector('.sd-guest-pop', { timeout: 10_000 });
check(true, 'guest: About This Guest… opens the guest\'s statement');
await guest.close();

const sealedOrigin = (await sh(main, 'guest url --no-network')).split('\n')[0];
const sealed = await load(ctx, sealedOrigin);
await openFlow(sealed);
s = await read(sealed);
check(s.profile === 'guest' && /^Guest, thrown away, no network/.test(s.headline), 'no network: says thrown away, no network', s.headline);
check(s.tab.includes('Relay: none'), 'no network: no relay', s.tab.join(' | '));
const off = s.lanes.filter((l) => l.status === 'off').map((l) => l.id).join();
check(off === 'tcp,api,github,direct,shared', 'no network: connections, APIs, GitHub, direct requests and sharing are off; this site\'s files are not', off);
check(!s.actions.includes('network'), 'no network: no relay to set, so no Network Settings action', s.actions.join());
check(lane(s, 'tcp').text.includes('Off here'), 'no network: an off lane says so in words');
await sealed.locator('.sd-df-lane[data-flow=direct]').click();
check((await read(sealed)).detail.includes('can still send the tab itself to another address'), 'no network: the stated limit is there');
// what the window says is what the server does
const refused = await sealed.evaluate(async () => (await fetch('/api/github/zen').catch(() => null))?.status ?? 0);
check(refused === 403, 'no network: and the server does refuse its proxy to this guest', String(refused));
await shot(sealed, 'guest-no-network');
await sealed.close();
await main.close();
await ctx.close();

// ── 360 px ──
for (const scheme of ['dark', 'light']) {
  const phone = await browser.newContext({ viewport: { width: 360, height: 740 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: scheme });
  const p = await load(phone, '/');
  await p.waitForSelector('.sd-welcome', { timeout: 30_000 });
  if (scheme === 'dark') {
    const b = await p.locator('.sd-welcome [data-act=dataflow]').boundingBox();
    check(!!b && b.x >= 0 && b.x + b.width <= 360 && b.width > 80, '360 px: the welcome card\'s button is on screen', JSON.stringify(b));
    await shot(p, 'phone-welcome');
  }
  await p.locator('.sd-welcome [data-act=dataflow]').tap();
  await p.waitForSelector('.sd-df[data-ready] .sd-df-lane', { timeout: 20_000 });
  await p.locator('.sd-welcome .sd-btn[data-act=close]').tap().catch(() => {});
  await p.waitForTimeout(350);
  const st = await read(p);
  const geo = await p.evaluate(() => {
    const r = (el) => el.getBoundingClientRect();
    const cells = [...document.querySelectorAll('.sd-df-lane[data-flow=api] .sd-df-node')].map((n) => ({ x: Math.round(r(n).left), y: Math.round(r(n).top), w: Math.round(r(n).width) }));
    const where = [...document.querySelectorAll('.sd-df-lane[data-flow=api] .sd-df-where')].map((n) => ({ t: n.textContent, w: Math.round(r(n).width) }));
    const s = document.querySelector('.sd-df .sd-scroll');
    const small = [...document.querySelectorAll('.sd-df *')].filter((n) => n.children.length === 0 && n.textContent.trim() && parseFloat(getComputedStyle(n).fontSize) < 10).length;
    return { cells, where, page: document.documentElement.scrollWidth - innerWidth, win: s.scrollWidth - s.clientWidth, small };
  });
  check(geo.cells.length === 3 && geo.cells[0].y < geo.cells[1].y && geo.cells[1].y < geo.cells[2].y && geo.cells.every((c) => Math.abs(c.x - geo.cells[0].x) < 4), `360 px ${scheme}: the lanes stack, tab over server over internet`, JSON.stringify(geo.cells));
  check(geo.where.map((w) => w.t).join() === 'This tab,Server,Internet' && geo.where.every((w) => w.w > 20), `360 px ${scheme}: each stacked cell names its place`, JSON.stringify(geo.where));
  check(geo.page <= 0 && geo.win <= 0, `360 px ${scheme}: nothing scrolls sideways`, JSON.stringify({ page: geo.page, win: geo.win }));
  check(geo.small === 0, `360 px ${scheme}: no text under 10 px`, String(geo.small));
  check(st.lanes.length === 8 && st.profile === 'main', `360 px ${scheme}: the same eight lanes`);
  await p.locator('.sd-df-lane[data-flow=api]').tap();
  check((await read(p)).detail.includes('can read your prompts'), `360 px ${scheme}: a tap explains a lane`);
  await shot(p, `phone-${scheme}`);
  await p.locator('.sd-df-lane[data-flow=api]').scrollIntoViewIfNeeded();
  await shot(p, `phone-${scheme}-lane`);
  await phone.close();
}

// ── terminal UI: no card, the command ──
const tctx = await browser.newContext({ viewport: { width: 1000, height: 700 } });
const term = await tctx.newPage();
term.on('pageerror', (e) => console.log('[pageerror]', e.message));
await term.goto(new URL('/?ui=terminal', base).toString());
await term.waitForFunction(() => window.__tabcomputer?.terminal && window.__tabcomputer?.shell, null, { timeout: 90_000 });
check(await term.locator('.sd-welcome, .sd-desktop .sd-dock').count() === 0, 'terminal UI: no desktop, no welcome card');
const out = await sh(term, 'dataflow');
check(out.includes('How your data flows') && out.includes('THIS TAB') && out.includes('Main profile') && out.includes('[exit 0]'), 'terminal UI: `dataflow` prints the text version', out.slice(0, 200));
check(/GitHub: (signed in|not signed in)/.test(out) && out.includes('Sharing') && out.includes('Files and programs'), 'terminal UI: with the live state and all eight flows');
check((await sh(term, 'help')).includes('dataflow'), 'terminal UI: `help` lists it');
if (shots) {
  await term.evaluate(() => { const t = window.__tabcomputer.terminal; t.injectInput('dataflow | head -40\r'); });
  await term.waitForTimeout(2500);
  await shot(term, 'terminal-ui');
}
await tctx.close();

await browser.close();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
