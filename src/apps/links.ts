/**
 * Where an app comes from (docs/APPS.md "Installing", "Links"): what
 * `app install X` and a `?app=X` address name, how its files are fetched, and
 * whether the person is asked first.
 *
 *   <id>                       an app this site ships: /apps/<id>/, listed in /apps/index.json
 *   gh:<owner>/<repo>[/<path>] a folder of a public GitHub repository, at its default branch
 *   gist:[<user>/]<id>         a gist: its files, flat (one app.json is a whole app), at its newest revision
 *   examples/<id>              an example this site keeps (apps/examples/), installed like its own apps
 *   https://…/x.zip | .tar.gz  an archive holding the app
 *   link  (+ #app=<files>)     the app's own files, carried by the address (share.ts, `app share`)
 *   #run=…&name=…              a one-file app written in the address: app.json's keys as key=value (src/link-fragment.ts)
 *
 * Trust is the run links' (src/run-url.ts): an app of this site, whose every
 * file matches the sha256 the site's own list gives, installs at once.
 * Anything else is shown first (its manifest: what it will run, what its page
 * may touch) with Install and Cancel, and what is installed is what was
 * shown: a repository is read at one commit, the manifest in the prompt is
 * the bytes that are written. A framed page takes no app link.
 *
 * No DOM and no filesystem here: the callers pass `fetch`, and get files back.
 */
import { MANIFEST_FILE, MANIFEST_MAX, ManifestError, parseManifest, validateManifest, APP_ID, RESERVED_IDS, type AppManifest, type ManifestHint } from './manifest';
import { AppError, FETCHED_BYTES_MAX, FETCHED_FILES_MAX, pageBeside } from './registry';
import { LINK_APP, unpackLink } from './share';
import { RunLinkError, GH_OWNER, GH_REPO, GH_SEGMENT, PAGE_PARAMS, fetchSiteFile, fetchRaw, githubMissing, githubTokenFetch, sha256Hex, plain, type Fetch } from '../run-url';
import { FragmentError, appFragment, manifestFromPairs, parseFragment } from '../link-fragment';

export type AppTarget =
  | { kind: 'site'; id: string }
  | { kind: 'gh'; owner: string; repo: string; path: string }
  /** `user` is '' for gist:<id> */
  | { kind: 'gist'; user: string; id: string }
  | { kind: 'url'; url: string }
  /** `?app=link#app=<payload>`: the files are in the address itself (share.ts) */
  | { kind: 'link'; payload: string }
  /** `#run=…&name=…`: a one-file app as the pairs written after the `#` (src/link-fragment.ts) */
  | { kind: 'keys'; pairs: [string, string][] };

/** A refused app link or install, and why (a sentence; no text from the link) */
export class AppLinkError extends RunLinkError {}

/** A gist's id: hex (older gists: digits) */
const GIST_ID = /^[0-9a-f]{5,40}$/;
/** `examples/<id>`: where the repository keeps the examples; on the site each is an app like its own */
const EXAMPLES = 'examples/';

/** What `app install` was given, or a `?app=` value. Throws AppLinkError for anything else. */
export function parseAppSpec(spec: string): AppTarget {
  if (spec.startsWith('gist:')) {
    const parts = spec.slice(5).split('/');
    const [user, id] = parts.length === 1 ? ['', parts[0]] : parts;
    if (parts.length > 2 || !GIST_ID.test(id ?? '') || (parts.length === 2 && !GH_OWNER.test(user))) throw new AppLinkError('a gist: app is gist:<id> or gist:<user>/<id>');
    return { kind: 'gist', user, id };
  }
  if (spec.startsWith(EXAMPLES)) spec = spec.slice(EXAMPLES.length);
  if (spec.startsWith('gh:')) {
    const [owner, repo, ...rest] = spec.slice(3).split('/');
    if (!GH_OWNER.test(owner ?? '') || !GH_REPO.test(repo ?? '') || repo === '.' || repo === '..') throw new AppLinkError('a gh: app is gh:<owner>/<repo>[/<path>]');
    if (rest.length > 12 || rest.some((s) => !GH_SEGMENT.test(s) || s === '.' || s === '..')) throw new AppLinkError("the gh: app's path may only have letters, digits, . _ - and /");
    return { kind: 'gh', owner, repo, path: rest.join('/') };
  }
  if (/^https?:/i.test(spec)) {
    let u: URL;
    try { u = new URL(spec); } catch { throw new AppLinkError('that is not an address'); }
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && /^(localhost|127\.0\.0\.1|[a-z0-9-]+\.localhost)$/.test(u.hostname))) throw new AppLinkError('an app is fetched over https');
    if (u.username || u.password) throw new AppLinkError('an app\'s address may not carry a password');
    if (!/\.(zip|tar\.gz|tgz)$/i.test(u.pathname)) throw new AppLinkError('an app\'s address must be a .zip, .tar.gz or .tgz archive');
    return { kind: 'url', url: u.href };
  }
  if (spec === LINK_APP) throw new AppLinkError('an app that a link carries is opened from the whole link, in the address bar');
  if (APP_ID.test(spec) && !RESERVED_IDS.has(spec)) return { kind: 'site', id: spec };
  throw new AppLinkError('no such app (an app is an id, gh:<owner>/<repo>[/<path>], gist:<id>, or the address of an archive)');
}

