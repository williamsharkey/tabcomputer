// The apps this site ships (docs/APPS.md "Links"): every folder of apps/ with an
// app.json, except templates/. A build copies each to dist/apps/<id>/ and lists
// its files with their sha256 in dist/apps/index.json (vite-plugin-apps.ts); the
// page installs `?app=<id>` and `app install <id>` only when every file it
// fetched matches that list (src/apps/links.ts).
//
//   node scripts/apps/site-apps.mjs [OUTDIR]     write OUTDIR/apps (default dist)
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
/** Never shipped: what measures or documents an app rather than being it */
const SKIP = new Set(['measure', 'test', 'tests', 'node_modules', 'README.md', 'package.json', 'package-lock.json']);

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    if (name.startsWith('.') || (dir === base && SKIP.has(name))) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, base, out); else out.push(p.slice(base.length + 1).split('\\').join('/'));
  }
  return out;
}

/** [{ id, name, description, version, dir, files: [{ path, sha256, size }] }] */
export function siteApps(root = ROOT) {
  const appsDir = join(root, 'apps');
  if (!existsSync(appsDir)) return [];
  const out = [];
  for (const id of readdirSync(appsDir).sort()) {
    const dir = join(appsDir, id);
    if (id === 'templates' || !existsSync(join(dir, 'app.json'))) continue;
    const m = JSON.parse(readFileSync(join(dir, 'app.json'), 'utf8'));
    if (m.id !== id) throw new Error(`apps/${id}/app.json has the id ${JSON.stringify(m.id)}: the folder's name must be the id`);
    const files = walk(dir).map((path) => {
      const bytes = readFileSync(join(dir, path));
      return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
    });
    out.push({ id, name: m.name, description: m.description ?? '', version: m.version ?? '', dir, files });
  }
  return out;
}

/** Write OUTDIR/apps/index.json and each app's files */
export function writeSiteApps(outDir, root = ROOT) {
  const apps = siteApps(root);
  const dest = join(outDir, 'apps');
  mkdirSync(dest, { recursive: true });
  for (const app of apps) {
    for (const f of app.files) {
      const to = join(dest, app.id, f.path);
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(app.dir, f.path)));
    }
  }
  writeFileSync(join(dest, 'index.json'), JSON.stringify({ format: 1, apps: apps.map(({ dir, ...a }) => a) }, null, 1) + '\n');
  return apps;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const apps = writeSiteApps(resolve(process.argv[2] || join(ROOT, 'dist')));
  console.log(`apps: ${apps.map((a) => `${a.id} (${a.files.length} files)`).join(', ') || 'none'}`);
}
