/**
 * Build a hot-swap bundle from a checkout of tabcomputer's source in the
 * filesystem (docs/HOTSWAP.md).
 *
 * The files named (the swap set, 'src/shell.ts' ...) are bundled with
 * esbuild. Every other import resolves to the page's live module (live.ts),
 * so the new code shares the page's singletons. A module that isn't live (a
 * lazy chunk not loaded yet) is copied into the bundle from the checkout,
 * and the result says so: that copy has its own module state.
 *
 * The bundle exports `__keys` (the swap set) and `m0`, `m1`, ... (their
 * namespaces); swap.ts evaluateBundle reads it.
 */
import type * as esbuild from 'esbuild-wasm';
import { liveLoaders, liveModules, NOT_LIVE, type LiveLoaders, type LiveMap } from './live';
import { carryState } from './state';
import { quietDuring } from './swap';

export interface HotswapFs {
  /** A file's text; throws if it doesn't exist or is a directory */
  readFile(path: string): Promise<string>;
}

export interface BuildOptions {
  /** The checkout's root directory (has src/) */
  root: string;
  /** The swap set, relative to root ('src/shell.ts') */
  files: string[];
  /** The live module map (default: the page's) */
  live?: LiveMap;
  /** Loaders for lazy modules (default: the page's) */
  loaders?: LiveLoaders;
  /** esbuild.build (default: the page's esbuild-wasm) */
  build?: (opts: esbuild.BuildOptions) => Promise<esbuild.BuildResult>;
  /** Extra defines; __BUILD_SHA__ and import.meta.env come from the page */
  define?: Record<string, string>;
  sourcemap?: boolean;
  /** Don't take the live modules' state (swap.ts state.ts): the swap starts with fresh module state */
  freshState?: boolean;
}

export interface TestBuildOptions extends Omit<BuildOptions, 'files'> {
  /** The test file (a vitest suite) */
  file: string;
}

export interface BuildResult {
  code: string;
  hash: string;
  keys: string[];
  /** Modules outside the swap set copied in because they aren't live */
  copied: string[];
  /** Lazy live modules the bundle imports statically: loaded before it runs */
  needs: string[];
  warnings: string[];
}

/** The bundle's first line: the lazy live modules to load before it runs */
export const NEEDS_PREFIX = '// hotswap-needs: ';

const EXTS = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js'];

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}
const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function pageBuild(opts: esbuild.BuildOptions): Promise<esbuild.BuildResult> {
  const { withEsbuild } = await import('../commands/build');
  return withEsbuild((e) => e.build(opts));
}

export async function buildSwap(fs: HotswapFs, opts: BuildOptions): Promise<BuildResult> {
  return bundle(fs, opts, null);
}

/**
 * Build a vitest suite from the checkout to run in the page (test-runner.ts).
 * Unlike a swap, every module comes from the checkout: the suite tests the
 * source as edited, in fresh module instances. Their IndexedDB and
 * localStorage go to the runner's isolated stand-ins (`__tcTestEnv`), never
 * the page's. `vitest` is the runner's API; `@shiro/x` is src/x; npm imports
 * are the page's live ones where it has them; node:path, node:os, node:fs (in
 * memory over a snapshot, test-fs.ts), node:url, node:buffer and node:process are the
 * runner's; anything else (node:child_process, ...) throws when used.
 */
export async function buildTest(fs: HotswapFs, opts: TestBuildOptions): Promise<BuildResult> {
  return bundle(fs, { ...opts, files: [] }, opts.file);
}

const TEST_GLOBALS = ['indexedDB', 'localStorage', 'sessionStorage'];
/** node's globals the page lacks, given to the tests' own files (test-fs.ts) */
const NODE_GLOBALS = ['Buffer', 'process'];

