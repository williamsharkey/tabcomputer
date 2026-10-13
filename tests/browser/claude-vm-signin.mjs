// Claude Code's own sign-in under `claude --vm` (docs/CLAUDE_VM.md, "Sign-in"):
// the native build's JavaScript on the page's engine, signed out, runs
// `claude auth login` (and `/login` in a session with LOGIN=session). It starts its localhost callback
// server, prints the URL and "Paste code here if prompted >", and opens the
// automatic URL with $BROWSER (xdg-open), which tabcomputer rewrites to the
// manual flow (src/open-url.ts). The test records that tab, pastes a code, and
// checks the token exchange Claude Code sends and the credentials it saves.
//
// Everything up to the account is real; the account is a stand-in: a front
// proxy in this script answers the token exchange (/api/platform/v1/oauth/token)
// and the account calls under /api/anthropic/api/oauth/, and passes the rest to
// the tabcomputer server.
//
// Needs a build, a server, and the linux-x64-musl binary at dist/__bench/claude-native
// (bench/README.md: native fixtures; a symlink works):
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/claude-vm-signin.mjs [http://localhost:5299/]
// CHROMIUM=/path/to/chrome for another browser; BLOCK=1: the browser blocks the new tab
// (the page offers the link instead); LOGIN=session: /login inside an interactive session,
// then the session's input box, and a terminal resize it must redraw for (SIGWINCH to the
// node guest). Relay-free: the stand-in is reached through the page's own origin.
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { createHash } from 'node:crypto';
import { chromiumPath } from './_browser.mjs';
const require = createRequire(import.meta.url);
let chromium;
for (const p of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright']) {
  try { ({ chromium } = require(p)); break; } catch { /* next */ }
}

const upstream = new URL(process.argv[2] ?? 'http://localhost:5299/');
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const START_MS = 240_000; // (the first start extracts the bundle)
const BLOCK = !!process.env.BLOCK;
const SESSION = process.env.LOGIN === 'session';
const CODE = 'standin-auth-code';
const ACCESS = 'sk-ant-oat01-' + 'a'.repeat(80) + '-standinAA';
const REFRESH = 'sk-ant-ort01-' + 'r'.repeat(80) + '-standinAA';

// ── the front proxy: the account's side stands in, the rest goes to the server ──
const exchanges = [];
const accountCalls = [];
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const profile = {
  account: { uuid: '00000000-0000-4000-8000-00000000000a', email: 'standin@example.com', email_address: 'standin@example.com', display_name: 'Stand-in', full_name: 'Stand In', has_claude_max: true, has_claude_pro: false, created_at: '2025-01-01T00:00:00Z' },
  organization: { uuid: '00000000-0000-4000-8000-00000000000b', name: 'Stand-in org', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', billing_type: 'stripe_subscription', has_extra_usage_enabled: false },
};
const front = createServer((req, res) => {
  const path = req.url;
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (path.startsWith('/api/platform/v1/oauth/token')) {
      let j = {};
      try { j = JSON.parse(body); } catch { j = Object.fromEntries(new URLSearchParams(body)); }
      exchanges.push(j);
      if (process.env.DEBUG) console.log('[token]', JSON.stringify({ ...j, code_verifier: j.code_verifier && '…' }));
      if (j.grant_type === 'authorization_code' && j.code !== CODE) return json(res, 401, { error: 'invalid_grant' });
      return json(res, 200, {
        token_type: 'Bearer', access_token: ACCESS, refresh_token: REFRESH, expires_in: 28800,
        scope: 'user:inference user:profile user:sessions:claude_code user:mcp_servers user:file_upload',
        account: { uuid: profile.account.uuid, email_address: profile.account.email },
        organization: { uuid: profile.organization.uuid, name: profile.organization.name },
      });
    }
    if (path.startsWith('/api/anthropic/api/oauth/') || path.startsWith('/api/anthropic/api/claude_cli') || path.startsWith('/api/anthropic/api/claude_code')) {
      accountCalls.push(`${req.method} ${path}`);
      if (process.env.DEBUG) console.log('[account]', req.method, path);
      if (path.startsWith('/api/anthropic/api/oauth/profile')) return json(res, 200, profile);
      if (path.includes('/roles')) return json(res, 200, { organization_role: 'admin', workspace_role: null, organization_name: profile.organization.name });
      return json(res, 200, {});
    }
    const headers = { ...req.headers, host: upstream.host };
    const up = httpRequest({ host: upstream.hostname, port: upstream.port, path, method: req.method, headers }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    up.end(body.length ? Buffer.from(body, 'binary') : undefined);
  });
  req.setEncoding('binary');
});
await new Promise((r) => front.listen(0, '127.0.0.1', r));
const url = `http://localhost:${front.address().port}/`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript((block) => {
  try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {}
  // The tab xdg-open opens: recorded, not opened (BLOCK=1: refused, as a popup blocker does)
  window.__opened = [];
  window.open = (u) => { window.__opened.push(String(u)); return block ? null : { closed: false, opener: null, close() {} }; };
}, BLOCK);
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
if (process.env.SHOW_CONSOLE) page.on('console', (m) => console.log('[console]', m.text().slice(0, 300)));
const sh = (cmd) => page.evaluate(async (cmd) => {
  const s = window.__siShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
const term = () => page.evaluate(() => {
  const w = window.__shiroDesktop.windows().find((w) => typeof w.content?.activeTerminal === 'function' && w.content.activeTerminal()?.shell.cwd === '/home/user/proj');
  const t = w?.content.activeTerminal();
  return t ? { running: t.foregroundLine ?? null, screen: t.getBufferContent() } : null;
});
const waitScreen = async (re, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    const t = await term();
    if (t && re.test(t.screen)) return t;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; screen:\n${t?.screen.split('\n').slice(-20).join('\n')}`);
    await page.waitForTimeout(500);
  }
};
const typeIn = (text) => page.evaluate((text) => {
  const w = window.__shiroDesktop.windows().find((w) => typeof w.content?.activeTerminal === 'function' && w.content.activeTerminal()?.shell.cwd === '/home/user/proj');
  w.content.activeTerminal().injectInput(text);
}, text);

try {
  await page.goto(url + '?ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  await sh('mkdir -p ~/proj; rm -f ~/.claude/.credentials.json');
  await page.evaluate(async () => {
    const r = await fetch('/__bench/claude-native');
    if (!r.ok) throw new Error(`/__bench/claude-native: ${r.status} (bench/README.md: native fixtures)`);
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/home/user/.local/bin', { recursive: true }).catch(() => {});
    await fs.writeFile('/home/user/.local/bin/claude', new Uint8Array(await r.arrayBuffer()), { mode: 0o755 });
  });
  await page.evaluate(() => window.__shiroDesktopCtx.openTerminal({ cwd: '/home/user/proj' }));
  await page.waitForTimeout(1000);
  // Signed out, and no key in the environment
  await typeIn('unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN\r');
  await page.waitForTimeout(300);

  if (SESSION) {
    // An interactive session's /login: Claude Code's first start asks for a theme, then how to sign in
    await typeIn('claude --vm\r');
    const first = await waitScreen(/theme|Select login method|Paste code here/i, START_MS, 'the first-run screen');
    if (/theme/i.test(first.screen) && !/Select login method/i.test(first.screen)) { await typeIn('\r'); }
    const pick = await waitScreen(/Select login method|Paste code here/i, 60_000, 'the login method picker');
    if (/Select login method/i.test(pick.screen)) { await page.waitForTimeout(500); await typeIn('\r'); }
  } else {
    await typeIn('claude --vm auth login\r');
  }
  const prompt = await waitScreen(/Paste code here/, START_MS, 'the paste prompt');
  check(true, `claude --vm ${SESSION ? '/login' : 'auth login'} reaches "Paste code here if prompted"`);
  const opened = await page.waitForFunction(() => window.__opened.length > 0 && window.__opened, null, { timeout: 30_000 }).then((h) => h.jsonValue(), () => []);
  check(opened.length === 1, `xdg-open opened one tab (${opened.length})`);
  let state = null, challenge = null;
  if (opened[0]) {
    const u = new URL(opened[0]);
    state = u.searchParams.get('state');
    challenge = u.searchParams.get('code_challenge');
    check(/\/oauth\/authorize$/.test(u.pathname), `it is Claude Code's authorize URL (${u.origin}${u.pathname})`);
    check(u.searchParams.get('redirect_uri') === 'https://platform.claude.com/oauth/code/callback', `redirected to the manual code page (${u.searchParams.get('redirect_uri')})`);
    check(u.searchParams.get('code') === 'true' && !!state && !!challenge && u.searchParams.get('code_challenge_method') === 'S256', 'with code=true, its state and its PKCE challenge');
  }
  if (BLOCK) {
    const offered = await page.evaluate(() => document.querySelector('#tabcomputer-open-offer a')?.getAttribute('href') ?? null);
    check(!!offered && offered === opened[0], 'blocked: the page offers the same link to click');
  }
  // The printed URL (the manual one) has the same state
  const printed = prompt.screen.replace(/\n/g, '');
  check(!state || printed.includes(state) || SESSION, 'the URL Claude Code printed carries the same state');

  await typeIn(`${CODE}#${state}`);
  await page.waitForTimeout(300);
  await typeIn('\r');
  const done = await waitScreen(SESSION ? /Login successful|Logged in as/ : /Login successful\.|Login failed/, 120_000, 'the sign-in result');
  check(/Login successful/.test(done.screen), `Claude Code says the sign-in worked${/Login failed/.test(done.screen) ? ': ' + done.screen.split('\n').find((l) => /Login failed/.test(l)) : ''}`);
  const ex = exchanges.find((e) => e.grant_type === 'authorization_code');
  check(!!ex, `the token exchange reached the platform (${exchanges.length} call(s))`);
  if (ex) {
    check(ex.redirect_uri === 'https://platform.claude.com/oauth/code/callback', `it names the manual redirect (${ex.redirect_uri})`);
    check(ex.code === CODE && ex.state === state, 'with the pasted code and its state');
    const s256 = ex.code_verifier ? createHash('sha256').update(ex.code_verifier).digest('base64url') : '';
    check(!!challenge && s256 === challenge, 'and the verifier for the challenge in the URL');
  }
  const creds = await sh('cat ~/.claude/.credentials.json');
  let saved = null;
  try { saved = JSON.parse(creds.out).claudeAiOauth; } catch { /* not JSON */ }
  check(saved?.accessToken === ACCESS && saved?.refreshToken === REFRESH, 'the tokens are saved in ~/.claude/.credentials.json');
  if (process.env.DEBUG) console.log('[account calls]', accountCalls.join(', '));
  if (SESSION) {
    // "Login successful. Press Enter to continue…": then the session's own prompt
    await typeIn('\r');
    const next = await waitScreen(/^\s*(❯|│ >|> )|Press Enter|trust|Yes/m, 60_000, 'the session after sign-in');
    for (let i = 0; i < 3 && !/^\s*❯/m.test(next.screen); i++) { await typeIn('\r'); await page.waitForTimeout(1500); }
    const before = await waitScreen(/^\s*❯/m, 60_000, "the session's input box");
    check(true, 'the session continues to its input box');
    // A resize reaches Claude Code (SIGWINCH to the node guest): its rules redraw at the new width
    const ruleWidth = (screen) => Math.max(0, ...screen.split('\n').map((l) => (l.match(/─{10,}/)?.[0].length ?? 0)));
    const wide = ruleWidth(before.screen);
    const size = await page.evaluate(() => {
      const w = window.__shiroDesktop.windows().find((w) => typeof w.content?.activeTerminal === 'function' && w.content.activeTerminal()?.shell.cwd === '/home/user/proj');
      const t = w.content.activeTerminal();
      t.term.resize(60, t.term.rows);
      return t.getSize?.() ?? { cols: t.term.cols };
    });
    if (process.env.DEBUG) console.log('[resize]', JSON.stringify(size));
    const t0 = Date.now();
    let narrow = wide;
    while (Date.now() - t0 < 15_000 && narrow >= wide) { await page.waitForTimeout(500); narrow = ruleWidth((await term()).screen.split('\n').slice(-12).join('\n')); }
    check(wide > 0 && narrow > 0 && narrow < wide, `the session redraws at the new width after a resize (${wide} -> ${narrow} columns)`);
  } else {
    await typeIn('claude --vm auth status\r');
    const st = await waitScreen(/"loggedIn"\s*:\s*true|"loggedIn"\s*:\s*false/, START_MS, 'auth status');
    check(/"loggedIn"\s*:\s*true/.test(st.screen), 'claude auth status: logged in');
  }
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message)}`);
  await page.screenshot({ path: process.env.FAIL_SHOT || '/tmp/claude-vm-signin-fail.png' }).catch(() => {});
}
await browser.close();
front.close();
process.exit(failed ? 1 : 0);
