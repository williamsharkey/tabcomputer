// Session restore, the agent part (src/agent-resume.ts): a line the user types
// into the terminal that runs an agent CLI is tracked, and its resume command
// appears once the session file does. A fake `codex` on PATH stands in for
// the real one (no download, no API). Needs a build and a running server:
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/agent-resume.mjs [http://localhost:5299/]
import { createRequire } from 'node:module';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const require = createRequire(import.meta.url);
let chromium;
({ chromium } = loadPlaywright());

const base = process.argv[2] || 'http://localhost:5299/';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
let failures = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failures++; };
const ID = '0f0e0d0c-0b0a-4908-8706-050403020100';

await page.goto(new URL('/?ui=terminal', base).toString());
await page.waitForFunction(() => window.__tabcomputer?.shell && !sessionStorage.getItem('tabcomputer-boots-unfinished'), null, { timeout: 90000 });
await page.evaluate(async (id) => {
  const fake = '#!/bin/sh\n'
    + 'd="$HOME/.codex/sessions/$(date +%Y/%m/%d)"\nmkdir -p "$d"\n'
    + `echo '{"type":"session_meta"}' > "$d/rollout-2026-10-11T00-00-00-${id}.jsonl"\n`
    + 'echo fake codex running\nsleep 60\n';
  await window.__tabcomputer.fs.mkdir('/usr/local/bin', { recursive: true });
  await window.__tabcomputer.fs.writeFile('/usr/local/bin/codex', fake, { mode: 0o755 });
}, ID);

const resume = () => page.evaluate(() => window.__tabcomputer.agentResume.forTerminal(window.__tabcomputer.terminal));
check((await resume()) === null, 'nothing to resume at an idle prompt');
await page.evaluate(() => window.__tabcomputer.terminal.injectInput('codex --sandbox danger-full-access\r'));
let cmd = null;
for (let i = 0; i < 40 && !cmd; i++) { await page.waitForTimeout(250); cmd = await resume(); }
check(!!cmd && cmd.line === `codex resume --sandbox danger-full-access ${ID}` && cmd.cwd === '/home/user', `while it runs: ${cmd ? cmd.line : 'null'}`);
await page.evaluate(() => window.__tabcomputer.terminal.injectInput('\x03'));
let gone = false;
for (let i = 0; i < 40 && !gone; i++) { await page.waitForTimeout(250); gone = (await resume()) === null; }
check(gone, 'after Ctrl-C ends it, nothing to resume');

await browser.close();
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
