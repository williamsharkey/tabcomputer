// numpy, pandas and matplotlib on the tab's python3 (tabcomputer#125, option A
// of docs/research/PYTHON_NATIVE_WHEELS.md), typed into the desktop's terminal
// from a fresh profile: `pip install numpy pandas matplotlib` records them as
// Pyodide's, and `python3 FILE.py` runs a program that imports them in Pyodide
// (a kernel process in a Worker) on the tab's own files, with a terminal's
// stdin, ^C, exit statuses, and plt.show() in a window. A program that needs
// none of them stays on the built-in Python. Needs pypi.org and the Pyodide
// CDN (cdn.jsdelivr.net).
//
//   npx vite build && PORT=6011 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/pyodide-numpy.mjs [http://localhost:6011/] [--shots DIR]
//
// Prints one line per step with its time, then the measured times; exits 1
// if a step fails. PLAYWRIGHT= and CHROMIUM= pick the tools.
import { createRequire } from 'node:module';
import { existsSync, mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
let chromium;
for (const m of [process.env.PLAYWRIGHT, 'playwright-core', 'playwright', '/opt/node-tools/node_modules/playwright'].filter(Boolean)) {
  try { ({ chromium } = require(m)); break; } catch { /* the next one */ }
}

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const base = args[0] || 'http://localhost:6011/';
const url = base + (base.includes('?') ? '&' : '?') + 'ui=desktop';
const MAC = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const exe = process.env.CHROMIUM || (existsSync(MAC) ? MAC : '/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const LIMIT = Number(process.env.WORKFLOW_LIMIT_MS || 240_000); // per step
if (shots) mkdirSync(shots, { recursive: true });

const bufferOf = (page) => page.evaluate(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  // (a line the terminal wrapped is one line here)
  for (let y = 0; y < b.length; y++) {
    const line = b.getLine(y);
    const text = line?.translateToString(true) ?? '';
    if (line?.isWrapped && rows.length) rows[rows.length - 1] += text; else rows.push(text);
  }
  return rows.join('\n');
});
const focus = (page) => page.evaluate(() => window.__tabcomputer.terminal.term.focus());
/** A command in a shell of its own, off the terminal (setting files up, looking at results) */
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  const s = window.__pnShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);

const times = {};
let marks = 0;
/**
 * Type `cmd` at the prompt and wait for its exit status. `opts.during(page)`
 * runs once the command is typed (to answer a prompt or press ^C);
 * `opts.code` is the status expected (0).
 */
