/**
 * CommonJS module resolver and loader.
 * Handles require() calls, node_modules resolution, package.json exports.
 * Extracted from node-cmd.ts requireModule()/_requireModule().
 */

import { SCRIPT_TIMER_NAMES } from './page-globals';
import type { CommandContext } from '../commands/index';
import { patchPackageSource } from './source-patches';
import { transformESModules, transformTS, transformJSX, esmLive } from '../commands/jseval/module-transform';
import { carryAsyncContext, carriesAsyncContext } from './async-context';
import { ProcessExitError } from '../commands/jseval/utils';
import { BrowserBuildFailure } from './browser-packages';
import { nodeGuestOf } from '../node-worker/hooks';
import { WORKER_ONLY_GLOBALS } from './process-global';

export interface RequireDeps {
  ctx: CommandContext;
  /** The script's own timers (execution.ts), bound by name in every module it loads */
  scriptTimers?: Record<string, Function>;
  fileCache: Map<string, string>;
  fileMtimes: Map<string, number>;
  moduleCache: Map<string, { exports: any }>;
  pendingPromises: Promise<any>[];
  processEvents: Record<string, Function[]>;
  getBuiltinModule: (name: string) => any;
  fakeConsole: any;
  fakeProcess: any;
  FakeBuffer: any;
  /** The process's own global object (process-global.ts): modules' globalThis and global */
  processGlobal?: any;
  /** Packages loaded as their browser builds, by specifier (browser-packages.ts) */
  browserModules?: Map<string, any>;
  /** Its Function: code compiled at run time sees the process's globals (process-global.ts) */
  processFunction?: FunctionConstructor;
  createExpressShim: () => any;
  createSqliteShim: () => any;
  createAutoStub: (modPath: string, target: any) => any;
}

/**
 * require() plus `ready`: the same load, awaiting the body of a module that
 * runs asynchronously (top-level await) before handing back its exports.
 */
export interface RequireFunction {
  (modPath: string, fromDir: string): any;
  ready(modPath: string, fromDir: string, importer?: string): Promise<any>;
}

