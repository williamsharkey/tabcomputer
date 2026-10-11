// Session restore with real Claude Code (src/agent-resume.ts, src/desktop/session.ts):
// `claude` runs in a desktop terminal against a local stand-in for the
// Messages API, one message is answered, the session file appears, and after
// a reload the terminal comes back running `claude ... --resume <id>` with the
// conversation on screen; ~/AGENTS.md reaches the model with no "external
// imports" question (src/agent-docs.ts). The npm build by default; CLAUDE_BUILD=native runs
// the native one (needs bench/.cache/fixtures/{claude-native,ld-musl-x86_64.so.1},
// served from the build's /__bench/, as bench/claude-tui.mjs does; ~2 min per start).
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/claude-restore.mjs [URL]
// Native: the relay must allow this machine and the stand-in's port, e.g. API_PORT=5311 with
//   TABCOMPUTER_TCP_PORTS=80,443,5311 TABCOMPUTER_TCP_ALLOW_CIDRS=<this machine's address>/32
//   TABCOMPUTER_TCP_ORIGINS=http://localhost:5299 for the server, and a copy of the fixtures in dist/__bench/.
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import os from 'node:os';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }

const url = process.argv[2] ?? 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const build = process.env.CLAUDE_BUILD === 'native' ? 'native' : 'npm';
const START_MS = build === 'native' ? 240_000 : 60_000;
const REPLY = 'pong-from-the-stand-in';
const KEY = 'sk-ant-api03-' + 'x'.repeat(80) + '-standin00AA';

// ── a stand-in for api.anthropic.com: every /v1/messages gets REPLY ──
const asked = [];
let sawAgentsMd = false;
const api = createServer((req, res) => {
  const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*' };
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages')) { res.writeHead(404, { ...cors, 'content-type': 'application/json' }); return res.end('{"type":"error","error":{"type":"not_found_error","message":"stand-in"}}'); }
    let j = {};
    try { j = JSON.parse(body); } catch {}
    if (req.url.startsWith('/v1/messages/count_tokens')) { res.writeHead(200, { ...cors, 'content-type': 'application/json' }); return res.end('{"input_tokens":10}'); }
    asked.push(JSON.stringify(j.messages ?? []).slice(-200));
    if (body.includes('gh issue list')) sawAgentsMd = true; // a line of ~/AGENTS.md (src/agent-docs.ts)
    if (process.env.DEBUG) console.log('[api]', req.url, j.stream ? 'stream' : '', asked.at(-1));
    const msg = { id: 'msg_standin' + asked.length, type: 'message', role: 'assistant', model: j.model || 'claude', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
    if (!j.stream) {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...msg, content: [{ type: 'text', text: REPLY }], stop_reason: 'end_turn' }));
    }
    res.writeHead(200, { ...cors, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const ev = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    ev('message_start', { message: msg });
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: REPLY } });
    ev('content_block_stop', { index: 0 });
    ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
    ev('message_stop', {});
    res.end();
  });
});
await new Promise((r) => api.listen(Number(process.env.API_PORT || 0), '0.0.0.0', r));
// the page reaches it by this machine's address (localhost in the tab is the tab's own network)
const addr = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address ?? '127.0.0.1';
const BASE = `http://${addr}:${api.address().port}`;

