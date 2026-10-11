/**
 * The built-in git's work-tree commands, as git does them: rm, mv, restore,
 * clean and reset. Pathspecs are files, directories (everything under them),
 * `.`, or globs (`*` crosses `/`, as git's), relative to the working directory.
 */
import git from './git-cached';
import type { CommandContext } from './index';
import { pathEntries, resolveSpec, isIgnoredPath, headCommitOid, branchName, unmergedPaths, repoPath, pathspec, type PathEntry } from './git-plumbing';

type Fs = any;

const MISMATCH = (spec: string) => `error: pathspec '${spec}' did not match any file(s) known to git\n`;

async function writeWork(ctx: CommandContext, fs: Fs, dir: string, path: string, oid: string, mode?: number): Promise<void> {
  const { blob } = await git.readBlob({ fs, dir, oid });
  const abs = `${dir === '/' ? '' : dir}/${path}`;
  const parent = abs.slice(0, abs.lastIndexOf('/')) || '/';
  await ctx.fs.mkdir(parent, { recursive: true }).catch(() => {});
  await ctx.fs.writeFile(abs, blob);
  if (mode === 0o100755) await ctx.fs.chmod(abs, 0o755).catch(() => {});
}

/** Remove a work-tree file, then its directories as they empty (git leaves no empty directory behind) */
async function removeWork(ctx: CommandContext, dir: string, path: string): Promise<void> {
  const root = dir === '/' ? '' : dir;
  await ctx.fs.unlink(`${root}/${path}`).catch(() => {});
  let d = path.slice(0, path.lastIndexOf('/'));
  while (d) {
    const abs = `${root}/${d}`;
    const left = await ctx.fs.readdir(abs).catch(() => null);
    if (!left || left.length) break;
    await ctx.fs.rmdir(abs).catch(() => {});
    d = d.slice(0, d.lastIndexOf('/'));
  }
}

/** The index entry for `path` set to a blob (no work-tree file needed) */
async function stageBlob(fs: Fs, dir: string, path: string, oid: string, mode: number): Promise<void> {
  await git.updateIndex({ fs, dir, filepath: path, oid, mode, add: true, force: true });
}

const prefixOf = (dir: string, workDir: string) => (workDir === dir ? '' : workDir.slice(dir === '/' ? 1 : dir.length + 1) + '/');
const usage = (ctx: CommandContext, msg: string) => { ctx.stderr += `fatal: ${msg}\n`; return 128; };

// ── rm ────────────────────────────────────────────────────────────────────

export async function gitRm(ctx: CommandContext, fs: Fs, dir: string, workDir: string): Promise<number> {
  const prefix = prefixOf(dir, workDir);
  let recursive = false, force = false, cached = false, quiet = false, dry = false, ignoreUnmatch = false;
  const specs: string[] = [];
  const args = ctx.args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { specs.push(...args.slice(i + 1)); break; }
    if (a === '--cached') cached = true;
    else if (a === '--force') force = true;
    else if (a === '--quiet') quiet = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--ignore-unmatch') ignoreUnmatch = true;
    else if (/^-[rfqn]+$/.test(a)) for (const c of a.slice(1)) { if (c === 'r') recursive = true; else if (c === 'f') force = true; else if (c === 'q') quiet = true; else dry = true; }
    else specs.push(a);
  }
  if (!specs.length) return usage(ctx, 'No pathspec was given. Which files should I remove?');
  const ents = (await pathEntries(fs, dir, true)).filter((e) => e.stage);
  const chosen = new Map<string, PathEntry>();
  for (const spec of specs) {
    const full = repoPath(prefix, spec);
    const hits = ents.filter((e) => pathspec(prefix, spec)(e.path));
    if (!hits.length) { if (ignoreUnmatch) continue; return usage(ctx, `pathspec '${spec}' did not match any files`); }
    if (!recursive && hits.some((e) => e.path !== full) && !/[*?[]/.test(full)) return usage(ctx, `not removing '${spec}' recursively without -r`);
    for (const e of hits) chosen.set(e.path, e);
  }
  if (!force) {
    // what git won't throw away: staged content unlike both HEAD and the file (--cached), or any change (without)
    const staged: string[] = [], local: string[] = [];
    for (const e of chosen.values()) {
      const s = e.stage!.oid, h = e.head?.oid, w = e.work?.oid;
      if (cached) { if (h !== s && w !== undefined && w !== s) staged.push(e.path); }
      else if (h !== s) staged.push(e.path);
      else if (w !== undefined && w !== s) local.push(e.path);
    }
    const complain = (list: string[], what: string) => {
      ctx.stderr += `error: the following file${list.length === 1 ? ' has' : 's have'} ${what}:\n${list.map((p) => `    ${p}\n`).join('')}`
        + (cached ? '(use -f to force removal)\n' : '(use --cached to keep the file, or -f to force removal)\n');
    };
    if (staged.length) complain(staged, cached ? 'staged content different from both the\nfile and the HEAD' : 'changes staged in the index');
    if (local.length) complain(local, 'local modifications');
    if (staged.length || local.length) return 1;
  }
  for (const p of [...chosen.keys()].sort()) {
    if (!quiet) ctx.stdout += `rm '${p}'\n`;
    if (dry) continue;
    await git.remove({ fs, dir, filepath: p });
    if (!cached) await removeWork(ctx, dir, p);
  }
  return 0;
}

