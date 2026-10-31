/**
 * server.mjs's /claude-releases/ (tabcomputer#40): Anthropic's Claude Code
 * releases from this origin, so `claude install` needn't come through the
 * rate-limited TCP relay. Against a local stand-in for downloads.claude.ai.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '../../..');
const PORT = 5396;
let upstream: Server;
let srv: ChildProcess;
const hits: string[] = [];
const CACHE = mkdtempSync(join(tmpdir(), 'claude-releases-test-'));
// Upstream responses for these paths wait until release() (downloads in flight)
const held = new Map<string, () => void>();
const holds = new Map<string, Promise<void>>();
const hold = (p: string) => holds.set(p, new Promise<void>((r) => held.set(p, r)));

// The real modules (the test config polyfills node:http and node:crypto for the browser code)
const { createHash } = (process as any).getBuiltinModule('crypto');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const GOOD = Buffer.alloc(300_000, 7); // big enough to arrive in several chunks
const BAD = Buffer.alloc(1000, 1);
const manifest = (platforms: Record<string, unknown>) => JSON.stringify({ version: 'x', platforms });

beforeAll(async () => {
  const { createServer } = (process as any).getBuiltinModule('http');
  const files: Record<string, string | Buffer> = {
    '/rel/latest': '1.0.0\n',
    '/rel/1.0.0/manifest.json': manifest({ 'linux-x64-musl': { checksum: sha256(GOOD), size: GOOD.length }, 'linux-x64': { checksum: sha256(GOOD), size: GOOD.length } }),
    '/rel/1.0.0/linux-x64-musl/claude': GOOD,
    '/rel/1.0.0/linux-x64/claude': GOOD,
    // a release whose binary doesn't match its manifest
    '/rel/1.0.1/manifest.json': manifest({ 'linux-x64-musl': { checksum: sha256(GOOD), size: BAD.length } }),
    '/rel/1.0.1/linux-x64-musl/claude': BAD,
    // a release without the musl build
    '/rel/1.0.2/manifest.json': manifest({ 'darwin-arm64': { checksum: sha256(GOOD), size: GOOD.length } }),
  };
  // more good releases, for the download cap and the pruning
  for (const v of ['2.0.0', '2.0.1', '2.0.2', '2.0.3']) {
    files[`/rel/${v}/manifest.json`] = manifest({ 'linux-x64-musl': { checksum: sha256(GOOD), size: GOOD.length } });
    files[`/rel/${v}/linux-x64-musl/claude`] = GOOD;
  }
  upstream = createServer(async (req: any, res: any) => {
    hits.push(req.url);
    await holds.get(req.url);
    const body = files[req.url];
    if (body === undefined) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-length': Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  srv = spawn('node', ['server.mjs'], {
    cwd: ROOT, stdio: 'ignore',
    env: {
      ...process.env, PORT: String(PORT), STATIC_DIR: resolve(ROOT, 'public'),
      TABCOMPUTER_CLAUDE_RELEASES_UPSTREAM: `http://127.0.0.1:${(upstream.address() as any).port}/rel`,
      TABCOMPUTER_CLAUDE_CACHE: CACHE,
    },
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
}, 20_000);
afterAll(() => { srv?.kill(); upstream?.close(); });

const get = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${PORT}${p}`, init);
const hitsFor = (p: string) => hits.filter((h) => h === `/rel/${p}`).length;

describe('claudeReleaseRequest: only the three release shapes', () => {
  it('accepts latest, a semver manifest and an allowed platform\'s binary; nothing else', () => {
    const server = new URL('../../../server.mjs', import.meta.url).href;
    const paths = [
      'latest', '2.1.296/manifest.json', '2.1.296/linux-x64-musl/claude', '2.1.296-beta.1/linux-x64-musl/claude',
      '2.1.296/linux-x64/claude', '2.1.296/darwin-arm64/claude', '2.1.296/linux-x64-musl/claude.sig', '2.1.296/linux-x64-musl/claude/x',
      '2.1/manifest.json', 'v2.1.296/manifest.json', '2.1.296/../../etc/passwd', '../latest', '%2e%2e/manifest.json',
      '2.1.296/manifest.json/', 'latest/x', '', '2.1.296', '99999.1.1/manifest.json',
    ];
    // Plain Node (vitest's polyfilled modules can't load server.mjs)
    const out = execFileSync('node', ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(server)});
      const paths = ${JSON.stringify(paths)};
      console.log(JSON.stringify({
        def: paths.map((p) => m.claudeReleaseRequest(p)),
        cfg: m.claudeReleasesConfig({ TABCOMPUTER_CLAUDE_PLATFORMS: 'linux-x64-musl, linux-x64,../x,evil' }).platforms,
        off: m.claudeReleasesConfig({ TABCOMPUTER_CLAUDE_RELEASES: '0' }).enabled,
      }));
      process.exit(0);`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const got = JSON.parse(out.trim().split('\n').pop()!);
    expect(Object.fromEntries(paths.map((p, i) => [p, got.def[i]]))).toEqual({
      'latest': { kind: 'latest' },
      '2.1.296/manifest.json': { kind: 'manifest', version: '2.1.296' },
      '2.1.296/linux-x64-musl/claude': { kind: 'binary', version: '2.1.296', platform: 'linux-x64-musl' },
      '2.1.296-beta.1/linux-x64-musl/claude': { kind: 'binary', version: '2.1.296-beta.1', platform: 'linux-x64-musl' },
      '2.1.296/linux-x64/claude': null, // not in the default platform list
      '2.1.296/darwin-arm64/claude': null,
      '2.1.296/linux-x64-musl/claude.sig': null,
      '2.1.296/linux-x64-musl/claude/x': null,
      '2.1/manifest.json': null,
      'v2.1.296/manifest.json': null,
      '2.1.296/../../etc/passwd': null,
      '../latest': null,
      '%2e%2e/manifest.json': null,
      '2.1.296/manifest.json/': null,
      'latest/x': null,
      '': null,
      '2.1.296': null,
      '99999.1.1/manifest.json': null,
    });
    expect(got.cfg).toEqual(['linux-x64-musl', 'linux-x64']); // unknown platforms dropped
    expect(got.off).toBe(false);
  });
});

describe('/claude-releases/', () => {
  it('serves latest and a manifest from upstream', async () => {
    const l = await get('/claude-releases/latest');
    expect(l.status).toBe(200);
    expect((await l.text()).trim()).toBe('1.0.0');
    expect(l.headers.get('cache-control')).toBe('no-cache');
    const m = await get('/claude-releases/1.0.0/manifest.json');
    expect(m.status).toBe(200);
    expect(JSON.parse(await m.text()).platforms['linux-x64-musl'].size).toBe(GOOD.length);
    expect(m.headers.get('cache-control')).toContain('immutable');
  });

  it('serves the binary immutable with its length, from upstream once (concurrent requests too)', async () => {
    const all = await Promise.all([1, 2, 3].map(() => get('/claude-releases/1.0.0/linux-x64-musl/claude')));
    for (const r of all) {
      expect(r.status).toBe(200);
      expect(r.headers.get('content-length')).toBe(String(GOOD.length));
      expect(r.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
      expect(r.headers.get('etag')).toBe(`"sha256-${sha256(GOOD)}"`);
      expect(sha256(Buffer.from(await r.arrayBuffer()))).toBe(sha256(GOOD));
    }
    expect(hitsFor('1.0.0/linux-x64-musl/claude')).toBe(1);
    const again = await get('/claude-releases/1.0.0/linux-x64-musl/claude');
    expect((await again.arrayBuffer()).byteLength).toBe(GOOD.length);
    expect(hitsFor('1.0.0/linux-x64-musl/claude')).toBe(1); // from disk
    expect(hitsFor('1.0.0/manifest.json')).toBe(1);
    const head = await get('/claude-releases/1.0.0/linux-x64-musl/claude', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(GOOD.length));
  });

  it('serves byte ranges of the binary (claude --vm reads only its JavaScript): a-b, a-, -n; 416 past the end', async () => {
    const url = '/claude-releases/1.0.0/linux-x64-musl/claude';
    const r = await get(url, { headers: { Range: 'bytes=100-199' } });
    expect(r.status).toBe(206);
    expect(r.headers.get('content-range')).toBe(`bytes 100-199/${GOOD.length}`);
    expect(r.headers.get('content-length')).toBe('100');
    expect(r.headers.get('accept-ranges')).toBe('bytes');
    expect(Buffer.from(await r.arrayBuffer()).equals(GOOD.subarray(100, 200))).toBe(true);
    const open = await get(url, { headers: { Range: `bytes=${GOOD.length - 10}-` } });
    expect(open.status).toBe(206);
    expect((await open.arrayBuffer()).byteLength).toBe(10);
    const suffix = await get(url, { headers: { Range: 'bytes=-64' } });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get('content-range')).toBe(`bytes ${GOOD.length - 64}-${GOOD.length - 1}/${GOOD.length}`);
    // an end past the file is cut to it; a start past it is a 416
    const cut = await get(url, { headers: { Range: `bytes=${GOOD.length - 5}-${GOOD.length + 1000}` } });
    expect((await cut.arrayBuffer()).byteLength).toBe(5);
    const past = await get(url, { headers: { Range: `bytes=${GOOD.length}-` } });
    expect(past.status).toBe(416);
    expect(past.headers.get('content-range')).toBe(`bytes */${GOOD.length}`);
    // several ranges, or another unit: the whole file, as a server may
    expect((await get(url, { headers: { Range: 'bytes=0-1,5-6' } })).status).toBe(200);
    expect((await get(url, { headers: { Range: 'items=0-1' } })).status).toBe(200);
    expect(hitsFor('1.0.0/linux-x64-musl/claude')).toBe(1); // all from disk
  });

  it('parseByteRange: one range of a file, or the whole file, or unsatisfiable', () => {
    const server = new URL('../../../server.mjs', import.meta.url).href;
    const cases = [[undefined, 10], ['bytes=2-4', 10], ['bytes=-3', 10], ['bytes=-30', 10], ['bytes=4-2', 10], ['bytes=-0', 10], ['bytes=10-', 10], ['bytes=3-', 10], ['bytes=-', 10]];
    // Plain Node, as above
    const out = execFileSync('node', ['--input-type=module', '-e', `
      const m = await import(${JSON.stringify(server)});
      console.log(JSON.stringify(${JSON.stringify(cases)}.map(([h, n]) => m.parseByteRange(h ?? undefined, n))));
      process.exit(0);`,
    ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    expect(JSON.parse(out.trim().split('\n').pop()!)).toEqual([
      null, { start: 2, end: 4 }, { start: 7, end: 9 }, { start: 0, end: 9 }, 'unsatisfiable', 'unsatisfiable', 'unsatisfiable', { start: 3, end: 9 }, null,
    ]);
  });

  it('refuses, and doesn\'t keep, a binary that fails the manifest\'s sha256', async () => {
    expect((await get('/claude-releases/1.0.1/linux-x64-musl/claude')).status).toBe(502);
    expect((await get('/claude-releases/1.0.1/linux-x64-musl/claude')).status).toBe(502);
    expect(hitsFor('1.0.1/linux-x64-musl/claude')).toBe(2); // not cached
  });

  it('404s a release without the platform, and an unknown version', async () => {
    expect((await get('/claude-releases/1.0.2/linux-x64-musl/claude')).status).toBe(404);
    expect((await get('/claude-releases/9.9.9/manifest.json')).status).toBe(404);
  });

  it('downloads at most 2 binaries at once (503 beyond, so the client uses the relay) and keeps the newest 3 versions', async () => {
    for (const v of ['2.0.0', '2.0.1', '2.0.2']) hold(`/rel/${v}/linux-x64-musl/claude`);
    // the manifests first, so the binary requests are what's pending
    for (const v of ['2.0.0', '2.0.1', '2.0.2']) expect((await get(`/claude-releases/${v}/manifest.json`)).status).toBe(200);
    const a = get('/claude-releases/2.0.0/linux-x64-musl/claude');
    const b = get('/claude-releases/2.0.1/linux-x64-musl/claude');
    for (let i = 0; i < 100 && hitsFor('2.0.1/linux-x64-musl/claude') + hitsFor('2.0.0/linux-x64-musl/claude') < 2; i++) await new Promise((r) => setTimeout(r, 20));
    const c = await get('/claude-releases/2.0.2/linux-x64-musl/claude');
    expect(c.status).toBe(503);
    expect(hitsFor('2.0.2/linux-x64-musl/claude')).toBe(0);
    // a second request for one in flight joins it instead
    const a2 = get('/claude-releases/2.0.0/linux-x64-musl/claude');
    for (const r of held.values()) r();
    for (const r of await Promise.all([a, b, a2])) {
      expect(r.status).toBe(200);
      expect((await r.arrayBuffer()).byteLength).toBe(GOOD.length);
    }
    expect(hitsFor('2.0.0/linux-x64-musl/claude')).toBe(1);
    // with nothing in flight it downloads again
    expect((await get('/claude-releases/2.0.2/linux-x64-musl/claude')).status).toBe(200);
    expect((await get('/claude-releases/2.0.3/linux-x64-musl/claude')).status).toBe(200);
    await new Promise((r) => setTimeout(r, 300)); // pruning runs after the response
    const versions = readdirSync(CACHE).filter((n) => /^\d/.test(n));
    expect(versions.length).toBe(3);
    expect(versions).toContain('2.0.3');
  });

  it('is not an open proxy', async () => {
    const before = hits.length;
    for (const p of [
      '/claude-releases/1.0.0/linux-x64/claude', // upstream has it, but it isn't an allowed platform
      '/claude-releases/1.0.0/linux-x64-musl/other',
      // (`..` and %2e%2e segments never get here: the URL parser removes them first)
      '/claude-releases/1.0.0%2f..%2f..%2fetc%2fpasswd/manifest.json',
      '/claude-releases/1.0.0/linux-x64-musl%2fclaude',
      '/claude-releases/https://evil.example/x',
      '/claude-releases/evil.example/manifest.json',
    ]) {
      expect((await get(p)).status, p).toBe(404);
    }
    expect((await get('/claude-releases/latest', { method: 'POST' })).status).toBe(404);
    expect(hits.length).toBe(before); // none of them reached upstream
  });
});
