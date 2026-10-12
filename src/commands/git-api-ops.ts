/**
 * git clone/fetch/pull/push for github.com through GitHub's REST API
 * (git-github-api.ts), as git.ts calls it in private network mode
 * (git-transport.ts). Each returns null when the API is not the way to do
 * this one (too big, a rate limit, something it cannot express): the caller
 * then does it by the git protocol over the relay, which is private too.
 */
import git from './git-cached';
import type { CommandContext } from './index';

/** Codes after which the relay takes over; any other error is the user's to read */
const RELAY_INSTEAD = new Set(['too-large', 'unsupported', 'rate-limit', 'api', 'network', 'empty']);

interface Remote { fs: any; dir: string; url: string | undefined; token: string; remote: string }

async function api() { return import('./git-github-api'); }

/** null: not for the API (the note says why, on stderr); a number: done, with that exit status */
async function attempt(ctx: CommandContext, what: string, token: string, body: (m: Awaited<ReturnType<typeof api>>, gh: { owner: string; repo: string }) => Promise<number>, url: string | undefined): Promise<number | null> {
  const m = await api();
  const gh = m.parseGitHubRemote(url);
  if (!gh) return null;
  try {
    return await body(m, gh);
  } catch (e: any) {
    if (!(e instanceof m.GitHubApiError)) throw e;
    if (RELAY_INSTEAD.has(e.code)) {
      ctx.stderr += `(git: ${what} through GitHub's API was not possible (${e.message}); using the relay)\n`;
      return null;
    }
    ctx.stderr += `fatal: ${e.message}\n`;
    if (e.code === 'auth' || e.code === 'not-found') {
      ctx.stderr += token
        ? 'hint: the repository may not exist, or your GitHub sign-in lacks access to it.\n'
        : 'hint: private repositories need a GitHub sign-in. Run: gh auth login\n';
    }
    return 128;
  }
}

/** The module reports every object: the terminal gets the other messages, and the last count once */
function progress(ctx: CommandContext): { report: (message: string) => void; done: () => void } {
  let last = '';
  return {
    report(message) {
      if (/^(Receiving|Writing) objects/.test(message)) { last = message; return; }
      ctx.stderr += message.endsWith('\n') ? message : message + '\n';
    },
    done() { if (last) ctx.stderr += last.replace(/\n?$/, ', done.\n'); },
  };
}

/**
 * A clone through the API is one request per file (about 40 files a second),
 * so only small repositories go that way; the relay clones the rest in one
 * pack. TABCOMPUTER_GIT_API_MAX_FILES moves the line.
 */
export const API_CLONE_MAX_FILES = 300;
export const API_CLONE_MAX_BYTES = 20 * 1000 * 1000;

export function apiCloneOp(ctx: CommandContext, o: Remote & { ref?: string; depth?: number }): Promise<number | null> {
  return attempt(ctx, 'clone', o.token, async (m, gh) => {
    const common = { ...gh, token: o.token || undefined, remote: o.remote };
    // A full clone is a request per file and a few per commit: only repositories the API can carry
    const est = await m.apiCloneEstimate({ ...common, ref: o.ref });
    const maxFiles = Number(ctx.env['TABCOMPUTER_GIT_API_MAX_FILES']) || API_CLONE_MAX_FILES;
    if (est.truncated || est.files > maxFiles || est.bytes > API_CLONE_MAX_BYTES) {
      throw new m.GitHubApiError('too-large', `${est.files}${est.truncated ? '+' : ''} files, ${Math.round(est.bytes / 1e6)} MB: a request per file would be slow`);
    }
    const p = progress(ctx);
    const r = await m.apiClone({ ...common, fs: o.fs, dir: o.dir, ref: o.ref, depth: o.depth ?? 0, maxFiles, onProgress: p.report });
    p.done();
    if (r.shallow && o.depth === undefined) ctx.stderr += '(git: history is shallow here: the rest could not be read through the API)\n';
    return 0;
  }, o.url);
}

export function apiFetchOp(ctx: CommandContext, o: Remote & { branch?: string; all?: boolean }): Promise<number | null> {
  return attempt(ctx, 'fetch', o.token, async (m, gh) => {
    await m.apiFetch({ ...gh, token: o.token || undefined, remote: o.remote, fs: o.fs, dir: o.dir, branch: o.branch, all: o.all, onProgress: progress(ctx).report });
    return 0;
  }, o.url);
}

/** Fetch the branch, then merge it as `git pull` does (a fast-forward when it can be) */
export function apiPullOp(ctx: CommandContext, o: Remote & { branch: string; author: { name: string; email: string } }): Promise<number | null> {
  return attempt(ctx, 'pull', o.token, async (m, gh) => {
    await m.apiFetch({ ...gh, token: o.token || undefined, remote: o.remote, fs: o.fs, dir: o.dir, branch: o.branch, onProgress: progress(ctx).report });
    await git.merge({ fs: o.fs, dir: o.dir, ours: o.branch, theirs: `refs/remotes/${o.remote}/${o.branch}`, author: o.author, committer: o.author });
    await git.checkout({ fs: o.fs, dir: o.dir, ref: o.branch });
    return 0;
  }, o.url);
}

export function apiPushOp(ctx: CommandContext, o: Remote & { branch: string; force: boolean }): Promise<number | null> {
  return attempt(ctx, 'push', o.token, async (m, gh) => {
    const p = progress(ctx);
    const r = await m.apiPush({ ...gh, token: o.token, remote: o.remote, fs: o.fs, dir: o.dir, branch: o.branch, force: o.force, onProgress: p.report });
    p.done();
    if (!r.ok) {
      ctx.stderr += /non-fast-forward/.test(r.error ?? '')
        ? 'error: push rejected — remote has new commits. Pull first.\n'
        : `error: push failed: ${r.error ?? 'rejected'}\n`;
      return 1;
    }
    if (r.rewritten) ctx.stderr += `(git: GitHub stored ${r.commits === 1 ? 'the commit' : 'these commits'} under different ids; ${o.branch} now points at GitHub's)\n`;
    return 0;
  }, o.url);
}
