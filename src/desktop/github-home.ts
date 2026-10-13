/**
 * The Git app's home and Files' Repositories panel (docs/DESKTOP.md "Git"):
 * the data side, no DOM. A small api.github.com client (CORS allows
 * `Authorization: Bearer` from any origin; the same-origin `/api/github`
 * proxy is the fallback when the direct request can't be made), the sign-in
 * state (GitHub's device flow, github-auth.ts), the lists it shows (your
 * repositories, notifications, pull requests, assigned issues) cached in
 * localStorage for an instant first paint, the repositories already on this
 * computer, and the HTML for each row. githome-ui.ts puts it on screen.
 */

import type { FileSystem } from '../filesystem';
import { GITHUB_TOKEN_KEY, DEFAULT_GITHUB_SCOPES, pollForToken, requestDeviceCode, saveGitHubToken } from '../github-auth';
import { onNetworkStatus, setNetworkStatus } from '../net-signin';
import { networkMode } from '../net-mode';
import { headBranch, parseRepoSpec, type Repo } from './gitstatus';

// ── API types (only the fields used) ──

export interface GhUser { login: string; name?: string | null; avatar_url: string; html_url: string }
export interface GhRepo {
  id: number; name: string; full_name: string; owner: { login: string }; private: boolean; fork?: boolean; archived?: boolean;
  description: string | null; language: string | null; pushed_at: string | null; updated_at: string; stargazers_count: number;
  html_url: string; clone_url?: string; default_branch?: string;
}
export interface GhNotification {
  id: string; unread: boolean; reason: string; updated_at: string;
  subject: { title: string; url: string | null; type: string };
  repository: { full_name: string; html_url: string };
}
export interface GhIssue { id: number; number: number; title: string; html_url: string; repository_url: string; updated_at: string; pull_request?: unknown; draft?: boolean }

export type GitHubErrorKind = 'auth' | 'rate' | 'offline' | 'http';
export class GitHubError extends Error {
  constructor(public kind: GitHubErrorKind, message: string, public status = 0, public resetAt: number | null = null) { super(message); }
}

type FetchLike = typeof fetch;
const API = 'https://api.github.com';

/** True when the Link header has a next page */
export function hasNextPage(link: string | null): boolean {
  return !!link && /<[^>]+>;\s*rel="next"/.test(link);
}

/**
 * A GET/POST/PATCH to api.github.com with the token. Errors are GitHubError:
 * auth (401: the token was revoked or expired), rate (403/429 with no
 * requests left; resetAt in ms), offline (the request never got an answer),
 * http (anything else, GitHub's message).
 */
