/**
 * clone, fetch and push for github.com repositories through GitHub's REST API,
 * for the private network mode: api.github.com allows cross-origin requests
 * with an Authorization header, so the page talks to GitHub itself and the
 * token and the code never pass through tabcomputer's /git-proxy.
 *
 * The result is an ordinary repository in isomorphic-git's object store. The
 * rule that keeps it one: an object is written only when its oid, computed
 * here from the bytes, equals the sha GitHub named.
 *
 * - Blobs come back as bytes and trees as entry lists, so both are rebuilt
 *   exactly.
 * - Commits are the hard part. The API gives the author and committer dates in
 *   UTC without the commit's own timezone offset, and the message without its
 *   last newline. A signed commit carries its raw text (`verification.payload`)
 *   and signature, which give the object back directly. For an unsigned one
 *   the missing pieces are searched: every quarter-hour offset for each of the
 *   two dates, with and without the newline, until the sha matches (the last
 *   combination that worked is tried first, so a history usually costs one
 *   hash per commit).
 * - A commit that still can't be reproduced (an `encoding` or `mergetag`
 *   header, an offset off the quarter hour) is not written. Its child becomes
 *   a shallow boundary (.git/shallow), as after `git clone --depth`. When it
 *   is the branch tip itself the operation fails with `unsupported`.
 * - Order of writes: blobs, then trees bottom-up, then commits oldest first,
 *   then .git/shallow, then refs. So a tree in the store has everything below
 *   it and a commit has its history up to a shallow boundary, also after an
 *   interrupted run, and "already in the store" is a safe place to stop.
 * - Push creates blobs, trees and commits with the git data API and compares
 *   every sha GitHub returns. A commit GitHub stores differently (an extra
 *   header it can't take) still goes up: its children are created on GitHub's
 *   sha and the local branch is then moved to GitHub's commits (`rewritten`).
 *   The trees are the same, so the work tree and index don't change.
 *
 * Without a token, file contents come from raw.githubusercontent.com (also
 * cross-origin, and outside the API's 60 requests an hour); with one, from the
 * API, since that host refuses the Authorization preflight.
 */
import git, { withGitCache } from './git-cached';

export interface GitHubApiOptions {
  /** The same fs object git.ts passes to isomorphic-git */
  fs: any;
  /** Work tree */
  dir: string;
  owner: string;
  repo: string;
  /** Absent: unauthenticated (public repositories, reads only) */
  token?: string;
  /** Default 'origin' */
  remote?: string;
  /** Default globalThis.fetch */
  fetchImpl?: typeof fetch;
  /** Default 'https://api.github.com' */
  apiBase?: string;
  /** Where file contents come from without a token; null: always the API. Default 'https://raw.githubusercontent.com' */
  rawBase?: string | null;
  /** Refuse to download more blobs than this in one operation. Default DEFAULT_MAX_FILES */
  maxFiles?: number;
  /** Refuse to download more blob bytes than this in one operation. Default DEFAULT_MAX_BYTES */
  maxBytes?: number;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
}

/** Most blobs one clone or fetch downloads (one request each) */
export const DEFAULT_MAX_FILES = 2000;
/** Most blob bytes one clone or fetch downloads */
export const DEFAULT_MAX_BYTES = 100 * 1000 * 1000;
/** Requests in flight at once when reading */
export const READ_CONCURRENCY = 6;
/** Requests in flight at once when creating blobs (GitHub slows down bursts of writes) */
export const WRITE_CONCURRENCY = 3;
export const DEFAULT_API_BASE = 'https://api.github.com';
export const DEFAULT_RAW_BASE = 'https://raw.githubusercontent.com';

/**
 * `.code`: 'auth' (401, or a 403 that is not a rate limit), 'rate-limit',
 * 'not-found', 'non-fast-forward', 'too-large', 'network', 'unsupported',
 * 'empty' (409: the repository has no commits), 'api' (any other status).
 */
export class GitHubApiError extends Error {
  status?: number;
  code: string;
  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.code = code;
    this.status = status;
  }
}