async function step(page, cmd, expect = null, opts = {}) {
  const mark = `@@step${++marks}`;
  const t0 = Date.now();
  await focus(page);
  await page.keyboard.type(`${cmd}; echo "${mark} $?"\r`, { delay: 2 });
  if (opts.during) await opts.during(page, t0);
  const re = new RegExp(`^${mark} (\\d+)$`, 'm');
  for (;;) {
    const s = await bufferOf(page);
    const m = re.exec(s);
    if (m) {
      const out = s.slice(0, m.index).split(`echo "${mark} $?"`).pop() ?? '';
      const ms = Date.now() - t0;
      const code = Number(m[1]);
      const ok = [opts.code ?? 0].flat().includes(code) && (!expect || expect.test(out));
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${(ms / 1000).toFixed(1).padStart(6)} s  ${cmd.length > 100 ? cmd.slice(0, 97) + '...' : cmd}`);
      if (!ok) throw new Error(`exit ${code}${expect ? `, wanted ${expect}` : ''}:\n${out.replace(/\s+$/gm, '').trim().split('\n').slice(-25).join('\n')}`);
      if (opts.time) times[opts.time] = ms;
      return { out, ms };
    }
    if (Date.now() - t0 > LIMIT) throw new Error(`timed out after ${LIMIT / 1000} s: ${cmd}\n${s.split('\n').slice(-25).join('\n')}`);
    await page.waitForTimeout(50);
  }
}
/** Wait until the terminal shows `re` after the last step's command */
async function shows(page, re, what) {
  const t0 = Date.now();
  for (;;) {
    const s = (await bufferOf(page)).split(`@@step${marks} $?"`).pop() ?? '';
    if (re.test(s)) return;
    if (Date.now() - t0 > LIMIT) throw new Error(`timed out waiting for ${what ?? re}:\n${s.split('\n').slice(-15).join('\n')}`);
    await page.waitForTimeout(50);
  }
}
/** In the script's own words: `label 0.123` lines it printed */
const printed = (out, label) => { const m = new RegExp(`${label} ([0-9.]+)`).exec(out); return m ? Math.round(Number(m[1]) * 1000) : undefined; };

const FILES = {
  'hello.py': 'import sys, json\nprint("hello from", sys.implementation.name, sys.platform)\n',
  'np.py': 'import sys, time\nt = time.time()\nimport numpy as np\nprint("import_numpy %.3f" % (time.time() - t))\nprint(sys.platform, np.__version__, int(np.arange(10).sum()), sys.version.split()[0])\n',
  'data.csv': 'name,score\n' + Array.from({ length: 500 }, (_, i) => `s${i},${(i * 7) % 101}`).join('\n') + '\n',
  'files.py': [
    'import os, sys, time',
    'import pandas as pd',
    't = time.time(); df = pd.read_csv("data.csv"); print("read_csv %.3f" % (time.time() - t))',
    'print("rows", len(df), "mean", round(df.score.mean(), 2), "cwd", os.getcwd(), "argv", sys.argv)',
    'df[df.score > 90].to_csv("out/top.csv", index=False)',
    'import matplotlib.pyplot as plt',
    't = time.time(); plt.plot(df.score[:50]); plt.title("scores"); plt.savefig("plot.png"); print("savefig %.3f" % (time.time() - t))',
    'print("listdir", sorted(os.listdir(".")))',
    'os.rename("old.txt", "new.txt"); os.remove("gone.txt")',
    'with open("new.txt", "a") as f: f.write("appended\\n")',
    'sys.exit(3)',
  ].join('\n') + '\n',
  'chart.py': [
    'import time',
    't = time.time(); import pandas as pd; print("import_pandas %.3f" % (time.time() - t))',
    't = time.time(); df = pd.read_csv("data.csv"); print("read_csv %.3f" % (time.time() - t))',
    't = time.time(); import matplotlib.pyplot as plt; print("import_pyplot %.3f" % (time.time() - t))',
    't = time.time(); plt.plot(df.score[:50]); plt.savefig("chart.png"); print("savefig %.3f" % (time.time() - t))',
    'print("chart rows", len(df))',
  ].join('\n') + '\n',
  'ask.py': 'import numpy\nname = input("name? ")\nprint("hi", name, "from", __import__("sys").platform)\n',
  'spin.py': 'import numpy as np\nprint("spinning", flush=True)\ntry:\n    while True:\n        np.arange(1000).sum()\nfinally:\n    print("cleanup ran", flush=True)\n',
  'stuck.py': 'import numpy as np\na = np.random.rand(1500, 1500)\nprint("in one call", flush=True)\nnp.linalg.matrix_power(a, 4000)\nprint("finished")\n',
  'busy.py': 'import numpy as np, time\nt = time.time(); n = 0\nwhile time.time() - t < 3:\n    np.sort(np.random.rand(20000)); n += 1\nprint("busy done", n > 0)\n',
  'show.py': 'import matplotlib.pyplot as plt\nplt.plot([1, 4, 9, 16]); plt.title("squares")\nplt.show()\nprint("after show", plt.get_fignums())\n',
  'aio.py': 'import asyncio, sys, numpy\nasync def main():\n    await asyncio.sleep(0.05)\n    return "ran"\nprint("asyncio", asyncio.run(main()), sys.platform)\n',
  'helper.py': 'import numpy as np\ndef mean(xs): return float(np.mean(xs))\n',
  'uses.py': 'from helper import mean\nimport sys\nprint("mean", mean([1, 2, 3]), sys.platform)\n',
  'both.py': 'import sys, cowsay\nprint("cowsay on", sys.platform, cowsay.__name__)\n',
  'bothnp.py': 'import sys, cowsay, numpy\nprint("cowsay on", sys.platform, cowsay.__name__)\n',
  'boom.py': 'import numpy\ndef f():\n    raise ValueError("bad value")\nf()\n',
};

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // a fresh profile
await context.addInitScript(() => { try { localStorage.setItem('tabcomputer-desktop-tour', '1'); localStorage.setItem('tabcomputer-desktop-welcome', '1'); } catch {} });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.desktop && window.__tabcomputer.kernel && window.__tabcomputer.terminal?.term && !document.querySelector('.sd-booting'), null, { timeout: 120_000 });
  for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf(page)); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(1000);
  if (!(await page.evaluate(() => crossOriginIsolated))) throw new Error('the page is not cross-origin isolated: Pyodide cannot run as a process');

  // ── `pyodide` by name, from nothing: fetch Pyodide and numpy, then again ──
  await step(page, `pyodide -c "import numpy; print('sum', numpy.arange(10).sum())"`, /sum 45/, { time: 'pyodide -c "import numpy", cold (Pyodide and numpy fetched)' });
  await page.waitForTimeout(2500); // (the next Pyodide loads in the background)
  await step(page, `pyodide -c "import numpy; print('sum', numpy.arange(10).sum())"`, /sum 45/, { time: 'pyodide -c "import numpy", warm' });

  // ── the built-in Python, and files to work on ──
  await step(page, `python3 -c 'import sys; print(sys.implementation.name, sys.platform)'`, /cpython wasi/);
  await sh(page, 'mkdir -p ~/lab/out && cd ~/lab && echo old > old.txt && echo gone > gone.txt');
  for (const [name, text] of Object.entries(FILES)) {
    await page.evaluate(([p, t]) => window.__tabcomputer.fs.writeFile(p, t), [`/home/user/lab/${name}`, text]);
  }
  await step(page, 'cd ~/lab');

  // ── before pip install: numpy is not there, as on any machine ──
  await step(page, 'python3 np.py 2>&1 | tail -1', /ModuleNotFoundError: No module named 'numpy'/);

  // ── pip install: recorded as Pyodide's, said in one line ──
  const pip = await step(page, 'pip install numpy pandas matplotlib', /Successfully installed .*numpy-/, { time: 'pip install numpy pandas matplotlib' });
  if ((pip.out.match(/Pyodide/g) ?? []).length !== 1 || !/Provided by Pyodide.*numpy [\d.]+, pandas [\d.]+, matplotlib [\d.]+/.test(pip.out)) throw new Error(`pip did not say it in one line:\n${pip.out}`);
  await step(page, 'pip list 2>&1 | grep -E "^(numpy|pandas|matplotlib) "', /numpy\s+\d[\s\S]*pandas\s+\d/);

  // ── routing: no numpy → the built-in Python; numpy → Pyodide, with nothing else typed ──
  await step(page, 'python3 hello.py', /hello from cpython wasi/, { time: 'python3 hello.py (no numpy: the built-in Python)' });
  let r = await step(page, 'python3 np.py', /emscripten \d+\.\d+\.\d+ 45 3\.13\./, { time: 'python3 np.py, first after pip install' });
  times['  import numpy inside it'] = printed(r.out, 'import_numpy');
  await page.waitForTimeout(2500);
  r = await step(page, 'python3 np.py', /emscripten \d+\.\d+\.\d+ 45 3\.13\./, { time: 'python3 np.py, warm' });
  times['  import numpy inside it (warm)'] = printed(r.out, 'import_numpy');
  await step(page, `python3 -c 'import numpy as np, sys; print(sys.platform, np.pi)'`, /emscripten 3\.14159/);
  await step(page, 'python3 -m np', /emscripten \d/);
  await step(page, 'python3 uses.py', /mean 2\.0 emscripten/);
  await step(page, 'python3 --wasi np.py 2>&1 | tail -1', /numpy is compiled, and runs in Pyodide here/);
  await step(page, 'TABCOMPUTER_PYTHON=pyodide python3 hello.py', /hello from cpython emscripten/);
  await step(page, 'python3 np.py | tail -1 | tr a-z A-Z > upper.txt; cat upper.txt', /EMSCRIPTEN \d/);

  // ── the tab's files, cwd, argv, the exit status ──
  await page.waitForTimeout(2500);
  r = await step(page, 'python3 files.py one "two words"', /rows 500 mean [\d.]+ cwd \/home\/user\/lab argv \['files\.py', 'one', 'two words'\]/, { code: 3, time: 'python3 files.py (pandas read_csv, to_csv, matplotlib savefig), whole run' });
  times['  pandas read_csv (500 rows) inside it'] = printed(r.out, 'read_csv');
  times['  matplotlib savefig inside it'] = printed(r.out, 'savefig');
  if (!/listdir \[.*'data\.csv'.*'out'.*'plot\.png'/.test(r.out.replace(/\n/g, ''))) throw new Error(`os.listdir did not show the tab's files:\n${r.out}`);
  const after = (await sh(page, 'cd ~/lab && head -c 4 plot.png | od -c | head -1; wc -c < plot.png; head -2 out/top.csv; cat new.txt; test ! -e old.txt && test ! -e gone.txt && echo moved-ok')).out.replace(/\r/g, '');
  if (!/P\s+N\s+G/.test(after) || !/name,score/.test(after) || !/old\s+appended/.test(after) || !/moved-ok/.test(after)) throw new Error(`the files Python wrote are not the tab's:\n${JSON.stringify(after)}`);
  console.log(`  ok           the shell sees plot.png (${/\n\s*(\d+)\n/.exec(after)?.[1]} bytes), out/top.csv, the rename, the removal and the append`);
  // (the same work again, now that pandas and matplotlib are fetched)
  await page.waitForTimeout(2500);
  r = await step(page, 'python3 chart.py', /chart rows 500/, { time: 'python3 chart.py (pandas read_csv + matplotlib savefig), warm, whole run' });
  times['  import pandas inside it'] = printed(r.out, 'import_pandas');
  times['  pandas read_csv (500 rows) inside it (warm)'] = printed(r.out, 'read_csv');
  times['  import matplotlib.pyplot inside it'] = printed(r.out, 'import_pyplot');
  times['  matplotlib savefig inside it (warm)'] = printed(r.out, 'savefig');
  await step(page, 'python3 boom.py 2>&1 | tail -7', /File ".*boom\.py", line 4, in <module>[\s\S]*ValueError: bad value/);
  await step(page, 'python3 boom.py 2>/dev/null', null, { code: 1 });

  // ── stdin at the terminal ──
  await step(page, 'python3 ask.py', /name\? Ada[\s\S]*hi Ada from emscripten/, {
    during: async (p) => { await shows(p, /name\? $/m, 'the input() prompt'); await p.keyboard.type('Ada\r', { delay: 5 }); },
  });
  await step(page, 'echo Grace | python3 ask.py', /hi Grace from emscripten/);

  // ── ^C is KeyboardInterrupt (finally runs), status 130 ──
  await step(page, 'python3 spin.py', /spinning[\s\S]*cleanup ran[\s\S]*KeyboardInterrupt/, {
    code: 130,
    during: async (p) => { await shows(p, /spinning/, 'the loop to start'); await p.waitForTimeout(300); await p.keyboard.press('Control+c'); },
  });

  // ── one long call into compiled code never looks for the interrupt: a second ^C ends the process ──
  r = await step(page, 'python3 stuck.py', /in one call/, {
    code: [130, 137],
    during: async (p) => { await shows(p, /in one call/, 'the call to start'); await p.waitForTimeout(500); await p.keyboard.press('Control+c'); await p.waitForTimeout(700); await p.keyboard.press('Control+c'); },
  });
  if (r.ms > 6000) throw new Error(`two ^C took ${r.ms} ms to end a program inside one numpy call`);

  // ── a long numpy loop does not hold the page: its main thread keeps turning ──
  let worst = 0;
  await step(page, 'python3 busy.py', /busy done True/, {
    during: async (p) => {
      for (let i = 0; i < 8; i++) {
        const lag = await p.evaluate(() => new Promise((res) => { const t = performance.now(); setTimeout(() => res(performance.now() - t - 100), 100); }));
        worst = Math.max(worst, lag);
        await p.waitForTimeout(200);
      }
    },
  });
  times['worst main-thread delay during a 3 s numpy loop'] = Math.round(worst);
  if (worst > 400) throw new Error(`the page's main thread stalled ${Math.round(worst)} ms while Python ran`);

  // ── plt.show(): a window with the figure ──
  r = await step(page, 'python3 show.py', /after show \[\]/, { time: 'python3 show.py (plt.show())' });
  if (/Warning/.test(r.out)) throw new Error(`matplotlib warned:\n${r.out}`);
  await page.waitForFunction(() => window.__tabcomputer.desktop.windows().some((w) => w.appId === 'python-figure'), null, { timeout: 15_000 });
  const fig = await page.evaluate(async () => {
    const w = window.__tabcomputer.desktop.windows().find((w) => w.appId === 'python-figure');
    const img = document.querySelector('[data-figure] img');
    await img.decode?.().catch(() => {});
    return { title: w.title, width: img.naturalWidth, height: img.naturalHeight, path: img.parentElement.dataset.figure };
  });
  if (!(fig.width > 100 && fig.height > 100) || fig.title !== 'Figure 1') throw new Error(`no figure in the window: ${JSON.stringify(fig)}`);
  console.log(`  ok           plt.show() opened "${fig.title}" (${fig.width}x${fig.height}, ${fig.path})`);
  await page.waitForTimeout(600);
  const shown = await page.evaluate(() => { const r = document.querySelector('[data-figure] img').getBoundingClientRect(); return { w: r.width, h: r.height, top: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.tagName }; });
  if (!(shown.w > 100 && shown.h > 100 && shown.top === 'IMG')) throw new Error(`the figure is not what the screen shows there: ${JSON.stringify(shown)}`);
  if (shots) await page.screenshot({ path: `${shots}/pyodide-numpy-show.png` }).catch(() => {});
  await page.evaluate(() => window.__tabcomputer.desktop.windows().filter((w) => w.appId === 'python-figure').forEach((w) => w.close()));

  // ── asyncio.run (the engine switches stacks: JSPI), and the plain call without it ──
  await step(page, 'python3 aio.py', /asyncio ran emscripten/);
  await step(page, 'TABCOMPUTER_PYODIDE_JSPI=0 python3 np.py', /emscripten \d/);
  await step(page, 'TABCOMPUTER_PYODIDE_JSPI=0 python3 aio.py 2>&1 | tail -1', /Cannot stack switch/);

  // ── a pure-Python package from pip serves both Pythons ──
  await step(page, 'pip install cowsay', /Successfully installed cowsay-/);
  await step(page, 'python3 both.py', /cowsay on wasi cowsay/);
  await step(page, 'python3 bothnp.py', /cowsay on emscripten cowsay/);

  // ── the REPL in Pyodide, when asked for ──
  await step(page, 'python3 --pyodide', />>> 6 \* 7\s*\n42/, {
    during: async (p) => {
      await shows(p, />>> $/m, 'the prompt');
      await p.keyboard.type('6 * 7\r', { delay: 5 });
      await shows(p, /^42$/m, '42');
      await p.keyboard.type('exit()\r', { delay: 5 });
    },
  });

  // ── uninstall: back to how it was ──
  await step(page, 'pip uninstall -y numpy > /dev/null; python3 np.py 2>&1 | tail -1', /ModuleNotFoundError: No module named 'numpy'/);

  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('ok');
} catch (e) {
  failed = 1;
  console.log(`FAIL\n  ${String(e.message).replace(/\n/g, '\n  ')}`);
  if (shots) await page.screenshot({ path: `${shots}/pyodide-numpy-fail.png` }).catch(() => {});
}
console.log('\nmeasured:');
for (const [k, v] of Object.entries(times)) console.log(`  ${k.padEnd(78)} ${v === undefined ? 'n/a' : (v / 1000).toFixed(v < 1000 ? 2 : 1) + ' s'}`);
await browser.close();
process.exit(failed);