// ── mv ────────────────────────────────────────────────────────────────────

export async function gitMv(ctx: CommandContext, fs: Fs, dir: string, workDir: string): Promise<number> {
  const prefix = prefixOf(dir, workDir);
  let force = false, skip = false, dry = false, verbose = false;
  const names: string[] = [];
  const args = ctx.args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { names.push(...args.slice(i + 1)); break; }
    if (a === '--force') force = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--verbose') verbose = true;
    else if (/^-[fknv]+$/.test(a)) for (const c of a.slice(1)) { if (c === 'f') force = true; else if (c === 'k') skip = true; else if (c === 'n') dry = true; else verbose = true; }
    else names.push(a);
  }
  if (names.length < 2) { ctx.stderr += 'usage: git mv [<options>] <source>... <destination>\n'; return 129; }
  const destSpec = names.pop()!;
  const dest = repoPath(prefix, destSpec);
  const root = dir === '/' ? '' : dir;
  const destIsDir = await ctx.fs.stat(`${root}/${dest}`).then((s: any) => s.isDirectory(), () => false);
  if (names.length > 1 && !destIsDir) return usage(ctx, `destination '${destSpec}' is not a directory`);
  const index = new Map((await pathEntries(fs, dir, false)).filter((e) => e.stage).map((e) => [e.path, e.stage!]));
  for (const srcSpec of names) {
    const src = repoPath(prefix, srcSpec);
    const to = destIsDir ? (dest ? `${dest}/` : '') + src.slice(src.lastIndexOf('/') + 1) : dest;
    const fail = (why: string) => { if (skip) return null; return usage(ctx, `${why}, source=${srcSpec}, destination=${destIsDir ? `${destSpec.replace(/\/$/, '')}/${src.slice(src.lastIndexOf('/') + 1)}` : destSpec}`); };
    const exists = await ctx.fs.exists(`${root}/${src}`);
    const tracked = [...index.keys()].filter((p) => p === src || p.startsWith(src + '/'));
    if (!exists) { const r = fail('bad source'); if (r !== null) return r; continue; }
    if (!tracked.length) { const r = fail('not under version control'); if (r !== null) return r; continue; }
    if (await ctx.fs.exists(`${root}/${to}`) && !force) { const r = fail('destination exists'); if (r !== null) return r; continue; }
    if (dry) ctx.stdout += `Checking rename of '${srcSpec}' to '${destIsDir ? `${destSpec.replace(/\/$/, '')}/${src.slice(src.lastIndexOf('/') + 1)}` : destSpec}'\n`;
    if (dry || verbose) {
      ctx.stdout += `Renaming ${src} to ${to}\n`;
      // (a directory: each file too)
      for (const p of tracked) if (p !== src) ctx.stdout += `Renaming ${p} to ${to + p.slice(src.length)}\n`;
    }
    if (dry) continue;
    if (force && await ctx.fs.exists(`${root}/${to}`)) await ctx.fs.rm(`${root}/${to}`, { recursive: true }).catch(() => {});
    const parent = `${root}/${to}`.slice(0, `${root}/${to}`.lastIndexOf('/')) || '/';
    await ctx.fs.mkdir(parent, { recursive: true }).catch(() => {});
    await ctx.fs.rename(`${root}/${src}`, `${root}/${to}`);
    // the index keeps each file's staged content under its new name
    for (const p of tracked) {
      const e = index.get(p)!;
      await stageBlob(fs, dir, to + p.slice(src.length), e.oid, e.mode);
      await git.remove({ fs, dir, filepath: p });
    }
  }
  return 0;
}

