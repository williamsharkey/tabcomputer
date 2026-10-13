// What a Python class installs, on the built-in Python (tabcomputer#125,
// #112), typed into the real terminal from a fresh profile:
// `pip install flask` and a hello-world app answering a request, PyYAML and
// tornado without their extensions, what check50 and JupyterLab say instead
// of installing, and numpy through Pyodide. Packages come from pypi.org.
//
//   npx vite build && PORT=5299 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/python-wheels.mjs [URL] [--shots DIR]
//
// Prints one line per step with its time; exits 1 if a step fails.
// PLAYWRIGHT= and CHROMIUM= pick the tools (default: playwright or
// playwright-core from node_modules, the pre-installed Chromium).
import { mkdirSync } from 'node:fs';
import { chromiumPath, joinWrappedRows, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:5299/?ui=terminal';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const LIMIT = Number(process.env.WORKFLOW_LIMIT_MS || 300_000); // per step
if (shots) mkdirSync(shots, { recursive: true });

// Whole lines: a row xterm wrapped is joined to the one before it, so pip's long
// "Successfully installed ..." line matches at any terminal width.
const bufferOf = async (page) => joinWrappedRows(await page.evaluate(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) { const l = b.getLine(y); rows.push({ text: l?.translateToString(false) ?? '', wrapped: !!l?.isWrapped }); }
  return rows;
}));

let marks = 0;
/** Type `cmd` at the prompt and wait for its exit status (as in dev-workflows.mjs). */
async function step(page, cmd, expect = null) {
  const mark = `@@step${++marks}`;
  const t0 = Date.now();
  await page.evaluate(() => window.__tabcomputer.terminal.term.focus());
  await page.keyboard.type(`${cmd}; echo "${mark} $?"\r`, { delay: 2 });
  const re = new RegExp(`^${mark} (\\d+)$`, 'm');
  for (;;) {
    const s = await bufferOf(page);
    const m = re.exec(s);
    if (m) {
      const out = s.slice(0, m.index).split(`echo "${mark} $?"`).pop() ?? '';
      const ms = Date.now() - t0;
      const code = Number(m[1]);
      const ok = code === 0 && (!expect || expect.test(out));
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${(ms / 1000).toFixed(1).padStart(6)} s  ${cmd.length > 110 ? cmd.slice(0, 107) + '...' : cmd}`);
      if (!ok) throw new Error(`exit ${code}${expect && code === 0 ? `, no ${expect}` : ''}:\n${out.replace(/\s+$/gm, '').trim().split('\n').slice(-25).join('\n')}`);
      return { out, ms };
    }
    if (Date.now() - t0 > LIMIT) throw new Error(`timed out after ${LIMIT / 1000} s: ${cmd}\n${s.split('\n').slice(-25).join('\n')}`);
    await page.waitForTimeout(100);
  }
}

const APP = String.raw`from flask import Flask, render_template_string\napp = Flask(__name__)\n@app.route("/")\ndef hello():\n    return render_template_string("<p>Hello, {{ who }}!</p>", who="<class>")\napp.run(port=5000)\n`;
const GET = `python3 -c 'import urllib.request as u; print(u.urlopen("http://127.0.0.1:5000/", timeout=5).read().decode())'`;
/** A refused install: the command fails, and says where the package can be installed. */
const refused = (pkg) => [`pip install ${pkg} > /tmp/refused.out 2>&1; test $? = 1 && grep -c "toolchain install python" /tmp/refused.out && grep "compiled extension" /tmp/refused.out`, /compiled extension/];

const STEPS = [
  // The interpreter installs on first use: keep that out of pip's time
  [`python3 -c 'import sys; print(sys.implementation.name, sys.platform)'`, /cpython wasi/],
  ['pip install flask', /Successfully installed .*Flask-.*MarkupSafe-/],
  [`mkdir -p ~/hello && cd ~/hello && printf '${APP}' > app.py && (python3 app.py > flask.log 2>&1 &)`],
  [`for i in $(seq 1 60); do ${GET} 2>/dev/null && break; sleep 0.2; done`, /<p>Hello, &lt;class&gt;!<\/p>/],
  [GET, /<p>Hello, &lt;class&gt;!<\/p>/],
  ['pip install pyyaml tornado', /Successfully installed .*PyYAML-.*tornado-/],
  [`python3 -c 'import yaml, tornado.web; print(yaml.safe_load("a: [1, 2]"), yaml.__with_libyaml__, tornado.version)'`, /\{'a': \[1, 2\]\} False \d/],
  ['pip install "termcolor<2"', /Successfully installed termcolor-1\.1\.0/],
  refused('check50 submit50'),
  refused('jupyterlab'),
  // numpy comes from Pyodide (tests/browser/pyodide-numpy.mjs has the rest): pip records it, python3 runs it there
  ['pip install numpy', /Provided by Pyodide/],
  [`python3 -c "import numpy; print('sum', numpy.arange(10).sum())"`, /sum 45/],
];

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // a fresh profile
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let failed = 0;
try {
  await page.goto(url);
  await page.waitForFunction(() => window.__tabcomputer?.terminal?.term && window.__tabcomputer?.kernel, null, { timeout: 90_000 });
  for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf(page)); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
  for (const [cmd, expect] of STEPS) await step(page, cmd, expect);
  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  console.log('ok');
} catch (e) {
  failed = 1;
  console.log(`FAIL\n  ${String(e.message).replace(/\n/g, '\n  ')}`);
}
if (shots) await page.screenshot({ path: `${shots}/python-wheels.png` }).catch(() => {});
await browser.close();
process.exit(failed);
