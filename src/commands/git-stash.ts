/**
 * git stash with git's own objects: a stash is a commit on refs/stash whose
 * parents are HEAD, a commit of the index and (-u) one of the untracked
 * files, and the stash list is that ref's reflog. So `git stash show`, the
 * stash@{n} names and a real git (pkg install git) see the same stashes.
 * push (save), pop, apply [--index], list, show [-p], drop, clear.
 */
import git from './git-cached';
import { CommandContext } from './index';
import { pathEntries, isIgnoredPath, statusText, changesBetweenTrees, gitPlumbing, type PathEntry } from './git-plumbing';

export interface StashIdent { name: string; email: string; timestamp?: number; timezoneOffset?: number }

type Fs = any;

/** `name <email> 1700000000 +0000` */
function rawIdent(p: StashIdent): string {
  const ts = p.timestamp ?? Math.floor(Date.now() / 1000);
  const off = p.timezoneOffset ?? new Date().getTimezoneOffset();
  const m = Math.abs(off);
  return `${p.name} <${p.email}> ${ts} ${off > 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

/** A commit object written as git writes stash commits (the message as is, no newline added) */
async function writeCommit(fs: Fs, dir: string, tree: string, parents: string[], who: StashIdent, message: string): Promise<string> {
  const text = `tree ${tree}\n${parents.map((p) => `parent ${p}\n`).join('')}author ${rawIdent(who)}\ncommitter ${rawIdent(who)}\n\n${message}`;
  return git.writeObject({ fs, dir, type: 'commit', object: new TextEncoder().encode(text), format: 'content' });
}

/** A tree (and its subtrees) of these files */
async function writeTreeOf(fs: Fs, dir: string, files: { path: string; oid: string; mode: number }[]): Promise<string> {
  const here: { mode: string; path: string; oid: string; type: 'blob' | 'tree' }[] = [];
  const subdirs = new Map<string, { path: string; oid: string; mode: number }[]>();
  for (const f of files) {
    const slash = f.path.indexOf('/');
    if (slash < 0) here.push({ mode: f.mode.toString(8).padStart(6, '0'), path: f.path, oid: f.oid, type: 'blob' });
    else {
      const name = f.path.slice(0, slash);
      (subdirs.get(name) ?? subdirs.set(name, []).get(name)!).push({ ...f, path: f.path.slice(slash + 1) });
    }
  }
  for (const [name, list] of subdirs) here.push({ mode: '040000', path: name, oid: await writeTreeOf(fs, dir, list), type: 'tree' });
  return git.writeTree({ fs, dir, tree: here });
}

interface StashRef { oid: string; message: string; line: string }

export async function gitStashHandler(ctx: CommandContext, fs: Fs, dir: string, workDir: string, ident: () => Promise<StashIdent>): Promise<number> {
  const explicit = ctx.args[1] && !ctx.args[1].startsWith('-');
  const sub = explicit ? ctx.args[1] : 'push';
  const opts = ctx.args.slice(explicit ? 2 : 1);
  const quiet = opts.includes('-q') || opts.includes('--quiet');
  const gitDir = `${dir === '/' ? '' : dir}/.git`;
  const logPath = `${gitDir}/logs/refs/stash`;
  const prefix = workDir === dir ? '' : workDir.slice(dir === '/' ? 1 : dir.length + 1) + '/';

  // The built-in git once kept stashes as JSON files in a directory at refs/stash: set them aside
  if ((await ctx.fs.stat(`${gitDir}/refs/stash`).catch(() => null))?.isDirectory()) {
    await ctx.fs.rename(`${gitDir}/refs/stash`, `${gitDir}/stash-legacy`).catch(() => {});
    ctx.stderr += 'git stash: stashes from an earlier built-in git are in .git/stash-legacy (a JSON file each)\n';
  }

  /** The stash list, newest first (stash@{0}) */
  async function stashes(): Promise<StashRef[]> {
    const text = await ctx.fs.readFile(logPath, 'utf8').catch(() => '') as string;
    return text.split('\n').filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      return { oid: line.split(' ')[1], message: tab >= 0 ? line.slice(tab + 1) : '', line };
    }).reverse();
  }
  async function saveList(list: StashRef[]): Promise<void> {
    if (!list.length) {
      await ctx.fs.unlink(logPath).catch(() => {});
      await git.deleteRef({ fs, dir, ref: 'refs/stash' }).catch(() => {});
      return;
    }
    await ctx.fs.writeFile(logPath, [...list].reverse().map((s) => s.line + '\n').join(''));
    await git.writeRef({ fs, dir, ref: 'refs/stash', value: list[0].oid, force: true });
  }
  /** stash@{N}, N, or the newest */
  async function pick(): Promise<{ n: number; ref: StashRef; named: boolean } | number> {
    const list = await stashes();
    const arg = opts.find((a) => !a.startsWith('-'));
    if (!list.length) { ctx.stderr += 'No stash entries found.\n'; return 1; }
    const m = arg?.match(/^(?:stash@\{(\d+)\}|(\d+))$/);
    const n = arg === undefined ? 0 : m ? +(m[1] ?? m[2]) : -1;
    if (n < 0 || n >= list.length) { ctx.stderr += `error: ${arg} is not a valid reference\n`; return 1; }
    return { n, ref: list[n], named: arg !== undefined };
  }

  switch (sub) {
    case 'push':
    case 'save': {
      let given = '', untracked = false;
      for (let i = 0; i < opts.length; i++) {
        const a = opts[i];
        if ((a === '-m' || a === '--message') && opts[i + 1] !== undefined) given = opts[++i];
        else if (a.startsWith('--message=')) given = a.slice(10);
        else if (a === '-u' || a === '--include-untracked') untracked = true;
        else if (sub === 'save' && !a.startsWith('-')) { given = opts.slice(i).join(' '); break; }
      }
      const head = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
      if (!head) { ctx.stderr += 'You do not have the initial commit yet\n'; return 1; }
      const branch = await git.currentBranch({ fs, dir }).catch(() => undefined) || '(no branch)';
      const { commit } = await git.readCommit({ fs, dir, oid: head });
      const headLine = `${head.slice(0, 7)} ${commit.message.split('\n')[0]}`;
      const ents = await pathEntries(fs, dir, true);
      const tracked = ents.filter((e) => e.stage || e.head);
      const changed = tracked.filter((e) => e.stage?.oid !== e.head?.oid || e.stage?.mode !== e.head?.mode || (e.stage && e.work?.oid !== e.stage.oid));
      const extra: PathEntry[] = [];
      if (untracked) for (const e of ents) if (!e.stage && !e.head && e.work && !(await isIgnoredPath(fs, dir, e.path))) extra.push(e);
      if (!changed.length && !extra.length) { if (!quiet) ctx.stdout += 'No local changes to save\n'; return 0; }
      const who = await ident();
      // the index, then the work tree's versions of the index's files
      const indexTree = await writeTreeOf(fs, dir, tracked.filter((e) => e.stage).map((e) => ({ path: e.path, ...e.stage! })));
      const indexCommit = await writeCommit(fs, dir, indexTree, [head], who, `index on ${branch}: ${headLine}\n`);
      const root = dir === '/' ? '' : dir;
      const workFiles: { path: string; oid: string; mode: number }[] = [];
      for (const e of tracked) {
        if (!e.stage || !e.work) continue;
        const oid = e.work.oid === e.stage.oid ? e.stage.oid : await git.writeBlob({ fs, dir, blob: await ctx.fs.readFile(`${root}/${e.path}`) as Uint8Array });
        workFiles.push({ path: e.path, oid, mode: e.stage.mode });
      }
      const parents = [head, indexCommit];
      if (extra.length) {
        const files: { path: string; oid: string; mode: number }[] = [];
        for (const e of extra) files.push({ path: e.path, oid: await git.writeBlob({ fs, dir, blob: await ctx.fs.readFile(`${root}/${e.path}`) as Uint8Array }), mode: e.work!.mode || 0o100644 });
        parents.push(await writeCommit(fs, dir, await writeTreeOf(fs, dir, files), [], who, `untracked files on ${branch}: ${headLine}\n`));
      }
      const message = given ? `On ${branch}: ${given}` : `WIP on ${branch}: ${headLine}`;
      // (the stash's own message has no newline after it; the index's and the untracked files' do, as git writes them)
      const stash = await writeCommit(fs, dir, await writeTreeOf(fs, dir, workFiles), parents, who, message);
      const list = await stashes();
      list.unshift({ oid: stash, message, line: `${list[0]?.oid ?? '0'.repeat(40)} ${stash} ${rawIdent(who)}\t${message}` });
      await ctx.fs.mkdir(`${gitDir}/logs/refs`, { recursive: true }).catch(() => {});
      await saveList(list);
      // then back to HEAD: tracked files, and the untracked ones that went into the stash
      const { gitReset } = await import('./git-worktree');
      const saved = ctx.args;
      ctx.args = ['reset', '--hard', '-q', 'HEAD'];
      try { await gitReset(ctx, fs, dir, workDir); } finally { ctx.args = saved; }
      for (const e of extra) await ctx.fs.unlink(`${root}/${e.path}`).catch(() => {});
      if (!quiet) ctx.stdout += `Saved working directory and index state ${message}\n`;
      return 0;
    }

    case 'pop':
    case 'apply': {
      const p = await pick();
      if (typeof p === 'number') return p;
      const withIndex = opts.includes('--index');
      const { commit: s } = await git.readCommit({ fs, dir, oid: p.ref.oid });
      const [base, indexCommit, untrackedCommit] = s.parent;
      const root = dir === '/' ? '' : dir;
      const now = new Map((await pathEntries(fs, dir, true)).map((e) => [e.path, e]));
      const changes = await changesBetweenTrees(fs, dir, base, p.ref.oid);
      // what the work tree changed since: git would merge, the built-in stops
      const blocked = changes.filter((c) => {
        const cur = now.get(c.path)?.work?.oid || undefined;
        return cur !== c.old && cur !== c.new;
      }).map((c) => c.path);
      const untrackedFiles = untrackedCommit ? await changesBetweenTrees(fs, dir, null, untrackedCommit) : [];
      const clash = untrackedFiles.filter((c) => now.get(c.path)?.work).map((c) => c.path);
      if (blocked.length) {
        ctx.stderr += `error: Your local changes to the following files would be overwritten by merge:\n${blocked.map((f) => `\t${f}\n`).join('')}Please commit your changes or stash them before you merge.\nAborting\n`;
        ctx.stdout += await statusText(fs, dir, prefix);
        if (sub === 'pop') ctx.stdout += 'The stash entry is kept in case you need it again.\n';
        return 1;
      }
      if (clash.length) {
        ctx.stderr += clash.map((f) => `${f} already exists, no checkout\n`).join('') + 'error: could not restore untracked files from stash\n';
        return 1;
      }
      const write = async (path: string, oid: string, mode?: number) => {
        const { blob } = await git.readBlob({ fs, dir, oid });
        await ctx.fs.mkdir(`${root}/${path}`.slice(0, `${root}/${path}`.lastIndexOf('/')) || '/', { recursive: true }).catch(() => {});
        await ctx.fs.writeFile(`${root}/${path}`, blob);
        if (mode === 0o100755) await ctx.fs.chmod(`${root}/${path}`, 0o755).catch(() => {});
      };
      for (const c of changes) {
        if (c.new) await write(c.path, c.new, c.mode);
        else await ctx.fs.unlink(`${root}/${c.path}`).catch(() => {});
      }
      // the index: as stashed with --index; otherwise files new in the index stay added, as git
      for (const c of await changesBetweenTrees(fs, dir, base, indexCommit)) {
        if (!withIndex && c.old) continue;
        if (c.new) await git.updateIndex({ fs, dir, filepath: c.path, oid: c.new, mode: c.mode, add: true, force: true });
        else await git.remove({ fs, dir, filepath: c.path });
      }
      for (const c of untrackedFiles) if (c.new) await write(c.path, c.new, c.mode);
      // (git's merge of an empty change says so, -q or not)
      if (untrackedCommit && !changes.length) ctx.stdout += 'Already up to date.\n';
      if (!quiet) ctx.stdout += await statusText(fs, dir, prefix);
      if (sub === 'pop') {
        const list = await stashes();
        list.splice(p.n, 1);
        await saveList(list);
        if (!quiet) ctx.stdout += `Dropped ${p.named ? `stash@{${p.n}}` : 'refs/stash@{0}'} (${p.ref.oid})\n`;
      }
      return 0;
    }

    case 'list': {
      const list = await stashes();
      let format = '%gd: %gs', nul = false;
      for (const a of opts) {
        const f = a.match(/^--(?:pretty|format)=(?:t?format:)?(.*)$/s);
        if (f) format = f[1] === 'oneline' ? '%gd: %gs' : f[1];
        else if (a === '-z') nul = true;
        else if (a === '--oneline') format = '%h %gs';
      }
      const lines: string[] = [];
      for (let n = 0; n < list.length; n++) lines.push(await formatStash(fs, dir, format, n, list[n]));
      ctx.stdout += lines.join(nul ? '\0' : '\n') + (lines.length ? (nul ? '\0' : '\n') : '');
      return 0;
    }

    case 'show': {
      const p = await pick();
      if (typeof p === 'number') return p;
      const { commit: s } = await git.readCommit({ fs, dir, oid: p.ref.oid });
      const patch = opts.some((a) => a === '-p' || a === '--patch');
      const saved = ctx.args;
      ctx.args = ['diff', ...(patch ? [] : ['--stat']), ...opts.filter((a) => a.startsWith('-') && a !== '-p' && a !== '--patch'), s.parent[0], p.ref.oid];
      try { return (await gitPlumbing(ctx, fs, dir, workDir)) ?? 0; } finally { ctx.args = saved; }
    }

    case 'drop': {
      const p = await pick();
      if (typeof p === 'number') return p;
      const list = await stashes();
      list.splice(p.n, 1);
      await saveList(list);
      if (!quiet) ctx.stdout += `Dropped ${p.named ? `stash@{${p.n}}` : 'refs/stash@{0}'} (${p.ref.oid})\n`;
      return 0;
    }

    case 'clear':
      await saveList([]);
      return 0;

    default:
      ctx.stderr += `error: unknown subcommand: \`${sub}'\nusage: git stash list [<log-options>]\n   or: git stash show [-u | --include-untracked | --only-untracked] [<diff-options>] [<stash>]\n   or: git stash drop [-q | --quiet] [<stash>]\n   or: git stash pop [--index] [-q | --quiet] [<stash>]\n   or: git stash apply [--index] [-q | --quiet] [<stash>]\n   or: git stash push [-u | --include-untracked] [-q | --quiet] [-m <message>]\n   or: git stash clear\n`;
      return 129;
  }
}

