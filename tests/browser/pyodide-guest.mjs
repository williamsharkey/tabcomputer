// numpy in a guest without network (guest--<name>--x.<base>): its
// Content-Security-Policy lets the page ask only its own host, so Pyodide has
// to come from the server's /pyodide/ route (server.mjs). The built-in Python
// runs, `pip install numpy` records the Pyodide build, `import numpy` runs in
// Pyodide, and no request leaves the guest's origin. `pip install` of a PyPI
// package still fails there: that is the guest having no network.
//
//   npx vite build && PORT=6311 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/pyodide-guest.mjs [http://app.localhost:6311/]
//
// The base is a *.localhost name so the guest is another origin of the same
// site, as on tabcomputer.com. The server needs cdn.jsdelivr.net the first
// time (then its disk). PLAYWRIGHT= and CHROMIUM= pick the tools.
import { chromiumPath, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const base = new URL(process.argv[2] || 'http://app.localhost:6311/');
const guest = `${base.protocol}//guest--numpy--tx.${base.host}`;
const browser = await chromium.launch({ executablePath: chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome'), args: ['--no-sandbox'] });
const context = await browser.newContext();
const page = await context.newPage();
const asked = new Map(); // origin → requests
const blocked = [];
context.on('request', (r) => { const u = new URL(r.url()); if (/^https?:$/.test(u.protocol)) asked.set(u.origin, (asked.get(u.origin) ?? 0) + 1); });
page.on('console', (m) => { if (/Content Security Policy/.test(m.text())) blocked.push(m.text().slice(0, 200)); });

let failed = 0;
const check = (ok, what, detail = '') => { console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`); if (!ok) { failed = 1; if (detail) console.log(`       ${String(detail).trim().replace(/\n/g, '\n       ')}`); } };
const sh = (cmd) => page.evaluate(async (cmd) => {
  const s = window.__pgShell ??= window.__tabcomputer.shell.fork();
  let o = ''; const code = await s.execute(cmd, (x) => { o += x; }, (x) => { o += x; }); return { code, out: o };
}, cmd);

try {
  const res = await page.goto(`${guest}/?ui=terminal`);
  const csp = res.headers()['content-security-policy'] ?? '';
  check(/connect-src 'self' blob: data:/.test(csp), `the guest's policy lets the page ask only its own host (${new URL(guest).host})`, csp);
  await page.waitForFunction(() => window.__tabcomputer?.shell && window.__tabcomputer.kernel, null, { timeout: 120_000 });
  check(await page.evaluate(() => crossOriginIsolated), 'the guest page is cross-origin isolated');

  let r = await sh(`python3 -c 'import sys; print(sys.implementation.name, sys.platform)'`);
  check(r.code === 0 && /cpython wasi/.test(r.out), 'the built-in Python runs', r.out);
  r = await sh('pip install numpy');
  check(r.code === 0 && /Provided by Pyodide.*numpy [\d.]+/.test(r.out), '`pip install numpy` records the Pyodide build', r.out);
  const t0 = Date.now();
  r = await sh(`python3 -c 'import numpy, sys; print(sys.platform, numpy.__version__, int(numpy.arange(10).sum()))'`);
  check(r.code === 0 && /emscripten \d+\.\d+\.\d+ 45/.test(r.out), `\`import numpy\` runs in Pyodide (${((Date.now() - t0) / 1000).toFixed(1)} s)`, r.out);
  r = await sh('pip install cowsay');
  check(r.code !== 0, '`pip install cowsay` fails: PyPI is another site', r.out);

  const others = [...asked.keys()].filter((o) => o !== guest);
  // (the browser stops a request to another site before it is made: pypi.org is not in the list)
  check(others.length === 0, `every request went to ${guest} (${asked.get(guest)} of them)`, others.join(', '));
  check(!blocked.some((b) => /pyodide|jsdelivr/i.test(b)), 'the policy stopped no request for Pyodide', blocked.join('\n'));
} catch (e) {
  failed = 1;
  console.log(`FAIL\n  ${String(e.message).replace(/\n/g, '\n  ')}`);
}
await browser.close();
console.log(failed ? 'FAILED' : 'ok');
process.exit(failed);