// ── restore ───────────────────────────────────────────────────────────────

export async function gitRestore(ctx: CommandContext, fs: Fs, dir: string, workDir: string): Promise<number> {
  const prefix = prefixOf(dir, workDir);
  let staged = false, worktree = false, source: string | null = null;
  const specs: string[] = [];
  const args = ctx.args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { specs.push(...args.slice(i + 1)); break; }
    if (a === '--staged') staged = true;
    else if (a === '--worktree') worktree = true;
    else if (a.startsWith('--source=')) source = a.slice(9);
    else if (a === '--source' || a === '-s') source = args[++i] ?? '';
    else if (/^-s./.test(a)) source = a.slice(2);
    else if (a === '-q' || a === '--quiet' || a === '--progress' || a === '--no-progress' || a === '--ignore-unmerged' || a === '--overlay' || a === '--no-overlay') { /* nothing to say */ }
    else if (/^-[SWq]+$/.test(a)) for (const c of a.slice(1)) { if (c === 'S') staged = true; else if (c === 'W') worktree = true; }
    else specs.push(a);
  }
  if (!staged) worktree = true;
  if (!specs.length) return usage(ctx, 'you must specify path(s) to restore');
  // From the index for the work tree alone; from HEAD (or --source) for the index, or both
  let srcOid: string | null = null;
  const fromTree = !!source || staged;
  if (fromTree) {
    try { srcOid = await resolveSpec(fs, dir, source || 'HEAD'); }
    catch { if (source) return usage(ctx, `could not resolve ${source}`); }
  }
  const ents = await pathEntries(fs, dir, true, srcOid ?? 'HEAD');
  const want = (e: PathEntry) => (fromTree ? (srcOid ? e.head : undefined) : e.stage);
  const tests = specs.map((sp) => pathspec(prefix, sp));
  const candidates = ents.filter((e) => e.stage || (fromTree && e.head));
  for (let k = 0; k < specs.length; k++) {
    if (!candidates.some((e) => tests[k](e.path))) { ctx.stderr += MISMATCH(specs[k]); return 1; }
  }
  for (const e of candidates) {
    if (!tests.some((t) => t(e.path))) continue;
    const src = want(e);
    if (staged) {
      if (src) { if (e.stage?.oid !== src.oid || e.stage?.mode !== src.mode) await stageBlob(fs, dir, e.path, src.oid, src.mode); }
      else if (e.stage) await git.remove({ fs, dir, filepath: e.path });
    }
    if (worktree) {
      if (src) { if (e.work?.oid !== src.oid) await writeWork(ctx, fs, dir, e.path, src.oid, src.mode); }
      else if (e.work) await removeWork(ctx, dir, e.path);
    }
  }
  return 0;
}

// ── clean ─────────────────────────────────────────────────────────────────