// Containers that reach the internet through a proxy (the npm build installs from the registry):
// https only, so the plain-http stand-in stays direct
const proxy = process.env.HTTPS_PROXY ? process.env.HTTPS_PROXY.replace(/^\w+:\/\//, '').replace(/\/$/, '') : '';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox', ...(proxy ? [`--proxy-server=https=${proxy}`] : [])] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, ignoreHTTPSErrors: !!proxy });
await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const boot = async () => {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
};
const sh = (cmd) => page.evaluate(async (cmd) => {
  const s = window.__crShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
/** The terminal window the test opened (cwd ~/proj), and its screen */
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

try {
  await boot();
  await sh('mkdir -p ~/proj');
  if (build === 'native') {
    await page.evaluate(async () => {
      for (const [src, dst] of [['/__bench/claude-native', '/home/user/.local/bin/claude'], ['/__bench/ld-musl-x86_64.so.1', '/lib/ld-musl-x86_64.so.1']]) {
        const r = await fetch(src);
        if (!r.ok) throw new Error(`${src}: ${r.status} (bench/README.md: native fixtures)`);
        await window.__tabcomputer.fs.mkdir(dst.slice(0, dst.lastIndexOf('/')), { recursive: true }).catch(() => {});
        await window.__tabcomputer.fs.writeFile(dst, new Uint8Array(await r.arrayBuffer()), { mode: 0o755 });
      }
    });
  }
  // The key approved, onboarding done (no prompts); the stand-in as the API, for every shell (the restored one too)
  await page.evaluate(async ({ key }) => {
    const fs = window.__tabcomputer.fs;
    let j = {};
    try { j = JSON.parse(await fs.readFile('/home/user/.claude.json', 'utf8')); } catch {}
    j.hasCompletedOnboarding = true;
    j.customApiKeyResponses = { approved: [key.slice(-20)], rejected: [] };
    await fs.writeFile('/home/user/.claude.json', JSON.stringify(j));
  }, { key: KEY });
  await sh(`printf '%s\\n' 'export ANTHROPIC_BASE_URL=${BASE}' 'export ANTHROPIC_API_KEY=${KEY}' >> ~/.profile`);

  await page.evaluate(() => window.__shiroDesktopCtx.openTerminal({ cwd: '/home/user/proj' }));
  await page.waitForTimeout(1000);
  await typeIn(`export ANTHROPIC_BASE_URL=${BASE} ANTHROPIC_API_KEY=${KEY}\r`);
  await page.waitForTimeout(300);
  await typeIn(`claude --${build}\r`);
  await waitScreen(/^\s*(❯|│ >|> )/m, START_MS, "claude's input box");
  check(true, `claude --${build} reaches its prompt`);
  await page.waitForTimeout(build === 'native' ? 10_000 : 3000);
  // ~/AGENTS.md comes in through ~/.claude/CLAUDE.md: no "external imports" question below home
  check(!/External imports|external CLAUDE\.md/.test((await agentTerm()).screen), 'no "Allow external CLAUDE.md file imports?" in ~/proj');
  for (const k of 'ping') { await typeIn(k); await page.waitForTimeout(150); }
  await waitScreen(/^\s*❯\s+ping/m, 60_000, 'ping in the input box');
  await typeIn('\r');
  await waitScreen(new RegExp(REPLY), START_MS, 'the reply');
  check(asked.length > 0, `the stand-in API answered (${asked.length} request(s))`);
  check(sawAgentsMd, '~/AGENTS.md reached the model (in the request)');
  const tracked = await page.waitForFunction(() => {
    const ar = window.__tabcomputer.agentResume;
    return window.__shiroDesktop.windows().some((w) => w.content?.activeTerminal && ar?.forTerminal(w.content.activeTerminal()));
  }, null, { timeout: 30_000 }).then(() => true, () => false);
  check(tracked, 'the run is tracked (agent-resume found its session file)');
  const files = await sh('ls ~/.claude/projects/-home-user-proj/');
  const id = (files.out.match(/([0-9a-f-]{36})\.jsonl/) ?? [])[1];
  check(!!id, `its session file: ${id ?? files.out.trim()}`);
  await page.waitForTimeout(4500); // a save (every 3 s while terminals print)

  // ── reload ──
  await boot();
  const t = await waitScreen(new RegExp(REPLY), START_MS, 'the resumed conversation').catch((e) => { check(false, e.message); return null; });
  if (t) {
    check((t.running ?? '').includes('--resume') && (!id || t.running.includes(id)), `the terminal resumes the session (${t.running})`);
    check(/ping/.test(t.screen), 'the conversation is on screen after the reload');
  }
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message)}`);
  await page.screenshot({ path: process.env.FAIL_SHOT || '/tmp/claude-restore-fail.png' }).catch(() => {});
}
await browser.close();
api.close();
process.exit(failed ? 1 : 0);