export interface ParsedAppLink {
  target: AppTarget;
  /** `&become`: the tab becomes the app instead of opening it in a window */
  become: boolean;
}

/**
 * The app link in a page address: null when there is none. Only `id`, `gh:`
 * and `link` forms: an address never names an archive. `hash` is the part
 * after `#`, where a shared app's files travel.
 */
export function parseAppUrl(search: string, hash = ''): ParsedAppLink | null {
  const q = new URLSearchParams(search);
  if (!q.has('app')) return parseAppFragment(hash);
  if (q.get('app') === LINK_APP) {
    const m = /^#app=([A-Za-z0-9_-]+)$/.exec(hash);
    if (!m) throw new AppLinkError('this app link is incomplete: the part after # is missing (it may have been cut short when it was copied)');
    return { target: { kind: 'link', payload: m[1] }, become: q.has('become') && q.get('become') !== '0' };
  }
  const target = parseAppSpec(q.get('app') ?? '');
  if (target.kind === 'url') throw new AppLinkError('an app link names an app of this site, gh:<owner>/<repo>[/<path>] or gist:<id>');
  return { target, become: q.has('become') && q.get('become') !== '0' };
}

/**
 * The app link in the part of an address after `#`, with nothing in the
 * query: a one-file app written as `key=value` pairs, or `#app=<files>`.
 * Null for anything else there (commands, a gist, nothing).
 */
export function parseAppFragment(hash: string): ParsedAppLink | null {
  try {
    const link = hash ? parseFragment(hash) : null;
    if (link?.kind === 'app') return { target: { kind: 'keys', pairs: link.pairs }, become: false };
    if (link?.kind === 'packed-app') return { target: { kind: 'link', payload: link.payload }, become: false };
    return null;
  } catch (e) {
    if (e instanceof FragmentError) throw new AppLinkError(e.message);
    throw e;
  }
}

/** `?app=…` for a target, with the parameters that go along (guest, become) */
export function appLinkQuery(target: AppTarget, extra: Record<string, string> = {}): string {
  // (an app written after the `#` has no query: the whole link is that part)
  if (target.kind === 'keys') return `#${appFragment(target.pairs)}`;
  const spec = target.kind === 'site' ? target.id : target.kind === 'gh' ? `gh:${target.owner}/${target.repo}${target.path ? '/' + target.path : ''}`
    : target.kind === 'gist' ? `gist:${target.user ? target.user + '/' : ''}${target.id}` : target.kind === 'link' ? LINK_APP : target.url;
  const q = new URLSearchParams({ app: spec });
  for (const [k, v] of Object.entries(extra)) if (PAGE_PARAMS.has(k)) q.set(k, v);
  return '?' + q.toString().replace(/%3A/g, ':').replace(/%2F/g, '/') + (target.kind === 'link' ? `#app=${target.payload}` : '');
}

export interface FetchedApp {
  manifest: AppManifest;
  /** The text of app.json, as fetched: what the prompt shows and what is written */
  manifestText: string;
  /** Every file of the app, app.json included */
  files(): Promise<Map<string, Uint8Array>>;
  /** registry.ts `source` */
  source: string;
  /** Where it came from, in words (the prompt, the terminal) */
  from: string;
  /** Reviewed by this site: installs without asking */
  curated: boolean;
}

