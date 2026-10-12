// Converter backend: a node HTTP server that runs inside the tab.
//
//   node server.js [port]        (default 4780)
//
// It serves the page in public/ and an API that runs Debian's converter
// programs (wpd2html, pub2xhtml, wps2html, wks2csv, mwaw2html, mdb-*) on files
// the page uploads. Only node's standard library: http, fs, path, child_process.
// Everything it touches is the tab's own filesystem; nothing is sent anywhere.
//
//   GET  /api/status                   which converters are installed
//   POST /api/setup                    install them; the response streams the log
//   PUT  /api/jobs/JOB/in/REL/PATH     store one dropped file (body: its bytes)
//   POST /api/jobs/JOB/convert?path=REL/PATH&to=html|csv|docx|pdf
//   GET  /api/jobs/JOB                 results so far (a reloaded page asks for this)
//   GET  /api/jobs/JOB/zip             the results folder as a zip
//   GET  /results/JOB/REL/PATH         one converted file
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');

const PORT = Number(process.argv[2] || process.env.PORT || 4780);
const PUBLIC = path.join(__dirname, 'public');
const HOME = process.env.HOME || '/home/user';
const WORK = process.env.CONVERTER_WORK || '/tmp/converter';         // dropped files
const RESULTS = process.env.CONVERTER_RESULTS || path.join(HOME, 'Converted'); // what the person keeps

const PACKAGES = ['libwpd-tools', 'libmspub-tools', 'libwps-tools', 'libmwaw-tools', 'mdbtools'];
// Needed before anything converts; the optional ones widen what converts (Debian 13's
// libmwaw-tools and libwps-tools ship no mwaw2csv or wdb2csv)
const TOOLS = ['wpd2html', 'pub2xhtml', 'wps2html', 'wks2csv', 'mwaw2html', 'mdb-tables', 'mdb-export', 'mdb-schema'];
const OPTIONAL = ['mwaw2csv', 'wdb2csv', 'pandoc', 'soffice', 'wkhtmltopdf', 'weasyprint', 'pdflatex'];

// extension → family. A family names the program for each output it can make.
const DOC = (html, text) => ({ kind: 'document', html, text });
const SHEET = (csv) => ({ kind: 'spreadsheet', csv });
const FAMILIES = {
  wpd: DOC('wpd2html', 'wpd2text'), wp: DOC('wpd2html', 'wpd2text'), wp5: DOC('wpd2html', 'wpd2text'), wp6: DOC('wpd2html', 'wpd2text'),
  pub: DOC('pub2xhtml'),
  wps: DOC('wps2html', 'wps2text'),
  wks: SHEET('wks2csv'), wk1: SHEET('wks2csv'), wk3: SHEET('wks2csv'), wk4: SHEET('wks2csv'), 123: SHEET('wks2csv'), wq1: SHEET('wks2csv'), wq2: SHEET('wks2csv'),
  wdb: SHEET('wdb2csv'),
  cwk: { kind: 'claris', html: 'mwaw2html', csv: 'mwaw2csv', text: 'mwaw2text' },
  cws: { kind: 'claris', html: 'mwaw2html', csv: 'mwaw2csv', text: 'mwaw2text' },
  mdb: { kind: 'database' },
};
const LABELS = { wpd: 'WordPerfect', wp: 'WordPerfect', wp5: 'WordPerfect', wp6: 'WordPerfect', pub: 'Publisher', wps: 'Works document', wks: 'Works/Lotus spreadsheet', wk1: 'Lotus 1-2-3', wk3: 'Lotus 1-2-3', wk4: 'Lotus 1-2-3', 123: 'Lotus 1-2-3', wq1: 'Quattro Pro', wq2: 'Quattro Pro', wdb: 'Works database', cwk: 'ClarisWorks', cws: 'ClarisWorks', mdb: 'Access database' };

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.csv': 'text/csv; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.sql': 'text/plain; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.zip': 'application/zip', '.pdf': 'application/pdf', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const sh = (cmd, opts = {}) => new Promise((resolve) => {
  const t0 = Date.now();
  exec(cmd, { timeout: opts.timeout || 120000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), ms: Date.now() - t0 });
  });
});
const safeRel = (p) => {
  const parts = String(p).split('/').filter((s) => s && s !== '.' && s !== '..');
  return parts.join('/');
};
const safeJob = (j) => String(j).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || 'job';
const exists = (p) => { try { fs.statSync(p); return true; } catch { return false; } };
const sizeOf = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

