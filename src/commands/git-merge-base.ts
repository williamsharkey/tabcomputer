/**
 * Merge bases for the built-in git (tabcomputer#131).
 *
 * isomorphic-git's findMergeBase returns the first commit two breadth-first
 * walkers both reach, which after an earlier merge can be an ancestor of the
 * real base: `git merge` then saw changes that were already merged and
 * reported conflicts git doesn't.
 *
 * mergeBases() is git's own walk (commit-reach.c, paint_down_to_common): the
 * best common ancestors, as `git merge-base --all` prints them. With several
 * (a criss-cross), baseTree() merges them into one virtual base as git's
 * default strategy does: oldest first, each merge based on the two bases' own
 * (possibly virtual) base, conflicts left in the file with markers.
 *
 * merge() is git.merge with that base. isomorphic-git's merge takes no base,
 * so when its own answer differs the two sides are merged as three stand-in
 * commits (the base's tree, then each side's tree as its child) and the result
 * committed with the real parents. The stand-ins and the merge commit made
 * from them stay in .git/objects, unreachable.
 */
import git, { TREE } from './git-cached';
import { diffEdits } from './git-utils';

type Fs = any;
interface Node { parent: string[]; tree: string; time: number }
interface Entry { mode: string; path: string; oid: string; type: string }
/** A walk's commits: the repository's, and the virtual ones of a criss-cross */
export interface BaseWalk { fs: Fs; dir: string; nodes: Map<string, Node | null>; virtual: number }

const PARENT1 = 1, PARENT2 = 2, STALE = 4, RESULT = 8;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function baseWalk(fs: Fs, dir: string): BaseWalk {
  return { fs, dir, nodes: new Map(), virtual: 0 };
}

async function node(w: BaseWalk, oid: string): Promise<Node | null> {
  if (w.nodes.has(oid)) return w.nodes.get(oid)!;
  let n: Node | null = null;
  try {
    const { commit } = await git.readCommit({ fs: w.fs, dir: w.dir, oid });
    n = { parent: commit.parent ?? [], tree: commit.tree, time: (commit.committer ?? commit.author).timestamp };
  } catch { n = null; } // (a shallow clone's boundary: no parents known)
  w.nodes.set(oid, n);
  return n;
}

/** Common ancestors of `one` and `twos` that no other one reaches, newest first (stale ones included) */
async function paint(w: BaseWalk, one: string, twos: string[]): Promise<{ found: string[]; flags: Map<string, number> }> {
  const flags = new Map<string, number>();
  // (git's priority queue: newest commit first, the earlier insertion among equals)
  const queue: { oid: string; time: number; n: number }[] = [];
  let n = 0;
  const push = async (oid: string) => { queue.push({ oid, time: (await node(w, oid))?.time ?? 0, n: n++ }); };
  flags.set(one, PARENT1);
  await push(one);
  for (const two of twos) {
    flags.set(two, (flags.get(two) ?? 0) | PARENT2);
    await push(two);
  }
  const found: { oid: string; time: number }[] = [];
  while (queue.some((e) => !(flags.get(e.oid)! & STALE))) {
    let at = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i].time > queue[at].time || (queue[i].time === queue[at].time && queue[i].n < queue[at].n)) at = i;
    }
    const e = queue.splice(at, 1)[0];
    let f = flags.get(e.oid)! & (PARENT1 | PARENT2 | STALE);
    if (f === (PARENT1 | PARENT2)) {
      if (!(flags.get(e.oid)! & RESULT)) {
        flags.set(e.oid, flags.get(e.oid)! | RESULT);
        let i = 0;
        while (i < found.length && found[i].time >= e.time) i++;
        found.splice(i, 0, { oid: e.oid, time: e.time });
      }
      // (what this commit reaches is common too, and not a best ancestor)
      f |= STALE;
    }
    for (const p of (await node(w, e.oid))?.parent ?? []) {
      const pf = flags.get(p) ?? 0;
      if ((pf & f) === f) continue;
      flags.set(p, pf | f);
      await push(p);
    }
  }
  return { found: found.map((x) => x.oid), flags };
}

/**
 * The best common ancestors of `one` and (a merge of) `twos`, newest first:
 * `git merge-base --all one twos...`. Empty for unrelated histories.
 */
