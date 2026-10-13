// PostgreSQL in the tab (docs/POSTGRES.md, tabcomputer#126), typed into the
// real terminal from a fresh profile: the first connection starts the server
// (its download, a new cluster), a database course's steps in psql (a script
// and the prompt), an Express app on node's `pg` that reads and writes, a
// Python program on pg8000, and the data after a reload. It prints the time
// of each step, what the server sent for PostgreSQL, and a query round trip.
//
//   npx vite build && PORT=6741 STATIC_DIR=$PWD/dist node server.mjs &
//   node tests/browser/postgres.mjs [URL] [--shots DIR]
//
// Needs registry.npmjs.org and pypi.org (express, pg, pg8000). Exits 1 if a
// step fails. PLAYWRIGHT= and CHROMIUM= pick the tools.
import { mkdirSync } from 'node:fs';
import http from 'node:http';
import { chromiumPath, joinWrappedRows, loadPlaywright } from './_browser.mjs';
const { chromium } = loadPlaywright();

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args.splice(i, 2)[1]; };
const shots = opt('--shots');
const url = args[0] || 'http://localhost:6741/?ui=terminal';
const exe = chromiumPath('/opt/pw-browsers/chromium-1194/chrome-linux/chrome');
const LIMIT = Number(process.env.WORKFLOW_LIMIT_MS || 300_000); // per step
if (shots) mkdirSync(shots, { recursive: true });

const bufferOf = async (page) => joinWrappedRows(await page.evaluate(() => {
  const b = window.__tabcomputer.terminal.term.buffer.active;
  const rows = [];
  for (let y = 0; y < b.length; y++) { const l = b.getLine(y); rows.push({ text: l?.translateToString(false) ?? '', wrapped: !!l?.isWrapped }); }
  return rows;
}));

