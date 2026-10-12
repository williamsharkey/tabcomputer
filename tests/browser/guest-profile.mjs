// Guests (src/guest.ts, docs/research/GUEST_PROFILE.md) in Chromium. Needs a build and a
// running server, no relay and no Debian:
//   npx vite build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/guest-profile.mjs [http://app.localhost:5299/]
//
// The default base is app.localhost, not localhost: a guest of it
// (guest--x.app.localhost) is then another origin of the same site, as
// guest--x.tabcomputer.com is to tabcomputer.com. Chromium resolves *.localhost itself.
//
//   planted     a fake token in the main profile: ~/.claude/.credentials.json, ~/.gitconfig,
//               localStorage, a cache, OPFS
//   control     the probe (a node script, in the page and in a Worker) finds it in the main profile
//   guest       the same probe in a guest finds nothing: shell commands, node in the page, node in
//               a Worker, raw page JavaScript (indexedDB.databases(), localStorage, OPFS, caches)
//   inbound     the main profile does not boot in a guest's frame and takes no seed from it;
//               ?guest goes to a guest before the main profile boots
//   no network  the CSP and the server's refusals, with node still working
//   kept        a named guest keeps its files across tabs; a thrown-away one keeps them across a
//               reload and loses them to a new tab
//   discard     Discard deletes everything the guest stored; the main profile is unchanged
//
// Exits 1 if any check fails.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright'); } catch {
  try { pw = require('/opt/node-tools/node_modules/playwright'); } catch { pw = require('playwright-core'); }
}
const { chromium } = pw;
const base = process.argv[2] || 'http://app.localhost:5299/';

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${!ok && detail ? `: ${detail}` : ''}`); if (!ok) failures++; };

const TOKEN = 'FAKE-TOKEN-guest-check-7f3a9c';

// Looks for TOKEN in everything the origin stores. Runs as a node script (page and Worker)
// and as page JavaScript; prints one JSON line.
const PROBE = `
// (in pieces: the probe is itself a file in the machine it searches)
const T = ${JSON.stringify(TOKEN.split('-'))}.join('-');
const g = globalThis;
const text = (v, depth = 0) => {
  if (v == null || depth > 6) return '';
  if (typeof v === 'string') return v;
  if (ArrayBuffer.isView(v)) { let s = ''; const b = new Uint8Array(v.buffer, v.byteOffset, v.byteLength); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
  if (v instanceof ArrayBuffer) return text(new Uint8Array(v));
  if (typeof v === 'object') { let s = ''; for (const k in v) s += k + '\\n' + text(v[k], depth + 1) + '\\n'; return s; }
  return String(v);
};
async function probe() {
  const out = { where: typeof g.document !== 'undefined' ? 'page' : 'worker', origin: String(g.location && g.location.origin), hits: [], dbs: [], errors: [] };
  try {
    const dbs = await g.indexedDB.databases();
    out.dbs = dbs.map((d) => d.name);
    for (const d of dbs) {
      const db = await new Promise((res, rej) => { const r = g.indexedDB.open(d.name); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
      for (const store of Array.from(db.objectStoreNames)) {
        const all = await new Promise((res, rej) => { const r = db.transaction(store, 'readonly').objectStore(store).getAll(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
        if (text(all).includes(T)) out.hits.push('indexedDB ' + d.name + '/' + store);
      }
      db.close();
    }
  } catch (e) { out.errors.push('indexedDB: ' + (e && e.message)); }
  try { if (g.localStorage) { out.localStorageKeys = g.localStorage.length; for (let i = 0; i < g.localStorage.length; i++) if (String(g.localStorage.getItem(g.localStorage.key(i))).includes(T)) out.hits.push('localStorage ' + g.localStorage.key(i)); } } catch (e) { out.errors.push('localStorage: ' + (e && e.message)); }
  try {
    out.caches = await g.caches.keys();
    for (const name of out.caches) { const c = await g.caches.open(name); for (const req of await c.keys()) { const r = await c.match(req); if ((await r.text()).includes(T)) out.hits.push('cache ' + name); } }
  } catch (e) { out.errors.push('caches: ' + (e && e.message)); }
  try {
    const root = await g.navigator.storage.getDirectory();
    out.opfs = [];
    for await (const [name, h] of root.entries()) { out.opfs.push(name); if (h.kind === 'file' && (await (await h.getFile()).text()).includes(T)) out.hits.push('OPFS ' + name); }
  } catch (e) { out.errors.push('OPFS: ' + (e && e.message)); }
  return out;
}
`;
const NODE_PROBE = PROBE + `
const fs = require('fs');
probe().then((out) => {
  for (const p of ['/home/user/.claude/.credentials.json', '/home/user/.gitconfig']) { try { if (fs.readFileSync(p, 'utf8').includes(T)) out.hits.push('file ' + p); } catch (e) {} }
  console.log('PROBE ' + JSON.stringify(out));
});
`;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium', args: ['--no-sandbox'] });
const ctx = await browser.newContext();
// The welcome card is not part of this check
await ctx.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });

async function load(url, { boots = true } = {}) {
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(new URL(url, base).toString());
  if (boots) await page.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
  return page;
}
/** A command in a shell of the check's own; its output */
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const s = Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  s.cwd = '/home/user';
  const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return `${out.replace(/\r\n/g, '\n').trim()}\n[exit ${code}]`;
}, cmd);
const write = (page, path, content) => page.evaluate(async ([path, content]) => {
  const fs = window.__tabcomputer.fs;
  await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true }).catch(() => {});
  await fs.writeFile(path, content);
  await fs.flushAll?.();
}, [path, content]);
const nodeProbe = async (page, mode) => {
  await write(page, '/tmp/probe.js', NODE_PROBE);
  const out = await sh(page, `${mode === 'page' ? 'TABCOMPUTER_NODE_WORKER=0 ' : ''}node /tmp/probe.js`);
  const m = /PROBE (\{.*\})/.exec(out);
  if (!m) { console.log(out.slice(0, 600)); return null; }
  return JSON.parse(m[1]);
};
const pageProbe = (page) => page.evaluate(`(async () => { ${PROBE}; return probe(); })()`);
const mainState = (page) => page.evaluate(async (T) => ({
  cred: await window.__tabcomputer.fs.readFile('/home/user/.claude/.credentials.json', 'utf8').catch(() => null),
  gitconfig: await window.__tabcomputer.fs.readFile('/home/user/.gitconfig', 'utf8').catch(() => null),
  token: localStorage.getItem('tabcomputer_github_token'),
  cache: await (await (await caches.open('guest-check')).match('/secret'))?.text() ?? null,
  opfs: await (await (await (await navigator.storage.getDirectory()).getFileHandle('secret.txt')).getFile()).text().catch(() => null),
  dbs: (await indexedDB.databases()).map((d) => d.name).sort(),
  pwned: await window.__tabcomputer.fs.exists('/home/user/pwned').catch(() => false),
  T,
}), TOKEN);

// ── planted: a main profile with something to steal ──
const main = await load('/');
const mainOrigin = new URL(base).origin;
await write(main, '/home/user/.claude/.credentials.json', JSON.stringify({ claudeAiOauth: { accessToken: TOKEN } }));
await write(main, '/home/user/.gitconfig', `[user]\n\tname = Someone\n[credential]\n\thelper = store --token=${TOKEN}\n`);
await main.evaluate(async (T) => {
  localStorage.setItem('tabcomputer_github_token', T);
  await (await caches.open('guest-check')).put('/secret', new Response(T));
  const h = await (await navigator.storage.getDirectory()).getFileHandle('secret.txt', { create: true });
  const w = await h.createWritable(); await w.write(T); await w.close();
}, TOKEN);
const before = await mainState(main);
check(before.cred?.includes(TOKEN) && before.token === TOKEN && before.cache === TOKEN && before.opfs === TOKEN, 'planted: the main profile holds the fake token in files, localStorage, a cache and OPFS', JSON.stringify(before));
check(!(await main.evaluate(() => document.querySelector('.sd-mb-guest'))), 'main profile: no Guest button');
check((await sh(main, 'guest')).includes('This is not a guest'), 'main profile: `guest` says it is not a guest');

// ── control: the probe does find it where it is ──
for (const mode of ['page', 'worker']) {
  const r = await nodeProbe(main, mode);
  check(!!r && r.where === mode && r.hits.some((h) => h.startsWith('indexedDB')) && r.hits.some((h) => h.startsWith('file')), `control: a node script in the ${mode} reads the token in the main profile (${r?.hits.join(', ')})`, JSON.stringify(r));
}
const ctl = await pageProbe(main);
check(['indexedDB', 'localStorage', 'cache', 'OPFS'].every((k) => ctl.hits.some((h) => h.startsWith(k))), `control: page JavaScript reads it in the main profile (${ctl.hits.join(', ')})`, JSON.stringify(ctl));

// ── guest ──
const guestUrl = (await sh(main, 'guest url --keep work')).split('\n')[0];
check(/^http:\/\/guest--work\./.test(guestUrl), `main profile: \`guest url --keep work\` is ${guestUrl}`);
const guest = await load(guestUrl);
const info = await guest.evaluate(() => ({ origin: location.origin, coi: crossOriginIsolated, pill: document.querySelector('.sd-mb-guest')?.textContent, attr: document.documentElement.dataset.guest }));
check(info.origin !== mainOrigin && info.origin === new URL(guestUrl).origin, `guest: its own origin (${info.origin})`);
check(info.coi === true, 'guest: cross-origin isolated (Workers, SharedArrayBuffer)');
check(info.pill === 'Guest', 'guest: the menu bar says Guest', String(info.pill));
await guest.waitForSelector('.sd-guest-pop', { timeout: 10_000 }).catch(() => {});
const stated = await guest.evaluate(() => document.querySelector('.sd-guest-pop')?.textContent ?? '');
check(stated.includes(new URL(guestUrl).host) && stated.includes('cannot read your main tabcomputer') && stated.includes('Kept in this browser under the name "work"'), 'guest: the statement of the boundary appears by itself', stated);
const status = await sh(guest, 'guest');
check(status.includes('Guest (kept as "work")') && status.includes('It has internet access'), 'guest: `guest` prints the same statement', status);

const cat = await sh(guest, 'cat ~/.claude/.credentials.json; cat ~/.gitconfig; grep -r FAKE-TOKEN /home/user /root /etc /tmp 2>/dev/null; gh auth token');
check(!cat.includes(TOKEN), 'guest: shell commands (cat, grep -r, gh auth token) do not see the token', cat);
for (const mode of ['page', 'worker']) {
  const r = await nodeProbe(guest, mode);
  check(!!r && r.where === mode && r.origin === info.origin && r.hits.length === 0 && r.errors.length === 0 && r.dbs.length > 0,
    `guest: a node script in the ${mode} finds nothing (databases it can list: ${r?.dbs.join(', ')})`, JSON.stringify(r));
}
const gp = await pageProbe(guest);
check(gp.hits.length === 0 && gp.errors.length === 0 && !gp.caches.includes('guest-check') && !gp.opfs.includes('secret.txt'),
  `guest: page JavaScript finds nothing (indexedDB.databases() ${gp.dbs.join(', ')}; localStorage ${gp.localStorageKeys} keys; caches [${gp.caches}]; OPFS [${gp.opfs}])`, JSON.stringify(gp));
const xo = await guest.evaluate(async (o) => {
  const r = { fetch: '', frame: '' };
  try { r.fetch = (await (await fetch(o + '/guest/config.json')).text()).slice(0, 80); } catch (e) { r.fetch = 'error: ' + e.message; }
  return r;
}, mainOrigin);
check(!xo.fetch.includes(TOKEN), 'guest: a request to the main origin returns only what the server gives anyone', xo.fetch);

// ── inbound: the guest reaching for the main profile ──
const framed = await guest.evaluate(async (o) => {
  const f = document.createElement('iframe');
  f.src = o + '/';
  f.style.cssText = 'position:fixed;left:0;top:0;width:300px;height:200px;z-index:999999';
  document.body.append(f);
  await new Promise((r) => { f.onload = r; setTimeout(r, 8000); });
  await new Promise((r) => setTimeout(r, 3000));
  // what a seed snippet's parent sends (main.ts): a file for the framed profile
  const node = { path: '/home/user/pwned', type: 'file', content: btoa('x'), mode: 0o644, mtime: Date.now(), ctime: Date.now() };
  f.contentWindow.postMessage({ type: 'shiro-seed', data: { fs: [node], localStorage: { pwned: '1' } } }, '*');
  f.contentWindow.postMessage({ type: 'shiro-seed-v2', ndjson: JSON.stringify(node), storage: { pwned: '1' } }, '*');
  await new Promise((r) => setTimeout(r, 3000));
  f.remove();
  return true;
}, mainOrigin);
const frameBodies = await Promise.all(guest.frames().filter((f) => f !== guest.mainFrame()).map((f) => f.evaluate(() => document.body?.innerText ?? '').catch(() => '')));
const afterFrame = await mainState(main);
check(framed && !afterFrame.pwned && (await main.evaluate(() => localStorage.getItem('pwned'))) === null, 'inbound: a seed posted to the main profile framed in the guest is not imported', frameBodies.join(' | '));

check(frameBodies.every((b) => !b || /does not (load|run)/.test(b)), 'inbound: the frame holds a refusal, not the main profile', frameBodies.join(' | '));

// ── no network ──
const nn = await load('/?guest&nonet&keepme=1');
const nnUrl = new URL(nn.url());
check(/^guest--[a-z0-9]{10}--tx\./.test(nnUrl.hostname) && nnUrl.searchParams.get('keepme') === '1' && !nnUrl.searchParams.has('guest'), `?guest&nonet on the main origin goes to a thrown-away no-network guest, the other parameters with it (${nnUrl.host})`, nn.url());
const nnInfo = await nn.evaluate(async (o) => {
  const violations = [];
  addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective + ' ' + e.blockedURI));
  const tryFetch = async (u, init) => { try { const r = await fetch(u, init); return `${r.status} ${(await r.text()).slice(0, 300)}`; } catch (e) { return 'threw'; } };
  const ws = (u) => new Promise((res) => { try { const w = new WebSocket(u); w.onopen = () => { w.close(); res('open'); }; w.onerror = () => res('error'); setTimeout(() => res('timeout'), 4000); } catch { res('threw'); } });
  const img = (u) => new Promise((res) => { const i = new Image(); i.onload = () => res('loaded'); i.onerror = () => res('error'); i.src = u; setTimeout(() => res('timeout'), 4000); });
  const out = {
    coi: crossOriginIsolated, pill: document.querySelector('.sd-mb-guest')?.textContent,
    other: await tryFetch('https://example.com/'),
    mainOrigin: await tryFetch(o + '/guest/config.json'),
    image: await img(o + '/tabcomputer-favicon.svg?x=' + Date.now()),
    api: await tryFetch('/api/github/zen'),
    token: await tryFetch('/tcp/token', { method: 'POST' }),
    gitProxy: await tryFetch('/git-proxy/github.com/x/y/info/refs'),
    own: await tryFetch('/guest/config.json'),
    wsTcp: await ws(`ws://${location.host}/tcp`),
    wsChannel: await ws(`ws://${location.host}/channel/abcd`),
    wsMain: await ws(o.replace(/^http/, 'ws') + '/channel/abcd'),
  };
  await new Promise((r) => setTimeout(r, 200));
  out.violations = violations;
  return out;
}, mainOrigin);
check(nnInfo.coi === true && nnInfo.pill === 'Guest · no network', 'no network: boots under its CSP, cross-origin isolated, and says so in the menu bar', JSON.stringify(nnInfo));
check(nnInfo.other === 'threw' && nnInfo.mainOrigin === 'threw' && nnInfo.image === 'error' && nnInfo.violations.some((v) => v.startsWith('connect-src')) && nnInfo.violations.some((v) => v.startsWith('img-src')),
  `no network: the browser refuses fetch and images to other origins, the main one included (${nnInfo.violations.length} CSP violations)`, JSON.stringify(nnInfo));
check(nnInfo.api.startsWith('403') && nnInfo.token.startsWith('403') && nnInfo.gitProxy.startsWith('403') && nnInfo.api.includes('no network'), 'no network: the server refuses its proxies and the relay token', JSON.stringify(nnInfo));
check(nnInfo.wsTcp !== 'open' && nnInfo.wsChannel !== 'open' && nnInfo.wsMain !== 'open', 'no network: no WebSocket opens, to this host or the main one', JSON.stringify(nnInfo));
check(nnInfo.own.startsWith('200') && nnInfo.own.includes('"enforced":true'), 'no network: the host\'s own files still load, and the server says it enforces the mode', nnInfo.own);
await nn.waitForSelector('.sd-guest-pop', { timeout: 10_000 }).catch(() => {});
const nnStated = await nn.evaluate(() => document.querySelector('.sd-guest-pop')?.textContent ?? '');
check(nnStated.includes('the browser blocks requests to other sites') && nnStated.includes('can still send the tab to another address') && nnStated.includes('Thrown away'), 'no network: the statement says what is blocked and what is not', nnStated);
const curl = await sh(nn, 'curl -sS -m 8 https://example.com/ ; echo "curl=$?"');
check(/curl=[1-9]/.test(curl), 'no network: curl fails', curl);
for (const mode of ['page', 'worker']) {
  const out = await sh(nn, `${mode === 'page' ? 'TABCOMPUTER_NODE_WORKER=0 ' : ''}node -e "require('fs').writeFileSync('/tmp/n-${mode}', String(6*7)); console.log('node ' + require('fs').readFileSync('/tmp/n-${mode}', 'utf8'))"`);
  check(out.includes('node 42'), `no network: node still runs in the ${mode} under the CSP`, out);
}

// ── kept and thrown away ──
await write(guest, '/home/user/kept.txt', 'kept');
await guest.close();
const guest2 = await load(guestUrl);
check((await sh(guest2, 'cat ~/kept.txt')).startsWith('kept'), 'kept: a named guest has its files in a new tab');

await write(nn, '/home/user/scratch.txt', 'scratch');
await nn.reload();
await nn.waitForFunction(() => window.__tabcomputer?.terminal && !document.querySelector('.sd-booting'), null, { timeout: 90_000 });
check((await sh(nn, 'cat ~/scratch.txt')).startsWith('scratch'), 'thrown away: a reload keeps the files');
const nnAddress = nnUrl.origin + '/';
await nn.close();
const nn2 = await load(nnAddress);
check((await sh(nn2, 'cat ~/scratch.txt')).includes('No such file'), 'thrown away: a new tab on its address starts empty', await sh(nn2, 'ls -la ~'));
await nn2.close();

// ── discard ──
await guest2.evaluate(async () => { localStorage.setItem('mine', '1'); await (await caches.open('mine')).put('/x', new Response('x')); });
if (!(await guest2.$('.sd-guest-pop'))) await guest2.click('.sd-mb-guest');
await guest2.click('.sd-guest-pop [data-act=discard]');
await guest2.click('.sd-guest-pop [data-act=discard]');
await guest2.waitForSelector('#guest-discarded', { timeout: 30_000 }).catch(() => {});
const gone = await guest2.evaluate(async () => ({
  text: document.body.innerText, dbs: (await indexedDB.databases()).map((d) => d.name), ls: localStorage.length, ss: sessionStorage.length, caches: await caches.keys(),
  booted: !!window.__tabcomputer,
}));
check(gone.text.includes('This guest has been discarded') && gone.dbs.length === 0 && gone.ls === 0 && gone.caches.length === 0 && !gone.booted, 'discard: every database, cache and key of the guest is deleted, and it does not boot again', JSON.stringify(gone));
await new Promise((r) => setTimeout(r, 6000)); // past the console log's and the watchdog's next save
const later = await guest2.evaluate(async () => ({ dbs: (await indexedDB.databases()).map((d) => d.name), ls: Object.keys(localStorage) }));
check(later.dbs.length === 0 && later.ls.length === 0, 'discard: nothing is written back afterwards', JSON.stringify(later));
await guest2.close();
const guest3 = await load(guestUrl);
check((await sh(guest3, 'cat ~/kept.txt')).includes('No such file'), 'discard: the name opens an empty guest afterwards');
await guest3.close();

const after = await mainState(main);
// (the main desktop may have made a database of its own meanwhile, e.g. its saved session)
const same = (s) => JSON.stringify({ ...s, dbs: null });
check(same(after) === same(before) && before.dbs.every((d) => after.dbs.includes(d)), 'the main profile is unchanged: files, token, cache, OPFS, and every database it had', `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
for (const mode of ['page', 'worker']) {
  const r = await nodeProbe(main, mode);
  check(!!r && r.hits.some((h) => h.startsWith('file')), `the main profile still reads its token (node in the ${mode})`, JSON.stringify(r));
}

await browser.close();
console.log(failures ? `${failures} check(s) failed` : 'all checks passed');
process.exit(failures ? 1 : 0);
