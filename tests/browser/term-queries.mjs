// Terminal queries a program may ask and wait on: each must get an answer
// (src/utils/term-queries.ts; xterm.js answers the rest). Claude Code's
// fullscreen renderer hung in a blocking tty read on one that went silent.
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/term-queries.mjs [http://localhost:5299/]
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); } catch { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
const base = process.argv[2] || 'http://localhost:5299/';
const exe = process.env.CHROMIUM || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const page = await (await browser.newContext()).newPage();
await page.goto(base);
await page.waitForFunction(() => window.__tabcomputer?.terminal?.term, null, { timeout: 90000 });
// [name, query, reply pattern] (null: must stay unanswered)
const cases = [
  ['DA1', '\x1b[c', /^\x1b\[\?[\d;]+c$/],
  ['DA2', '\x1b[>c', /^\x1b\[>[\d;]+c$/],
  ['DSR cursor position', '\x1b[6n', /^\x1b\[\d+;\d+R$/],
  ['DECRQM ?2026', '\x1b[?2026$p', /^\x1b\[\?2026;\d\$y$/],
  ['DECRQM ?1016 (SGR pixel mouse)', '\x1b[?1016$p', /^\x1b\[\?1016;\d\$y$/],
  ['OSC 11 background', '\x1b]11;?\x07', /^\x1b\]11;rgb:/],
  ['XTVERSION', '\x1b[>0q', /^\x1bP>\|tabcomputer/],
  ['XTGETTCAP', '\x1bP+q544e\x1b\\', /^\x1bP0\+r\x1b\\$/],
  ['CSI 14t text area pixels', '\x1b[14t', /^\x1b\[4;\d+;\d+t$/],
  ['CSI 16t cell pixels', '\x1b[16t', /^\x1b\[6;\d+;\d+t$/],
  ['CSI 18t text area chars', '\x1b[18t', /^\x1b\[8;\d+;\d+t$/],
  ['kitty keyboard ? u (stays silent)', '\x1b[?u', null],
];
let failures = 0;
for (const [name, q, want] of cases) {
  const reply = await page.evaluate(async (q) => {
    const term = window.__tabcomputer.terminal.term; let got = '';
    const d = term.onData((x) => { got += x; });
    await new Promise((r) => term.write(q, r));
    await new Promise((r) => setTimeout(r, 200));
    d.dispose(); return got;
  }, q);
  const ok = want ? want.test(reply) : reply === '';
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(34)} ${JSON.stringify(reply)}`);
}
await browser.close();
console.log(failures ? `${failures} FAILED` : 'all ok');
process.exit(failures ? 1 : 0);