function send(res, status, body, headers = {}) {
  const isBytes = body instanceof Uint8Array;
  const out = isBytes || typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'content-type': isBytes || typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(out);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const parts = [];
    req.on('data', (c) => parts.push(typeof c === 'string' ? Buffer.from(c) : c));
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

// ── which programs are here ──
let statusCache = null;
async function status(fresh) {
  if (statusCache && !fresh) return statusCache;
  const names = [...TOOLS, ...OPTIONAL];
  const r = await sh(names.map((n) => `command -v ${n} >/dev/null 2>&1 && echo ${n}`).join('; ') + '; true');
  const have = new Set(r.stdout.split('\n').map((s) => s.trim()).filter(Boolean));
  const tools = {};
  for (const n of names) tools[n] = have.has(n);
  const ready = TOOLS.every((n) => tools[n]);
  const outputs = ['html', 'csv'];
  if (tools.pandoc) outputs.push('docx');
  if (tools.soffice || (tools.pandoc && (tools.wkhtmltopdf || tools.weasyprint || tools.pdflatex))) outputs.push('pdf');
  const st = { ready, tools, outputs, extensions: Object.keys(FAMILIES), labels: LABELS, results: RESULTS, checkMs: r.ms };
  statusCache = ready ? st : null; // keep asking until the converters are there
  return st;
}

// ── first use: install the converters, streaming what happens ──
// A prebuilt `rescue` toolchain set (seconds) when this build has one, else apt.
const SETUP = `
if toolchain list 2>/dev/null | grep -q '^rescue '; then
  echo "== Installing the prebuilt converter set (toolchain install rescue)"
  toolchain install rescue
else
  if [ ! -e /var/lib/shiro/rootfs.json ]; then
    echo "== Installing Debian (first time on this computer)"
    debian install || exit 1
  fi
  echo "== Reading the package lists (apt-get update)"
  sudo apt-get update || exit 1
  echo "== Installing ${PACKAGES.join(' ')}"
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ${PACKAGES.join(' ')} || exit 1
fi
echo "== Done"
`;
let setupRunning = null;
function setup(res) {
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  const t0 = Date.now();
  const write = (s) => { try { res.write(s); } catch {} };
  if (!setupRunning) {
    const listeners = new Set();
    // stdin 'ignore' matters in a tab: with the default piped stdin, sudo under
    // spawn() never returns there (docs/research/APP_MAKER.md, gap 3)
    const child = spawn('sh', ['-c', SETUP], { stdio: ['ignore', 'pipe', 'pipe'] });
    setupRunning = { listeners, log: '' };
    const on = (d) => { const s = String(d); setupRunning.log += s; for (const l of listeners) l(s); };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('close', (code) => {
      const done = setupRunning;
      setupRunning = null;
      statusCache = null;
      for (const l of done.listeners) l(null, code);
    });
  } else write(setupRunning.log);
  setupRunning.listeners.add((s, code) => {
    if (s !== null) return write(s);
    write(`\n== exit ${code} after ${((Date.now() - t0) / 1000).toFixed(1)} s\n`);
    res.end();
  });
}

// ── one conversion ──
function csvToHtml(csv, title) {
  const rows = [];
  let row = [], cell = '', inq = false;
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (inq) { if (c === '"') { if (csv[i + 1] === '"') { cell += '"'; i++; } else inq = false; } else cell += c; }
    else if (c === '"') inq = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const e = (s) => String(s).replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${e(title)}</title><style>body{font:14px system-ui,sans-serif}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:3px 8px;text-align:left}</style></head><body><h1>${e(title)}</h1><table>\n${rows.map((r, i) => `<tr>${r.map((c) => (i ? `<td>${e(c)}</td>` : `<th>${e(c)}</th>`)).join('')}</tr>`).join('\n')}\n</table></body></html>\n`;
}

async function run(cmd, outFile) {
  const r = await sh(`${cmd} > ${q(outFile)}`);
  if (r.code !== 0 || sizeOf(outFile) === 0) {
    try { fs.unlinkSync(outFile); } catch {}
    const why = (r.stderr.trim().split('\n').pop() || '').slice(0, 300);
    return { error: why || (r.code ? `exit ${r.code}` : 'the converter wrote nothing'), ms: r.ms };
  }
  return { ms: r.ms };
}

async function convert(job, rel, to) {
  const t0 = Date.now();
  const input = path.join(WORK, job, 'in', rel);
  const ext = (rel.split('.').pop() || '').toLowerCase();
  const fam = FAMILIES[ext];
  const outDir = path.join(RESULTS, job, path.dirname(rel));
  const stem = path.basename(rel).replace(/\.[^.]+$/, '');
  const out = (suffix) => path.join(outDir, stem + suffix);
  const done = (files, extra = {}) => ({ ok: true, path: rel, outputs: files.map((f) => ({ path: path.relative(path.join(RESULTS, job), f), size: sizeOf(f) })), ms: Date.now() - t0, ...extra });
  const fail = (error, extra = {}) => ({ ok: false, path: rel, error, ms: Date.now() - t0, ...extra });
  if (!fam) return fail(`.${ext} is not a format this converter knows`);
  if (!exists(input)) return fail('the file did not arrive');
  // A family's CSV program may not be installed: Works databases then go through wks2csv
  const have = (await status()).tools;
  const csvTool = fam.csv && (have[fam.csv] ? fam.csv : fam.csv === 'wdb2csv' ? 'wks2csv' : null);
  fs.mkdirSync(outDir, { recursive: true });
  let toolMs = 0;

  if (fam.kind === 'database') {
    const t = await sh(`mdb-tables -1 ${q(input)}`);
    toolMs += t.ms;
    if (t.code !== 0) return fail((t.stderr.trim().split('\n').pop() || `mdb-tables: exit ${t.code}`).slice(0, 300), { toolMs });
    const tables = t.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!tables.length) return fail('no tables in this database', { toolMs });
    const dir = out('');
    fs.mkdirSync(dir, { recursive: true });
    const files = [], bad = [];
    for (const table of tables) {
      const csv = path.join(dir, table.replace(/[\/\\]/g, '_') + '.csv');
      const r = await run(`mdb-export ${q(input)} ${q(table)}`, csv);
      toolMs += r.ms;
      if (r.error) { bad.push(`${table}: ${r.error}`); continue; }
      if (to === 'html') {
        const html = csv.replace(/\.csv$/, '.html');
        fs.writeFileSync(html, csvToHtml(fs.readFileSync(csv, 'utf8'), table));
        fs.unlinkSync(csv);
        files.push(html);
      } else files.push(csv);
    }
    const schema = await run(`mdb-schema ${q(input)}`, path.join(dir, 'schema.sql'));
    toolMs += schema.ms;
    if (!schema.error) files.push(path.join(dir, 'schema.sql'));
    if (!files.length) return fail(bad.join('; ') || 'nothing could be exported', { toolMs });
    return done(files, { toolMs, note: bad.length ? `tables that failed: ${bad.join('; ')}` : `${tables.length} table(s)` });
  }

  if (to === 'csv') {
    if (!fam.csv) return fail(`a ${LABELS[ext]} file is a document, not a table: pick HTML`);
    if (!csvTool) return fail(`${fam.csv} is not installed here: pick HTML`);
    const r = await run(`${csvTool} ${q(input)}`, out('.csv'));
    toolMs += r.ms;
    return r.error ? fail(r.error, { toolMs }) : done([out('.csv')], { toolMs });
  }

  // html, and docx/pdf by way of html
  const html = out('.html');
  if (fam.html) {
    const r = await run(`${fam.html} ${q(input)}`, html);
    toolMs += r.ms;
    // ClarisWorks spreadsheets: mwaw2html refuses them, mwaw2csv takes them
    if (r.error && csvTool) {
      const c = await run(`${csvTool} ${q(input)}`, out('.csv'));
      toolMs += c.ms;
      if (c.error) return fail(r.error, { toolMs });
      fs.writeFileSync(html, csvToHtml(fs.readFileSync(out('.csv'), 'utf8'), stem));
      fs.unlinkSync(out('.csv'));
    } else if (r.error) return fail(r.error, { toolMs });
  } else {
    const c = await run(`${csvTool} ${q(input)}`, out('.csv'));
    toolMs += c.ms;
    if (c.error) return fail(c.error, { toolMs });
    fs.writeFileSync(html, csvToHtml(fs.readFileSync(out('.csv'), 'utf8'), stem));
    fs.unlinkSync(out('.csv'));
  }
  if (to === 'html') return done([html], { toolMs });

  const st = await status();
  if (!st.outputs.includes(to)) return fail(`${to.toUpperCase()} needs pandoc, which is not installed here; the HTML was kept`, { toolMs, outputs: done([html]).outputs });
  const target = out('.' + to);
  const cmd = to === 'pdf' && st.tools.soffice
    ? `soffice --headless --convert-to pdf --outdir ${q(outDir)} ${q(html)}`
    : `pandoc ${q(html)} -o ${q(target)}`;
  const p = await sh(cmd, { timeout: 300000 });
  toolMs += p.ms;
  if (p.code !== 0 || !sizeOf(target)) return fail((p.stderr.trim().split('\n').pop() || `exit ${p.code}`).slice(0, 300) + '; the HTML was kept', { toolMs, outputs: done([html]).outputs });
  fs.unlinkSync(html);
  return done([target], { toolMs });
}

function listTree(dir, base = dir, out = []) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const n of names.sort()) {
    const p = path.join(dir, n);
    let st; try { st = fs.statSync(p); } catch { continue; }
    if (st.isDirectory()) listTree(p, base, out); else out.push({ path: path.relative(base, p), size: st.size });
  }
  return out;
}

// ── HTTP ──
const jobs = new Map(); // job → { results: [...] } (memory; the results folder is the durable part)
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const p = decodeURIComponent(url.pathname);
    let m;

    if (p === '/api/status') return send(res, 200, await status(url.searchParams.has('fresh')));
    if (p === '/api/ping') return send(res, 200, { t: Date.now() });
    if (p === '/api/setup' && req.method === 'POST') return setup(res);

    if ((m = /^\/api\/jobs\/([^/]+)\/in\/(.+)$/.exec(p)) && (req.method === 'PUT' || req.method === 'POST')) {
      const job = safeJob(m[1]), rel = safeRel(m[2]);
      const body = await readBody(req);
      const dest = path.join(WORK, job, 'in', rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, body);
      return send(res, 200, { ok: true, path: rel, size: body.length });
    }
    if ((m = /^\/api\/jobs\/([^/]+)\/convert$/.exec(p)) && req.method === 'POST') {
      const job = safeJob(m[1]);
      const r = await convert(job, safeRel(url.searchParams.get('path') || ''), (url.searchParams.get('to') || 'html').toLowerCase());
      if (!jobs.has(job)) jobs.set(job, { results: [] });
      jobs.get(job).results.push(r);
      return send(res, 200, r);
    }
    if ((m = /^\/api\/jobs\/([^/]+)\/zip$/.exec(p))) {
      const job = safeJob(m[1]);
      const dir = path.join(RESULTS, job);
      if (!exists(dir)) return send(res, 404, { error: 'no results yet' });
      const zip = path.join(WORK, job, 'converted.zip');
      fs.mkdirSync(path.dirname(zip), { recursive: true });
      try { fs.unlinkSync(zip); } catch {}
      const r = await sh(`cd ${q(dir)} && zip -r ${q(zip)} .`);
      if (r.code !== 0 || !sizeOf(zip)) return send(res, 500, { error: r.stderr.trim() || 'zip failed' });
      return send(res, 200, fs.readFileSync(zip), { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="converted-${job}.zip"`, 'x-zip-ms': String(r.ms) });
    }
    if ((m = /^\/api\/jobs\/([^/]+)$/.exec(p))) {
      const job = safeJob(m[1]);
      return send(res, 200, { job, folder: path.join(RESULTS, job), results: jobs.get(job)?.results || [], files: listTree(path.join(RESULTS, job)) });
    }
    if ((m = /^\/results\/([^/]+)\/(.+)$/.exec(p))) {
      const f = path.join(RESULTS, safeJob(m[1]), safeRel(m[2]));
      if (!exists(f)) return send(res, 404, 'not found');
      return send(res, 200, fs.readFileSync(f), { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
    }

    // the page
    const rel = safeRel(p === '/' ? 'index.html' : p);
    const f = path.join(PUBLIC, rel);
    if (!exists(f) || fs.statSync(f).isDirectory()) return send(res, 404, 'not found');
    return send(res, 200, fs.readFileSync(f), { 'content-type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream' });
  } catch (e) {
    send(res, 500, { error: String((e && e.message) || e) });
  }
});
server.listen(PORT, () => console.log(`converter: listening on ${PORT} (results in ${RESULTS})`));
