/**
 * `claude --vm`: native Claude Code's JavaScript, taken out of the binary the
 * user installed and laid out as files tabcomputer's node runs
 * (docs/CLAUDE_VM.md). Done once per binary, keyed by its sha256, under
 * ~/.cache/tabcomputer/claude-vm/<sha256>/. The files are Anthropic's code
 * from the user's own copy; tabcomputer never serves them.
 *
 * The bundle's ES modules import each other as "/$bunfs/root/…": that prefix
 * becomes the cache directory. Bun-only syntax becomes node's:
 * `import.meta.require` is the module's require as Bun has it (assets by
 * their loader: bun-assets.json), `import.meta.dir` its dirname. Each module reads `Bun` from its process's global (the launcher
 * puts the shim there; process-global.ts keeps it out of other processes).
 * zstd-compressed assets are stored decompressed.
 */
import { parseBunGraph, BunLoader } from './bun-graph';
import { zstdDecodeAll } from '../commands/compress/zstd-codec';

export const VM_CACHE = '.cache/tabcomputer/claude-vm';
/** Bumped when the layout written here changes: an older extraction is redone */
export const VM_LAYOUT = 8;

export interface VmFs {
  readFile(path: string, enc?: string): Promise<any>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  stat(path: string): Promise<{ size: number; mtime: Date | number }>;
}

const BUNFS = '/$bunfs/root/';

/**
 * One extracted JS module's text with Bun's names made node's, before it
 * becomes CommonJS (toCommonJS): the bundle's paths, Bun's require (an
 * embedded asset gives its text or its path, by its loader: bun/index.ts),
 * and import.meta, which CommonJS doesn't have.
 */
export function adaptModule(source: string, dir: string): string {
  let s = source.split(BUNFS).join(dir + '/');
  s = s.replace(/\bimport\.meta\.require\b/g, 'Bun.__require(require)');
  s = s.replace(/\bimport\.meta\.(?:dirname|dir)\b/g, '__dirname');
  s = s.replace(/\bimport\.meta\.filename\b/g, '__filename');
  s = s.replace(/\bimport\.meta\.url\b/g, 'require("url").pathToFileURL(__filename).href');
  // (the first line stays first: `// @bun @bytecode` is a pragma comment)
  return 'var Bun = globalThis.Bun;\n' + s;
}

/**
 * An adapted ES module as CommonJS, with esbuild (the page's): imports read
 * their module's exports where they are used, as ES module bindings are live.
 * Bun's chunks assign exports in lazy initializers and import each other in
 * cycles; node-compat's own transform copies an import once, when it runs, so
 * those stayed undefined. Strict, as an ES module is.
 */
export async function toCommonJS(esbuild: { transform(code: string, opts: object): Promise<{ code: string }> }, code: string): Promise<string> {
  const r = await esbuild.transform(code, { format: 'cjs', loader: 'js', target: 'esnext', logLevel: 'silent', minifyWhitespace: true });
  return '"use strict";' + r.code;
}

/** The launcher: the process's Bun, then Claude Code's entry. */
// (MODULE_PARAMS from console on: the launcher's own, or undefined where it has none)
const LAUNCHER_PASSES = [
  ...['console', 'process', 'global', 'Buffer'].map((n) => `typeof ${n} === 'undefined' ? undefined : ${n}`),
  "{ url: 'file://' + __dirname + '/bundle.js', dirname: __dirname, filename: __dirname + '/bundle.js' }", 'm', 'require',
  ...['__dynamic_import', '__shiro_require_ready', 'globalThis', 'Function', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'setImmediate', 'clearImmediate', 'self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope'].map((n) => `typeof ${n} === 'undefined' ? undefined : ${n}`),
].join(', ');

