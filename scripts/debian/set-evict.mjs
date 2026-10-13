#!/usr/bin/env node
// Package layers (docs/DEBIAN.md "Package layers"): the cap on what all sets
// take on disk together.
//
//   node set-evict.mjs OUT --max-mb N [--keep ID] [--debs DIR --debs-max-mb M] [--specs DIR]
//
// OUT is the directory of sets (TABCOMPUTER_DEBIAN_LAYERS/sets: <key>/layer.json,
// <key>/index-*.json.gz, chunks/). Chunks no index names are deleted (a build
// that failed part-way left them). Then, while the chunks are over N MB, the
// set used longest ago goes: the mtime of its layer.json, which server.mjs
// sets when a tab asks for the set. ID (the set about to be built) and sets
// with a `pinned` file (the ones built at deploy) are never removed. Each set
// keeps its newest two indexes, as toolchain layers do: a tab that applied
// the older one may still fetch its chunks. With --debs, the oldest
// downloaded .debs go until that directory is under M MB. With --specs, the
// builder's spec file (DIR/<key>.json) of each removed set goes with it, and
// so does one a day old whose set was never built (a build that failed).
//
// build-set.sh runs this before a build, under its lock, so nothing here
// races a build. A tab that applied a set which is removed later keeps what
// it has fetched (it fetches a set's chunks in the background after the
// install); a file it never fetched fails to read, and installing the
// packages again builds the set again.
import { gunzipSync } from 'node:zlib';
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';

const SPEC_FILE = /^(p-[0-9a-f]{24})\.json$/;
const SPEC_STALE_MS = 24 * 3600_000;
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export function evictSets(dir, { maxBytes, keepId = '', debs = '', debsMax = 0, specs = '', now = Date.now() }) {
  const chunkDir = join(dir, 'chunks');
  const sets = () => (existsSync(dir) ? readdirSync(dir) : [])
    .filter((d) => existsSync(join(dir, d, 'layer.json')))
    .map((d) => ({ id: d, used: lstatSync(join(dir, d, 'layer.json')).mtimeMs, pinned: existsSync(join(dir, d, 'pinned')) }));
  const removed = [];
  let chunkBytes = 0, chunksDeleted = 0;
  const sweep = () => {
    const live = new Set();
    for (const s of sets()) {
      const indexes = readdirSync(join(dir, s.id)).filter((f) => /^index-[0-9a-f]+\.json\.gz$/.test(f))
        .map((f) => ({ f, t: lstatSync(join(dir, s.id, f)).mtimeMs })).sort((a, b) => b.t - a.t);
      for (const o of indexes.slice(2)) unlinkSync(join(dir, s.id, o.f));
      for (const { f } of indexes.slice(0, 2)) {
        try { for (const c of JSON.parse(gunzipSync(readFileSync(join(dir, s.id, f)))).chunks) live.add(`${c[0]}.gz`); }
        catch { /* an index cut short: its set is built again when asked for */ }
      }
    }
    chunkBytes = 0;
    for (const f of existsSync(chunkDir) ? readdirSync(chunkDir) : []) {
      if (live.has(f)) chunkBytes += lstatSync(join(chunkDir, f)).size;
      else { unlinkSync(join(chunkDir, f)); chunksDeleted++; }
    }
  };
  sweep();
  while (chunkBytes > maxBytes) {
    const oldest = sets().filter((s) => !s.pinned && s.id !== keepId).sort((a, b) => a.used - b.used)[0];
    if (!oldest) break;
    rmSync(join(dir, oldest.id), { recursive: true, force: true });
    removed.push(oldest.id);
    sweep();
  }
  let debsDeleted = 0;
  if (debs && existsSync(debs)) {
    const files = readdirSync(debs).filter((f) => f.endsWith('.deb')).map((f) => ({ f, st: lstatSync(join(debs, f)) })).sort((a, b) => a.st.mtimeMs - b.st.mtimeMs);
    let total = files.reduce((n, x) => n + x.st.size, 0);
    for (const x of files) { if (total <= debsMax) break; unlinkSync(join(debs, x.f)); total -= x.st.size; debsDeleted++; }
  }
  let specsDeleted = 0;
  if (specs && existsSync(specs)) {
    const have = new Set(sets().map((s) => s.id));
    for (const f of readdirSync(specs)) {
      const id = SPEC_FILE.exec(f)?.[1];
      if (!id || id === keepId) continue;
      const gone = removed.includes(id) || (!have.has(id) && now - lstatSync(join(specs, f)).mtimeMs > SPEC_STALE_MS);
      if (gone) { unlinkSync(join(specs, f)); specsDeleted++; }
    }
  }
  return { sets: sets().length, removed, chunkBytes, chunksDeleted, debsDeleted, specsDeleted };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : dflt; };
  const maxBytes = Number(opt('--max-mb', '3072')) * 1e6;
  const keepId = opt('--keep', '');
  const debs = opt('--debs', '');
  const debsMax = Number(opt('--debs-max-mb', '1024')) * 1e6;
  const specs = opt('--specs', '');
  if (!args[0]) { console.error('usage: set-evict.mjs OUT --max-mb N [--keep ID] [--debs DIR --debs-max-mb M] [--specs DIR]'); process.exit(2); }
  console.log(JSON.stringify(evictSets(args[0], { maxBytes, keepId, debs, debsMax, specs })));
}
