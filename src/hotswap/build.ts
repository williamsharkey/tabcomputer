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
import { liveLoaders, liveModules, type LiveLoaders, type LiveMap } from './live';

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
  const root = normalize(opts.root);
  const live = opts.live ?? liveModules();
  const loaders = opts.loaders ?? liveLoaders();
  const needs = new Set<string>();
  const keys = opts.files.map((f) => normalize(f.startsWith('/') ? f : `${root}/${f}`).slice(root.length + 1));
  for (const k of keys) {
    if (k.startsWith('..') || k.startsWith('/')) throw new Error(`${k}: not inside ${root}`);
  }
  const swapSet = new Set(keys);
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

  const entry = keys.map((k, i) => `export * as m${i} from ${JSON.stringify(`${root}/${k}`)};`).join('\n') +
    `\nexport const __keys = ${JSON.stringify(keys)};\n`;

  const plugin: esbuild.Plugin = {
    name: 'tabcomputer-hotswap',
    setup(build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.kind === 'entry-point') return { path: 'entry', namespace: 'hs-entry' };
        const [spec, query] = args.path.split('?');
        if (spec.endsWith('.css')) return { path: spec, namespace: 'hs-empty' };
        if (!spec.startsWith('.') && !spec.startsWith('/')) {
          if (live.has(`npm:${spec}`)) return { path: `npm:${spec}`, namespace: 'hs-live' };
          return { errors: [{ text: `${args.path} (imported by ${keyOf(args.importer) ?? args.importer}) isn't a live module: add it to LIVE_DEPS in vite-plugin-hotswap.ts, or keep the import outside the swap set` }] };
        }
        const abs = await resolveFile(normalize(spec.startsWith('/') ? spec : `${dirOf(args.importer)}/${spec}`));
        if (!abs) return { errors: [{ text: `cannot resolve ${args.path} from ${args.importer}` }] };
        if (query !== undefined) {
          if (query === 'raw') return { path: abs, namespace: 'hs-raw' };
          return { errors: [{ text: `${args.path}: Vite's ?${query} imports can't be built in the tab; keep it outside the swap set` }] };
        }
        const key = keyOf(abs);
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
      build.onLoad({ filter: /.*/, namespace: 'hs-src' }, async (args) => {
        const p = args.path;
        const loader = p.endsWith('.tsx') ? 'tsx' : p.endsWith('.ts') ? 'ts' : p.endsWith('.json') ? 'json' : 'js';
        return { contents: await fs.readFile(p), loader, resolveDir: dirOf(p) };
      });
    },
  };

  const result = await (opts.build ?? pageBuild)({
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
      ...opts.define,
    },
    plugins: [plugin],
  });
  for (const w of result.warnings) warnings.push(w.text);
  for (const k of copied) warnings.push(`${k} isn't loaded in the page, so the bundle has its own copy (its module state is separate)`);
  const code = `${NEEDS_PREFIX}${JSON.stringify([...needs])}\n` +
    result.outputFiles![0].text.replace(/\bimport\((["'])tc-live:([^"']+)\1\)/g, (_m, _q, key) => `globalThis.__tabcomputerLiveImport(${JSON.stringify(key)})`);
  return { code, hash: await sha256Hex(code), keys, copied: [...copied], needs: [...needs], warnings };
}

function pageSha(): string {
  try { return typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : ''; } catch { return ''; }
}