export function launcherSource(): string {
  return [
    '// tabcomputer: claude --vm (src/claude-vm/extract.ts)',
    "const { createBun } = await require('tabcomputer:claude-vm').load();",
    "const assets = JSON.parse(require('fs').readFileSync(__dirname + '/bun-assets.json', 'utf8'));",
    "globalThis.Bun = createBun({ fs: require('fs'), process: process, childProcess: require('child_process'), net: require('net'), http: require('http'), Buffer: Buffer, assets: assets, main: __dirname + '/cli.js' });",
    // bundle.js through V8's code cache when a service worker serves /__vm/ (code-cache.ts):
    // the parameters node-compat gives a module, the bundle's own module first
    "const { loadCompiled } = await require('tabcomputer:claude-vm').codeCache();",
    "const bundle = process.env.TABCOMPUTER_VM_CODECACHE === '0' ? null : await loadCompiled(__dirname, () => require('fs').readFileSync(__dirname + '/bundle.js', 'utf8')).catch(() => null);",
    'if (bundle) {',
    "  const file = __dirname + '/bundle.js';",
    '  const m = { exports: {}, id: file, filename: file, loaded: false, children: [] };',
    `  bundle.apply(m.exports, [m, m.exports, require, file, __dirname, ${LAUNCHER_PASSES}]);`,
    "} else require('./bundle.js');",
    '',
  ].join('\n');
}

/**
 * `ws` (built into Bun, so not in the bundle): a client over the page's
 * WebSocket. No server; Claude Code starts without one.
 */
