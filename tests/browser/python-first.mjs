// The fast Python stays first (tabcomputer#124, src/python/choose.ts): from a
// fresh profile, `python3` before and after `toolchain install python`. After
// it, `python3 FILE` still runs on the built-in Python (or Pyodide for numpy),
// and on Debian's only for a program that needs it: one that imports turtle
// (a window opens), or a package only Debian's Python has. `python3.13`,
// `/usr/bin/python3` and Debian's own scripts are Debian's; `pip install` is
// one command; venvs made by each Python run that Python.
//
// And tabcomputer#148 for the plain `python3`: a reload while a Pyodide
// program waits in input() or at the `--pyodide` prompt, and ^C in a
// `while True: time.sleep(1)` loop of a script that imports numpy.
//
// Needs the python toolchain layer on the server and pypi.org; the step that
// hands a compiled package to Debian's pip also needs the relay:
//   npm run build && PORT=5299 STATIC_DIR=$PWD/dist TABCOMPUTER_DEBIAN_LAYERS=DIR \
//     TABCOMPUTER_TCP_RELAY=1 TABCOMPUTER_TCP_ORIGINS=http://localhost:5299 node server.mjs &
//   node tests/browser/python-first.mjs [URL] [--only rule|order|148] [--no-relay]
//
// Prints one line per step with its time, then the table of measured times;
// exits 1 if a step fails. PLAYWRIGHT= and CHROMIUM= pick the tools.
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const flag = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
const only = opt('--only');
const noRelay = flag('--no-relay');
const base = args[0] || 'http://localhost:5299/';
const url = base + (base.includes('?') ? '&' : '?') + 'ui=desktop';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const LIMIT = Number(process.env.WORKFLOW_LIMIT_MS || 600_000);

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
let failed = 0;
const times = {};

async function open() {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  page.setDefaultTimeout(LIMIT);
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message.split('\n')[0]));
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.shell && window.__tabcomputer.kernel && window.__tabcomputer.terminal, null, { timeout: 120_000 });
  await page.waitForTimeout(1500);
  return { context, page };
}

/** One shell line in a terminal-less fork kept across steps; output and stderr together, and the time it took */
const sh = (page, cmd) => page.evaluate(async (cmd) => {
  let out = '';
  const t0 = performance.now();
  const s = window.__pfShell ??= Object.assign(window.__tabcomputer.shell.fork(), { terminal: null });
  const code = await s.execute(cmd, (x) => { out += x; }, (x) => { out += x; });
  return { code, out: out.replace(/\r\n/g, '\n'), ms: Math.round(performance.now() - t0) };
}, cmd);
const write = (page, path, text) => page.evaluate(([p, t]) => window.__tabcomputer.fs.writeFile(p, t), [path, text]);

async function step(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    console.log(`ok    ${name}  ${((Date.now() - t0) / 1000).toFixed(1)} s${note ? `  (${note})` : ''}`);
    return true;
  } catch (e) {
    failed++;
    console.log(`FAIL  ${name}  ${((Date.now() - t0) / 1000).toFixed(1)} s\n      ${String(e?.message ?? e).replace(/\n/g, '\n      ')}`);
    return false;
  }
}
/** Run `cmd`, check its status and output, keep its time under `label` */
async function run(page, cmd, expect, { code = 0, time } = {}) {
  const r = await sh(page, cmd);
  if (r.code !== code || (expect && !expect.test(r.out))) throw new Error(`${cmd}\nexit ${r.code}${expect ? `, wanted ${expect}` : ''}:\n${r.out.trim().split('\n').slice(-20).join('\n')}`);
  if (time) times[time] = r.ms;
  return r;
}
/** The fastest of `n` runs (the first of a kind pays for compiling the interpreter) */
async function best(page, cmd, expect, time, n = 3) {
  let ms = Infinity, last;
  for (let i = 0; i < n; i++) { last = await run(page, cmd, expect); ms = Math.min(ms, last.ms); }
  times[time] = ms;
  return last;
}

