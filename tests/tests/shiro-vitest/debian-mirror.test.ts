/**
 * server.mjs's Debian package mirror (docs/DEBIAN.md "Package mirror"): apt's
 * /debian/mirror/HOST/PATH and the GUI apps' /debian/pool/PATH, one handler,
 * against a local stand-in for deb.debian.org and snapshot.debian.org.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const PORT = 5394;
let upstream: Server;
let srv: ChildProcess;
const hits: string[] = [];

beforeAll(async () => {
  // The real http module (the test config polyfills node:http for the browser code)
  const { createServer } = (process as any).getBuiltinModule('http');
  upstream = createServer((req: any, res: any) => {
    hits.push(req.url!);
    if (req.url === '/debian/pool/main/h/hello/hello_1_amd64.deb') { res.writeHead(200, { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' }); return res.end('current-deb'); }
    if (req.url === '/snap/pool/main/h/hello/hello_0_amd64.deb') { res.writeHead(200); return res.end('old-deb'); }
    if (req.url === '/debian/dists/trixie/InRelease') { res.writeHead(200); return res.end('release'); }
    res.writeHead(404); res.end();
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const up = `http://127.0.0.1:${(upstream.address() as any).port}`;
  srv = spawn('node', ['server.mjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: {
      ...process.env, PORT: String(PORT), STATIC_DIR: resolve(ROOT, 'public'),
      TABCOMPUTER_DEBIAN_MIRRORS: `deb.debian.org=${up}`, TABCOMPUTER_DEBIAN_SNAPSHOT: `${up}/snap/`,
      TABCOMPUTER_DEBIAN_CACHE: mkdtempSync(join(tmpdir(), 'shiro-mirror-test-')),
    },
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
});
afterAll(() => { srv?.kill(); upstream?.close(); });

const get = (p: string) => fetch(`http://127.0.0.1:${PORT}${p}`);

describe('Debian package mirror', () => {
  it("serves apt's archive paths and caches pool files", async () => {
    const r = await get('/debian/mirror/deb.debian.org/debian/pool/main/h/hello/hello_1_amd64.deb');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('current-deb');
    expect(r.headers.get('cache-control')).toContain('immutable');
    expect(r.headers.get('last-modified')).toBe('Mon, 01 Jan 2024 00:00:00 GMT');
    const before = hits.length;
    expect(await (await get('/debian/mirror/deb.debian.org/debian/pool/main/h/hello/hello_1_amd64.deb')).text()).toBe('current-deb');
    expect(hits.length).toBe(before); // from the disk cache
    expect(await (await get('/debian/mirror/deb.debian.org/debian/dists/trixie/InRelease')).text()).toBe('release');
  });

  it("serves the GUI apps' /debian/pool/ URL from the same mirror and cache", async () => {
    const before = hits.length;
    const r = await get('/debian/pool/main/h/hello/hello_1_amd64.deb');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('current-deb');
    expect(hits.length).toBe(before);
  });

  it('falls back to snapshot.debian.org for pool files the mirror dropped', async () => {
    const r = await get('/debian/pool/main/h/hello/hello_0_amd64.deb');
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('old-deb');
  });

  it('answers as before: the length, a HEAD, and Not Modified', async () => {
    const path = '/debian/mirror/deb.debian.org/debian/pool/main/h/hello/hello_1_amd64.deb';
    const r = await get(path);
    expect(r.headers.get('content-length')).toBe('11');
    expect(r.headers.get('content-type')).toBe('application/octet-stream');
    expect(r.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    const head = await fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'HEAD' });
    expect([head.status, head.headers.get('content-length'), await head.text()]).toEqual([200, '11', '']);
    const same = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { 'if-modified-since': 'Tue, 02 Jan 2024 00:00:00 GMT' } });
    expect(same.status).toBe(304);
    const missing = await get('/debian/mirror/deb.debian.org/debian/dists/trixie/Nothing');
    expect([missing.status, missing.headers.get('content-type'), missing.headers.get('cache-control')]).toEqual([404, 'text/plain; charset=utf-8', 'no-cache']);
    expect(await missing.text()).toBe('upstream: 404 Not Found\n');
  });

  it('is not an open proxy', async () => {
    expect((await get('/debian/mirror/evil.example/debian/pool/main/x/x.deb')).status).toBe(404);
    expect((await get('/debian/mirror/deb.debian.org/etc/passwd')).status).toBe(404);
    expect((await get('/debian/mirror/deb.debian.org/debian/pool/%2e%2e/x')).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${PORT}/debian/mirror/deb.debian.org/debian/dists/trixie/InRelease`, { method: 'POST' })).status).toBe(404);
  });
});

/**
 * What a request can cost the server (server.mjs createDebianMirror, in
 * debian-mirror-harness.mjs): a file goes to disk as it arrives, no file over
 * the cap is fetched, a few upstream fetches run at a time, and the cache
 * directory has a size it stays under.
 */