const SAFE_REL = /^[A-Za-z0-9._@+ -]+(\/[A-Za-z0-9._@+ -]+)*$/;
const relOk = (rel: string) => SAFE_REL.test(rel) && rel.length <= 300 && !rel.split('/').some((s) => s === '.' || s === '..' || s.startsWith(' ') || s.endsWith(' '));

/** An app.json that names no page, no backend and none of the keys tabcomputer supplies a page for */
function namesNoPage(bytes: Uint8Array): boolean {
  try {
    const raw: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return !!raw && typeof raw === 'object' && !Array.isArray(raw) && !['entry', 'backend', 'run', 'fields', 'table', 'columns'].some((k) => (raw as Record<string, unknown>)[k] !== undefined);
  } catch { return false; }
}

function manifestFrom(bytes: Uint8Array, hint: ManifestHint = {}): { manifest: AppManifest; text: string } {
  if (bytes.length > MANIFEST_MAX) throw new AppLinkError('the app\'s app.json is too large');
  let manifest: AppManifest;
  try { manifest = parseManifest(bytes, hint); } catch (e) {
    if (e instanceof ManifestError) throw new AppLinkError(`the app's manifest is not valid:\n${e.message}`);
    throw e;
  }
  return { manifest, text: new TextDecoder().decode(bytes) };
}

export interface SiteAppEntry { id: string; name?: string; description?: string; version?: string; files: { path: string; sha256: string; size: number }[] }

/**
 * An app this site ships. Curated only when /apps/index.json on the page's
 * own origin lists it, and every file /apps/<id>/… returned has the sha256
 * that list gives (both fetched with redirects refused; an HTML answer, the
 * app shell standing in for a missing file, is refused).
 */
export async function fetchSiteApp(id: string, origin: string, fetchFn: Fetch): Promise<FetchedApp> {
  if (!APP_ID.test(id) || RESERVED_IDS.has(id)) throw new AppLinkError('no such app');
  const listBytes = await fetchSiteFile(`${origin}/apps/index.json`, fetchFn, 1 << 20, 'the app list', 'this site ships no apps');
  let index: { apps?: SiteAppEntry[] };
  try { index = JSON.parse(new TextDecoder().decode(listBytes)); } catch { throw new AppLinkError('could not read the app list'); }
  const entry = Array.isArray(index?.apps) ? index.apps.find((a) => a && a.id === id) : undefined;
  if (!entry || !Array.isArray(entry.files) || !entry.files.length) throw new AppLinkError('no such app');
  if (entry.files.length > FETCHED_FILES_MAX) throw new AppLinkError('the app has too many files');
  // Every name is checked before anything is fetched under it
  for (const f of entry.files) if (typeof f?.path !== 'string' || !relOk(f.path) || typeof f.sha256 !== 'string') throw new AppLinkError('the app list names a file that is not a plain path');
  const get = async (f: { path: string; sha256: string; size: number }): Promise<Uint8Array> => {
    if (typeof f?.path !== 'string' || !relOk(f.path) || typeof f.sha256 !== 'string') throw new AppLinkError('the app list names a file that is not a plain path');
    const bytes = await fetchSiteFile(`${origin}/apps/${id}/${f.path.split('/').map(encodeURIComponent).join('/')}`, fetchFn, FETCHED_BYTES_MAX, `the app's ${plain(f.path, 60)}`, `the app's ${plain(f.path, 60)} is missing`, f.path.endsWith('.html') || f.path.endsWith('.htm'));
    if ((await sha256Hex(bytes)) !== f.sha256.toLowerCase()) throw new AppLinkError('the app does not match the app list (reload and try again)');
    return bytes;
  };
  const mf = entry.files.find((f) => f?.path === MANIFEST_FILE);
  if (!mf) throw new AppLinkError('no such app');
  const { manifest, text } = manifestFrom(await get(mf), { id, page: pageBeside((rel) => entry.files.some((f) => f.path === rel)) });
  if (manifest.id !== id) throw new AppLinkError('the app\'s manifest names another id');
  return {
    manifest, manifestText: text, source: 'site', curated: true, from: `${origin.replace(/^https?:\/\//, '')}/apps/${id}/`,
    async files() {
      const out = new Map<string, Uint8Array>();
      let total = 0;
      for (const f of entry.files) {
        const bytes = f.path === MANIFEST_FILE ? new TextEncoder().encode(text) : await get(f);
        total += bytes.length;
        if (total > FETCHED_BYTES_MAX) throw new AppLinkError('the app is too large');
        out.set(f.path, bytes);
      }
      return out;
    },
  };
}