const WHICH = 'import sys; print("PY", sys.implementation.name, sys.platform, sys.version.split()[0])';
const FILES = {
  'hello.py': `${WHICH}\nprint("hello")\n`,
  // (#124's program: input() and a 2-million sieve)
  'lab.py': 'import sys\nn = int(input())\nsieve = bytearray([1]) * 2_000_001\nsieve[0:2] = b"\\0\\0"\nfor i in range(2, 1415):\n    if sieve[i]: sieve[i*i::i] = bytes(len(sieve[i*i::i]))\nprint("primes", sum(sieve), "asked", n, sys.platform)\n',
  'np.py': 'import sys, numpy as np\nprint("NP", sys.platform, np.__version__, int(np.arange(10).sum()))\n',
  'draw.py': 'import sys, time, turtle\nt = turtle.Turtle()\nfor _ in range(4):\n    t.forward(80); t.left(90)\nturtle.update()\nprint("DRAWN", sys.platform, flush=True)\ntime.sleep(1.5)\nturtle.bye()\n',
  'usesyaml.py': 'import sys, yaml\nprint("YAML", sys.platform, yaml.__file__)\n',
  'envscript': `#!/usr/bin/env python3\n${WHICH}\n`,
  'debscript': `#!/usr/bin/python3\n${WHICH}\n`,
};
const BUILTIN = /PY cpython wasi 3\.13/;
const DEBIAN = /PY cpython linux 3\.13/;

