// Live profile (src/live-profile.ts) from outside, in Chromium: shiro-mcp's
// `profile` tool over the HTTPS relay captures typed keys and their echo, a
// long task and a kernel program's syscalls, and writes JSON and a Chrome trace.
// Needs a build, a running server and a built shiro-mcp:
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   (cd shiro-mcp && npm ci && npm run build)
//   node tests/browser/live-profile.mjs [http://localhost:5299/]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const base = process.argv[2] || 'http://localhost:5299/';
const origin = new URL(base).origin;
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const mcpPath = fileURLToPath(new URL('../../shiro-mcp/dist/index.js', import.meta.url));
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext();
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot() {
  const page = await context.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(base);
  await page.waitForFunction(() => window.__tabcomputer?.shell, null, { timeout: 90000 });
  return page;
}
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const s = window.__checkShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return { code, out: out.replace(/\r\n/g, '\n') };
}, cmd);

// shiro-mcp over stdio
function startMcp() {
  const mcp = spawn(process.execPath, [mcpPath], {
    env: { ...process.env, TABCOMPUTER_SIGNALING_URL: origin, TABCOMPUTER_TRANSPORT: 'relay' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (process.env.SHOW_MCP) mcp.stderr.on('data', (d) => process.stdout.write(`[mcp] ${d}`));
  let buf = '';
  const waiters = new Map();
  mcp.stdout.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const r = JSON.parse(line); waiters.get(r.id)?.(r); } catch { /* not JSON-RPC */ }
    }
  });
  let id = 0;
  const call = (method, params) => new Promise((resolve) => {
    const n = ++id; waiters.set(n, resolve);
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n');
  });
  const tool = async (name, args = {}) => {
    const r = await call('tools/call', { name, arguments: args });
    const text = r.result?.content?.[0]?.text ?? '';
    if (r.error || r.result?.isError) throw new Error(r.error?.message || text);
    try { return JSON.parse(text); } catch { return text; }
  };
  return { mcp, call, tool };
}


// 1. Connect over the relay, as from a cloud container
const page = await boot();
await sh(page, 'remote start');
const code = await page.evaluate(() => localStorage.getItem('tabcomputer-remote-code'));
await wait(6000);
const { mcp, call, tool } = startMcp();
await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'live-profile-check', version: '0' } });
const connected = await tool('connect', { code }).catch((e) => `ERR ${e.message}`);
check(/HTTPS relay/.test(String(connected)), `shiro-mcp connected over the relay (${connected})`);

// 2. A capture: typed keys echo, a long task, a kernel program's syscalls
const st = await tool('profile', { action: 'start', sampleMs: 50, durationMs: 60000, label: 'browser check' }).catch((e) => ({ error: e.message }));
check(st.meta?.running === true && st.meta.sampleMs === 50, `profile start (${st.error ?? st.meta?.id})`);
await tool('profile', { action: 'mark', text: 'typing' });
await page.click('.xterm');
await page.keyboard.type('echo typed', { delay: 60 });
await page.keyboard.press('Enter');
await wait(500);
await sh(page, `js-eval 'const t = Date.now(); while (Date.now() - t < 400) {}'`);
const lua = await tool('exec', { command: `lua -e 'for i = 1, 200 do io.write(i, " ") end print()' | wc -c` }).catch((e) => ({ stdout: `ERR ${e.message}` }));
check(Number(lua.stdout) > 500, `a kernel program ran during the capture (lua, ${String(lua.stdout).trim()} bytes; ${String(lua.stderr ?? '').slice(0, 120)})`);
await wait(300);
const stop = await tool('profile', { action: 'stop' }).catch((e) => ({ error: e.message }));
check(stop.meta?.running === false && stop.summary?.length >= 3, `profile stop with a summary:\n    ${(stop.summary ?? [stop.error]).join('\n    ')}`);
const kernelHooked = await page.evaluate(() => Object.prototype.hasOwnProperty.call(window.__tabcomputer.kernel, 'syscall'));
check(!kernelHooked, 'the kernel is unhooked after stop');