export function gitHubApi(token: string, opts: { fetchImpl?: FetchLike; proxyBase?: string | null } = {}) {
  const fetchImpl = opts.fetchImpl ?? ((...a: Parameters<FetchLike>) => fetch(...a));
  // (private network mode has no fallback: the request must not reach this site's server)
  const proxyBase = opts.proxyBase === undefined ? (networkMode() === 'private' ? null : '/api/github') : opts.proxyBase;
  async function request<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<{ data: T; next: boolean }> {
    const reqInit: RequestInit = {
      method: init.method ?? 'GET',
      headers: {
        Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
        ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    };
    let res: Response;
    try { res = await fetchImpl(API + path, reqInit); }
    catch {
      // A blocked cross-origin request (an extension, a proxy): this site's own route
      if (!proxyBase) throw new GitHubError('offline', "Can't reach GitHub. Check the connection.");
      try { res = await fetchImpl(proxyBase + path, reqInit); }
      catch { throw new GitHubError('offline', "Can't reach GitHub. Check the connection."); }
    }
    if (res.status === 401) throw new GitHubError('auth', 'Your GitHub sign-in has expired or was revoked. Sign in again.', 401);
    const remaining = res.headers.get('x-ratelimit-remaining');
    if (res.status === 429 || (res.status === 403 && remaining === '0')) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) || 0;
      const retry = Number(res.headers.get('retry-after')) || 0;
      const resetAt = reset ? reset * 1000 : retry ? Date.now() + retry * 1000 : null;
      throw new GitHubError('rate', `GitHub's rate limit is used up${resetAt ? `; it resets at ${new Date(resetAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : ''}.`, res.status, resetAt);
    }
    if (res.status === 205 || res.status === 204) return { data: null as T, next: false };
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new GitHubError('http', `GitHub answered ${res.status}${body?.message ? `: ${body.message}` : ''}`, res.status);
    return { data: body as T, next: hasNextPage(res.headers.get('link')) };
  }
  return {
    request,
    user: () => request<GhUser>('/user').then(r => r.data),
    repos: (page = 1, perPage = 50) => request<GhRepo[]>(`/user/repos?sort=pushed&per_page=${perPage}&page=${page}&affiliation=owner,collaborator,organization_member`),
    notifications: () => request<GhNotification[]>('/notifications?all=true&per_page=30').then(r => r.data),
    search: (q: string) => request<{ items: GhIssue[] }>(`/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=10`).then(r => r.data.items ?? []),
    markRead: (id: string) => request<null>(`/notifications/threads/${encodeURIComponent(id)}`, { method: 'PATCH' }),
    createRepo: (name: string, isPrivate: boolean, description = '') =>
      request<GhRepo>('/user/repos', { method: 'POST', body: { name, private: isPrivate, description, auto_init: false } }).then(r => r.data),
  };
}

// ── What the lists show ──

export interface HomeData {
  user: GhUser | null;
  repos: GhRepo[];
  /** The next page of /user/repos to ask for, or 0 when there is none */
  reposNext: number;
  notifications: GhNotification[];
  prs: GhIssue[];
  issues: GhIssue[];
  /** When it was fetched (ms) */
  at: number;
}

export type RepoVisibility = 'all' | 'public' | 'private';
export type RepoSort = 'pushed' | 'name' | 'stars';

/** The repositories a filter box, a visibility choice and a sort leave */
export function filterRepos(repos: GhRepo[], opts: { query?: string; visibility?: RepoVisibility; sort?: RepoSort } = {}): GhRepo[] {
  const q = (opts.query ?? '').trim().toLowerCase();
  let out = repos.filter(r =>
    (opts.visibility === 'public' ? !r.private : opts.visibility === 'private' ? r.private : true) &&
    (!q || r.full_name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q) || (r.language ?? '').toLowerCase() === q));
  const time = (r: GhRepo) => Date.parse(r.pushed_at ?? r.updated_at) || 0;
  if (opts.sort === 'name') out = [...out].sort((a, b) => a.full_name.localeCompare(b.full_name, undefined, { sensitivity: 'base' }));
  else if (opts.sort === 'stars') out = [...out].sort((a, b) => b.stargazers_count - a.stargazers_count || time(b) - time(a));
  else out = [...out].sort((a, b) => time(b) - time(a));
  return out;
}

/** Unread first, then newest */
export function sortNotifications(list: GhNotification[]): GhNotification[] {
  return [...list].sort((a, b) => (a.unread === b.unread ? Date.parse(b.updated_at) - Date.parse(a.updated_at) : a.unread ? -1 : 1));
}

/** The github.com page for a notification (its API URL turned into the web one), else the repository */
export function notificationLink(n: GhNotification): string {
  const m = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/(issues|pulls|commits|releases)\/([^/]+)$/.exec(n.subject.url ?? '');
  if (!m) return n.repository.html_url;
  const kind = m[2] === 'pulls' ? 'pull' : m[2] === 'commits' ? 'commit' : m[2];
  if (kind === 'releases') return `https://github.com/${m[1]}/releases`;
  return `https://github.com/${m[1]}/${kind}/${m[3]}`;
}

/** "owner/repo" of a search result */
export function issueRepo(i: GhIssue): string {
  return i.repository_url.replace(/^https:\/\/api\.github\.com\/repos\//, '');
}

/** "just now", "5m ago", "3h ago", "2d ago", "3w ago", else the date */
export function relTime(iso: string | null | undefined, now = Date.now()): string {
  const t = Date.parse(iso ?? '');
  if (!t) return '';
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400 / 7)}w ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
}

// ── Repositories on this computer ──

export const HOME = '/home/user';
export const SRC = `${HOME}/src`;
const RECENT_KEY = 'tabcomputer_git_recent';

export interface LocalRepo {
  path: string;
  name: string;
  branch: string | null;
  /** owner/repo of its GitHub origin, lowercase, when it has one */
  origin: string | null;
  worktree: boolean;
  /** Last activity: the index's (or HEAD's) mtime */
  mtime: number;
}

/** owner/repo (lowercase) of `[remote "origin"] url` in a git config, if it is a GitHub URL */
export function parseOrigin(config: string): string | null {
  let inOrigin = false;
  for (const raw of config.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('[')) { inOrigin = /^\[remote\s+"origin"\]$/.test(line); continue; }
    const m = inOrigin && /^url\s*=\s*(.+)$/.exec(line);
    if (m) {
      const url = m[1].trim().replace(/^(https?:\/\/)[^@/]+@/, '$1');
      const spec = parseRepoSpec(url);
      return spec ? `${spec.owner}/${spec.repo}`.toLowerCase() : null;
    }
  }
  return null;
}

/** Recently opened repositories (the Git app remembers them), newest first */
export function recentRepos(): string[] {
  try { const v = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); return Array.isArray(v) ? v.filter(x => typeof x === 'string') : []; } catch { return []; }
}
export function rememberRepo(path: string): void {
  try { localStorage.setItem(RECENT_KEY, JSON.stringify([path, ...recentRepos().filter(p => p !== path)].slice(0, 12))); } catch {}
}

