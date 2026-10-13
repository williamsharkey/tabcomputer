/**
 * For pyodide-mirror.test.ts: server.mjs's Pyodide route (createPyodideMirror)
 * on a port of its own, over a made-up distribution and a stand-in upstream.
 * Plain Node, because vitest's polyfilled modules can't load server.mjs, and
 * the real route's files are pinned by sha256.
 *
 *   CACHE=dir [MAX_MB=n] [DEAD=1] [OFF=1] node pyodide-mirror-harness.mjs   → prints "PORT n"
 *   GET /__hits                 the upstream requests so far (file names)
 *   GET /__hold?f=NAME          upstream answers for NAME wait
 *   GET /__release?f=NAME       ... until this
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';

const m = await import(new URL('../../../server.mjs', import.meta.url).href);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

export const VERSION = '9.9.9';
const wheel = Buffer.alloc(200_000, 3);
const files = {
  'pyodide.mjs': Buffer.from('export const loadPyodide = 1;\n'.repeat(400)),
  'pyodide.asm.wasm': Buffer.concat([Buffer.from([0, 0x61, 0x73, 0x6d]), Buffer.alloc(60_000, 9)]),
  'python_stdlib.zip': Buffer.alloc(5000, 4),
  'numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl': wheel,
  'six-1.17.0-py2.py3-none-any.whl': Buffer.alloc(900, 5),
  // what the upstream has is not what the lock says
  'tampered-1.0-py3-none-any.whl': Buffer.alloc(700, 6),
  // the upstream has it; the lock does not name it
  'unlisted-1.0-py3-none-any.whl': Buffer.alloc(700, 7),
};
const pkg = (name, file, sha = sha256(files[file])) => [name, { name, version: '1', file_name: file, imports: [name], depends: [], sha256: sha }];
files['pyodide-lock.json'] = Buffer.from(JSON.stringify({
  info: { python: '3.13.2' },
  packages: Object.fromEntries([
    pkg('numpy', 'numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl'),
    pkg('six', 'six-1.17.0-py2.py3-none-any.whl'),
    pkg('tampered', 'tampered-1.0-py3-none-any.whl', sha256(Buffer.from('what the lock expects'))),
    // a name no request can spell
    ['evil', { name: 'evil', version: '1', file_name: '../../outside.whl', imports: [], depends: [], sha256: sha256(wheel) }],
  ]),
}));
const core = ['pyodide-lock.json', 'pyodide.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip'];

const hits = [];
const holds = new Map();
const releases = new Map();
const prefix = `https://upstream.test/pyodide/v${VERSION}/full/`;
const fetchFn = async (url) => {
  if (process.env.DEAD) throw new Error('upstream is down');
  const name = String(url).startsWith(prefix) ? String(url).slice(prefix.length) : `?${url}`;
  hits.push(name);
  await holds.get(name);
  const body = files[name];
  return body ? new Response(body, { status: 200 }) : new Response('', { status: 404 });
};

const mirror = m.createPyodideMirror({
  ...m.pyodideMirrorConfig({
    TABCOMPUTER_PYODIDE: process.env.OFF ? '0' : '1',
    TABCOMPUTER_PYODIDE_UPSTREAM: 'https://upstream.test/pyodide/',
    TABCOMPUTER_PYODIDE_CACHE: process.env.CACHE,
    TABCOMPUTER_PYODIDE_CACHE_MAX_MB: process.env.MAX_MB,
  }),
  dists: { [VERSION]: Object.fromEntries(core.map((f) => [f, sha256(files[f])])) },
}, { fetchFn, log: () => {} });

const server = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const f = u.searchParams.get('f');
  if (u.pathname === '/__hits') return res.end(JSON.stringify(hits));
  if (u.pathname === '/__hold') { holds.set(f, new Promise((r) => releases.set(f, r))); return res.end('ok'); }
  if (u.pathname === '/__release') { releases.get(f)?.(); holds.delete(f); return res.end('ok'); }
  const what = m.pyodideRequest(u.pathname);
  if (!what) { res.writeHead(404, { 'x-not-the-route': '1' }); return res.end(); }
  mirror.handle(req, res, what, { 'x-script-header': '1' });
});
server.listen(0, '127.0.0.1', () => console.log(`PORT ${server.address().port}`));
