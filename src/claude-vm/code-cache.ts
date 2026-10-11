/**
 * claude --vm's bundle.js through V8's code cache (docs/CLAUDE_VM.md).
 *
 * node-compat compiles a module with `new Function`, which V8 never caches:
 * every launch parses ~40 MB again. A script a service worker serves from
 * CacheStorage is cached once V8 has seen it twice (from the third load
 * on, in a dedicated worker too). So bundle.js goes into CacheStorage once,
 * as an ES module whose default export takes node-compat's module
 * parameters, and is imported from there. The worker that serves /__vm/
 * answers /__vm/probe.mjs with `export default 'tabcomputer-vm'`; without it, nothing is stored and the
 * launcher requires bundle.js as before.
 */

const CACHE = 'tabcomputer-vm';

/** node-compat's module parameters (src/node-compat/require.ts), timers and worker-only names included */
export const MODULE_PARAMS = [
  'module', 'exports', 'require', '__filename', '__dirname',
  'console', 'process', 'global', 'Buffer', '__import_meta',
  '__shiro_module', '__shiro_require', '__dynamic_import', '__shiro_require_ready', 'globalThis', 'Function',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope',
] as const;

/** bundle.js's source as that ES module */
export function moduleSource(src: string): string {
  return `export default function (${MODULE_PARAMS.join(', ')}) { return (function () {\n${src}\n}).call(this); }\n`;
}

/** Where a layout's bundle is served: /__vm/<sha>/<nc-key>/bundle.mjs */
export function bundleUrl(dir: string): string {
  return '/__vm/' + dir.split('/').slice(-2).join('/') + '/bundle.mjs';
}

export interface LoadDeps {
  caches: CacheStorage | undefined;
  /** the browser's import(), which node-compat doesn't route as it does a process's fetch */
  importUrl: (href: string) => Promise<any>;
  base: string | undefined;
}

const defaults = (): LoadDeps => ({
  caches: typeof caches !== 'undefined' ? caches : undefined,
  importUrl: (href) => import(/* @vite-ignore */ href),
  base: typeof location !== 'undefined' ? location.href : undefined,
});

/**
 * The compiled bundle of the layout in `dir`, or null when no service worker
 * serves /__vm/ to this worker (none, or not yet: a worker keeps the controller
 * it started with). `readSource` gives bundle.js's text the first time. Throws
 * when the bundle can't be imported (the cache entry gone): the launcher then
 * requires bundle.js.
 */
export async function loadCompiled(dir: string, readSource: () => string, deps: LoadDeps = defaults()): Promise<((...args: unknown[]) => unknown) | null> {
  const { caches: storage, importUrl, base } = deps;
  if (!storage || !base) return null;
  // (a new URL each time: a worker keeps a failed import's answer, and the worker may have
  // been taken since; clients.claim() takes running workers too)
  const probe = await importUrl(new URL(`/__vm/probe.mjs?t=${Date.now()}-${Math.random()}`, base).href).catch(() => null);
  if (probe?.default !== 'tabcomputer-vm') return null;
  const href = new URL(bundleUrl(dir), base).href;
  const cache = await storage.open(CACHE);
  if (!(await cache.match(href))) {
    // (one layout at a time: an earlier version's or build's goes)
    for (const req of await cache.keys()) await cache.delete(req);
    await cache.put(href, new Response(moduleSource(readSource()), { headers: { 'content-type': 'text/javascript' } }));
  }
  const ns = await importUrl(href);
  if (typeof ns?.default !== 'function') throw new Error(`${href}: not the bundle`);
  return ns.default;
}