/** A stash in `git stash list --format`: the reflog atoms, and the stash commit's own */
async function formatStash(fs: Fs, dir: string, format: string, n: number, s: StashRef): Promise<string> {
  const { commit } = await git.readCommit({ fs, dir, oid: s.oid });
  const secs = commit.committer.timestamp;
  const ago = () => {
    const d = Math.max(0, Math.floor(Date.now() / 1000) - secs);
    for (const [u, k] of [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]] as const) {
      if (d >= k) { const c = Math.floor(d / k); return `${c} ${u}${c > 1 ? 's' : ''} ago`; }
    }
    return `${d} seconds ago`;
  };
  return format.replace(/%(gd|gD|gs|gn|ge|[ac][trdDI]|[sHhn%]|x[0-9a-fA-F]{2})/g, (_, k: string) => {
    if (k === 'gd' || k === 'gD') return `stash@{${n}}`;
    if (k === 'gs' || k === 's') return s.message;
    if (k === 'gn' || k === 'an' || k === 'cn') return commit.author.name;
    if (k === 'ge') return commit.author.email;
    if (k === 'H') return s.oid;
    if (k === 'h') return s.oid.slice(0, 7);
    if (k === 'n') return '\n';
    if (k === '%') return '%';
    if (k[0] === 'x') return String.fromCharCode(parseInt(k.slice(1), 16));
    if (k[1] === 't') return String(secs);
    if (k[1] === 'r') return ago();
    if (k[1] === 'I') return new Date(secs * 1000).toISOString().replace('.000Z', '+00:00');
    if (k[1] === 'd' || k[1] === 'D') return new Date(secs * 1000).toUTCString();
    return '';
  });
}
