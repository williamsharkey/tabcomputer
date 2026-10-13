// An image pasted into a `claude --vm` session (node in a Worker) becomes
// [Image #1]: the terminal saves it to /tmp and pastes the path
// (src/terminal-file-paste.ts), and Claude Code's paste handler reads the
// file and attaches it. Claude Code looks for image paths only in a paste
// event, so the bracketed paste markers have to reach it (a terminal that
// dropped them showed the path as typed text). Signed in with stand-in credentials (no request is
// sent); the account's calls are answered by a front proxy, as in
// claude-vm-signin.mjs.
//
// Needs a build, a server, and the linux-x64-musl binary at dist/__bench/claude-native:
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/claude-vm-image-paste.mjs [http://localhost:5299/]
// DEBUG=1 prints Claude Code's debug log lines about the paste.
import { createRequire } from 'node:module';
import { createServer, request as httpRequest } from 'node:http';
import { chromiumPath } from './_browser.mjs';
const require = createRequire(import.meta.url);
let chromium;
for (const p of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright']) {
  try { ({ chromium } = require(p)); break; } catch { /* next */ }
}
const upstream = new URL(process.argv[2] ?? 'http://localhost:5299/');
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const START_MS = 300_000; // (the first start extracts the bundle)
const ACCESS = 'sk-ant-oat01-' + 'a'.repeat(80) + '-standinAA';
const REFRESH = 'sk-ant-ort01-' + 'r'.repeat(80) + '-standinAA';
const profile = {
  account: { uuid: '00000000-0000-4000-8000-00000000000a', email: 'standin@example.com', email_address: 'standin@example.com', display_name: 'Stand-in', full_name: 'Stand In', has_claude_max: true, has_claude_pro: false, created_at: '2025-01-01T00:00:00Z' },
  organization: { uuid: '00000000-0000-4000-8000-00000000000b', name: 'Stand-in org', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x', billing_type: 'stripe_subscription', has_extra_usage_enabled: false },
};
const json = (res, status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const front = createServer((req, res) => {
  const path = req.url;
  let body = '';
  req.setEncoding('binary');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    if (path.startsWith('/api/anthropic/') || path.startsWith('/api/platform/')) {
      if (path.includes('/oauth/profile')) return json(res, 200, profile);
      if (path.includes('/roles')) return json(res, 200, { organization_role: 'admin', workspace_role: null, organization_name: profile.organization.name });
      return json(res, 200, {});
    }
    const up = httpRequest({ host: upstream.hostname, port: upstream.port, path, method: req.method, headers: { ...req.headers, host: upstream.host } }, (r) => {
      res.writeHead(r.statusCode ?? 502, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    up.end(body.length ? Buffer.from(body, 'binary') : undefined);
  });
});
await new Promise((r) => front.listen(0, '127.0.0.1', r));
const url = `http://localhost:${front.address().port}/`;

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
await context.addInitScript(() => {
  try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {}
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const sh = (cmd) => page.evaluate(async (cmd) => {
  const s = window.__ipShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
const termOf = `(() => {
  const w = window.__shiroDesktop.windows().find((w) => typeof w.content?.activeTerminal === 'function' && w.content.activeTerminal()?.shell.cwd === '/home/user/proj');
  return w?.content.activeTerminal();
})()`;
const screen = () => page.evaluate((termOf) => eval(termOf)?.getBufferContent() ?? '', termOf);
const waitScreen = async (re, ms, what) => {
  const t0 = Date.now();
  for (;;) {
    const s = await screen();
    if (re.test(s)) return s;
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}; screen:\n${s.split('\n').slice(-20).join('\n')}`);
    await page.waitForTimeout(500);
  }
};
const typeIn = (text) => page.evaluate(([termOf, text]) => eval(termOf).injectInput(text), [termOf, text]);

try {
  await page.goto(url + '?ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  await page.waitForTimeout(2500);
  await page.evaluate(async ([ACCESS, REFRESH]) => {
    const r = await fetch('/__bench/claude-native');
    if (!r.ok) throw new Error(`/__bench/claude-native: ${r.status} (bench/README.md: native fixtures)`);
    const fs = window.__tabcomputer.fs;
    await fs.mkdir('/home/user/.local/bin', { recursive: true }).catch(() => {});
    await fs.writeFile('/home/user/.local/bin/claude', new Uint8Array(await r.arrayBuffer()), { mode: 0o755 });
    await fs.mkdir('/home/user/proj', { recursive: true }).catch(() => {});
    await fs.mkdir('/home/user/.claude', { recursive: true }).catch(() => {});
    await fs.writeFile('/home/user/.claude/.credentials.json', JSON.stringify({ claudeAiOauth: {
      accessToken: ACCESS, refreshToken: REFRESH, expiresAt: Date.now() + 8 * 3600_000,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'], subscriptionType: 'max',
    } }));
    let cfg = {};
    try { cfg = JSON.parse(await fs.readFile('/home/user/.claude.json', 'utf8')); } catch { /* none */ }
    cfg.hasCompletedOnboarding = true;
    cfg.theme = 'dark';
    cfg.projects = { ...(cfg.projects ?? {}), '/home/user/proj': { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } };
    await fs.writeFile('/home/user/.claude.json', JSON.stringify(cfg));
  }, [ACCESS, REFRESH]);
  await page.evaluate(() => window.__shiroDesktopCtx.openTerminal({ cwd: '/home/user/proj' }));
  await page.waitForTimeout(1000);
  await typeIn('unset ANTHROPIC_API_KEY ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN; rm -rf ~/.claude/debug\r');
  await page.waitForTimeout(300);
  await typeIn('claude --vm --debug\r');
  let s = await waitScreen(/^\s*❯|Press Enter|trust|Yes|theme/m, START_MS, 'the session');
  for (let i = 0; i < 6 && !/^\s*❯\s*$/m.test(s); i++) { await typeIn('\r'); await page.waitForTimeout(2000); s = await screen(); }
  await waitScreen(/^\s*❯/m, 60_000, "the session's input box");
  check(true, 'the session reaches its input box');
  await page.waitForTimeout(2000);

  // Cmd+V with an image: the paste event, where the browser fires it
  const path = await page.evaluate(async (termOf) => {
    const c = new OffscreenCanvas(40, 30); const g = c.getContext('2d'); g.fillStyle = '#0a0'; g.fillRect(0, 0, 40, 30);
    const blob = await c.convertToBlob({ type: 'image/png' });
    const dt = new DataTransfer(); dt.items.add(new File([blob], 'image.png', { type: 'image/png' }));
    const t = eval(termOf);
    t.term.focus();
    let got = '';
    const d = t.term.onData((x) => { got += x; });
    t.term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
    for (let i = 0; i < 50 && !got; i++) await new Promise((r) => setTimeout(r, 100));
    d.dispose();
    return got;
  }, termOf);
  console.log('[sent]', JSON.stringify(path));
  check(/^\x1b\[200~\/tmp\/paste-[\d-]+\.png\x1b\[201~$/.test(path), 'the terminal sends the saved path as a bracketed paste');
  let attached = false;
  try { await waitScreen(/\[Image #1\]/, 20_000, '[Image #1]'); attached = true; } catch (e) { console.log(String(e.message)); }
  check(attached, 'Claude Code attaches it as [Image #1]');
  if (process.env.DEBUG || !attached) {
    const log = await sh('cat ~/.claude/debug/*.txt 2>/dev/null | grep -iE "paste|image|clipboard|refused|read" | tail -40');
    console.log(log.out);
  }
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message)}`);
  await page.screenshot({ path: process.env.FAIL_SHOT || '/tmp/claude-vm-image-paste-fail.png' }).catch(() => {});
}
await browser.close();
front.close();
process.exit(failed ? 1 : 0);
