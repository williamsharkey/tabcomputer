import { createHash } from 'crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import type { Plugin } from 'vite';

/**
 * Content-hashed copies of the engines' wasm (dist/engines/<engine>/<name>.<sha>.wasm)
 * and dist/engines/manifest.json naming them, so a page loads each wasm from a URL
 * that can be cached for good (server.mjs: immutable) and a new build's wasm is a
 * new URL. The plain names stay for older pages and the `doctor` command.
 */
export function hashEngineWasm(): Plugin {
  let outDir = 'dist';
  return {
    name: 'hash-engine-wasm',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      const engines = path.join(outDir, 'engines');
      if (!existsSync(engines)) return;
      const manifest: Record<string, string> = {};
      for (const engine of readdirSync(engines, { withFileTypes: true })) {
        if (!engine.isDirectory()) continue;
        for (const name of readdirSync(path.join(engines, engine.name))) {
          if (!name.endsWith('.wasm') || /\.[0-9a-f]{12}\.wasm$/.test(name)) continue;
          const file = path.join(engines, engine.name, name);
          const sha = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
          const hashed = name.replace(/\.wasm$/, `.${sha}.wasm`);
          copyFileSync(file, path.join(engines, engine.name, hashed));
          manifest[`${engine.name}/${name}`] = `${engine.name}/${hashed}`;
        }
      }
      writeFileSync(path.join(engines, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    },
  };
}

/** The files one Blink engine version is made of (host.mjs loads blink.mjs, which loads blink.wasm and itself again for each guest thread). */
const BLINK_FILES = ['host.mjs', 'blink.mjs', 'blink.wasm'];

/** engines/blink/v-<sha of BLINK_FILES>/ for the engine in public/, or '' without one. */
function blinkVersionDir(root: string): string {
  const dir = path.join(root, 'public', 'engines', 'blink');
  if (!BLINK_FILES.every((f) => existsSync(path.join(dir, f)))) return '';
  const h = createHash('sha256');
  for (const f of BLINK_FILES) h.update(f).update(readFileSync(path.join(dir, f)));
  return `engines/blink/v-${h.digest('hex').slice(0, 12)}/`;
}

/**
 * A copy of the Blink engine in a directory named by its content
 * (dist/engines/blink/v-<sha>/), and that directory compiled into the page as
 * __BLINK_ENGINE_DIR__. A page then runs only the engine it was built with:
 * blink.mjs starts each guest thread's worker from `new URL("blink.mjs",
 * import.meta.url)`, so with plain names a deploy during a long session gave
 * new threads the new blink.mjs next to the old one, and every x86 process
 * trapped with "func is not a function" (#18). release.sh keeps old versions.
 */
export function versionBlinkEngine(): Plugin {
  let root = process.cwd();
  let outDir = 'dist';
  let dir = '';
  return {
    name: 'version-blink-engine',
    apply: 'build',
    config(config) {
      root = path.resolve(config.root ?? process.cwd());
      dir = blinkVersionDir(root);
      return { define: { __BLINK_ENGINE_DIR__: JSON.stringify(dir) } };
    },
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      if (!dir) return;
      const from = path.join(outDir, 'engines', 'blink');
      const to = path.join(outDir, dir);
      mkdirSync(to, { recursive: true });
      for (const f of BLINK_FILES) copyFileSync(path.join(from, f), path.join(to, f));
    },
  };
}