export function createRequireFunction(deps: RequireDeps): RequireFunction {
  const { ctx, fileCache, fileMtimes, moduleCache, pendingPromises, processEvents,
    getBuiltinModule, fakeConsole, fakeProcess, FakeBuffer,
    createExpressShim, createSqliteShim, createAutoStub } = deps;
  // A kernel guest (node in a Worker) has no DOM and a real network stack: packages
  // load as their node builds there, not their browser ones (decode-named-character-
  // reference's index.dom.js wants `document`: astro dev failed at startup)
  const guest = !!nodeGuestOf(ctx);
  const buildOf = (pkg: { name?: unknown }) => nodeBuild(pkg) || guest;

  // Modules whose body is still running (top-level await), by path, and which
  // module each importer is waiting on (to spot cycles)
  const pendingEval = new Map<string, Promise<unknown>>();
  const waitsOn = new Map<string, string>();
  // The file the last _requireModule call loaded or found in the cache
  let lastResolved = '';

  /**
   * An ES module with top-level await runs as an async function, so require()
   * returns its exports before its `export { … }` assignments run. Static
   * imports in async modules and import() wait for the body instead, as ESM
   * evaluation does (Gemini CLI's chunks all start with an await). A wait
   * that would close a cycle back to the importer is skipped.
   */
  async function requireReady(modPath: string, fromDir: string, importer?: string): Promise<any> {
    lastResolved = '';
    const exp = requireModule(modPath, fromDir);
    const path = lastResolved;
    const running = path ? pendingEval.get(path) : undefined;
    if (!running) return exp;
    for (let at: string | undefined = path; at; at = waitsOn.get(at)) if (at === importer) return exp;
    if (importer) waitsOn.set(importer, path);
    try {
      await running;
    } finally {
      if (importer) waitsOn.delete(importer);
    }
    return moduleCache.get(path)?.exports ?? exp;
  }

  /** Modules being evaluated → what runs when each has loaded (require.relink) */
  const loading = new Map<string, ((exports: any) => void)[]>();
  /** The next module this loads is evaluated again (it was asked for with a query) */
  let freshNext = false;
  function requireModule(modPath: string, fromDir: string): any {
    // file: URLs name files (vite's bundled config imports its dependencies so)
    if (modPath.startsWith('file://')) modPath = decodeURIComponent(new URL(modPath).pathname);
    // A file with a query or hash (`import('./page.mjs?time=…')`, Astro's cache
    // busting) is that file; a query makes it a fresh instance, as in node
    if (/^(?:\/|\.\.?\/)/.test(modPath) && /[?#]/.test(modPath)) {
      if (modPath.includes('?')) freshNext = true;
      modPath = modPath.replace(/[?#].*$/, '');
    }
    // A package that runs as its browser build (browser-packages.ts)
    const browser = deps.browserModules?.get(modPath);
    if (browser instanceof BrowserBuildFailure) throw browser.error(modPath);
    if (browser) return browser;
    let result: any;
    try { result = _requireModule(modPath, fromDir); } finally { freshNext = false; }
    // For Node.js builtins, wrap in auto-stub Proxy
    if (result && typeof result === 'object' && (modPath.startsWith('node:') || getBuiltinModule(modPath) !== null)) {
      return createAutoStub(modPath, result);
    }
    return result;
  }

  /** A file the text cache doesn't hold (a binary one: require.resolve('./favicon.ico'), Next's build) */
  function isFile(p: string): boolean {
    if (!/\.[^/.]+$/.test(p) || /\.(c|m)?[jt]sx?$|\.json$/.test(p)) return false;
    try { return !!getBuiltinModule('fs')?.statSync(p)?.isFile(); } catch { return false; }
  }

  function tryResolveExtensions(base: string): string | undefined {
    // As Node: the file itself, then with an extension (require('./package')
    // is package.json: uvu's CLI), then a directory's index
    if (fileCache.has(base) || isFile(base)) return base;
    for (const ext of ['.ts', '.tsx', '.js', '.jsx', '.json']) {
      if (fileCache.has(base + ext)) return base + ext;
    }
    // A directory with a package.json names its file in "main" (next/dist/compiled/zod: index.cjs)
    const pj = fileCache.get(base + '/package.json');
    if (pj) {
      try {
        const main = JSON.parse(pj).main;
        if (typeof main === 'string' && main) {
          const m = ctx.fs.resolvePath(main, base);
          for (const c of [m, m + '.js', m + '.json', m + '/index.js']) if (fileCache.has(c)) return c;
        }
      } catch { /* not JSON */ }
    }
    for (const idx of ['/index.ts', '/index.tsx', '/index.js', '/index.jsx', '/index.json']) {
      if (fileCache.has(base + idx)) return base + idx;
    }
    return undefined;
  }

  function _requireModule(modPath: string, fromDir: string, resolveOnly = false): any {
    // Check for Express shim — return the factory function itself
    // (users do: const express = require('express'); const app = express();)
    if (modPath === 'express' && !resolveOnly) {
      return createExpressShim;
    }

    // Check for better-sqlite3 shim
    if (modPath === 'better-sqlite3' && !resolveOnly) {
      return createSqliteShim();
    }

    // Check built-in modules first
    const builtin = getBuiltinModule(modPath);
    if (builtin !== null) {
      return resolveOnly ? modPath : builtin;
    }

    let resolved = modPath;

    // Handle Node.js package #imports (subpath imports)
    // e.g., chalk uses `import x from '#ansi-styles'` which maps via package.json "imports"
    if (modPath.startsWith('#')) {
      let lookupDir = fromDir;
      while (lookupDir) {
        const pkgJsonPath = `${lookupDir}/package.json`;
        if (fileCache.has(pkgJsonPath)) {
          try {
            const pkg = JSON.parse(fileCache.get(pkgJsonPath)!);
            if (pkg.imports && pkg.imports[modPath]) {
              const mapping = pkg.imports[modPath];
              let target: string | undefined;
              if (typeof mapping === 'string') {
                target = mapping;
              } else if (typeof mapping === 'object') {
                target = mapping.default || mapping.node || mapping.import || mapping.require;
              }
              if (target) {
                resolved = ctx.fs.resolvePath(target, lookupDir);
                if (!resolved.endsWith('.js') && !resolved.endsWith('.json') && !resolved.endsWith('.ts') && !resolved.endsWith('.tsx') && !resolved.endsWith('.jsx')) {
                  const found = tryResolveExtensions(resolved);
                  if (found) resolved = found;
                }
                if (!resolveOnly && moduleCache.has(resolved)) { lastResolved = resolved; return moduleCache.get(resolved)!.exports; }
                break;
              }
            }
          } catch { /* ignore parse errors */ }
        }
        const parent = lookupDir.substring(0, lookupDir.lastIndexOf('/')) || '';
        if (parent === lookupDir || !parent) break;
        lookupDir = parent;
      }
    } else if (modPath.startsWith('./') || modPath.startsWith('../') || modPath.startsWith('/')) {
      resolved = ctx.fs.resolvePath(modPath, fromDir);
      if (!resolved.endsWith('.js') && !resolved.endsWith('.json') && !resolved.endsWith('.ts') && !resolved.endsWith('.tsx') && !resolved.endsWith('.jsx')) {
        const found = tryResolveExtensions(resolved);
        if (found) resolved = found;
      }
    } else {
      // Handle subpath imports like 'semver/functions/coerce'
      // Split into package name and subpath
      const parts = modPath.split('/');
      const isScoped = modPath.startsWith('@');
      const pkgName = isScoped ? parts.slice(0, 2).join('/') : parts[0];
      const subpath = isScoped ? parts.slice(2).join('/') : parts.slice(1).join('/');

      // Walk up directories to find node_modules (npm resolution)
      let searchDir = fromDir.startsWith('/') ? fromDir : ctx.cwd;
      let found = false;
      while (searchDir) {
        let pkgDir = `${searchDir}/node_modules/${pkgName}`;
        // A package behind a symlink (pnpm: node_modules/x -> .pnpm/x@1/node_modules/x)
        // loads from its real path, as in node, so its dependencies resolve beside it
        const realPkgDir = ctx.fs.realpathCached?.(pkgDir);
        if (realPkgDir && realPkgDir !== pkgDir && fileCache.has(`${realPkgDir}/package.json`)) pkgDir = realPkgDir;
        let pkgPath = `${pkgDir}/package.json`;

        // Handle npm GitHub tarball extraction which creates nested structure
        // e.g., node_modules/busboy/mscdex-busboy-9aadb7a/package.json
        if (!fileCache.has(pkgPath)) {
          const nestedPkg = [...fileCache.keys()].find(
            k => k.startsWith(pkgDir + '/') && k.endsWith('/package.json') && k.split('/').length === pkgDir.split('/').length + 2
          );
          if (nestedPkg) {
            pkgDir = nestedPkg.replace('/package.json', '');
            pkgPath = nestedPkg;
          }
        }

        if (fileCache.has(pkgPath)) {
          if (subpath) {
            // Subpath import - check exports field first, then look for file directly
            let subpathResolved: string | undefined;
            try {
              const pkg = JSON.parse(fileCache.get(pkgPath)!);
              if (pkg.exports) {
                // Check for subpath in exports: { "./*": "./dist/*.js" } or { "./foo": "./dist/foo.js" }
                const subpathKey = `./${subpath}`;
                const exp = pkg.exports[subpathKey];
                if (exp) {
                  const target = exportTarget(exp, buildOf(pkg));
                  if (target) {
                    subpathResolved = `${pkgDir}/${target.replace(/^\.\//, '')}`;
                  }
                } else {
                  // Try wildcard exports: "./*" -> "./dist/*"
                  for (const [key, value] of Object.entries(pkg.exports)) {
                    if (key.includes('*')) {
                      const pattern = key.replace('./', '').replace('*', '(.*)');
                      const regex = new RegExp(`^${pattern}$`);
                      const match = subpath.match(regex);
                      if (match) {
                        const target = exportTarget(value, buildOf(pkg));
                        if (target) {
                          subpathResolved = `${pkgDir}/${target.replace(/^\.\//, '').replace('*', match[1])}`;
                          break;
                        }
                      }
                    }
                  }
                }
              }
            } catch { /* ignore parse errors */ }

            if (subpathResolved && fileCache.has(subpathResolved)) {
              resolved = subpathResolved;
            } else {
              // Fall back to direct file lookup
              const subpathFull = `${pkgDir}/${subpath}`;
              if (fileCache.has(subpathFull)) {
                resolved = subpathFull;
              } else {
                const found = tryResolveExtensions(subpathFull);
                resolved = found || subpathResolved || subpathFull + '.js'; // Will fail with helpful error
              }
            }
          } else {
            // Main package import - use package.json exports or main field
            try {
              const pkg = JSON.parse(fileCache.get(pkgPath)!);
              let main: string | undefined;

              // Modern packages use "exports" field
              if (pkg.exports) {
                const exp = pkg.exports;
                // exports can be string, object with "." entry, or conditional exports
                if (typeof exp === 'string') {
                  main = exp;
                } else if (exp['.']) {
                  const dotExport = exp['.'];
                  main = exportTarget(dotExport, buildOf(pkg));
                } else {
                  main = exportTarget(exp, buildOf(pkg));
                }
              }

              // Fall back to main field or index.js
              if (!main) {
                main = pkg.main || pkg.module || 'index.js';
              }

              // Ensure main is a string
              if (typeof main !== 'string') {
                main = 'index.js';
              }

              main = main.replace(/^\.\//, '');
              // Don't add .js if already has valid extension
              if (!/\.(js|cjs|mjs|json|ts|tsx|jsx)$/.test(main)) {
                // Check if main points to a directory or file, trying TS extensions first
                const fullBase = `${pkgDir}/${main}`;
                const found = tryResolveExtensions(fullBase);
                if (found) {
                  main = found.substring(pkgDir.length + 1);
                } else {
                  main += '.js';
                }
              }
              resolved = `${pkgDir}/${main}`;
            } catch {
              resolved = `${pkgDir}/index.js`;
            }
          }
          found = true;
          break;
        }
        // Also check if package exists without package.json
        if (fileCache.has(`${pkgDir}/index.js`)) {
          if (subpath) {
            const subpathFull = `${pkgDir}/${subpath}`;
            if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
            else if (fileCache.has(subpathFull)) resolved = subpathFull;
            else resolved = subpathFull + '/index.js';
          } else {
            resolved = `${pkgDir}/index.js`;
          }
          found = true;
          break;
        }
        // Move up one directory
        const parent = searchDir.substring(0, searchDir.lastIndexOf('/')) || '';
        if (parent === searchDir || !parent) break;
        searchDir = parent;
      }
      // Also check global node_modules (/usr/local/lib/node_modules)
      if (!found) {
        const globalPkgDir = `/usr/local/lib/node_modules/${pkgName}`;
        const globalPkgPath = `${globalPkgDir}/package.json`;
        if (fileCache.has(globalPkgPath)) {
          if (subpath) {
            const subpathFull = `${globalPkgDir}/${subpath}`;
            if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
            else if (fileCache.has(subpathFull)) resolved = subpathFull;
            else resolved = subpathFull + '/index.js';
          } else {
            try {
              const pkg = JSON.parse(fileCache.get(globalPkgPath)!);
              let main: string | undefined;
              if (pkg.exports) {
                const exp = pkg.exports;
                if (typeof exp === 'string') main = exp;
                else main = exportTarget(exp['.'] ?? exp, buildOf(pkg));
              }
              if (!main) main = pkg.main || pkg.module || 'index.js';
              if (typeof main !== 'string') main = 'index.js';
              main = main.replace(/^\.\//, '');
              if (!/\.(js|cjs|mjs|json)$/.test(main)) {
                const asDir = `${globalPkgDir}/${main}/index.js`;
                const asFile = `${globalPkgDir}/${main}.js`;
                if (fileCache.has(asDir) && !fileCache.has(asFile)) main += '/index.js';
                else main += '.js';
              }
              resolved = `${globalPkgDir}/${main}`;
            } catch {
              resolved = `${globalPkgDir}/index.js`;
            }
          }
          found = true;
        }
      }
      // Also check from ctx.cwd — scripts in /tmp need to find packages in /home/user/node_modules
      if (!found && ctx.cwd !== fromDir) {
        const cwdPkgDir = `${ctx.cwd}/node_modules/${pkgName}`;
        const cwdPkgPath = `${cwdPkgDir}/package.json`;
        if (fileCache.has(cwdPkgPath)) {
          if (subpath) {
            const subpathFull = `${cwdPkgDir}/${subpath}`;
            if (fileCache.has(subpathFull + '.js')) resolved = subpathFull + '.js';
            else if (fileCache.has(subpathFull)) resolved = subpathFull;
            else if (fileCache.has(subpathFull + '/index.js')) resolved = subpathFull + '/index.js';
            else resolved = subpathFull + '.js';
          } else {
            try {
              const pkg = JSON.parse(fileCache.get(cwdPkgPath)!);
              let main: string | undefined;
              if (pkg.exports) {
                const exp = pkg.exports;
                if (typeof exp === 'string') main = exp;
                else main = exportTarget(exp['.'] ?? exp, buildOf(pkg));
              }
              if (!main) main = pkg.main || pkg.module || 'index.js';
              if (typeof main !== 'string') main = 'index.js';
              main = main.replace(/^\.\//, '');
              if (!/\.(js|cjs|mjs|json)$/.test(main)) {
                const asDir = `${cwdPkgDir}/${main}/index.js`;
                const asFile = `${cwdPkgDir}/${main}.js`;
                if (fileCache.has(asDir) && !fileCache.has(asFile)) main += '/index.js';
                else main += '.js';
              }
              resolved = `${cwdPkgDir}/${main}`;
            } catch {
              resolved = `${cwdPkgDir}/index.js`;
            }
          }
          found = true;
        }
      }
      if (!found) {
        resolved = `${ctx.cwd}/node_modules/${modPath}/index.js`;
      }
    }

    if (resolveOnly) {
      if (fileCache.has(resolved) || moduleCache.has(resolved) || isFile(resolved)) return resolved;
      const err: any = new Error(`Cannot find module '${modPath}'`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    if (freshNext) { freshNext = false; moduleCache.delete(resolved); }
    if (moduleCache.has(resolved)) { lastResolved = resolved; return moduleCache.get(resolved)!.exports; }

    const content = fileCache.get(resolved);
    if (content === undefined) {
      // Show helpful debug info
      const nearby = [...fileCache.keys()]
        .filter(k => k.includes(modPath.replace(/^\.\.?\//g, '').replace(/\.js$/, '')))
        .slice(0, 5);
      const hint = nearby.length ? `\nSimilar files in cache: ${nearby.join(', ')}` : '';
      const isNpmPkg = !modPath.startsWith('.') && !modPath.startsWith('/');
      const npmHint = isNpmPkg ? `\nTry: npm install ${modPath.split('/')[0]}` : '';
      throw Object.assign(new Error(`Cannot find module '${modPath}' (resolved: ${resolved})${hint}${npmHint}`), { code: 'MODULE_NOT_FOUND', requireStack: [] });
    }

    if (resolved.endsWith('.json')) {
      const exp = JSON.parse(content);
      // (a module as node has it: Next's dev server walks require.cache entries' children)
      moduleCache.set(resolved, { exports: exp, id: resolved, filename: resolved, loaded: true, children: [] } as { exports: any });
      lastResolved = resolved;
      return exp;
    }

    const mod: any = { exports: {} as any, id: resolved, filename: resolved, loaded: false, children: [] };
    moduleCache.set(resolved, mod);
    // While it loads, a module that imports it back (a cycle) has its named imports re-read when it is done
    loading.set(resolved, []);
    const loaded = () => { const fns = loading.get(resolved) ?? []; loading.delete(resolved); for (const fn of fns) { try { fn(mod.exports); } catch { /* a const it can't reassign */ } } };
    const modDir = resolved.substring(0, resolved.lastIndexOf('/')) || ctx.cwd;
    const nestedRequire = makeRequire(modDir, mod);

    try {
      // Transform TypeScript/JSX/ESM syntax to CommonJS
      let transformedContent = patchPackageSource(resolved, content);
      if (resolved.endsWith('.ts') || resolved.endsWith('.tsx')) {
        transformedContent = transformTS(transformedContent);
      }
      if (resolved.endsWith('.tsx') || resolved.endsWith('.jsx')) {
        transformedContent = transformJSX(transformedContent);
      }
      // Once a process uses AsyncLocalStorage, awaits carry its stores (async-context.ts)
      transformedContent = transformESModules(transformedContent,
        carriesAsyncContext(content) ? carryAsyncContext : undefined, esmLive(ctx.env));

      const modImportMeta = {
        url: `file://${resolved}`,
        dirname: modDir,
        filename: resolved,
      };
      const fnParams = [
        'module', 'exports', 'require', '__filename', '__dirname',
        'console', 'process', 'global', 'Buffer', '__import_meta',
        '__shiro_module', '__shiro_require', '__dynamic_import', '__shiro_require_ready', 'globalThis', 'Function',
        ...(deps.scriptTimers ? SCRIPT_TIMER_NAMES : []), ...(guest ? WORKER_ONLY_GLOBALS : []),
      ];
      const dynamicImport = async (specifier: unknown) => {
        let spec = String(specifier);
        if (/^(?:https?|data|blob):/.test(spec)) return import(/* @vite-ignore */ spec);
        if (spec.startsWith('file://')) spec = decodeURIComponent(spec.slice(7));
        return esmNamespace(await requireReady(spec, modDir, resolved));
      };
      const fnArgs = [mod, mod.exports, nestedRequire, resolved, modDir,
        fakeConsole, fakeProcess, deps.processGlobal ?? globalThis, FakeBuffer, modImportMeta,
        mod, nestedRequire, dynamicImport, (p: string) => requireReady(p, modDir, resolved), deps.processGlobal ?? globalThis, deps.processFunction ?? Function,
        ...(deps.scriptTimers ? SCRIPT_TIMER_NAMES.map((k) => deps.scriptTimers![k]) : []), ...(guest ? WORKER_ONLY_GLOBALS.map(() => undefined) : [])];

      const AsyncFn = Object.getPrototypeOf(async function(){}).constructor;
      const runAsync = (wrapped: (...a: any[]) => Promise<any>) => {
          const execPromise = wrapped.apply(mod.exports, fnArgs);
          pendingEval.set(resolved, execPromise);
          execPromise.then(() => { pendingEval.delete(resolved); loaded(); }, () => { pendingEval.delete(resolved); loading.delete(resolved); });
          pendingPromises.push(execPromise.catch((e: any) => {
            if (!(e instanceof ProcessExitError)) {
              console.error(`Error in module ${resolved}:`, e.message, e.stack?.slice(0, 300));
              if (processEvents['uncaughtException']?.length) {
                fakeProcess.emit('uncaughtException', e);
              }
            }
          }));
      };
      // An import still evaluating (its own top-level await, or one of its imports'):
      // ES module importers wait for it. The body runs synchronously first, so its
      // hoisted exports are there for a cyclic import; at the first static import still
      // evaluating it stops, and runs again as an async module awaiting its imports
      // (they are cached by then, and the hoisted exports come first). SvelteKit's
      // config called kit's sveltekit() before core/sync/utils.js's `await import_peer(…)`
      const waiting = new Set<string>();
      let waited: ((...a: any[]) => Promise<any>) | null | undefined;
      let inBody = false;
      const noteWaiting = (spec: string) => {
        lastResolved = '';
        const exp = nestedRequire(spec);
        if (lastResolved && pendingEval.has(lastResolved)) {
          waiting.add(spec);
          if (inBody) {
            if (waited === undefined) waited = compileWaiting();
            if (waited) { inBody = false; throw NEEDS_WAIT; }
          }
        }
        return exp;
      };
      const compileWaiting = () => {
        try {
          return new AsyncFn(...fnParams, wrapModuleBody(transformedContent.replace(IMPORT_CALL,
            (_: string, q: string, spec: string) => `(await __shiro_require_ready(${q}${spec}${q}))`), true));
        } catch (e) {
          if (!(e instanceof SyntaxError)) throw e;
          return null; // (an import inside a function: it runs as it is)
        }
      };
      const syncArgs = fnArgs.slice();
      syncArgs[11] = Object.assign(noteWaiting, nestedRequire);
      try {
        // Synchronous first: most packages have no top-level await, and module.exports
        // is then filled before require() returns (chalk 5's `export default`)
        const syncFn = new Function(...fnParams, wrapModuleBody(transformedContent, false));
        inBody = true;
        try { syncFn.apply(mod.exports, syncArgs); } finally { inBody = false; }
        loaded();
        // (an import still evaluating that it could not wait for)
        if (waiting.size) {
          // (one at a time: waitsOn holds one import per importer, for the cycle check)
          const settled = (async () => { for (const spec of waiting) await requireReady(spec, modDir, resolved); })().catch(() => {});
          pendingEval.set(resolved, settled);
          settled.then(() => { if (pendingEval.get(resolved) === settled) pendingEval.delete(resolved); });
        }
      } catch (syncErr: any) {
        if (syncErr === NEEDS_WAIT && waited) {
          runAsync(waited);
        } else if (syncErr instanceof SyntaxError && /\bawait\b/.test(transformedContent)) {
          // SyntaxError from top-level `await` -> fall back to AsyncFunction
          runAsync(compileAsyncModule(AsyncFn, fnParams, transformedContent));
        } else {
          throw syncErr;
        }
      }

    } catch (err) {
      moduleCache.delete(resolved);
      loading.delete(resolved);
      // process.exit() while a module loads (tsc's lib/_tsc.js runs the compiler
      // from require) ends the script; it is not a load failure
      if (err instanceof ProcessExitError || (err as any)?._isProcessExit) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      const enhancedErr: any = new Error(`Error loading module '${resolved}': ${errMsg}`);
      if ((err as any)?.code) enhancedErr.code = (err as any).code;
      if (err instanceof Error && err.stack) {
        enhancedErr.stack = `Error loading module '${resolved}':\n${err.stack}`;
      }
      throw enhancedErr;
    }

    lastResolved = resolved;
    return mod.exports;
  }

  /** require.cache / Module._cache: an object keyed by filename, as in node, over the module cache */
  const requireCache = new Proxy({}, {
    get: (_t, k) => typeof k === 'string' && moduleCache.has(k) ? moduleCache.get(k) : undefined,
    set: (_t, k, v) => { if (typeof k === 'string') moduleCache.set(k, v); return true; },
    has: (_t, k) => typeof k === 'string' && moduleCache.has(k),
    deleteProperty: (_t, k) => { if (typeof k === 'string') moduleCache.delete(k); return true; },
    ownKeys: () => [...moduleCache.keys()],
    getOwnPropertyDescriptor: (_t, k) => typeof k === 'string' && moduleCache.has(k)
      ? { value: moduleCache.get(k), writable: true, enumerable: true, configurable: true } : undefined,
  });
  /**
   * A module's `require`, with Node's properties: resolve (and
   * resolve.paths: the node_modules directories searched, null for a
   * builtin), cache and main.
   */
  function makeRequire(fromDir: string, mod?: any): any {
    const req: any = (p: string) => requireModule(p, fromDir);
    // A named import of a module still loading: `fn` gets its exports once it has loaded
    req.relink = (spec: string, fn: (exports: any) => void) => {
      if (!loading.size) return;
      let resolved: string;
      try { resolved = req.resolve(spec); } catch { return; }
      loading.get(resolved)?.push(fn);
    };
    req.live = liveExports;
    req.settle = settleExports;
    req.resolve = (request: string, opts?: { paths?: string[] }) => {
      const dirs = opts?.paths?.length ? opts.paths : [fromDir];
      let last: any;
      for (const d of dirs) {
        try { return _requireModule(request, ctx.fs.resolvePath(d, ctx.cwd), true); } catch (e) { last = e; }
      }
      throw last;
    };
    req.resolve.paths = (request: string) => {
      if (getBuiltinModule(request) !== null) return null;
      const out: string[] = [];
      for (let d = fromDir; ; d = d.substring(0, d.lastIndexOf('/')) || '/') {
        if (!d.endsWith('/node_modules')) out.push(`${d === '/' ? '' : d}/node_modules`);
        if (d === '/') break;
      }
      return out;
    };
    req.cache = requireCache;
    req.main = mainModule;
    req.extensions = extensions;
    if (mod) {
      mod.require = req;
      mod.paths ??= req.resolve.paths('x');
    }
    return req;
  }
  let mainModule: any;
  (requireModule as any).makeRequire = makeRequire;
  (requireModule as any).cache = requireCache;
  /**
   * require.extensions / Module._extensions: what loads each kind of file, as
   * node has them (Next's config loader reads `require.extensions['.js']` to
   * chain its .ts hook). Loading goes through this module's own loader.
   */
  const extensions: Record<string, (mod: any, filename: string) => void> = {
    '.js': (mod, filename) => { mod.exports = requireModule(filename, '/'); },
    '.json': (mod, filename) => { mod.exports = requireModule(filename, '/'); },
    '.node': (_mod, filename) => { throw Object.assign(new Error(`Cannot load native addon ${filename}`), { code: 'ERR_DLOPEN_FAILED' }); },
  };
  (requireModule as any).extensions = extensions;
  // The entry is a module too: one that imports it back (a cycle through it) gets it, not a
  // second run of it (vitest's entry ran twice), and re-reads its exports once it has run
  (requireModule as any).setMain = (m: any) => {
    mainModule = m;
    if (typeof m?.filename === 'string' && m.filename.startsWith('/') && !moduleCache.has(m.filename)) {
      moduleCache.set(m.filename, m);
      loading.set(m.filename, []);
    }
  };
  (requireModule as any).mainLoaded = () => {
    const f = mainModule?.filename;
    const fns = loading.get(f) ?? [];
    loading.delete(f);
    if (mainModule) mainModule.loaded = true;
    for (const fn of fns) { try { fn(mainModule.exports); } catch { /* a const it can't reassign */ } }
  };

  return Object.assign(requireModule, { ready: requireReady });
}

/**
 * Static imports of files (relative or absolute specifiers) in an async
 * module body wait for the module they import (`requireReady`);
 * transformESModules writes them as `__shiro_require("./m")`. Builtins and
 * packages are left synchronous, so a bundle that only imports those (Claude
 * Code's cli.js) runs as before. Falls back to the plain body if the rewrite
 * doesn't compile (a generated call inside a non-async function).
 */
/** A static import as transformESModules writes it */
/** Thrown out of a module body that has to wait for an import (see requireModule) */
const NEEDS_WAIT = new Error('(waits for an import)');
const IMPORT_CALL = /__shiro_require\((['"])([^'"\n]+)\1\)/g;

export function compileAsyncModule(AsyncFn: any, params: string[], body: string): (...a: any[]) => Promise<any> {
  const awaited = body.replace(/__shiro_require\((['"])((?:\.\.?)?\/[^'"\n]*)\1\)/g, '(await __shiro_require_ready($1$2$1))');
  if (awaited !== body) {
    try {
      return new AsyncFn(...params, wrapModuleBody(awaited, true));
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
    }
  }
  return new AsyncFn(...params, wrapModuleBody(body, true));
}

/**
 * A module body inside its own function, so the body's top-level declarations
 * shadow the wrapper's parameters instead of colliding with them (commander
 * has `const process = require('node:process')`; Node's own wrapper is a
 * function scope too). `this` is passed through (module.exports).
 */
export function wrapModuleBody(body: string, isAsync: boolean): string {
  return `return (${isAsync ? 'async ' : ''}function () {\n${body}\n}).call(this);`;
}

/**
 * The file a package.json "exports" value names for require(): conditions
 * in the order browser > require > node > default > import, nested
 * conditions and fallback arrays followed. Browser builds come first because
 * they talk to the network with fetch (axios's node build needs a real http
 * stack); require before import because the import entry is often an ESM
 * wrapper around the CommonJS one (commander).
 */
export function exportTarget(v: unknown, nodeBuild: boolean | 'esm' = false): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    for (const x of v) { const t = exportTarget(x, nodeBuild); if (t) return t; }
    return undefined;
  }
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const order = nodeBuild === 'esm' ? ['import', 'node', 'default', 'require'] : ['browser', 'require', 'node', 'default', 'import'];
  for (const c of order) {
    if (o[c] === undefined || (nodeBuild && c === 'browser')) continue;
    const t = exportTarget(o[c], nodeBuild);
    if (t) return t;
  }
  return undefined;
}

/**
 * Packages whose browser build is only a stub that throws ("ws does not work
 * in the browser"): they take their node build, which runs on tabcomputer's
 * node (ws's server attaches to http.createServer's 'upgrade'; engine.io,
 * under Socket.IO, requires it).
 */
export const NODE_BUILD_PACKAGES = new Set(['ws']);
/**
 * Packages that load as their node ES module build. Their CommonJS builds
 * find their files through esbuild's import.meta.url shim, which takes the
 * page's `document` for a browser and gives the page's URL (vite's
 * package.json, @astrojs/compiler's astro.wasm); their browser builds want
 * setup a node program doesn't do (@astrojs/compiler's initialize()).
 */
export const ESM_BUILD_PACKAGES = new Set(['vite', '@astrojs/compiler']);
const nodeBuild = (pkg: { name?: unknown }): boolean | 'esm' =>
  typeof pkg?.name !== 'string' ? false : ESM_BUILD_PACKAGES.has(pkg.name) ? 'esm' : NODE_BUILD_PACKAGES.has(pkg.name);

/**
 * What import() of a module gives, from its CommonJS exports: a namespace
 * with `default` (the exports) and the named exports, as Node does for
 * CommonJS modules. Exports that already have a default (transformed ES
 * modules with a default export, __esModule builds) are returned as they are.
 */
export function esmNamespace(exp: any): any {
  if (exp === null || (typeof exp !== 'object' && typeof exp !== 'function')) return { default: exp };
  if ('default' in exp) return exp;
  const fnOwn = new Set<PropertyKey>(['length', 'name', 'prototype', 'arguments', 'caller']);
  const has = (k: PropertyKey) => k === 'default' || k in exp;
  return new Proxy(Object.create(null), {
    get: (_t, k) => k === 'default' ? exp : k === Symbol.toStringTag ? 'Module' : exp[k],
    has: (_t, k) => has(k),
    ownKeys: () => ['default', ...Reflect.ownKeys(exp).filter(k => k !== 'default' && !(typeof exp === 'function' && fnOwn.has(k)))],
    getOwnPropertyDescriptor: (_t, k) => has(k)
      ? { value: k === 'default' ? exp : exp[k], enumerable: true, configurable: true, writable: false }
      : undefined,
  });
}

/**
 * An ES module's exports as live bindings (esm-live.ts, TABCOMPUTER_ESM_LIVE=1): each a getter
 * reading the module's variable (undefined while it can't be read yet), and a setter that
 * keeps it live for the same value (the transform's own copy at the module's end) and
 * replaces it with another.
 */
function liveExports(exports: any, thunks: Record<string, () => unknown>): void {
  const props: PropertyDescriptorMap = {};
  for (const name of Object.keys(thunks)) {
    const read = thunks[name];
    props[name] = {
      get() { try { return read(); } catch { return undefined; } },
      set(v) {
        let c; try { c = read(); } catch { /* not yet */ }
        if (v !== c) Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
      },
      enumerable: true, configurable: true,
    };
  }
  Object.defineProperties(exports, props);
}

/** Exports whose values can't change any more, as plain properties (esm-live.ts's settled) */
function settleExports(exports: any, values: Record<string, unknown>): void {
  const props: PropertyDescriptorMap = {};
  for (const name of Object.keys(values)) props[name] = { value: values[name], writable: true, enumerable: true, configurable: true };
  Object.defineProperties(exports, props);
}