export async function gitClean(ctx: CommandContext, fs: Fs, dir: string, workDir: string): Promise<number> {
  const prefix = prefixOf(dir, workDir);
  let force = false, dry = false, dirs = false, quiet = false, withIgnored = false, onlyIgnored = false;
  const excludes: string[] = [];
  const specs: string[] = [];
  const args = ctx.args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { specs.push(...args.slice(i + 1)); break; }
    if (a === '--force') force = true;
    else if (a === '--dry-run') dry = true;
    else if (a === '--quiet') quiet = true;
    else if (a === '-e' || a === '--exclude') excludes.push(args[++i] ?? '');
    else if (a.startsWith('--exclude=')) excludes.push(a.slice(10));
    else if (/^-[fndqxX]+$/.test(a)) for (const c of a.slice(1)) { if (c === 'f') force = true; else if (c === 'n') dry = true; else if (c === 'd') dirs = true; else if (c === 'q') quiet = true; else if (c === 'x') withIgnored = true; else onlyIgnored = true; }
    else specs.push(a);
  }
  if (!force && !dry) return usage(ctx, 'clean.requireForce defaults to true and neither -i, -n, nor -f given; refusing to clean');
  const tests = specs.map((sp) => pathspec(prefix, sp));
  const ents = await pathEntries(fs, dir, true);
  const tracked = new Set(ents.filter((e) => e.stage || e.head).map((e) => e.path));
  const trackedDirs = new Set<string>();
  for (const p of tracked) for (let i = p.indexOf('/'); i >= 0; i = p.indexOf('/', i + 1)) trackedDirs.add(p.slice(0, i));
  const exRes = excludes.map((g) => new RegExp('(^|/)' + g.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]') + '$'));
  const victims = new Set<string>();
  for (const e of ents) {
    if (tracked.has(e.path) || !e.work) continue;
    if (tests.length && !tests.some((t) => t(e.path))) continue;
    if (exRes.some((re) => re.test(e.path))) continue;
    const ign = await isIgnoredPath(fs, dir, e.path);
    if (onlyIgnored ? !ign : ign && !withIgnored) continue;
    // a file in an untracked directory goes with the directory, and only with -d
    const parts = e.path.split('/');
    let top = e.path;
    for (let k = 1; k < parts.length; k++) { const d = parts.slice(0, k).join('/'); if (!trackedDirs.has(d)) { top = d + '/'; break; } }
    if (top.endsWith('/') && !dirs) continue;
    victims.add(top);
  }
  const root = dir === '/' ? '' : dir;
  for (const v of [...victims].sort()) {
    const shown = relativeTo(prefix, v);
    if (dry) { ctx.stdout += `Would remove ${shown}\n`; continue; }
    if (!quiet) ctx.stdout += `Removing ${shown}\n`;
    await ctx.fs.rm(`${root}/${v.replace(/\/$/, '')}`, { recursive: true }).catch(() => {});
  }
  return 0;
}

function relativeTo(prefix: string, p: string): string {
  if (!prefix) return p;
  const a = prefix.replace(/\/$/, '').split('/'), b = p.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return '../'.repeat(a.length - i) + b.slice(i).join('/');
}

// ── reset ─────────────────────────────────────────────────────────────────

/** Tracked files whose work-tree copy differs from the index: what mixed reset lists */
async function unstagedList(fs: Fs, dir: string): Promise<string> {
  let out = '';
  for (const e of await pathEntries(fs, dir, true)) {
    if (!e.stage) continue;
    if (!e.work) out += `D\t${e.path}\n`;
    else if (e.work.oid !== e.stage.oid) out += `M\t${e.path}\n`;
  }
  return out;
}