async function bundle(fs: HotswapFs, opts: BuildOptions, testFile: string | null): Promise<BuildResult> {
  const root = normalize(opts.root);
  const live = opts.live ?? liveModules();
  const loaders = opts.loaders ?? liveLoaders();
  const needs = new Set<string>();
  const keys = opts.files.map((f) => normalize(f.startsWith('/') ? f : `${root}/${f}`).slice(root.length + 1));
  for (const k of keys) {
    if (k.startsWith('..') || k.startsWith('/')) throw new Error(`${k}: not inside ${root}`);
  }
  const swapSet = new Set(keys);
  // A swapped module the page hasn't loaded yet (a lazy command): load it first, so there is a
  // live one to patch and the modules it imports are live too; a persisted bundle loads it at boot
  if (!testFile) {
    for (const k of keys) {
      if (live.has(k) || !loaders.has(k)) continue;
      needs.add(k);
      const ns = await loaders.get(k)!();
      if (!live.has(k)) live.set(k, ns);
    }
  }
  const copied = new Set<string>();
  const warnings: string[] = [];

  const isFile = async (p: string) => { try { await fs.readFile(p); return true; } catch { return false; } };
  const resolveFile = async (p: string): Promise<string | null> => {
    for (const ext of EXTS) if (await isFile(p + ext)) return p + ext;
    // TypeScript's ESM style: './x.js' naming x.ts
    if (/\.m?js$/.test(p)) {
      const ts = p.replace(/\.m?js$/, '.ts');
      if (await isFile(ts)) return ts;
    }
    return null;
  };
  const keyOf = (abs: string) => (abs.startsWith(root + '/') ? abs.slice(root.length + 1) : null);

  let tsconfigRaw: any = undefined;
  try { tsconfigRaw = JSON.parse(await fs.readFile(`${root}/tsconfig.json`)); } catch { /* esbuild's defaults */ }

  const testPath = testFile ? normalize(testFile.startsWith('/') ? testFile : `${root}/${testFile}`) : null;
  const entry = testPath
    ? `import ${JSON.stringify(testPath)};\nexport const __keys = [];\n`
    : keys.map((k, i) => `export * as m${i} from ${JSON.stringify(`${root}/${k}`)};`).join('\n') +
      `\nexport const __keys = ${JSON.stringify(keys)};\n`;

  const plugin: esbuild.Plugin = {
    name: 'tabcomputer-hotswap',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point') return { path: 'entry', namespace: 'hs-entry' };
        let [spec, query] = args.path.split('?');
        if (spec.endsWith('.css')) return { path: spec, namespace: 'hs-empty' };
        if (testPath && spec === 'vitest') return { path: 'vitest', namespace: 'hs-vitest' };
        if (testPath && spec.startsWith('@shiro/')) spec = `${root}/src/${spec.slice(7)}`;
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
          if (live.has(`npm:${spec}`)) return { path: `npm:${spec}`, namespace: 'hs-live' };
          if (testPath) return { path: spec, namespace: 'hs-stub' };
          return { errors: [{ text: `${args.path} (imported by ${keyOf(args.importer) ?? args.importer}) isn't a live module: add it to LIVE_DEPS in vite-plugin-hotswap.ts, or keep the import outside the swap set` }] };
        }
        const abs = await resolveFile(normalize(spec.startsWith('/') ? spec : `${dirOf(args.importer)}/${spec}`));
        if (!abs) return { errors: [{ text: `cannot resolve ${args.path} from ${args.importer}` }] };
        if (query !== undefined) {
          if (query === 'raw') return { path: abs, namespace: 'hs-raw' };
          // A Worker or asset URL: the page's own, which the plugin registers
          const qkey = `${keyOf(abs)}?${query}`;
          // The page registers it when the importing module loads: load a lazy importer the page's way
          const importer = keyOf(args.importer);
          if (!live.has(qkey) && importer && loaders.has(importer)) await loaders.get(importer)!().catch(() => {});
          if (live.has(qkey)) return { path: qkey, namespace: 'hs-live' };
          if (testPath) return { path: args.path, namespace: 'hs-stub' };
          return { errors: [{ text: `${args.path}: Vite's ?${query} imports can't be built in the tab and the page doesn't have this one; keep it outside the swap set` }] };
        }
        const key = keyOf(abs);
        if (testPath) return { path: abs, namespace: 'hs-src' };
        if (key && !swapSet.has(key)) {
          // import(): the page's module when the code runs (rewritten below)
          if (args.kind === 'dynamic-import' && (live.has(key) || loaders.has(key))) return { path: `tc-live:${key}`, external: true };
          if (live.has(key)) return { path: key, namespace: 'hs-live' };
          if (loaders.has(key)) { needs.add(key); return { path: key, namespace: 'hs-live' }; }
          copied.add(key);
        }
        return { path: abs, namespace: 'hs-src' };
      });
      build.onLoad({ filter: /.*/, namespace: 'hs-entry' }, () => ({ contents: entry, loader: 'js', resolveDir: root }));
      build.onLoad({ filter: /.*/, namespace: 'hs-empty' }, () => ({ contents: '', loader: 'js' }));
      build.onLoad({ filter: /.*/, namespace: 'hs-raw' }, async (args) => ({
        contents: `export default ${JSON.stringify(await fs.readFile(args.path))};`, loader: 'js',
      }));
      // CommonJS with live getters: esbuild reads named imports as properties at
      // each use, so the bindings stay live. __esModule keeps `default` the module's own.
      build.onLoad({ filter: /.*/, namespace: 'hs-live' }, (args) => ({
        contents: `var m = globalThis.__tabcomputerLive.get(${JSON.stringify(args.path)}), o = { __esModule: true };\n` +
          `if (!m) throw new Error(${JSON.stringify(`hotswap: live module ${args.path} isn't loaded`)});\n` +
          `Object.keys(m).forEach(function (k) { Object.defineProperty(o, k, { enumerable: true, get: function () { return m[k]; } }); });\n` +
          `module.exports = o;\n`,
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'hs-vitest' }, () => ({ contents: 'module.exports = globalThis.__tcTestApi;', loader: 'js' }));
      // A module the tab can't give a test (node:fs): it throws when used, not when imported
      build.onLoad({ filter: /.*/, namespace: 'hs-stub' }, (args) => ({
        contents: `var given = (globalThis.__tcTestNode || {})[${JSON.stringify(args.path.replace(/^node:/, ''))}];\n` +
          `if (given) { module.exports = given; } else {\n` +
          `var msg = ${JSON.stringify(`${args.path} isn't available to tests in the tab`)};\n` +
          `var thrower = new Proxy({}, { get: function (_t, k) { if (k === Symbol.toPrimitive || k === 'then') return undefined; throw new Error(msg + ' (used: ' + String(k) + ')'); } });\n` +
          `module.exports = new Proxy({}, { get: function (_t, k) { return k === '__esModule' ? false : thrower[k]; }, getPrototypeOf: function () { return thrower; } });\n}\n`,
        loader: 'js',
      }));
      build.onLoad({ filter: /.*/, namespace: 'hs-src' }, async (args) => {
        const p = args.path;
        const loader = p.endsWith('.tsx') ? 'tsx' : p.endsWith('.ts') ? 'ts' : p.endsWith('.json') ? 'json' : 'js';
        let contents = await fs.readFile(p);
        // The tests' own files (src/ is built as for the page): import.meta.url is the file's, as under
        // node (new URL('./fixtures/x', import.meta.url)), and they get node's Buffer and process globals
        const testOwn = testPath && loader !== 'json' && !p.startsWith(`${root}/src/`);
        if (testOwn) contents = contents.replace(/\bimport\.meta\.url\b/g, JSON.stringify(`file://${p}`));
        if (testOwn) {
          for (const g of NODE_GLOBALS) {
            if (new RegExp(`\\b${g}\\b`).test(contents) &&
                !new RegExp(`(\\bimport\\b[^;]*\\b${g}\\b[^;]*\\bfrom\\b|\\b(const|let|var|class|function)\\s+${g}\\b)`).test(contents)) {
              contents = `var ${g} = globalThis.__tcTestNode.${g};\n${contents}`;
            }
          }
        }
        const key = keyOf(p);
        if (!testPath && !opts.freshState && key && swapSet.has(key) && loader !== 'json') contents = carryState(contents, key).code;
        return { contents, loader, resolveDir: dirOf(p) };
      });
    },
  };

  const result = await quietDuring(() => (opts.build ?? pageBuild)({
    entryPoints: ['entry'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    keepNames: true,
    logLevel: 'silent',
    legalComments: 'none',
    sourcemap: opts.sourcemap ? 'inline' : false,
    tsconfigRaw,
    define: {
      __BUILD_SHA__: JSON.stringify(pageSha()),
      'import.meta.env.DEV': 'false',
      'import.meta.env.PROD': 'true',
      'import.meta.env.MODE': '"production"',
      'import.meta.env.BASE_URL': '"./"',
      ...(testPath ? testDefines(testPath) : {}),
      ...opts.define,
    },
    plugins: [plugin],
  }));
  for (const w of result.warnings) warnings.push(w.text);
  if (testPath) return { code: result.outputFiles![0].text, hash: '', keys: [], copied: [], needs: [], warnings };
  for (const k of copied) {
    warnings.push(NOT_LIVE.test(k)
      ? `${k} is generated or vendored, which the page doesn't make live, so the bundle has its own copy`
      : `${k} isn't loaded in the page, so the bundle has its own copy (its module state is separate)`);
  }
  const code = `${NEEDS_PREFIX}${JSON.stringify([...needs])}\n` +
    result.outputFiles![0].text.replace(/\bimport\((["'])tc-live:([^"']+)\1\)/g, (_m, _q, key) => `globalThis.__tabcomputerLiveImport(${JSON.stringify(key)})`);
  return { code, hash: await sha256Hex(code), keys, copied: [...copied], needs: [...needs], warnings };
}

function testDefines(file: string): Record<string, string> {
  const d: Record<string, string> = {
    __dirname: JSON.stringify(dirOf(file)),
    __filename: JSON.stringify(file),
  };
  for (const g of TEST_GLOBALS) {
    for (const pre of ['', 'window.', 'globalThis.', 'self.']) d[pre + g] = `globalThis.__tcTestEnv.${g}`;
  }
  return d;
}

function pageSha(): string {
  try { return typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : ''; } catch { return ''; }
}