const COMMIT = /^[0-9a-f]{40}$/;

/**
 * An app in a GitHub repository, read at one commit: the default branch's
 * head when the link was opened. The manifest shown in the prompt and every
 * file installed come from that commit, so what is shown is what is installed.
 */
export async function fetchGhApp(t: { owner: string; repo: string; path: string }, visitorFetch: Fetch, githubToken?: string | null): Promise<FetchedApp> {
  // (a private repository, or the visitors' rate limit: with the tab's GitHub sign-in, once the person gave it; `fetchSignedIn`)
  const fetchFn = githubToken ? githubTokenFetch(visitorFetch, githubToken) : visitorFetch;
  if (!GH_OWNER.test(t.owner) || !GH_REPO.test(t.repo) || t.repo === '.' || t.repo === '..' || (t.path && t.path.split('/').some((s) => !GH_SEGMENT.test(s) || s === '.' || s === '..'))) throw new AppLinkError('no such app');
  const where = `github.com/${t.owner}/${t.repo}${t.path ? `, ${t.path}` : ''}`;
  const api = `https://api.github.com/repos/${t.owner}/${t.repo}`;
  const headBytes = await fetchRaw(`${api}/commits/HEAD`, (url, init) => fetchFn(url, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), accept: 'application/vnd.github.sha' } }), 200, where, githubMissing(where, !!githubToken));
  const commit = new TextDecoder().decode(headBytes).trim();
  if (!COMMIT.test(commit)) throw new AppLinkError(`could not read the head commit of ${where}`);
  const raw = (rel: string) => `https://raw.githubusercontent.com/${t.owner}/${t.repo}/${commit}/${[...(t.path ? t.path.split('/') : []), ...rel.split('/')].map(encodeURIComponent).join('/')}`;
  // The commit's files, listed once: for the page beside an app.json that names none, and for the install
  let listed: Promise<{ rels: string[]; total: number }> | null = null;
  const list = () => listed ??= (async () => {
    const treeBytes = await fetchRaw(`${api}/git/trees/${commit}?recursive=1`, fetchFn, 16 << 20, `the file list of ${where}`, `${where} does not exist`);
    let tree: { truncated?: boolean; tree?: { path?: unknown; type?: unknown; mode?: unknown; size?: unknown }[] };
    try { tree = JSON.parse(new TextDecoder().decode(treeBytes)); } catch { throw new AppLinkError(`could not read the file list of ${where}`); }
    if (tree?.truncated || !Array.isArray(tree?.tree)) throw new AppLinkError(`${where} has too many files to list`);
    const prefix = t.path ? t.path + '/' : '';
    const rels: string[] = [];
    let total = 0;
    for (const e of tree.tree) {
      if (typeof e?.path !== 'string' || !e.path.startsWith(prefix)) continue;
      const rel = e.path.slice(prefix.length);
      // Files only: a link (mode 120000) or a submodule is left out, and so is the repository's own metadata
      if (e.type !== 'blob' || e.mode === '120000' || rel.startsWith('.git/') || rel.startsWith('.github/')) continue;
      if (!relOk(rel)) throw new AppLinkError(`the app has a file whose name is not a plain path (${plain(rel, 60)})`);
      total += typeof e.size === 'number' ? e.size : 0;
      rels.push(rel);
    }
    return { rels, total };
  })();
  const manifestBytes = await fetchRaw(raw(MANIFEST_FILE), fetchFn, MANIFEST_MAX, `${where}, ${MANIFEST_FILE}`, `${where} has no ${MANIFEST_FILE}: it is not an app`);
  // An app with a page of its own may leave `entry` out, as in a folder or a gist: the page is the index.html beside app.json or in public/
  let page: string | undefined;
  if (namesNoPage(manifestBytes)) { const { rels } = await list(); page = pageBeside((rel) => rels.includes(rel)); }
  // (an app.json without an id takes the folder's name, else the repository's)
  const { manifest, text } = manifestFrom(manifestBytes, { id: t.path.split('/').pop() || t.repo, page });
  const spec = `${t.owner}/${t.repo}${t.path ? '/' + t.path : ''}`;
  return {
    manifest, manifestText: text, curated: false, source: `gh:${spec}@${commit}`, from: `${where} at commit ${commit.slice(0, 10)}`,
    async files() {
      const { rels, total } = await list();
      if (!rels.includes(MANIFEST_FILE)) throw new AppLinkError(`${where} has no ${MANIFEST_FILE}`);
      if (rels.length > FETCHED_FILES_MAX || total > FETCHED_BYTES_MAX) throw new AppLinkError(`the app is too large to install from a repository (${rels.length} files, ${(total / 1e6).toFixed(1)} MB)`);
      const out = new Map<string, Uint8Array>();
      let got = 0;
      const queue = rels.filter((r) => r !== MANIFEST_FILE);
      const lane = async () => {
        for (let rel = queue.shift(); rel !== undefined; rel = queue.shift()) {
          const bytes = await fetchRaw(raw(rel), fetchFn, FETCHED_BYTES_MAX, `${where}, ${plain(rel, 60)}`, `${where}, ${plain(rel, 60)} is missing`);
          got += bytes.length;
          if (got > FETCHED_BYTES_MAX) throw new AppLinkError('the app is too large');
          out.set(rel, bytes);
        }
      };
      await Promise.all([lane(), lane(), lane(), lane()]);
      // The manifest is the one that was shown, not fetched again
      out.set(MANIFEST_FILE, new TextEncoder().encode(text));
      return out;
    },
  };
}