describe('Debian package mirror: limits', () => {
  const HARNESS = resolve(__dirname, 'debian-mirror-harness.mjs');
  const procs: ChildProcess[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  afterAll(() => { for (const p of procs) p.kill(); });

  async function harness(env: Record<string, string> = {}) {
    const cache = env.CACHE ?? mkdtempSync(join(tmpdir(), 'deb-mirror-'));
    const p = spawn('node', [HARNESS], { env: { ...process.env, CACHE: cache, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
    procs.push(p);
    const port = await new Promise<number>((ok, fail) => {
      p.stdout!.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) ok(Number(m[1])); });
      p.on('exit', () => fail(new Error('the harness exited')));
    });
    const at = `http://127.0.0.1:${port}`;
    const pool = (name: string) => `/debian/pool/main/${name}`;
    const file = (name: string) => fetch(`${at}/debian/mirror/deb.debian.org${pool(name)}`);
    const ctl = async (path: string) => (await fetch(`${at}${path}`)).json() as Promise<any>;
    const until = async (want: (s: any) => boolean) => {
      for (let i = 0; i < 400; i++) { const s = await ctl('/__stats'); if (want(s)) return s; await sleep(10); }
      throw new Error('never got there');
    };
    /** Every file under the cache directory, by its path inside it */
    const kept = () => (existsSync(cache) ? readdirSync(cache, { recursive: true }) as string[] : []).map(String).filter((f) => statSync(join(cache, f)).isFile()).sort();
    return { cache, pool, file, ctl, until, kept, hold: (name: string) => ctl(`/__hold?f=${encodeURIComponent(pool(name))}`), release: (name: string) => ctl(`/__release?f=${encodeURIComponent(pool(name))}`) };
  }

  it('has a size limit for one file, a size limit for the cache and a limit on fetches, and makes its directory', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'deb-mirror-')), 'not/there/yet');
    const h = await harness({ CACHE: dir });
    const s = await h.ctl('/__stats');
    expect(s.config).toEqual({ maxBytes: 2048 * 1024 * 1024, maxFileBytes: 768 * 1024 * 1024, fetches: 4, cacheDir: dir });
    const r = await h.file('a_3k.deb');
    expect([r.status, r.headers.get('content-length'), (await r.arrayBuffer()).byteLength]).toEqual([200, '3072', 3072]);
    expect(h.kept()).toEqual(['deb.debian.org/debian/pool/main/a_3k.deb', 'deb.debian.org/debian/pool/main/a_3k.deb.lm']);
    // the production server keeps its copies where a reboot does not empty them
    const env = readFileSync(resolve(ROOT, 'profiles/tabcomputer/server.env'), 'utf8');
    expect(env).toMatch(/^TABCOMPUTER_DEBIAN_CACHE=\/opt\/tabcomputer\/debian-cache$/m);
    expect(env).toMatch(/^TABCOMPUTER_DEBIAN_CACHE_MAX_MB=\d+$/m);
  }, 30_000);

  it('writes a file to disk as it arrives, and every request for it gets the whole file', async () => {
    const h = await harness();
    const name = 'big_8192k.deb';
    await h.hold(name);
    const both = [h.file(name), h.file(name)];
    // half of it has come from the upstream: that half is in a temporary file, and nothing has been answered
    await h.until((s) => s.sent[h.pool(name)] >= 4096 * 1024);
    await sleep(100);
    const partial = h.kept();
    expect(partial).toHaveLength(1);
    expect(partial[0]).toMatch(/big_8192k\.deb\.\d+\.[0-9a-f]{8}\.tmp$/);
    expect(statSync(join(h.cache, partial[0])).size).toBeGreaterThanOrEqual(4096 * 1024 - 65536);
    expect((await h.ctl('/__stats')).fetching).toBe(1);
    await h.release(name);
    for (const r of await Promise.all(both)) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-length')).toBe(String(8192 * 1024));
      expect((await r.arrayBuffer()).byteLength).toBe(8192 * 1024);
    }
    expect(await h.ctl('/__hits')).toEqual([h.pool(name)]);   // fetched once for both
    expect(h.kept()).toEqual([`deb.debian.org${h.pool(name)}`, `deb.debian.org${h.pool(name)}.lm`]);
  }, 30_000);

  it('does not fetch a file over the limit, whether or not the upstream says its size', async () => {
    const h = await harness({ FILE_MAX_MB: '1' });
    const said = await h.file('huge_2048k.deb');
    expect([said.status, await said.text()]).toEqual([502, 'upstream: the file is larger than 1 MB\n']);
    expect((await h.ctl('/__stats')).sent[h.pool('huge_2048k.deb')]).toBeLessThanOrEqual(65536);   // refused by its size, not read
    const unsaid = await h.file('huge_2048k.nolen.deb');
    expect([unsaid.status, await unsaid.text()]).toEqual([502, 'upstream: the file is larger than 1 MB\n']);
    const s = await h.ctl('/__stats');
    expect(s.sent[h.pool('huge_2048k.nolen.deb')]).toBeLessThan(2048 * 1024);                        // stopped at the limit
    expect(h.kept()).toEqual([]);                                                                    // nothing kept, no temporary file left
    expect(s.fetching).toBe(0);
    expect(s.logged.filter((l: string) => /larger than 1 MB/.test(l))).toHaveLength(2);
    // a file at the limit is served
    const ok = await h.file('fits_1024k.nolen.deb');
    expect([ok.status, (await ok.arrayBuffer()).byteLength]).toEqual([200, 1024 * 1024]);
  }, 30_000);

  it('fetches a few files at a time; the others wait their turn', async () => {
    const h = await harness({ FETCHES: '2' });
    const names = ['w1_256k.deb', 'w2_256k.deb', 'w3_256k.deb', 'w4_256k.deb'];
    for (const n of names) await h.hold(n);
    const all = names.map((n) => h.file(n));
    const s = await h.until((x) => x.fetching === 2 && x.waiting === 2);
    expect(s).toMatchObject({ fetching: 2, waiting: 2 });
    expect(await h.ctl('/__hits')).toHaveLength(2);
    for (const n of names) await h.release(n);
    for (const r of await Promise.all(all)) expect([r.status, (await r.arrayBuffer()).byteLength]).toEqual([200, 256 * 1024]);
    expect(await h.ctl('/__hits')).toHaveLength(4);
    expect(await h.ctl('/__stats')).toMatchObject({ fetching: 0, waiting: 0, used: 4 * 256 * 1024 });
  }, 30_000);

  it('keeps the cache under its size: the copies used longest ago go first', async () => {
    const h = await harness({ MAX_MB: '1' });
    const get = async (n: string) => { const r = await h.file(n); expect(r.status).toBe(200); await r.arrayBuffer(); await sleep(30); };
    for (const n of ['c1_300k.deb', 'c2_300k.deb', 'c3_300k.deb']) await get(n);
    expect((await h.ctl('/__hits'))).toHaveLength(3);
    // two minutes on, c1 is used again: it is no longer the one used longest ago
    await h.ctl('/__advance?ms=120000');
    await get('c1_300k.deb');
    expect((await h.ctl('/__hits'))).toHaveLength(3);
    // a fourth file takes it past 1 MB: c2 goes, the rest stay
    await get('c4_300k.deb');
    const kept = h.kept().filter((f) => !f.endsWith('.lm')).map((f) => f.split('/').pop());
    expect(kept).toEqual(['c1_300k.deb', 'c3_300k.deb', 'c4_300k.deb']);
    expect(h.kept().filter((f) => f.endsWith('.lm'))).toHaveLength(3);
    const s = await h.ctl('/__stats');
    expect(s.used).toBeLessThanOrEqual(1024 * 1024);
    expect(s.logged.some((l: string) => /removed the 1 files used longest ago/.test(l))).toBe(true);
    // the removed one is fetched again when asked for; the kept ones are not
    await get('c3_300k.deb');
    expect((await h.ctl('/__hits'))).toHaveLength(4);
    await get('c2_300k.deb');
    expect((await h.ctl('/__hits'))).toHaveLength(5);
  }, 30_000);
});
