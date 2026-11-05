/**
 * `claude --vm`: native Claude Code's JavaScript, taken out of the binary the
 * user installed (or byte ranges of the site's copy: preinstall.ts) and laid
 * out for tabcomputer's node (docs/CLAUDE_VM.md). Done once per binary and
 * tabcomputer build, keyed by its sha256, under
 * ~/.cache/tabcomputer/claude-vm/<sha256>/nc-<build>/. The code is Anthropic's
 * from the user's own copy; tabcomputer never serves it.
 *
 * Bun's ES modules become node-compat's CommonJS with live bindings
 * (esm-live.ts liveModule): Bun's chunks assign exports in lazy initializers
 * and import each other in cycles, so an import must read its module's
 * current exports where it is used. That rewrite is exact for Bun's output:
 * its minifier (esbuild's renamer) never gives a nested binding the name of
 * a top-level one, so every identifier spelled like an import is that import.
 * The bundle's paths ("/$bunfs/root/…") become the layout's directory and
 * Bun-only syntax node's: `import.meta.require` is the module's require as
 * Bun has it (assets by their loader: bun-assets.json), `import.meta.dir` its
 * dirname. Each module reads `Bun` from its process's global (the launcher
 * puts the shim there; process-global.ts keeps it out of other processes).
 * zstd-compressed assets are stored decompressed.
 */
import { parseBunGraph, BunLoader, type BunGraph } from './bun-graph';
import { zstdDecodeAll } from '../commands/compress/zstd-codec';
import { adaptModule, vmModuleTransform, transformModules } from './vm-transform';
import { LAUNCHER_GLOBAL_NAMES } from './module-store';

export { adaptModule, vmModuleTransform };

export const VM_CACHE = '.cache/tabcomputer/claude-vm';
/** Bumped when the layout written here changes: an older extraction is redone */
export const VM_LAYOUT = 9;

export interface VmFs {
  readFile(path: string, enc?: string): Promise<any>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: Date | number }>;
}

const BUNFS = '/$bunfs/root/';

/** The launcher: the process's Bun, then Claude Code's entry. Modules already compiled by the warm-up are reused. */
export function launcherSource(): string {
  return [
    '// tabcomputer: claude --vm (src/claude-vm/extract.ts, module-store.ts)',
    // (TABCOMPUTER_VM_TRACE: claude.ts vmTracer)
    "const __vmTrace = process.env.TABCOMPUTER_VM_TRACE ? (p) => { try { require('fs').appendFileSync(process.env.TABCOMPUTER_VM_TRACE, (performance.timeOrigin + performance.now()).toFixed(1) + ' ' + p + '\\n'); } catch {} } : () => {};",
    "__vmTrace('launcher');",
    "const vm = require('tabcomputer:claude-vm');",
    "const fs = require('fs');",
    "const [{ createBun }, store] = await Promise.all([vm.load(), vm.modules()]);",
    "const assets = JSON.parse(fs.readFileSync(__dirname + '/bun-assets.json', 'utf8'));",
    "globalThis.Bun = createBun({ fs, process: process, childProcess: require('child_process'), net: require('net'), http: require('http'), Buffer: Buffer, assets: assets, main: __dirname + '/cli.js', transform: vm.transformSync });",
    "const bytes = await store.loadModules(__dirname, () => fs.readFileSync(__dirname + '/modules.js'));",
    "const index = store.cachedIndex(__dirname) || JSON.parse(fs.readFileSync(__dirname + '/modules.json', 'utf8'));",
    "__vmTrace('modules read');",
    `const globals = { ${LAUNCHER_GLOBAL_NAMES.map((n) => `${n}: typeof ${n} === 'undefined' ? undefined : ${n}`).join(', ')} };`,
    'const loader = store.createModuleLoader({ dir: __dirname, bytes, index, outer: require, globals, live: require.live, settle: require.settle });',
    "if (process.env.TABCOMPUTER_VM_TRACE) for (const s of [1, 3, 10]) setTimeout(() => { const t = loader.stats(); __vmTrace(`modules compiled after ${s} s: ${t.compiled} of ${t.modules}, ${(t.compiledBytes / 1048576).toFixed(1)} of ${(t.bytes / 1048576).toFixed(1)} MB`); }, s * 1000).unref?.();",
    "loader.require(__dirname)('./cli.js');",
    "__vmTrace('cli.js returned');",
    "process.stdout.write('', () => __vmTrace('first stdout flush'));",
    '',
  ].join('\n');
}

