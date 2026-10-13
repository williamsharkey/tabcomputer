// Papercuts from a classroom test (tabcomputer#128, #124), the parts only a browser shows:
//  1. `desktop open code DIR` opens DIR, not the home folder
//  2. a terminal reloaded four times shows one restore note and one prompt
//  3. the welcome card's "Write some Python" runs the built-in python3
//  4. `time` prints user and sys in the terminal's format; valgrind's hint
//
//   npx vite build && PORT=5611 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/class-papercuts.mjs http://localhost:5611/
import { chromiumPath, loadPlaywright } from './_browser.mjs';
let chromium;
({ chromium } = loadPlaywright());

const url = process.argv[2] ?? 'http://localhost:5611/';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const boot = async (page, go = true) => {
  if (go) await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && window.__tabcomputer.terminal && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
};
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__cpShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
/** The main terminal's lines that have text */
const screen = (page) => page.evaluate(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const out = [];
  for (let i = 0; i < b.length; i++) { const l = b.getLine(i)?.translateToString(true) ?? ''; if (l.trim()) out.push(l); }
  return out;
});

try {
  // ── 3. the welcome card (a first visit shows it) ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await boot(page);
    await page.waitForSelector('.sd-welcome', { timeout: 15_000 });
    const text = await page.locator('.sd-welcome').innerText();
    check(/Write some Python/.test(text), 'welcome card has "Write some Python"');
    check(!/toolchain install python/.test(text), 'and it does not name toolchain install python');
    check(/python3, built in/.test(text), 'it names the built-in python3');
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);

  // ── 1. desktop open code DIR ──
  {
    await sh(page, 'mkdir -p ~/lab2 && echo "int main(void) { return 0; }" > ~/lab2/hello.c');
    const r = await sh(page, 'cd / && desktop open code ~/lab2');
    check(r.code === 0, `desktop open code ~/lab2 exits 0 (${r.out.trim()})`);
    await page.waitForFunction(() => window.__shiroDesktop.windows().some((w) => w.appId === 'code'), null, { timeout: 30_000 });
    await page.waitForTimeout(1500);
    const w = await page.evaluate(() => {
      const w = window.__shiroDesktop.windows().find((w) => w.appId === 'code');
      // (the editor is a srcdoc frame: its file tree, else the document it was given)
      const doc = w.iframe?.contentDocument;
      return { title: w.title, dir: w.codeDir ?? null, text: doc?.getElementById('sidebar')?.innerText || w.iframe?.srcdoc || '' };
    });
    check(w.dir === '/home/user/lab2' || w.title === 'lab2', `the Code window is on ~/lab2 (title ${JSON.stringify(w.title)}, dir ${w.dir})`);
    check(/hello\.c/.test(w.text) && !/AGENTS\.md/.test(w.text), `it lists hello.c, not the home folder's AGENTS.md`);
    await page.evaluate(() => window.__shiroDesktop.windows().find((w) => w.appId === 'code')?.close());
  }

  // ── 4. time and valgrind at the prompt ──
  {
    const t = await sh(page, 'time true');
    check(/real\t0m0\.\d{3}s\r?\nuser\t0m0\.\d{3}s\r?\nsys\t0m0\.\d{3}s/.test(t.out), `time prints real, user and sys (${JSON.stringify(t.out.trim())})`);
    const v = await sh(page, 'valgrind ./a.out');
    check(v.code === 127 && /-fsanitize=address/.test(v.out), 'valgrind: command not found names -fsanitize=address');
    const w = await sh(page, 'which nosuchthing; echo "rc=$?"');
    check(/nosuchthing not found/.test(w.out) && /rc=1/.test(w.out), 'which names what is missing');
  }

  // ── 2. four reloads: one note, one prompt ──
  {
    const term = page.locator('.sd-win[data-app=terminal] .xterm-helper-textarea').first();
    await term.focus();
    await page.keyboard.type('echo marker-one');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => { const b = window.__tabcomputer.terminal.term.buffer.active; for (let i = 0; i < b.length; i++) if (/^marker-one/.test(b.getLine(i)?.translateToString(true) ?? '')) return true; return false; }, null, { timeout: 15_000 });
    for (let i = 1; i <= 4; i++) {
      // (the session is saved on a timer and on pagehide)
      await page.waitForTimeout(1500);
      await page.reload();
      await boot(page, false);
      await page.waitForFunction(() => { const b = window.__tabcomputer.terminal.term.buffer.active; for (let i = 0; i < b.length; i++) if (/before the page reloaded/.test(b.getLine(i)?.translateToString(true) ?? '')) return true; return false; }, null, { timeout: 30_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      const lines = await screen(page);
      const notes = lines.filter((l) => /before the page reloaded/.test(l)).length;
      const last = lines.at(-1) ?? '';
      const prompts = (last.match(/\$ ?/g) ?? []).length;
      check(notes === 1, `reload ${i}: one restore note (${notes})`);
      check(prompts === 1 && /\$\s*$/.test(last), `reload ${i}: one prompt on the last line (${JSON.stringify(last)})`);
      check(lines.filter((l) => /^marker-one/.test(l)).length === 1, `reload ${i}: the old output is there once`);
    }
  }
  check(errors.length === 0, `no page errors (${errors.slice(0, 3).join(' | ')})`);
  await context.close();
} finally {
  await browser.close();
}
console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
process.exit(failed ? 1 : 0);