type DiscoverFs = Pick<FileSystem, 'readdir' | 'stat' | 'readFile' | 'resolvePath'>;

/** The repository whose top is exactly `dir`, or null */
async function repoAt(fs: DiscoverFs, dir: string): Promise<Repo | null> {
  const dotgit = `${dir}/.git`;
  let st;
  try { st = await fs.stat(dotgit); } catch { return null; }
  if (st.isDirectory()) return { root: dir, gitdir: dotgit, worktree: false };
  try {
    const m = /^gitdir:\s*(.+)\s*$/m.exec(await fs.readFile(dotgit, 'utf8') as string);
    if (m) return { root: dir, gitdir: fs.resolvePath(m[1].trim(), dir), worktree: true };
  } catch {}
  return null;
}

/**
 * The repositories on this computer: ~/src/NAME, ~/src/OWNER/NAME, ~/NAME and
 * the recently opened ones, each with its branch and GitHub origin, most
 * recently used first.
 */
export async function discoverLocalRepos(fs: DiscoverFs, recent: string[] = recentRepos()): Promise<LocalRepo[]> {
  const ls = (d: string) => fs.readdir(d).catch(() => [] as string[]);
  const candidates: string[] = [...recent];
  for (const n of await ls(SRC)) {
    if (n.startsWith('.')) continue;
    candidates.push(`${SRC}/${n}`);
    // An owner folder (not itself a repository): one level more
    if (!(await repoAt(fs, `${SRC}/${n}`))) for (const m of await ls(`${SRC}/${n}`)) if (!m.startsWith('.')) candidates.push(`${SRC}/${n}/${m}`);
  }
  for (const n of await ls(HOME)) if (!n.startsWith('.') && n !== 'src') candidates.push(`${HOME}/${n}`);
  const seen = new Set<string>();
  const out: LocalRepo[] = [];
  for (const path of candidates) {
    if (seen.has(path)) continue;
    seen.add(path);
    const repo = await repoAt(fs, path);
    if (!repo) continue;
    const common = repo.worktree ? repo.gitdir.replace(/\/worktrees\/[^/]+$/, '') : repo.gitdir;
    let origin: string | null = null;
    try { origin = parseOrigin(await fs.readFile(`${common}/config`, 'utf8') as string); } catch {}
    let mtime = 0;
    for (const f of ['index', 'HEAD']) { try { mtime = Math.max(mtime, (await fs.stat(`${repo.gitdir}/${f}`)).mtime.getTime()); } catch {} }
    out.push({ path, name: path.split('/').pop()!, branch: await headBranch(fs as FileSystem, repo), origin, worktree: repo.worktree, mtime });
  }
  const rank = (p: string) => { const i = recent.indexOf(p); return i < 0 ? Infinity : i; };
  return out.sort((a, b) => rank(a.path) - rank(b.path) || b.mtime - a.mtime || a.path.localeCompare(b.path));
}