/**
 * `ws` (built into Bun, so not in the bundle): a client over the page's
 * WebSocket. No server; Claude Code starts without one.
 *
 * The page's WebSocket sends no headers, and wss://api.anthropic.com wants
 * `Authorization` (the voice stream): those connections go through the
 * page's server (server.mjs `/api/ws-proxy`), which opens the real one with
 * the URL, headers and protocols sent here as the first message (not in the
 * URL: tokens stay out of access logs), answers `{"type":"open"}` (or why
 * not), and then passes every frame both ways. `TABCOMPUTER_VM_WS_PROXY`
 * names another origin for that route (tests). Private network mode
 * (net-mode.ts) has no such route, so voice input is off there.
 */
export function wsShimSource(): string {
  // (no backslashes, backticks or dollar-braces below: this is a template literal)
  return `const { EventEmitter } = require('events');
const PROXIED = /^wss:[/][/]api[.]anthropic[.]com(:443)?[/]/i;
function proxyUrl() {
  if (process.env.TABCOMPUTER_NETWORK_MODE === 'private' && !process.env.TABCOMPUTER_VM_WS_PROXY) return null;
  let o = process.env.TABCOMPUTER_VM_WS_PROXY || '';
  if (!o) { try { o = require('tabcomputer:claude-vm').origin() || ''; } catch (e) { o = ''; } }
  return o ? o.replace(/[/]+$/, '').replace(/^http/, 'ws') + '/api/ws-proxy' : null;
}
function headersOf(opts) {
  const h = {}, src = opts && opts.headers;
  if (!src || typeof src !== 'object') return h;
  if (typeof src.forEach === 'function' && !Array.isArray(src)) { src.forEach((v, k) => { h[k] = String(v); }); return h; }
  for (const k of Object.keys(src)) if (src[k] != null) h[k] = Array.isArray(src[k]) ? src[k].join(', ') : String(src[k]);
  return h;
}
class WebSocket extends EventEmitter {
  constructor(url, protocols, opts) {
    super();
    if (protocols && !Array.isArray(protocols) && typeof protocols === 'object') { opts = protocols; protocols = undefined; }
    this.url = String(url);
    this._state = 0;
    this._protocol = '';
    const via = PROXIED.test(this.url) ? proxyUrl() : null;
    let ws;
    try { ws = this._ws = new globalThis.WebSocket(via || this.url, via ? undefined : protocols); } catch (e) {
      this._ws = null;
      Promise.resolve().then(() => { this._error(e); this._closed(1006, ''); });
      return;
    }
    ws.binaryType = 'arraybuffer';
    let hello = !via;
    ws.onopen = () => {
      if (!via) return this._opened(ws.protocol);
      ws.send(JSON.stringify({ url: this.url, headers: headersOf(opts), protocols: protocols == null ? [] : [].concat(protocols) }));
    };
    ws.onmessage = (e) => {
      if (!hello) {
        hello = true;
        let m = {};
        try { m = JSON.parse(String(e.data)); } catch (_) { /* not the proxy's */ }
        if (m.type === 'open') return this._opened(m.protocol || '');
        if (m.type === 'unexpected-response') return this._unexpected(m);
        this._failure = m.message || 'ws-proxy refused the connection';
        return;
      }
      if (this._state !== 1) return;
      const d = typeof e.data === 'string' ? e.data : Buffer.from(e.data);
      this.emit('message', d, typeof e.data !== 'string');
      if (this.onmessage) this.onmessage({ data: d, target: this });
    };
    ws.onerror = () => { if (!this._rejected && !this._errored) this._error(new Error(this._failure || 'WebSocket error')); };
    ws.onclose = (e) => {
      if (!this._everOpen) {
        if (!this._rejected && !this._errored) this._error(new Error(this._failure || 'WebSocket error'));
        return this._closed(1006, '');
      }
      this._closed(e.code, e.reason || '');
    };
  }
  _opened(protocol) {
    if (this._state !== 0) return;
    this._state = 1; this._everOpen = true; this._protocol = protocol || '';
    this.emit('open');
    if (this.onopen) this.onopen({ target: this });
  }
  _error(err) {
    this._errored = true;
    this.emit('error', err);
    if (this.onerror) this.onerror({ error: err, message: err.message, target: this });
  }
  _closed(code, reason) {
    if (this._done) return;
    this._done = true; this._state = 3;
    this.emit('close', code, Buffer.from(reason || ''));
    if (this.onclose) this.onclose({ code: code, reason: reason, target: this });
  }
  // as ws: the upgrade was answered with an HTTP status (401, 403, ...)
  _unexpected(m) {
    this._rejected = true;
    this._state = 2;
    const res = Object.assign(new EventEmitter(), { statusCode: m.status || 0, statusMessage: m.statusText || '', headers: m.headers || {}, resume() {}, destroy() {} });
    const req = { destroy() {}, abort() {} };
    if (this.listenerCount('unexpected-response') > 0) this.emit('unexpected-response', req, res);
    else this._error(new Error('Unexpected server response: ' + res.statusCode));
  }
  get readyState() { return this._state; }
  get protocol() { return this._protocol; }
  get bufferedAmount() { return this._ws ? this._ws.bufferedAmount : 0; }
  send(data, opts, cb) {
    if (typeof opts === 'function') { cb = opts; opts = undefined; }
    if (this._state !== 1) {
      const err = new Error('WebSocket is not open: readyState ' + this._state);
      if (this._state === 0) throw err;
      if (cb) cb(err);
      return;
    }
    if (opts && opts.binary === false && typeof data !== 'string') data = Buffer.from(data).toString();
    try { this._ws.send(data); if (cb) cb(); } catch (e) { if (cb) cb(e); }
  }
  close(code, reason) {
    if (this._state >= 2 || !this._ws) return;
    this._state = 2;
    try { if (code === 1000 || (code >= 3000 && code <= 4999)) this._ws.close(code, reason); else this._ws.close(); } catch (e) { this._ws.close(); }
  }
  terminate() { if (this._ws && this._state < 3) { this._state = 2; this._ws.close(); } }
  ping() {} pong() {}
}
WebSocket.CONNECTING = 0; WebSocket.OPEN = 1; WebSocket.CLOSING = 2; WebSocket.CLOSED = 3;
class WebSocketServer extends EventEmitter { constructor() { super(); throw new Error('ws: no WebSocket server in claude --vm yet'); } }
module.exports = WebSocket;
module.exports.WebSocket = WebSocket;
module.exports.WebSocketServer = module.exports.Server = WebSocketServer;
module.exports.default = WebSocket;
`;
}