export function wsShimSource(): string {
  return `const { EventEmitter } = require('events');
class WebSocket extends EventEmitter {
  constructor(url, protocols, opts) {
    super();
    if (protocols && !Array.isArray(protocols) && typeof protocols === 'object') protocols = undefined;
    const ws = this._ws = new globalThis.WebSocket(String(url), protocols);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => { this.emit('open'); this.onopen?.({ target: this }); };
    ws.onmessage = (e) => { const d = typeof e.data === 'string' ? e.data : Buffer.from(e.data); this.emit('message', d, typeof e.data !== 'string'); this.onmessage?.({ data: d, target: this }); };
    ws.onerror = () => { const err = new Error('WebSocket error'); this.emit('error', err); this.onerror?.({ error: err, message: err.message, target: this }); };
    ws.onclose = (e) => { this.emit('close', e.code, Buffer.from(e.reason || '')); this.onclose?.({ code: e.code, reason: e.reason, target: this }); };
  }
  get readyState() { return this._ws.readyState; }
  get protocol() { return this._ws.protocol; }
  send(data, opts, cb) { if (typeof opts === 'function') cb = opts; try { this._ws.send(data); cb?.(); } catch (e) { cb?.(e); } }
  close(code, reason) { this._ws.close(code, reason); }
  terminate() { this._ws.close(); }
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

/**
 * bundle.js: every module of the tree as a function in one table, with a
 * CommonJS loader over it, in one file. One read and one compile instead of
 * 2345 (a start read each through the kernel); anything outside the table
 * (node's builtins, ws, the assets) is the process's own require.
 */
export function bundleHeader(dir: string): string {
  return `const __vmMods = Object.create(null), __vmCache = Object.create(null), __vmOuter = require;
const __vmDir = (p) => p.slice(0, p.lastIndexOf('/')) || '/';
const __vmKey = (from, id) => {
  if (typeof id !== 'string') return null;
  let p = id.startsWith('/') ? id : id.startsWith('./') || id.startsWith('../') ? require('path').resolve(from, id) : null;
  if (p === null) return null;
  return __vmMods[p] ? p : __vmMods[p + '.js'] ? p + '.js' : null;
};
const __vmRequire = (from) => {
  const r = (id) => {
    const key = __vmKey(from, id);
    if (key === null) return __vmOuter(id);
    let m = __vmCache[key];
    if (m) return m.exports;
    m = __vmCache[key] = { exports: {}, id: key, filename: key, loaded: false, children: [] };
    const dir = __vmDir(key);
    __vmMods[key].call(m.exports, m, m.exports, __vmRequire(dir), key, dir, __vmImport(dir));
    m.loaded = true;
    return m.exports;
  };
  r.resolve = (id) => __vmKey(from, id) ?? __vmOuter.resolve(id);
  r.cache = __vmCache;
  return r;
};
// import(): the module's exports, as Bun's ES modules give their namespace
const __vmImport = (from) => (id) => Promise.resolve().then(() => {
  const e = __vmRequire(from)(String(id).replace(/^file:\\/\\//, ''));
  return e && (e.__esModule || typeof e !== 'object') ? (e.__esModule ? e : { default: e }) : Object.assign({ default: e }, e);
});
`;
}

/** One module of bundle.js */
export function bundleEntry(path: string, code: string): string {
  return `__vmMods[${JSON.stringify(path)}] = function (module, exports, require, __filename, __dirname, __dynamic_import) {\n${code}\n};\n`;
}

const isZstd = (b: Uint8Array) => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VmLayout { dir: string; launcher: string; sha256: string; extracted: boolean }

/** Where stage 1 has the bundle's own directory; stage 2 puts the real one there */
const ROOT_TOKEN = '/__tabcomputer_vm_root__';

const buildKey = (): string => {
  const sha = typeof __BUILD_SHA__ === 'string' && __BUILD_SHA__ ? __BUILD_SHA__ : 'dev';
  let h = 0x811c9dc5;
  for (const c of `${sha}:${VM_LAYOUT}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/**
 * The layout for the binary at `binPath`, made first if needed, in two stages
 * under ~/.cache/tabcomputer/claude-vm/<sha256>/:
 *   cjs/          once per Claude Code version: the bundle's files, its ES
 *                 modules as CommonJS (toCommonJS: esbuild, the slow part)
 *   nc-<build>/   once per tabcomputer build: what runs. node-compat's own
 *                 transforms are done here, not at every launch (64 MB of
 *                 code: ~4 s a start), and the files say so (PRETRANSFORMED)
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
  // (a first launch takes ~40 s: a line per stage so it doesn't look hung)
  const t0 = Date.now();
  const secs = () => `${((Date.now() - t0) / 1000).toFixed(1)} s`;
  if (!sha) {
    say(`claude --vm: reading the native build (${Math.round(st.size / 2 ** 20)} MB)...\n`);
    bin = await fs.readFile(binPath) as Uint8Array;
    sha = await sha256Hex(bin);
  }
  const base = `${root}/${sha}`;
  const cjs = `${base}/cjs`;
  const dir = `${base}/nc-${buildKey()}`;
  const launcher = `${dir}/vm-main.mjs`;
  const made = new Set<string>();
  const mkdirOnce = async (d: string) => { if (!made.has(d)) { made.add(d); await fs.mkdir(d, { recursive: true }); } };
  const readText = async (p: string) => { try { return await fs.readFile(p, 'utf8') as string; } catch { return null; } };
  let extracted = false;

  // Stage 1: the bundle out of the binary, as CommonJS
  if ((await readText(`${cjs}/complete`))?.trim() !== String(VM_LAYOUT)) {
    say('claude --vm: extracting Claude Code\'s JavaScript from the native build (once per version)...\n');
    bin ??= await fs.readFile(binPath) as Uint8Array;
    const graph = parseBunGraph(bin);
    const dec = new TextDecoder();
    const files: { rel: string; loader: number }[] = [];
    const { withEsbuild } = await import('../commands/build');
    let n = 0;
    const jsCount = graph.modules.filter((m) => m.loader === BunLoader.js).length;
    say(`  ${jsCount} modules, ${graph.modules.length - jsCount} assets; converting to CommonJS (${secs()})\n`);
    await withEsbuild(async (esbuild) => {
      for (const m of graph.modules) {
        if (!m.name.startsWith(BUNFS)) continue;
        const rel = m === graph.entry ? 'cli.js' : m.name.slice(BUNFS.length);
        const path = `${cjs}/${rel}`;
        await mkdirOnce(path.slice(0, path.lastIndexOf('/')));
        files.push({ rel, loader: m.loader });
        if (m.loader === BunLoader.js) {
          await fs.writeFile(path, await toCommonJS(esbuild as any, adaptModule(dec.decode(m.contents), ROOT_TOKEN)));
          if (++n % 500 === 0) say(`  ${n}/${jsCount} modules (${secs()})\n`);
        }
        // zstd assets (skills, docs; the code checks the magic, not the name) stored
        // decompressed: node's sync reads find text in its cache, and no zstd at run time
        else if (isZstd(m.contents)) await fs.writeFile(path, zstdDecodeAll(m.contents));
        else await fs.writeFile(path, m.contents.slice());
      }
    });
    await fs.writeFile(`${cjs}/files.json`, JSON.stringify(files));
    await fs.writeFile(`${cjs}/complete`, String(VM_LAYOUT));
    say(`  extracted (${secs()})\n`);
    extracted = true;
  }

  // Stage 2: what runs, transformed for this build's node
  if ((await readText(`${dir}/complete`))?.trim() !== String(VM_LAYOUT)) {
    say('claude --vm: preparing Claude Code for this tabcomputer build...\n');
    const files: { rel: string; loader: number }[] = JSON.parse((await readText(`${cjs}/files.json`)) ?? '[]');
    const [{ transformESModules }, { carryAsyncContext, carriesAsyncContext }, { PRETRANSFORMED }] = await Promise.all([
      import('../commands/jseval/module-transform'), import('../node-compat/async-context'), import('../node-compat/require'),
    ]);
    const assets: Record<string, number> = {};
    const bundle: string[] = [PRETRANSFORMED, bundleHeader(dir)];
    const jsCount = files.filter((f) => f.loader === BunLoader.js).length;
    let n = 0;
    for (const f of files) {
      const path = `${dir}/${f.rel}`;
      await mkdirOnce(path.slice(0, path.lastIndexOf('/')));
      if (f.loader === BunLoader.js) {
        const code = ((await readText(`${cjs}/${f.rel}`)) ?? '').split(ROOT_TOKEN + '/').join(dir + '/');
        const done = transformESModules(code, carriesAsyncContext(code) ? carryAsyncContext : undefined);
        await fs.writeFile(path, PRETRANSFORMED + done);
        bundle.push(bundleEntry(path, done));
        if (++n % 500 === 0) say(`  ${n}/${jsCount} modules (${secs()})\n`);
      } else {
        assets[path] = f.loader;
        await fs.writeFile(path, await fs.readFile(`${cjs}/${f.rel}`) as Uint8Array);
      }
    }
    await mkdirOnce(`${dir}/node_modules/ws`);
    await fs.writeFile(`${dir}/node_modules/ws/index.js`, wsShimSource());
    await fs.writeFile(`${dir}/node_modules/ws/package.json`, JSON.stringify({ name: 'ws', main: 'index.js' }));
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({ type: 'commonjs' }));
    await fs.writeFile(`${dir}/bun-assets.json`, JSON.stringify(assets));
    bundle.push(`__vmRequire(${JSON.stringify(dir)})(${JSON.stringify(dir + '/cli.js')});\n`);
    await fs.writeFile(`${dir}/bundle.js`, bundle.join(''));
    await fs.writeFile(launcher, launcherSource());
    await fs.writeFile(`${dir}/complete`, String(VM_LAYOUT));
    say(`  ready (${secs()}); starting Claude Code\n`);
    // an earlier build's tree is no longer used
    for (const name of await (fs as any).readdir?.(base).catch?.(() => []) ?? []) {
      if (name.startsWith('nc-') && `${base}/${name}` !== dir) await (fs as any).rm?.(`${base}/${name}`, { recursive: true, force: true }).catch?.(() => {});
    }
  }
  index[binPath] = { size: st.size, mtime, sha256: sha };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');
  return { dir, launcher, sha256: sha, extracted };
}