/**
 * An app in a gist, read at one revision: the newest when the link was
 * opened. A gist holds no folders, so its files are the app's, flat: an
 * `app.json` alone when tabcomputer supplies the page, or with `index.html`
 * and what it loads. One request to GitHub's API gives the revision and the
 * files together, so what is shown is what is installed.
 */
export async function fetchGistApp(t: { user: string; id: string }, visitorFetch: Fetch, githubToken?: string | null): Promise<FetchedApp> {
  const fetchFn = githubToken ? githubTokenFetch(visitorFetch, githubToken) : visitorFetch;
  if (!GIST_ID.test(t.id) || (t.user && !GH_OWNER.test(t.user))) throw new AppLinkError('no such app');
  const where = `gist.github.com/${t.user ? t.user + '/' : ''}${t.id}`;
  const bytes = await fetchRaw(`https://api.github.com/gists/${t.id}`, fetchFn, 16 << 20, where, `${where} does not exist`);
  let gist: { owner?: { login?: unknown }; history?: { version?: unknown }[]; truncated?: unknown; files?: Record<string, { content?: unknown; truncated?: unknown } | null> };
  try { gist = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AppLinkError(`could not read ${where}`); }
  const rev = gist?.history?.[0]?.version;
  if (typeof rev !== 'string' || !COMMIT.test(rev)) throw new AppLinkError(`could not read the revision of ${where}`);
  const login = typeof gist.owner?.login === 'string' && GH_OWNER.test(gist.owner.login) ? gist.owner.login : '';
  if (t.user && login.toLowerCase() !== t.user.toLowerCase()) throw new AppLinkError(`${where} is not a gist of that account`);
  const listed = gist.files && typeof gist.files === 'object' && !Array.isArray(gist.files) ? Object.entries(gist.files) : [];
  if (gist.truncated || listed.length > FETCHED_FILES_MAX) throw new AppLinkError(`${where} has too many files`);
  for (const [name] of listed) if (!relOk(name) || name.includes('/')) throw new AppLinkError(`the gist has a file whose name is not a plain name (${plain(name, 60)})`);
  const get = async (name: string): Promise<Uint8Array> => {
    const f = gist.files![name];
    if (typeof f?.content === 'string' && !f.truncated) return new TextEncoder().encode(f.content);
    // A large file is not in the answer: fetched by itself, at the same revision
    if (!login) throw new AppLinkError(`${where} has no owner to fetch ${plain(name, 60)} from`);
    return fetchRaw(`https://gist.githubusercontent.com/${login}/${t.id}/raw/${rev}/${encodeURIComponent(name)}`, visitorFetch, FETCHED_BYTES_MAX, `${where}, ${plain(name, 60)}`, `${where}, ${plain(name, 60)} is missing`);
  };
  const names = listed.map(([name]) => name);
  if (!names.includes(MANIFEST_FILE)) throw new AppLinkError(`${where} has no ${MANIFEST_FILE}: it is not an app`);
  const { manifest, text } = manifestFrom(await get(MANIFEST_FILE), { page: pageBeside((rel) => names.includes(rel)) });
  return {
    manifest, manifestText: text, curated: false, source: `gist:${t.id}@${rev}`, from: `${where} at revision ${rev.slice(0, 10)}`,
    async files() {
      const out = new Map<string, Uint8Array>();
      let total = 0;
      for (const name of names) {
        const b = name === MANIFEST_FILE ? new TextEncoder().encode(text) : await get(name);
        total += b.length;
        if (total > FETCHED_BYTES_MAX) throw new AppLinkError('the app is too large');
        out.set(name, b);
      }
      return out;
    },
  };
}

