// Hot-swapping the shell inside a running tab (src/hotswap/, docs/HOTSWAP.md).
// Needs a build and a running server:
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/hotswap.mjs [http://localhost:5299/]
// 1. Copies this checkout's src/ into the tab (~/shiro), edits src/shell.ts there with sed.
// 2. `hotswap apply --ttl 8s src/shell.ts`: the main terminal's shell sees the change, no reload.
// 3. The TTL runs out unconfirmed: the change reverts by itself.
// 4. Apply, `hotswap confirm --persist`, reload: the swap is back; ?safe=1 skips it; revert clears it.
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.argv[2] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext();
let failures = 0;
const check = (ok, what, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || !extra ? '' : `\n     ${extra}`}`); if (!ok) failures++; };
const url = (q) => new URL(q, base).toString();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(page, q) {
  await page.goto(url(q), { waitUntil: 'commit' });
  await page.waitForFunction(() => !!window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished'), null, { timeout: 90000 });
}
// Commands in a terminal-less fork of the main shell (a new Shell: made by the live class)
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const s = window.__checkShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return { code, out: out.replace(/\r\n/g, '\n') };
}, cmd);
// The main shell instance itself (the one the terminal runs)
const mainEcho = (page) => page.evaluate(async () => {
  let out = '';
  await window.__tabcomputer.shell.execute('echo $BASH_VERSION', (x) => { out += x; }, () => {});
  return out.trim();
});

const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await boot(page, '/?ui=terminal');
check(true, 'boots');

// 1. A checkout of the source in the tab
const files = [];
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(ts|tsx|json|txt|js|mjs)$/.test(e.name)) files.push(p);
  }
};
walk(path.join(repo, 'src'));
for (const f of ['tsconfig.json', 'build-number.txt', 'package.json']) files.push(path.join(repo, f));
for (let i = 0; i < files.length; i += 100) {
  const batch = files.slice(i, i + 100).map((f) => [path.relative(repo, f), fs.readFileSync(f, 'utf8')]);
  await page.evaluate(async (batch) => {
    const vfs = window.__tabcomputer.fs;
    for (const [rel, text] of batch) {
      const p = `/home/user/shiro/${rel}`;
      await vfs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
      await vfs.writeFile(p, text);
    }
  }, batch);
}
check(true, `copied ${files.length} files to ~/shiro`);

let r = await sh(page, `cd /home/user/shiro && sed -i "s/result += '5.0.0'/result += '9.9.9-hotswap'/" src/shell.ts && grep -c 9.9.9-hotswap src/shell.ts`);
check(r.out.trim() === '1', 'edited src/shell.ts in the tab', r.out);
check((await mainEcho(page)) === '5.0.0', 'before: BASH_VERSION is 5.0.0');

// 2. Swap it in
let t0 = Date.now();
r = await sh(page, 'hotswap apply --ttl 8s src/shell.ts');
console.log(r.out.split('\n').map((l) => '     ' + l).join('\n'));
check(r.code === 0 && /applied #\d+ src\/shell\.ts/.test(r.out) && /Shell: \d+ method\(s\) swapped/.test(r.out), `hotswap apply (${Date.now() - t0} ms)`, r.out);
check((await mainEcho(page)) === '9.9.9-hotswap', 'the main shell runs the new code (no reload)');
check((await sh(page, 'echo $BASH_VERSION')).out.trim() === '9.9.9-hotswap', 'a forked shell runs it too');
check(/reverts in \d+s unless confirmed/.test((await sh(page, 'hotswap status')).out), 'hotswap status shows the TTL');
check((await sh(page, 'echo hi | tr a-z A-Z')).out.trim() === 'HI', 'pipelines still work under the swap');

// 3. The TTL runs out
await wait(9000);
check((await mainEcho(page)) === '5.0.0', 'reverted by itself after the TTL');
check(/No swaps applied/.test((await sh(page, 'hotswap status')).out), 'status: nothing applied');

// 4. Confirm and persist; reload
r = await sh(page, 'hotswap apply --ttl 30s src/shell.ts && hotswap confirm --persist');
check(r.code === 0 && /persisted 1 swap/.test(r.out), 'confirm --persist', r.out);
await boot(page, '/?ui=terminal');
check((await mainEcho(page)) === '9.9.9-hotswap', 'a reload re-applies the persisted swap');
check(/confirmed, persisted/.test((await sh(page, 'hotswap status')).out), 'status after reload: persisted');
await boot(page, '/?ui=terminal&safe=1');
check((await mainEcho(page)) === '5.0.0', 'safe mode skips persisted swaps');
await boot(page, '/?ui=terminal');
r = await sh(page, 'hotswap revert');
check(/reverted #\d+/.test(r.out) && /updated the persisted swaps/.test(r.out), 'hotswap revert drops it from persistence', r.out);
await boot(page, '/?ui=terminal');
check((await mainEcho(page)) === '5.0.0', 'the next load has no swap');

await browser.close();
console.log(failures ? `${failures} failure(s)` : 'all ok');
process.exit(failures ? 1 : 0);
