import path from 'path';
import fs from 'fs';
import zlib from 'zlib';
import crypto from 'crypto';
import { execSync } from 'child_process';
import type { Plugin } from 'vite';
import { moduleState } from './src/hotswap/state';
import { NOT_LIVE } from './src/hotswap/live';

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

/** `new URL('<literal>', import.meta.url)` in a module's source: the literals, in order */
const META_URL_RE = /\bnew\s+URL\(\s*(['"])([^'"\n]+)\1\s*,\s*import\.meta\.url\s*\)/g;
export function metaUrlLiterals(code: string): string[] {
  return [...code.matchAll(META_URL_RE)].map((m) => m[2]);
}

/**
 * Registrations of the URLs the build gave a module's `new URL('<lit>', import.meta.url)`
 * (#47): Vite rewrites those (a Worker's chunk, an asset's hashed file) before this
 * plugin's post transform sees the code, so the i-th rewritten expression is the i-th
 * literal of the source. Nothing when the counts differ (the bundle then falls back to
 * `lit` against the module's URL: build.ts META_URL_HELPER).
 */
export function liveUrlRegistrations(key: string, literals: string[], transformed: string): string {
  const args = [...transformed.matchAll(/\bnew\s+URL\(\s*((?:"[^"]*"|'[^']*'|\/\*[\s\S]*?\*\/|\([^()]*\)|[^,()])+?)\s*,\s*import\.meta\.url\s*\)/g)].map((m) => m[1]);
  if (!literals.length || args.length !== literals.length) return '';
  return literals.map((lit, i) => `globalThis.__tabcomputerLiveUrls.set(${JSON.stringify(`${key}|${lit}`)}, new URL(${args[i]}, import.meta.url).href);\n`).join('');
}

export function hotswapLiveModules(root: string): Plugin[] {
  const srcDir = path.join(root, 'src') + path.sep;
  /** Each module's `new URL('<lit>', import.meta.url)` literals, from its source before Vite rewrote them */
  const metaLiterals = new Map<string, string[]>();
  const pre: Plugin = {
    name: 'tabcomputer-hotswap-live-urls',
    enforce: 'pre',
    apply: 'build',
    transform(code, id) {
      if (id.includes('?') || id.includes('\0') || !id.startsWith(srcDir) || !/\.(ts|tsx|js|mjs)$/.test(id)) return null;
      const lits = metaUrlLiterals(code);
      if (lits.length) metaLiterals.set(id, lits); else metaLiterals.delete(id);
      return null;
    },
  };
  return [pre, {
    name: 'tabcomputer-hotswap-live',
    enforce: 'post',
    // (dev serves modules by URL; an absolute-path self-import there would load a second copy)
    apply: 'build',
    async transform(code, id) {
      if (id.includes('?') || id.includes('\0')) return null;
      if (!id.startsWith(srcDir) || !/\.(ts|tsx|js|mjs)$/.test(id) || id.endsWith('.d.ts')) return null;
      const key = path.relative(root, id).split(path.sep).join('/');
      if (NOT_LIVE.test(key)) return null;
      let extra = `import * as __tcLiveSelf from ${JSON.stringify(id)};\n` +
        `(globalThis.__tabcomputerLive ??= new Map()).set(${JSON.stringify(key)}, __tcLiveSelf);\n`;
      // Its URL, and the URLs the build gave its `new URL('<lit>', import.meta.url)`s: a
      // swapped or tested copy of it (a blob: module) resolves those through these (#47)
      if (/\bimport\.meta\.url\b/.test(code)) {
        extra += `(globalThis.__tabcomputerLiveUrls ??= new Map()).set(${JSON.stringify(key)}, import.meta.url);\n` +
          liveUrlRegistrations(key, metaLiterals.get(id) ?? [], code);
      }
      LIVE_DEPS.forEach((dep, i) => {
        if (!new RegExp(`\\bfrom\\s*(['"])${dep.replace(/[/.]/g, '\\$&')}\\1`).test(code)) return;
        extra += `import * as __tcLiveDep${i} from ${JSON.stringify(dep)};\n` +
          `globalThis.__tabcomputerLive.set(${JSON.stringify('npm:' + dep)}, __tcLiveDep${i});\n`;
      });
      // Module state (top-level lets and Map/Set/array/object consts): a swap of this
      // module aliases its own copies to these (build.ts carryState)
      const state = moduleState(code);
      if (state.length) {
        extra += `(globalThis.__tabcomputerLiveState ??= new Map()).set(${JSON.stringify(key)}, {` +
          state.map(({ name, mutable }) => `get ${name}() { return ${name}; }${mutable ? `, set ${name}(v) { ${name} = v; }` : ''}`).join(', ') +
          '});\n';
      }
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
        if (NOT_LIVE.test(lazyKey)) continue;
        extra += `(globalThis.__tabcomputerLiveLoaders ??= new Map()).set(${JSON.stringify(lazyKey)}, () => import(${JSON.stringify(m[2])}));\n`;
      }
      return {
        code: `${code}\n${extra}`,
        map: null,
      };
    },
  }];
}

/** What `hotswap checkout` gets: the source of this build (src/hotswap/source.ts) */
// The suites' fixtures are in too (about 200 KB gzipped), for `hotswap test`'s node:fs
const SOURCE_DIRS = ['src', 'profiles', 'tests/tests/shiro-vitest'];
const SOURCE_FILES = ['tsconfig.json', 'package.json', 'build-number.txt', 'vite.config.ts', 'vite-plugin-hotswap.ts', 'AGENTS.md', 'CLAUDE.md', 'docs/HOTSWAP.md', 'docs/DEVELOP_IN_TAB.md'];

/** The tarball's name for a build ('' sha: outside a git checkout) */
export function sourceTarName(sha: string): string {
  // (under assets/: release.sh keeps a week of old assets, so tabs opened before a deploy still find theirs)
  return `assets/hotswap-source-${sha ? sha.slice(0, 12) : 'nogit'}.tar.gz`;
}

function tarHeader(name: string, size: number, type: string): Buffer {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.fill(' ', 148, 156);
  h.write(type, 156);
  h.write('ustar\0' + '00', 257, 'binary');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

export function tar(entries: [string, Buffer][]): Buffer {
  const parts: Buffer[] = [];
  const pad = (n: number) => Buffer.alloc((512 - (n % 512)) % 512);
  for (const [name, data] of entries) {
    if (Buffer.byteLength(name) > 100) {
      const long = Buffer.from(name + '\0');
      parts.push(tarHeader('././@LongLink', long.length, 'L'), long, pad(long.length));
    }
    parts.push(tarHeader(name, data.length, '0'), data, pad(data.length));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const gitBlobSha = (data: Buffer) => crypto.createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

/**
 * Emit the build's own source as assets/hotswap-source-<sha>.tar.gz, with a
 * manifest (.hotswap-source.json: the commit, build number, git blob ids)
 * that `hotswap diff` and `hotswap push` work from.
 */
export function hotswapSource(root: string, sha: string): Plugin {
  return {
    name: 'tabcomputer-hotswap-source',
    apply: 'build',
    generateBundle() {
      let listed: string[];
      try {
        listed = execSync('git ls-files --cached --others --exclude-standard -z', { cwd: root, maxBuffer: 64 << 20 }).toString().split('\0').filter(Boolean);
      } catch {
        return; // not a git checkout: no source tarball
      }
      const files = listed.filter((f) => (SOURCE_FILES.includes(f) || SOURCE_DIRS.some((d) => f.startsWith(d + '/'))))
        .filter((f) => fs.existsSync(path.join(root, f)) && fs.statSync(path.join(root, f)).isFile())
        .sort();
      const entries: [string, Buffer][] = files.map((f) => [f, fs.readFileSync(path.join(root, f))]);
      const build = fs.readFileSync(path.join(root, 'build-number.txt'), 'utf8').trim();
      const manifest = { sha, build, files: Object.fromEntries(entries.map(([f, d]) => [f, gitBlobSha(d)])) };
      entries.unshift(['.hotswap-source.json', Buffer.from(JSON.stringify(manifest, null, 1))]);
      this.emitFile({ type: 'asset', fileName: sourceTarName(sha), source: zlib.gzipSync(tar(entries), { level: 9 }) });
    },
  };
}
