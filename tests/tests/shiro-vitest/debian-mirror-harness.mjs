/**
 * For debian-mirror.test.ts: server.mjs's Debian mirror (createDebianMirror)
 * on a port of its own, over a stand-in upstream whose files are made as they
 * are read, so a large one is never held anywhere. Plain Node, because
 * vitest's polyfilled modules can't load server.mjs.
 *
 *   CACHE=dir [MAX_MB=n] [FILE_MAX_MB=n] [FETCHES=n] node debian-mirror-harness.mjs   → prints "PORT n"
 *   GET /debian/mirror/...      the route under test
 *   GET /__hits                 the upstream requests so far (paths)
 *   GET /__hold?f=PATH          the upstream stops half-way through PATH
 *   GET /__release?f=PATH       ... until this
 *   GET /__stats                { fetching, waiting, used } and what the upstream has sent of each held file
 *   GET /__advance?ms=N         the mirror's clock goes N ms ahead
 *
 * The upstream's files, by name (under /debian/pool/main/):
 *   NAME_<n>k.deb               n KB of one byte value, with a content-length
 *   NAME_<n>k.nolen.deb         the same without a content-length
 */
import { createServer } from 'node:http';

const m = await import(new URL('../../../server.mjs', import.meta.url).href);
const env = process.env;
const UP = 'https://upstream.test';
const hits = [];
const holds = new Map();
const releases = new Map();
const sent = new Map();
let ahead = 0;

const fetchFn = async (url) => {
  const path = String(url).startsWith(UP) ? String(url).slice(UP.length) : `?${url}`;
  hits.push(path);
  const size = /_(\d+)k(\.nolen)?\.deb$/.exec(path);
  if (!size) return new Response('', { status: 404, statusText: 'Not Found' });
  const total = Number(size[1]) * 1024;
  const chunk = Buffer.alloc(64 * 1024, path.length % 251);
  let at = 0;
  sent.set(path, 0);
  const body = new ReadableStream({
    async pull(controller) {
      if (at >= total / 2 && holds.has(path)) await holds.get(path);
      if (at >= total) return controller.close();
      const n = Math.min(chunk.length, total - at);
      controller.enqueue(n === chunk.length ? chunk : chunk.subarray(0, n));
      at += n;
      sent.set(path, at);
    },
  }, { highWaterMark: 1 });
  return new Response(body, { status: 200, headers: { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT', ...(size[2] ? {} : { 'content-length': String(total) }) } });
};

const logged = [];
const mirror = m.createDebianMirror({
  ...m.debianMirrorConfig({
    TABCOMPUTER_DEBIAN_MIRRORS: `deb.debian.org=${UP}`, TABCOMPUTER_DEBIAN_SNAPSHOT: `${UP}/snap/`, TABCOMPUTER_DEBIAN_CACHE: env.CACHE,
    TABCOMPUTER_DEBIAN_CACHE_MAX_MB: env.MAX_MB, TABCOMPUTER_DEBIAN_FILE_MAX_MB: env.FILE_MAX_MB, TABCOMPUTER_DEBIAN_FETCHES: env.FETCHES,
  }),
}, { fetchFn, log: (l) => logged.push(l), now: () => Date.now() + ahead });

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const f = url.searchParams.get('f');
  if (url.pathname === '/__hits') return json(hits);
  if (url.pathname === '/__hold') { holds.set(f, new Promise((r) => releases.set(f, r))); return json(true); }
  if (url.pathname === '/__release') { holds.delete(f); releases.get(f)?.(); return json(true); }
  if (url.pathname === '/__stats') return json({ ...mirror.stats(), sent: Object.fromEntries(sent), logged, config: { maxBytes: mirror.config.maxBytes, maxFileBytes: mirror.config.maxFileBytes, fetches: mirror.config.fetches, cacheDir: mirror.config.cacheDir } });
  if (url.pathname === '/__advance') { ahead += Number(url.searchParams.get('ms')); return json(ahead); }
  if (url.pathname.startsWith('/debian/mirror/')) return mirror.handle(req, res, url.pathname.slice('/debian/mirror/'.length));
  res.writeHead(404); res.end();
});
server.listen(0, '127.0.0.1', () => console.log(`PORT ${server.address().port}`));