export async function mergeBases(w: BaseWalk, one: string, twos: string[]): Promise<string[]> {
  if (twos.includes(one)) return [one];
  const { found, flags } = await paint(w, one, twos);
  const bases = found.filter((oid) => !(flags.get(oid)! & STALE));
  if (bases.length < 2) return bases;
  // (commit dates out of order can leave an ancestor of another base in the list: git's remove_redundant)
  const keep: string[] = [];
  for (const b of bases) {
    let redundant = false;
    for (const other of bases) {
      if (other === b) continue;
      const r = await paint(w, other, [b]);
      if (r.found.includes(b) && !(r.flags.get(b)! & STALE)) { redundant = true; break; }
    }
    if (!redundant) keep.push(b);
  }
  return keep;
}

/** Whether `ancestor` is `oid` or one of its ancestors */
export async function isAncestor(w: BaseWalk, ancestor: string, oid: string): Promise<boolean> {
  return (await mergeBases(w, oid, [ancestor]))[0] === ancestor;
}

/** Every commit `oids` reach */
export async function reachable(w: BaseWalk, oids: string[]): Promise<Set<string>> {
  const seen = new Set<string>();
  const stack = [...oids];
  while (stack.length) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    stack.push(...((await node(w, oid))?.parent ?? []));
  }
  return seen;
}

/**
 * The tree to merge `a` and `b` against: their merge base's, or with several
 * bases the tree of their merge (git's recursive / ort virtual base). null for
 * unrelated histories.
 */
export async function baseTree(w: BaseWalk, a: string, b: string, depth = 0): Promise<{ tree: string | null; bases: string[] }> {
  const bases = await mergeBases(w, a, [b]);
  if (!bases.length) return { tree: null, bases };
  // (git merges them oldest first)
  let prev = bases[bases.length - 1];
  for (let i = bases.length - 2; i >= 0; i--) {
    const next = bases[i];
    const inner = (await baseTree(w, prev, next, depth + 1)).tree;
    const tree = await mergeDir(w, inner, (await node(w, prev))!.tree, (await node(w, next))!.tree, depth + 1) ?? EMPTY_TREE;
    const id = `virtual-${w.virtual++}`;
    w.nodes.set(id, { parent: [prev, next], tree, time: 0 });
    prev = id;
  }
  return { tree: (await node(w, prev))!.tree, bases };
}

// ── The merge of two bases: never stops, a conflict stays in the file ─────

const same = (x?: Entry, y?: Entry) => x?.oid === y?.oid && x?.mode === y?.mode;
const regular = (e?: Entry) => !!e && e.mode.startsWith('100');

async function entries(w: BaseWalk, oid: string | null): Promise<Map<string, Entry>> {
  const map = new Map<string, Entry>();
  if (!oid || oid === EMPTY_TREE) return map;
  for (const e of (await git.readTree({ fs: w.fs, dir: w.dir, oid })).tree) map.set(e.path, e as Entry);
  return map;
}

/** Trees `a` and `b` merged against `o` → a tree oid (null: nothing left) */
async function mergeDir(w: BaseWalk, o: string | null, a: string | null, b: string | null, depth: number): Promise<string | null> {
  if (a === b || b === o) return a;
  if (a === o) return b;
  const [O, A, B] = await Promise.all([entries(w, o), entries(w, a), entries(w, b)]);
  const out: Entry[] = [];
  for (const name of new Set([...O.keys(), ...A.keys(), ...B.keys()])) {
    const all = [O.get(name), A.get(name), B.get(name)];
    const [to, ta, tb] = all.map((e) => (e?.type === 'tree' ? e.oid : null));
    const [fo, fa, fb] = all.map((e) => (e?.type === 'tree' ? undefined : e));
    const sub = to || ta || tb ? await mergeDir(w, to, ta, tb, depth) : null;
    // (a file on one side and a directory on the other: the directory stays; git renames the file)
    if (sub) out.push({ mode: '040000', path: name, oid: sub, type: 'tree' });
    else {
      const file = await mergeEntry(w, fo, fa, fb, depth);
      if (file) out.push({ ...file, path: name });
    }
  }
  if (!out.length) return null;
  return git.writeTree({ fs: w.fs, dir: w.dir, tree: out as any });
}

