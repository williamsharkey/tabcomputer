import git, { TREE, STAGE, withGitCache } from './git-cached';
// @ts-ignore - isomorphic-git http module
import http from 'isomorphic-git/http/web';
import { Command, CommandContext } from './index';
import { gitStashHandler } from './git-stash';
import { gitRm, gitMv, gitRestore, gitClean, gitReset } from './git-worktree';
import { gitBlame } from './git-blame';
import { gitTagHandler } from './git-tag';
import { resolveRevision } from './git-utils';
import { startReflog } from './git-reflog';
import { activeProfile } from '../profile';
import { gitPlumbing, changeSummary, stagedCount, statusText, gitDate, unmergedPaths, pathEntries, changesBetweenTrees } from './git-plumbing';
import { packageShadows } from '../pkg-manager';
import { installPackIndexer } from '../git-pack-indexer';
import { builtinCloneHandles } from './git-clone-route';
import { githubCloneSize, githubRepo, pageCloneLimit, mb } from './git-clone-size';
import { splitShortOptions, unknownOption, realGit, PREFER_REAL } from './git-route';
import { GLOBAL_GITCONFIG, parseGitConfig, formatGitConfig } from './git-config';
import { gitHttpFor } from './git-transport';
import { retrySignedIn } from '../github-needed';
import { apiCloneOp, apiFetchOp, apiPullOp, apiPushOp } from './git-api-ops';

// git clone's pack indexing in a worker (vite-plugin-isogit.ts calls it from fromPack)
installPackIndexer();

// --- Main command ---

const GITHUB_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'ls-remote']);

export const gitCmd: Command = {
  name: 'git',
  description: 'Version control system',
  // one isomorphic-git cache per command (see git-cached.ts)
  // (clone, fetch, pull, push and ls-remote that fail for want of a GitHub sign-in ask for one and
  //  run again: github-needed.ts. They fail before they change anything.)
  exec: (ctx: CommandContext) => {
    const once = () => withGitCache(async () => {
      const reflog: ReflogHook = {};
      const code = await gitMain(ctx, reflog);
      await reflog.finish?.(code);
      return code;
    });
    const sub = ctx.args.find((a) => GITHUB_SUBCOMMANDS.has(a));
    return sub ? retrySignedIn(ctx, `git ${sub}`, once) : once();
  },
  keepOverPackage: builtinCloneHandles,
};


/** Set by gitMain once the repository is known: writes the reflog entries for what the command moved */
interface ReflogHook { finish?: (code: number) => Promise<void> }

