/**
 * Brotli copies of the build's largest downloads, made once at build time:
 * `dist/assets/NAME.wasm.br` beside `NAME.wasm`. server.mjs sends the copy
 * to a browser that accepts `br` (its static files are otherwise sent as
 * they are, and nginx in front compresses HTML only).
 *
 * Only PostgreSQL's files (src/postgres/, PGlite): its wasm and data by
 * name, and the script chunks that hold PGlite itself. They are 17.3 MB as
 * they are and 3.9 MB this way.
 */
import type { Plugin } from 'vite';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { brotliCompressSync, constants } from 'node:zlib';

const NAMED = /^(pglite|initdb|pg_dump)-[\w-]+\.(wasm|data)$/;
/** A script chunk is PGlite's when it is large and has this in it */
const PGLITE_SCRIPT = 'execProtocolRawSync';

export function precompress(): Plugin {
  let outDir = 'dist';
  return {
    name: 'tabcomputer-precompress',
    apply: 'build',
    configResolved(config) { outDir = config.build.outDir; },
    closeBundle() {
      const dir = join(outDir, 'assets');
      let names: string[] = [];
      try { names = readdirSync(dir); } catch { return; }
      for (const name of names) {
        if (!NAMED.test(name) && !name.endsWith('.js')) continue;
        const data = readFileSync(join(dir, name));
        if (!NAMED.test(name) && (data.length < 200_000 || !data.includes(PGLITE_SCRIPT))) continue;
        const br = brotliCompressSync(data, {
          params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_LGWIN]: 24, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
        });
        writeFileSync(join(dir, `${name}.br`), br);
        this.info(`${name}: ${data.length} bytes, ${br.length} as brotli`);
      }
    },
  };
}