/** An archive's files as an app: `app.json` at the top, or inside its one top-level folder */
export function archiveApp(files: Map<string, Uint8Array>, url: string): FetchedApp {
  let entries = [...files];
  if (!files.has(MANIFEST_FILE)) {
    const tops = new Set(entries.map(([p]) => p.split('/')[0]));
    const top = tops.size === 1 ? [...tops][0] + '/' : '';
    if (!top || !files.has(top + MANIFEST_FILE)) throw new AppLinkError(`the archive has no ${MANIFEST_FILE} at its top`);
    entries = entries.map(([p, b]) => [p.slice(top.length), b]);
  }
  const map = new Map<string, Uint8Array>();
  for (const [p, b] of entries) {
    if (!p || p.endsWith('/')) continue;
    if (!relOk(p)) throw new AppLinkError(`the archive has a file whose name is not a plain path (${plain(p, 60)})`);
    map.set(p, b);
  }
  const { manifest, text } = manifestFrom(map.get(MANIFEST_FILE)!, { page: pageBeside((rel) => map.has(rel)) });
  let host = url;
  try { const u = new URL(url); host = u.host + u.pathname; } catch { /* shown as given */ }
  return { manifest, manifestText: text, curated: false, source: `url:${url}`, from: plain(host, 100), files: async () => map };
}

/**
 * The app a shared link carries (`app share`, share.ts). Never curated: the
 * person who opens the link is shown it first. Its `source` is a hash of the
 * link's payload, so the same link opened again finds the app it installed.
 */
export async function linkApp(payload: string): Promise<FetchedApp> {
  let files: Map<string, Uint8Array>;
  let hint: string;
  try { ({ files, id: hint } = await unpackLink(payload)); } catch (e) {
    throw new AppLinkError(e instanceof AppError ? e.message : 'the link does not hold an app');
  }
  const { manifest, text } = manifestFrom(files.get(MANIFEST_FILE)!, { id: APP_ID.test(hint) ? hint : undefined, page: pageBeside((rel) => files.has(rel)) });
  let bytes = 0;
  for (const b of files.values()) bytes += b.length;
  const id = (await sha256Hex(new TextEncoder().encode(payload))).slice(0, 16);
  return {
    manifest, manifestText: text, curated: false, source: `link:${id}`,
    from: `this link (${files.size} ${files.size === 1 ? 'file' : 'files'}, ${Math.max(1, Math.ceil(bytes / 1000))} KB)`,
    files: async () => files,
  };
}

const notValid = (problems: string[]): string => `the app in the link is not valid:\n${problems.map((p) => `  ${p}`).join('\n')}`;

/**
 * The one-file app a link spells after its `#` (`#run=…&name=…`). Never
 * curated: the person who opens the link is shown it first. Its app.json is
 * written here from the pairs, and that text is what the prompt shows and
 * what is installed. Its `source` is a hash of that text, so the same link
 * opened again finds the app it installed. Every problem names its key.
 */
export async function keysApp(pairs: [string, string][]): Promise<FetchedApp> {
  const { raw, problems } = manifestFromPairs(pairs);
  if (problems.length) throw new AppLinkError(notValid(problems));
  let manifest: AppManifest;
  try { manifest = validateManifest(raw); } catch (e) {
    if (e instanceof ManifestError) throw new AppLinkError(notValid(e.problems));
    throw e;
  }
  const text = JSON.stringify(raw, null, 2) + '\n';
  if (text.length > MANIFEST_MAX) throw new AppLinkError('the app in the link is too large');
  const id = (await sha256Hex(new TextEncoder().encode(text))).slice(0, 16);
  return {
    manifest, manifestText: text, curated: false, source: `link:${id}`,
    from: 'this link',
    files: async () => new Map([[MANIFEST_FILE, new TextEncoder().encode(text)]]),
  };
}

