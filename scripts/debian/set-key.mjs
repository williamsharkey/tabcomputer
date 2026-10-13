#!/usr/bin/env node
// Package layers (docs/DEBIAN.md "Package layers"): a set's key, and the
// builder's spec files for the sets built ahead.
//
//   node set-key.mjs key BASE_DIR PACKAGE...            → the key
//   node set-key.mjs specs BASE_DIR SETS.json OUT_DIR   → writes OUT_DIR/<key>.json per set of
//                                                         src/debian/package-sets.json, prints "<key> <file>" lines
//
// The key is the base rootfs, its snapshot and the sorted names, as
// server.mjs computes it (packageSetKey there; package-layers.test.ts checks
// that the two agree). BASE_DIR is the packed base (public/debian).
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** A Debian binary package name (Debian policy 5.6.1), at most 63 characters. */
export const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,62}$/;

export function setKey(baseId, snapshot, names) {
  return 'p-' + createHash('sha256').update(`${baseId}\n${snapshot}\n${[...names].sort().join(' ')}\n`).digest('hex').slice(0, 24);
}

/** The builder's spec for one set: a toolchains.json with the one layer. */
export function setSpec(key, names) {
  return { format: 1, layers: { [key]: { title: names.join(', '), description: 'Debian packages', packages: names } } };
}

function names(list) {
  const out = [...new Set(list)].sort();
  for (const n of out) if (typeof n !== 'string' || !PACKAGE_NAME.test(n)) throw new Error(`"${n}" is not a Debian package name`);
  if (!out.length) throw new Error('a set names at least one package');
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, baseDir, ...rest] = process.argv.slice(2);
  try {
    const base = JSON.parse(readFileSync(join(baseDir ?? '', 'rootfs.json'), 'utf8'));
    if (cmd === 'key') console.log(setKey(base.id, base.snapshot, names(rest)));
    else if (cmd === 'specs') {
      const [setsFile, outDir] = rest;
      mkdirSync(outDir, { recursive: true });
      for (const set of JSON.parse(readFileSync(setsFile, 'utf8')).sets) {
        const n = names(set);
        const key = setKey(base.id, base.snapshot, n);
        const file = join(outDir, `${key}.json`);
        writeFileSync(file, JSON.stringify(setSpec(key, n)) + '\n');
        console.log(`${key} ${file}`);
      }
    } else { console.error('usage: set-key.mjs key BASE_DIR PACKAGE... | specs BASE_DIR SETS.json OUT_DIR'); process.exit(2); }
  } catch (e) { console.error(`set-key.mjs: ${e.message}`); process.exit(1); }
}