/** owner/repo (lowercase) → its local folder; a repository cloned twice maps to the first */
export function localIndex(locals: LocalRepo[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const l of locals) if (l.origin && !l.worktree && !m.has(l.origin)) m.set(l.origin, l.path);
  return m;
}

/** Where a one-click clone goes: ~/src/NAME, else ~/src/OWNER/NAME, else ~/src/NAME-2… */
export async function cloneTarget(owner: string, name: string, exists: (p: string) => Promise<boolean>): Promise<string> {
  for (const p of [`${SRC}/${name}`, `${SRC}/${owner}/${name}`]) if (!(await exists(p))) return p;
  for (let i = 2; ; i++) if (!(await exists(`${SRC}/${name}-${i}`))) return `${SRC}/${name}-${i}`;
}

/** A repository name GitHub accepts */
export function validRepoName(name: string): boolean {
  return /^[A-Za-z0-9_.-]{1,100}$/.test(name) && name !== '.' && name !== '..' && !name.endsWith('.git');
}

/**
 * git init in `dir` (branch main); with `readme`, a README.md and a first
 * commit. `origin` sets the remote. Returns the commit id, if one was made.
 */
export async function createLocalRepo(fs: FileSystem, dir: string, opts: { readme?: boolean; author?: { name: string; email: string }; origin?: string } = {}): Promise<string | null> {
  const git = await import('isomorphic-git');
  const gfs = fs.toIsomorphicGitFS() as Parameters<typeof git.init>[0]['fs'];
  await fs.mkdir(dir, { recursive: true });
  await git.init({ fs: gfs, dir, defaultBranch: 'main' });
  if (opts.origin) await git.addRemote({ fs: gfs, dir, remote: 'origin', url: opts.origin });
  if (!opts.readme) return null;
  await fs.writeFile(`${dir}/README.md`, `# ${dir.split('/').pop()}\n`);
  await git.add({ fs: gfs, dir, filepath: 'README.md' });
  return git.commit({ fs: gfs, dir, message: 'Initial commit', author: opts.author ?? { name: 'user', email: 'user@localhost' } });
}

// ── Sign-in and the lists, shared by every window ──

export type Phase = 'signed-out' | 'requesting' | 'code' | 'signed-in';
export interface Notice { kind: GitHubErrorKind | 'info'; text: string }
export interface CloneState { dest: string; progress: string; error?: string; done?: boolean }

const CACHE_KEY = 'tabcomputer_git_home';

/** A short tag for a token, so a cache never shows one account's lists to another (never the token itself) */
export function tokenTag(token: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) h = Math.imul(h ^ token.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(36);
}

export interface ModelOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** The /api/github fallback (null: none, as in tests) */
  proxyBase?: string | null;
  /** Called with the new token after a sign-in (git identity, the network status) */
  onSignedIn?: (token: string) => void;
}

/**
 * Sign-in state and the GitHub lists. `refresh()` shows the cached lists at
 * once and fetches new ones; a 401 signs out with a message, a rate limit or
 * no connection keeps what's on screen with a notice.
 */
export class GitHubHomeModel {
  phase: Phase = 'signed-out';
  code: { userCode: string; uri: string } | null = null;
  data: HomeData | null = null;
  notice: Notice | null = null;
  loading = false;
  loadingMore = false;
  clones = new Map<string, CloneState>();
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private seq = 0;

  constructor(private opts: ModelOptions = {}) {
    if (this.token()) { this.phase = 'signed-in'; this.data = this.readCache(); }
  }