/** owner/repo for a github.com remote URL (https, ssh://, git@github.com:o/r), else null */
export function parseGitHubRemote(url: string | undefined): { owner: string; repo: string } | null {
  const m = /^(?:(?:https?|ssh|git):\/\/(?:[^/@]+@)?(?:www\.)?github\.com(?::\d+)?\/|(?:[^/@]+@)?github\.com:)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec((url ?? '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

// ---------------------------------------------------------------------------
// Requests

interface Session {
  o: GitHubApiOptions;
  remote: string;
  requests: number;
  read: Limiter;
  /** Commits the API has described, by sha */
  commits: Map<string, ApiCommit>;
  listings: Map<string, TreeListing>;
  /** Objects known to be in the local store */
  present: Set<string>;
  /** A store this operation created: nothing to look up */
  fresh: boolean;
  /** Blobs and bytes this operation may still download */
  filesLeft: number;
  bytesLeft: number;
  /** The timezone offsets and message ending of the last commit rebuilt */
  hint?: [string, string, string];
}

function session(o: Partial<GitHubApiOptions> & Pick<GitHubApiOptions, 'owner' | 'repo'>): Session {
  return {
    o: o as GitHubApiOptions, remote: o.remote || 'origin', requests: 0, read: limiter(READ_CONCURRENCY),
    commits: new Map(), listings: new Map(), present: new Set(), fresh: false,
    filesLeft: o.maxFiles ?? DEFAULT_MAX_FILES, bytesLeft: o.maxBytes ?? DEFAULT_MAX_BYTES,
  };
}

type Limiter = <T>(fn: () => Promise<T>) => Promise<T>;
/** Run at most `max` of the given functions at once */
function limiter(max: number): Limiter {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async (fn) => {
    while (active >= max) await new Promise<void>(r => waiting.push(r));
    active++;
    try { return await fn(); } finally { active--; waiting.shift()?.(); }
  };
}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
});

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
const repoPath = (s: Session) => `/repos/${encodeURIComponent(s.o.owner)}/${encodeURIComponent(s.o.repo)}`;

interface RequestInit2 { body?: unknown; accept?: string; /** a ref or a list that changes: never from the browser's cache */ live?: boolean }

/** One API request. Returns the response when it is 2xx, else throws a GitHubApiError */
async function request(s: Session, method: string, path: string, init: RequestInit2 = {}): Promise<Response> {
  const { o } = s;
  const doFetch = o.fetchImpl ?? globalThis.fetch;
  for (let attempt = 0; ; attempt++) {
    o.signal?.throwIfAborted();
    s.requests++;
    let res: Response;
    try {
      res = await doFetch((o.apiBase ?? DEFAULT_API_BASE) + path, {
        method,
        headers: {
          Accept: init.accept ?? 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(o.token ? { Authorization: `Bearer ${o.token}` } : {}),
          ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        ...(init.live || method !== 'GET' ? { cache: 'no-store' as RequestCache } : {}),
        signal: o.signal,
      });
    } catch (e: any) {
      if (o.signal?.aborted) throw e;
      throw new GitHubApiError('network', `could not reach GitHub (${e?.message || e})`);
    }
    if (res.ok) return res;
    const err = await apiError(s, res);
    // A secondary rate limit names a short wait: take it, twice at most
    const wait = Number(res.headers.get('retry-after'));
    if (err.code === 'rate-limit' && wait > 0 && wait <= 60 && attempt < 2) {
      o.onProgress?.(`GitHub asked to wait ${wait} s`);
      await sleep(wait * 1000, o.signal);
      continue;
    }
    throw err;
  }
}

async function apiError(s: Session, res: Response): Promise<GitHubApiError> {
  const message = String(((await res.json().catch(() => null)) as any)?.message ?? res.statusText ?? '');
  const { status } = res;
  const where = `${s.o.owner}/${s.o.repo}`;
  if ((status === 403 || status === 429)
    && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') || /rate limit|abuse/i.test(message))) {
    const reset = Number(res.headers.get('x-ratelimit-reset')), retry = Number(res.headers.get('retry-after'));
    const secs = retry > 0 ? retry : reset > 0 ? Math.max(0, Math.round(reset - Date.now() / 1000)) : 0;
    const when = !secs ? ''
      : secs < 90 ? `; try again in ${secs} s`
      : `; it resets at ${new Date(Date.now() + secs * 1000).toTimeString().slice(0, 5)} (in ${Math.ceil(secs / 60)} min)`;
    return new GitHubApiError('rate-limit', `GitHub API rate limit reached${when}`
      + (s.o.token ? '' : '. Signed in to GitHub the limit is 5,000 requests an hour instead of 60: gh auth login'), status);
  }
  if (status === 401) return new GitHubApiError('auth', `GitHub refused the sign-in (${message || 'bad credentials'}). Run: gh auth login`, status);
  if (status === 403) return new GitHubApiError('auth', `GitHub refused access to ${where}: ${message}`, status);
  if (status === 404) {
    return new GitHubApiError('not-found', s.o.token
      ? `${where}: not found, or your GitHub sign-in has no access to it`
      : `${where}: not found. A private repository needs a GitHub sign-in: gh auth login`, status);
  }
  if (status === 409 && /empty/i.test(message)) return new GitHubApiError('empty', `${where} is empty`, status);
  if (status === 422 && /fast[ -]forward/i.test(message)) return new GitHubApiError('non-fast-forward', message, status);
  return new GitHubApiError('api', `GitHub: ${status} ${message}`.trim(), status);
}

async function getJson(s: Session, path: string, live = false): Promise<any> {
  return (await request(s, 'GET', path, { live })).json();
}
async function send(s: Session, method: string, path: string, body: unknown): Promise<any> {
  return (await request(s, method, path, { body })).json();
}

// ---------------------------------------------------------------------------
// Objects

const enc = new TextEncoder(), dec = new TextDecoder();
const hex = (b: Uint8Array) => Array.from(b, x => x.toString(16).padStart(2, '0')).join('');

/** The oid git gives an object of this type and content */
export async function gitOid(type: 'blob' | 'tree' | 'commit', content: Uint8Array): Promise<string> {
  const head = enc.encode(`${type} ${content.length}\0`);
  const all = new Uint8Array(head.length + content.length);
  all.set(head);
  all.set(content, head.length);
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-1', all)));
}

/** Is the object in the local store? */
async function has(s: Session, oid: string): Promise<boolean> {
  if (s.present.has(oid)) return true;
  if (s.fresh) return false;
  try {
    await git.readObject({ fs: s.o.fs, dir: s.o.dir, oid, format: 'deflated' });
    s.present.add(oid);
    return true;
  } catch { return false; }
}

/** Store an object whose oid must be `sha` */
async function store(s: Session, type: 'blob' | 'tree' | 'commit', content: Uint8Array, sha: string): Promise<void> {
  const oid = await git.writeObject({ fs: s.o.fs, dir: s.o.dir, type, object: content, format: 'content' });
  if (oid !== sha) throw new GitHubApiError('unsupported', `${type} ${sha} came out as ${oid}`);
  s.present.add(sha);
}

interface ApiIdent { name: string; email: string; date: string }
interface ApiCommit {
  sha: string; tree: string; parents: string[];
  author: ApiIdent; committer: ApiIdent; message: string;
  signature?: string | null; payload?: string | null;
}

/** One shape for an item of `GET /commits` and for `GET /git/commits/{sha}` */
function apiCommit(j: any): ApiCommit {
  const c = j.commit ?? j;
  return {
    sha: j.sha, tree: c.tree.sha, parents: (j.parents ?? []).map((p: any) => p.sha),
    author: c.author, committer: c.committer, message: c.message ?? '',
    signature: c.verification?.signature, payload: c.verification?.payload,
  };
}

const pad2 = (n: number) => String(n).padStart(2, '0');
/** Every quarter-hour offset from -1200 to +1400, +0000 first */
const OFFSETS = (() => {
  const all = ['+0000'];
  for (let m = -12 * 60; m <= 14 * 60; m += 15) {
    if (m) all.push(`${m < 0 ? '-' : '+'}${pad2(Math.floor(Math.abs(m) / 60))}${pad2(Math.abs(m) % 60)}`);
  }
  return all;
})();

/** Author and committer offsets to try, likeliest first: both the same, then a committer in UTC (GitHub's own merges), then the rest */
function* offsetPairs(): Generator<[string, string]> {
  for (const t of OFFSETS) yield [t, t];
  for (const t of OFFSETS) yield [t, '+0000'];
  for (const t of OFFSETS) yield ['+0000', t];
  for (const a of OFFSETS) for (const c of OFFSETS) yield [a, c];
}

/**
 * The commit's bytes, or null when no reconstruction has its sha. Exported
 * for the tests.
 */
export async function rebuildCommit(c: ApiCommit, hintHolder: { hint?: [string, string, string] } = {}): Promise<Uint8Array | null> {
  const fits = async (text: string) => {
    const bytes = enc.encode(text);
    return (await gitOid('commit', bytes)) === c.sha ? bytes : null;
  };
  // Signed: the payload is the commit without its gpgsig header, which git puts last
  if (c.payload && c.signature) {
    const cut = c.payload.indexOf('\n\n');
    if (cut >= 0) {
      const headers = c.payload.slice(0, cut), rest = c.payload.slice(cut);
      const committerEnd = headers.indexOf('\n', headers.indexOf('\ncommitter ') + 1);
      for (const sig of [c.signature.replace(/\n+$/, ''), c.signature]) {
        const header = 'gpgsig ' + sig.replace(/\n/g, '\n ');
        const hit = await fits(`${headers}\n${header}${rest}`)
          // an older layout: before headers that follow the committer (encoding)
          ?? (committerEnd > 0 ? await fits(`${headers.slice(0, committerEnd)}\n${header}${headers.slice(committerEnd)}${rest}`) : null);
        if (hit) return hit;
      }
    }
  }
  const secs = (d: string) => Math.floor(Date.parse(d) / 1000);
  const at = secs(c.author?.date), ct = secs(c.committer?.date);
  if (!Number.isFinite(at) || !Number.isFinite(ct)) return null;
  const head = `tree ${c.tree}\n` + c.parents.map(p => `parent ${p}\n`).join('');
  const text = (a: string, k: string, end: string) => `${head}author ${c.author.name} <${c.author.email}> ${at} ${a}\n`
    + `committer ${c.committer.name} <${c.committer.email}> ${ct} ${k}\n\n${c.message}${end}`;
  if (hintHolder.hint) {
    const hit = await fits(text(...hintHolder.hint));
    if (hit) return hit;
  }
  for (const [a, k] of offsetPairs()) {
    // git ends a message with a newline, which the API drops; a commit made through the API has none
    for (const end of ['\n', '']) {
      const hit = await fits(text(a, k, end));
      if (hit) { hintHolder.hint = [a, k, end]; return hit; }
    }
  }
  return null;
}

interface TreeEntry { path: string; mode: string; type: string; sha: string; size?: number }
interface TreeListing { sha: string; tree: TreeEntry[]; truncated?: boolean }

/** A tree object's bytes from its entries (names, not paths), in git's order */
export function treeBytes(entries: TreeEntry[]): Uint8Array {
  const rows = entries.map(e => ({
    // git sorts a directory as if its name ended in '/'
    key: enc.encode(e.path + (e.mode.replace(/^0+/, '') === '40000' ? '/' : '')),
    head: enc.encode(`${e.mode.replace(/^0+/, '')} ${e.path}\0`),
    sha: e.sha,
  }));
  rows.sort((x, y) => {
    const n = Math.min(x.key.length, y.key.length);
    for (let i = 0; i < n; i++) if (x.key[i] !== y.key[i]) return x.key[i] - y.key[i];
    return x.key.length - y.key.length;
  });
  const out = new Uint8Array(rows.reduce((n, r) => n + r.head.length + 20, 0));
  let at = 0;
  for (const r of rows) {
    out.set(r.head, at);
    at += r.head.length;
    for (let i = 0; i < 20; i++) out[at++] = parseInt(r.sha.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function treeListing(s: Session, sha: string, recursive: boolean): Promise<TreeListing> {
  const key = sha + (recursive ? '+r' : '');
  let list = s.listings.get(key);
  if (!list) {
    list = await s.read(() => getJson(s, `${repoPath(s)}/git/trees/${sha}${recursive ? '?recursive=1' : ''}`)) as TreeListing;
    s.listings.set(key, list);
  }
  return list;
}

interface BlobRef { sha: string; path: string; size: number }
interface PendingTree { sha: string; bytes: Uint8Array; depth: number }

/**
 * What the store lacks of the tree `root`: the blobs to download and the tree
 * objects to write once they are there. `recursive` asks for the whole
 * listing in one request (a first clone); otherwise only the subtrees the
 * store lacks are listed, which is a few requests for an ordinary commit.
 */
async function collectTree(s: Session, root: string, recursive: boolean): Promise<{ blobs: BlobRef[]; trees: PendingTree[] }> {
  const blobs = new Map<string, BlobRef>(), trees: PendingTree[] = [];
  const addTree = async (sha: string, entries: TreeEntry[], depth: number) => {
    const bytes = treeBytes(entries);
    const oid = await gitOid('tree', bytes);
    if (oid !== sha) throw new GitHubApiError('unsupported', `tree ${sha} can't be rebuilt from GitHub's listing (it came out as ${oid})`);
    trees.push({ sha, bytes, depth });
  };
  const addBlob = async (e: TreeEntry, path: string) => {
    // A submodule (160000) names a commit in another repository: nothing to fetch
    if (e.type === 'blob' && !blobs.has(e.sha) && !(await has(s, e.sha))) blobs.set(e.sha, { sha: e.sha, path, size: e.size ?? 0 });
  };
  const walk = async (sha: string, prefix: string, depth: number): Promise<void> => {
    if (await has(s, sha)) return;
    const list = await treeListing(s, sha, false);
    await addTree(sha, list.tree, depth);
    await Promise.all(list.tree.map(e => e.type === 'tree' ? walk(e.sha, `${prefix}${e.path}/`, depth + 1) : addBlob(e, prefix + e.path)));
  };

  if (await has(s, root)) return { blobs: [], trees };
  const list = recursive ? await treeListing(s, root, true) : null;
  // A truncated listing (over 100,000 entries or 7 MB) is walked tree by tree instead
  if (!list || list.truncated) {
    await walk(root, '', 0);
    return { blobs: [...blobs.values()], trees };
  }
  const dirs = new Map<string, { sha: string; entries: TreeEntry[] }>([['', { sha: root, entries: [] }]]);
  const dir = (path: string) => {
    let d = dirs.get(path);
    if (!d) dirs.set(path, d = { sha: '', entries: [] });
    return d;
  };
  for (const e of list.tree) {
    const cut = e.path.lastIndexOf('/');
    dir(cut < 0 ? '' : e.path.slice(0, cut)).entries.push({ ...e, path: e.path.slice(cut + 1) });
    if (e.type === 'tree') dir(e.path).sha = e.sha;
    else await addBlob(e, e.path);
  }
  for (const [path, d] of dirs) {
    if (!(await has(s, d.sha))) await addTree(d.sha, d.entries, path ? path.split('/').length : 0);
  }
  return { blobs: [...blobs.values()], trees };
}

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Download one blob into the store. `commit` is a commit that has it at `path` */
async function fetchBlob(s: Session, b: BlobRef, commit: string): Promise<void> {
  const { o } = s;
  let bytes: Uint8Array | null = null;
  const rawBase = o.rawBase === undefined ? DEFAULT_RAW_BASE : o.rawBase;
  if (!o.token && rawBase) {
    // The raw host: no API quota. Anything but these exact bytes (a miss, a redirect page) falls through to the API
    try {
      o.signal?.throwIfAborted();
      s.requests++;
      const res = await (o.fetchImpl ?? globalThis.fetch)(
        `${rawBase}/${encodeURIComponent(o.owner)}/${encodeURIComponent(o.repo)}/${commit}/${encodePath(b.path)}`, { signal: o.signal });
      if (res.ok) {
        const got = new Uint8Array(await res.arrayBuffer());
        if ((await gitOid('blob', got)) === b.sha) bytes = got;
      }
    } catch (e) {
      if (o.signal?.aborted) throw e;
    }
  }
  if (!bytes) {
    const res = await request(s, 'GET', `${repoPath(s)}/git/blobs/${b.sha}`, { accept: 'application/vnd.github.raw+json' });
    bytes = new Uint8Array(await res.arrayBuffer());
    if ((await gitOid('blob', bytes)) !== b.sha) {
      // The raw media type was not honoured: the JSON form
      const j = await getJson(s, `${repoPath(s)}/git/blobs/${b.sha}`);
      bytes = j.encoding === 'base64' ? fromBase64(j.content) : enc.encode(j.content);
    }
  }
  await store(s, 'blob', bytes, b.sha);
}

// ---------------------------------------------------------------------------
// History

const gitFile = (s: Session, name: string) => `${s.o.dir === '/' ? '' : s.o.dir}/.git/${name}`;
const fsp = (s: Session) => s.o.fs.promises ?? s.o.fs;

async function readShallow(s: Session): Promise<Set<string>> {
  const text = await fsp(s).readFile(gitFile(s, 'shallow'), 'utf8').catch(() => '');
  return new Set(String(text).split('\n').filter(Boolean));
}

/** The API's description of a commit: from a page of its history, so the commits needed next come with it */
async function describeCommit(s: Session, sha: string, want: number): Promise<ApiCommit> {
  let c = s.commits.get(sha);
  if (c) return c;
  const page = await getJson(s, `${repoPath(s)}/commits?sha=${sha}&per_page=${Math.max(1, Math.min(100, want))}`);
  for (const j of page) s.commits.set(j.sha, apiCommit(j));
  c = s.commits.get(sha);
  if (!c) s.commits.set(sha, c = apiCommit(await getJson(s, `${repoPath(s)}/git/commits/${sha}`)));
  return c;
}

interface HistoryResult { commits: number; blobs: number; shallow: boolean }

/**
 * Bring `tip` and its history into the store: back to commits the store has,
 * or `depth` commits deep. The caller moves refs afterwards.
 */
async function fetchHistory(s: Session, tip: string, depth: number): Promise<HistoryResult> {
  const { o } = s;
  const shallow = await readShallow(s);
  const before = shallow.size;
  const raws: { sha: string; bytes: Uint8Array }[] = [];
  const queue: { sha: string; level: number; child?: string }[] = [{ sha: tip, level: 1 }];
  const seen = new Set<string>(), dropped = new Set<string>();
  let blobCount = 0, pages = 0;
  // Out of budget: the commits still queued are left out, and their children become the boundary
  let full = false;

  while (queue.length) {
    const { sha, level, child } = queue.shift()!;
    // Left out before, reached again from another child: that child is a boundary too
    if (dropped.has(sha)) { shallow.add(child!); continue; }
    if (seen.has(sha) || await has(s, sha)) continue;
    seen.add(sha);
    const drop = () => { dropped.add(sha); shallow.add(child!); };
    if (full) { drop(); continue; }
    // A small first page (a fetch usually brings a few commits), then full ones
    const c = await describeCommit(s, sha, Math.min(depth - level + 1, pages++ ? 100 : 10));
    const bytes = await rebuildCommit(c, s);
    if (!bytes) {
      if (!child) {
        throw new GitHubApiError('unsupported', `commit ${sha} can't be reproduced from what GitHub's API says about it `
          + '(a header or timezone the API does not report), so it can\'t be stored. Clone or fetch through the git protocol instead.');
      }
      o.onProgress?.(`history stops at ${child.slice(0, 7)}: its parent ${sha.slice(0, 7)} can't be reproduced through the API`);
      drop();
      continue;
    }
    const need = await collectTree(s, c.tree, s.fresh && !raws.length);
    const size = need.blobs.reduce((n, b) => n + b.size, 0);
    if (need.blobs.length > s.filesLeft || size > s.bytesLeft) {
      if (!child) {
        throw new GitHubApiError('too-large', `${o.owner}/${o.repo} needs ${need.blobs.length} files (${(size / 1e6).toFixed(1)} MB), one request each: `
          + `more than the limit of ${o.maxFiles ?? DEFAULT_MAX_FILES} files or ${(o.maxBytes ?? DEFAULT_MAX_BYTES) / 1e6} MB`);
      }
      o.onProgress?.(`history stops at ${child.slice(0, 7)}: the download limit is reached`);
      full = true;
      drop();
      continue;
    }
    s.filesLeft -= need.blobs.length;
    s.bytesLeft -= size;
    let done = 0;
    await Promise.all(need.blobs.map(b => s.read(async () => {
      await fetchBlob(s, b, sha);
      blobCount++;
      o.onProgress?.(`Receiving objects: ${++done}/${need.blobs.length} (commit ${raws.length + 1}, ${s.requests} requests)`);
    })));
    for (const t of need.trees.sort((x, y) => y.depth - x.depth)) await store(s, 'tree', t.bytes, t.sha);
    raws.push({ sha, bytes });

    if (level >= depth) {
      for (const p of c.parents) if (!(await has(s, p))) shallow.add(sha);
    } else {
      for (const p of c.parents) queue.push({ sha: p, level: level + 1, child: sha });
    }
  }

  // The boundary first, then commits oldest first: a commit in the store always has its history
  if (shallow.size !== before) await fsp(s).writeFile(gitFile(s, 'shallow'), [...shallow].join('\n') + '\n');
  for (const r of raws.reverse()) await store(s, 'commit', r.bytes, r.sha);
  return { commits: raws.length, blobs: blobCount, shallow: shallow.size > 0 };
}

const headsPath = (s: Session, branch: string) => `${repoPath(s)}/git/ref/heads/${encodePath(branch)}`;

/** The sha a branch points at on GitHub; null when there is no such branch */
async function remoteTip(s: Session, branch: string): Promise<string | null> {
  try {
    return (await getJson(s, headsPath(s, branch), true)).object.sha;
  } catch (e: any) {
    if (e instanceof GitHubApiError && e.code === 'not-found') {
      // No such branch, or no such repository? The second is the error to report
      await getJson(s, repoPath(s), true);
      return null;
    }
    throw e;
  }
}

async function setRef(s: Session, ref: string, value: string): Promise<void> {
  await git.writeRef({ fs: s.o.fs, dir: s.o.dir, ref, value, force: true });
}
const localRef = (s: Session, ref: string): Promise<string | null> =>
  git.resolveRef({ fs: s.o.fs, dir: s.o.dir, ref }).catch(() => null);

// ---------------------------------------------------------------------------
// The four operations

/**
 * How big a clone through the API would be: the branch, its tip, the number
 * of blobs and their total size (two requests, three when `ref` is not
 * given). A truncated listing counts only what it lists. An empty repository
 * has oid ''.
 */
export async function apiCloneEstimate(o: Omit<GitHubApiOptions, 'fs' | 'dir'> & { ref?: string }): Promise<{ branch: string; oid: string; files: number; bytes: number; truncated: boolean }> {
  const s = session(o);
  const branch = o.ref || (await getJson(s, repoPath(s), true)).default_branch;
  let oid: string | null;
  try {
    oid = await remoteTip(s, branch);
  } catch (e: any) {
    if (e instanceof GitHubApiError && e.code === 'empty') return { branch, oid: '', files: 0, bytes: 0, truncated: false };
    throw e;
  }
  if (!oid) throw new GitHubApiError('not-found', `Remote branch ${branch} not found in ${o.owner}/${o.repo}`, 404);
  const list = await treeListing(s, oid, true);
  const blobs = list.tree.filter(e => e.type === 'blob');
  return { branch, oid, files: blobs.length, bytes: blobs.reduce((n, e) => n + (e.size ?? 0), 0), truncated: !!list.truncated };
}

/**
 * Clone into `dir` (missing or empty; `git init` is done here). The result is
 * a normal repository: HEAD on the branch, refs/heads/<branch>,
 * refs/remotes/<remote>/<branch>, the remote's url and fetch refspec, the
 * branch's upstream, files checked out. `depth` defaults to 1; 0 or Infinity
 * is the whole history. An empty repository gives an empty one (oid '').
 * `shallow` says whether history was cut (by depth, the limits, or a commit
 * that can't be reproduced).
 */
export function apiClone(o: GitHubApiOptions & { ref?: string; depth?: number; noCheckout?: boolean }): Promise<{ branch: string; oid: string; commits: number; blobs: number; shallow: boolean }> {
  return withGitCache(async () => {
    const s = session(o);
    s.fresh = true;
    const { fs, dir } = o;
    const depth = o.depth && o.depth > 0 ? o.depth : o.depth === undefined ? 1 : Infinity;
    const branch = o.ref || (await getJson(s, repoPath(s), true)).default_branch;
    let tip: string | null = null;
    try {
      tip = await remoteTip(s, branch);
      if (!tip) throw new GitHubApiError('not-found', `Remote branch ${branch} not found in ${o.owner}/${o.repo}`, 404);
    } catch (e: any) {
      if (!(e instanceof GitHubApiError && e.code === 'empty')) throw e;
    }

    const init = async () => {
      await git.init({ fs, dir, defaultBranch: branch });
      await git.addRemote({ fs, dir, remote: s.remote, url: `https://github.com/${o.owner}/${o.repo}.git`, force: true });
      await git.setConfig({ fs, dir, path: `branch.${branch}.remote`, value: s.remote });
      await git.setConfig({ fs, dir, path: `branch.${branch}.merge`, value: `refs/heads/${branch}` });
    };
    if (!tip) {
      await init();
      return { branch, oid: '', commits: 0, blobs: 0, shallow: false };
    }
    // Refuse a repository over the limits before anything is written
    const first = await describeCommit(s, tip, Math.min(depth, 10));
    const list = await treeListing(s, first.tree, true);
    if (!list.truncated) {
      const blobs = list.tree.filter(e => e.type === 'blob');
      const size = blobs.reduce((n, e) => n + (e.size ?? 0), 0);
      if (blobs.length > s.filesLeft || size > s.bytesLeft) {
        throw new GitHubApiError('too-large', `${o.owner}/${o.repo} has ${blobs.length} files (${(size / 1e6).toFixed(1)} MB), one request each: `
          + `more than the limit of ${o.maxFiles ?? DEFAULT_MAX_FILES} files or ${(o.maxBytes ?? DEFAULT_MAX_BYTES) / 1e6} MB`);
      }
    }
    await init();
    const got = await fetchHistory(s, tip, depth);
    await setRef(s, `refs/remotes/${s.remote}/${branch}`, tip);
    await setRef(s, `refs/heads/${branch}`, tip);
    if (!o.noCheckout) await git.checkout({ fs, dir, ref: branch, force: true });
    return { branch, oid: tip, commits: got.commits, blobs: got.blobs, shallow: got.shallow };
  });
}

/**
 * Bring refs/remotes/<remote>/<branch> up to date for one branch (default:
 * the current branch's upstream, else the current branch) or, with `all`,
 * every branch the remote has. Downloads only objects the repository lacks,
 * back to commits it has (or `depth` commits from each tip). Doesn't touch
 * the work tree or local branches, and doesn't delete refs of branches that
 * are gone.
 */
export function apiFetch(o: GitHubApiOptions & { branch?: string; all?: boolean; depth?: number }): Promise<{ updated: { ref: string; from: string | null; to: string }[] }> {
  return withGitCache(async () => {
    const s = session(o);
    const { fs, dir } = o;
    const depth = o.depth && o.depth > 0 ? o.depth : Infinity;
    const tips: { name: string; sha: string }[] = [];
    try {
      if (o.all) {
        for (let page = 1; ; page++) {
          const got = await getJson(s, `${repoPath(s)}/branches?per_page=100&page=${page}`, true);
          for (const b of got) tips.push({ name: b.name, sha: b.commit.sha });
          if (got.length < 100) break;
        }
      } else {
        let branch = o.branch;
        if (!branch) {
          const current = await git.currentBranch({ fs, dir });
          if (!current) throw new GitHubApiError('unsupported', 'HEAD is detached: name the branch to fetch');
          const merge = await git.getConfig({ fs, dir, path: `branch.${current}.merge` }).catch(() => undefined);
          branch = merge ? String(merge).replace(/^refs\/heads\//, '') : current;
        }
        const sha = await remoteTip(s, branch!);
        if (!sha) throw new GitHubApiError('not-found', `Remote branch ${branch} not found in ${o.owner}/${o.repo}`, 404);
        tips.push({ name: branch!, sha });
      }
    } catch (e: any) {
      // An empty repository has no branches: nothing to fetch
      if (!(e instanceof GitHubApiError && e.code === 'empty')) throw e;
    }
    const updated: { ref: string; from: string | null; to: string }[] = [];
    for (const t of tips) {
      const ref = `refs/remotes/${s.remote}/${t.name}`;
      const from = await localRef(s, ref);
      if (from === t.sha) continue;
      await fetchHistory(s, t.sha, depth);
      await setRef(s, ref, t.sha);
      updated.push({ ref, from, to: t.sha });
    }
    return { updated };
  });
}

interface RawIdent { name: string; email: string; timestamp: number; tz: string }
interface RawCommit { tree: string; parents: string[]; author?: RawIdent; committer?: RawIdent; message: string; gpgsig?: string }

/** A commit object as git stores it: the message exactly, the dates with their offsets */
function parseRawCommit(bytes: Uint8Array): RawCommit {
  const text = dec.decode(bytes);
  const cut = text.indexOf('\n\n');
  const c: RawCommit = { tree: '', parents: [], message: cut < 0 ? '' : text.slice(cut + 2) };
  // A header line that starts with a space continues the one before
  for (const line of (cut < 0 ? text : text.slice(0, cut)).replace(/\n /g, '\u0000').split('\n')) {
    const sp = line.indexOf(' ');
    const key = line.slice(0, sp), value = line.slice(sp + 1).replace(/\u0000/g, '\n');
    if (key === 'tree') c.tree = value;
    else if (key === 'parent') c.parents.push(value);
    else if (key === 'gpgsig') c.gpgsig = value;
    else if (key === 'author' || key === 'committer') {
      const m = /^(.*?) ?<(.*?)> (-?\d+) ([+-]\d{4})$/.exec(value);
      if (m) c[key] = { name: m[1], email: m[2], timestamp: Number(m[3]), tz: m[4] };
    }
  }
  return c;
}

/** ISO 8601 in the commit's own offset, which is how the API takes a timezone */
function isoDate(id: RawIdent): string {
  const sign = id.tz[0] === '-' ? -1 : 1;
  const minutes = sign * (Number(id.tz.slice(1, 3)) * 60 + Number(id.tz.slice(3, 5)));
  return new Date((id.timestamp + minutes * 60) * 1000).toISOString().slice(0, 19) + `${id.tz.slice(0, 3)}:${id.tz.slice(3, 5)}`;
}

/** Add every tree and blob under `tree` (a tree in the local store) to `known` */
async function addClosure(s: Session, known: Set<string>, tree: string): Promise<void> {
  if (known.has(tree)) return;
  known.add(tree);
  const got = await git.readTree({ fs: s.o.fs, dir: s.o.dir, oid: tree }).catch(() => null);
  for (const e of got?.tree ?? []) {
    if (e.type === 'tree') await addClosure(s, known, e.oid);
    else if (e.type === 'blob') known.add(e.oid);
  }
}

type PushResult = { ok: boolean; oid: string; created: boolean; commits: number; rewritten: boolean; error?: string };

/**
 * Push local `branch` (default: the current one) to the branch of the same
 * name on GitHub, creating it if absent. A push that is not a fast-forward
 * is refused unless `force`: the result then has `ok: false` and an `error`
 * that starts with 'non-fast-forward' (nothing is thrown, and nothing was
 * changed on GitHub but unreferenced objects). `rewritten`: GitHub stored at
 * least one commit under another sha, and the local branch now points at
 * GitHub's commits. An empty repository gets its first commit through the
 * contents API (a placeholder the pushed history then replaces), because
 * the git data API refuses an empty repository.
 */
export function apiPush(o: GitHubApiOptions & { branch?: string; force?: boolean }): Promise<PushResult> {
  return withGitCache(async () => {
    const s = session(o);
    const { fs, dir } = o;
    if (!o.token) throw new GitHubApiError('auth', 'Pushing needs a GitHub sign-in. Run: gh auth login');
    const branch = o.branch || await git.currentBranch({ fs, dir }) || '';
    if (!branch) throw new GitHubApiError('unsupported', 'HEAD is detached: name the branch to push');
    const local = await localRef(s, `refs/heads/${branch}`);
    if (!local) throw new GitHubApiError('not-found', `src refspec ${branch} does not match any`);
    const tracking = `refs/remotes/${s.remote}/${branch}`;
    const refused = (oid: string): PushResult => ({
      ok: false, oid, created: false, commits: 0, rewritten: false,
      error: `non-fast-forward: ${branch} on GitHub has commits this branch lacks. Fetch and merge them, or push with force`,
    });

    // The remote's tip now, not what the last fetch saw
    let remote: string | null = null, empty = false;
    try {
      remote = await remoteTip(s, branch);
    } catch (e: any) {
      if (!(e instanceof GitHubApiError && e.code === 'empty')) throw e;
      empty = true;
    }
    if (remote === local) {
      await setRef(s, tracking, local);
      return { ok: true, oid: local, created: false, commits: 0, rewritten: false };
    }
    const remoteIsHere = !!remote && await has(s, remote);
    if (remote && !o.force) {
      const ancestor = remoteIsHere && await git.isDescendent({ fs, dir, oid: local, ancestor: remote, depth: -1 }).catch(() => false);
      if (!ancestor) return refused(remote);
    }

    // Commits GitHub has: the history of its tip and of every branch of this remote fetched before
    const starts = remoteIsHere ? [remote!] : [];
    for (const b of await git.listBranches({ fs, dir, remote: s.remote }).catch(() => [] as string[])) {
      const oid = b === 'HEAD' ? null : await localRef(s, `refs/remotes/${s.remote}/${b}`);
      if (oid) starts.push(oid);
    }
    const there = new Set<string>();
    const readCommit = async (oid: string) => parseRawCommit((await git.readObject({ fs, dir, oid, format: 'content' })).object as Uint8Array);
    for (const stack = [...starts]; stack.length;) {
      const oid = stack.pop()!;
      if (there.has(oid) || !(await has(s, oid))) continue;
      there.add(oid);
      stack.push(...(await readCommit(oid)).parents);
    }
    // Commits to create, parents before children. A parent the store lacks is past a shallow boundary: it came from GitHub
    const fresh: { oid: string; commit: RawCommit }[] = [];
    const known = new Set<string>(), visited = new Set<string>();
    const visit = async (oid: string): Promise<void> => {
      if (visited.has(oid)) return;
      visited.add(oid);
      if (!(await has(s, oid))) return;
      const commit = await readCommit(oid);
      if (there.has(oid)) return addClosure(s, known, commit.tree);
      for (const p of commit.parents) await visit(p);
      fresh.push({ oid, commit });
    };
    await visit(local);

    if (empty) {
      // The git data API answers 409 until the repository has a commit
      o.onProgress?.('The repository is empty: starting it through the contents API');
      await send(s, 'PUT', `${repoPath(s)}/contents/.gitkeep`, { message: 'Start the repository', content: '', branch });
    }

    // Blobs, then trees bottom-up, then the commit, for each commit in turn
    let written = 0;
    const wrote = () => o.onProgress?.(`Writing objects: ${++written} (${s.requests} requests)`);
    const write = limiter(WRITE_CONCURRENCY);
    const missing = (e: any, what: string) => e instanceof GitHubApiError && e.status === 422
      ? new GitHubApiError('api', `${e.message} (${what}: GitHub may no longer have objects this push builds on; fetch, then push again)`, 422) : e;
    const upload = async (oid: string): Promise<void> => {
      if (known.has(oid)) return;
      const { tree } = await git.readTree({ fs, dir, oid });
      for (const e of tree) if (e.type === 'tree') await upload(e.oid);
      await Promise.all(tree.filter(e => e.type === 'blob' && !known.has(e.oid)).map(e => write(async () => {
        if (known.has(e.oid)) return;
        known.add(e.oid);
        const { blob } = await git.readBlob({ fs, dir, oid: e.oid });
        const made = await send(s, 'POST', `${repoPath(s)}/git/blobs`, { content: toBase64(blob), encoding: 'base64' });
        if (made.sha !== e.oid) throw new GitHubApiError('unsupported', `blob ${e.oid} (${e.path}) was stored by GitHub as ${made.sha}`);
        wrote();
      })));
      const made = await send(s, 'POST', `${repoPath(s)}/git/trees`, {
        tree: tree.map(e => ({ path: e.path, mode: e.mode, type: e.type, sha: e.oid })),
      }).catch(e => { throw missing(e, `tree ${oid.slice(0, 7)}`); });
      if (made.sha !== oid) throw new GitHubApiError('unsupported', `tree ${oid} was stored by GitHub as ${made.sha}`);
      known.add(oid);
      wrote();
    };
    const shaOf = new Map<string, string>();
    for (const { oid, commit } of fresh) {
      if (!commit.author || !commit.committer) throw new GitHubApiError('unsupported', `commit ${oid} has an author or committer line the API can't express`);
      await upload(commit.tree);
      const ident = (id: RawIdent) => ({ name: id.name, email: id.email, date: isoDate(id) });
      const made = await send(s, 'POST', `${repoPath(s)}/git/commits`, {
        message: commit.message, tree: commit.tree, parents: commit.parents.map(p => shaOf.get(p) ?? p),
        author: ident(commit.author), committer: ident(commit.committer),
        ...(commit.gpgsig ? { signature: commit.gpgsig } : {}),
      }).catch(e => { throw missing(e, `commit ${oid.slice(0, 7)}`); });
      shaOf.set(oid, made.sha);
      wrote();
    }
    const tip = shaOf.get(local) ?? local;
    const rewritten = fresh.some(f => shaOf.get(f.oid) !== f.oid);

    // The contents API may have made the branch
    if (empty) remote = await remoteTip(s, branch);
    try {
      if (remote) await send(s, 'PATCH', `${repoPath(s)}/git/refs/heads/${encodePath(branch)}`, { sha: tip, force: !!o.force || empty });
      else await send(s, 'POST', `${repoPath(s)}/git/refs`, { ref: `refs/heads/${branch}`, sha: tip });
    } catch (e: any) {
      // The branch moved while the objects went up
      if (e instanceof GitHubApiError && e.code === 'non-fast-forward') return refused(remote ?? '');
      throw e;
    }
    const result: PushResult = { ok: true, oid: tip, created: !remote || empty, commits: fresh.length, rewritten };

    if (rewritten) {
      // GitHub's versions of the commits, oldest first; their trees are already here
      for (const f of fresh) {
        const sha = shaOf.get(f.oid)!;
        if (sha === f.oid || await has(s, sha)) continue;
        const bytes = await rebuildCommit(apiCommit(await getJson(s, `${repoPath(s)}/git/commits/${sha}`)), s);
        if (!bytes) {
          return { ...result, rewritten: false, error: `pushed as ${tip}, but GitHub stored commit ${f.oid.slice(0, 7)} as ${sha.slice(0, 7)} in a form that can't be read back: the local branch is unchanged` };
        }
        await store(s, 'commit', bytes, sha);
      }
      await setRef(s, `refs/heads/${branch}`, tip);
    }
    await setRef(s, tracking, tip);
    return result;
  });
}
