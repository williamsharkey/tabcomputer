// The Notebook app (docs/NOTEBOOK.md) on the desktop, from a fresh profile: a
// notebook in a git repository is opened from the Files app and run top to
// bottom with numpy, pandas and matplotlib; the test checks the outputs (text,
// a pandas table, an inline plot, a value, input(), a shell line, a
// traceback), that what the notebook's author wrote cannot run script, that
// Python's state stays between cells, Stop, Restart, that a long cell leaves
// the page responsive, Save (nbformat 4, what git sees), and the notebook
// after a reload. Then `jupyter notebook`, `jupyter execute`, `code FILE.ipynb`.
// Needs the Pyodide distribution (cdn.jsdelivr.net unless the build serves it).
//
//   npx vite build && PORT=6521 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/notebook.mjs [http://localhost:6521/] [--shots DIR] [--save-to FILE]
//
// Prints one line per step, then the measured times (cold: nothing fetched
// before; warm: after a reload). Exits 1 if a step fails. --save-to writes the
// saved notebook to a file of the host, to check with Jupyter's own nbformat.
// PLAYWRIGHT= and CHROMIUM= pick the tools.
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const saveTo = opt('--save-to');
const base = args[0] || 'http://localhost:6521/';
const url = base + (base.includes('?') ? '&' : '?') + 'ui=desktop';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const LIMIT = Number(process.env.WORKFLOW_LIMIT_MS || 240_000);
if (shots) mkdirSync(shots, { recursive: true });

