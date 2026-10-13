// Desktop behaviour from user feedback (docs/DESKTOP.md):
//  1. window order and the focused window survive a reload; safe-mode reset-layout forgets them
//  2. the welcome card drags like a window
//  3. a tall window (Apps) opens above the dock, not past it
//  4. the menu bar follows the focused window's app (Code, opened by the `code` command)
//  5. Code: a File ▸ Open… / Open Folder… in the menu bar, a first-open hint, the editor not clipped
//  6. the other commands' windows (mdview, html, img, finder, spawn) are desktop windows the menu bar follows
//
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/desktop-feedback.mjs [URL]
import { createRequire } from 'node:module';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const require = createRequire(import.meta.url);
let chromium;
({ chromium } = loadPlaywright());

const url = process.argv[2] ?? 'http://localhost:5299/';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const check = (ok, what) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) failed++; };
const boot = async (page) => {
  await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=desktop');
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  await page.waitForTimeout(800);
};
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__fbShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);
const stack = (page) => page.evaluate(() => {
  const wm = window.__shiroDesktop;
  return { order: wm.windows().filter((w) => !w.options.override).map((w) => w.appId), focused: wm.focused()?.appId ?? null };
});
const appName = (page) => page.evaluate(() => document.querySelector('.sd-mb-app')?.textContent);

