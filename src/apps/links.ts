/**
 * Where an app comes from (docs/APPS.md "Installing", "Links"): what
 * `app install X` and a `?app=X` address name, how its files are fetched, and
 * whether the person is asked first.
 *
 *   <id>                       an app this site ships: /apps/<id>/, listed in /apps/index.json
 *   gh:<owner>/<repo>[/<path>] a folder of a public GitHub repository, at its default branch
 *   https://…/x.zip | .tar.gz  an archive holding the app
 *   link  (+ #app=<files>)     the app's own files, carried by the address (share.ts, `app share`)
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
import { MANIFEST_FILE, MANIFEST_MAX, ManifestError, parseManifest, APP_ID, RESERVED_IDS, type AppManifest } from './manifest';
import { AppError, FETCHED_BYTES_MAX, FETCHED_FILES_MAX } from './registry';
import { LINK_APP, unpackApp } from './share';
import { RunLinkError, GH_OWNER, GH_REPO, GH_SEGMENT, PAGE_PARAMS, fetchSiteFile, fetchRaw, githubMissing, githubTokenFetch, sha256Hex, plain, type Fetch } from '../run-url';

export type AppTarget =
  | { kind: 'site'; id: string }
  | { kind: 'gh'; owner: string; repo: string; path: string }
  | { kind: 'url'; url: string }
  /** `?app=link#app=<payload>`: the files are in the address itself (share.ts) */
  | { kind: 'link'; payload: string };

/** A refused app link or install, and why (a sentence; no text from the link) */
export class AppLinkError extends RunLinkError {}

/** What `app install` was given, or a `?app=` value. Throws AppLinkError for anything else. */
export function parseAppSpec(spec: string): AppTarget {
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
  throw new AppLinkError('no such app (an app is an id, gh:<owner>/<repo>[/<path>], or the address of an archive)');
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
  if (!q.has('app')) return null;
  if (q.get('app') === LINK_APP) {
    const m = /^#app=([A-Za-z0-9_-]+)$/.exec(hash);
    if (!m) throw new AppLinkError('this app link is incomplete: the part after # is missing (it may have been cut short when it was copied)');
    return { target: { kind: 'link', payload: m[1] }, become: q.has('become') && q.get('become') !== '0' };
  }
  const target = parseAppSpec(q.get('app') ?? '');
  if (target.kind === 'url') throw new AppLinkError('an app link names an app of this site or gh:<owner>/<repo>[/<path>]');
  return { target, become: q.has('become') && q.get('become') !== '0' };
}

/** `?app=…` for a target, with the parameters that go along (guest, become) */
export function appLinkQuery(target: AppTarget, extra: Record<string, string> = {}): string {
  const spec = target.kind === 'site' ? target.id : target.kind === 'gh' ? `gh:${target.owner}/${target.repo}${target.path ? '/' + target.path : ''}` : target.kind === 'link' ? LINK_APP : target.url;
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

function manifestFrom(bytes: Uint8Array): { manifest: AppManifest; text: string } {
  if (bytes.length > MANIFEST_MAX) throw new AppLinkError('the app\'s app.json is too large');
  let manifest: AppManifest;
  try { manifest = parseManifest(bytes); } catch (e) {
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
  const { manifest, text } = manifestFrom(await get(mf));
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
  const { manifest, text } = manifestFrom(await fetchRaw(raw(MANIFEST_FILE), fetchFn, MANIFEST_MAX, `${where}, ${MANIFEST_FILE}`, `${where} has no ${MANIFEST_FILE}: it is not an app`));
  const spec = `${t.owner}/${t.repo}${t.path ? '/' + t.path : ''}`;
  return {
    manifest, manifestText: text, curated: false, source: `gh:${spec}@${commit}`, from: `${where} at commit ${commit.slice(0, 10)}`,
    async files() {
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
  const { manifest, text } = manifestFrom(map.get(MANIFEST_FILE)!);
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
  try { files = await unpackApp(payload); } catch (e) {
    throw new AppLinkError(e instanceof AppError ? e.message : 'the link does not hold an app');
  }
  const { manifest, text } = manifestFrom(files.get(MANIFEST_FILE)!);
  let bytes = 0;
  for (const b of files.values()) bytes += b.length;
  const id = (await sha256Hex(new TextEncoder().encode(payload))).slice(0, 16);
  return {
    manifest, manifestText: text, curated: false, source: `link:${id}`,
    from: `a link that carries the app's own files (${files.size} ${files.size === 1 ? 'file' : 'files'}, ${Math.max(1, Math.ceil(bytes / 1000))} KB)`,
    files: async () => files,
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
    try { parsed = parseAppUrl(deps.search, deps.hash ?? ''); } finally { if (new URLSearchParams(deps.search).has('app')) deps.cleanUrl(); }
    await deps.ready?.();
    if (!parsed) return 'none';
    if (deps.framed) throw new AppLinkError('app links are ignored inside a frame; open the link in its own tab');
    const t = parsed.target;
    const app = t.kind === 'site' ? await fetchSiteApp(t.id, deps.origin, deps.fetch)
      : t.kind === 'link' ? await linkApp(t.payload)
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
