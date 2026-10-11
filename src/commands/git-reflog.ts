/**
 * The built-in git's reflogs, as git keeps them (tabcomputer#86): each update
 * of HEAD or a branch appends "<old> <new> <name> <<email>> <time> <tz>\t<message>"
 * to .git/logs/HEAD and .git/logs/refs/heads/<branch>. isomorphic-git writes
 * none, so a git command that moves refs snapshots HEAD and the branches before
 * it runs, and after it writes what moved, with git's message for that command
 * ("commit: <subject>", "reset: moving to HEAD~1", "checkout: moving from a to b").
 * core.logAllRefUpdates false: only logs that already exist grow, as git's.
 * `HEAD@{N}` / `main@{N}` / `@{N}` read them back (git-utils.ts, resolveRevision).
 */
import git from './git-cached';
import type { CommandContext } from './index';
import { resolveRevision } from './git-utils';

type Fs = any;

export const ZERO_OID = '0'.repeat(40);

export interface ReflogIdent { name: string; email: string; timestamp?: number; timezoneOffset?: number }

interface RefState {
  /** the branch HEAD names (unborn too), or null when detached */
  branch: string | null;
  head: string | null;
  branches: Map<string, string>;
  mergeHead: boolean;
  stash: string | null;
}

/** The subcommands that can move HEAD or a branch */
const MOVERS = new Set(['commit', 'checkout', 'switch', 'branch', 'merge', 'reset', 'cherry-pick', 'revert', 'rebase', 'pull', 'stash']);
const OFF = new Set(['false', 'no', 'off', '0']);

const gitDirOf = (dir: string) => `${dir === '/' ? '' : dir}/.git`;

async function refState(ctx: CommandContext, fs: Fs, dir: string): Promise<RefState> {
  const branches = new Map<string, string>();
  for (const b of await git.listBranches({ fs, dir }).catch(() => [] as string[])) {
    const oid = await git.resolveRef({ fs, dir, ref: `refs/heads/${b}` }).catch(() => null);
    if (oid) branches.set(b, oid);
  }
  return {
    branch: (await git.currentBranch({ fs, dir, fullname: false }).catch(() => undefined)) || null,
    head: await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null),
    branches,
    mergeHead: await ctx.fs.exists(`${gitDirOf(dir)}/MERGE_HEAD`),
    stash: await git.resolveRef({ fs, dir, ref: 'refs/stash' }).catch(() => null),
  };
}

/** "Name <email> 1791733459 -0400", as git writes an ident */
function identText(p: ReflogIdent): string {
  const ts = p.timestamp ?? Math.floor(Date.now() / 1000);
  const off = p.timezoneOffset ?? new Date().getTimezoneOffset();
  const m = Math.abs(off);
  return `${p.name} <${p.email}> ${ts} ${off > 0 ? '-' : '+'}${String(Math.floor(m / 60)).padStart(2, '0')}${String(m % 60).padStart(2, '0')}`;
}

const subjectOf = (message: string) => message.split('\n')[0];

/** The commits from `from` (exclusive) to `to`, oldest first, along first parents; each with the oid before it */
async function stepsBetween(fs: Fs, dir: string, from: string | null, to: string): Promise<{ old: string | null; oid: string; subject: string }[]> {
  const chain: { oid: string; subject: string; parent: string | null }[] = [];
  let oid: string | null = to;
  while (oid && oid !== from && chain.length < 1000) {
    const { commit } = await git.readCommit({ fs, dir, oid });
    chain.push({ oid, subject: subjectOf(commit.message), parent: commit.parent[0] ?? null });
    oid = commit.parent[0] ?? null;
  }
  // (not an ancestor: one step, from where HEAD was)
  const steps = oid === from ? chain.reverse() : chain.slice(0, 1);
  return steps.map((s, i) => ({ old: i === 0 ? from : steps[i - 1].oid, oid: s.oid, subject: s.subject }));
}

/** The words of a command line that aren't options (`valued` options' values skipped), and whether `--` was there */
function positionals(args: string[], valued: string[]): { pos: string[]; dashdash: boolean; value: (o: string) => string | undefined } {
  const pos: string[] = [];
  const values = new Map<string, string>();
  let dashdash = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { dashdash = true; break; }
    if (valued.includes(a)) { values.set(a, args[++i] ?? ''); continue; }
    if (a.startsWith('-') && a !== '-') continue;
    pos.push(a);
  }
  return { pos, dashdash, value: (o) => values.get(o) };
}

