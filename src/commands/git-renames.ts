/**
 * Rename detection for the built-in git's diffs, as git's diffcore-rename
 * does it: a deleted file and an added file with the same blob are a rename
 * (100%); otherwise the pair that shares the most content, when that is at
 * least the threshold (50% unless -M/--find-renames says another).
 *
 * Similarity is git's: both files are cut into lines (64 bytes at most), and
 * the bytes of the source's lines that the destination also has, over the
 * larger file's size.
 */

/** git's MAX_SCORE: scores are fractions of it, so thresholds compare as integers */
export const MAX_SCORE = 60000;
export const DEFAULT_RENAME_SCORE = MAX_SCORE / 2;

/** Above this many candidate pairs, or bytes in one file, only identical files are paired (git's rename limit, smaller: this runs in a page) */
const MAX_PAIRS = 2500;
const MAX_BYTES = 1 << 20;

export interface RenameChange { path: string; status: string; old?: string; new?: string; from?: string; score?: number }

/** Lines of `bytes` (cut at a newline or 64 bytes) → how many bytes of each */
function chunkCounts(bytes: Uint8Array): Map<string, number> {
  const counts = new Map<string, number>();
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] !== 10 && i - start + 1 < 64 && i !== bytes.length - 1) continue;
    // (a key by content: latin1 keeps every byte apart)
    let key = '';
    for (let k = start; k <= i; k++) key += String.fromCharCode(bytes[k]);
    counts.set(key, (counts.get(key) ?? 0) + (i - start + 1));
    start = i + 1;
  }
  return counts;
}

/** How much of `src` is in `dst`, of MAX_SCORE (0 when sizes alone rule out `minScore`) */
export function similarityScore(src: Uint8Array, dst: Uint8Array, minScore = 0): number {
  const max = Math.max(src.length, dst.length), min = Math.min(src.length, dst.length);
  if (!src.length || !dst.length) return 0;
  if (max * (MAX_SCORE - minScore) < (max - min) * MAX_SCORE) return 0;
  const a = chunkCounts(src), b = chunkCounts(dst);
  let copied = 0;
  for (const [key, n] of a) copied += Math.min(n, b.get(key) ?? 0);
  return Math.floor((copied * MAX_SCORE) / max);
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Pair deletions with additions in `changes` (sorted by path). A pair becomes
 * one change at the new path: status 'R', `from`, `score` (of MAX_SCORE),
 * `old` the source's blob. `read` gives a side's bytes (null: unreadable).
 */
export async function detectRenames<T extends RenameChange>(changes: T[], read: (c: T, side: 'old' | 'new') => Promise<Uint8Array | null>, minScore = DEFAULT_RENAME_SCORE): Promise<T[]> {
  const sources = changes.filter((c) => c.status === 'D' && c.old);
  const dests = changes.filter((c) => c.status === 'A' && c.new);
  if (!sources.length || !dests.length) return changes;
  const pairs = new Map<T, { src: T; score: number }>();
  const used = new Set<T>();
  // identical blobs first; the same file name before another
  for (const d of dests) {
    const same = sources.filter((s) => !used.has(s) && s.old === d.new);
    const s = same.find((x) => baseName(x.path) === baseName(d.path)) ?? same[0];
    if (s) { used.add(s); pairs.set(d, { src: s, score: MAX_SCORE }); }
  }
  const restS = sources.filter((s) => !used.has(s)), restD = dests.filter((d) => !pairs.has(d));
  if (minScore < MAX_SCORE && restS.length && restD.length && restS.length * restD.length <= MAX_PAIRS) {
    const bytes = new Map<T, Uint8Array | null>();
    const load = async (c: T, side: 'old' | 'new') => {
      if (!bytes.has(c)) { const b = await read(c, side).catch(() => null); bytes.set(c, b && b.length <= MAX_BYTES ? b : null); }
      return bytes.get(c)!;
    };
    const found: { src: T; dst: T; score: number; name: number }[] = [];
    for (const d of restD) {
      const db = await load(d, 'new');
      if (!db?.length) continue;
      for (const s of restS) {
        const sb = await load(s, 'old');
        if (!sb?.length) continue;
        const score = similarityScore(sb, db, minScore);
        if (score >= minScore) found.push({ src: s, dst: d, score, name: baseName(s.path) === baseName(d.path) ? 1 : 0 });
      }
    }
    // (a stable sort: equal scores stay in path order)
    found.sort((x, y) => y.score - x.score || y.name - x.name);
    for (const f of found) {
      if (used.has(f.src) || pairs.has(f.dst)) continue;
      used.add(f.src);
      pairs.set(f.dst, { src: f.src, score: f.score });
    }
  }
  if (!pairs.size) return changes;
  const out: T[] = [];
  for (const c of changes) {
    if (used.has(c)) continue;
    const p = pairs.get(c);
    out.push(p ? { ...c, status: 'R', from: p.src.path, old: p.src.old, score: p.score } : c);
  }
  return out;
}

/** A score as git prints it: a whole percentage, rounded down */
export const scorePercent = (score: number) => Math.floor((score * 100) / MAX_SCORE);

/** `old => new` as --stat and --numstat write it: what the two paths share is outside the braces (`src/{a.ts => b.ts}`) */
export function renameName(a: string, b: string): string {
  let pfx = 0;
  for (let i = 0; i < a.length && i < b.length && a[i] === b[i]; i++) if (a[i] === '/') pfx = i + 1;
  // the suffix starts at a slash; it may share the prefix's last slash (a/b/c => a/c is a/{b => }/c)
  let sfx = 0;
  const floor = pfx ? pfx - 1 : 0;
  for (let i = a.length - 1, j = b.length - 1; i >= floor && j >= floor && a[i] === b[j]; i--, j--) if (a[i] === '/') sfx = a.length - i;
  if (!pfx && !sfx) return `${a} => ${b}`;
  const mid = (s: string) => s.slice(pfx, Math.max(pfx, s.length - sfx));
  return `${a.slice(0, pfx)}{${mid(a)} => ${mid(b)}}${a.slice(a.length - sfx)}`;
}

/**
 * The rename threshold a diff's options ask for (of MAX_SCORE), or null for
 * no detection: -M, -M90%, -M9 (a fraction, as git: 0.9), --find-renames[=N],
 * --no-renames; `byDefault` is what the command does without any of them.
 */
export function renameThreshold(args: string[], byDefault: boolean): number | null {
  let score: number | null = byDefault ? DEFAULT_RENAME_SCORE : null;
  for (const a of args) {
    if (a === '--') break;
    if (a === '--no-renames') { score = null; continue; }
    const m = /^(?:-M|--find-renames=?|-C|--find-copies=?)(.*)$/.exec(a);
    if (!m || (a.startsWith('--') && !/^--find-(renames|copies)(=|$)/.test(a))) continue;
    const v = m[1];
    if (!v) { score = DEFAULT_RENAME_SCORE; continue; }
    const n = /^(\d+)%$/.exec(v);
    if (n) score = Math.min(MAX_SCORE, Math.floor((Number(n[1]) * MAX_SCORE) / 100));
    else if (/^\d+$/.test(v)) score = Math.min(MAX_SCORE, Math.floor(Number('0.' + v) * MAX_SCORE));
  }
  return score;
}