async function gitMain(ctx: CommandContext, reflog: ReflogHook = {}): Promise<number> {
    // Global options before the subcommand (git -C /path -c k=v --no-pager subcmd ...)
    const argv = ctx.args, cwd0 = ctx.cwd; // as given, for the real git
    let workDir = ctx.cwd;
    const configOverrides: [string, string][] = [];
    let ai = 0;
    for (; ai < ctx.args.length; ai++) {
      const a = ctx.args[ai];
      if (a === '-C' && ai + 1 < ctx.args.length) {
        workDir = ctx.fs.resolvePath(ctx.args[++ai], workDir);
      } else if (a === '-c' && ai + 1 < ctx.args.length) {
        const kv = ctx.args[++ai], eq = kv.indexOf('=');
        configOverrides.push(eq < 0 ? [kv, 'true'] : [kv.slice(0, eq), kv.slice(eq + 1)]);
      } else if (a.startsWith('--git-dir=') || a.startsWith('--work-tree=')) {
        const v = ctx.fs.resolvePath(a.slice(a.indexOf('=') + 1), workDir);
        workDir = a.startsWith('--git-dir=') ? (v.endsWith('/.git') ? v.slice(0, -5) || '/' : v) : v;
      } else if (['--no-pager', '-P', '--paginate', '-p', '--no-optional-locks', '--literal-pathspecs',
        '--no-replace-objects', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--bare'].includes(a)) {
        // nothing to do: no pager, no locks to skip
      } else break;
    }
    // Mutate ctx in-place so stdout/stderr propagate back
    ctx.args = ctx.args.slice(ai);
    ctx.cwd = workDir;
    const subcommand = ctx.args[0];

    if (!subcommand || subcommand === '--help' || subcommand === '-h') {
      ctx.stdout = 'usage: git <command> [<args>]\n\nAvailable commands:\n  init, config, add, commit, status, log, diff, show, branch, checkout, clone\n  push, pull, fetch, remote, merge, stash, reset, tag, cherry-pick, revert, rebase, reflog\n';
      return 0;
    }
    if (subcommand === '--version' || subcommand === '-v') {
      ctx.stdout = 'git version 2.47.0 (isomorphic-git/shiro)\n';
      return 0;
    }

    if (ctx.args.includes('--help') || (ctx.args.length === 2 && ctx.args[1] === '-h')) {
      ctx.stdout = `usage: git ${subcommand} [<options>] [<args>]\n\n(the built-in git; \`pkg install git\` for the full git and its manual)\n`;
      return 0;
    }
    // What the built-in doesn't know (a subcommand, an option) is the real git's; combined short options split first
    ctx.args = [subcommand, ...splitShortOptions(subcommand, ctx.args.slice(1))];
    const unknown = unknownOption(subcommand, ctx.args.slice(1));
    if (unknown !== null || PREFER_REAL.has(subcommand)) {
      const code = await realGit(ctx, argv, cwd0);
      if (code !== null) return code;
      const full = '(the built-in git; `pkg install git` has the full git, which needs the x86 engine)\n';
      if (unknown === subcommand) {
        ctx.stderr = `git: '${unknown}' is not a git command. See 'git --help'.\n${full}`;
        return 1;
      }
      if (unknown?.includes(' ')) {
        ctx.stderr = `error: unknown subcommand: \`${unknown.split(' ')[1]}'\nusage: git ${subcommand} ...\n${full}`;
        return 129;
      }
      if (unknown !== null) {
        ctx.stderr = (unknown.startsWith('--') ? `error: unknown option \`${unknown.slice(2)}'\n` : `error: unknown switch \`${unknown.slice(1)}'\n`)
          + `usage: git ${subcommand} [<options>]\n${full}`;
        return 129;
      }
    }

    // A linked worktree's .git (`git worktree add`) is a file, "gitdir: ...", which
    // isomorphic-git can't follow: there the built-in read nothing and committed nowhere
    if (subcommand !== 'init' && subcommand !== 'clone' && await dotGitIsFile(ctx, workDir)) {
      const code = await realGit(ctx, argv, cwd0);
      if (code !== null) return code;
      ctx.stderr = 'fatal: the built-in git can\'t work in a linked worktree (its .git is a file)\n'
        + '(`pkg install git` has the full git, which needs the x86 engine)\n';
      return 128;
    }

    const fs = ctx.fs.toIsomorphicGitFS();
    // The repository is the nearest directory up from here with a .git, as for git
    let dir = workDir;
    if (subcommand === 'ls-remote' && /[:@]/.test(ctx.args.find((a, i) => i > 0 && !a.startsWith('-')) ?? '')) {
      return lsRemote(ctx, fs, workDir, null);
    }
    if (!['init', 'clone', 'config'].includes(subcommand)) {
      let root: string | null = workDir;
      while (root && !(await ctx.fs.exists(root === '/' ? '/.git' : `${root}/.git`))) {
        root = root === '/' ? null : root.slice(0, root.lastIndexOf('/')) || '/';
      }
      if (!root) {
        ctx.stderr = 'fatal: not a git repository (or any of the parent directories): .git\n';
        return 128;
      }
      dir = root;
      // What this moves of HEAD and the branches goes in their reflogs (git-reflog.ts)
      const logAllRefUpdates = async (): Promise<string | undefined> => {
        const k = 'core.logallrefupdates';
        const set = configOverrides.find(([name]) => name.toLowerCase() === k)?.[1]
          ?? await git.getConfig({ fs, dir, path: k }).catch(() => undefined)
          ?? Object.entries(await readGlobalConfig(ctx)).find(([name]) => name.toLowerCase() === k)?.[1];
        return set === undefined ? undefined : String(set);
      };
      reflog.finish = (await startReflog(ctx, fs, dir, subcommand, ctx.args.slice(1), logAllRefUpdates, () => resolveCommitter(ctx, fs, dir))) ?? undefined;
    }

    try {
      const handled = await gitPlumbing(ctx, fs, dir, workDir);
      if (handled !== null) return handled;
      switch (subcommand) {
        case 'config':
          return gitConfigCommand(ctx, fs, dir, configOverrides);

        case 'init': {
          let targetDir = dir;
          const initPath = ctx.args.slice(1).find((x, i, arr) => !x.startsWith('-') && arr[i - 1] !== '-b' && arr[i - 1] !== '--initial-branch');
          if (initPath) {
            targetDir = ctx.fs.resolvePath(initPath, dir);
            await ctx.fs.mkdir(targetDir, { recursive: true });
          }
          const gitDir = ctx.fs.resolvePath('.git', targetDir);
          try {
            await ctx.fs.mkdir(gitDir, { recursive: true });
          } catch (e) {
            // Ignore if already exists
          }
          const branchFlag = ctx.args.findIndex(x => x === '-b' || x === '--initial-branch');
          const defaultBranch = (branchFlag > 0 && ctx.args[branchFlag + 1])
            || (await readGlobalConfig(ctx))['init.defaultbranch'] || 'main';
          await git.init({ fs, dir: targetDir, defaultBranch });
          if (!ctx.args.includes('-q') && !ctx.args.includes('--quiet')) ctx.stdout = `Initialized empty Git repository in ${targetDir}/.git/\n`;
          break;
        }

        case 'add': {
          let update = false, force = false, dashdash = false;
          const paths: string[] = [];
          for (const a of ctx.args.slice(1)) {
            if (dashdash || !a.startsWith('-')) paths.push(a);
            else if (a === '--') dashdash = true;
            else if (a === '-u' || a === '--update') update = true;
            else if (a === '-f' || a === '--force') force = true;
            // -A/--all, -v, -N, ...: the defaults here
          }
          const rel = (paths.length ? paths : ['.']).map(p => {
            const abs = ctx.fs.resolvePath(p, workDir);
            return abs === dir ? '.' : abs.slice(dir === '/' ? 1 : dir.length + 1);
          });
          const under = (f: string) => rel.some(r => r === '.' || f === r || f.startsWith(r + '/'));
          // statusMatrix trusts the index's stat data: a file rewritten at the same size no later than
          // the index was written reads as unchanged. Those ("racily clean", as git calls them) get hashed.
          const indexTime = (await ctx.fs.stat(`${dir === '/' ? '' : dir}/.git/index`).catch(() => null) as any)?.mtimeMs ?? Infinity;
          const racy = async (f: string) => ((await ctx.fs.stat(`${dir === '/' ? '' : dir}/${f}`).catch(() => null) as any)?.mtimeMs ?? Infinity) >= indexTime - 1000;
          const seen = new Set<string>();
          const matrix = await git.statusMatrix({ fs, dir, ...(rel.includes('.') ? {} : { filepaths: rel }) });
          for (const [filepath, head, work, stage] of matrix) {
            if (!under(filepath)) continue;
            seen.add(filepath);
            if (work === 0) {
              if (head || stage) await git.remove({ fs, dir, filepath });
              continue;
            }
            if (update && head === 0 && stage === 0) continue; // -u: tracked files only
            if (((work === 1 && stage === 1) || (work === 2 && stage === 2)) && !(await racy(filepath))) continue;
            await git.add({ fs, dir, filepath, force });
          }
          const ignoredPaths: string[] = [];
          for (let i = 0; i < rel.length; i++) {
            if (rel[i] === '.' || [...seen].some(f => f === rel[i] || f.startsWith(rel[i] + '/'))) continue;
            // ignored (git add -f), or nothing there
            if (force && await ctx.fs.exists(dir === '/' ? '/' + rel[i] : `${dir}/${rel[i]}`)) { await git.add({ fs, dir, filepath: rel[i], force: true }); continue; }
            if (!(await ctx.fs.exists(dir === '/' ? '/' + rel[i] : `${dir}/${rel[i]}`))) {
              ctx.stderr += `fatal: pathspec '${paths[i]}' did not match any files\n`;
              return 128;
            }
            if (await git.isIgnored({ fs, dir, filepath: rel[i] }).catch(() => false)) ignoredPaths.push(paths[i]);
          }
          if (ignoredPaths.length) {
            ctx.stderr += `The following paths are ignored by one of your .gitignore files:\n${ignoredPaths.map(p => p + '\n').join('')}hint: Use -f if you really want to add them.\nhint: Turn this message off by running\nhint: "git config advice.addIgnoredFile false"\n`;
            return 1;
          }
          break;
        }

        case 'commit': {
          let message = '';
          let amend = false;
          let allowEmpty = false;
          let all = false, quiet = false;
          const messages: string[] = [];
          for (let i = 1; i < ctx.args.length; i++) {
            const a = ctx.args[i];
            if (a === '-m' || a === '--message' || a === '-F' || a === '--file') {
              const v = ctx.args[++i] ?? '';
              messages.push(a === '-F' || a === '--file' ? (v === '-' ? ctx.stdin : await ctx.fs.readFile(ctx.fs.resolvePath(v, workDir), 'utf8') as string) : v);
            } else if (a.startsWith('--message=')) messages.push(a.slice(10));
            else if (a === '--amend') amend = true;
            else if (a === '--allow-empty') allowEmpty = true;
            else if (a === '--all') all = true;
            else if (a === '--quiet') quiet = true;
            else if (/^-[aqnsvem]+$/.test(a) || /^-[aqnsv]*m.+$/.test(a)) {
              // bundled short options: -am msg, -qam msg, -mmsg
              for (let j = 1; j < a.length; j++) {
                const c = a[j];
                if (c === 'a') all = true;
                else if (c === 'q') quiet = true;
                else if (c === 'm') { messages.push(j + 1 < a.length ? a.slice(j + 1) : ctx.args[++i] ?? ''); break; }
              }
            }
          }
          message = messages.map(m => m.replace(/\n+$/, '')).join('\n\n');
          if (all) {
            // -a: stage what changed in tracked files, as git does
            // (a racily clean file is hashed, not trusted to its stat data: see add)
            const indexTime = (await ctx.fs.stat(`${dir === '/' ? '' : dir}/.git/index`).catch(() => null) as any)?.mtimeMs ?? Infinity;
            for (const [filepath, head, work, stage] of await git.statusMatrix({ fs, dir })) {
              if (head === 0 && stage === 0) continue;
              if (work === 0) { await git.remove({ fs, dir, filepath }); continue; }
              const mtime = (await ctx.fs.stat(`${dir === '/' ? '' : dir}/${filepath}`).catch(() => null) as any)?.mtimeMs ?? Infinity;
              if (work !== stage || (head === 1 && work === 2) || mtime >= indexTime - 1000) await git.add({ fs, dir, filepath });
            }
          }

          const author = await resolveAuthor(ctx, fs, dir);
          const committer = await resolveCommitter(ctx, fs, dir);
          const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
          const prefix = workDir === dir ? '' : workDir.slice(dir === '/' ? 1 : dir.length + 1) + '/';
          // Concluding a merge: its other parent and message, once no path is left conflicted
          const gitDir = `${dir === '/' ? '' : dir}/.git`;
          const mergeHead = ((await ctx.fs.readFile(`${gitDir}/MERGE_HEAD`, 'utf8').catch(() => '')) as string).trim() || null;
          if (mergeHead) {
            const conflicted = await unmergedPaths(fs, dir);
            if (conflicted.size) {
              ctx.stdout = [...conflicted.keys()].sort().map((p) => `U\t${p}\n`).join('');
              ctx.stderr = "error: Committing is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use 'git add/rm <file>'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n";
              return 128;
            }
            if (!message) message = ((await ctx.fs.readFile(`${gitDir}/MERGE_MSG`, 'utf8').catch(() => '')) as string).replace(/\n+$/, '');
          }
          // Nothing staged: git says so with the status, and commits nothing
          if (!mergeHead && !amend && !allowEmpty && await stagedCount(fs, dir) === 0) {
            ctx.stdout = await statusText(fs, dir, prefix);
            return 1;
          }
          let headCommit: any = null;
          if (amend) {
            if (!headOid) { ctx.stderr = 'fatal: You have nothing to amend.\n'; return 128; }
            headCommit = (await git.readCommit({ fs, dir, oid: headOid })).commit;
            if (!message) message = headCommit.message;
          }
          if (!message) {
            ctx.stderr = 'Aborting commit due to empty commit message.\n';
            return 1;
          }
          // (--amend replaces HEAD's commit, with HEAD's parents and author; the committer is now)
          const sha = await git.commit({
            fs, dir, message, committer,
            author: amend ? headCommit.author : author,
            ...(amend ? { amend: true } : {}),
            ...(mergeHead && headOid ? { parent: [headOid, mergeHead] } : {}),
          });
          if (mergeHead) for (const f of ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE']) await ctx.fs.unlink(`${gitDir}/${f}`).catch(() => {});
          if (!quiet) {
            const branch = await git.currentBranch({ fs, dir });
            const parent = amend ? headCommit.parent[0] ?? null : headOid;
            const subject = message.split('\n\n')[0].split('\n').join(' ').trim();
            ctx.stdout = `[${branch ?? 'detached HEAD'}${!amend && !headOid ? ' (root-commit)' : ''} ${sha.slice(0, 7)}] ${subject}\n`;
            if (amend) ctx.stdout += ` Date: ${gitDate(headCommit.author)}\n`;
            if (!mergeHead) ctx.stdout += await changeSummary(fs, dir, parent, sha, false);
          }
          break;
        }

        case 'branch': {
          let del: 'd' | 'D' | null = null, move = false, force = false, all = false, remotes = false;
          const names: string[] = [];
          for (const a of ctx.args.slice(1)) {
            if (a === '--delete') del = del ?? 'd';
            else if (a === '--move') move = true;
            else if (a === '--force') force = true;
            else if (a === '--all') all = true;
            else if (a === '--remotes') remotes = true;
            else if (a === '--list' || a === '--quiet' || a.startsWith('--color') || a === '--no-color' || a.startsWith('--sort')) { /* listing as is */ }
            else if (/^-[dDmMfarlq]+$/.test(a)) {
              for (const c of a.slice(1)) {
                if (c === 'd' || c === 'D') { del = c === 'D' || del === 'D' ? 'D' : 'd'; if (c === 'D') force = true; }
                else if (c === 'm' || c === 'M') { move = true; if (c === 'M') force = true; }
                else if (c === 'f') force = true;
                else if (c === 'a') all = true;
                else if (c === 'r') remotes = true;
              }
            } else names.push(a);
          }
          const current = await git.currentBranch({ fs, dir });
          const existing = await git.listBranches({ fs, dir });
          const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
          if (del) {
            if (!names.length) { ctx.stderr = 'fatal: branch name required\n'; return 128; }
            let status = 0;
            for (const name of names) {
              if (!existing.includes(name)) { ctx.stderr += `error: branch '${name}' not found\n`; status = 1; continue; }
              if (name === current) { ctx.stderr += `error: cannot delete branch '${name}' used by worktree at '${dir}'\n`; status = 1; continue; }
              const oid = await git.resolveRef({ fs, dir, ref: `refs/heads/${name}` });
              // -d deletes only what HEAD has merged
              const merged = !headOid || oid === headOid || await git.isDescendent({ fs, dir, oid: headOid, ancestor: oid, depth: -1 }).catch(() => false);
              if (del === 'd' && !force && !merged) {
                ctx.stderr += `error: the branch '${name}' is not fully merged.\nIf you are sure you want to delete it, run 'git branch -D ${name}'\n`;
                status = 1;
                continue;
              }
              await git.deleteBranch({ fs, dir, ref: name });
              ctx.stdout += `Deleted branch ${name} (was ${oid.slice(0, 7)}).\n`;
            }
            return status;
          }
          if (move) {
            const [from, to] = names.length >= 2 ? names : [current, names[0]];
            if (!to || !from) { ctx.stderr = 'fatal: branch name required\n'; return 128; }
            if (!existing.includes(from)) { ctx.stderr = `fatal: no branch named '${from}'\n`; return 128; }
            if (existing.includes(to) && !force) { ctx.stderr = `fatal: a branch named '${to}' already exists\n`; return 128; }
            if (existing.includes(to)) await git.deleteBranch({ fs, dir, ref: to });
            await git.renameBranch({ fs, dir, oldref: from, ref: to, checkout: from === current });
            break;
          }
          if (names.length && !all && !remotes) {
            const [name, start] = names;
            if (existing.includes(name) && !force) { ctx.stderr = `fatal: a branch named '${name}' already exists\n`; return 128; }
            let object: string | undefined;
            if (start) {
              try { object = await resolveRevision(fs, dir, start); }
              catch { ctx.stderr = `fatal: not a valid object name: '${start}'\n`; return 128; }
            } else if (!headOid) { ctx.stderr = `fatal: not a valid object name: '${current ?? 'HEAD'}'\n`; return 128; }
            await git.branch({ fs, dir, ref: name, object, force });
            break;
          }
          if (!remotes) {
            if (!current && headOid) ctx.stdout += `* (HEAD detached at ${headOid.slice(0, 7)})\n`;
            for (const b of [...existing].sort()) ctx.stdout += (b === current ? '* ' : '  ') + b + '\n';
          }
          if (all || remotes) {
            for (const r of await git.listRemotes({ fs, dir }).catch(() => [] as { remote: string }[])) {
              const list = await git.listBranches({ fs, dir, remote: r.remote }).catch(() => [] as string[]);
              for (const b of list.sort()) ctx.stdout += `  ${all ? 'remotes/' : ''}${r.remote}/${b}\n`;
            }
          }
          break;
        }

        case 'checkout':
        case 'switch': {
          let newBranch = '', force = false, quiet = false, sawDashDash = false, detach = false;
          const rest: string[] = [];
          for (let i = 1; i < ctx.args.length; i++) {
            const a = ctx.args[i];
            if (sawDashDash) rest.push(a);
            else if (a === '--') sawDashDash = true;
            else if (a === '-b' || a === '-B' || a === '-c' || a === '-C') { newBranch = ctx.args[++i] ?? ''; force = force || a === '-B' || a === '-C'; if (!newBranch) { ctx.stderr = `error: switch \`${a[1]}' requires a value\n`; return 129; } }
            else if (a === '-q' || a === '--quiet') quiet = true;
            else if (a === '-f' || a === '--force') force = true;
            else if (a === '--detach' || (a === '-d' && subcommand === 'switch')) detach = true;
            else if (a === '--no-track' || a === '--track' || a === '-t' || a === '--recurse-submodules' || a === '--no-recurse-submodules' || a === '--progress' || a === '--no-progress') {}
            else rest.push(a);
          }
          const say = (m: string) => { if (!quiet) ctx.stderr += m; };
          // a switch that would overwrite local changes stops, as git's
          const switchTo = async (ref: string): Promise<boolean> => {
            try { await git.checkout({ fs, dir, ref, force }); return true; }
            catch (e: any) {
              if (e?.code !== 'CheckoutConflictError') throw e;
              ctx.stderr += `error: Your local changes to the following files would be overwritten by checkout:\n${(e.data?.filepaths ?? []).map((f: string) => `\t${f}\n`).join('')}Please commit your changes or stash them before you switch branches.\nAborting\n`;
              return false;
            }
          };
          const branches = await git.listBranches({ fs, dir });
          if (newBranch) {
            if (branches.includes(newBranch) && !force) { ctx.stderr = `fatal: a branch named '${newBranch}' already exists\n`; return 128; }
            let start: string | undefined;
            if (rest[0]) {
              try { start = await resolveRevision(fs, dir, rest[0]); }
              catch { ctx.stderr = `fatal: invalid reference: ${rest[0]}\n`; return 128; }
            }
            // (on an unborn branch there is nothing to point at yet: HEAD just names the new one)
            const unborn = !start && !(await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null));
            if (!unborn) await git.branch({ fs, dir, ref: newBranch, object: start, checkout: false, force });
            if (start && !(await switchTo(newBranch))) { await git.deleteBranch({ fs, dir, ref: newBranch }).catch(() => {}); return 1; }
            if (!start) await git.writeRef({ fs, dir, ref: 'HEAD', value: `refs/heads/${newBranch}`, symbolic: true, force: true });
            say(`Switched to a new branch '${newBranch}'\n`);
            break;
          }
          if (detach || (!rest.length && subcommand === 'checkout')) {
            if (!detach) break; // (plain `git checkout`: nothing to do)
            const oid = await resolveRevision(fs, dir, rest[0] ?? 'HEAD').catch(() => null);
            if (!oid) { ctx.stderr = `fatal: invalid reference: ${rest[0]}\n`; return 128; }
            if (!(await switchTo(oid))) return 1;
            const { commit } = await git.readCommit({ fs, dir, oid });
            say(`HEAD is now at ${oid.slice(0, 7)} ${commit.message.split('\n')[0]}\n`);
            break;
          }
          if (!rest.length) {
            ctx.stderr = 'fatal: missing branch or commit argument\n';
            return 128;
          }
          const target = rest[0];
          if (!sawDashDash && rest.length === 1 && branches.includes(target)) {
            if (target === await git.currentBranch({ fs, dir })) { say(`Already on '${target}'\n`); break; }
            if (!(await switchTo(target))) return 1;
            say(`Switched to branch '${target}'\n`);
            break;
          }
          if (!sawDashDash && rest.length === 1 && subcommand === 'checkout') {
            // a commit (detached HEAD) or a remote branch of that name
            const remoteRef = (await git.listBranches({ fs, dir, remote: 'origin' }).catch(() => [] as string[])).includes(target);
            if (remoteRef) {
              await git.branch({ fs, dir, ref: target, object: `refs/remotes/origin/${target}`, checkout: false });
              await git.setConfig({ fs, dir, path: `branch.${target}.remote`, value: 'origin' });
              await git.setConfig({ fs, dir, path: `branch.${target}.merge`, value: `refs/heads/${target}` });
              await git.checkout({ fs, dir, ref: target, force });
              say(`branch '${target}' set up to track 'origin/${target}'.\nSwitched to a new branch '${target}'\n`);
              break;
            }
            let oid: string | null = null;
            try { oid = await resolveRevision(fs, dir, target); } catch {}
            if (oid) {
              if (!(await switchTo(oid))) return 1;
              const { commit } = await git.readCommit({ fs, dir, oid });
              say(`HEAD is now at ${oid.slice(0, 7)} ${commit.message.split('\n')[0]}\n`);
              break;
            }
          }
          if (subcommand === 'switch') { ctx.stderr = `fatal: invalid reference: ${target}\n`; return 128; }
          // paths: from the index, or from a commit (checkout REV -- paths), as git restore does them
          let ref: string | null = null, paths = rest;
          if (sawDashDash) {
            const before = ctx.args.slice(1, ctx.args.indexOf('--')).filter(a => !a.startsWith('-'));
            if (before.length) ref = before[0];
            paths = ctx.args.slice(ctx.args.indexOf('--') + 1);
          }
          if (!paths.length) { ctx.stderr = 'fatal: you must specify path(s) to restore\n'; return 128; }
          const saved = ctx.args;
          ctx.args = ['restore', ...(ref ? ['--source', ref, '--staged', '--worktree'] : []), '--', ...paths];
          try { return await gitRestore(ctx, fs, dir, workDir); } finally { ctx.args = saved; }
        }

        case 'clone': {
          const cloneArgs = ctx.args.slice(1);
          let url = '';
          let cloneTarget = '';
          // The full git installed (this is builtinCloneHandles' case): its defaults,
          // all history, branches and tags; the built-in alone: a shallow clone
          const asFullGit = packageShadows(ctx.fs).has('git');
          let cloneDepth: number | undefined = asFullGit ? undefined : 1;
          let cloneBranch: string | undefined;
          let singleBranch: boolean | undefined;
          let noTags = false;
          let remoteName = 'origin';
          for (let i = 0; i < cloneArgs.length; i++) {
            const a = cloneArgs[i];
            if (a === '--depth' && i + 1 < cloneArgs.length) { cloneDepth = parseInt(cloneArgs[++i], 10) || 1; continue; }
            if (a.startsWith('--depth=')) { cloneDepth = parseInt(a.slice(8), 10) || 1; continue; }
            if (a === '--branch' || a === '-b') { cloneBranch = cloneArgs[++i]; continue; }
            if (a.startsWith('--branch=')) { cloneBranch = a.slice(9); continue; }
            if (a === '--origin' || a === '-o') { remoteName = cloneArgs[++i] || 'origin'; continue; }
            if (a.startsWith('--origin=')) { remoteName = a.slice(9) || 'origin'; continue; }
            if (a === '--single-branch') { singleBranch = true; continue; }
            if (a === '--no-single-branch') { singleBranch = false; continue; }
            if (a === '--no-tags') { noTags = true; continue; }
            if (a === '--quiet' || a === '-q') continue;
            if (a.startsWith('-')) continue;
            if (!url) { url = a; } else if (!cloneTarget) { cloneTarget = a; }
          }
          if (!url) { ctx.stderr = 'error: must specify repository URL\n'; return 1; }
          if (!url.startsWith('http://') && !url.startsWith('https://') && !url.startsWith('git://')) {
            url = 'https://' + url;
          }
          const repoName = url.split('/').pop()?.replace(/\.git$/, '') || 'repo';
          const targetDir = cloneTarget
            ? ctx.fs.resolvePath(cloneTarget, ctx.cwd)
            : ctx.fs.resolvePath(repoName, ctx.cwd);
          // As git: only into a new or empty directory, and a failed clone leaves nothing behind
          const existed = await ctx.fs.exists(targetDir);
          if (existed && (await ctx.fs.readdir(targetDir).catch(() => [])).length) {
            ctx.stderr = `fatal: destination path '${cloneTarget || repoName}' already exists and is not an empty directory.\n`;
            return 128;
          }
          await ctx.fs.mkdir(targetDir, { recursive: true });
          const gitDir = ctx.fs.resolvePath('.git', targetDir);
          await ctx.fs.mkdir(gitDir, { recursive: true });
          const undo = async () => {
            await ctx.fs.rm(existed ? gitDir : targetDir, { recursive: true }).catch(() => {});
          };
          ctx.stderr = `Cloning into '${cloneTarget || repoName}'...\n`;

          // proxy, relay or GitHub's API (git-transport.ts)
          const net = gitHttpFor(ctx.env, url, http);
          const token = ctx.env['GITHUB_TOKEN'] || (typeof localStorage !== 'undefined' ? localStorage.getItem('tabcomputer_github_token') || '' : '');
          // Too big for the page (#43): the full git, in its own worker, or a hint, never a frozen tab
          const limit = pageCloneLimit(ctx.env);
          const size = limit ? await githubCloneSize(url, { shallow: cloneDepth !== undefined, ref: cloneBranch, token, below: limit }) : null;
          if (size && size.bytes > limit) {
            await undo();
            const why = `${url} is about ${mb(size.bytes)} ${size.what}, more than the built-in clone can hold in this page (TABCOMPUTER_GIT_CLONE_MAX_MB=${limit / 1e6})`;
            if (asFullGit) {
              ctx.stderr = `(git: ${why}; the full git does it)\n`;
              const code = await realGit(ctx, argv, cwd0);
              if (code !== null) return code;
            }
            ctx.stderr = `fatal: ${why}\n`
              + 'hint: `pkg install git` and clone again: the full git runs in its own worker\n'
              + `hint: or read just the files you need: gh api repos/${githubRepo(url)}/contents/PATH\n`;
            return 128;
          }
          // github.com in private mode: GitHub's API from the browser; null: the relay does it
          const viaApi = net.transport === 'api'
            ? await apiCloneOp(ctx, { fs, dir: targetDir, url, token, remote: remoteName, ref: cloneBranch, depth: cloneDepth }).catch(async (e) => { await undo(); throw e; })
            : null;
          if (viaApi !== null && viaApi !== 0) { await undo(); return viaApi; }
          if (viaApi === null && net.transport === 'api') {
            // (what the API had written before it gave up: the relay's clone starts clean)
            await ctx.fs.rm(gitDir, { recursive: true }).catch(() => {});
            await ctx.fs.mkdir(gitDir, { recursive: true });
          }
          try {
            if (viaApi === null) await Promise.race([
              git.clone({
                fs, http: net.http, dir: targetDir, url,
                ...(net.corsProxy ? { corsProxy: net.corsProxy } : {}),
                remote: remoteName,
                // as git: --depth implies --single-branch
                singleBranch: singleBranch ?? (asFullGit ? cloneDepth !== undefined : true),
                noTags,
                ...(cloneDepth !== undefined ? { depth: cloneDepth } : {}),
                ...(cloneBranch ? { ref: cloneBranch } : {}),
                onProgress: async () => {
                  await new Promise(resolve => setTimeout(resolve, 0));
                },
                ...githubAuth(token, url),
              }),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error('clone timed out after 300s')), 300000)
              ),
            ]);
          } catch (cloneErr: any) {
            await undo();
            // isomorphic-git reads the pack back for the checkout and gets null when that read fails (#43)
            if (/null \(reading 'slice'\)/.test(String(cloneErr?.message))) cloneErr = new Error('could not read the downloaded pack back (browser storage or memory full?)');
            const httpStatus = cloneErr?.data?.statusCode;
            // The full git is there: it gets a clone the built-in couldn't do (not one refused for credentials)
            if (asFullGit && httpStatus !== 401 && httpStatus !== 403) {
              ctx.stderr = `(git: the built-in clone failed (${cloneErr.message || cloneErr}); the full git does it)\n`;
              const code = await realGit(ctx, argv, cwd0);
              if (code !== null) return code;
            }
            ctx.stderr += `fatal: ${cloneErr.message || cloneErr}\n`;
            if ((httpStatus === 401 || httpStatus === 403 || httpStatus === 404) && /github\.com/.test(url)) {
              ctx.stderr += token
                ? 'hint: the repository may not exist, or your GitHub sign-in lacks access to it.\n'
                : 'hint: private repositories need a GitHub sign-in. Run: gh auth login\n';
            }
            return 128;
          }

          try {
            await new Promise(resolve => setTimeout(resolve, 0));
            const branch = await git.currentBranch({ fs, dir: targetDir }) || 'main';
            await git.checkout({ fs, dir: targetDir, ref: branch, force: true });
            // The checked-out branch tracks the remote's, as git clone sets it up
            await git.setConfig({ fs, dir: targetDir, path: `branch.${branch}.remote`, value: remoteName });
            await git.setConfig({ fs, dir: targetDir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
          } catch { /* checkout best-effort */ }

          ctx.stderr += `done.\n`;
          break;
        }

        case 'remote': {
          const [, remoteCmd, name, url] = ctx.args;
          const remotes = await git.listRemotes({ fs, dir });
          const known = (n: string) => remotes.some(r => r.remote === n);
          if (!remoteCmd || remoteCmd === '-v' || remoteCmd === '--verbose') {
            for (const r of remotes) ctx.stdout += remoteCmd ? `${r.remote}\t${r.url} (fetch)\n${r.remote}\t${r.url} (push)\n` : `${r.remote}\n`;
            break;
          }
          if (remoteCmd === 'add') {
            if (!name || !url) { ctx.stderr = 'usage: git remote add [<options>] <name> <url>\n'; return 129; }
            if (known(name)) { ctx.stderr = `error: remote ${name} already exists.\n`; return 3; }
            await git.addRemote({ fs, dir, remote: name, url });
            break;
          }
          if (remoteCmd === 'get-url' || remoteCmd === 'set-url' || remoteCmd === 'remove' || remoteCmd === 'rm' || remoteCmd === 'rename') {
            if (!name) { ctx.stderr = `usage: git remote ${remoteCmd} <name>\n`; return 129; }
            if (!known(name)) { ctx.stderr = remoteCmd === 'remove' || remoteCmd === 'rm' || remoteCmd === 'rename' ? `error: No such remote: '${name}'\n` : `error: No such remote '${name}'\n`; return 2; }
            if (remoteCmd === 'get-url') { ctx.stdout = `${remotes.find(r => r.remote === name)!.url}\n`; break; }
            if (remoteCmd === 'set-url') {
              if (!url) { ctx.stderr = 'usage: git remote set-url [--push] <name> <newurl> [<oldurl>]\n'; return 129; }
              await git.setConfig({ fs, dir, path: `remote.${name}.url`, value: url });
              break;
            }
            if (remoteCmd === 'rename') {
              if (!url) { ctx.stderr = 'usage: git remote rename [--[no-]progress] <old> <new>\n'; return 129; }
              if (known(url)) { ctx.stderr = `error: remote ${url} already exists.\n`; return 3; }
              const old = remotes.find(r => r.remote === name)!;
              await git.deleteRemote({ fs, dir, remote: name });
              await git.addRemote({ fs, dir, remote: url, url: old.url });
              // its remote-tracking branches and the branches that track it move along
              for (const b of await git.listBranches({ fs, dir, remote: name }).catch(() => [] as string[])) {
                const oid = await git.resolveRef({ fs, dir, ref: `refs/remotes/${name}/${b}` }).catch(() => null);
                if (oid && b !== 'HEAD') await git.writeRef({ fs, dir, ref: `refs/remotes/${url}/${b}`, value: oid, force: true });
                await git.deleteRef({ fs, dir, ref: `refs/remotes/${name}/${b}` }).catch(() => {});
              }
              for (const b of await git.listBranches({ fs, dir })) {
                if (await git.getConfig({ fs, dir, path: `branch.${b}.remote` }).catch(() => undefined) === name) await git.setConfig({ fs, dir, path: `branch.${b}.remote`, value: url });
              }
              break;
            }
            await git.deleteRemote({ fs, dir, remote: name });
            for (const b of await git.listBranches({ fs, dir, remote: name }).catch(() => [] as string[])) await git.deleteRef({ fs, dir, ref: `refs/remotes/${name}/${b}` }).catch(() => {});
            break;
          }
          ctx.stderr = `error: unknown subcommand: \`${remoteCmd}'\n`;
          return 129;
        }

        case 'push': {
          const { remote, ref, token } = parseRemoteArgs(ctx);
          if (!token) {
            ctx.stderr = 'error: not signed in to GitHub. Run: gh auth login\n';
            return 1;
          }
          const currentBranch = ref || await git.currentBranch({ fs, dir }) || 'main';
          const pushUrl = await remoteUrl(fs, dir, remote);
          const net = gitHttpFor(ctx.env, pushUrl, http);
          ctx.stdout = `Pushing to ${remote}/${currentBranch}...\n`;
          const pushForce = ctx.args.includes('-f') || ctx.args.includes('--force');
          const pushedByApi = net.transport === 'api'
            ? await apiPushOp(ctx, { fs, dir, url: pushUrl, token, remote, branch: currentBranch, force: pushForce })
            : null;
          if (pushedByApi !== null && pushedByApi !== 0) return pushedByApi;
          try {
            const result = pushedByApi === 0 ? { ok: true } as Awaited<ReturnType<typeof git.push>> : await git.push({
              fs, http: net.http, dir,
              remote,
              ref: currentBranch,
              force: ctx.args.includes('-f') || ctx.args.includes('--force'),
              ...(net.corsProxy ? { corsProxy: net.corsProxy } : {}),
              ...githubAuth(token, pushUrl),
              onMessage: (msg: string) => { ctx.stdout += msg; },
            });
            if (result.ok) {
              ctx.stdout += `done.\n`;
              if (ctx.args.includes('-u') || ctx.args.includes('--set-upstream')) {
                await git.setConfig({ fs, dir, path: `branch.${currentBranch}.remote`, value: remote });
                await git.setConfig({ fs, dir, path: `branch.${currentBranch}.merge`, value: `refs/heads/${currentBranch}` });
                ctx.stdout += `branch '${currentBranch}' set up to track '${remote}/${currentBranch}'.\n`;
              }
            } else {
              ctx.stderr = `error: push failed\n`;
              if (result.refs) {
                for (const [refName, status] of Object.entries(result.refs)) {
                  if (!(status as any).ok) {
                    ctx.stderr += `  ${refName}: ${(status as any).error || 'rejected'}\n`;
                  }
                }
              }
              return 1;
            }
          } catch (e: any) {
            const http = e.statusCode || e.data?.statusCode;
            if (http === 413) {
              // nginx in front of the git proxy takes requests up to 100 MB; the built-in git
              // sends more than the new objects (all of history for a new branch of a big repo)
              ctx.stderr = `error: push failed: the upload was too large for tabcomputer's git proxy (HTTP 413, over 100 MB).\n`
                + `The full git sends only what the remote lacks: pkg install git, then git push again.\n`;
            } else if (e.code === 'HttpError' || e.statusCode === 401 || e.statusCode === 403) {
              ctx.stderr = `error: authentication failed (HTTP ${e.statusCode || e.data?.statusCode || ''})\nSign in again with: gh auth login (or gh auth refresh if the token lacks access)\n`;
            } else if (e.code === 'PushRejectedError') {
              ctx.stderr = `error: push rejected — remote has new commits. Pull first.\n`;
            } else {
              ctx.stderr = `error: push failed: ${e.message}\n`;
            }
            return 1;
          }
          break;
        }

        case 'fetch': {
          const { remote, token } = parseRemoteArgs(ctx);
          const quiet = ctx.args.includes('-q') || ctx.args.includes('--quiet');
          // --all: every remote (none is fine: nothing to do)
          const remotes = ctx.args.includes('--all')
            ? (await git.listRemotes({ fs, dir })).map(r => r.remote)
            : [remote];
          for (const r of remotes) {
            if (!(await remoteUrl(fs, dir, r))) {
              ctx.stderr += `fatal: '${r}' does not appear to be a git repository\nfatal: Could not read from remote repository.\n`;
              return 128;
            }
            if (!quiet) ctx.stderr += `Fetching ${r}\n`;
            const net = gitHttpFor(ctx.env, await remoteUrl(fs, dir, r), http);
            if (net.transport === 'api') {
              const code = await apiFetchOp(ctx, { fs, dir, url: await remoteUrl(fs, dir, r), token, remote: r, all: true });
              if (code === 0) continue;
              if (code !== null) return code;
            }
            await git.fetch({
              fs, http: net.http, dir,
              remote: r,
              ...(net.corsProxy ? { corsProxy: net.corsProxy } : {}),
              prune: ctx.args.includes('--prune') || ctx.args.includes('-p'),
              tags: ctx.args.includes('--tags') || ctx.args.includes('-t'),
              ...githubAuth(token, await remoteUrl(fs, dir, r)),
            });
          }
          break;
        }

        case 'pull': {
          const { remote, ref, token } = parseRemoteArgs(ctx);
          const currentBranch = ref || await git.currentBranch({ fs, dir }) || 'main';
          const net = gitHttpFor(ctx.env, await remoteUrl(fs, dir, remote), http);
          ctx.stdout = `Pulling from ${remote}/${currentBranch}...\n`;
          if (net.transport === 'api') {
            const code = await apiPullOp(ctx, { fs, dir, url: await remoteUrl(fs, dir, remote), token, remote, branch: currentBranch, author: await resolveAuthor(ctx, fs, dir) });
            if (code === 0) { ctx.stdout += `done.\n`; break; }
            if (code !== null) return code;
          }
          await git.pull({
            fs, http: net.http, dir,
            remote,
            ref: currentBranch,
            ...(net.corsProxy ? { corsProxy: net.corsProxy } : {}),
            singleBranch: true,
            author: await resolveAuthor(ctx, fs, dir),
            ...githubAuth(token, await remoteUrl(fs, dir, remote)),
          });
          ctx.stdout += `done.\n`;
          break;
        }

        case 'merge': {
          let noFF = false, ffOnly = false, quiet = false, abort = false, message: string | undefined;
          const names: string[] = [];
          for (let i = 1; i < ctx.args.length; i++) {
            const a = ctx.args[i];
            if (a === '--no-ff') noFF = true;
            else if (a === '--ff') noFF = false;
            else if (a === '--ff-only') ffOnly = true;
            else if (a === '-q' || a === '--quiet') quiet = true;
            else if (a === '--abort') abort = true;
            else if (a === '-m' || a === '--message') message = ctx.args[++i];
            else if (a.startsWith('--message=')) message = a.slice(10);
            else if (!a.startsWith('-')) names.push(a);
          }
          const gitDir = `${dir === '/' ? '' : dir}/.git`;
          const mergeFiles = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE'];
          if (abort) {
            if (!(await ctx.fs.exists(`${gitDir}/MERGE_HEAD`))) { ctx.stderr = 'fatal: There is no merge to abort (MERGE_HEAD missing).\n'; return 128; }
            const saved = ctx.args;
            ctx.args = ['reset', '--hard', '-q', 'HEAD'];
            try { await gitReset(ctx, fs, dir, workDir); } finally { ctx.args = saved; }
            for (const f of mergeFiles) await ctx.fs.unlink(`${gitDir}/${f}`).catch(() => {});
            break;
          }
          if (await ctx.fs.exists(`${gitDir}/MERGE_HEAD`)) {
            ctx.stderr = 'error: Merging is not possible because you have unmerged files.\nhint: Fix them up in the work tree, and then use \'git add/rm <file>\'\nhint: as appropriate to mark resolution and make a commit.\nfatal: Exiting because of an unresolved conflict.\n';
            return 128;
          }
          const theirs = names[0];
          if (!theirs) {
            ctx.stderr = 'fatal: No remote for the current branch.\n';
            return 128;
          }
          const theirOid = await resolveRevision(fs, dir, theirs).catch(() => null);
          if (!theirOid) { ctx.stderr = `merge: ${theirs} - not something we can merge\n`; return 1; }
          const ours = await git.currentBranch({ fs, dir }) || 'main';
          const before = await git.resolveRef({ fs, dir, ref: 'HEAD' });
          // (" into B" unless B is main or master: git's merge.suppressDest default)
          const msg = message ?? `Merge branch '${theirs}'${ours === 'main' || ours === 'master' ? '' : ` into ${ours}`}`;
          // what the work tree had before: a conflict's cleanly merged files are staged, these aren't
          const local = new Set((await pathEntries(fs, dir, true)).filter((e) => !e.stage || e.work?.oid !== e.stage.oid).map((e) => e.path));
          let mergeResult;
          try {
            mergeResult = await git.merge({
              // (a branch by name: isomorphic-git labels the conflict markers with it)
              fs, dir, ours, theirs: await git.expandRef({ fs, dir, ref: theirs }).then(() => theirs, () => theirOid),
              fastForward: !noFF,
              fastForwardOnly: ffOnly,
              message: msg,
              author: await resolveAuthor(ctx, fs, dir),
              committer: await resolveCommitter(ctx, fs, dir),
              // a conflict leaves the markers in the work tree and the stages in the index, as git
              abortOnConflict: false,
            });
          } catch (e: any) {
            if (e.code === 'MergeConflictError') {
              const d = e.data ?? {};
              await ctx.fs.writeFile(`${gitDir}/MERGE_HEAD`, `${theirOid}\n`);
              await ctx.fs.writeFile(`${gitDir}/MERGE_MODE`, '');
              await ctx.fs.writeFile(`${gitDir}/MERGE_MSG`, `${msg}\n\n# Conflicts:\n${(d.filepaths ?? []).map((f: string) => `#\t${f}\n`).join('')}`);
              await git.writeRef({ fs, dir, ref: 'ORIG_HEAD', value: before, force: true }).catch(() => {});
              const conflicted = await unmergedPaths(fs, dir);
              for (const e of await pathEntries(fs, dir, true)) {
                if (conflicted.has(e.path) || local.has(e.path) || !e.work || e.work.oid === e.stage?.oid) continue;
                await git.add({ fs, dir, filepath: e.path });
              }
              // our side's marker says HEAD, as git's does
              for (const f of d.bothModified ?? []) {
                const path = `${dir === '/' ? '' : dir}/${f}`;
                const text = await ctx.fs.readFile(path, 'utf8').catch(() => null) as string | null;
                if (text !== null) await ctx.fs.writeFile(path, text.replace(new RegExp(`^<{7} ${ours.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'gm'), '<<<<<<< HEAD'));
              }
              for (const f of d.bothModified ?? []) ctx.stdout += `Auto-merging ${f}\nCONFLICT (content): Merge conflict in ${f}\n`;
              for (const f of d.deleteByUs ?? []) ctx.stdout += `CONFLICT (modify/delete): ${f} deleted in HEAD and modified in ${theirs}.  Version ${theirs} of ${f} left in tree.\n`;
              for (const f of d.deleteByTheirs ?? []) ctx.stdout += `CONFLICT (modify/delete): ${f} deleted in ${theirs} and modified in HEAD.  Version HEAD of ${f} left in tree.\n`;
              ctx.stdout += 'Automatic merge failed; fix conflicts and then commit the result.\n';
              return 1;
            }
            if (e.code === 'MergeNotSupportedError') {
              ctx.stderr = 'error: the built-in git can\'t merge these changes (`pkg install git` has the full git)\n';
              return 1;
            }
            if (e.code === 'FastForwardError') { ctx.stderr = 'fatal: Not possible to fast-forward, aborting.\n'; return 128; }
            throw e;
          }
          // the merge moved the branch; the work tree and index follow
          if (!mergeResult.alreadyMerged) await git.checkout({ fs, dir, ref: ours });
          if (quiet) break;
          if (mergeResult.alreadyMerged) { ctx.stdout = 'Already up to date.\n'; break; }
          if (mergeResult.fastForward) ctx.stdout = `Updating ${before.slice(0, 7)}..${mergeResult.oid?.slice(0, 7)}\nFast-forward\n`;
          else ctx.stdout = `Merge made by the 'ort' strategy.\n`;
          ctx.stdout += await changeSummary(fs, dir, before, mergeResult.oid!, true);
          break;
        }

        case 'stash':
          return gitStashHandler(ctx, fs, dir, workDir, () => resolveCommitter(ctx, fs, dir));

        case 'reset':
          return gitReset(ctx, fs, dir, workDir);
        case 'rm':
          return gitRm(ctx, fs, dir, workDir);
        case 'mv':
          return gitMv(ctx, fs, dir, workDir);
        case 'restore':
          return gitRestore(ctx, fs, dir, workDir);
        case 'clean':
          return gitClean(ctx, fs, dir, workDir);
        case 'blame':
          return gitBlame(ctx, fs, dir, workDir);

        case 'tag':
          return gitTagHandler(ctx, fs, dir, () => resolveCommitter(ctx, fs, dir));

        case 'cherry-pick':
        case 'revert': {
          // Each commit's change applied to HEAD and committed, as git's sequencer does; where
          // HEAD changed the same file since, the built-in stops (the full git merges)
          const reverse = subcommand === 'revert';
          const record = ctx.args.includes('-x');
          const specs = ctx.args.slice(1).filter(a => !a.startsWith('-'));
          if (!specs.length) { ctx.stderr = `usage: git ${subcommand} [<options>] <commit-ish>...\n`; return 129; }
          for (const spec of specs) {
            let oid: string;
            try { oid = await resolveRevision(fs, dir, spec); }
            catch { ctx.stderr = `fatal: bad revision '${spec}'\n`; return 128; }
            const { commit: picked } = await git.readCommit({ fs, dir, oid });
            const parent = picked.parent[0] ?? null;
            if (picked.parent.length > 1) { ctx.stderr = `error: commit ${oid} is a merge but no -m option was given.\nfatal: ${subcommand} failed\n`; return 128; }
            const [from, to] = reverse ? [oid, parent] : [parent, oid];
            if (!to) { ctx.stderr = `error: cannot ${subcommand} a root commit\n`; return 128; }
            const changes = await changesBetweenTrees(fs, dir, from, to);
            const head = await git.resolveRef({ fs, dir, ref: 'HEAD' });
            const now = new Map((await pathEntries(fs, dir, true)).map(e => [e.path, e]));
            const subject = picked.message.split('\n')[0];
            const dirty = changes.filter(c => { const e = now.get(c.path); return e && (e.stage?.oid !== e.head?.oid || (e.stage && e.work?.oid !== e.stage.oid)); });
            if (dirty.length) {
              ctx.stderr = `error: your local changes would be overwritten by ${subcommand}.\nhint: commit your changes or stash them to proceed.\nfatal: ${subcommand} failed\n`;
              return 128;
            }
            const clash = changes.filter(c => { const ours = now.get(c.path)?.head?.oid; return ours !== c.old && ours !== c.new; });
            if (clash.length) {
              ctx.stderr = `error: could not ${reverse ? 'revert' : 'apply'} ${oid.slice(0, 7)}... ${subject}\n`
                + `(the built-in git: ${clash.map(c => c.path).join(', ')} changed since; \`pkg install git\` merges the changes)\n`;
              return 1;
            }
            const todo = changes.filter(c => now.get(c.path)?.head?.oid !== c.new);
            if (!todo.length) {
              ctx.stdout += `On branch ${await git.currentBranch({ fs, dir }) ?? 'HEAD'}\nnothing to commit, working tree clean\n`;
              ctx.stderr += `The previous ${subcommand} is now empty, possibly due to conflict resolution.\nIf you wish to commit it anyway, use:\n\n    git commit --allow-empty\n\n`;
              return 1;
            }
            const root = dir === '/' ? '' : dir;
            for (const c of todo) {
              if (c.new) {
                const { blob } = await git.readBlob({ fs, dir, oid: c.new });
                const full = `${root}/${c.path}`;
                await ctx.fs.mkdir(full.slice(0, full.lastIndexOf('/')) || '/', { recursive: true }).catch(() => {});
                await ctx.fs.writeFile(full, blob);
                await git.add({ fs, dir, filepath: c.path });
              } else {
                await ctx.fs.unlink(`${root}/${c.path}`).catch(() => {});
                await git.remove({ fs, dir, filepath: c.path });
              }
            }
            const me = await resolveAuthor(ctx, fs, dir);
            const message = reverse
              ? `Revert "${subject}"\n\nThis reverts commit ${oid}.\n`
              : picked.message.replace(/\n*$/, '\n') + (record ? `\n(cherry picked from commit ${oid})\n` : '');
            const author = reverse ? { ...me, timestamp: me.timestamp ?? Math.floor(Date.now() / 1000), timezoneOffset: me.timezoneOffset ?? new Date().getTimezoneOffset() } : picked.author;
            const sha = await git.commit({ fs, dir, message, author, committer: await resolveCommitter(ctx, fs, dir) });
            const branch = await git.currentBranch({ fs, dir });
            ctx.stdout += `[${branch ?? 'detached HEAD'} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n Date: ${gitDate(author as any)}\n`;
            ctx.stdout += await changeSummary(fs, dir, head, sha, false);
          }
          return 0;
        }

        case 'rebase': {
          if (ctx.args[1] === '-i' || ctx.args[1] === '--interactive') {
            ctx.stderr = 'fatal: interactive rebase is not supported\n';
            return 1;
          }
          if (ctx.args[1] === '--continue' || ctx.args[1] === '--abort') {
            ctx.stderr = `fatal: no rebase in progress\n`;
            return 1;
          }
          const rebaseQuiet = ctx.args.includes('-q') || ctx.args.includes('--quiet');
          const target = ctx.args.slice(1).find(a => !a.startsWith('-'));
          if (!target) { ctx.stderr = 'usage: git rebase <branch>\n'; return 1; }
          let targetOid: string;
          try {
            targetOid = await git.resolveRef({ fs, dir, ref: target });
          } catch {
            ctx.stderr = `fatal: invalid upstream '${target}'\n`; return 128;
          }
          const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
          // Find merge base (walk both histories to find common ancestor)
          const targetLog = await git.log({ fs, dir, ref: targetOid, depth: 200 });
          const headLog = await git.log({ fs, dir, ref: headOid, depth: 200 });
          const targetOids = new Set(targetLog.map(c => c.oid));
          let mergeBase = '';
          for (const c of headLog) {
            if (targetOids.has(c.oid)) { mergeBase = c.oid; break; }
          }
          if (!mergeBase) { ctx.stderr = 'fatal: no common ancestor found\n'; return 1; }
          // Collect commits from merge-base..HEAD (exclusive of merge-base)
          const toReplay: typeof headLog = [];
          for (const c of headLog) {
            if (c.oid === mergeBase) break;
            toReplay.push(c);
          }
          toReplay.reverse();
          if (toReplay.length === 0) {
            ctx.stdout = `Current branch is up to date.\n`;
            return 0;
          }
          // Reset HEAD to target
          const currentBranch = await git.currentBranch({ fs, dir }) || 'HEAD';
          await git.writeRef({ fs, dir, ref: `refs/heads/${currentBranch}`, value: targetOid, force: true });
          // Checkout target tree
          await git.checkout({ fs, dir, ref: currentBranch, force: true });
          // Cherry-pick each commit
          for (const entry of toReplay) {
            const parentOid = entry.commit.parent[0];
            if (!parentOid) continue;
            const changes = await git.walk({ fs, dir, trees: [git.TREE({ ref: parentOid }), git.TREE({ ref: entry.oid })],
              map: async (filepath: string, [A, B]: any[]) => {
                if (filepath === '.') return;
                const aOid = A ? await A.oid() : null;
                const bOid = B ? await B.oid() : null;
                if (aOid === bOid) return;
                const bType = B ? await B.type() : null;
                const aType = A ? await A.type() : null;
                if (bType === 'tree' || aType === 'tree') return;
                return { filepath, bOid };
              },
            });
            for (const ch of changes.filter(Boolean)) {
              const fullPath = dir + '/' + ch.filepath;
              if (ch.bOid) {
                const { blob } = await git.readBlob({ fs, dir, oid: ch.bOid });
                await ctx.fs.mkdir(fullPath.split('/').slice(0, -1).join('/'), { recursive: true });
                await ctx.fs.writeFile(fullPath, new TextDecoder().decode(blob));
                await git.add({ fs, dir, filepath: ch.filepath });
              } else {
                await ctx.fs.unlink(fullPath).catch(() => {});
                await git.remove({ fs, dir, filepath: ch.filepath });
              }
            }
            await git.commit({ fs, dir, message: entry.commit.message, author: entry.commit.author });
          }
          if (!rebaseQuiet) ctx.stdout = `Successfully rebased and updated refs/heads/${currentBranch}.\n`;
          return 0;
        }

        case 'ls-remote':
          return lsRemote(ctx, fs, dir, dir);

        default:
          ctx.stderr = `git: '${subcommand}' is not a git command\n`;
          return 1;
      }
    } catch (e: any) {
      ctx.stderr = `fatal: ${e.message}\n`;
      return 128;
    }

    return 0;
}

export { GLOBAL_GITCONFIG, parseGitConfig, formatGitConfig };

/** Whether the nearest .git up from `from` is a file (a linked worktree's or a submodule's), not a directory */
async function dotGitIsFile(ctx: CommandContext, from: string): Promise<boolean> {
  for (let d: string | null = from; d; d = d === '/' ? null : d.slice(0, d.lastIndexOf('/')) || '/') {
    const p = d === '/' ? '/.git' : `${d}/.git`;
    if (await ctx.fs.exists(p)) return !(await ctx.fs.stat(p)).isDirectory();
  }
  return false;
}

async function readGlobalConfig(ctx: CommandContext): Promise<Record<string, string>> {
  try { return parseGitConfig(await ctx.fs.readFile(GLOBAL_GITCONFIG, 'utf8') as string); } catch { return {}; }
}

interface Ident { name: string; email: string; timestamp?: number; timezoneOffset?: number }

/** A GIT_*_DATE: `@1700000000 +0100`, `1700000000 +0100`, or a date Date.parse reads (ISO 8601, RFC 2822) */
export function parseGitDate(s: string | undefined): { timestamp: number; timezoneOffset: number } | null {
  if (!s) return null;
  const m = /^@?(\d+)(?:\s+([+-])(\d\d):?(\d\d))?$/.exec(s.trim());
  // (isomorphic-git's timezoneOffset is getTimezoneOffset()'s: minutes west, so +0100 is -60)
  // (`|| 0`: +0000 is 0, not -0, which isomorphic-git writes as -0000)
  if (m) return { timestamp: Number(m[1]), timezoneOffset: (m[2] ? (m[2] === '+' ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4])) : 0) || 0 };
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  const z = /([+-])(\d\d):?(\d\d)$/.exec(s.trim());
  return { timestamp: Math.floor(t / 1000), timezoneOffset: (z ? (z[1] === '+' ? -1 : 1) * (Number(z[2]) * 60 + Number(z[3])) : 0) || 0 };
}

/**
 * Commit author or committer, as git: GIT_AUTHOR_* / GIT_COMMITTER_* first, then
 * the repo's config, ~/.gitconfig, then a default; GIT_*_DATE sets the time.
 */
async function resolveIdent(ctx: CommandContext, fs: any, dir: string, who: 'AUTHOR' | 'COMMITTER' = 'AUTHOR'): Promise<Ident> {
  const repoValue = async (path: string) => { try { return await git.getConfig({ fs, dir, path }); } catch { return undefined; } };
  const global = await readGlobalConfig(ctx);
  const ident: Ident = {
    name: ctx.env[`GIT_${who}_NAME`] || (await repoValue('user.name')) || global['user.name'] || ctx.env['USER'] || 'user',
    email: ctx.env[`GIT_${who}_EMAIL`] || (await repoValue('user.email')) || global['user.email'] || ctx.env['EMAIL'] || `user@${activeProfile().hostname}.local`,
  };
  const when = parseGitDate(ctx.env[`GIT_${who}_DATE`]);
  return when ? { ...ident, ...when } : ident;
}
const resolveAuthor = (ctx: CommandContext, fs: any, dir: string) => resolveIdent(ctx, fs, dir, 'AUTHOR');
const resolveCommitter = (ctx: CommandContext, fs: any, dir: string) => resolveIdent(ctx, fs, dir, 'COMMITTER');

async function gitConfigCommand(ctx: CommandContext, fs: any, dir: string, overrides: [string, string][] = []): Promise<number> {
  const args = ctx.args.slice(1);
  let global = false, system = false, local = false, list = false, unset = false, nul = false, nameOnly = false;
  let mode = '' as 'get' | 'get-all' | 'get-regexp' | '', type = '', dflt: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--global') global = true;
    else if (a === '--system') system = true;
    else if (a === '--local') local = true;
    else if (a === '--list' || a === '-l') list = true;
    else if (a === '--unset' || a === '--unset-all') unset = true;
    else if (a === '-z' || a === '--null') nul = true;
    else if (a === '--name-only') nameOnly = true;
    else if (a === '--get' || a === '--get-all' || a === '--get-regexp') mode = a.slice(2) as typeof mode;
    else if (a === '--bool' || a === '--int' || a === '--path') type = a.slice(2);
    else if (a.startsWith('--type=')) type = a.slice(7);
    else if (a === '--type') type = args[++i] ?? '';
    else if (a.startsWith('--default=')) dflt = a.slice(10);
    else if (a === '--default') dflt = args[++i];
    else if (a === '--includes' || a === '--no-includes' || a === '--show-origin' || a === '--show-scope' || a === '--add' || a === '--replace-all') {}
    else if (a === '-f' || a === '--file' || a === '--blob') i++;
    else positional.push(a);
  }
  // --list and the get forms read the repository's config from a subdirectory too
  let root: string | null = dir;
  while (root && !(await ctx.fs.exists(root === '/' ? '/.git' : `${root}/.git`))) {
    root = root === '/' ? null : root.slice(0, root.lastIndexOf('/')) || '/';
  }
  const inRepo = root !== null;
  if (root) dir = root;
  const readAll = async (): Promise<Record<string, string>> => {
    const values: Record<string, string> = {};
    if (!global && !local) {
      try { Object.assign(values, parseGitConfig(await ctx.fs.readFile('/etc/gitconfig', 'utf8') as string)); } catch {}
    }
    if (system) return values;
    if (!local) Object.assign(values, await readGlobalConfig(ctx));
    if (!global && inRepo) {
      try { Object.assign(values, parseGitConfig(await ctx.fs.readFile(dir + '/.git/config', 'utf8') as string)); } catch {}
    }
    if (!global && !local) for (const [k, v] of overrides) values[k.toLowerCase()] = v;
    return values;
  };
  const typed = (v: string) => {
    if (type === 'bool') return /^(true|yes|on|1|)$/i.test(v) ? 'true' : 'false';
    if (type === 'int') { const m = v.match(/^(-?\d+)([kmg]?)$/i); return m ? String(+m[1] * ({ '': 1, k: 1024, m: 1048576, g: 1073741824 } as any)[m[2].toLowerCase()]) : v; }
    if (type === 'path' && v.startsWith('~/')) return (ctx.env['HOME'] || '/home/user') + v.slice(1);
    return v;
  };
  const end = nul ? '\0' : '\n';
  const pair = (k: string, v: string) => nameOnly ? k + end : nul ? `${k}\n${typed(v)}\0` : mode === 'get-regexp' ? `${k} ${typed(v)}\n` : `${k}=${typed(v)}\n`;

  if (list) {
    ctx.stdout = Object.entries(await readAll()).map(([k, v]) => pair(k, v)).join('');
    return 0;
  }
  if (mode === 'get-regexp') {
    let re: RegExp;
    try { re = new RegExp(positional[0] ?? '.', 'i'); } catch { ctx.stderr = `error: invalid key pattern: ${positional[0]}\n`; return 6; }
    const hits = Object.entries(await readAll()).filter(([k]) => re.test(k));
    ctx.stdout = hits.map(([k, v]) => pair(k, v)).join('');
    return hits.length ? 0 : 1;
  }
  const key = positional[0]?.toLowerCase();
  const value = positional.slice(1).join(' ');
  if (!key) { ctx.stderr = 'usage: git config [--global] <name> [<value>] | --list | --unset <name>\n'; return 1; }
  if (mode || (!value && !unset)) {
    const v = (await readAll())[key] ?? dflt;
    if (v === undefined) return 1;
    ctx.stdout = typed(v) + end;
    return 0;
  }

  if (global || !inRepo) {
    if (!global && !inRepo) { ctx.stderr = 'fatal: not in a git directory\n'; return 128; }
    const values = await readGlobalConfig(ctx);
    if (unset) { if (values[key] === undefined) return 5; delete values[key]; }
    else values[key] = value;
    await ctx.fs.writeFile(GLOBAL_GITCONFIG, formatGitConfig(values));
    return 0;
  }
  await git.setConfig({ fs, dir, path: key, value: unset ? undefined : value });
  return 0;
}

/**
 * Credentials for GitHub remotes, sent on the first request. Left to the usual
 * 401 challenge, the browser answers GitHub's `WWW-Authenticate: Basic` with its
 * own login prompt, which stalls that request and every later one to the same
 * origin until the clone/push times out. Only github.com URLs get the token.
 */
export function githubAuth(token: string, url: string | undefined): Record<string, any> {
  if (!token || !url || !/^https?:\/\/([^/@]+@)?github\.com\//.test(url)) return {};
  return {
    headers: { Authorization: 'Basic ' + btoa('x-access-token:' + token) },
    onAuth: () => ({ username: 'x-access-token', password: token }),
    onAuthFailure: () => ({ cancel: true }),
  };
}

/** `git ls-remote [--heads|--tags] URL|REMOTE [patterns]` */
async function lsRemote(ctx: CommandContext, fs: any, cwd: string, dir: string | null): Promise<number> {
  const pos = ctx.args.slice(1).filter(a => !a.startsWith('-'));
  const target = pos[0] ?? 'origin';
  const url = dir && !/[:@]/.test(target) ? await remoteUrl(fs, dir, target) : target;
  if (!url) { ctx.stderr = `fatal: '${target}' does not appear to be a git repository\n`; return 128; }
  const { token } = parseRemoteArgs(ctx);
  const net = gitHttpFor(ctx.env, url, http);
  void cwd;
  const heads = ctx.args.includes('--heads') || ctx.args.includes('-h') || ctx.args.includes('--branches');
  const tags = ctx.args.includes('--tags') || ctx.args.includes('-t');
  let refs: { ref: string; oid: string; target?: string; peeled?: string }[];
  try {
    refs = await git.listServerRefs({ http: net.http, url, ...(net.corsProxy ? { corsProxy: net.corsProxy } : {}), symrefs: true, peelTags: true, ...githubAuth(token, url) });
  } catch (e: any) {
    ctx.stderr = `fatal: unable to access '${url}': ${e.message}\n`;
    return 128;
  }
  const pats = pos.slice(1);
  let out = '';
  for (const r of refs) {
    if (heads && !r.ref.startsWith('refs/heads/')) continue;
    if (tags && !r.ref.startsWith('refs/tags/')) continue;
    if (pats.length && !pats.some(p => r.ref === p || r.ref.endsWith('/' + p))) continue;
    out += `${r.oid}\t${r.ref}\n`;
    if (r.peeled) out += `${r.peeled}\t${r.ref}^{}\n`;
  }
  if (!ctx.args.includes('-q') && !ctx.args.includes('--quiet')) ctx.stdout += out;
  return 0;
}

async function remoteUrl(fs: any, dir: string, remote: string): Promise<string | undefined> {
  try { return await git.getConfig({ fs, dir, path: `remote.${remote}.url` }); } catch { return undefined; }
}

function parseRemoteArgs(ctx: CommandContext): { remote: string; ref: string; token: string } {
  let remote = 'origin';
  let ref = '';
  const positional: string[] = [];
  for (let i = 1; i < ctx.args.length; i++) {
    if (!ctx.args[i].startsWith('-')) {
      positional.push(ctx.args[i]);
    }
  }
  if (positional.length >= 1) remote = positional[0];
  if (positional.length >= 2) ref = positional[1];

  const token = ctx.env['GITHUB_TOKEN']
    || (typeof localStorage !== 'undefined' ? localStorage.getItem('tabcomputer_github_token') || '' : '');
  return { remote, ref, token };
}