const isZstd = (b: Uint8Array) => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VmLayout { dir: string; launcher: string; sha256: string; extracted: boolean }

const buildKey = (): string => {
  const sha = typeof __BUILD_SHA__ === 'string' && __BUILD_SHA__ ? __BUILD_SHA__ : 'dev';
  let h = 0x811c9dc5;
  for (const c of `${sha}:${VM_LAYOUT}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/** Where a layout for this Claude Code sha and this tabcomputer build is written */
export function claudeVmLayoutDir(home: string, sha: string): string {
  return `${home}/${VM_CACHE}/${sha}/nc-${buildKey()}`;
}

export interface RenderedLayoutFile { rel: string; bytes: Uint8Array }

/**
 * The files of a layout for `dir` (the real directory, or a placeholder the
 * pack substitutes later). `yieldMs` 0 keeps a Node packer in a tight loop.
 */
export async function renderVmLayout(graph: BunGraph, dir: string, onProgress?: (done: number, total: number) => void, yieldMs = 50): Promise<{ files: RenderedLayoutFile[]; modules: Uint8Array }> {
  const enc = new TextEncoder();
  const js: { rel: string; contents: Uint8Array }[] = [];
  const files: RenderedLayoutFile[] = [];
  const assets: Record<string, number> = {};
  for (const m of graph.modules) {
    if (!m.name.startsWith(BUNFS)) continue;
    const rel = m === graph.entry ? 'cli.js' : m.name.slice(BUNFS.length);
    if (m.loader === BunLoader.js) { js.push({ rel, contents: m.contents }); continue; }
    const bytes = isZstd(m.contents) ? zstdDecodeAll(m.contents) : m.contents.slice();
    files.push({ rel, bytes });
    assets[`${dir}/${rel}`] = m.loader;
  }
  const parts = await transformModules(dir, js.map((m) => m.contents), (n) => onProgress?.(n, js.length), yieldMs);
  const index: Record<string, [number, number]> = {};
  let size = 0;
  js.forEach((m, k) => { index[`${dir}/${m.rel}`] = [size, parts[k].length]; size += parts[k].length; });
  const modules = new Uint8Array(size);
  for (let k = 0, at = 0; k < parts.length; at += parts[k].length, k++) modules.set(parts[k], at);
  files.push(
    { rel: 'modules.js', bytes: modules },
    { rel: 'modules.json', bytes: enc.encode(JSON.stringify(index)) },
    { rel: 'bun-assets.json', bytes: enc.encode(JSON.stringify(assets)) },
    { rel: 'package.json', bytes: enc.encode(JSON.stringify({ type: 'commonjs' })) },
    { rel: 'vm-main.mjs', bytes: enc.encode(launcherSource()) },
    { rel: 'node_modules/ws/index.js', bytes: enc.encode(wsShimSource()) },
    { rel: 'node_modules/ws/package.json', bytes: enc.encode(JSON.stringify({ name: 'ws', main: 'index.js' })) },
  );
  return { files, modules };
}

/**
 * The layout for the binary at `binPath`, made first if needed, under
 * ~/.cache/tabcomputer/claude-vm/<sha256>/nc-<build>/ (once per Claude Code
 * version and tabcomputer build: node-compat's transforms are this build's):
 *   modules.js    every JS module, transformed for node-compat, one after another
 *                 (UTF-8); modules.json has each one's [offset, length] by path.
 *                 The launcher compiles a module when it is first required
 *                 (module-store.ts); its bytes are also in CacheStorage.
 *   the assets    by their paths, as Bun's file system had them (bun-assets.json)
 *   vm-main.mjs   the launcher
 * `say` reports progress.
 */
export async function ensureClaudeVm(fs: VmFs, binPath: string, home: string, say: (s: string) => void = () => {}): Promise<VmLayout> {
  const root = `${home}/${VM_CACHE}`;
  // (path, size, mtime) → sha256, so a launch doesn't hash 250 MB every time
  const indexPath = `${root}/index.json`;
  let index: Record<string, { size: number; mtime: number; sha256: string }> = {};
  try { index = JSON.parse(await fs.readFile(indexPath, 'utf8')) ?? {}; } catch { /* none yet */ }
  const st = await fs.stat(binPath);
  const mtime = typeof st.mtime === 'number' ? st.mtime : st.mtime.getTime();
  let bin: Uint8Array | null = null;
  let sha = index[binPath]?.size === st.size && index[binPath]?.mtime === mtime ? index[binPath].sha256 : '';
  if (!sha) {
    say(`claude --vm: reading the native build (${Math.round(st.size / 2 ** 20)} MB)...\n`);
    bin = await fs.readFile(binPath) as Uint8Array;
    sha = await sha256Hex(bin);
  }
  const layout = await ensureClaudeVmLayout(fs, sha, home, async () => parseBunGraph(bin ??= await fs.readFile(binPath) as Uint8Array), say);
  index[binPath] = { size: st.size, mtime, sha256: sha };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');
  return layout;
}

/** Layouts being made, by sha256: a boot preinstall and a `claude` typed meanwhile share one */
const making = new Map<string, Promise<VmLayout>>();

/** Whether the layout for `sha` is being made now (by the boot's preinstall, say) */
export const layoutInProgress = (home: string, sha: string): boolean => making.has(`${home}\0${sha}`);

/**
 * The layout of the binary whose sha256 is `sha` (above), made first if needed;
 * `graph` gives its module graph (from the whole file, or from byte ranges of
 * the server's copy: remote-graph.ts) and is called only when stage 1 is to do.
 */
export function ensureClaudeVmLayout(fs: VmFs, sha: string, home: string, graph: () => Promise<BunGraph>, say: (s: string) => void = () => {}): Promise<VmLayout> {
  const key = `${home}\0${sha}`;
  let p = making.get(key);
  if (!p) {
    p = makeLayout(fs, sha, home, graph, say).finally(() => making.delete(key));
    making.set(key, p);
  }
  return p;
}

async function makeLayout(fs: VmFs, sha: string, home: string, loadGraph: () => Promise<BunGraph>, say: (s: string) => void): Promise<VmLayout> {
  const root = `${home}/${VM_CACHE}`;
  const t0 = Date.now();
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  const base = `${root}/${sha}`;
  const dir = claudeVmLayoutDir(home, sha);
  const launcher = `${dir}/vm-main.mjs`;
  const made = new Set<string>();
  const mkdirOnce = async (d: string) => { if (!made.has(d)) { made.add(d); await fs.mkdir(d, { recursive: true }); } };
  const readText = async (p: string) => { try { return await fs.readFile(p, 'utf8') as string; } catch { return null; } };
  if ((await readText(`${dir}/complete`))?.trim() === String(VM_LAYOUT)) return { dir, launcher, sha256: sha, extracted: false };

  const graph = await loadGraph();
  say('claude --vm: preparing Claude Code\'s JavaScript (once per version and tabcomputer build)...\n');
  const { putModules } = await import('./module-store');
  let shown = 0;
  const rendered = await renderVmLayout(graph, dir, (n, total) => {
    if (n - shown < 500 && n < total) return;
    shown = n;
    say(`  ${n}/${total} modules (${secs()})\n`);
  });
  for (const f of rendered.files) {
    const path = `${dir}/${f.rel}`;
    await mkdirOnce(path.slice(0, path.lastIndexOf('/')));
    await fs.writeFile(path, f.bytes);
  }
  // (the launcher's fast read; without it, it reads modules.js and puts it there itself)
  await putModules(dir, rendered.modules).catch(() => {});
  await fs.writeFile(`${dir}/complete`, String(VM_LAYOUT));
  say(`  ready (${secs()}); starting Claude Code\n`);
  // an earlier build's tree, and an earlier layout's cjs/ stage, are no longer used
  for (const name of await (fs as any).readdir?.(base).catch?.(() => []) ?? []) {
    if ((name.startsWith('nc-') || name === 'cjs') && `${base}/${name}` !== dir) await (fs as any).rm?.(`${base}/${name}`, { recursive: true, force: true }).catch?.(() => {});
  }
  return { dir, launcher, sha256: sha, extracted: true };
}
