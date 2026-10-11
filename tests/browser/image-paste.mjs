// Pasting and dropping an image on the terminal, in Chromium:
//  1. a paste event carrying only an image (what Cmd+V delivers on a Mac) reaches
//     the terminal as a path to the image saved in /tmp, before xterm.js's own
//     paste handler (which pastes text only) sees it;
//  2. a dropped image file does the same;
//  3. Claude Code's Ctrl+V route from node as a kernel guest (a Worker): through a
//     shell, `xclip -t TARGETS -o | grep image/...` finds the browser clipboard's
//     image and `xclip -t image/png -o > file` saves its bytes
//     (navigator.clipboard.read, with clipboard-read granted).
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/image-paste.mjs [http://localhost:5299/]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
for (const p of ['playwright', 'playwright-core', '/opt/node-tools/node_modules/playwright']) {
  try { ({ chromium } = require(p)); break; } catch { /* next */ }
}
const base = new URL(process.argv[2] || 'http://localhost:5299/');
const exe = process.env.CHROMIUM || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1200, height: 800 } });
await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base.origin });
const page = await context.newPage();
const url = new URL(base); url.searchParams.set('ui', 'terminal');
await page.goto(url.href);
await page.waitForFunction(() => window.__tabcomputer?.terminal?.term, null, { timeout: 120_000 });

const screen = () => page.evaluate(() => {
  const t = window.__tabcomputer.terminal.term;
  const b = t.buffer.active, r = [];
  for (let y = 0; y < b.length; y++) r.push(b.getLine(y)?.translateToString(true) ?? '');
  return r.join('\n');
});
const until = async (cond, ms = 60_000) => {
  const t0 = Date.now();
  for (;;) {
    const s = await screen();
    if (cond(s)) return s;
    if (Date.now() - t0 > ms) { console.log(s.trimEnd().split('\n').slice(-12).join('\n')); return null; }
    await page.waitForTimeout(100);
  }
};
const atPrompt = (s) => /\$\s*$/.test(s.trimEnd());
if (!await until(atPrompt, 120_000)) throw new Error('no prompt');
await page.evaluate(() => window.__tabcomputer.terminal.term.focus());

// A small PNG made in the page, and a DataTransfer carrying it as a file
const MAKE = `(async () => {
  const c = new OffscreenCanvas(3, 2); const g = c.getContext('2d'); g.fillStyle = '#f00'; g.fillRect(0, 0, 3, 2);
  const blob = await c.convertToBlob({ type: 'image/png' });
  const dt = new DataTransfer(); dt.items.add(new File([blob], 'Screen Shot.png', { type: 'image/png' }));
  return { blob, dt };
})()`;

let failures = 0;
const check = (ok, name, detail = '') => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? '  ' + detail : ''}`); };

// 1. Cmd+V with an image: the paste event, dispatched where the browser does (xterm's textarea)
await page.keyboard.type('ls -l ', { delay: 10 });
const size = await page.evaluate(async (MAKE) => {
  const { blob, dt } = await eval(MAKE);
  const ta = window.__tabcomputer.terminal.term.textarea;
  ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  return blob.size;
}, MAKE);
let s = await until((x) => /ls -l \/tmp\/paste-\d{8}-\d{6}\.png\s*$/.test(x.trimEnd()), 10_000);
check(!!s, 'a pasted image becomes its /tmp path at the prompt');
await page.keyboard.press('Enter');
s = await until((x) => new RegExp(`\\s${size}\\s.*\\/tmp\\/paste-\\d{8}-\\d{6}\\.png`).test(x) && atPrompt(x), 10_000);
check(!!s, `the file is the image (${size} bytes)`);

// A text paste is still text
await page.evaluate(() => {
  const dt = new DataTransfer(); dt.setData('text/plain', 'echo pasted-text-ok');
  window.__tabcomputer.terminal.term.textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
});
await page.keyboard.press('Enter');
check(!!await until((x) => /^pasted-text-ok$/m.test(x) && atPrompt(x), 10_000), 'a text paste is unchanged');

// 2. Drop an image file on the terminal
await page.keyboard.type('ls -l ', { delay: 10 });
await page.evaluate(async (MAKE) => {
  const { dt } = await eval(MAKE);
  const el = window.__tabcomputer.terminal.term.element;
  el.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
  el.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
}, MAKE);
check(!!await until((x) => /ls -l \/tmp\/drop-\d{8}-\d{6}-Screen_Shot\.png\s*$/.test(x.trimEnd()), 10_000), 'a dropped image becomes its /tmp path');
await page.keyboard.press('Enter');
await until(atPrompt, 10_000);

// 3. Claude Code's Ctrl+V: from node (a kernel guest), through a shell, on the real clipboard
await page.bringToFront();
const wrote = await page.evaluate(async (MAKE) => {
  const { blob } = await eval(MAKE);
  try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); } catch (e) { return String(e); }
  await window.__tabcomputer.fs.writeFile('/tmp/ctrlv.js', `
    const cp = require("child_process");
    const run = (c) => new Promise((r) => { const ch = cp.spawn(c, [], { shell: true }); let o = ""; ch.stdout.on("data", (d) => { o += d; }); ch.on("close", (code) => r(code + ":" + o.trim())); });
    (async () => {
      const t = await run('xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"');
      const s = await run("xclip -selection clipboard -t image/png -o > /tmp/ctrlv.png 2>/dev/null");
      const b = require("fs").readFileSync("/tmp/ctrlv.png");
      console.log("CTRLV", t, s, b.length, b.subarray(1, 4).toString());
    })();
  `);
  return blob.size;
}, MAKE);
if (typeof wrote === 'string') check(false, 'write an image to the clipboard', wrote);
else {
  await page.keyboard.type('node /tmp/ctrlv.js\n', { delay: 10 });
  s = await until((x) => /CTRLV .*/.test(x) && atPrompt(x), 60_000);
  const line = s && /CTRLV .*/.exec(s)[0];
  // (Chrome re-encodes a clipboard image, so the size may differ a little from what was written)
  check(/^CTRLV 0:image\/png 0: [1-9]\d* PNG$/.test(line ?? ''), "Claude Code's xclip calls from a node guest find and save the clipboard image", JSON.stringify(line));
}

await browser.close();
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
