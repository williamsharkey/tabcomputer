/**
 * Pyodide from this site: server.mjs's /pyodide/v<VERSION>/full/<FILE> (each
 * file fetched from the upstream once, checked against a sha256, kept on
 * disk), and the page's choice between it and jsdelivr
 * (src/python/pyodide-dist.ts). The route runs in
 * pyodide-mirror-harness.mjs over a made-up distribution; the real
 * server.mjs is started too, for its wiring, its pins and the off switch.
 * A real Pyodide through the route is tests/browser/pyodide-numpy.mjs.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setShiroOrigin } from '@shiro/utils/shiro-origin';
import { PYODIDE_CDN, PYODIDE_SITE_PATH, PYODIDE_VERSION, clearLockCache, fetchLock, pyodideIndexURL } from '@shiro/python/pyodide-dist';

const ROOT = resolve(__dirname, '../../..');
const HARNESS = resolve(__dirname, 'pyodide-mirror-harness.mjs');
const V = '9.9.9';
const NUMPY = 'numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl';
const { createHash } = (process as any).getBuiltinModule('crypto');
const { createServer, request } = (process as any).getBuiltinModule('http');
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const procs: ChildProcess[] = [];

/** The route on a port of its own; `at(path)` fetches from it */
async function harness(env: Record<string, string>) {
  const p = spawn('node', [HARNESS], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  procs.push(p);
  const port = await new Promise<number>((ok, fail) => {
    p.stdout!.on('data', (d) => { const m = /PORT (\d+)/.exec(String(d)); if (m) ok(Number(m[1])); });
    p.on('exit', () => fail(new Error('the harness exited')));
  });
  const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  const file = (name: string, init?: RequestInit, version = V) => at(`/pyodide/v${version}/full/${name}`, init);
  const hits = async (name?: string) => {
    const all = await (await at('/__hits')).json() as string[];
    return name ? all.filter((h) => h === name).length : all.length;
  };
  return { port, at, file, hits, stop: () => p.kill() };
}

let h: Awaited<ReturnType<typeof harness>>;
const CACHE = mkdtempSync(join(tmpdir(), 'pyodide-mirror-test-'));
beforeAll(async () => { h = await harness({ CACHE }); }, 20_000);
afterAll(() => { for (const p of procs) p.kill(); });

describe('pyodideRequest and the configuration', () => {
  it('takes a file of a version\'s full/ directory and nothing else; the pinned version is the page\'s', () => {
    const server = new URL('../../../server.mjs', import.meta.url).href;
    const paths = [
      `/pyodide/v0.29.5/full/pyodide.mjs`, `/pyodide/v0.29.5/full/${NUMPY}`,
      '/pyodide/v0.29.5/full/', '/pyodide/v0.29.5/full/a/b.whl', '/pyodide/v0.29.5/full/..', '/pyodide/v0.29.5/full/a..b',
      '/pyodide/v0.29.5/full/%2e%2e%2fx', '/pyodide/v0.29.5/full/.hidden', '/pyodide/v0.29.5/debug/pyodide.mjs',
      '/pyodide/0.29.5/full/pyodide.mjs', '/pyodide/v0.29/full/pyodide.mjs', '/pyodide/vlatest/full/pyodide.mjs',
      '/pyodide/pyodide', '/x/pyodide/v0.29.5/full/pyodide.mjs', '/pyodide/v0.29.5/full/pyodide.mjs/',
    ];
    const out = execFileSync('node', ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(server)});
      console.log(JSON.stringify({
        req: ${JSON.stringify(paths)}.map((p) => m.pyodideRequest(p)),
        versions: Object.keys(m.PYODIDE_DISTS),
        core: Object.keys(m.PYODIDE_DISTS[${JSON.stringify(PYODIDE_VERSION)}] ?? {}),
        def: m.pyodideMirrorConfig({}),
        set: m.pyodideMirrorConfig({ TABCOMPUTER_PYODIDE: '0', TABCOMPUTER_PYODIDE_UPSTREAM: 'https://mirror.test/py/', TABCOMPUTER_PYODIDE_CACHE: '/var/x', TABCOMPUTER_PYODIDE_CACHE_MAX_MB: '5' }),
      }));
      process.exit(0);`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const got = JSON.parse(out.trim().split('\n').pop()!);
    expect(got.req.slice(0, 2)).toEqual([{ version: '0.29.5', file: 'pyodide.mjs' }, { version: '0.29.5', file: NUMPY }]);
    expect(got.req.slice(2)).toEqual(paths.slice(2).map(() => null));
    // (the page asks for PYODIDE_VERSION: a bump there needs its sha256 list here)
    expect(got.versions).toContain(PYODIDE_VERSION);
    expect(got.core.sort()).toEqual(['pyodide-lock.json', 'pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide.js', 'pyodide.mjs', 'python_stdlib.zip']);
    expect(got.def).toMatchObject({ enabled: true, upstream: 'https://cdn.jsdelivr.net/pyodide', maxBytes: 1024 * 2 ** 20 });
    expect(got.def.cacheDir).toMatch(/tabcomputer-pyodide$/);
    expect(got.set).toMatchObject({ enabled: false, upstream: 'https://mirror.test/py', cacheDir: '/var/x', maxBytes: 5 * 2 ** 20 });
  });
});

describe('/pyodide/v<VERSION>/full/<FILE>', () => {
  it('serves a core file with its type, for ever, to any origin; the loader also with the page\'s script headers', async () => {
    const w = await h.file('pyodide.asm.wasm', { headers: { 'accept-encoding': 'identity' } });
    expect(w.status).toBe(200);
    expect(w.headers.get('content-type')).toBe('application/wasm');
    expect(w.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    expect(w.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    expect(w.headers.get('access-control-allow-origin')).toBe('*');
    expect(w.headers.get('x-script-header')).toBeNull();
    const body = new Uint8Array(await w.arrayBuffer());
    expect(w.headers.get('content-length')).toBe(String(body.length));
    expect(w.headers.get('etag')).toBe(`"sha256-${sha256(body)}"`);
    const js = await h.file('pyodide.mjs');
    expect(js.headers.get('content-type')).toContain('text/javascript');
    expect(js.headers.get('x-script-header')).toBe('1');
    expect(await js.text()).toContain('loadPyodide');
    expect((await h.file('python_stdlib.zip')).headers.get('content-type')).toBe('application/zip');
    expect((await h.file('pyodide-lock.json')).headers.get('content-type')).toBe('application/json');
  });

  it('serves a file the lock names, from the upstream once: first requests at the same time share one fetch, later ones read the disk', async () => {
    await h.at(`/__hold?f=${NUMPY}`);
    const all = [1, 2, 3, 4].map(() => h.file(NUMPY));
    await new Promise((r) => setTimeout(r, 300));
    await h.at(`/__release?f=${NUMPY}`);
    for (const r of await Promise.all(all)) {
      expect(r.status).toBe(200);
      const body = new Uint8Array(await r.arrayBuffer());
      expect(body.length).toBe(200_000);
      expect(r.headers.get('etag')).toBe(`"sha256-${sha256(body)}"`);
      expect(r.headers.get('content-encoding')).toBeNull(); // (a wheel is a zip already)
    }
    expect(await h.hits(NUMPY)).toBe(1);
    expect((await h.file(NUMPY)).status).toBe(200);
    expect(await h.hits(NUMPY)).toBe(1);
    expect(await h.hits('pyodide-lock.json')).toBe(1);
    expect(readdirSync(join(CACHE, V))).toContain(NUMPY);
    expect(readdirSync(join(CACHE, V)).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('HEAD answers with the length and no body', async () => {
    const r = await h.file('six-1.17.0-py2.py3-none-any.whl', { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-length')).toBe('900');
    expect((await r.arrayBuffer()).byteLength).toBe(0);
  });

  it('refuses a name the lock does not have, another version and other methods, without asking the upstream', async () => {
    const before = await h.hits();
    expect((await h.file('unlisted-1.0-py3-none-any.whl')).status).toBe(404);
    expect((await h.file('pyodide.js')).status).toBe(404); // (not in this made-up version's core list)
    expect((await h.file('pyodide.mjs', undefined, '0.29.5')).status).toBe(404);
    expect((await h.file('pyodide.mjs', undefined, '9.9.8')).status).toBe(404);
    const post = await h.file('pyodide.mjs', { method: 'POST', body: 'x' });
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET, HEAD');
    expect((await h.file('pyodide.mjs', { method: 'DELETE' })).status).toBe(405);
    expect(await h.hits()).toBe(before);
  });

  it('path tricks never reach the route', async () => {
    const before = await h.hits();
    // (fetch would tidy these away: the raw request line)
    const raw = (path: string) => new Promise<{ status: number; notRoute: boolean }>((ok, fail) => {
      request({ host: '127.0.0.1', port: h.port, path, method: 'GET' }, (res: any) => {
        res.resume();
        ok({ status: res.statusCode, notRoute: res.headers['x-not-the-route'] === '1' });
      }).on('error', fail).end();
    });
    for (const p of [
      `/pyodide/v${V}/full/../../outside.whl`, `/pyodide/v${V}/full/%2e%2e%2f%2e%2e%2foutside.whl`, `/pyodide/v${V}/full/..%2foutside.whl`,
      `/pyodide/v${V}/full/sub/${NUMPY}`, `/pyodide/v${V}/full/${NUMPY}%00.mjs`, `/pyodide/v${V}/full/`,
    ]) {
      const r = await raw(p);
      expect([p, r.status]).toEqual([p, 404]);
    }
    expect(await h.hits()).toBe(before);
    expect(existsSync(join(CACHE, 'outside.whl'))).toBe(false);
  });

  it('a file that is not what the lock says is refused and not kept', async () => {
    const name = 'tampered-1.0-py3-none-any.whl';
    const r = await h.file(name);
    expect(r.status).toBe(502);
    expect(await r.text()).toContain('sha256 mismatch');
    expect(r.headers.get('cache-control')).toBe('no-store');
    expect(readdirSync(join(CACHE, V))).not.toContain(name);
    expect((await h.file(name)).status).toBe(502);
    expect(await h.hits(name)).toBe(2); // (asked again: nothing was remembered)
  });

  it('JavaScript, wasm and JSON are kept compressed too, and sent so to a browser that takes brotli', async () => {
    const plain = new Uint8Array(await (await h.file('pyodide.asm.wasm', { headers: { 'accept-encoding': 'identity' } })).arrayBuffer());
    let r: Response | null = null;
    for (let i = 0; i < 50; i++) {
      r = await h.file('pyodide.asm.wasm', { headers: { 'accept-encoding': 'gzip, br' } });
      if (r.headers.get('content-encoding') === 'br') break;
      await r.arrayBuffer();
      await new Promise((ok) => setTimeout(ok, 100));
    }
    expect(r!.headers.get('content-encoding')).toBe('br');
    expect(r!.headers.get('vary')).toBe('accept-encoding');
    expect(Number(r!.headers.get('content-length'))).toBeLessThan(plain.length);
    expect(sha256(new Uint8Array(await r!.arrayBuffer()))).toBe(sha256(plain)); // (fetch decodes it)
    const id = await h.file('pyodide.asm.wasm', { headers: { 'accept-encoding': 'identity' } });
    expect(id.headers.get('content-encoding')).toBeNull();
    expect(id.headers.get('content-length')).toBe(String(plain.length));
  });

  it('after a restart, with the upstream gone, what is on disk is served; the rest is a 502', async () => {
    const again = await harness({ CACHE, DEAD: '1' });
    const r = await again.file(NUMPY);
    expect(r.status).toBe(200);
    expect((await r.arrayBuffer()).byteLength).toBe(200_000);
    expect((await again.file('pyodide.mjs')).status).toBe(200);
    expect((await again.file('python_stdlib.zip', { method: 'HEAD' })).status).toBe(200);
    expect((await again.file('unlisted-1.0-py3-none-any.whl')).status).toBe(404); // (the lock is on disk)
    expect((await again.file('tampered-1.0-py3-none-any.whl')).status).toBe(502);
    expect(await again.hits()).toBe(0);
    again.stop();
  });

  it('a full cache serves a file without keeping it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pyodide-mirror-full-'));
    const full = await harness({ CACHE: dir, MAX_MB: '0' });
    for (let i = 0; i < 2; i++) {
      const r = await full.file(NUMPY);
      expect(r.status).toBe(200);
      expect((await r.arrayBuffer()).byteLength).toBe(200_000);
    }
    expect(await full.hits(NUMPY)).toBe(2);
    expect(existsSync(join(dir, V))).toBe(false);
    full.stop();
  });

  it('TABCOMPUTER_PYODIDE=0: a 404 for everything', async () => {
    const off = await harness({ CACHE: mkdtempSync(join(tmpdir(), 'pyodide-mirror-off-')), OFF: '1' });
    for (const f of ['pyodide-lock.json', 'pyodide.mjs', NUMPY]) expect((await off.file(f)).status).toBe(404);
    expect((await off.file('pyodide-lock.json', { method: 'HEAD' })).status).toBe(404);
    expect(await off.hits()).toBe(0);
    off.stop();
  });
});

describe('server.mjs itself', () => {
  const PORT = 5397;
  let upstream: any;
  const asked: string[] = [];
  const start = async (port: number, env: Record<string, string>) => {
    const p = spawn('node', ['server.mjs'], {
      cwd: ROOT, stdio: 'ignore',
      env: {
        ...process.env, PORT: String(port), STATIC_DIR: resolve(ROOT, 'public'),
        TABCOMPUTER_PYODIDE_UPSTREAM: `http://127.0.0.1:${upstream.address().port}/py`,
        TABCOMPUTER_PYODIDE_CACHE: mkdtempSync(join(tmpdir(), 'pyodide-mirror-real-')), ...env,
      },
    });
    procs.push(p);
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break; } catch { /* starting */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init);
  };
  beforeAll(async () => {
    // An upstream that answers every name with bytes of its own
    upstream = createServer((req: any, res: any) => { asked.push(req.url); res.writeHead(200); res.end('not Pyodide'); });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  });
  afterAll(() => upstream?.close());

  it('has the route, serves nothing its pins do not match, and nothing else under /pyodide/', async () => {
    const get = await start(PORT, {});
    const base = `/pyodide/v${PYODIDE_VERSION}/full/`;
    expect(base).toBe(PYODIDE_SITE_PATH);
    for (const f of ['pyodide.mjs', 'pyodide.asm.wasm', 'pyodide-lock.json']) {
      const r = await get(base + f);
      expect([f, r.status, (await r.text()).trim()]).toEqual([f, 502, 'upstream: sha256 mismatch']);
    }
    // (the lock was refused, so no other name can be vouched for)
    expect((await get(base + NUMPY)).status).toBe(502);
    expect((await get(base + 'pyodide-lock.json', { method: 'HEAD' })).status).toBe(502);
    expect(asked).toContain(`/py/v${PYODIDE_VERSION}/full/pyodide.mjs`);
    const n = asked.length;
    expect((await get('/pyodide/v0.1.0/full/pyodide.mjs')).status).toBe(404);
    expect((await get(`${base}sub/pyodide.mjs`)).status).toBe(404);
    expect(asked.length).toBe(n);
    // /pyodide/<repo> is still a repository link: the static handler's (no app shell in public/)
    expect(await (await get('/pyodide/pyodide')).text()).toBe('Not found');
  }, 30_000);

  it('TABCOMPUTER_PYODIDE=0 turns it off', async () => {
    const get = await start(PORT + 1, { TABCOMPUTER_PYODIDE: '0' });
    const n = asked.length;
    const r = await get(`${PYODIDE_SITE_PATH}pyodide-lock.json`, { method: 'HEAD' });
    expect(r.status).toBe(404);
    expect((await get(`${PYODIDE_SITE_PATH}pyodide.mjs`)).status).toBe(404);
    expect(asked.length).toBe(n);
  }, 30_000);
});