// ── the rule, before and after the toolchain ──
if (!only || only === 'rule') {
  const { context, page } = await open();
  await sh(page, 'mkdir -p /home/user/pf && cd /home/user/pf');
  for (const [name, text] of Object.entries(FILES)) await write(page, `/home/user/pf/${name}`, text);
  await sh(page, 'chmod +x envscript debscript');

  await step('before: python3 hello.py is the built-in Python (the first run fetches it)', async () => {
    await run(page, 'python3 hello.py', BUILTIN, { time: 'first python3 of a fresh profile (fetches the built-in Python)' });
    await best(page, 'python3 hello.py', BUILTIN, 'python3 hello.py | before');
    await best(page, 'echo 5 | python3 lab.py', /primes 148933 asked 5 wasi/, 'python3 lab.py (input() and a 2-million sieve) | before');
  });
  await step('before: import turtle says what to run', async () => {
    const r = await run(page, 'python3 draw.py', /No module named 'tkinter'[\s\S]*toolchain install python/, { code: 1, time: 'python3 draw.py (turtle) | before' });
    if (/python3 is then Debian's/.test(r.out)) throw new Error(`the old sentence:\n${r.out}`);
  });
  await step('before: pip install requests, pip install numpy; import numpy runs in Pyodide', async () => {
    await run(page, 'pip install requests', /Successfully installed .*requests/, { time: 'pip install requests | before' });
    await run(page, 'pip install numpy', /Provided by Pyodide/, { time: 'pip install numpy | before' });
    await run(page, 'python3 -c "import numpy"', null, { time: 'python3 -c "import numpy", first (Pyodide and numpy fetched) | before' });
    await best(page, 'python3 -c "import numpy"', null, 'python3 -c "import numpy" | before');
    await run(page, 'python3 np.py', /NP emscripten/);
  });
  await step('before: pip install of a compiled package says to install the toolchain; --debian says it is not installed', async () => {
    await run(page, 'pip install setproctitle', /compiled extension[\s\S]*Debian's Python can install it\. Run: toolchain install python, then this command again\./, { code: 1 });
    await run(page, 'python3 --debian hello.py', /python3: Debian's Python is not installed\. Run: toolchain install python/, { code: 1 });
  });

  const installed = await step('toolchain install python', async () => {
    const r = await run(page, 'toolchain install python', /Python 3: \d+ packages installed/, { time: 'toolchain install python (Debian base and the layer)' });
    if (!/note: python3 stays the built-in Python/.test(r.out)) throw new Error(`the note:\n${r.out}`);
    const link = await sh(page, 'readlink /usr/bin/python3; readlink -f /usr/bin/python3');
    if (!/python3\.13/.test(link.out)) throw new Error(`/usr/bin/python3 is not Debian's: ${link.out}`);
  });

  if (installed) {
    await step('after: python3 hello.py is still the built-in Python, as fast as before', async () => {
      await best(page, 'python3 hello.py', BUILTIN, 'python3 hello.py | after');
      await best(page, 'echo 5 | python3 lab.py', /primes 148933 asked 5 wasi/, 'python3 lab.py (input() and a 2-million sieve) | after');
      await run(page, 'python hello.py', BUILTIN);
      await run(page, 'python3 -c \'import sys; print("PY", sys.implementation.name, sys.platform, sys.version.split()[0])\'', BUILTIN);
      await run(page, './envscript', BUILTIN);
    });
    await step("after: python3.13, /usr/bin/python3, --debian and TABCOMPUTER_PYTHON=debian are Debian's (what python3 was before this change)", async () => {
      await run(page, 'python3.13 hello.py', DEBIAN, { time: "python3.13 hello.py, first (Debian's Python's files fetched)" });
      await best(page, 'python3.13 hello.py', DEBIAN, "python3.13 hello.py (Debian's by name: python3 before this change) | after", 2);
      await best(page, 'echo 5 | python3.13 lab.py', /primes 148933 asked 5 linux/, "python3.13 lab.py (Debian's by name: python3 before this change) | after", 2);
      await run(page, '/usr/bin/python3 hello.py', DEBIAN);
      await run(page, 'python3 --debian hello.py', DEBIAN);
      await run(page, 'TABCOMPUTER_PYTHON=debian python3 hello.py', DEBIAN);
      await run(page, 'python3 --wasi hello.py', BUILTIN);
    });
    await step("after: Debian's own scripts get Debian's Python (#!/usr/bin/python3, a program that starts python3 by path)", async () => {
      await run(page, './debscript', DEBIAN);
      await run(page, '/usr/bin/pip --version', /pip \d+\.\d+.* from \/usr\/lib\/python3\/dist-packages\/pip \(python 3\.13\)/);
      await run(page, 'py3versions -d', /python3\.13/);
      // (Debian's dash looks python3 up on PATH itself and execs the file)
      await run(page, "/bin/dash -c 'python3 hello.py'", DEBIAN);
    });
    await step('after: import numpy still runs in Pyodide; a turtle program runs on Debian\'s and opens a window', async () => {
      await best(page, 'python3 -c "import numpy"', null, 'python3 -c "import numpy" | after');
      await run(page, 'python3 np.py', /NP emscripten/);
      await best(page, 'python3.13 -c "import numpy"', null, "python3.13 -c \"import numpy\" (Debian's by name) | after", 2);
      const seen = page.waitForFunction(() => window.__tabcomputer.desktop.windows().some((w) => /turtle/i.test(w.title) && w.surface), null, { timeout: LIMIT });
      const r = await run(page, 'python3 draw.py', /DRAWN linux/, { time: 'python3 draw.py (turtle) | after' });
      await seen;
      void r;
      await best(page, 'python3 draw.py', /DRAWN linux/, 'python3 draw.py (turtle), again | after', 1);
      // where the import could not be seen beforehand, the message names --debian
      await run(page, 'python3 --wasi draw.py', /No module named 'tkinter' in tabcomputer's built-in Python[\s\S]*python3 --debian FILE\.py/, { code: 1 });
    });
    await step("after: a package only Debian's Python has runs there, until pip installs it for the built-in one", async () => {
      await run(page, 'python3 usesyaml.py', /YAML linux \/usr\/lib\/python3\/dist-packages\/yaml/);
      await run(page, 'pip install pyyaml', /Successfully installed .*PyYAML/i);
      await run(page, 'python3 usesyaml.py', /YAML wasi \/usr\/lib\/pkg\/python3\/lib\/python3\.13\/site-packages\/yaml/);
    });
    await step('after: pip install requests is the same command and the same pip', async () => {
      // (with what it brought along, so the same five packages are installed again; the wheels now come from the browser's cache)
      await run(page, 'pip uninstall -y requests urllib3 idna certifi charset-normalizer', /Successfully uninstalled requests/);
      await run(page, 'pip install requests', /Successfully installed .*requests/, { time: 'pip install requests | after' });
      await run(page, 'pip --version', /pip .*\(tabcomputer\)/);
      await run(page, 'python3 -m pip --version', /pip .*\(tabcomputer\)/);
      await run(page, 'python3 -c "import sys, requests; print(sys.platform, requests.__file__)"', /wasi \/usr\/lib\/pkg\/python3\//);
      const link = await sh(page, 'readlink -f /usr/bin/python3');
      if (!/python3\.13/.test(link.out)) throw new Error(`/usr/bin/python3 is no longer Debian's: ${link.out}`);
    });
    await step('after: venvs: python3 -m venv is the built-in Python\'s, python3.13 -m venv is Debian\'s, and each runs its own', async () => {
      await run(page, 'python3 -m venv /tmp/pf-own && grep -c "home = /usr/lib/pkg/python3/bin" /tmp/pf-own/pyvenv.cfg', /^1$/m, { time: 'python3 -m venv DIR | after' });
      await run(page, `( . /tmp/pf-own/bin/activate && python3 -c '${WHICH}' && pip --version && python3 -m pip --version )`, /PY cpython wasi[\s\S]*pip .*from \/tmp\/pf-own\/[\s\S]*pip .*from \/tmp\/pf-own\//);
      await run(page, '/tmp/pf-own/bin/python hello.py', BUILTIN);
      await run(page, 'python3.13 -m venv /tmp/pf-deb && grep -c "home = /usr/bin" /tmp/pf-deb/pyvenv.cfg', /^1$/m, { time: "python3.13 -m venv DIR (Debian's) | after" });
      await run(page, `( . /tmp/pf-deb/bin/activate && python3 -c '${WHICH}' && pip --version )`, /PY cpython linux[\s\S]*pip \d+.* from \/tmp\/pf-deb\/lib\/python3\.13\/site-packages\/pip/);
      await run(page, '/tmp/pf-deb/bin/python hello.py', DEBIAN);
    });
    if (!noRelay) await step("after: pip install of a compiled package neither Python here has goes to Debian's pip, and python3 runs it there", async () => {
      const r = await run(page, 'pip install setproctitle', /has a compiled part that only Debian's Python can use\. Installing it for Debian's Python[\s\S]*Successfully installed setproctitle/, { time: "pip install setproctitle (compiled: handed to Debian's pip) | after" });
      void r;
      await run(page, 'python3 -c "import sys, setproctitle; print(sys.platform, setproctitle.__version__)"', /linux \d+\.\d+/);
      await run(page, 'pip show setproctitle', /Name: setproctitle/);
      await run(page, 'pip uninstall -y setproctitle', /Successfully uninstalled setproctitle/);
    });
  }
  await context.close();
}

// ── the other order: Debian's Python first, the built-in one on first use ──
if (!only || only === 'order') {
  const { context, page } = await open();
  await sh(page, 'mkdir -p /home/user/pf && cd /home/user/pf');
  await write(page, '/home/user/pf/hello.py', FILES['hello.py']);
  await step("Debian's Python installed first: python3 still runs the built-in one (fetched on first use), and /usr/bin/python3 stays Debian's", async () => {
    await run(page, 'toolchain install python', /Python 3: \d+ packages installed/);
    await run(page, 'python3 hello.py', BUILTIN, { time: "first python3 after toolchain install python in a fresh profile (fetches the built-in Python)" });
    await run(page, 'python3 hello.py', BUILTIN);
    await run(page, 'readlink -f /usr/bin/python3', /\/usr\/bin\/python3\.13/);
    await run(page, '/usr/bin/python3 hello.py', DEBIAN);
    await run(page, 'pkg install --reinstall python3 >/dev/null 2>&1; readlink -f /usr/bin/python3', /\/usr\/bin\/python3\.13/);
  });
  await context.close();
}

// ── tabcomputer#148: a reload while a Pyodide program waits; ^C in a sleep loop ──
if (!only || only === '148') {
  const { context, page } = await open();
  let crashed = false;
  page.on('crash', () => { crashed = true; });
  const bufferOf = () => page.evaluate(() => {
    const b = window.__tabcomputer.terminal.term.buffer.active;
    const rows = [];
    for (let y = 0; y < b.length; y++) { const line = b.getLine(y); const text = line?.translateToString(true) ?? ''; if (line?.isWrapped && rows.length) rows[rows.length - 1] += text; else rows.push(text); }
    return rows.join('\n');
  });
  const shows = async (re, what, ms = 120_000) => {
    for (const t0 = Date.now(); ;) {
      const s = await bufferOf();
      if (re.test(s)) return s;
      if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}:\n${s.split('\n').slice(-12).join('\n')}`);
      await page.waitForTimeout(100);
    }
  };
  const type = async (text) => { await page.evaluate(() => window.__tabcomputer.terminal.term.focus()); await page.keyboard.type(text, { delay: 3 }); };
  /** After a reload the command that was running is offered again at the prompt, not run: drop it */
  const freshPrompt = async () => { await page.evaluate(() => window.__tabcomputer.terminal.term.focus()); await page.keyboard.press('Control+c'); await page.waitForTimeout(400); await page.evaluate(() => window.__tabcomputer.terminal.term.clear()); await page.waitForTimeout(200); };
  const pyodideProcs = () => page.evaluate(() => [...window.__tabcomputer.kernel.procs.values()].filter((p) => /python|pyodide/.test(`${p.comm} ${p.argv?.join(' ')}`)).map((p) => `${p.pid}:${p.comm}:${p.state}`));
  /** Reload while something waits; the page must come back, and say nothing of a crash */
  const reloadWhile = async (what) => {
    crashed = false;
    const procs = await pyodideProcs();
    if (!procs.length) throw new Error(`no Python process while ${what}`);
    const t0 = Date.now();
    await page.reload({ timeout: 120_000 });
    await page.waitForFunction(() => window.__tabcomputer?.shell && window.__tabcomputer.terminal, null, { timeout: 120_000 });
    await page.waitForTimeout(1500);
    if (crashed) throw new Error(`the tab crashed on a reload while ${what}`);
    const alive = await page.evaluate(() => 1 + 1).catch(() => 0);
    if (alive !== 2) throw new Error(`the page does not answer after a reload while ${what}`);
    return `${procs.join(' ')} was waiting; the page was back ${((Date.now() - t0) / 1000).toFixed(1)} s later`;
  };
  await sh(page, 'mkdir -p /home/user/pf && cd /home/user/pf');
  await write(page, '/home/user/pf/ask.py', 'import numpy\nname = input("name? ")\nprint("hi", name)\n');
  await write(page, '/home/user/pf/nap.py', 'import numpy, time\nprint("napping", flush=True)\ntry:\n    while True:\n        time.sleep(1)\nfinally:\n    print("cleanup ran", flush=True)\n');
  const ready = await step('pip install numpy (records it), and Pyodide runs a program', async () => {
    await run(page, 'pip install numpy', /Provided by Pyodide/);
    await run(page, 'echo Ada | python3 ask.py', /hi Ada/);
  });
  if (ready) {
    await step('#148.1: a reload while a numpy script waits in input()', async () => {
      await type('cd /home/user/pf && python3 ask.py\r');
      await shows(/name\? $/m, 'the input() prompt');
      await page.waitForTimeout(500);
      return reloadWhile('a Pyodide program waited in input()');
    });
    await step('#148.1: a reload at the python3 --pyodide prompt', async () => {
      await freshPrompt();
      await type('python3 --pyodide\r');
      await shows(/>>> $/m, 'the Pyodide prompt');
      await page.waitForTimeout(500);
      return reloadWhile('the --pyodide prompt waited');
    });
    await step('#148.1 again: three more reloads, at the prompt and in input()', async () => {
      for (let i = 0; i < 3; i++) {
        await freshPrompt();
        await type(i % 2 ? 'cd /home/user/pf && python3 ask.py\r' : 'python3 --pyodide\r');
        await shows(i % 2 ? /name\? $/m : />>> $/m, 'the prompt');
        await page.waitForTimeout(300 + 400 * i);
        await reloadWhile(i % 2 ? 'a Pyodide program waited in input()' : 'the --pyodide prompt waited');
      }
    });
    await step('#148.2: ^C in `while True: time.sleep(1)` of a script that imports numpy: one ^C, KeyboardInterrupt, the finally runs', async () => {
      await freshPrompt();
      await type('cd /home/user/pf && python3 nap.py; echo "@@nap $?"\r');
      await shows(/^napping$/m, 'the loop to start');
      await page.waitForTimeout(1700);
      const t0 = Date.now();
      await page.keyboard.press('Control+c');
      let s;
      try { s = await shows(/^@@nap \d+$/m, 'the script to end after one ^C', 8000); }
      catch (e) {
        // (so the next step has a prompt: a second ^C kills the process)
        await page.keyboard.press('Control+c');
        await shows(/^@@nap \d+$/m, 'the script to end after a second ^C', 15000).catch(() => {});
        throw new Error(`one ^C did not end it within 8 s: ${String(e.message).split('\n')[0]}`);
      }
      const ms = Date.now() - t0;
      const tail = s.split('napping').pop();
      if (!/cleanup ran/.test(tail) || !/KeyboardInterrupt/.test(tail) || !/@@nap 130/.test(tail)) throw new Error(`not a KeyboardInterrupt with status 130:\n${tail.trim()}`);
      times['^C to the prompt in a time.sleep loop (Pyodide)'] = ms;
      return `${ms} ms`;
    });
    await step('#148.2: in a time.sleep loop at the python3 --pyodide prompt, one ^C gives KeyboardInterrupt and the prompt again', async () => {
      await page.evaluate(() => window.__tabcomputer.terminal.term.clear());
      await type('python3 --pyodide\r');
      await shows(/>>> $/m, 'the Pyodide prompt');
      await type('import time\r');
      await shows(/>>> import time\n>>> $/m, 'the prompt after import time');
      await type('while True: time.sleep(1)\r');
      await page.waitForTimeout(300);
      await type('\r');
      await page.waitForTimeout(2500);
      await page.keyboard.press('Control+c');
      await shows(/KeyboardInterrupt\s*\n>>> $/m, 'KeyboardInterrupt and the prompt again', 8000);
      await type('exit()\r');
      await page.waitForTimeout(500);
    });
  }
  await context.close();
}

await browser.close();
if (Object.keys(times).length) {
  console.log('\nMeasured (ms; the fastest of the runs where a command was run more than once):');
  const rows = new Map();
  for (const [k, v] of Object.entries(times)) {
    const [what, when] = k.split(' | ');
    if (!when) { console.log(`  ${String(v).padStart(7)}  ${k}`); continue; }
    rows.set(what, { ...(rows.get(what) ?? {}), [when]: v });
  }
  console.log('\n| Command | Before `toolchain install python` | After |\n| --- | ---: | ---: |');
  for (const [what, r] of rows) console.log(`| ${what} | ${r.before ?? ''} | ${r.after ?? ''} |`);
}
process.exit(failed ? 1 : 0);