const DIR = '/home/user/src/course';
const NB = `${DIR}/lab3.ipynb`;
const code = (source, extra = {}) => ({ cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: source.split(/(?<=\n)/), ...extra });
const NOTEBOOK = {
  cells: [
    { cell_type: 'markdown', metadata: {}, source: ['# Lab 3\n', '\n', 'Plot the *squares*. <script>window.__nbXss = 1</script><img src="x" onerror="window.__nbXss = 2">\n', '\n', '| a | b |\n', '|---|---|\n', '| 1 | 2 |\n'] },
    code("%matplotlib inline\nimport numpy as np\nimport pandas as pd\nimport matplotlib.pyplot as plt\nprint('numpy', np.arange(10).sum())"),
    code("df = pd.read_csv('data.csv')\ndf.head()"),
    code("plt.plot(df.x, df.y)\nplt.title('squares')\nplt.show()\nprint('plotted', len(df))"),
    code('total = int(df.y.sum())\ntotal'),
    code("name = input('Name? ')\nprint('hi', name)"),
    code("!echo shell-ok && pwd\nfiles = !ls\nprint(sorted(files))\nwith open('out.txt', 'w') as f:\n    f.write(str(total))"),
    code("import os, sys\nprint(os.getcwd(), sys.version_info[:2], os.path.exists('/home/user/src/course/.git'))\nfrom IPython.display import display, HTML\ndisplay(HTML('<i>shown</i>'))"),
    code('def half(x):\n    return x / 0\nhalf(1)'),
    // never run (the cell before it fails): its saved output is what the file's author wrote
    code("print('not reached')", { execution_count: 9, outputs: [{ output_type: 'display_data', metadata: {}, data: { 'text/html': ["<b>kept</b><script>window.__nbXss = 3</script><img src=\"x\" onerror=\"window.__nbXss = 4\"><a href=\"javascript:window.__nbXss=5\">link</a><iframe src=\"/\"></iframe>"], 'text/plain': ['<IPython.core.display.HTML object>'] } }] }),
  ],
  metadata: { kernelspec: { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' }, language_info: { name: 'python' } },
  nbformat: 4,
  nbformat_minor: 4,
};
const DATA = 'x,y\n' + Array.from({ length: 12 }, (_, i) => `${i},${i * i}`).join('\n') + '\n';
const SMALL = { cells: [code("import numpy as np\nprint('executed', int(np.arange(4).sum()))\nnp.pi")], metadata: {}, nbformat: 4, nbformat_minor: 4 };

const sh = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__nbShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const rc = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code: rc, out: o };
}, cmd);
const bufferOf = (page) => page.evaluate(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && rows.length) rows[rows.length - 1] += text; else rows.push(text);
  }
  return rows.join('\n');
});
/** The notebook window's state: its cells' drawn outputs and Python's status */
const nbState = (page) => page.evaluate((path) => {
  const w = window.__tabcomputer.desktop.windows().find((x) => x.appId === 'notebook' && x.notebook?.path === path);
  if (!w) return null;
  const cells = [...w.body.querySelectorAll('.nb-cell')].map((c) => ({
    count: c.querySelector('.nb-count')?.textContent ?? '',
    out: c.querySelector('.nb-outputs')?.innerText ?? '',
    html: c.querySelector('.nb-outputs')?.innerHTML ?? '',
    md: c.querySelector('.nb-md')?.innerHTML ?? '',
  }));
  return { cells, status: w.body.querySelector('.nb-status-text')?.textContent ?? '', state: w.notebook.kernel.state, idle: w.notebook.idle(), dirty: w.notebook.dirty(), title: w.title, notices: w.body.querySelector('.nb-notices')?.innerText ?? '' };
}, NB);
const until = async (page, what, fn, limit = LIMIT) => {
  const t0 = Date.now();
  for (;;) {
    // (a page that does not answer is frozen: say so instead of waiting on it)
    const s = await Promise.race([nbState(page), new Promise((_r, reject) => setTimeout(() => reject(new Error(`the page did not answer for 15 s while waiting for ${what}`)), 15_000))]);
    const r = s && fn(s);
    if (r) return s;
    if (Date.now() - t0 > limit) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(s)?.slice(0, 1500)}`);
    await page.waitForTimeout(40);
  }
};
const times = {};
const ok = (what, extra = '') => console.log(`  ok    ${what}${extra ? `  (${extra})` : ''}`);
const check = (cond, what, detail = '') => { if (!cond) throw new Error(`${what}${detail ? `:\n${detail}` : ''}`); ok(what); };
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

async function boot(page) {
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && window.__tabcomputer.terminal?.term && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf(page)); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(800);
}

/** Open the notebook from the Files app and press Run All as soon as it is drawn; times from the double-click */
async function openAndRunAll(page, label) {
  await page.evaluate(async (dir) => {
    const d = window.__tabcomputer.desktop;
    // (one Files window: a reload brought the earlier one back)
    for (const w of d.windows().filter((x) => x.appId === 'files')) w.close(true);
    await d.openApp('files', { path: dir });
  }, DIR);
  const row = page.locator(`tr[data-path="${NB}"]`).last();
  await row.waitFor({ timeout: 20_000 });
  const t0 = Date.now();
  await row.dblclick();
  await until(page, 'the notebook window', (s) => s.cells.length >= 10);
  times[`${label}: double-click in Files to the notebook drawn`] = Date.now() - t0;
  const win = page.locator('.sd-win:has(.nb-cells)').last();
  await win.locator('[data-act=run-all]').click();
  await until(page, 'the first cell\'s output', (s) => /numpy 45/.test(s.cells[1].out));
  times[`${label}: double-click to the first cell's output (numpy, pandas and matplotlib imported)`] = Date.now() - t0;
  await until(page, 'the pandas table', (s) => /<table/.test(s.cells[2].html));
  times[`${label}: double-click to the pandas table`] = Date.now() - t0;
  await until(page, 'the plot', (s) => /<img[^>]+src="data:image\/png;base64,/.test(s.cells[3].html));
  times[`${label}: double-click to the inline plot`] = Date.now() - t0;
  // input(): the box appears under the cell that asked
  const input = win.locator('.nb-stdin input');
  await input.waitFor({ timeout: LIMIT });
  await input.fill('Ada');
  await input.press('Enter');
  await until(page, 'Run All to end', (s) => s.idle && s.state === 'idle');
  times[`${label}: Run All, whole notebook (with the wait for input)`] = Date.now() - t0;
  return win;
}

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 860 } }); // a fresh profile
await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
if (process.env.NB_DEBUG) page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`  console ${m.type()}: ${m.text().slice(0, 300)}`); });
let failed = 0;
try {
  await boot(page);
  if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error('the page is not cross-origin isolated: cells cannot run');

  // ── a repository with a notebook and its data ──
  await sh(page, `mkdir -p ${DIR}`);
  for (const [name, text] of [['lab3.ipynb', JSON.stringify(NOTEBOOK, null, 1) + '\n'], ['data.csv', DATA], ['small.ipynb', JSON.stringify(SMALL)]]) {
    await page.evaluate(([p, t]) => window.__tabcomputer.fs.writeFile(p, t), [`${DIR}/${name}`, text]);
  }
  const git = await sh(page, `cd ${DIR} && git init -q . && git add -A && git -c user.name=t -c user.email=t@example.com commit -q -m start && git status --short | wc -l`);
  check(/^\s*0\s*$/m.test(git.out), 'a git repository with lab3.ipynb and data.csv, clean', git.out);
  check(await page.evaluate(() => window.__tabcomputer.desktop.apps().some((a) => a.id === 'notebook' && a.name === 'Notebook')), 'the dock has an entry named Notebook');

  // ── open from Files, Run All (cold: Pyodide and the three packages are fetched now) ──
  const win = await openAndRunAll(page, 'cold');
  let s = await nbState(page);
  if (shots) await page.screenshot({ path: `${shots}/notebook-run.png` });
  check(/<h1>Lab 3<\/h1>/.test(s.cells[0].md) && /<em>squares<\/em>/.test(s.cells[0].md) && /<table>/.test(s.cells[0].md), 'the text cell is drawn as Markdown (heading, emphasis, table)', s.cells[0].md);
  check(s.cells[1].out.trim() === 'numpy 45' && s.cells[1].count === '[1]', '%matplotlib inline and the imports run; print shows under the cell', JSON.stringify(s.cells[1]));
  check(/class="dataframe"/.test(s.cells[2].html) && /<th>x<\/th>/.test(s.cells[2].html) && s.cells[2].out.includes('16'), 'a DataFrame is an HTML table', s.cells[2].html.slice(0, 400));
  const img = await win.locator('.nb-cell').nth(3).locator('.nb-outputs img').evaluate((i) => ({ w: i.naturalWidth, h: i.naturalHeight }));
  check(img.w > 300 && img.h > 200 && /plotted 12/.test(s.cells[3].out), `plt.show() draws the figure under the cell (${img.w}x${img.h} PNG), and the cell goes on`, s.cells[3].out);
  check(s.cells[4].out.trim() === '506', 'a later cell uses the variables of an earlier one (the last value is shown)', s.cells[4].out);
  check(/Name\? Ada\s*\n\s*hi Ada/.test(s.cells[5].out), 'input() asks under the cell and gets what was typed', s.cells[5].out);
  check(/shell-ok/.test(s.cells[6].out) && s.cells[6].out.includes(DIR) && /'data\.csv', 'lab3\.ipynb'/.test(s.cells[6].out), '!command runs in the tab\'s shell in the notebook\'s folder, and x = !ls captures it', s.cells[6].out);
  check(s.cells[7].out.includes(`${DIR} (3, 13) True`) && /<i>shown<\/i>/.test(s.cells[7].html), 'Python works in the notebook\'s folder on the tab\'s files; IPython.display works', s.cells[7].out);
  check(/ZeroDivisionError: division by zero/.test(s.cells[8].out) && /ipython-input-\d+.*line 3/.test(s.cells[8].out) && /in half/.test(s.cells[8].out), 'an error shows its traceback with the cell\'s lines', s.cells[8].out);
  check(s.cells[9].count === '[9]' && /kept/.test(s.cells[9].out), 'Run All stops at the error: the cell after it did not run');
  const xss = await page.evaluate(() => window.__nbXss);
  check(xss === undefined && !/<script|onerror|javascript:|<iframe/i.test(s.cells[9].html + s.cells[0].md), 'script, handlers, javascript: links and frames in the notebook\'s Markdown and saved outputs are not in the page', `${xss} ${s.cells[9].html}`);
  const written = await sh(page, `cat ${DIR}/out.txt`);
  check(written.out.trim() === '506', 'a file the notebook wrote is the tab\'s file');
  const ps = await sh(page, 'ps aux | grep notebook | grep -v grep');
  check(/python3 -m notebook lab3\.ipynb/.test(ps.out), 'the notebook\'s Python is a process in ps', ps.out);

  // ── state between cells: a new cell, typed ──
  await win.locator('.nb-cell').nth(4).locator('textarea').click();
  await win.locator('[data-act=add-code]').click();
  await page.keyboard.type('total + 1');
  await page.keyboard.press('Shift+Enter');
  s = await until(page, 'the new cell\'s value', (x) => x.cells.length === 11 && x.cells[5].out.trim() === '507');
  ok('a new cell typed below, Shift+Enter: Python still has the variables');

  // ── a long cell does not freeze the page; Stop ends a cell ──
  await win.locator('.nb-cell').nth(5).locator('textarea').click();
  await win.locator('[data-act=add-code]').click();
  await page.keyboard.type('import time\nt = time.time(); n = 0\nwhile time.time() - t < 2.5:\nnp.sort(np.random.rand(20000)); n += 1\n');
  await page.keyboard.press('Backspace');
  await page.keyboard.type("print('busy done', n > 0)");
  await page.evaluate(() => {
    window.__nbLag = 0;
    let last = performance.now();
    const tick = () => { const now = performance.now(); window.__nbLag = Math.max(window.__nbLag, now - last); last = now; window.__nbTick = setTimeout(tick, 10); };
    tick();
  });
  await page.keyboard.press('Control+Enter');
  await until(page, 'the busy cell', (x) => /busy done True/.test(x.cells[6].out));
  const lag = await page.evaluate(() => { clearTimeout(window.__nbTick); return Math.round(window.__nbLag); });
  times['longest delay of the page\'s main thread during a 2.5 s numpy loop in a cell'] = lag;
  check(lag < 400, `a 2.5 s cell leaves the desktop responsive (longest delay ${lag} ms)`);

  await win.locator('[data-act=add-code]').click();
  await page.keyboard.type("import time\nprint('looping')\nwhile True:\ntime.sleep(0.05)");
  await page.keyboard.press('Control+Enter');
  await until(page, 'the loop to start', (x) => /looping/.test(x.cells[7].out) && x.state === 'busy');
  const tStop = Date.now();
  await win.locator('[data-act=stop]').click();
  s = await until(page, 'Stop', (x) => /KeyboardInterrupt/.test(x.cells[7].out) && x.state === 'idle');
  times['Stop to KeyboardInterrupt shown'] = Date.now() - tStop;
  ok('Stop raises KeyboardInterrupt in the running cell, and Python is ready again');
  await win.locator('.nb-cell').nth(7).locator('textarea').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type("answer = input('Stop me: ')");
  await page.keyboard.press('Control+Enter');
  await win.locator('.nb-stdin input').waitFor({ timeout: 20_000 });
  await win.locator('[data-act=stop]').click();
  s = await until(page, 'Stop during input()', (x) => /KeyboardInterrupt/.test(x.cells[7].out) && x.state === 'idle');
  check(await win.locator('.nb-stdin').count() === 0, 'Stop ends a cell that waits in input()');
  await win.locator('.nb-cell').nth(7).locator('textarea').click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type('total * 2');
  await page.keyboard.press('Control+Enter');
  await until(page, 'a cell after Stop', (x) => x.cells[7].out.trim() === '1012');
  ok('after Stop the variables are still there');

  // ── Save: the file, as git and Jupyter see it ──
  await win.locator('[data-act=save]').click();
  await until(page, 'Save', (x) => !x.dirty && !/Edited/.test(x.title));
  const saved = await page.evaluate((p) => window.__tabcomputer.fs.readFile(p, 'utf8'), NB);
  if (saveTo) writeFileSync(saveTo, saved);
  const file = JSON.parse(saved);
  const outs = (i) => file.cells[i].outputs;
  const png = outs(3).find((o) => o.output_type === 'display_data')?.data['image/png'];
  check(file.nbformat === 4 && file.nbformat_minor === 4 && file.cells.length === 13 && file.cells.every((c) => Array.isArray(c.source)), 'the saved file is nbformat 4 with sources as lists of lines');
  check(outs(1)[0].output_type === 'stream' && outs(1)[0].text.join('') === 'numpy 45\n' && file.cells[1].execution_count === 1, 'printed text is saved as a stream output with the cell\'s number');
  check(outs(2)[0].output_type === 'execute_result' && Array.isArray(outs(2)[0].data['text/html']) && /dataframe/.test(outs(2)[0].data['text/html'].join('')) && typeof outs(2)[0].data['text/plain'][0] === 'string', 'the table is saved as execute_result with text/html and text/plain');
  check(typeof png === 'string' && png.startsWith('iVBORw0KGgo') && png.length > 5000, `the plot is saved as image/png (${png?.length} base64 characters)`);
  check(outs(11)[0].output_type === 'error' && outs(11)[0].ename === 'ZeroDivisionError' && Array.isArray(outs(11)[0].traceback), 'the error is saved with its name and traceback');
  check(file.metadata.kernelspec.name === 'python3' && /^3\.13\./.test(file.metadata.language_info.version), 'the file names the Python kernel and its version');
  check(saved.startsWith('{\n "cells": [\n  {\n   "cell_type"') && saved.endsWith('}\n'), 'the file is indented the way Jupyter writes it');
  const st = await sh(page, `cd ${DIR} && git status --short`);
  check(/^ M lab3\.ipynb$/m.test(st.out) && /^\?\? out\.txt$/m.test(st.out), 'git sees the notebook as modified and the new file', st.out);

  // ── Restart clears the variables ──
  await win.locator('[data-act=restart]').click();
  await until(page, 'Python after Restart', (x) => x.state === 'idle');
  await win.locator('.nb-cell').nth(7).locator('textarea').click();
  await page.keyboard.press('Control+Enter');
  s = await until(page, 'a cell after Restart', (x) => /NameError/.test(x.cells[7].out));
  ok('Restart starts a new Python: the variables are gone');
  await win.locator('.nb-cell').nth(7).locator('[data-tool=delete]').click();
  await win.locator('[data-act=save]').click();
  await until(page, 'Save', (x) => !x.dirty);

  // ── a reload: the notebook comes back with its outputs, and runs again (warm) ──
  await page.waitForTimeout(1500); // (the session is saved on a timer)
  await boot(page);
  const back = await nbState(page);
  if (back) {
    ok('after a reload the desktop opens the notebook again by itself');
    check(/<img[^>]+src="data:image\/png;base64,/.test(back.cells[3].html) && /numpy 45/.test(back.cells[1].out) && /dataframe/.test(back.cells[2].html), 'the saved outputs are drawn from the file: text, table, plot');
    await page.evaluate((path) => window.__tabcomputer.desktop.windows().find((x) => x.appId === 'notebook' && x.notebook?.path === path).close(true), NB);
  } else {
    console.log('  note  the notebook was not reopened by the session restore; opening it from Files');
  }
  await page.waitForTimeout(500);
  const win2 = await openAndRunAll(page, 'warm');
  s = await nbState(page);
  check(/numpy 45/.test(s.cells[1].out) && /dataframe/.test(s.cells[2].html) && /hi Ada/.test(s.cells[7].out) && /ZeroDivisionError/.test(s.cells[10].out), 'opened again from Files after the reload, it runs top to bottom');
  if (shots) await page.screenshot({ path: `${shots}/notebook-warm.png` });
  await win2.locator('[data-act=save]').click();
  await until(page, 'Save', (x) => !x.dirty);

  // ── jupyter and code, at the prompt ──
  await page.evaluate((path) => window.__tabcomputer.desktop.windows().find((x) => x.appId === 'notebook' && x.notebook?.path === path).close(true), NB);
  let r = await sh(page, `cd ${DIR} && jupyter notebook lab3.ipynb`);
  check(r.code === 0, 'jupyter notebook lab3.ipynb exits 0', r.out);
  await until(page, 'the window jupyter notebook opened', (x) => x.cells.length === 12);
  ok('jupyter notebook FILE opens the notebook');
  r = await sh(page, `cd ${DIR} && jupyter lab lab3.ipynb && code lab3.ipynb && desktop windows | grep -c "notebook.*lab3"`);
  check(r.out.trim() === '1', 'jupyter lab FILE and code FILE.ipynb show the window that has the notebook (one window)', r.out);
  r = await sh(page, `cd ${DIR} && jupyter lab`);
  await page.locator(`.nb-item[data-path="${DIR}/small.ipynb"]`).waitFor({ timeout: 20_000 });
  ok('jupyter lab, with no file, lists the folder\'s notebooks');
  const tExec = Date.now();
  r = await sh(page, `cd ${DIR} && jupyter execute --inplace small.ipynb`);
  times['jupyter execute small.ipynb (numpy), whole command'] = Date.now() - tExec;
  check(r.code === 0 && /executed 6/.test(r.out) && /3\.14159/.test(r.out), 'jupyter execute runs a notebook at the prompt and prints its outputs', r.out);
  const small = JSON.parse(await page.evaluate((p) => window.__tabcomputer.fs.readFile(p, 'utf8'), `${DIR}/small.ipynb`));
  check(small.cells[0].execution_count === 1 && small.cells[0].outputs.length === 2, 'jupyter execute --inplace saves the outputs in the file');
  r = await sh(page, `cd ${DIR} && jupyter nbconvert --to script small.ipynb && cat small.py`);
  check(/import numpy as np/.test(r.out), 'jupyter nbconvert --to script writes the code cells as a .py file', r.out);
  r = await sh(page, 'jupyter --version; pip install jupyterlab 2>&1 | tail -3');
  console.log(`  note  pip install jupyterlab says: ${r.out.trim().split('\n').slice(-2).join(' / ')}`);

  if (errors.length) throw new Error(`page errors:\n${errors.slice(0, 5).join('\n')}`);
} catch (e) {
  failed = 1;
  console.log(`  FAIL  ${e.message}`);
  if (process.env.NB_DEBUG) {
    // Where the page's main thread is, when it is the page that stopped answering
    try {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Debugger.enable');
      const paused = new Promise((resolve) => cdp.once('Debugger.paused', resolve));
      await cdp.send('Debugger.pause');
      const ev = await Promise.race([paused, new Promise((r) => setTimeout(() => r(null), 5000))]);
      console.log(ev ? `  main thread at:\n${ev.callFrames.slice(0, 12).map((f) => `    ${f.functionName || '(anonymous)'} ${f.url.split('/').pop()}:${f.location.lineNumber}:${f.location.columnNumber}`).join('\n')}` : '  main thread: idle (nothing to pause in)');
      await cdp.send('Debugger.resume').catch(() => {});
    } catch (err) { console.log(`  (no stack: ${err.message})`); }
  }
  if (shots) await page.screenshot({ path: `${shots}/notebook-fail.png` }).catch(() => {});
} finally {
  await browser.close();
}
console.log('\nTimes:');
for (const [k, v] of Object.entries(times)) console.log(`  ${k}: ${/delay/.test(k) ? `${v} ms` : secs(v)}`);
process.exit(failed);