  token(): string | null {
    try { return localStorage.getItem(GITHUB_TOKEN_KEY) || null; } catch { return null; }
  }
  api() {
    const t = this.token();
    return t ? gitHubApi(t, { fetchImpl: this.opts.fetchImpl, proxyBase: this.opts.proxyBase }) : null;
  }
  subscribe(cb: () => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  emit(): void { for (const cb of this.listeners) { try { cb(); } catch (e) { console.warn('[git home]', e); } } }

  private readCache(): HomeData | null {
    const t = this.token();
    try {
      const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      return c && t && c.tag === tokenTag(t) ? c.data as HomeData : null;
    } catch { return null; }
  }
  private writeCache(): void {
    const t = this.token();
    if (!t || !this.data) return;
    // The first pages only: a cache is for the first paint
    const data = { ...this.data, repos: this.data.repos.slice(0, 100), reposNext: this.data.repos.length > 100 ? 0 : this.data.reposNext };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ tag: tokenTag(t), data })); } catch {}
  }

  /** Follow the saved token: signed in elsewhere (the network sheet, gh auth login) or signed out */
  sync(): void {
    const has = !!this.token();
    if (has && this.phase !== 'signed-in') { this.phase = 'signed-in'; this.code = null; this.abort?.abort(); this.data = this.readCache(); this.emit(); void this.refresh(); }
    else if (!has && this.phase === 'signed-in') { this.phase = 'signed-out'; this.data = null; this.emit(); }
  }

  async refresh(): Promise<void> {
    const api = this.api();
    if (!api) { this.sync(); return; }
    const seq = ++this.seq;
    if (!this.data) this.data = this.readCache();
    this.loading = true;
    this.emit();
    const [user, repos, notes, prs, issues] = await Promise.allSettled([
      api.user(), api.repos(1), api.notifications(), api.search('is:open is:pr author:@me archived:false'), api.search('is:open is:issue assignee:@me archived:false'),
    ]);
    if (seq !== this.seq) return;
    this.loading = false;
    const errors = [user, repos, notes, prs, issues].flatMap(r => (r.status === 'rejected' ? [r.reason] : []));
    const err = errors.find(e => e instanceof GitHubError && e.kind === 'auth') ?? errors[0];
    if (err instanceof GitHubError && err.kind === 'auth') { this.expire(err.message); return; }
    const prev = this.data;
    const ok = <T>(r: PromiseSettledResult<T>, old: T): T => (r.status === 'fulfilled' ? r.value : old);
    this.data = {
      user: ok(user, prev?.user ?? null),
      repos: repos.status === 'fulfilled' ? repos.value.data : prev?.repos ?? [],
      reposNext: repos.status === 'fulfilled' ? (repos.value.next ? 2 : 0) : prev?.reposNext ?? 0,
      notifications: sortNotifications(ok(notes, prev?.notifications ?? [])),
      prs: ok(prs, prev?.prs ?? []),
      issues: ok(issues, prev?.issues ?? []),
      at: errors.length === 5 ? prev?.at ?? 0 : Date.now(),
    };
    this.notice = err ? { kind: err instanceof GitHubError ? err.kind : 'http', text: err instanceof Error ? err.message : String(err) } : null;
    if (errors.length < 5) this.writeCache();
    this.emit();
  }

  async moreRepos(): Promise<void> {
    const api = this.api();
    if (!api || !this.data?.reposNext || this.loadingMore) return;
    this.loadingMore = true;
    this.emit();
    try {
      const page = this.data.reposNext;
      const r = await api.repos(page);
      const have = new Set(this.data.repos.map(x => x.id));
      this.data = { ...this.data, repos: [...this.data.repos, ...r.data.filter(x => !have.has(x.id))], reposNext: r.next ? page + 1 : 0 };
    } catch (e) {
      if (e instanceof GitHubError && e.kind === 'auth') { this.loadingMore = false; this.expire(e.message); return; }
      this.notice = { kind: e instanceof GitHubError ? e.kind : 'http', text: (e as Error).message };
    }
    this.loadingMore = false;
    this.emit();
  }

  /** The device flow, in place: the code to enter, then signed in */
  async signIn(): Promise<boolean> {
    if (this.phase === 'requesting' || this.phase === 'code') return false;
    const abort = this.abort = new AbortController();
    this.phase = 'requesting';
    this.notice = null;
    this.emit();
    try {
      const code = await requestDeviceCode(DEFAULT_GITHUB_SCOPES, this.opts.fetchImpl);
      if (abort.signal.aborted) return false;
      this.code = { userCode: code.user_code, uri: code.verification_uri };
      this.phase = 'code';
      this.emit();
      const token = await pollForToken(code, { signal: abort.signal, fetchImpl: this.opts.fetchImpl, sleep: this.opts.sleep });
      if (abort.signal.aborted) return false;
      saveGitHubToken(token);
      this.code = null;
      this.phase = 'signed-in';
      this.data = null;
      this.opts.onSignedIn?.(token);
      this.emit();
      await this.refresh();
      return true;
    } catch (e) {
      if (abort.signal.aborted || this.phase === 'signed-in') return false;
      this.code = null;
      this.phase = 'signed-out';
      this.notice = { kind: 'auth', text: `Couldn't sign in: ${(e as Error)?.message ?? e}` };
      this.emit();
      return false;
    }
  }

  cancelSignIn(): void {
    if (this.phase !== 'requesting' && this.phase !== 'code') return;
    this.abort?.abort();
    this.code = null;
    this.phase = 'signed-out';
    this.emit();
  }

  /** The token stopped working: forget it and say why */
  expire(text: string): void {
    try { localStorage.removeItem(GITHUB_TOKEN_KEY); localStorage.removeItem(CACHE_KEY); } catch {}
    this.seq++;
    this.loading = false;
    this.phase = 'signed-out';
    this.data = null;
    this.notice = { kind: 'auth', text };
    setNetworkStatus('needs-sign-in');
    this.emit();
  }
}

