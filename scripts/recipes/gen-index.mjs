// public/recipes/index.json: the curated recipes a run link may run without
// asking (docs/RUN_LINKS.md), from the header comments of public/recipes/*.sh.
// The page runs `?run=<name>` only when this list has the name and the sha256
// of the file it fetched, so regenerate it after changing a recipe:
//
//   node scripts/recipes/gen-index.mjs           write it
//   node scripts/recipes/gen-index.mjs --check   exit 1 if it is out of date
//
// recipes-index.test.ts checks the same thing with the page's own parser.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const dir = new URL('../../public/recipes/', import.meta.url);
const KEYS = ['title', 'for', 'needs', 'first-run', 'later', 'args', 'on-open', 'profile', 'status'];

/** `# key: value` lines of the comment block at the top (parseRecipeHeader in src/run-url.ts) */
function header(text) {
  const h = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('#')) { if (line.trim()) break; continue; }
    const m = /^#\s*([a-z][a-z-]*):\s*(.*?)\s*$/.exec(line);
    if (m && KEYS.includes(m[1]) && h[m[1]] === undefined && m[2]) h[m[1]] = m[2];
  }
  return h;
}

const recipes = readdirSync(dir).filter((f) => /^[a-z0-9][a-z0-9-]*\.sh$/.test(f)).sort().map((f) => {
  const bytes = readFileSync(new URL(f, dir));
  const h = header(bytes.toString('utf8'));
  if (!h.title) throw new Error(`${f}: no "# title:" header`);
  return { name: f.slice(0, -3), sha256: createHash('sha256').update(bytes).digest('hex'), ...h };
});
const out = JSON.stringify({ format: 1, recipes }, null, 1) + '\n';
const path = new URL('index.json', dir);
if (process.argv.includes('--check')) {
  let now = '';
  try { now = readFileSync(path, 'utf8'); } catch { /* missing */ }
  if (now !== out) { console.error('public/recipes/index.json is out of date: node scripts/recipes/gen-index.mjs'); process.exit(1); }
} else {
  writeFileSync(path, out);
  console.log(`recipes: ${recipes.map((r) => r.name).join(', ')}`);
}
