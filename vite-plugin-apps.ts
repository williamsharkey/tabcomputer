import path from 'path';
import type { Plugin } from 'vite';
// @ts-expect-error a plain .mjs script, shared with the tests
import { writeSiteApps } from './scripts/apps/site-apps.mjs';

/**
 * The apps this site ships (apps/<id>/, docs/APPS.md "Links"): copied to
 * dist/apps/<id>/ and listed with each file's sha256 in dist/apps/index.json,
 * which is what makes `?app=<id>` a curated app that installs without asking.
 */
export function siteApps(): Plugin {
  let outDir = 'dist';
  return {
    name: 'site-apps',
    apply: 'build',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      writeSiteApps(outDir);
    },
  };
}
