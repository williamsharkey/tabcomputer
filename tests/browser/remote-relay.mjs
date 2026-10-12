// `remote start` over the HTTPS relay, and the freeze watchdog, in Chromium.
// Needs a build, a running server and a built shiro-mcp:
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   (cd shiro-mcp && npm ci && npm run build)
//   node tests/browser/remote-relay.mjs [http://localhost:5299/]
// 1. `remote start` in the page offers a relay mailbox; shiro-mcp (forced to
//    the relay, as in a container without UDP) connects, runs exec and diag.
// 2. A 4 s freeze shows up in diag as a stall, with the command that froze;
//    during a 10 s freeze the watchdog worker answers diag itself.
// 3. A page frozen for good and then closed leaves a wedge record that the next
//    load reports (`watchdog --prev`, previousWedge).
// 2c. `abort` from outside ends a long command like Ctrl-C.
// 4. `watchdog --kernel` lists kernel processes; `watchdog off` holds across a load.
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

// 1. Relay connection
const page = await boot();
await sh(page, 'remote start');
const code = await page.evaluate(() => localStorage.getItem('tabcomputer-remote-code'));
check(!!code, 'remote start registered a code');
await wait(6000); // ICE gathering (up to 5 s) before the offer is posted
// The code is <id>#<secret>; the server is given the id and holds a sealed offer
const [codeId, codeSecret] = String(code).split('#');
check(/^[a-z]+-[a-z]+-[a-z]+$/.test(codeId) && /^[a-z2-7]{26}$/.test(codeSecret ?? ''), 'the code is <id>#<secret>');
const offer = await (await fetch(`${origin}/offer/${codeId}?v=3`)).json();
check(offer.v === 3 && typeof offer.sealed === 'string' && !('offer' in offer), 'the server holds a sealed offer, not the SDP');
check(offer.relay && /^[a-f0-9]{32}$/.test(offer.relay.id), 'the offer names a relay mailbox');
check((await fetch(`${origin}/offer/${codeId}`)).status === 426, 'a client from before protocol 3 is told to update');

const { mcp, call, tool } = startMcp();
await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'remote-relay-check', version: '0' } });
const connected = await tool('connect', { code }).catch((e) => `ERR ${e.message}`);
check(/HTTPS relay/.test(String(connected)), `shiro-mcp connected over the relay (${connected})`);
const ex = await tool('exec', { command: 'echo relay-$((6*7))' }).catch((e) => ({ stdout: `ERR ${e.message}` }));
check(ex.stdout?.replace(/\r\n/g, '\n') === 'relay-42\n', `exec runs in the tab (${JSON.stringify(ex.stdout)})`);
check(/HTTPS relay/.test((await sh(page, 'remote status')).out), 'remote status says HTTPS relay');

// 2. A freeze shows up as a stall with the command that caused it
await sh(page, `js-eval 'const t = Date.now(); while (Date.now() - t < 4000) {}'`);
await wait(1200);
const diag = await tool('diag', { kind: 'stall,note' }).catch((e) => ({ error: e.message }));
const stall = diag.events?.find((e) => e.kind === 'stall');
check(stall && stall.ms >= 3000, `diag shows the stall (${stall?.ms} ms)`);
check(stall?.active?.some((a) => a.includes('js-eval')), `…with the command in flight (${stall?.active?.[0]})`);
check(diag.events?.some((e) => e.kind === 'note' && /worker saw the page frozen/.test(e.text)), 'the worker saw the freeze too');
check(typeof diag.lag?.maxMs1m === 'number' && Array.isArray(diag.procs), 'diag has lag and the process table');

// 2b. While the page is frozen, the watchdog worker (which hosts the relay) answers diag
page.evaluate(() => window.__tabcomputer.shell.execute(`js-eval 'const t = Date.now(); while (Date.now() - t < 10000) {}'`, () => {})).catch(() => {});
await wait(1000);
const t0 = Date.now();
const frozen = await tool('diag', {}).catch((e) => ({ error: e.message }));
check(frozen.frozen === true && Date.now() - t0 < 8000, `diag answers during a freeze (${frozen.error ?? `frozen ${frozen.frozenMs} ms, in ${Date.now() - t0} ms`})`);
check(frozen.snapshot?.active?.some((a) => a.line.includes('js-eval')), `…naming what is running (${frozen.snapshot?.active?.[0]?.line})`);
await wait(10000);
const after = await tool('diag', { kind: 'stall' }).catch((e) => ({ error: e.message }));
check(!after.frozen && after.events?.length > 0, 'the page answers diag itself again afterwards');

// 2c. The kill switch: abort a long command from outside
const long = sh(page, 'slow() { sleep 60; }; slow; echo after=$?');
await wait(1000);
const ab = await tool('abort').catch((e) => ({ error: e.message }));
check(ab.requested === true, `abort accepted (${JSON.stringify(ab).slice(0, 120)})`);
const ended = await Promise.race([long, wait(10000).then(() => null)]);
check(ended && ended.code === 130, `…and the command ended like Ctrl-C (${ended ? `status ${ended.code}` : 'still running after 10 s'})`);
mcp.kill();

// 3. Frozen for good, then closed: the next load reports it
page.evaluate(() => window.__tabcomputer.shell.execute(`js-eval 'for (;;) {}'`, () => {})).catch(() => {});
await wait(12000); // the worker writes the record after 3 s without a heartbeat; 10 s+ offers safe mode
const cdp = await browser.newBrowserCDPSession();
const { targetInfos } = await cdp.send('Target.getTargets');
for (const t of targetInfos) if (t.type === 'page') await cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
await cdp.detach().catch(() => {});
const next = await boot();
await wait(1000);
const prev = JSON.parse((await sh(next, 'watchdog --json -k wedge')).out);
check(prev.previousWedge && prev.previousWedge.seenAt - prev.previousWedge.since >= 3000, `the next load found the wedge record (${prev.previousWedge ? Math.round((prev.previousWedge.seenAt - prev.previousWedge.since) / 1000) + 's' : 'none'})`);
check(prev.previousWedge?.snapshot?.active?.some((a) => a.line.includes('for (;;)')), `…naming what was running (${prev.previousWedge?.snapshot?.active?.[0]?.line})`);
check((await sh(next, 'watchdog --prev -n 400')).out.includes('js-eval'), 'watchdog --prev shows the previous load\'s commands');
const screenText = await next.evaluate(() => { const b = window.__tabcomputer.terminal.term.buffer.active; let t = ''; for (let i = 0; i < b.length; i++) t += b.getLine(i).translateToString(true) + '\n'; return t; });
check(/The last load froze for \d+ s while running: js-eval/.test(screenText) && screenText.includes('safe=1'), 'the next load offers safe mode');
// 4. The kernel side of diag, and the kill switch
const kd = JSON.parse((await sh(next, 'watchdog --kernel')).out);
check(kd && kd.total > 0 && kd.procs.every((p) => Array.isArray(p.fds)), `watchdog --kernel lists kernel processes (${kd?.total})`);
await sh(next, 'watchdog off');
const off = await boot();
check(await off.evaluate(() => !window.__tabcomputerWatchdog), 'watchdog off: not installed on the next load');
check((await sh(off, 'watchdog')).out.includes('not running'), '…and the command says so');
await sh(off, 'watchdog on');
await off.close();
await sh(next, 'remote stop');

await browser.close();
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
