/**
 * claude --vm's modules at run time (docs/CLAUDE_VM.md): every module of the
 * layout (extract.ts) is one slice of modules.js, UTF-8, and is decoded and
 * compiled when it is first required. The boot's warm-up (warm.ts) compiles
 * them ahead of `claude`, in the node worker that will run it, without
 * starting Claude Code. Claude Code 2.1.316 runs 1399 of its 2648 modules to
 * its prompt; the rest are never executed.
 *
 * The bytes come from CacheStorage (read in the node worker itself: ~0.1 s for
 * 70 MB, against ~1 s through the kernel), else from modules.js in the tab's
 * files, which then goes into the cache for the next launch. No service
 * worker: V8 keeps no compiled code for a script a service worker serves a
 * dedicated worker from CacheStorage (Chrome 156: none at any size), so
 * importing the code from there bought nothing over compiling it here.
 */

/** The CacheStorage cache with each layout's modules.js (one layout at a time) */
export const MODULE_CACHE = 'tabcomputer-claude-vm';

/** A module's [byte offset, byte length] in modules.js, by its path */
export type ModuleIndex = Record<string, [number, number]>;

/** The key of the layout in `dir` (…/<sha256>/nc-<build>): a URL, as CacheStorage wants */
export function storeKey(origin: string, dir: string): string {
  return `${origin.replace(/\/+$/, '')}/__claude-vm/${dir.split('/').slice(-2).join('/')}/modules.js`;
}

export interface StoreDeps {
  caches: CacheStorage | undefined;
  origin: string | undefined;
}

const defaults = (): StoreDeps => ({
  caches: typeof caches !== 'undefined' ? caches : undefined,
  origin: typeof location !== 'undefined' && /^https?:$/.test(location.protocol) ? location.origin : undefined,
});

/** modules.js put in the cache for the layout in `dir`, any other layout's taken out */
export async function putModules(dir: string, bytes: Uint8Array, deps: StoreDeps = defaults()): Promise<void> {
  if (!deps.caches || !deps.origin) return;
  const key = storeKey(deps.origin, dir);
  const cache = await deps.caches.open(MODULE_CACHE);
  for (const req of await cache.keys()) if (req.url !== key) await cache.delete(req);
  await cache.put(key, new Response(bytes as BodyInit, { headers: { 'content-type': 'application/octet-stream' } }));
}

/**
 * What the last layout run in this worker left: its bytes and its compiled modules. A
 * node worker runs one process at a time and goes back to a pool when it ends
 * (node-worker/host.ts), so the next `claude` it runs starts with them. A compiled
 * module holds nothing of a process's: its globals and its module are parameters.
 */
let kept: { dir: string; bytes: Uint8Array; compiled: Map<string, Function>; params?: string; index?: ModuleIndex } | null = null;

/**
 * The process globals the launcher passes into every module, in this order.
 * precompile() builds functions with these parameters; a later load reuses
 * them only when the launcher's list still matches (createModuleLoader).
 */