async function mergeEntry(w: BaseWalk, o: Entry | undefined, a: Entry | undefined, b: Entry | undefined, depth: number): Promise<Entry | undefined> {
  if (same(a, b) || same(b, o)) return a;
  if (same(a, o)) return b;
  // changed on one side and deleted on the other: the base's version, as git takes for a virtual base
  if (!a || !b) return o;
  // (links and submodules are not merged by content)
  if (!regular(a) || !regular(b)) return o ?? a;
  const base = regular(o) ? o : undefined;
  const mode = base && a.mode === base.mode ? b.mode : a.mode;
  if (a.oid === b.oid || b.oid === base?.oid) return { ...a, mode };
  if (a.oid === base?.oid) return { ...b, mode };
  const read = async (e?: Entry) => (e ? (await git.readBlob({ fs: w.fs, dir: w.dir, oid: e.oid })).blob : new Uint8Array(0));
  const [bo, ba, bb] = await Promise.all([read(base), read(a), read(b)]);
  if ([bo, ba, bb].some((x) => x.subarray(0, 8000).includes(0))) return { ...(base ?? a), mode };
  const text = (x: Uint8Array) => new TextDecoder().decode(x);
  const merged = mergeText(text(bo), text(ba), text(bb), 7 + 2 * depth);
  const oid = await git.writeBlob({ fs: w.fs, dir: w.dir, blob: new TextEncoder().encode(merged) });
  return { ...a, mode, oid };
}

const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

/** For each line of `o`, the line of `x` it is kept as (-1: none) */
function kept(o: string[], x: string[]): number[] {
  const map = new Array<number>(o.length).fill(-1);
  let i = 0, j = 0;
  for (const e of diffEdits(o, x)) {
    if (e === 0) map[i++] = j++;
    else if (e < 0) i++;
    else j++;
  }
  return map;
}

/** A three-way merge of text; where both sides changed the same lines differently, both with markers */
export function mergeText(base: string, ours: string, theirs: string, marker = 7, names = ['Temporary merge branch 1', 'Temporary merge branch 2']): string {
  const o = lines(base), a = lines(ours), b = lines(theirs);
  const ka = kept(o, a), kb = kept(o, b);
  const eol = (l: string[]) => { const s = l.join(''); return s && !s.endsWith('\n') ? s + '\n' : s; };
  let out = '';
  let io = 0, ia = 0, ib = 0;
  while (io < o.length || ia < a.length || ib < b.length) {
    if (io < o.length && ka[io] === ia && kb[io] === ib) { out += a[ia]; io++; ia++; ib++; continue; }
    // the changed stretch: up to the next base line both sides keep
    let no = io;
    while (no < o.length && (ka[no] < 0 || kb[no] < 0)) no++;
    const na = no < o.length ? ka[no] : a.length, nb = no < o.length ? kb[no] : b.length;
    const O = o.slice(io, no).join('');
    let A = a.slice(ia, na), B = b.slice(ib, nb);
    if (A.join('') === B.join('') || B.join('') === O) out += A.join('');
    else if (A.join('') === O) out += B.join('');
    else {
      // (lines both sides begin or end the stretch with are not part of the conflict)
      let pre = 0;
      while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
      let suf = 0;
      while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
      const tail = A.slice(A.length - suf).join('');
      out += A.slice(0, pre).join('');
      A = A.slice(pre, A.length - suf); B = B.slice(pre, B.length - suf);
      out += `${'<'.repeat(marker)} ${names[0]}\n${eol(A)}${'='.repeat(marker)}\n${eol(B)}${'>'.repeat(marker)} ${names[1]}\n${tail}`;
    }
    io = no; ia = na; ib = nb;
  }
  return out;
}

// ── git.merge with that base ──────────────────────────────────────────────

export interface MergeOptions {
  fs: Fs; dir: string;
  /** our branch, by name */
  ours: string;
  /** their branch, ref or commit */
  theirs: string;
  fastForward?: boolean; fastForwardOnly?: boolean; abortOnConflict?: boolean;
  message?: string; author?: any; committer?: any;
}

