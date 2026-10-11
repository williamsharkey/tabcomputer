/**
 * How big a clone the built-in git would take on, before it starts (#43).
 *
 * The built-in clone (isomorphic-git) runs on the page's thread with the whole
 * pack in memory: it downloads it, indexes it (pako and SHA-1 over every
 * object, yielding only once per percent) and reads it back for the checkout.
 * Up to ~40 MB that takes seconds; tabcomputer's own repository, ~300 MB of
 * mostly incompressible tarballs, froze the tab for over a minute, where
 * neither `timeout` nor Ctrl-C can reach it. So for GitHub, whose API says how
 * big a branch's files are (or a repository's whole history), a clone above
 * the limit goes to the full git, which runs in its own worker, or stops with
 * a hint instead of freezing the page.
 */

/** Default limit in MB; TABCOMPUTER_GIT_CLONE_MAX_MB changes it, 0 turns the check off. */
export const PAGE_CLONE_MAX_MB = 100;

export interface CloneSize {
  /** Bytes the clone would bring: the branch's files (shallow) or the repository's history. */
  bytes: number;
  /** What `bytes` counts, for the message. */
  what: string;
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<any> }>;

/** owner/repo of a github.com https URL, else null. */
export function githubRepo(url: string): string | null {
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : null;
}

/**
 * The clone's size from the GitHub API, or null when it can't say (not
 * GitHub, offline, rate-limited, a private repository without a token): then
 * the clone goes ahead as before. Shallow: the files of `ref` (or the default
 * branch); otherwise the repository's size, which counts all of its history.
 */
export async function githubCloneSize(url: string, opts: {
  shallow: boolean;
  ref?: string;
  token?: string;
  /** A repository whose whole history is at most this needs no second request (its size bounds any branch's). */
  below?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
}): Promise<CloneSize | null> {
  const repo = githubRepo(url);
  if (!repo) return null;
  const get: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init));
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  const api = async (path: string) => {
    const signal = typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(opts.timeoutMs ?? 10_000) : undefined;
    const res = await get(`https://api.github.com/repos/${repo}${path}`, { headers, ...(signal ? { signal } : {}) });
    return res.ok ? res.json() : null;
  };
  try {
    const info = await api('');
    if (!info || typeof info.size !== 'number') return null;
    const history: CloneSize = { bytes: info.size * 1024, what: 'with its history' };
    if (!opts.shallow || (opts.below !== undefined && history.bytes <= opts.below)) return history;
    const ref = opts.ref || info.default_branch;
    if (!ref) return history;
    const tree = await api(`/git/trees/${encodeURI(ref)}?recursive=1`);
    // (a tree too big to list in one response: the repository's size is the bound left)
    if (!tree || !Array.isArray(tree.tree) || tree.truncated) return history;
    let bytes = 0;
    for (const e of tree.tree) if (e.type === 'blob' && typeof e.size === 'number') bytes += e.size;
    return { bytes, what: `in ${ref}'s files` };
  } catch {
    return null;
  }
}

/** The limit in bytes from the environment (0: no limit). */
export function pageCloneLimit(env: Record<string, string | undefined>): number {
  const v = env.TABCOMPUTER_GIT_CLONE_MAX_MB;
  const mb = v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : PAGE_CLONE_MAX_MB;
  return Math.max(0, mb) * 1e6;
}

export const mb = (bytes: number) => `${Math.round(bytes / 1e6)} MB`;