try {
  // ── 2. the welcome card (a first visit shows it) ──
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await boot(page);
    await page.waitForSelector('.sd-welcome', { timeout: 15_000 });
    // measured once its entrance animation is over
    await page.waitForFunction(() => !document.querySelector('.sd-welcome').getAnimations().length, null, { timeout: 5000 }).catch(() => {});
    const before = await page.locator('.sd-welcome h2').boundingBox();
    await page.mouse.move(before.x + 20, before.y + 8);
    await page.mouse.down();
    await page.mouse.move(before.x - 200, before.y - 150, { steps: 8 });
    await page.mouse.up();
    const after = await page.locator('.sd-welcome h2').boundingBox();
    check(Math.abs(after.x - (before.x - 220)) < 3 && Math.abs(after.y - (before.y - 158)) < 3, `welcome card drags (${Math.round(before.x)},${Math.round(before.y)} → ${Math.round(after.x)},${Math.round(after.y)})`);
    // a button still clicks (Got It closes it), it doesn't start a drag
    await page.locator('.sd-welcome .sd-btn[data-act=close]').click();
    await page.waitForTimeout(400);
    check(!(await page.locator('.sd-welcome').count()), 'its buttons still work (Got It closes it)');
    await context.close();
  }

  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await boot(page);

  // ── 3. Apps opens above the dock ──
  {
    await page.evaluate(() => window.__shiroDesktop.openApp('apps'));
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const w = document.querySelector('.sd-win[data-app=apps]')?.getBoundingClientRect();
      const d = document.querySelector('.sd-dock')?.getBoundingClientRect();
      return w && d && { bottom: w.bottom, top: w.top, dockTop: d.top };
    });
    check(r && r.top >= 0 && r.bottom <= r.dockTop, `Apps opens above the dock at 1280×720 (window ${Math.round(r?.top)}–${Math.round(r?.bottom)}, dock at ${Math.round(r?.dockTop)})`);
  }

  // ── 1. order and focus across a reload ──
  {
    await page.evaluate(async () => { await window.__shiroDesktop.openApp('files'); await window.__shiroDesktop.openApp('settings'); });
    await page.waitForTimeout(500);
    // the main terminal on top and focused, Apps below it, Files at the bottom
    await page.evaluate(() => {
      const wm = window.__shiroDesktop;
      for (const id of ['files', 'settings', 'apps', 'terminal']) wm.windows().find((w) => w.appId === id)?.focus();
    });
    await page.waitForTimeout(800);
    const saved = await stack(page);
    await boot(page);
    await page.waitForTimeout(1500);
    const back = await stack(page);
    const restorable = (o) => o.filter((a) => ['terminal', 'files', 'settings'].includes(a));
    check(JSON.stringify(restorable(back.order)) === JSON.stringify(restorable(saved.order)) && back.focused === 'terminal',
      `order and focus survive a reload (${restorable(saved.order).join(',')} focus ${saved.focused} → ${restorable(back.order).join(',')} focus ${back.focused})`);
    // now Settings on top
    await page.evaluate(() => window.__shiroDesktop.windows().find((w) => w.appId === 'settings')?.focus());
    await page.waitForTimeout(800);
    await boot(page);
    await page.waitForTimeout(1500);
    const s2 = await stack(page);
    check(s2.focused === 'settings' && restorable(s2.order).at(-1) === 'settings' && await appName(page) === 'Settings',
      `a window other than the main terminal keeps the focus (${restorable(s2.order).join(',')}, focus ${s2.focused}, menu bar “${await appName(page)}”)`);
    const r = await sh(page, 'safe-mode reset-layout');
    const cleared = await page.evaluate(() => localStorage.getItem('tabcomputer-desktop-session'));
    check(r.code === 0 && (cleared === null || !JSON.parse(cleared).windows?.some((w) => w.focused && w.app === 'settings')), `safe-mode reset-layout forgets them (${r.out.trim().split('\n')[0]})`);
    await page.evaluate(() => { for (const w of window.__shiroDesktop.windows()) if (w.appId !== 'terminal') w.close(true); });
  }

  // ── 4 + 5. Code ──
  {
    await sh(page, 'mkdir -p ~/proj && printf "hello\\n" > ~/proj/a.txt && printf "two\\n" > ~/b.txt');
    await page.evaluate(() => window.__shiroDesktop.openApp('settings'));
    await page.waitForTimeout(500);
    check(await appName(page) === 'Settings', 'menu bar: Settings while Settings is focused');
    await sh(page, 'code ~/proj');
    await page.waitForTimeout(800);
    check(await appName(page) === 'Code', `menu bar follows the new Code window (“${await appName(page)}”)`);
    const code = await page.evaluate(() => {
      const w = window.__shiroDesktop.focused();
      const f = w?.iframe;
      const fr = f?.getBoundingClientRect(), body = w?.body.getBoundingClientRect();
      return { app: w?.appId, title: w?.title, hint: f?.contentDocument?.querySelector('#hint')?.textContent ?? null, fits: !!fr && !!body && fr.width >= body.width - 1 && fr.height >= body.height - 1,
        sidebar: !!f?.contentDocument?.querySelector('#sidebar'), status: !!f?.contentDocument?.querySelector('#status') };
    });
    check(code.app === 'code', `\`code\` opens a desktop window of the Code app (“${code.title}”)`);
    check(!!code.hint && code.hint.includes('File ▸ Open'), `first open shows the hint (“${(code.hint ?? '').slice(0, 60)}…”)`);
    check(code.fits && code.sidebar && code.status, 'the editor fills the window: file list, tabs, status bar all inside');
    // File ▸ Open…
    await page.locator('.sd-mb-menus .sd-mb-item', { hasText: 'File' }).click();
    const items = await page.locator('.sd-menu .sd-label').allTextContents();
    check(items[0] === 'Open…' && items[1] === 'Open Folder…', `File menu starts with Open… / Open Folder… (${items.slice(0, 3).join(' | ')})`);
    await page.locator('.sd-menu .sd-menu-item', { hasText: 'Open…' }).first().click();
    const input = page.locator('.sd-sheet input[name=path]');
    await input.waitFor({ timeout: 5000 });
    check((await input.inputValue()) === '~/proj/', `Open… starts in the window's folder (${await input.inputValue()})`);
    await input.fill('~/b.txt');
    await input.press('Enter');
    await page.waitForFunction(() => window.__shiroDesktop.windows().filter((w) => w.appId === 'code').length === 2, null, { timeout: 15_000 }).catch(() => {});
    const two = await page.evaluate(() => window.__shiroDesktop.windows().filter((w) => w.appId === 'code').map((w) => ({ title: w.title, hint: !!w.iframe?.contentDocument?.querySelector('#hint') })));
    check(two.length === 2 && two[1].title.includes('b.txt') && !two[1].hint, `Open… opens it in a new Code window, without the hint again (${JSON.stringify(two)})`);
    // a folder given to Open… is refused with a pointer to Open Folder…
    await page.locator('.sd-mb-menus .sd-mb-item', { hasText: 'File' }).click();
    await page.locator('.sd-menu .sd-menu-item', { hasText: 'Open…' }).first().click();
    const live = page.locator('.sd-sheet:not(.sd-leaving)');
    await live.locator('input[name=path]').fill('~/proj');
    await live.locator('input[name=path]').press('Enter');
    const note = await page.waitForFunction(() => document.querySelector('.sd-sheet:not(.sd-leaving) .sd-git-dest')?.textContent || '', null, { timeout: 5000 }).then((h) => h.jsonValue(), () => '');
    check(note.includes('Open Folder'), `Open… on a folder points to Open Folder… (“${note}”)`);
    await page.keyboard.press('Escape');
    // saves go to the window's own file
    await page.evaluate(() => {
      const [a, b] = window.__shiroDesktop.windows().filter((w) => w.appId === 'code');
      b.iframe.contentWindow.parent.postMessage({ type: 'shiro-editor-save', path: '~/b.txt', content: 'from b\n' }, '*');
    });
    await page.waitForTimeout(300);
    // (a message from the page itself, not from either editor, saves nothing)
    const [a, b] = [(await sh(page, 'cat ~/proj/a.txt')).out, (await sh(page, 'cat ~/b.txt')).out];
    check(a.trim() === 'hello' && b.trim() === 'two', `a save message not from a Code window's own editor writes nothing (${JSON.stringify([a, b])})`);
    // from inside the second window's editor (its own realm): that window's file, not the first one's
    await page.evaluate(() => {
      const [, w] = window.__shiroDesktop.windows().filter((x) => x.appId === 'code');
      w.iframe.contentWindow.Function("parent.postMessage({ type: 'shiro-editor-save', path: '~/b.txt', content: 'saved\\n' }, '*')")();
    });
    await page.waitForTimeout(400);
    const [a2, b2] = [(await sh(page, 'cat ~/proj/a.txt')).out, (await sh(page, 'cat ~/b.txt')).out];
    check(a2.trim() === 'hello' && b2.trim() === 'saved', `a save from a Code window's editor writes its own file only (${JSON.stringify([a2, b2])})`);
  }
  // ── the other windows commands open (mdview, html, img, finder, spawn): desktop windows the menu bar follows ──
  {
    await page.evaluate(() => { for (const w of window.__shiroDesktop.windows()) if (w.appId !== 'terminal') w.close(true); });
    await sh(page, 'printf "# Title\\n\\nSome *markdown*.\\n" > ~/n.md && printf "<h1>hi</h1>" > ~/p.html && printf "%s" "<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'20\' height=\'20\'/>" > ~/i.svg');
    const want = { mdview: 'Markdown Viewer', html: 'HTML Viewer', img: 'Image Viewer', finder: 'Finder', spawn: 'Spawn' };
    for (const cmd of ['mdview ~/n.md', 'html ~/p.html', 'img ~/i.svg', 'finder', 'spawn echo hello']) void sh(page, cmd);
    await page.waitForFunction((ids) => ids.every((id) => window.__shiroDesktop.windows().some((w) => w.appId === id)), Object.keys(want), { timeout: 30_000 }).catch(() => {});
    const found = await page.evaluate((ids) => ids.filter((id) => window.__shiroDesktop.windows().some((w) => w.appId === id)), Object.keys(want));
    check(found.length === 5, `mdview, html, img, finder and spawn open desktop windows (${found.join(', ')})`);
    check(await page.evaluate(() => !document.querySelector('body > [data-server-window]')), 'none of them is a floating server window any more');
    const names = [];
    for (const id of [...found, ...found.slice(0, 2)]) {
      await page.evaluate((id) => window.__shiroDesktop.windows().find((w) => w.appId === id).focus(), id);
      await page.waitForTimeout(150);
      names.push([id, await appName(page)]);
    }
    check(names.every(([id, n]) => n === want[id]), `the menu bar follows focus across them (${names.map(([id, n]) => `${id}→${n}`).join(', ')})`);
    // closing through the server-window API (servers' own close) goes through the window manager
    await page.evaluate(() => document.querySelector('[data-server-window]')?._close?.());
    await page.waitForTimeout(300);
    check(await page.evaluate(() => window.__shiroDesktop.windows().filter((w) => ['mdview', 'html', 'img', 'finder', 'spawn'].includes(w.appId)).length) === 4, 'closing one through the server-window API removes its desktop window');
  }
  check(!errors.length, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  await context.close();
  // the classic terminal UI keeps the floating server window
  {
    const classic = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await classic.newPage();
    await page.goto(url + (url.includes('?') ? '&' : '?') + 'ui=terminal');
    await page.waitForFunction(() => window.__tabcomputer?.shell && window.__tabcomputer.kernel, null, { timeout: 120_000 });
    await sh(page, 'printf "<h1>hi</h1>" > ~/p.html');
    void sh(page, 'html ~/p.html');
    const floating = await page.waitForFunction(() => !!document.querySelector('body > [data-server-window]'), null, { timeout: 15_000 }).then(() => true, () => false);
    check(floating, 'the classic terminal UI keeps its floating server window');
    await classic.close();
  }
} catch (e) {
  failed++;
  console.log(`FAIL ${String(e.message).split('\n')[0]}`);
}
await browser.close();
process.exit(failed ? 1 : 0);