let shared: GitHubHomeModel | null = null;
/** The page's one model: windows share the sign-in, the lists and clones in progress */
export function homeModel(opts?: ModelOptions): GitHubHomeModel {
  if (shared) return shared;
  const m = shared = new GitHubHomeModel(opts);
  onNetworkStatus(() => m.sync());
  try { addEventListener('storage', (e) => { if (e.key === GITHUB_TOKEN_KEY) m.sync(); }); } catch {}
  return m;
}

// ── Rows (HTML) ──

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const LANG_COLORS: Record<string, string> = {
  TypeScript: '#3178c6', JavaScript: '#f1e05a', Python: '#3572a5', Go: '#00add8', Rust: '#dea584', C: '#555555', 'C++': '#f34b7d',
  Java: '#b07219', Ruby: '#701516', Shell: '#89e051', HTML: '#e34c26', CSS: '#563d7c', Swift: '#f05138', Kotlin: '#a97bff',
  'C#': '#178600', PHP: '#4f5d95', Lua: '#000080', Vue: '#41b883', Svelte: '#ff3e00', Dart: '#00b4ab', Zig: '#ec915c',
};

export interface RepoRowOptions {
  /** Its local folder, when it is on this computer */
  local?: string;
  clone?: CloneState;
  now?: number;
  /** The secondary action for a local repository ('Files' in Git, 'Git' in Files) */
  altLabel?: string;
}

export function repoRowHTML(r: GhRepo, o: RepoRowOptions = {}): string {
  const [owner, name] = r.full_name.split('/');
  const meta = [
    r.language ? `<span class="sd-gh-lang"><i style="background:${LANG_COLORS[r.language] ?? 'var(--sd-text-3)'}"></i>${esc(r.language)}</span>` : '',
    r.stargazers_count ? `<span title="Stars">★ ${r.stargazers_count}</span>` : '',
    `<span>Updated ${esc(relTime(r.pushed_at ?? r.updated_at, o.now))}</span>`,
  ].filter(Boolean).join('<span aria-hidden="true">·</span>');
  let action: string;
  if (o.clone && !o.clone.done && !o.clone.error) action = `<span class="sd-gh-progress sd-small sd-muted" title="${esc(o.clone.progress)}"><span class="sd-spinner" aria-hidden="true"></span>${esc(o.clone.progress || 'Cloning…')}</span>`;
  else if (o.local) action = `${o.altLabel ? `<button class="sd-btn" data-gh-alt="${esc(o.local)}" type="button">${esc(o.altLabel)}</button>` : ''}<button class="sd-btn sd-primary" data-gh-open="${esc(o.local)}" type="button" title="${esc(o.local)}">Open</button>`;
  else action = `<button class="sd-btn" data-gh-clone="${esc(r.full_name)}" type="button" title="Clone into ~/src/${esc(name)}">Clone</button>`;
  return `<div class="sd-gh-row sd-gh-repo" data-full="${esc(r.full_name)}">
    <div class="sd-gh-main">
      <div class="sd-gh-title"><span class="sd-gh-name"><span class="sd-muted">${esc(owner)}/</span>${esc(name)}</span>${r.private ? '<span class="sd-gh-pill">Private</span>' : ''}${r.fork ? '<span class="sd-gh-pill">Fork</span>' : ''}${r.archived ? '<span class="sd-gh-pill">Archived</span>' : ''}</div>
      ${r.description ? `<div class="sd-gh-desc sd-small sd-muted">${esc(r.description)}</div>` : ''}
      <div class="sd-gh-meta sd-small sd-muted">${meta}</div>
      ${o.clone?.error ? `<div class="sd-gh-err sd-small">Clone failed: ${esc(o.clone.error)} <button class="sd-link" data-gh-clone-term="${esc(r.full_name)}" type="button">Try in a Terminal</button></div>` : ''}
    </div>
    <div class="sd-gh-act">${action}</div>
  </div>`;
}

