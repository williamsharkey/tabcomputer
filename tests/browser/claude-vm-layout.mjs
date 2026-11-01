// claude --vm's layout in the real app (src/claude-vm/extract.ts, module-store.ts),
// with a synthetic Bun executable as the native build: the first `claude --vm`
// lays the modules out and runs the entry (a chunk's live binding, a chunk's
// default through import.meta.require, Bun, the build's env); modules.js is in
// the 'tabcomputer-claude-vm' cache under its layout; a service worker an
// earlier build registered (/vm-sw.js, now shipped switched off) is taken out
// with its cache; after a reload it runs again; with the cache entry gone it
// reads modules.js from the files and puts it back.
// (Real Claude Code through it: CLAUDE_BUILD=vm PREINSTALLED=1 node tests/browser/claude-restore.mjs.)
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/claude-vm-layout.mjs [URL]
import { fakeBunElf } from '../tests/shiro-vitest/fake-bun-elf.mjs';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const url = process.argv[2] || 'http://localhost:5299/';
const browser = await chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium'), args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const run = (cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const sh = window.__ccShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await sh.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { code, out };
}, cmd);
const said = (r) => { const m = /VMLAYOUT (\{.*\})/.exec(r.out); return m ? JSON.parse(m[1]) : null; };
const keys = () => page.evaluate(async () => (await (await caches.open('tabcomputer-claude-vm')).keys()).map((r) => new URL(r.url).pathname));
const boot = async () => {
  await page.waitForFunction(() => window.__tabcomputer?.shell, null, { timeout: 90_000 });
  await page.evaluate(() => { delete window.__ccShell; });
};

// The entry reads a chunk's export that the chunk's initializer sets (live), and a
// command module's default as Bun's import.meta.require gives it
const elf = fakeBunElf([
  { name: '/$bunfs/root/chunk-a.js', contents: '// @bun\nvar a;function init(){a="chunk"}export{a,init};\n', loader: 1 },
  { name: '/$bunfs/root/chunk-cmd.js', contents: '// @bun\nvar o={name:"cmd"};export{o as default};\n', loader: 1 },
  { name: '/$bunfs/root/cli', contents: '// @bun\nimport{a,init}from"/$bunfs/root/chunk-a.js";init();var c=import.meta.require("/$bunfs/root/chunk-cmd.js").default;\n'
    + 'console.log("VMLAYOUT " + JSON.stringify({ a, cmd: c && c.name, bun: typeof Bun.version, build: process.env.TABCOMPUTER_CLAUDE_BUILD }));\n', loader: 1 },
], 2);
// (claude --vm takes a file over 1 MB as the native build)
const padded = new Uint8Array(1_100_000);
padded.set(elf);

try {
  await page.goto(url);
  await boot();
  // as an earlier build left it: its service worker registered, its cache there
  const swOff = await page.evaluate(async () => (await (await fetch('/vm-sw.js', { cache: 'no-store' })).text()).includes('const ENABLED = false;'));
  check(swOff, 'vm-sw.js is deployed switched off');
  await page.evaluate(async () => {
    await navigator.serviceWorker.register('/vm-sw.js', { scope: '/' }).catch(() => {});
    await (await caches.open('tabcomputer-vm')).put('/__vm/old/bundle.mjs', new Response('x'));
  });

  await page.evaluate(async (b64) => {
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/home/user/.local/bin', { recursive: true });
    await fs.writeFile('/home/user/.local/bin/claude', Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
  }, Buffer.from(padded).toString('base64'));

  const first = await run('claude --vm');
  const one = said(first);
  check(one?.a === 'chunk' && one.cmd === 'cmd' && one.bun === 'string' && one.build === 'vm', `the first claude --vm lays out and runs the entry (${JSON.stringify(one) ?? first.out.slice(-400)})`);
  const k = await keys();
  check(k.length === 1 && /^\/__claude-vm\/[0-9a-f]{64}\/nc-[0-9a-f]+\/modules\.js$/.test(k[0]), `modules.js cached under its layout (${k})`);
  const gone = await page.evaluate(async () => {
    for (let i = 0; i < 50 && (await caches.has('tabcomputer-vm')); i++) await new Promise((r) => setTimeout(r, 100));
    const regs = (await navigator.serviceWorker.getRegistrations()).filter((r) => ((r.active ?? r.waiting ?? r.installing)?.scriptURL ?? '').endsWith('/vm-sw.js'));
    return { regs: regs.length, cache: await caches.has('tabcomputer-vm') };
  });
  check(gone.regs === 0 && !gone.cache, `an earlier build's service worker and its cache are gone (${JSON.stringify(gone)})`);

  await page.reload();
  await boot();
  check(said(await run('claude --vm'))?.a === 'chunk', 'after a reload it runs again');

  // the cache entry gone (evicted): modules.js from the files, and back into the cache
  await page.evaluate(async () => caches.delete('tabcomputer-claude-vm'));
  await page.reload();
  await boot();
  check(said(await run('claude --vm'))?.cmd === 'cmd', 'with the cache entry gone it runs from the files');
  const back = await page.evaluate(async () => {
    for (let i = 0; i < 50; i++) { if ((await (await caches.open('tabcomputer-claude-vm')).keys()).length) return true; await new Promise((r) => setTimeout(r, 100)); }
    return false;
  });
  check(back, 'and puts modules.js back in the cache');
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message)}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
