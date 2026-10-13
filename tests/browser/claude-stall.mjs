// tabcomputer#19: Claude Code between a tool result and the model's next reply, and whether it
// can be quit there. Real Claude Code in a desktop terminal against a local stand-in for the
// Messages API, as claude-restore.mjs:
//   1. SIGTERM at the idle prompt ends it (`kill -TERM PID` from another shell);
//   2. ROUNDS Bash tool calls in a row, each result going back to the model, with writer-less
//      FIFOs under /tmp and the `find … -type p` calls the issue's freezes followed (#21);
//   3. the stand-in then takes the request that carries a tool result and never answers: the
//      state the issue's transcripts show. Claude Code has to stay alive (its screen keeps
//      changing), and SIGTERM has to end it there too. SIGKILL is the fallback, reported.
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   CLAUDE_BUILD=vm|native|npm node tests/browser/claude-stall.mjs [URL]
// vm (the default here) and native need bench/.cache/fixtures/{claude-native,ld-musl-x86_64.so.1}
// copied to dist/__bench/ (bench/README.md). native (`claude --x86`) reaches the stand-in through
// the relay: API_PORT=5311 with TABCOMPUTER_TCP_RELAY=1 TABCOMPUTER_TCP_PORTS=80,443,5311
// TABCOMPUTER_TCP_ALLOW_CIDRS=<this machine's address>/32 TABCOMPUTER_TCP_ORIGINS=http://localhost:5299
// for the server. ROUNDS=8 by default. PLAYWRIGHT= and CHROMIUM= pick the tools.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import os from 'node:os';
const require = createRequire(import.meta.url);
let chromium;
for (const name of [process.env.PLAYWRIGHT, 'playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) {
  try { ({ chromium } = require(name)); break; } catch { /* the next one */ }
}

const url = process.argv[2] ?? 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const build = ['native', 'npm'].includes(process.env.CLAUDE_BUILD) ? process.env.CLAUDE_BUILD : 'vm';
const flag = build === 'native' ? 'x86' : build;
const START_MS = build === 'native' ? 240_000 : build === 'vm' ? 150_000 : 60_000; // (vm: the first start extracts)
const TURN_MS = build === 'native' ? 60_000 : 20_000; // one tool call and the request after it
const ROUNDS = Number(process.env.ROUNDS || 8);
const KEY = 'sk-ant-api03-' + 'x'.repeat(80) + '-standin00AA';
const DONE = 'all-tools-done-from-the-stand-in';

// The commands the model "asks" for: the shapes the issue's freezes followed, then plain ones
const COMMANDS = [
  'mkfifo /tmp/stall-a.fifo /tmp/stall-b.fifo; echo fifos-made',
  'find /tmp -maxdepth 2 | head',
  'command find /tmp -maxdepth 2 -type p',
  'ls -la /tmp | head -20',
  'grep -r fifos /tmp/nothing-here 2>/dev/null; echo grep-done',
  'echo round-$(date +%s)',
];

// ── a stand-in for api.anthropic.com ──
// "go": ROUNDS tool calls, then DONE. "stall": one tool call, then the request with its result
// is read and never answered.
let toolCalls = 0, results = 0, stalled = 0, mode = '', lastId = '';
const answered = new Set();
const held = [];
const api = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404, { ...cors, 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"stand-in"}}'); }
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end('{"input_tokens":10}'); }
    let j = {};
    try { j = JSON.parse(body); } catch {}
    const main = (j.tools ?? []).some((t) => t.name === 'Bash');
    // the request that carries the result of the call asked for last (reminders may follow it
    // in the message list, so the last message isn't always the result)
    const hasResult = !!lastId && body.includes(`"tool_use_id":"${lastId}"`);
    if (process.env.DEBUG) console.log('[api]', req.url, main ? 'main' : 'side', mode, hasResult ? `result of ${lastId}` : '', body.length);
    if (main && hasResult && !answered.has(lastId)) { answered.add(lastId); results++; }
    const msg = { id: 'msg_standin' + Date.now(), type: 'message', role: 'assistant', model: j.model || 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    if (main && mode === 'stall' && hasResult && lastId.startsWith('toolu_stall')) { stalled++; held.push(res); return; } // never answered
    if (!j.stream) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' }));
    }
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: msg });
    // one call at a time: the next only in the request that brings the last one's result
    const wantsTool = main && (!lastId || hasResult) && ((mode === 'go' && toolCalls < ROUNDS) || (mode === 'stall' && !lastId.startsWith('toolu_stall')));
    if (wantsTool) {
      const n = toolCalls++;
      lastId = (mode === 'stall' ? 'toolu_stall' : 'toolu_standin') + n;
      const input = { command: mode === 'stall' ? 'echo before-the-stall' : COMMANDS[n % COMMANDS.length], description: 'Run a command' };
      ev('content_block_start', { index: 0, content_block: { type: 'tool_use', id: lastId, name: 'Bash', input: {} } });
      ev('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } });
    } else {
      ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: main && mode === 'go' && toolCalls >= ROUNDS && hasResult ? DONE : 'ok' } });
      ev('content_block_stop', { index: 0 });
      ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    }
    ev('message_stop', {});
    res.end();
  });
});
await new Promise((r) => api.listen(Number(process.env.API_PORT || 0), '0.0.0.0', r));
// the page reaches it by this machine's address (localhost in the tab is the tab's own network)
const addr = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
const BASE = `http://${addr}:${api.address().port}`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const sh = (cmd) => page.evaluate(async (cmd) => {
  const s = window.__csShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
const agentTerm = () => page.evaluate(() => {
  const w = window.__shiroDesktop.windows().find((w) => typeof w.content?.activeTerminal === 'function' && w.content.activeTerminal()?.shell.cwd === '/home/user/proj');
  const t = w?.content.activeTerminal();
  return t ? { running: t.foregroundLine ?? null, screen: t.getBufferContent() } : null;
});
const waitScreen = async (re, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    const t = await agentTerm();
    if (t && re.test(t.screen)) return t;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; screen:\n${t?.screen.split('\n').slice(-15).join('\n')}`);
    await page.waitForTimeout(500);
  }
};
const typeIn = (text) => page.evaluate((text) => {
  const w = window.__shiroDesktop.windows().find((w) => typeof w.content?.activeTerminal === 'function' && w.content.activeTerminal()?.shell.cwd === '/home/user/proj');
  w.content.activeTerminal().injectInput(text);
}, text);
/** Claude Code's kernel process: the binary (native), or the node that runs its JavaScript */
const claudePid = () => page.evaluate((build) => {
  const live = [...window.__tabcomputer.kernel.procs.values()].filter((p) => p.state !== 'zombie' && !p.exiting);
  const line = (p) => (p.argv ?? []).join(' ');
  const hit = build === 'native'
    ? live.filter((p) => /\/claude$/.test(p.argv?.[0] ?? ''))
    : live.filter((p) => /(^|\/)node$/.test(p.argv?.[0] ?? '') && /claude/.test(line(p)));
  // the first started: a session's own children (its shells) come later
  return hit.length ? Math.min(...hit.map((p) => p.pid)) : null;
}, build);
const alive = (pid) => page.evaluate((pid) => {
  const p = window.__tabcomputer.kernel.procs.get(pid);
  return !!p && p.state !== 'zombie';
}, pid);
/** `kill -SIG PID` from the side shell, then how long until the process is gone and the terminal has its shell back (null: still there after ms) */
const killAndWait = async (sig, pid, ms) => {
  const t0 = Date.now();
  await sh(`kill -${sig} ${pid}`);
  for (;;) {
    const t = await agentTerm();
    if (!(await alive(pid)) && !t?.running) return Date.now() - t0;
    if (Date.now() - t0 > ms) return null;
    await page.waitForTimeout(250);
  }
};
const start = async () => {
  await typeIn(`claude --${flag} --dangerously-skip-permissions\r`);
  await waitScreen(/^\s*(❯|│ >|> )/m, START_MS, "claude's input box");
  await page.waitForTimeout(build === 'native' ? 10_000 : 3000);
  const pid = await claudePid();
  if (pid == null) throw new Error('no claude process in the kernel\'s table');
  return pid;
};
const say = async (text) => {
  for (const k of text) { await typeIn(k); await page.waitForTimeout(build === 'native' ? 400 : 120); }
  await waitScreen(new RegExp(`^\\s*❯\\s+${text}`, 'm'), 60_000, `${text} in the input box`);
  await typeIn('\r');
};

try {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  await sh('mkdir -p ~/proj');
  if (build !== 'npm') {
    await page.evaluate(async () => {
      for (const [src, dst] of [['/__bench/claude-native', '/home/user/.local/bin/claude'], ['/__bench/ld-musl-x86_64.so.1', '/lib/ld-musl-x86_64.so.1']]) {
        const r = await fetch(src);
        if (!r.ok) throw new Error(`${src}: ${r.status} (bench/README.md: native fixtures)`);
        await window.__tabcomputer.fs.mkdir(dst.slice(0, dst.lastIndexOf('/')), { recursive: true }).catch(() => {});
        await window.__tabcomputer.fs.writeFile(dst, new Uint8Array(await r.arrayBuffer()), { mode: 0o755 });
      }
    });
  }
  // The key approved, onboarding done, the bypass warning accepted: no prompts
  await page.evaluate(async ({ key }) => {
    const fs = window.__tabcomputer.fs;
    let j = {};
    try { j = JSON.parse(await fs.readFile('/home/user/.claude.json', 'utf8')); } catch {}
    j.hasCompletedOnboarding = true;
    j.customApiKeyResponses = { approved: [key.slice(-20)], rejected: [] };
    await fs.writeFile('/home/user/.claude.json', JSON.stringify(j));
    let st = {};
    try { st = JSON.parse(await fs.readFile('/home/user/.claude/settings.json', 'utf8')); } catch {}
    st.skipDangerousModePermissionPrompt = true;
    await fs.mkdir('/home/user/.claude', { recursive: true }).catch(() => {});
    await fs.writeFile('/home/user/.claude/settings.json', JSON.stringify(st));
  }, { key: KEY });
  await page.evaluate(() => window.__shiroDesktopCtx.openTerminal({ cwd: '/home/user/proj' }));
  await page.waitForTimeout(1000);
  await typeIn(`export ANTHROPIC_BASE_URL=${BASE} ANTHROPIC_API_KEY=${KEY}\r`);
  await page.waitForTimeout(300);

  // ── 1. SIGTERM at the idle prompt ──
  let t0 = Date.now();
  let pid = await start();
  console.log(`     (claude --${flag}: prompt in ${((Date.now() - t0) / 1000).toFixed(1)} s, pid ${pid})`);
  let ms = await killAndWait('TERM', pid, 30_000);
  check(ms != null, `SIGTERM at the idle prompt ends claude --${flag}${ms != null ? ` (${ms} ms)` : ' (still running after 30 s)'}`);
  if (ms == null) await killAndWait('KILL', pid, 15_000);

  // ── 2. tool calls in a row, FIFOs under /tmp ──
  pid = await start();
  mode = 'go';
  t0 = Date.now();
  await say('go');
  const done = await waitScreen(new RegExp(DONE), ROUNDS * TURN_MS + START_MS, `the reply after ${ROUNDS} tool calls`).then(() => true, (e) => { console.log(String(e.message).split('\n').slice(0, 12).join('\n')); return false; });
  check(done && toolCalls === ROUNDS && results >= ROUNDS, `${ROUNDS} Bash calls, each result answered by the next request (${toolCalls} calls, ${results} results, ${((Date.now() - t0) / 1000).toFixed(1)} s)`);

  // ── 3. the request after a tool result is never answered ──
  if (done) {
    mode = 'stall';
    await say('stall');
    const t1 = Date.now();
    while (!stalled && Date.now() - t1 < TURN_MS + START_MS) await page.waitForTimeout(250);
    check(stalled > 0, 'the request carrying the tool result reached the stand-in, which holds it');
    // Alive while it waits: the spinner and its timer keep drawing
    const a = (await agentTerm()).screen;
    await page.waitForTimeout(build === 'native' ? 8000 : 4000);
    const b = (await agentTerm()).screen;
    check(a !== b, 'claude keeps drawing while the model is silent (its event loop runs)');
    check(await alive(pid), 'and is still running');
    ms = await killAndWait('TERM', pid, 30_000);
    check(ms != null, `SIGTERM ends it while it waits for the model${ms != null ? ` (${ms} ms)` : ' (still running after 30 s)'}`);
    if (ms == null) {
      const k = await killAndWait('KILL', pid, 15_000);
      console.log(`     (SIGKILL: ${k != null ? `gone in ${k} ms` : 'still there after 15 s'})`);
    }
  }
  const prompt = await sh('echo side-shell-answers');
  check(prompt.out.includes('side-shell-answers'), 'the page still runs commands');
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message)}`);
  await page.screenshot({ path: process.env.FAIL_SHOT || '/tmp/claude-stall-fail.png' }).catch(() => {});
}
for (const r of held) r.destroy();
await browser.close();
api.close();
process.exit(failed ? 1 : 0);
