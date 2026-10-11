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
export const VM_LAYOUT = 5;

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
export function launcherSource(): string {
  return [
    '// tabcomputer: claude --vm (src/claude-vm/extract.ts)',
    "const { createBun } = await require('tabcomputer:claude-vm').load();",
    "const assets = JSON.parse(require('fs').readFileSync(__dirname + '/bun-assets.json', 'utf8'));",
    'globalThis.Bun = createBun({ process: process, require: require, Buffer: Buffer, assets: assets, root: __dirname });',
    "await import('./cli.js');",
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

const isZstd = (b: Uint8Array) => b.length >= 4 && b[0] === 0x28 && b[1] === 0xb5 && b[2] === 0x2f && b[3] === 0xfd;

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface VmLayout { dir: string; launcher: string; sha256: string; extracted: boolean }

/**
 * The extracted layout for the binary at `binPath`, extracting it first if
 * needed. `say` reports progress (extraction takes a while once).
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
    bin = await fs.readFile(binPath) as Uint8Array;
    sha = await sha256Hex(bin);
  }
  const dir = `${root}/${sha}`;
  const launcher = `${dir}/vm-main.mjs`;
  let extracted = false;
  let done: string | null = null;
  try { done = await fs.readFile(`${dir}/complete`, 'utf8'); } catch { /* not yet */ }
  if (done?.trim() !== String(VM_LAYOUT)) {
    say('claude --vm: extracting Claude Code\'s JavaScript from the native build (once per version)...\n');
    bin ??= await fs.readFile(binPath) as Uint8Array;
    const graph = parseBunGraph(bin);
    const dec = new TextDecoder();
    const made = new Set<string>();
    const assets: Record<string, number> = {};
    const mkdirOnce = async (d: string) => { if (!made.has(d)) { made.add(d); await fs.mkdir(d, { recursive: true }); } };
    const { withEsbuild } = await import('../commands/build');
    let done = 0;
    const jsCount = graph.modules.filter((m) => m.loader === BunLoader.js).length;
    await withEsbuild(async (esbuild) => { for (const m of graph.modules) {
      if (!m.name.startsWith(BUNFS)) continue;
      const rel = m.name.slice(BUNFS.length);
      const path = `${dir}/${m === graph.entry ? 'cli.js' : rel}`;
      await mkdirOnce(path.slice(0, path.lastIndexOf('/')));
      if (m.loader !== BunLoader.js) assets[path] = m.loader;
      if (m.loader === BunLoader.js) {
        await fs.writeFile(path, await toCommonJS(esbuild as any, adaptModule(dec.decode(m.contents), dir)));
        if (++done % 500 === 0) say(`  ${done}/${jsCount} modules\n`);
      }
      // zstd assets (skills, docs; the code checks the magic, not the name) stored
      // decompressed: node's sync reads find text in its cache, and no zstd at run time
      else if (isZstd(m.contents)) await fs.writeFile(path, zstdDecodeAll(m.contents));
      else await fs.writeFile(path, m.contents.slice());
    } });
    await mkdirOnce(`${dir}/node_modules/ws`);
    await fs.writeFile(`${dir}/node_modules/ws/index.js`, wsShimSource());
    await fs.writeFile(`${dir}/node_modules/ws/package.json`, JSON.stringify({ name: 'ws', main: 'index.js' }));
    await fs.writeFile(`${dir}/package.json`, JSON.stringify({ type: 'commonjs' }));
    await fs.writeFile(`${dir}/bun-assets.json`, JSON.stringify(assets));
    await fs.writeFile(launcher, launcherSource());
    await fs.writeFile(`${dir}/complete`, String(VM_LAYOUT));
    extracted = true;
  }
  index[binPath] = { size: st.size, mtime, sha256: sha };
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(indexPath, JSON.stringify(index, null, 2) + '\n');
  return { dir, launcher, sha256: sha, extracted };
}
