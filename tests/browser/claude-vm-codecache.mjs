// claude --vm's code cache in the real app (src/claude-vm/code-cache.ts,
// sw-host.ts, public/vm-sw.js), with a synthetic Bun executable as the
// native build: a page that never ran `claude --vm` has no service worker; the
// first `claude --vm` registers vm-sw.js and its node process already imports
// the bundle from the 'tabcomputer-vm' cache, with Bun and the process's
// globals; the next launch does too; a reload's page and assets don't come
// from the worker; a node process whose worker started before the service
// worker took the page requires bundle.js; and with DIST set (the server's
// STATIC_DIR), the off switch: vm-sw.js deployed with ENABLED = false makes the
// next launch require bundle.js, unregister the worker and empty its cache.
// (Real Claude Code through it: CLAUDE_BUILD=vm node tests/browser/claude-restore.mjs.)
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   DIST=$PWD/dist node tests/browser/claude-vm-codecache.mjs [URL]
import { createRequire } from 'node:module';
import { fakeBunElf } from '../tests/shiro-vitest/fake-bun-elf.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const require = createRequire(import.meta.url);
let chromium;
({ chromium } = loadPlaywright());

const url = process.argv[2] || 'http://localhost:5299/';
const exe = chromiumPath('/opt/pw-browsers/chromium');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let page = await (await browser.newContext()).newPage();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const run = (cmd, p = page) => p.evaluate(async (cmd) => {
  let out = '';
  const sh = window.__ccShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await sh.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { code, out };
}, cmd);

// The entry imports a chunk (the bundle's own module table) and says where it ran from:
// a frame at /__vm/ is the cached ES module
const elf = fakeBunElf([
  { name: '/$bunfs/root/chunk-a.js', contents: '// @bun\nexport const a = "chunk";\n', loader: 1 },
  { name: '/$bunfs/root/cli', contents: '// @bun\nimport { a } from "/$bunfs/root/chunk-a.js";\n'
    + 'console.log("VMCC " + JSON.stringify({ a, bun: typeof Bun.version, build: process.env.TABCOMPUTER_CLAUDE_BUILD, cached: new Error().stack.includes("/__vm/") }));\n', loader: 1 },
], 1);
// (claude --vm takes a file over 1 MB as the native build)
const padded = new Uint8Array(1_100_000);
padded.set(elf);