/** The bytes of an archive at an address: no cookies, no redirect to somewhere else, not a web page */
export function fetchArchive(url: string, fetchFn: Fetch): Promise<Uint8Array> {
  let shown = url;
  try { const u = new URL(url); shown = u.host + u.pathname; } catch { /* as given */ }
  return fetchRaw(url, fetchFn, FETCHED_BYTES_MAX, plain(shown, 80), `${plain(shown, 80)} does not exist`);
}

export interface InstallPromptInfo {
  manifest: AppManifest;
  manifestText: string;
  from: string;
  /** An older install of this id is replaced */
  replaces?: string;
  /** This server has guests: offer "Open in a guest" */
  guests: boolean;
  /** Its page gets an origin of its own here */
  confined: boolean;
}
export type InstallChoice = 'install' | 'guest' | 'cancel';

export interface AppLinkDeps {
  search: string;
  /** The address's part after `#` (a shared app's files) */
  hash?: string;
  origin: string;
  framed: boolean;
  fetch: Fetch;
  cleanUrl(): void;
  ready?(): Promise<void>;
  /** The source of the app installed under this id, or null */
  installedSource(id: string): Promise<string | null>;
  /** Show an app that isn't curated; 'install' only when the person chose Install */
  confirm(app: FetchedApp): Promise<InstallChoice>;
  /** Write the files and register the app */
  install(app: FetchedApp, files: Map<string, Uint8Array>): Promise<void>;
  /** Open the installed app: a window, or the whole tab */
  open(id: string, become: boolean): Promise<void>;
  /** The same link in a guest (false: this server has none) */
  openInGuest(query: string): Promise<boolean>;
  report(message: string): void;
  /** Fetch as a visitor, then signed in to GitHub when that is what was missing (`fetchSignedIn`); absent: as a visitor only */
  github?<T>(action: string, run: (token: string | null) => Promise<T>): Promise<T>;
}

export type AppLinkOutcome = 'none' | 'opened' | 'installed' | 'guest' | 'cancelled' | 'refused';

/** Handle the page's app link, if it has one. Never throws. */
export async function handleAppLink(deps: AppLinkDeps): Promise<AppLinkOutcome> {
  let parsed: ParsedAppLink | null;
  try {
    const inQuery = new URLSearchParams(deps.search).has('app');
    // (without `app` in the query the link is the part after `#`: it leaves the address too)
    try { parsed = parseAppUrl(deps.search, deps.hash ?? ''); } finally { if (inQuery || deps.hash) deps.cleanUrl(); }
    await deps.ready?.();
    if (!parsed) return 'none';
    if (deps.framed) throw new AppLinkError('app links are ignored inside a frame; open the link in its own tab');
    const t = parsed.target;
    const app = t.kind === 'site' ? await fetchSiteApp(t.id, deps.origin, deps.fetch)
      : t.kind === 'link' ? await linkApp(t.payload)
      : t.kind === 'keys' ? await keysApp(t.pairs)
      : t.kind === 'gist' ? await (deps.github ?? ((_action, run) => run(null)))(`gist:${t.id}`, (token) => fetchGistApp(t, deps.fetch, token))
      : await (deps.github ?? ((_action, run) => run(null)))(`gh:${(t as { owner: string }).owner}/${(t as { repo: string }).repo}`,
        (token) => fetchGhApp(t as { owner: string; repo: string; path: string }, deps.fetch, token));
    const had = await deps.installedSource(app.manifest.id);
    // Already here from this very place (the same commit, for a repository): opening it is all that is left
    if (had !== app.source) {
      if (!app.curated) {
        const choice = await deps.confirm(app);
        if (choice === 'guest') {
          if (!await deps.openInGuest(appLinkQuery(t, parsed.become ? { become: '1' } : {}))) throw new AppLinkError('this server has no guests');
          return 'guest';
        }
        if (choice !== 'install') return 'cancelled';
      }
      await deps.install(app, await app.files());
    }
    await deps.open(app.manifest.id, parsed.become);
    return had === app.source ? 'opened' : 'installed';
  } catch (e) {
    await deps.ready?.().catch(() => {});
    deps.report(e instanceof RunLinkError || e instanceof ManifestError ? e.message : 'it failed to start');
    if (!(e instanceof RunLinkError) && !(e instanceof ManifestError)) console.warn('[app-link]', e);
    return 'refused';
  }
}
