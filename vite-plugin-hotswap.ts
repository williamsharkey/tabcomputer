import path from 'path';
import type { Plugin } from 'vite';

/**
 * The live module map for hot-swapping (src/hotswap/, docs/HOTSWAP.md): every
 * module under src/ registers its own namespace in
 * `globalThis.__tabcomputerLive` under its path ('src/shell.ts'), so a swap
 * bundle built in the tab imports the page's live modules (the same
 * registry, kernel, fs singletons) instead of fresh copies.
 *
 * A module importing itself is valid ESM: the namespace is the live one.
 */
/** npm modules registered as 'npm:NAME' where src/ imports them (a swap bundle can import these) */
const LIVE_DEPS = ['@xterm/xterm', '@xterm/addon-fit', '@xterm/addon-unicode11', 'acorn', 'pako', 'isomorphic-git', 'isomorphic-git/http/web', 'esbuild-wasm'];

export function hotswapLiveModules(root: string): Plugin {
  const srcDir = path.join(root, 'src') + path.sep;
  return {
    name: 'tabcomputer-hotswap-live',
    enforce: 'post',
    // (dev serves modules by URL; an absolute-path self-import there would load a second copy)
    apply: 'build',
    async transform(code, id) {
      if (id.includes('?') || id.includes('\0')) return null;
      if (!id.startsWith(srcDir) || !/\.(ts|tsx|js|mjs)$/.test(id) || id.endsWith('.d.ts')) return null;
      const key = path.relative(root, id).split(path.sep).join('/');
      let extra = `import * as __tcLiveSelf from ${JSON.stringify(id)};\n` +
        `(globalThis.__tabcomputerLive ??= new Map()).set(${JSON.stringify(key)}, __tcLiveSelf);\n`;
      LIVE_DEPS.forEach((dep, i) => {
        if (!new RegExp(`\\bfrom\\s*(['"])${dep.replace(/[/.]/g, '\\$&')}\\1`).test(code)) return;
        extra += `import * as __tcLiveDep${i} from ${JSON.stringify(dep)};\n` +
          `globalThis.__tabcomputerLive.set(${JSON.stringify('npm:' + dep)}, __tcLiveDep${i});\n`;
      });
      // Vite query imports (a Worker, an asset URL): registered as 'src/x.ts?worker&inline'
      let q = 0;
      for (const m of code.matchAll(/\bfrom\s*(['"])(\.{1,2}\/[^'"?]+)\?((?:worker|sharedworker|url)[^'"]*)\1/g)) {
        const r = await this.resolve(m[2], id);
        if (!r || r.external || !r.id.startsWith(srcDir)) continue;
        const base = path.relative(root, r.id.split('?')[0]).split(path.sep).join('/');
        extra += `import * as __tcLiveQ${q} from ${JSON.stringify(`${m[2]}?${m[3]}`)};\n` +
          `globalThis.__tabcomputerLive.set(${JSON.stringify(`${base}?${m[3]}`)}, __tcLiveQ${q++});\n`;
      }
      // Loaders for the lazy modules this one imports (the same import() it already
      // has, so chunking doesn't change): a swap can load them the page's way
      const seen = new Set<string>();
      for (const m of code.matchAll(/import\(\s*(['"])(\.{1,2}\/[^'"?]+)\1\s*\)/g)) {
        if (seen.has(m[2])) continue;
        seen.add(m[2]);
        const r = await this.resolve(m[2], id);
        if (!r || r.external || r.id.includes('?') || !r.id.startsWith(srcDir)) continue;
        const lazyKey = path.relative(root, r.id).split(path.sep).join('/');
        extra += `(globalThis.__tabcomputerLiveLoaders ??= new Map()).set(${JSON.stringify(lazyKey)}, () => import(${JSON.stringify(m[2])}));\n`;
      }
      return {
        code: `${code}\n${extra}`,
        map: null,
      };
    },
  };
}
