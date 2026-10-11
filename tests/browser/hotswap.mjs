// Hot-swapping the shell inside a running tab (src/hotswap/, docs/HOTSWAP.md).
// Needs a build and a running server:
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/hotswap.mjs [http://localhost:5299/]
// 1. `hotswap checkout` unpacks the build's own source into ~/tabcomputer; sed edits src/shell.ts; `hotswap diff` shows it.
// 2. `hotswap apply --ttl 8s src/shell.ts`: the main terminal's shell sees the change, no reload.
// 3. The TTL runs out unconfirmed: the change reverts by itself.
// 4. Apply, `hotswap confirm --persist`, reload: the swap is back; ?safe=1 skips it; revert clears it.
// 5. `hotswap apply src/commands/git.ts` patches the lazy git command (#47); revert; then `reload` it.
// 6. `hotswap test` runs shell suites from the checkout in the tab, without touching the tab's own storage;
//    their node:fs reads the checkout (fixtures included) and writes only in memory.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

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

// 1. A checkout of this build's source in the tab
let t0 = Date.now();
let r = await sh(page, 'hotswap checkout');
check(r.code === 0 && /checked out build \d+/.test(r.out) && /in \/home\/user\/tabcomputer/.test(r.out), `hotswap checkout (${Date.now() - t0} ms)`, r.out);
// A tab with a checkout in ~/shiro (the old default) and none in ~/tabcomputer keeps using it
r = await sh(page, 'mv /home/user/tabcomputer /home/user/shiro && hotswap checkout; mv /home/user/shiro /home/user/tabcomputer');
check(/using the existing checkout in \/home\/user\/shiro/.test(r.out), 'hotswap checkout falls back to an existing ~/shiro checkout', r.out);
check(/No changes/.test((await sh(page, 'cd /home/user/tabcomputer && hotswap diff')).out), 'a fresh checkout has no changes');

r = await sh(page, `cd /home/user/tabcomputer && sed -i "s/result += '5.0.0'/result += '9.9.9-hotswap'/" src/shell.ts && grep -c 9.9.9-hotswap src/shell.ts`);
check(r.out.trim() === '1', 'edited src/shell.ts in the tab', r.out);
check((await mainEcho(page)) === '5.0.0', 'before: BASH_VERSION is 5.0.0');

r = await sh(page, 'hotswap diff --stat; hotswap diff');
check(/^M src\/shell\.ts$/m.test(r.out) && /^\+.*9\.9\.9-hotswap/m.test(r.out) && /^-.*'5\.0\.0'/m.test(r.out), 'hotswap diff shows the edit', r.out);

// 2. Swap it in
t0 = Date.now();
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


// 5. A registry command (#47): git is a lazy command, a plain object, not a class
r = await sh(page, `cd /home/user/tabcomputer && sed -i 's/git version 2\\.47\\.0/git version 9.9.9-swapped/' src/commands/git.ts && hotswap apply --ttl 60s src/commands/git.ts`);
check(r.code === 0 && /command git: replaced .*exec/.test(r.out) && !/not swapped.*gitCmd/.test(r.out), 'hotswap apply src/commands/git.ts patches the git command', r.out);
check(/9\.9\.9-swapped/.test((await sh(page, 'git --version')).out), 'git runs the swapped code');
await sh(page, 'hotswap revert');
check(/git version 2\.47\.0/.test((await sh(page, 'git --version')).out), 'revert puts the old git back');
// reload resolves the command's relative imports through the live modules
r = await sh(page, 'cd /home/user/tabcomputer && reload commands/git src/commands/git.ts');
check(r.code === 0 && /Hot-reloaded 'commands\/git'/.test(r.out), 'reload of a command with relative imports', r.out);
check(/9\.9\.9-swapped/.test((await sh(page, 'git --version')).out), 'git runs the reloaded code');

// 6. Suites from the checkout, in the tab
await page.evaluate(async () => {
  await window.__tabcomputer.fs.writeFile('/home/user/keep.txt', 'mine');
  localStorage.setItem('hotswap-check', 'mine');
});
t0 = Date.now();
r = await sh(page, 'cd /home/user/tabcomputer && hotswap test shell-posix shell-syntax shell-issue74');
console.log(r.out.split('\n').map((l) => '     ' + l).join('\n'));
check(r.code === 0 && /PASS tests\/tests\/shiro-vitest\/shell-posix\.test\.ts: \d+ passed/.test(r.out) && /Tests: \d+ passed\n/.test(r.out), `hotswap test runs the shell suites (${Date.now() - t0} ms)`, r.out);
// node:fs: a fixture by import.meta.url, and a guest worker from a lazy module (shell-conformance's argv0.wasm)
r = await sh(page, 'cd /home/user/tabcomputer && hotswap test -t argv shell-conformance');
check(r.code === 0 && /PASS .*shell-conformance\.test\.ts: 1 passed/.test(r.out), 'a suite reads its wasm fixture with node:fs and runs it', r.out);
// a suite's node:fs writes stay in memory: the tab's files and the checkout are unchanged
r = await sh(page, `cd /home/user/tabcomputer && cat > tests/tests/shiro-vitest/fs-probe.test.ts <<'END'
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
it('reads the checkout and writes in memory', () => {
  expect(readFileSync(join(__dirname, '../../../src/shell.ts'), 'utf8')).toContain('export class Shell');
  expect(existsSync('/home/user/keep.txt')).toBe(false); // only the checkout is in its fs
  writeFileSync('/home/user/keep.txt', 'clobbered');
  writeFileSync(join(__dirname, 'fs-probe.test.ts'), 'clobbered');
  const d = mkdtempSync('/tmp/probe-');
  writeFileSync(d + '/x', Buffer.from('y'));
  expect([readFileSync('/home/user/keep.txt', 'utf8'), existsSync(d + '/x'), process.env.HOME]).toEqual(['clobbered', true, '/home/user']);
});
END
hotswap test fs-probe; head -c 6 tests/tests/shiro-vitest/fs-probe.test.ts; echo; ls -d /tmp/probe-* 2>/dev/null | wc -l; rm tests/tests/shiro-vitest/fs-probe.test.ts`);
check(/PASS .*fs-probe\.test\.ts: 1 passed/.test(r.out) && /\nimport\n0\n$/.test(r.out), "a suite's node:fs reads the checkout and its writes stay in memory", r.out);
r = await sh(page, 'cd /home/user/tabcomputer && hotswap test -t "nothing matches this" shell-posix');
check(/0 passed/.test(r.out), 'hotswap test -t filters');
const kept = await page.evaluate(async () => ({
  file: await window.__tabcomputer.fs.readFile('/home/user/keep.txt', 'utf8'),
  ls: localStorage.getItem('hotswap-check'),
  dbs: (await indexedDB.databases()).map((d) => d.name).filter((n) => n.startsWith('tabcomputer-test-')).length,
}));
check(kept.file === 'mine' && kept.ls === 'mine', "the tab's own files and localStorage are untouched", JSON.stringify(kept));

await browser.close();
console.log(failures ? `${failures} failure(s)` : 'all ok');
process.exit(failures ? 1 : 0);