try {
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.shell, null, { timeout: 90_000 });
  check(await page.evaluate(() => !navigator.serviceWorker.controller), 'no service worker before claude --vm');
  // a node process first: its worker is pooled before the service worker exists
  await run('node -e "1"');

  await page.evaluate(async (b64) => {
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/home/user/.local/bin', { recursive: true });
    await fs.writeFile('/home/user/.local/bin/claude', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }, Buffer.from(padded).toString('base64'));

  const first = await run('claude --vm');
  const said = (r) => { const m = /VMCC (\{.*\})/.exec(r.out); return m ? JSON.parse(m[1]) : null; };
  const one = said(first);
  check(one?.a === 'chunk' && one.bun === 'string' && one.build === 'vm', `claude --vm runs the extracted entry with Bun (${JSON.stringify(one) ?? first.out.slice(-300)})`);
  check(one?.cached === true, 'the first launch already imports the bundle from the cache');
  const ctl = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '');
  check(/\/vm-sw\.js$/.test(ctl), `vm-sw.js controls the page (${ctl})`);
  const keys = await page.evaluate(async () => (await (await caches.open('tabcomputer-vm')).keys()).map((r) => new URL(r.url).pathname));
  check(keys.length === 1 && /^\/__vm\/[0-9a-f]{64}\/nc-[0-9a-f]+\/bundle\.mjs$/.test(keys[0]), `one bundle stored, under its layout (${keys})`);

  const two = said(await run('claude --vm'));
  check(two?.cached === true && two.a === 'chunk', 'the next launch imports it from there again');
  const off = said(await run('TABCOMPUTER_VM_CODECACHE=0 claude --vm'));
  check(off?.cached === false && off.a === 'chunk', 'TABCOMPUTER_VM_CODECACHE=0: bundle.js through require, as before');

  // a reload with the worker in charge: the page and its assets still come from the server
  const viaWorker = [];
  page.on('response', (r) => { if (r.fromServiceWorker() && !new URL(r.url()).pathname.startsWith('/__vm/')) viaWorker.push(r.url()); });
  await page.reload();
  await page.waitForFunction(() => window.__tabcomputer?.shell, null, { timeout: 90_000 });
  const navCtl = await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '');
  check(/\/vm-sw\.js$/.test(navCtl) && !viaWorker.length, `after a reload: controlled, and nothing outside /__vm/ answered by the worker${viaWorker.length ? ` (${viaWorker.slice(0, 3)})` : ''}`);
  check((await run('echo hi')).out.includes('hi'), 'the terminal\'s shell runs after the reload');
  const three = said(await run('claude --vm'));
  check(three?.cached === true, 'the launch after a reload imports from the cache');

  const other = await page.evaluate(async () => {
    const r = await fetch('/vm-sw.js');
    const miss = await fetch('/__vm/zzz/nc-9/bundle.mjs');
    return { ok: r.ok, miss: miss.status, missText: await miss.text() };
  });
  check(other.ok && other.miss === 404 && /tabcomputer-vm/.test(other.missText), 'other requests reach the server; a layout not cached is a 404');

  // the off switch, deployed: the next launch requires bundle.js, and the worker and its cache go
  if (process.env.DIST) {
    const file = join(process.env.DIST, 'vm-sw.js');
    const original = readFileSync(file, 'utf8');
    try {
      writeFileSync(file, original.replace('const ENABLED = true;', 'const ENABLED = false;'));
      const offRun = said(await run('claude --vm'));
      const after = await page.evaluate(async () => ({
        regs: (await navigator.serviceWorker.getRegistrations()).map((r) => (r.active ?? r.waiting ?? r.installing)?.scriptURL ?? '').filter((u) => u.endsWith('/vm-sw.js')).length,
        cache: await caches.has('tabcomputer-vm'),
      }));
      check(offRun?.cached === false && offRun.a === 'chunk' && after.regs === 0 && !after.cache, `off switch: bundle.js required, worker unregistered, cache emptied (${JSON.stringify({ cached: offRun?.cached, ...after })})`);
    } finally {
      writeFileSync(file, original);
    }
  } else console.log('skip the off switch (DIST unset)');

  // a cold start where the worker takes the page mid-launch: before, the process requires
  // bundle.js and stores nothing; once taken (clients.claim() takes running workers), it can import
  page = await (await browser.newContext()).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.shell, null, { timeout: 90_000 });
  await page.evaluate(async () => {
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/tmp/vmcc/aaa/nc-1', { recursive: true });
    await fs.writeFile('/tmp/vmcc/aaa/nc-1/bundle.js', 'module.exports.v = 1;');
    await fs.writeFile('/tmp/vmcc/aaa/nc-1/run.mjs', `
const { loadCompiled } = await require('tabcomputer:claude-vm').codeCache();
const load = () => loadCompiled('/tmp/vmcc/aaa/nc-1', () => require('fs').readFileSync('/tmp/vmcc/aaa/nc-1/bundle.js', 'utf8')).then((f) => f === null ? 'null' : typeof f, (e) => 'threw ' + e.message);
console.log('BEFORE ' + await load());
require('fs').writeFileSync('/tmp/vmcc/probed', '1');
await new Promise((r) => setTimeout(r, 4000));
console.log('AFTER ' + await load());`);
  });
  const mid = run('node /tmp/vmcc/aaa/nc-1/run.mjs');
  // (polled here: waitForFunction takes an async predicate's promise as true at once)
  await page.evaluate(async () => {
    for (let i = 0; i < 300; i++) {
      try { await window.__tabcomputer.fs.stat('/tmp/vmcc/probed'); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    throw new Error('the process never probed');
  });
  const stored0 = await page.evaluate(async () => (await caches.keys()).length);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/vm-sw.js', { scope: '/' });
    if (!navigator.serviceWorker.controller) await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
  });
  const midOut = (await mid).out;
  check(/BEFORE null/.test(midOut) && stored0 === 0, `before the worker takes the page: no compiled bundle (bundle.js required), nothing stored (${midOut.trim().split('\n')[0]})`);
  check(/AFTER function/.test(midOut), `the same process once it is taken: the compiled bundle (${midOut.trim().split('\n').pop()})`);
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message)}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