// 3. Collect: JSON and a Chrome trace written by shiro-mcp
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-profile-'));
const out = path.join(dir, 'p.json');
const col = await tool('profile', { action: 'collect', out }).catch((e) => ({ error: e.message }));
check(col.out === out && fs.existsSync(out) && fs.existsSync(`${out}.trace.json`), `collect wrote ${out} and the trace (${col.error ?? 'ok'})`);
const p = JSON.parse(fs.readFileSync(out, 'utf8'));
const keys = p.inputs.filter((i) => i.name === 'keydown' && i.key);
const echoed = keys.filter((k) => k.echoMs !== undefined);
check(keys.length >= 10 && echoed.length >= keys.length - 2, `keydowns ${keys.length}, echoed ${echoed.length} (echo ms ${echoed.map((k) => Math.round(k.echoMs)).join(',')})`);
check(!JSON.stringify(p.inputs).includes('"key":"e"'), 'key values are not recorded');
const lt = p.tasks.filter((t) => t.ms >= 350);
check(lt.length >= 1, `the 400 ms freeze is a long task or frame (${p.tasks.map((t) => `${t.kind} ${Math.round(t.ms)}`).join(', ')})`);
const luaSys = p.syscalls.filter((s) => p.procs.some((q) => q.pid === s.pid && /lua/.test(q.cmd)) || /lua/.test(String(p.procs.find((q) => q.pid === s.pid)?.cmd)));
const anySys = p.syscalls.reduce((a, s) => a + s.sync + s.async, 0);
check(anySys > 0 && p.syscalls.some((s) => s.name === 'write' || s.name === 'writev'), `syscalls counted (${anySys}; top ${p.syscalls.slice(0, 4).map((s) => `${s.pid}:${s.name ?? s.nr} ${s.sync}/${s.async}`).join(', ')}; lua rows ${luaSys.length})`);
check(p.samples.length >= 20 && p.samples.some((s) => s.out > 0), `samples ${p.samples.length}, terminal output seen`);
check(p.marks.some((m) => m.text === 'typing'), 'the mark is in the capture');
const tr = JSON.parse(fs.readFileSync(`${out}.trace.json`, 'utf8'));
check(tr.traceEvents.some((e) => e.cat === 'echo' && e.ph === 'X') && tr.traceEvents.some((e) => e.ph === 'C'), `the trace has echo spans and counters (${tr.traceEvents.length} events)`);

// 4. watchdog profile in the tab
const local = await sh(page, 'watchdog profile start -d 2 -i 50 local; sleep 0.3; watchdog profile mark hi; watchdog profile stop');
check(local.code === 0 && /profile p\w+ \(local\): ended \(stopped\)/.test(local.out), `watchdog profile start/stop (${local.out.split('\n')[1] ?? local.out})`);
const saved = await sh(page, 'watchdog profile save /tmp/p.json && wc -c < /tmp/p.json');
check(saved.code === 0 && Number(saved.out) > 100, `watchdog profile save (${saved.out.trim()} bytes)`);

mcp.kill();

// 5. shiro-mcp/profile.mjs, the CLI (a new peer on the same mailbox, as after a restart)
const cliOut = path.join(dir, 'cli.json');
const cli = await new Promise((resolve) => {
  const c = spawn(process.execPath, [fileURLToPath(new URL('../../shiro-mcp/profile.mjs', import.meta.url)), code, cliOut, '--seconds', '30', '--sample', '50', '--label', 'cli', '--run', `lua -e 'print(1)'`],
    { env: { ...process.env, TABCOMPUTER_SIGNALING_URL: origin } });
  let text = '';
  c.stdout.on('data', (d) => { text += d; });
  c.stderr.on('data', (d) => { text += d; });
  c.on('exit', (status) => resolve({ status, text }));
});
const cp = fs.existsSync(cliOut) ? JSON.parse(fs.readFileSync(cliOut, 'utf8')) : null;
check(cli.status === 0 && cp?.meta?.label === 'cli' && cp.meta.endReason === 'stopped' && cp.marks.some((m) => m.text.startsWith('run: lua')), `profile.mjs --run captured and stopped (${cli.text.trim().split('\n').slice(-2).join(' | ')})`);
await browser.close();
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