const coded = (code: string, message: string) => Object.assign(new Error(message), { code });
const short = (ref: string) => ref.replace(/^refs\/(heads|tags|remotes)\//, '');
const STAND_IN = { name: 'tabcomputer', email: 'merge-base@tabcomputer', timestamp: 0, timezoneOffset: 0 };

/**
 * isomorphic-git's merge on the right base. Results and errors are git.merge's
 * (MergeConflictError, MergeNotSupportedError, FastForwardError), and
 * UnrelatedHistoriesError when the two share no commit.
 */
export async function merge(o: MergeOptions): Promise<{ oid?: string; tree?: string; alreadyMerged?: boolean; fastForward?: boolean; mergeCommit?: boolean }> {
  const { fs, dir } = o;
  const ourRef = await git.expandRef({ fs, dir, ref: o.ours });
  const ourOid = await git.resolveRef({ fs, dir, ref: ourRef });
  const theirOid = await git.resolveRef({ fs, dir, ref: o.theirs });
  const w = baseWalk(fs, dir);
  const { tree: base, bases } = await baseTree(w, ourOid, theirOid);
  if (bases[0] === theirOid) return { oid: ourOid, alreadyMerged: true };
  if (bases[0] === ourOid && o.fastForward !== false) {
    await git.writeRef({ fs, dir, ref: ourRef, value: theirOid, force: true });
    return { oid: theirOid, fastForward: true };
  }
  if (o.fastForwardOnly) throw coded('FastForwardError', 'A simple fast-forward merge was not possible.');
  if (!base) throw coded('UnrelatedHistoriesError', 'refusing to merge unrelated histories');
  const common = {
    fs, dir, fastForward: false, abortOnConflict: o.abortOnConflict ?? true,
    ...(o.message ? { message: o.message } : {}), ...(o.author ? { author: o.author } : {}), ...(o.committer ? { committer: o.committer } : {}),
  };
  const root = dir === '/' ? '' : dir;
  // A merge that stops on a conflict writes the merged files and stages the conflicts, but
  // leaves the files the other side deleted: they go here, or the commit that resolves the
  // conflict would keep them
  const deletions = async (e: any) => {
    if (e?.code !== 'MergeConflictError' || o.abortOnConflict !== false) return;
    const gone: string[] = (await git.walk({
      fs, dir, trees: [TREE({ ref: base }), TREE({ ref: ourOid }), TREE({ ref: theirOid })],
      map: async (path: string, [B, O, T]: any[]) => {
        if (path === '.' || !B || !O || T || (await O.type()) !== 'blob') return undefined;
        return (await B.oid()) === (await O.oid()) && (await B.mode()) === (await O.mode()) ? path : undefined;
      },
    })).flat(Infinity).filter(Boolean);
    for (const path of gone) {
      await fs.promises.unlink(`${root}/${path}`).catch(() => {});
      await git.remove({ fs, dir, filepath: path });
      for (let d = path; (d = d.slice(0, d.lastIndexOf('/'))) !== '';) {
        if (await fs.promises.rmdir(`${root}/${d}`).then(() => false, () => true)) break;
      }
    }
  };
  const iso = await git.findMergeBase({ fs, dir, oids: [ourOid, theirOid] }).catch(() => [] as string[]);
  if (bases.length === 1 && iso.length === 1 && iso[0] === bases[0]) {
    try {
      return await git.merge({ ...common, ours: o.ours, theirs: o.theirs });
    } catch (e) {
      await deletions(e);
      throw e;
    }
  }
  const standIn = (tree: string, parent: string[], message: string) =>
    git.writeCommit({ fs, dir, commit: { tree, parent, message, author: STAND_IN, committer: STAND_IN } });
  const b = await standIn(base, [], 'merge base\n');
  const ours = await standIn((await node(w, ourOid))!.tree, [b], 'ours\n');
  const them = await standIn((await node(w, theirOid))!.tree, [b], 'theirs\n');
  const message = o.message ?? `Merge branch '${short(o.theirs)}' into ${short(ourRef)}`;
  let made;
  try {
    made = await git.merge({ ...common, message, ours, theirs: them, noUpdateBranch: true });
  } catch (e: any) {
    await deletions(e);
    // the markers name the branches, not the stand-ins
    if (e?.code === 'MergeConflictError' && o.abortOnConflict === false) for (const f of e.data?.bothModified ?? []) {
      const text = await fs.promises.readFile(`${root}/${f}`, 'utf8').catch(() => null) as string | null;
      if (text !== null) await fs.promises.writeFile(`${root}/${f}`, text.split(`<<<<<<< ${ours}\n`).join(`<<<<<<< ${short(ourRef)}\n`).split(`>>>>>>> ${them}\n`).join(`>>>>>>> ${short(o.theirs)}\n`));
    }
    throw e;
  }
  const oid = await git.commit({
    fs, dir, ref: ourRef, tree: made.tree, parent: [ourOid, theirOid], message,
    ...(o.author ? { author: o.author } : {}), ...(o.committer ? { committer: o.committer } : {}),
  });
  return { oid, tree: made.tree, mergeCommit: true };
}