/**
 * Before a git command: what it may move. The function returned writes the
 * reflog entries for what did move, given the command's exit status; null when
 * `sub` moves nothing.
 */
export async function startReflog(
  ctx: CommandContext, fs: Fs, dir: string, sub: string, args: string[],
  logAll: () => Promise<string | undefined>, ident: () => Promise<ReflogIdent>,
): Promise<((code: number) => Promise<void>) | null> {
  if (!MOVERS.has(sub)) return null;
  const before = await refState(ctx, fs, dir);
  return async (code: number) => {
    try {
      await writeEntries(ctx, fs, dir, sub, args, code, before, await logAll(), ident);
    } catch { /* a reflog that can't be written never fails the command */ }
  };
}

async function writeEntries(
  ctx: CommandContext, fs: Fs, dir: string, sub: string, args: string[], code: number,
  before: RefState, logAll: string | undefined, ident: () => Promise<ReflogIdent>,
): Promise<void> {
  const after = await refState(ctx, fs, dir);
  const logs = `${gitDirOf(dir)}/logs`;
  const off = OFF.has(String(logAll ?? '').toLowerCase());
  let who: string | null = null;
  const append = async (ref: string, old: string | null | undefined, oid: string | null | undefined, msg: string) => {
    if (!oid) return;
    const path = `${logs}/${ref}`;
    if (off && !(await ctx.fs.exists(path))) return;
    who ??= identText(await ident());
    await ctx.fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true }).catch(() => {});
    await ctx.fs.appendFile(path, `${old ?? ZERO_OID} ${oid} ${who}\t${msg.replace(/\n/g, ' ')}\n`);
  };
  const branchLog = (b: string) => `refs/heads/${b}`;
  // HEAD's entries, and the same for the branch HEAD is on when that branch moved with it
  const onHead = async (steps: [string | null, string | null, string][]) => {
    const b = after.branch;
    const branchMoved = b !== null && b === before.branch && before.branches.get(b) !== after.branches.get(b);
    for (const [old, oid, msg] of steps) {
      await append('HEAD', old, oid, msg);
      if (branchMoved) await append(branchLog(b!), old, oid, msg);
    }
  };
  const headMoved = before.head !== after.head;
  const removed = [...before.branches.keys()].filter((b) => !after.branches.has(b));
  const added = [...after.branches.keys()].filter((b) => !before.branches.has(b));
  const changed = [...after.branches.keys()].filter((b) => before.branches.has(b) && before.branches.get(b) !== after.branches.get(b));

  switch (sub) {
    case 'commit': {
      if (!headMoved || !after.head) break;
      const { commit } = await git.readCommit({ fs, dir, oid: after.head });
      const kind = !before.head ? 'commit (initial)' : args.includes('--amend') ? 'commit (amend)' : before.mergeHead ? 'commit (merge)' : 'commit';
      await onHead([[before.head, after.head, `${kind}: ${subjectOf(commit.message)}`]]);
      break;
    }
    case 'cherry-pick':
    case 'revert': {
      if (!headMoved || !after.head) break;
      const steps = await stepsBetween(fs, dir, before.head, after.head);
      await onHead(steps.map((s) => [s.old, s.oid, `${sub}: ${s.subject}`]));
      break;
    }
    case 'merge':
    case 'pull': {
      if (sub === 'merge' && args.includes('--abort')) {
        if (code === 0) await onHead([[after.head, after.head, 'reset: moving to HEAD']]);
        break;
      }
      if (!headMoved || !after.head) break;
      const { commit } = await git.readCommit({ fs, dir, oid: after.head });
      const how = commit.parent.length > 1 && commit.parent[0] === before.head ? "Merge made by the 'ort' strategy." : 'Fast-forward';
      const what = sub === 'merge' ? `merge ${positionals(args, ['-m', '--message']).pos[0] ?? 'HEAD'}` : 'pull';
      await onHead([[before.head, after.head, `${what}: ${how}`]]);
      break;
    }
    case 'reset': {
      if (code !== 0) break;
      // a reset of HEAD (not of paths): no words, or one that names a revision
      const { pos, dashdash } = positionals(args, []);
      const rest = dashdash ? args.slice(args.indexOf('--') + 1) : [];
      let target: string | null = null;
      if (!rest.length && pos.length === 0) target = 'HEAD';
      else if (!rest.length && pos.length === 1 && (headMoved || await isRevision(fs, dir, pos[0]))) target = pos[0];
      if (target !== null) await onHead([[before.head, after.head, `reset: moving to ${target}`]]);
      break;
    }
    case 'stash': {
      const what = args[0] && !args[0].startsWith('-') ? args[0] : 'push';
      // (push saves, then resets the work tree to HEAD)
      if (code === 0 && (what === 'push' || what === 'save') && after.stash && after.stash !== before.stash) {
        await onHead([[after.head, after.head, 'reset: moving to HEAD']]);
      }
      break;
    }
    case 'checkout':
    case 'switch': {
      const { pos, dashdash, value } = positionals(args, ['-b', '-B', '-c', '-C']);
      const newBranch = value('-b') ?? value('-B') ?? value('-c') ?? value('-C');
      const start = pos[0] ?? 'HEAD';
      for (const b of added) await append(branchLog(b), null, after.branches.get(b), `branch: Created from ${start}`);
      for (const b of changed) await append(branchLog(b), before.branches.get(b), after.branches.get(b), `branch: Reset to ${start}`);
      const alreadyOn = !newBranch && !dashdash && pos.length === 1 && pos[0] === before.branch;
      if (code === 0 && (headMoved || before.branch !== after.branch || alreadyOn)) {
        const from = before.branch ?? before.head;
        const to = after.branch ?? pos[0] ?? after.head;
        await append('HEAD', before.head, after.head, `checkout: moving from ${from} to ${to}`);
      }
      break;
    }
    case 'branch': {
      const move = args.some((a) => a === '--move' || /^-[a-zA-Z]*[mM]/.test(a));
      const { pos } = positionals(args, []);
      if (move) {
        const from = removed[0];
        const to = added[0] ?? changed[0];
        if (from && to) {
          const text = await ctx.fs.readFile(`${logs}/${branchLog(from)}`, 'utf8').catch(() => null) as string | null;
          await ctx.fs.unlink(`${logs}/${branchLog(from)}`).catch(() => {});
          await ctx.fs.unlink(`${logs}/${branchLog(to)}`).catch(() => {});
          if (text !== null) {
            await ctx.fs.mkdir(`${logs}/${branchLog(to)}`.replace(/\/[^/]*$/, ''), { recursive: true }).catch(() => {});
            await ctx.fs.writeFile(`${logs}/${branchLog(to)}`, text);
          }
          const oid = after.branches.get(to)!;
          await append(branchLog(to), oid, oid, `Branch: renamed refs/heads/${from} to refs/heads/${to}`);
        }
        return;
      }
      const start = pos[1] ?? before.branch ?? 'HEAD';
      for (const b of added) await append(branchLog(b), null, after.branches.get(b), `branch: Created from ${start}`);
      for (const b of changed) await append(branchLog(b), before.branches.get(b), after.branches.get(b), `branch: Reset to ${start}`);
      break;
    }
    case 'rebase': {
      // (the built-in's rebase: the branch set to the upstream, then each commit picked)
      const b = after.branch;
      const upstream = positionals(args, []).pos[0];
      if (!headMoved || !after.head || !b || !upstream) break;
      const onto = await git.resolveRef({ fs, dir, ref: upstream }).catch(() => null);
      if (!onto) break;
      const steps = await stepsBetween(fs, dir, onto, after.head);
      await append('HEAD', before.head, onto, `rebase (start): checkout ${upstream}`);
      for (const s of steps) await append('HEAD', s.old, s.oid, `rebase (pick): ${s.subject}`);
      await append('HEAD', after.head, after.head, `rebase (finish): returning to refs/heads/${b}`);
      await append(branchLog(b), before.branches.get(b), after.head, `rebase (finish): refs/heads/${b} onto ${onto}`);
      break;
    }
  }
  // a deleted branch's log goes with it
  for (const b of removed) await ctx.fs.unlink(`${logs}/${branchLog(b)}`).catch(() => {});
}

async function isRevision(fs: Fs, dir: string, spec: string): Promise<boolean> {
  return resolveRevision(fs, dir, spec).then(() => true, () => false);
}