const TYPE_LABEL: Record<string, string> = { PullRequest: 'Pull request', Issue: 'Issue', Commit: 'Commit', Release: 'Release', Discussion: 'Discussion', CheckSuite: 'Checks' };

export function notificationRowHTML(n: GhNotification, now = Date.now()): string {
  return `<a class="sd-gh-row sd-gh-note${n.unread ? ' sd-gh-unread' : ''}" href="${esc(notificationLink(n))}" target="_blank" rel="noopener" data-note="${esc(n.id)}">
    <span class="sd-gh-dot" aria-label="${n.unread ? 'Unread' : 'Read'}"></span>
    <div class="sd-gh-main">
      <div class="sd-gh-title">${esc(n.subject.title)}</div>
      <div class="sd-gh-meta sd-small sd-muted"><span>${esc(n.repository.full_name)}</span><span aria-hidden="true">·</span><span>${esc(TYPE_LABEL[n.subject.type] ?? n.subject.type)}</span><span aria-hidden="true">·</span><span>${esc(relTime(n.updated_at, now))}</span></div>
    </div></a>`;
}

export function issueRowHTML(i: GhIssue, now = Date.now()): string {
  return `<a class="sd-gh-row sd-gh-issue" href="${esc(i.html_url)}" target="_blank" rel="noopener">
    <span class="sd-gh-kind ${i.pull_request ? 'sd-gh-pr' : 'sd-gh-iss'}" aria-hidden="true">${i.pull_request ? '⇄' : '◎'}</span>
    <div class="sd-gh-main">
      <div class="sd-gh-title">${esc(i.title)}${i.draft ? ' <span class="sd-gh-pill">Draft</span>' : ''}</div>
      <div class="sd-gh-meta sd-small sd-muted"><span>${esc(issueRepo(i))}#${i.number}</span><span aria-hidden="true">·</span><span>${esc(relTime(i.updated_at, now))}</span></div>
    </div></a>`;
}

export function localRowHTML(l: LocalRepo, changed?: number | null, altLabel?: string): string {
  const where = l.path.startsWith(HOME) ? '~' + l.path.slice(HOME.length) : l.path;
  return `<div class="sd-gh-row sd-gh-local" data-local="${esc(l.path)}">
    <div class="sd-gh-main">
      <div class="sd-gh-title"><span class="sd-gh-name">${esc(l.name)}</span>${l.branch ? `<span class="sd-git-tag">${esc(l.branch)}</span>` : ''}${l.worktree ? '<span class="sd-gh-pill">Branch folder</span>' : ''}</div>
      <div class="sd-gh-meta sd-small sd-muted"><span>${esc(where)}</span><span class="sd-gh-changed" data-changed="${esc(l.path)}">${changed == null ? '' : changed ? `· ${changed} changed` : '· clean'}</span></div>
    </div>
    <div class="sd-gh-act">${altLabel ? `<button class="sd-btn" data-gh-alt="${esc(l.path)}" type="button">${esc(altLabel)}</button>` : ''}<button class="sd-btn sd-primary" data-gh-open="${esc(l.path)}" type="button">Open</button></div>
  </div>`;
}

/** Placeholder rows the size of real ones, so the lists don't jump when they arrive */
export function skeletonRows(n: number): string {
  return Array.from({ length: n }, () => '<div class="sd-gh-row sd-gh-skel" aria-hidden="true"><div class="sd-gh-main"><i></i><i></i></div></div>').join('');
}