export const LAUNCHER_GLOBAL_NAMES = ['console', 'process', 'global', 'Buffer', 'globalThis', 'Function',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope'] as const;

/** The launcher's parsed modules.json, when this worker already read or compiled that layout */
export function cachedIndex(dir: string): ModuleIndex | null {
  return kept?.dir === dir && kept.index ? kept.index : null;
}

/** The layout's modules.js: kept in this worker, else from the cache, else `readFile` (and then into the cache, not waited for) */
export async function loadModules(dir: string, readFile: () => Uint8Array, deps: StoreDeps = defaults()): Promise<Uint8Array> {
  if (kept?.dir === dir) return kept.bytes;
  let bytes: Uint8Array | null = null;
  if (deps.caches && deps.origin) {
    try {
      const hit = await (await deps.caches.open(MODULE_CACHE)).match(storeKey(deps.origin, dir));
      if (hit) bytes = new Uint8Array(await hit.arrayBuffer());
    } catch { /* below */ }
  }
  if (!bytes) {
    bytes = readFile();
    void putModules(dir, bytes, deps).catch(() => {});
  }
  kept = { dir, bytes, compiled: new Map() };
  return bytes;
}

/** What a module's code reads as its own (node-compat's module parameters) */
const OWN = ['module', 'exports', 'require', '__filename', '__dirname', '__import_meta', '__shiro_module', '__shiro_require', '__dynamic_import', '__shiro_require_ready'] as const;

/**
 * Compile every module of a layout into this worker's cache, without running
 * any of it. The next `claude` in this same worker (node-worker/host.ts keeps
 * it) finds the functions already made. `yieldMs` gives the page back between
 * slices when node is running here rather than in a worker.
 */
export async function precompile(dir: string, bytes: Uint8Array, index: ModuleIndex, yieldMs = 0): Promise<number> {
  const params = [...OWN, ...LAUNCHER_GLOBAL_NAMES].join(',');
  const keys = Object.keys(index);
  if (kept?.dir === dir && kept.bytes === bytes && kept.params === params && kept.compiled.size >= keys.length) {
    kept.index = index;
    return kept.compiled.size;
  }
  const names = [...OWN, ...LAUNCHER_GLOBAL_NAMES];
  const compiled = new Map<string, Function>();
  const decoder = new TextDecoder();
  let spent = performance.now();
  for (const key of keys) {
    const [at, len] = index[key];
    const body = decoder.decode(bytes.subarray(at, at + len));
    try {
      compiled.set(key, new Function(...names, `"use strict";${body}\n//# sourceURL=${key}`));
    } catch { /* the real load reports a module that does not compile */ }
    if (yieldMs && performance.now() - spent >= yieldMs) {
      await new Promise((r) => setTimeout(r, 0));
      spent = performance.now();
    }
  }
  kept = { dir, bytes, compiled, params, index };
  return compiled.size;
}

/** Bun's root for the bundle's own files, which import specifiers keep (extract.ts adaptModule) */
export const BUN_ROOT = '/$bunfs/root/';

export interface LoaderOptions {
  /** The layout's directory, which BUN_ROOT stands for */
  dir: string;
  bytes: Uint8Array;
  index: ModuleIndex;
  /** The launcher's require: node's builtins, ws, anything not in the index */
  outer: (id: string) => any;
  /** The process's globals as the launcher has them (console, process, globalThis, timers, …) */
  globals: Record<string, unknown>;
  /** node-compat's export getters (require.live / require.settle, from the launcher's require) */
  live: (exports: any, thunks: Record<string, () => unknown>) => void;
  settle: (exports: any, values: Record<string, unknown>) => void;
}

interface Mod { exports: any; id: string; filename: string; loaded: boolean; children: Mod[] }

/**
 * An ES module's namespace over node-compat's exports for it, live: node-compat
 * makes a default export the module's exports (named ones attached to it), as
 * CommonJS interop has it; a namespace has it as `default`.
 */
function namespace(m: Mod, initial: any): object {
  // (named exports are getters on the exports object the module started with (esm-live.ts),
  // or, listed beside the default (`export { o as default, q }`), properties of that default)
  const replaced = () => m.exports !== initial && m.exports != null && (typeof m.exports === 'object' || typeof m.exports === 'function');
  const own = () => {
    const keys = new Set(Object.keys(initial));
    if (replaced()) for (const k of Object.keys(m.exports)) keys.add(k);
    keys.delete('default');
    return m.exports !== initial ? ['default', ...keys] : [...keys];
  };
  const read = (k: PropertyKey) => {
    if (k === 'default') return m.exports !== initial ? m.exports : undefined;
    if (k === Symbol.toStringTag) return 'Module';
    return k in initial || !replaced() ? initial[k] : m.exports[k];
  };
  return new Proxy(Object.create(null), {
    get: (_t, k) => read(k),
    has: (_t, k) => own().includes(k as string),
    ownKeys: () => own(),
    getOwnPropertyDescriptor: (_t, k) => own().includes(k as string) ? { value: read(k), enumerable: true, configurable: true, writable: false } : undefined,
    set: () => false,
    defineProperty: () => false,
  });
}

/**
 * A CommonJS loader over the index: `require(from)` gives the require of a module
 * in directory `from`. Each module is compiled the first time it is required.
 */
export function createModuleLoader(o: LoaderOptions) {
  const cache: Record<string, Mod> = Object.create(null);
  const namespaces: Record<string, object> = Object.create(null);
  /** The namespace of the module at `key`, which must have started loading */
  const namespaceOf = (key: string) => namespaces[key] ??= namespace(cache[key], initials.get(cache[key])!);
  const initials = new WeakMap<Mod, object>();
  /** Modules whose bodies are running, and what runs once each has (require.relink) */
  const loading = new Map<string, ((exports: any) => void)[]>();
  const decoder = new TextDecoder();
  const names = [...OWN, ...Object.keys(o.globals)];
  const globals = Object.values(o.globals);
  let compiled = 0;
  let compiledBytes = 0;

  const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
  const normalize = (p: string) => {
    const out: string[] = [];
    for (const part of p.split('/')) {
      if (part === '..') out.pop();
      else if (part && part !== '.') out.push(part);
    }
    return '/' + out.join('/');
  };
  const keyOf = (from: string, id: unknown): string | null => {
    if (typeof id !== 'string') return null;
    if (id.startsWith('file://')) id = decodeURIComponent(id.slice(7));
    if ((id as string).startsWith(BUN_ROOT)) id = o.dir + '/' + (id as string).slice(BUN_ROOT.length);
    const p = (id as string).startsWith('/') ? normalize(id as string) : /^\.\.?\//.test(id as string) ? normalize(from + '/' + id) : null;
    if (p === null) return null;
    return o.index[p] ? p : o.index[p + '.js'] ? p + '.js' : null;
  };

  // (compiled with the same parameters only: the launcher's globals)
  const params = names.join(',');
  if (kept?.dir === o.dir && kept.bytes === o.bytes) {
    kept.index = o.index;
    kept.params ??= params;
  }
  const reuse = kept?.dir === o.dir && kept.bytes === o.bytes && kept.params === params ? kept.compiled : null;
  const compile = (key: string): Function => {
    const had = reuse?.get(key);
    if (had) return had;
    const [at, len] = o.index[key];
    const body = decoder.decode(o.bytes.subarray(at, at + len));
    compiled++;
    compiledBytes += len;
    // (strict, as the ES modules it was; named in stack traces by its path)
    const fn = new Function(...names, `"use strict";${body}\n//# sourceURL=${key}`);
    reuse?.set(key, fn);
    return fn;
  };

  const requireFrom = (from: string): any => {
    const r: any = (id: string) => {
      const key = keyOf(from, id);
      if (key === null) return o.outer(id);
      const had = cache[key];
      if (had) return had.exports;
      const m: Mod = cache[key] = { exports: {}, id: key, filename: key, loaded: false, children: [] };
      initials.set(m, m.exports);
      const dir = dirOf(key);
      const req = requireFrom(dir);
      loading.set(key, []);
      try {
        compile(key).apply(m.exports, [m, m.exports, req, key, dir, { url: 'file://' + key, dirname: dir, filename: key }, m, req, importFrom(dir),
          (p: string) => Promise.resolve(req(p)), ...globals]);
      } catch (e) {
        delete cache[key];
        throw e;
      } finally {
        const waiting = loading.get(key) ?? [];
        loading.delete(key);
        for (const fn of waiting) fn(m.exports);
      }
      m.loaded = true;
      return m.exports;
    };
    // (Bun's import.meta.require: an ES module of the bundle as its namespace, anything else as require gives it)
    r.namespace = (id: string) => {
      const key = keyOf(from, id);
      if (key === null) return o.outer(id);
      r(id);
      return namespaceOf(key);
    };
    r.resolve = (id: string) => keyOf(from, id) ?? (o.outer as any).resolve?.(id) ?? id;
    r.cache = cache;
    r.live = o.live;
    r.settle = o.settle;
    // (a named import of a module still running its body: `fn` gets its exports once it has run)
    r.relink = (id: string, fn: (exports: any) => void) => {
      const key = keyOf(from, id);
      if (key !== null) loading.get(key)?.push(fn);
    };
    return r;
  };

  // import(): a module of the bundle's namespace; anything else's exports as a namespace
  const importFrom = (from: string) => (id: unknown) => Promise.resolve().then(() => {
    const req = requireFrom(from);
    if (keyOf(from, String(id)) !== null) return req.namespace(String(id));
    const e = req(String(id));
    return e && (e.__esModule || typeof e !== 'object') ? (e.__esModule ? e : { default: e }) : Object.assign({ default: e }, e);
  });

  return {
    require: requireFrom,
    /** How many modules have been compiled, and their bytes */
    stats: () => ({ compiled, compiledBytes, modules: Object.keys(o.index).length, bytes: o.bytes.length }),
  };
}