let marks = 0;
const times = {};
/** Type `cmd` at the prompt and wait for its exit status. */
async function step(page, cmd, expect = null, name = '') {
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
      if (name) times[name] = ms;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${(ms / 1000).toFixed(1).padStart(6)} s  ${cmd.length > 110 ? cmd.slice(0, 107) + '...' : cmd}`);
      if (!ok) throw new Error(`exit ${code}${expect && code === 0 ? `, no ${expect}` : ''}:\n${out.replace(/\s+$/gm, '').trim().split('\n').slice(-25).join('\n')}`);
      return { out, ms };
    }
    if (Date.now() - t0 > LIMIT) throw new Error(`timed out after ${LIMIT / 1000} s: ${cmd}\n${s.split('\n').slice(-25).join('\n')}`);
    await page.waitForTimeout(100);
  }
}

/** Type `text` and wait until the terminal shows `re` after what was there before. */
async function typeAndSee(page, text, re, what) {
  const before = (await bufferOf(page)).length;
  const t0 = Date.now();
  await page.keyboard.type(text, { delay: 2 });
  for (;;) {
    const s = (await bufferOf(page)).slice(Math.max(0, before - 200));
    if (re.test(s)) { console.log(`  ok   ${((Date.now() - t0) / 1000).toFixed(1).padStart(6)} s  ${what}`); return s; }
    if (Date.now() - t0 > 60_000) throw new Error(`${what}: no ${re} after 60 s:\n${s.split('\n').slice(-20).join('\n')}`);
    await page.waitForTimeout(50);
  }
}

const FILES = {
  '/home/user/universe.sql': [
    '\\c universe',
    'CREATE TABLE galaxy(galaxy_id SERIAL PRIMARY KEY, name VARCHAR(30) UNIQUE NOT NULL, age_in_millions_of_years INT, has_life BOOLEAN DEFAULT false);',
    'CREATE TABLE star(star_id SERIAL PRIMARY KEY, name VARCHAR(30) UNIQUE NOT NULL,',
    '  galaxy_id INT NOT NULL REFERENCES galaxy(galaxy_id), mass NUMERIC(6,2));',
    "INSERT INTO galaxy(name, age_in_millions_of_years, has_life) VALUES ('Milky Way', 13600, true), ('Andromeda', 10000, false);",
    "INSERT INTO star(name, galaxy_id, mass) VALUES ('Sun', 1, 1.00), ('Sirius', 1, 2.06), ('Alpheratz', 2, 3.80);",
    'SELECT s.name AS star, g.name AS galaxy FROM star s JOIN galaxy g USING (galaxy_id) ORDER BY s.name;',
    '',
  ].join('\n'),
  '/home/user/api/server.js': `const express = require('express');
const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', user: 'freecodecamp', database: 'universe' });
const app = express();
app.use(express.json());
app.get('/stars', async (req, res) => {
  const r = await pool.query('SELECT s.name, g.name AS galaxy FROM star s JOIN galaxy g USING (galaxy_id) ORDER BY star_id');
  res.json(r.rows);
});
app.post('/stars', async (req, res) => {
  const r = await pool.query('INSERT INTO star(name, galaxy_id) VALUES ($1, $2) RETURNING star_id, name', [req.body.name, req.body.galaxy_id]);
  res.status(201).json(r.rows[0]);
});
app.listen(3000, () => console.log('listening on 3000'));
`,
  '/home/user/api/bench.js': `const { Client } = require('pg');
(async () => {
  const c = new Client({ host: 'localhost', user: 'freecodecamp', database: 'universe' });
  await c.connect();
  let t = performance.now();
  for (let i = 0; i < 200; i++) await c.query('SELECT 1');
  const one = (performance.now() - t) / 200;
  t = performance.now();
  for (let i = 0; i < 100; i++) await c.query('SELECT s.name, g.name FROM star s JOIN galaxy g USING (galaxy_id) WHERE star_id = $1', [1 + i % 3]);
  const join = (performance.now() - t) / 100;
  t = performance.now();
  await c.query('CREATE TABLE IF NOT EXISTS big(id int primary key, v text)');
  await c.query('TRUNCATE big');
  await c.query("INSERT INTO big SELECT g, md5(g::text) FROM generate_series(1, 20000) g");
  const load = performance.now() - t;
  t = performance.now();
  const n = (await c.query("SELECT count(*) FROM big WHERE v LIKE 'a%'")).rows[0].count;
  const scan = performance.now() - t;
  console.log('ROUNDTRIP select1=' + one.toFixed(2) + 'ms join=' + join.toFixed(2) + 'ms insert20k=' + load.toFixed(0) + 'ms scan20k=' + scan.toFixed(1) + 'ms rows=' + n);
  await c.end();
})().catch((e) => { console.error('BENCH FAILED', e.message); process.exit(1); });
`,
  '/home/user/db.py': `import pg8000.native
con = pg8000.native.Connection("freecodecamp", host="localhost", database="universe")
con.run("INSERT INTO galaxy(name, age_in_millions_of_years) VALUES (:n, :a)", n="Whirlpool", a=400)
for row in con.run("SELECT galaxy_id, name, age_in_millions_of_years FROM galaxy ORDER BY galaxy_id"):
    print(row)
print("python rows", con.row_count)
con.close()
`,
};

const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } }); // a fresh profile
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
/** The files the page fetched from this site while the first connection was made: PostgreSQL's download */
const fetched = new Set();
let firstUse = false;
page.on('request', (r) => { if (firstUse && r.url().startsWith(new URL(url).origin) && !r.url().includes('/api/')) fetched.add(r.url()); });
/** What the server sends for `u` to a browser: the bytes on the wire and their encoding */
const wire = (u) => new Promise((resolve, reject) => {
  http.get(u, { headers: { 'accept-encoding': 'br, gzip' } }, (res) => {
    let bytes = 0;
    res.on('data', (c) => { bytes += c.length; });
    res.on('end', () => resolve({ bytes, encoding: res.headers['content-encoding'] || 'none' }));
  }).on('error', reject);
});

const ready = async () => {
  await page.waitForFunction(() => window.__tabcomputer?.terminal?.term && window.__tabcomputer?.kernel, null, { timeout: 90_000 });
  for (let i = 0; i < 300 && !/\$ ?$/m.test(await bufferOf(page)); i++) await page.waitForTimeout(100);
  await page.waitForTimeout(500);
};

let failed = 0;
try {
  await page.goto(url);
  await ready();
  await page.evaluate(async (files) => {
    for (const [path, text] of Object.entries(files)) {
      await window.__tabcomputer.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
      await window.__tabcomputer.fs.writeFile(path, text);
    }
  }, FILES);

  // Nothing of PostgreSQL is loaded before something connects
  firstUse = true;
  await step(page, 'service postgresql status; test $? = 3', /inactive.*starts when something connects/);
  if ([...fetched].some((u) => /pglite|initdb/.test(u))) throw new Error('PostgreSQL was fetched before anything connected');
  // The first connection: the download, a new cluster, the server
  await step(page, 'pg_isready', /localhost:5432 - accepting connections/, 'first use');
  firstUse = false;
  if (![...fetched].some((u) => /pglite-[\w-]+\.wasm$/.test(u))) throw new Error(`the first connection did not fetch PostgreSQL (it was loaded before?): ${[...fetched].join(', ')}`);
  await step(page, 'psql -At -c "select version()" -c "select current_user, current_database()"', /PostgreSQL 18\.\d+[\s\S]*user\|user/);
  await step(page, 'ps aux | grep -c "[p]ostgres -D"', /^1$/m);
  await step(page, 'sudo -u postgres psql -At -c "select current_user"', /^postgres$/m);
  await step(page, 'sudo service postgresql status', /active \(running\), PostgreSQL 18 on 127\.0\.0\.1:5432/);

  // A relational database course: a database, tables with keys, rows, a join
  await step(page, 'psql --username=freecodecamp --dbname=postgres -c "CREATE DATABASE universe;"', /CREATE DATABASE/, 'create database');
  await step(page, 'psql --username=freecodecamp --dbname=postgres -f ~/universe.sql', /Alpheratz \| Andromeda[\s\S]*Sun +\| Milky Way[\s\S]*\(3 rows\)/, 'script');
  // ... and at the prompt
  await page.evaluate(() => window.__tabcomputer.terminal.term.focus());
  await typeAndSee(page, 'psql universe freecodecamp\r', /universe=#\s*$/, 'psql prompt');
  await typeAndSee(page, '\\dt\r', /List of relations[\s\S]*public \| galaxy \| table \| freecodecamp[\s\S]*\(2 rows\)[\s\S]*universe=#\s*$/, '\\dt');
  await typeAndSee(page, '\\d star\r', /Table "public\.star"[\s\S]*"star_pkey" PRIMARY KEY, btree \(star_id\)[\s\S]*FOREIGN KEY \(galaxy_id\) REFERENCES galaxy\(galaxy_id\)[\s\S]*universe=#\s*$/, '\\d star');
  await typeAndSee(page, 'SELECT name FROM galaxy\r', /universe-#\s*$/, 'a statement over two lines');
  await typeAndSee(page, 'WHERE has_life;\r', / Milky Way\n\(1 row\)[\s\S]*universe=#\s*$/, 'its result');
  await typeAndSee(page, '\\l\r', /List of databases[\s\S]*universe +\| freecodecamp \| UTF8[\s\S]*universe=#\s*$/, '\\l');
  await typeAndSee(page, '\\c postgres\r', /You are now connected to database "postgres" as user "freecodecamp"\.[\s\S]*postgres=#\s*$/, '\\c postgres');
  await typeAndSee(page, '\\q\r', /\$ ?$/, '\\q');

  // node: an Express app on pg that reads and writes
  await step(page, 'cd ~/api && npm init -y > /dev/null && npm install express pg 2>&1 | tail -2', null, 'npm install');
  await step(page, '(node server.js > server.log 2>&1 &) ; for i in $(seq 1 50); do grep -q listening server.log 2>/dev/null && break; sleep 0.2; done; cat server.log', /listening on 3000/);
  await step(page, `curl -s -X POST -H 'content-type: application/json' -d '{"name":"Vega","galaxy_id":1}' http://localhost:3000/stars`, /\{"star_id":4,"name":"Vega"\}/);
  await step(page, 'curl -s http://localhost:3000/stars', /"name":"Sun","galaxy":"Milky Way"[\s\S]*"name":"Vega","galaxy":"Milky Way"/);
  const bench = await step(page, 'node bench.js', /ROUNDTRIP select1=/);
  console.log(`       ${/ROUNDTRIP.*/.exec(bench.out)?.[0]}`);

  // Python: pg8000 on the built-in interpreter
  await step(page, 'cd ~ && pip install pg8000 2>&1 | tail -1', /Successfully installed .*pg8000-/, 'pip install');
  await step(page, 'python3 db.py', /\[3, 'Whirlpool', 400\][\s\S]*python rows/);

  // pg_dump, and its script loaded into another database
  await step(page, 'pg_dump -U freecodecamp universe > ~/universe-dump.sql && grep -c "^INSERT INTO public.star" ~/universe-dump.sql', /^4$/m, 'pg_dump');
  await step(page, 'createdb -U freecodecamp copy && psql -U freecodecamp -d copy -q -v ON_ERROR_STOP=1 -f ~/universe-dump.sql && psql -U freecodecamp -d copy -At -c "select count(*) from star" && dropdb -U freecodecamp copy', /^4$/m);

  // A reload: the server is gone with the page; the next connection finds the data
  await step(page, 'psql -U freecodecamp -d universe -At -c "select count(*) from star" -c "select count(*) from galaxy"', /^4\n3$/m);
  await page.waitForTimeout(1000); // (the files the last statement changed reach the filesystem)
  await page.reload();
  await ready();
  await step(page, 'psql -U freecodecamp -d universe -At -c "select count(*) from star" -c "select count(*) from galaxy"', /^4\n3$/m, 'after a reload');
  const du = await step(page, 'du -sh /var/lib/postgresql | cut -f1', /\d/);
  const timing = await step(page, `psql -U freecodecamp -d universe -c '\\timing on' -c 'select 1' -c 'select 1' -c 'select count(*) from star' | grep Time`, /Time: /);

  if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
  let total = 0;
  for (const u of [...fetched].sort()) {
    const s = await wire(u);
    total += s.bytes;
    console.log(`  sent ${String(s.bytes).padStart(9)} bytes  ${s.encoding.padEnd(5)} ${u.split('/').pop()}`);
  }
  console.log(`  sent ${String(total).padStart(9)} bytes in all for the first connection`);
  console.log(`  the data directory: ${du.out.trim().split('\n').pop()}`);
  console.log(`  psql's own times: ${timing.out.trim().split('\n').map((l) => l.trim()).join(', ')}`);
  console.log(`  first use ${(times['first use'] / 1000).toFixed(1)} s, after a reload ${(times['after a reload'] / 1000).toFixed(1)} s`);
  console.log('ok');
} catch (e) {
  failed = 1;
  console.log(`FAIL\n  ${String(e.message).replace(/\n/g, '\n  ')}`);
}
if (shots) await page.screenshot({ path: `${shots}/postgres.png` }).catch(() => {});
await browser.close();
process.exit(failed);
