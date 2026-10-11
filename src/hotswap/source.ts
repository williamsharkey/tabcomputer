/**
 * A checkout of this build's own source in the tab, and pushing changes made
 * to it (docs/HOTSWAP.md).
 *
 * A production build carries assets/hotswap-source-<sha>.tar.gz (vite-plugin-hotswap.ts):
 * src/, profiles/, the vitest suites and the root files a build needs, plus
 * .hotswap-source.json (the commit, the build number, each file's git blob
 * id). `hotswap checkout` unpacks it; `hotswap diff` compares the files with
 * the manifest; `hotswap push` makes a commit of the changed files on top of
 * the build's commit through GitHub's REST API (blobs, a tree on the commit's
 * tree, a commit, a ref), so no clone of the whole repository (hundreds of
 * MB of packages) is needed.
 */
import { untar, gunzip } from '../pkg-tar';

export interface SourceFs {
  readFile(path: string, enc?: 'utf8'): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

export interface SourceManifest {
  sha: string;
  build: string;
  files: Record<string, string>;
}

export const MANIFEST = '.hotswap-source.json';
export const CACHE = '.hotswap/source.tar.gz';
const DIRS = ['src', 'profiles', 'tests/tests/shiro-vitest'];

export function pageBuildSha(): string {
  try { return typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : ''; } catch { return ''; }
}

/** The URL of this page's source tarball (the name vite-plugin-hotswap.ts sourceTarName gives it) */
export function sourceUrl(sha = pageBuildSha(), base = typeof document !== 'undefined' ? document.baseURI : 'http://localhost/'): string {
  return new URL(`assets/hotswap-source-${sha ? sha.slice(0, 12) : 'nogit'}.tar.gz`, base).toString();
}

const enc = new TextEncoder();
const bytesOf = (d: Uint8Array | string) => (typeof d === 'string' ? enc.encode(d) : d);

export async function gitBlobSha(data: Uint8Array): Promise<string> {
  const head = enc.encode(`blob ${data.length}\0`);
  const all = new Uint8Array(head.length + data.length);
  all.set(head);
  all.set(data, head.length);
  const digest = await crypto.subtle.digest('SHA-1', all);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function exists(fs: SourceFs, p: string): Promise<boolean> {
  try { await fs.stat(p); return true; } catch { return false; }
}

/** Unpack a source tarball into dir; returns its manifest */
export async function unpackSource(fs: SourceFs, dir: string, gz: Uint8Array): Promise<SourceManifest> {
  const entries = untar(await gunzip(gz));
  const made = new Set<string>();
  const mkdirp = async (d: string) => { if (!made.has(d)) { await fs.mkdir(d, { recursive: true }); made.add(d); } };
  let manifest: SourceManifest | null = null;
  for (const e of entries) {
    if (e.type !== 'file') continue;
    const p = `${dir}/${e.path}`;
    await mkdirp(p.slice(0, p.lastIndexOf('/')));
    await fs.writeFile(p, e.data);
    if (e.path === MANIFEST) manifest = JSON.parse(new TextDecoder().decode(e.data));
  }
  if (!manifest) throw new Error('the tarball has no ' + MANIFEST);
  await mkdirp(`${dir}/.hotswap`);
  await fs.writeFile(`${dir}/${CACHE}`, gz);
  return manifest;
}

/** Download this build's source into dir (which must be empty or missing unless force) */
export async function checkoutSource(fs: SourceFs, dir: string, opts: { force?: boolean; url?: string; fetch?: typeof fetch } = {}): Promise<SourceManifest> {
  if (!opts.force && await exists(fs, dir)) {
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    if (names.length) throw new Error(`${dir} is not empty (--force unpacks over it)`);
  }
  const url = opts.url ?? sourceUrl();
  const resp = await (opts.fetch ?? fetch)(url);
  if (!resp.ok) {
    throw new Error(resp.status === 404
      ? `this tab's build has no source on the server (${url}: 404); a dev server has none, and deploys keep older builds' for a week (reload to get the current build)`
      : `${url}: HTTP ${resp.status}`);
  }
  return unpackSource(fs, dir, new Uint8Array(await resp.arrayBuffer()));
}

export async function readManifest(fs: SourceFs, dir: string): Promise<SourceManifest> {
  try {
    return JSON.parse(await fs.readFile(`${dir}/${MANIFEST}`, 'utf8') as string);
  } catch {
    throw new Error(`${dir} has no ${MANIFEST}: make the checkout with 'hotswap checkout'`);
  }
}

export interface Change { path: string; status: 'M' | 'A' | 'D' }

async function walk(fs: SourceFs, dir: string, rel: string, out: string[]): Promise<void> {
  let names: string[];
  try { names = await fs.readdir(`${dir}/${rel}`); } catch { return; }
  for (const n of names) {
    const r = `${rel}/${n}`;
    if (n === 'node_modules' || r === 'tests/tests/shiro-vitest/fixtures') continue;
    const st = await fs.stat(`${dir}/${r}`).catch(() => null);
    if (st?.isDirectory()) await walk(fs, dir, r, out);
    else if (st?.isFile()) out.push(r);
  }
}

/** Files changed since the checkout: modified, added (under the source directories) and deleted */
export async function sourceChanges(fs: SourceFs, dir: string, manifest?: SourceManifest): Promise<Change[]> {
  const m = manifest ?? await readManifest(fs, dir);
  const out: Change[] = [];
  for (const [path, sha] of Object.entries(m.files)) {
    let data: Uint8Array;
    try { data = bytesOf(await fs.readFile(`${dir}/${path}`)); } catch { out.push({ path, status: 'D' }); continue; }
    if (await gitBlobSha(data) !== sha) out.push({ path, status: 'M' });
  }
  const present: string[] = [];
  for (const d of DIRS) await walk(fs, dir, d, present);
  for (const path of present) if (!(path in m.files)) out.push({ path, status: 'A' });
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** A file's text as the checkout had it (from the cached tarball) */
export async function baseText(fs: SourceFs, dir: string, path: string): Promise<string | null> {
  const gz = bytesOf(await fs.readFile(`${dir}/${CACHE}`));
  const e = untar(await gunzip(gz)).find((x) => x.path === path && x.type === 'file');
  return e ? new TextDecoder().decode(e.data) : null;
}

export type GhApi = (method: string, path: string, body?: unknown) => Promise<{ status: number; data: any }>;

export interface PushOptions {
  repo: string;
  branch: string;
  message: string;
  author?: { name: string; email: string };
}

export interface PushResult { commit: string; branch: string; created: boolean; url: string; files: number }

function b64(data: Uint8Array): string {
  let s = '';
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

/**
 * Commit the checkout's changes on top of the build's commit as a new
 * branch. A branch this checkout made gets a new commit on top (its content
 * is still the build plus every change); any other existing branch, and
 * main, deploy and unix/*, are refused. Never a force push.
 */
/** Branches a push from the tab never touches: the trunk, the deploy branch, the shared unix/* work branches */
export function protectedBranch(branch: string): boolean {
  return /^(main|master|deploy|unix\/.*)$/.test(branch);
}

export async function pushSource(fs: SourceFs, dir: string, api: GhApi, opts: PushOptions): Promise<PushResult> {
  if (protectedBranch(opts.branch)) throw new Error(`won't push to ${opts.branch}: push a new branch (e.g. hotswap/${opts.branch.replace(/^unix\//, '')}-fix) and open a pull request`);
  if (!/^[\w.\/-]+$/.test(opts.branch) || opts.branch.includes('..') || opts.branch.endsWith('/')) throw new Error(`bad branch name: ${opts.branch}`);
  const m = await readManifest(fs, dir);
  if (!m.sha) throw new Error('the checkout has no commit id (a build outside git); push it some other way');
  const changes = await sourceChanges(fs, dir, m);
  if (!changes.length) throw new Error('nothing changed since the checkout');
  const ok = (r: { status: number; data: any }, what: string) => {
    if (r.status >= 300) throw new Error(`${what}: HTTP ${r.status}${r.data?.message ? `: ${r.data.message}` : ''}`);
    return r.data;
  };
  const repo = `/repos/${opts.repo}`;
  const base = await api('GET', `${repo}/git/commits/${m.sha}`);
  if (base.status === 404) throw new Error(`the build's commit ${m.sha.slice(0, 12)} isn't in ${opts.repo} (--repo OWNER/NAME)`);
  const baseTree = ok(base, 'reading the build commit').tree.sha as string;

  // Where this checkout last pushed each branch
  const pushedPath = `${dir}/.hotswap/pushed.json`;
  let pushed: Record<string, string> = {};
  try { pushed = JSON.parse(await fs.readFile(pushedPath, 'utf8') as string); } catch { /* none yet */ }
  const ref = await api('GET', `${repo}/git/ref/heads/${opts.branch}`);
  const head: string | null = ref.status === 200 ? ref.data?.object?.sha ?? null : null;
  if (ref.status !== 200 && ref.status !== 404) ok(ref, 'reading the branch');
  // Only a branch this checkout made, still where its last push left it
  if (head && head !== pushed[opts.branch]) {
    throw new Error(`branch ${opts.branch} ${opts.branch in pushed ? 'moved since this checkout pushed it' : "exists and wasn't made from this checkout"}; push to a new branch (e.g. ${opts.branch}-2)`);
  }

  const tree: unknown[] = [];
  for (const c of changes) {
    if (c.status === 'D') { tree.push({ path: c.path, mode: '100644', type: 'blob', sha: null }); continue; }
    const data = bytesOf(await fs.readFile(`${dir}/${c.path}`));
    const blob = ok(await api('POST', `${repo}/git/blobs`, { content: b64(data), encoding: 'base64' }), `uploading ${c.path}`);
    tree.push({ path: c.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const newTree = ok(await api('POST', `${repo}/git/trees`, { base_tree: baseTree, tree }), 'making the tree');
  const parent = head ?? m.sha;
  const commitBody: any = { message: opts.message, tree: newTree.sha, parents: [parent] };
  if (opts.author) commitBody.author = opts.author;
  const commit = ok(await api('POST', `${repo}/git/commits`, commitBody), 'making the commit');
  if (head) ok(await api('PATCH', `${repo}/git/refs/heads/${opts.branch}`, { sha: commit.sha, force: false }), 'moving the branch');
  else ok(await api('POST', `${repo}/git/refs`, { ref: `refs/heads/${opts.branch}`, sha: commit.sha }), 'making the branch');

  pushed[opts.branch] = commit.sha;
  await fs.mkdir(`${dir}/.hotswap`, { recursive: true });
  await fs.writeFile(pushedPath, JSON.stringify(pushed));
  return { commit: commit.sha, branch: opts.branch, created: !head, url: `https://github.com/${opts.repo}/tree/${opts.branch}`, files: changes.length };
}