export async function gitReset(ctx: CommandContext, fs: Fs, dir: string, workDir: string): Promise<number> {
  const prefix = prefixOf(dir, workDir);
  let mode = null as 'soft' | 'mixed' | 'hard' | null;
  let quiet = false;
  const pos: string[] = [];
  let paths: string[] | null = null;
  const args = ctx.args.slice(1);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { paths = args.slice(i + 1); break; }
    if (a === '--soft' || a === '--mixed' || a === '--hard') mode = a.slice(2) as 'soft' | 'mixed' | 'hard';
    else if (a === '--keep' || a === '--merge') mode = 'hard';
    else if (a === '-q' || a === '--quiet') quiet = true;
    else if (a === '--no-refresh' || a === '--refresh') { /* nothing to refresh */ }
    else pos.push(a);
  }
  // the first word is a revision when it names one; the rest (or all) are paths
  let target = 'HEAD';
  if (pos.length) {
    const r = await resolveSpec(fs, dir, pos[0]).then(() => true, () => false);
    if (r) target = pos.shift()!;
    else if (paths === null && !(await ctx.fs.exists(`${dir === '/' ? '' : dir}/${repoPath(prefix, pos[0])}`))
      && !(await pathEntries(fs, dir, false)).some((e) => pathspec(prefix, pos[0])(e.path))) {
      return usage(ctx, `ambiguous argument '${pos[0]}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
    }
  }
  if (pos.length) paths = [...pos, ...(paths ?? [])];
  let oid: string;
  try { oid = await resolveSpec(fs, dir, target); }
  catch {
    if (target === 'HEAD' && !(await headCommitOid(fs, dir))) oid = '';
    else return usage(ctx, `ambiguous argument '${target}': unknown revision or path not in the working tree.\nUse '--' to separate paths from revisions, like this:\n'git <command> [<revision>...] -- [<file>...]'`);
  }

  if (paths && paths.length) {
    if (mode === 'soft' || mode === 'hard') return usage(ctx, `Cannot do ${mode} reset with paths.`);
    // the index entries for these paths back to the revision's
    const tests = paths.map((p) => pathspec(prefix, p));
    for (const e of await pathEntries(fs, dir, false, oid || 'HEAD')) {
      if (!tests.some((t) => t(e.path))) continue;
      const src = oid ? e.head : undefined;
      if (src) { if (e.stage?.oid !== src.oid) await stageBlob(fs, dir, e.path, src.oid, src.mode); }
      else if (e.stage) await git.remove({ fs, dir, filepath: e.path });
    }
    if (!quiet) { const list = await unstagedList(fs, dir); if (list) ctx.stdout += `Unstaged changes after reset:\n${list}`; }
    return 0;
  }

  mode ??= 'mixed';
  if (!oid) return usage(ctx, "Failed to resolve 'HEAD' as a valid ref.");
  // a merge in progress ends: its conflicted index entries go, then the index is the revision's
  if (mode !== 'soft') {
    for (const p of (await unmergedPaths(fs, dir)).keys()) await git.remove({ fs, dir, filepath: p }).catch(() => {});
    const gitDir = `${dir === '/' ? '' : dir}/.git`;
    for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) await ctx.fs.unlink(`${gitDir}/${f}`).catch(() => {});
  }
  const old = await headCommitOid(fs, dir);
  const before = await pathEntries(fs, dir, mode === 'hard', oid);
  const branch = await branchName(fs, dir);
  if (old) await git.writeRef({ fs, dir, ref: 'ORIG_HEAD', value: old, force: true }).catch(() => {});
  await git.writeRef({ fs, dir, ref: branch ? `refs/heads/${branch}` : 'HEAD', value: oid, force: true });
  if (mode !== 'soft') {
    for (const e of before) {
      const src = e.head; // (the walk's tree side is the target revision here)
      if (src) { if (e.stage?.oid !== src.oid || e.stage?.mode !== src.mode) await stageBlob(fs, dir, e.path, src.oid, src.mode); }
      else if (e.stage) await git.remove({ fs, dir, filepath: e.path });
      if (mode === 'hard') {
        if (src) { if (e.work?.oid !== src.oid) await writeWork(ctx, fs, dir, e.path, src.oid, src.mode); }
        else if (e.stage && e.work) await removeWork(ctx, dir, e.path);
      }
    }
  }
  if (quiet) return 0;
  if (mode === 'hard') {
    const { commit } = await git.readCommit({ fs, dir, oid });
    ctx.stdout += `HEAD is now at ${oid.slice(0, 7)} ${commit.message.split('\n\n')[0].split('\n').join(' ').trim()}\n`;
  } else if (mode === 'mixed') {
    const list = await unstagedList(fs, dir);
    if (list) ctx.stdout += `Unstaged changes after reset:\n${list}`;
  }
  return 0;
}