describe('where the page takes Pyodide from', () => {
  const SITE = `https://tab.test${PYODIDE_SITE_PATH}`;
  const store = new Map<string, string>();
  const hadStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  beforeAll(() => {
    setShiroOrigin('https://tab.test');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } } });
  });
  afterAll(() => { setShiroOrigin(null); if (hadStorage) Object.defineProperty(globalThis, 'localStorage', hadStorage); else delete (globalThis as any).localStorage; });
  afterEach(() => { store.clear(); clearLockCache(); });

  /** A site answering the probe with `answer`; `asked` is every request made */
  function site(answer: (url: string, init?: RequestInit) => Response | Promise<Response>) {
    const asked: string[] = [];
    const f = (async (input: any, init?: any) => { asked.push(`${init?.method ?? 'GET'} ${input}`); return answer(String(input), init); }) as typeof fetch;
    return { fetch: f, asked };
  }
  const json = () => new Response(null, { status: 200, headers: { 'content-type': 'application/json' } });

  it('this site, when it has the distribution: one HEAD for the package list', async () => {
    const s = site(json);
    expect(await pyodideIndexURL(s.fetch)).toBe(SITE);
    expect(SITE).toMatch(new RegExp(`^https?://[^/]+/pyodide/v${PYODIDE_VERSION.replace(/\./g, '\\.')}/full/$`));
    expect(s.asked).toEqual([`HEAD ${SITE}pyodide-lock.json`]);
  });

  it('jsdelivr, when the site answers 404, the app shell, an error, or not at all', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      () => new Response('Not found', { status: 404 }),
      () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } }),
      () => new Response('upstream: 503', { status: 502 }),
      () => { throw new TypeError('Failed to fetch'); },
    ];
    for (const a of answers) expect(await pyodideIndexURL(site(a).fetch)).toBe(PYODIDE_CDN);
    expect(PYODIDE_CDN).toBe(`https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`);
  });

  it('the localStorage override wins, and nothing is asked', async () => {
    store.set('tabcomputer-pyodide-url', 'https://mirror.school.test/pyodide');
    const s = site(json);
    expect(await pyodideIndexURL(s.fetch)).toBe('https://mirror.school.test/pyodide/');
    expect(s.asked).toEqual([]);
  });

  it('the page asks once, and the package list comes from where it chose', async () => {
    const real = globalThis.fetch;
    const s = site((url, init) => init?.method === 'HEAD' ? json() : new Response(JSON.stringify({ info: { python: '3.13.2' }, packages: {} }), { status: 200 }));
    globalThis.fetch = s.fetch;
    try {
      expect(await Promise.all([pyodideIndexURL(), pyodideIndexURL(), pyodideIndexURL()])).toEqual([SITE, SITE, SITE]);
      expect((await fetchLock()).info.python).toBe('3.13.2');
      await fetchLock();
      expect(s.asked).toEqual([`HEAD ${SITE}pyodide-lock.json`, `GET ${SITE}pyodide-lock.json`]);
    } finally { globalThis.fetch = real; }
  });
});
