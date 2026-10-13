/**
 * Run links (docs/RUN_LINKS.md): `?run=` in the page's address names a setup
 * script that runs in a new Terminal once the machine has booted, in
 * `~/run/<name>/`, so a solution sent to someone is one URL.
 *
 *   ?run=<name>                    a curated recipe, served by this site at /recipes/<name>.sh
 *   ?run=gh:<owner>/<repo>[/path]  a script in a GitHub repository (default .tabcomputer/run.sh)
 *   ?run=sh:<base64url>            a script carried in the link itself
 *   ?run=gist:<user>/<id>[/file]   a file of a gist (its first file unless one is named); gist:<id> looks the owner up
 *   ?run=lab:<owner>/<repo>        a class repository: sign in if it is private, clone it, open the Code app (src/lab.ts)
 *
 * `?app=` (src/apps/links.ts, docs/APPS.md) is the same machinery for an app
 * instead of a script: the trust rule, the cleaned address, the framed-page
 * refusal, `?safe=1` and guest routing are shared.
 *
 * Trust: a tab can hold tokens and the person's files, so a link never runs
 * code nobody reviewed without asking. A curated recipe (listed in
 * /recipes/index.json with the sha256 of its file, same origin, no redirect)
 * runs at once. `gh:` and `sh:` scripts are shown whole in a window with Run
 * and Cancel (src/run-prompt.ts), on every load. A framed page ignores run
 * links: the frame's owner could cover the prompt.
 *
 * Arguments: the script's `# args:` header names them; a query parameter of
 * that name becomes `RUN_<NAME>` in the Terminal's environment. Values are
 * set on the shell's environment, never written into shell text. A recipe
 * may fetch what an argument names; it must not run it (docs/RUN_LINKS.md).
 *
 * This module has no DOM and no imports: main.ts loads it only when the
 * address has `run`, and the tests drive it with stand-ins.
 */

/** Query parameters that are the page's own: never arguments, and left in the address */
export const PAGE_PARAMS = new Set(['run', 'app', 'become', 'safe', 'ui', 'profile', 'reload', 'hotswap', 'watchdog', 'demo', 'unbecome', 'apps', 'guest', 'nonet']);
/** The page's parameters that are a link's own: gone from the address once the link is taken */
const LINK_PARAMS = new Set(['run', 'app', 'become']);

const RECIPE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** `gh-…`, `sh-…` and `gist-…` are the directories of scripts that aren't curated; `lab-…` names a lab link */
const RESERVED_NAME = /^(gh|sh|gist|lab)(-|$)/;
export const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const GH_REPO = /^[A-Za-z0-9._-]{1,100}$/;
export const GH_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
/** A gist's id: hex (older gists: digits) */
const GIST_ID = /^[0-9a-f]{5,40}$/;
const ARG_NAME = /^[a-z][a-z0-9_]{0,31}$/;
export const GH_DEFAULT_PATH = '.tabcomputer/run.sh';
/** Largest script a link may run (a curated recipe: CURATED_MAX) */
export const SCRIPT_MAX = 64 << 10;
const CURATED_MAX = 256 << 10;
const VALUE_MAX = 2000;
/** The script and the file the Terminal sources, in ~/run/<name>/ */
export const SCRIPT_FILE = '.recipe.sh';
export const START_FILE = '.run-link';

export type RunTarget =
  | { kind: 'recipe'; name: string }
  | { kind: 'gh'; name: string; owner: string; repo: string; path: string }
  /** `user` is '' for gist:<id> (looked up); `file` is '' for the gist's first file */
  | { kind: 'gist'; name: string; user: string; id: string; file: string }
  | { kind: 'sh'; name: string; bytes: Uint8Array }
  /** A class repository (a lab link): no script is fetched; `lab open` clones it and opens the Code app */
  | { kind: 'lab'; name: string; owner: string; repo: string };

export interface ParsedRun {
  target: RunTarget;
  /** Every other parameter that isn't the page's own, lower-cased name → value (first wins) */
  params: Record<string, string>;
}

/** A link that must not run, and why (shown to the person, so no text from the link) */
export class RunLinkError extends Error {}

/** Characters that make text read differently from what runs: controls (but \n and \t), bidi and invisible marks */
export const DECEPTIVE = /[\x00-\x08\x0b-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\u061c\ufeff]/;

/** Text from a link or a script, safe to show on a terminal or in a message: one line, no control characters */
export function plain(s: string, max = 120): string {
  const t = String(s).replace(new RegExp(DECEPTIVE.source, 'g'), '?').replace(/[\n\t]/g, ' ');
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/** Single-quote for the shell */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

function base64urlBytes(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(s)) throw new RunLinkError('the sh: script is not base64url');
  let bin: string;
  try { bin = atob(s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/')); } catch { throw new RunLinkError('the sh: script is not base64url'); }
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** For links: a script as the `sh:` form carries it */
export function encodeShLink(script: string): string {
  let bin = '';
  for (const b of new TextEncoder().encode(script)) bin += String.fromCharCode(b);
  return 'sh:' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * The run link in a query string: null when there is none, a RunLinkError
 * when `run` is there but names nothing this page will run.
 */
export function parseRunUrl(search: string): ParsedRun | null {
  const q = new URLSearchParams(search);
  if (!q.has('run')) return null;
  const run = q.get('run') ?? '';
  let target: RunTarget;
  if (run.startsWith('gh:')) {
    const [owner, repo, ...rest] = run.slice(3).split('/');
    const segs = rest.length ? rest : GH_DEFAULT_PATH.split('/');
    if (!GH_OWNER.test(owner ?? '') || !GH_REPO.test(repo ?? '') || repo === '.' || repo === '..') {
      throw new RunLinkError('a gh: link is gh:<owner>/<repo>[/<path>]');
    }
    if (segs.length > 12 || segs.some((s) => !GH_SEGMENT.test(s) || s === '.' || s === '..')) {
      throw new RunLinkError("the gh: link's path may only have letters, digits, . _ - and /");
    }
    const path = segs.join('/');
    const name = ['gh', slug(owner), slug(repo), ...(path === GH_DEFAULT_PATH ? [] : [slug(path)])].filter(Boolean).join('-').slice(0, 96);
    target = { kind: 'gh', name, owner, repo, path };
  } else if (run.startsWith('lab:')) {
    // lab:<owner>/<repo>, nothing after it: the repository itself is what opens
    const parts = run.slice(4).split('/');
    const [owner, repo] = parts;
    if (parts.length !== 2 || !GH_OWNER.test(owner ?? '') || !GH_REPO.test(repo ?? '') || repo.startsWith('.') || repo.endsWith('.git')) {
      throw new RunLinkError('a lab: link is lab:<owner>/<repo>');
    }
    target = { kind: 'lab', name: ['lab', slug(owner), slug(repo)].filter(Boolean).join('-').slice(0, 96), owner, repo };
  } else if (run.startsWith('gist:')) {
    // gist:<id>, gist:<user>/<id>, gist:<user>/<id>/<file>: a file is one name, never a path
    const parts = run.slice(5).split('/');
    const [user, id, file] = parts.length === 1 ? ['', parts[0], ''] : [parts[0], parts[1] ?? '', parts[2] ?? ''];
    if (parts.length > 3 || !GIST_ID.test(id) || (parts.length > 1 && !GH_OWNER.test(user))) {
      throw new RunLinkError('a gist: link is gist:<user>/<id>[/<file>] or gist:<id>');
    }
    if (parts.length === 3 && (!GH_SEGMENT.test(file) || file === '.' || file === '..')) {
      throw new RunLinkError("the gist: link's file may only have letters, digits, . _ and -");
    }
    const name = ['gist', slug(user), id.slice(0, 12), slug(file)].filter(Boolean).join('-').slice(0, 96);
    target = { kind: 'gist', name, user, id, file };
  } else if (run.startsWith('sh:')) {
    const bytes = base64urlBytes(run.slice(3));
    if (!bytes.length) throw new RunLinkError('the sh: script is empty');
    if (bytes.length > SCRIPT_MAX) throw new RunLinkError('the sh: script is too long');
    // (its directory is named after its hash, in loadScript)
    target = { kind: 'sh', name: 'sh', bytes };
  } else if (RECIPE_NAME.test(run) && !RESERVED_NAME.test(run)) {
    target = { kind: 'recipe', name: run };
  } else {
    throw new RunLinkError('no such recipe (a recipe name has only a-z, 0-9 and -)');
  }
  const params: Record<string, string> = {};
  for (const [k, v] of q) {
    const key = k.toLowerCase();
    if (PAGE_PARAMS.has(key) || key in params) continue;
    params[key] = v;
  }
  return { target, params };
}

/** The address without the link: `run`, `app` (and its `become`) and every parameter that isn't the page's own. */
export function cleanRunUrl(href: string): string {
  const u = new URL(href);
  for (const k of [...u.searchParams.keys()]) {
    if (LINK_PARAMS.has(k.toLowerCase()) || !PAGE_PARAMS.has(k.toLowerCase())) u.searchParams.delete(k);
  }
  return u.toString();
}

/** Header keys a recipe may carry (docs/RUN_LINKS.md "Recipe format") */
export const HEADER_KEYS = ['title', 'for', 'needs', 'first-run', 'later', 'args', 'on-open', 'profile', 'status'] as const;
export type RecipeHeader = Partial<Record<(typeof HEADER_KEYS)[number], string>>;

/** `# key: value` lines in the comment block at the top of a script (the first of each key). */
export function parseRecipeHeader(script: string): RecipeHeader {
  const h: RecipeHeader = {};
  for (const line of script.split('\n')) {
    if (!line.startsWith('#')) { if (line.trim()) break; continue; }
    const m = /^#\s*([a-z][a-z-]*):\s*(.*?)\s*$/.exec(line);
    if (!m || !(HEADER_KEYS as readonly string[]).includes(m[1])) continue;
    const key = m[1] as keyof RecipeHeader;
    if (h[key] === undefined && m[2]) h[key] = m[2];
  }
  return h;
}

/** Argument names from an `# args:` header: `repo (optional git URL), main (the main file)` → repo, main */
export function declaredArgs(args: string | undefined): string[] {
  const out: string[] = [];
  for (const part of (args ?? '').replace(/\([^)]*\)/g, '').split(',')) {
    const name = part.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (ARG_NAME.test(name) && !PAGE_PARAMS.has(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/**
 * The environment a link's parameters give the script: RUN_<NAME> for each
 * declared argument that is present. `ignored` are parameters the script
 * doesn't declare. A value that could change what a terminal shows (control
 * characters) or is very long stops the run.
 */
export function runEnv(params: Record<string, string>, header: RecipeHeader): { env: Record<string, string>; ignored: string[] } {
  const declared = declaredArgs(header.args);
  const env: Record<string, string> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (!declared.includes(k)) { ignored.push(k); continue; }
    if (v.length > VALUE_MAX) throw new RunLinkError(`the link's ${k} argument is too long`);
    if (DECEPTIVE.test(v) || /[\n\t]/.test(v)) throw new RunLinkError(`the link's ${k} argument has control characters`);
    env[`RUN_${k.toUpperCase()}`] = v;
  }
  return { env, ignored };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** A script's text from its bytes: UTF-8, LF line ends, nothing that hides what it does. */
export function scriptText(bytes: Uint8Array): string {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new RunLinkError('the script is not UTF-8 text'); }
  text = text.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  if (!text.trim()) throw new RunLinkError('the script is empty');
  if (DECEPTIVE.test(text)) throw new RunLinkError('the script has control or invisible characters, so what it shows may not be what it runs');
  return text.endsWith('\n') ? text : text + '\n';
}

export interface RecipeIndexEntry {
  name: string; sha256: string;
  title?: string; for?: string; needs?: string; args?: string; status?: string; profile?: string;
  'first-run'?: string; later?: string;
}

export interface LoadedScript {
  /** Directory name under ~/run */
  name: string;
  /** Reviewed by this site: runs without asking */
  curated: boolean;
  text: string;
  sha256: string;
  /** Where it came from, for the Terminal's first line and the prompt */
  from: string;
  header: RecipeHeader;
}

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** A same-origin file exactly as the site serves it: no redirect, not the app shell standing in for a missing file. */
export async function fetchSiteFile(url: string, fetchFn: Fetch, max: number, what: string, missing: string, isHtml = false): Promise<Uint8Array> {
  let res: Response;
  try { res = await fetchFn(url, { redirect: 'error', credentials: 'same-origin', cache: 'no-cache' }); } catch { throw new RunLinkError(`could not fetch ${what}`); }
  if (!res.ok) throw new RunLinkError(res.status === 404 ? missing : `could not fetch ${what} (HTTP ${res.status})`);
  if (res.redirected || (res.url && res.url !== url)) throw new RunLinkError(`${what} was redirected`);
  // (`isHtml`: the file asked for is a page itself, an app's index.html; its sha256 is what proves it)
  if (!isHtml && /html/i.test(res.headers.get('content-type') ?? '')) throw new RunLinkError(missing);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max) throw new RunLinkError(`${what} is too large`);
  return bytes;
}

/**
 * A file from a raw-content host (raw.githubusercontent.com, gist.githubusercontent.com),
 * exactly the one asked for: no cookies, no referrer, no redirect followed, and
 * never an HTML page standing in for it.
 */
export async function fetchRaw(url: string, fetchFn: Fetch, max: number, what: string, missing: string): Promise<Uint8Array> {
  let res: Response;
  try { res = await fetchFn(url, { redirect: 'error', credentials: 'omit', cache: 'no-cache', referrerPolicy: 'no-referrer' }); } catch { throw new RunLinkError(`could not fetch ${what}`); }
  if (!res.ok) throw new RunLinkError(res.status === 404 ? missing : `could not fetch ${what} (HTTP ${res.status})`);
  if (res.redirected || (res.url && res.url !== url)) throw new RunLinkError(`${what} was redirected`);
  if (/html/i.test(res.headers.get('content-type') ?? '')) throw new RunLinkError(`${what} is a web page, not a file`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > max) throw new RunLinkError(`${what} is too large`);
  return bytes;
}

/** The account a gist belongs to (GitHub's API): only its login is used, and only if it is a plain name */
async function gistOwner(id: string, fetchFn: Fetch): Promise<string> {
  const bytes = await fetchRaw(`https://api.github.com/gists/${id}`, fetchFn, 4 << 20, `gist ${id}`, `gist ${id} does not exist`);
  let login: unknown;
  try { login = (JSON.parse(new TextDecoder().decode(bytes)) as { owner?: { login?: unknown } })?.owner?.login; } catch { login = undefined; }
  if (typeof login !== 'string' || !GH_OWNER.test(login)) throw new RunLinkError(`gist ${id} has no owner to fetch it from: use gist:<user>/<id>`);
  return login;
}

/**
 * Fetch the script a link names and decide whether it is curated. A recipe
 * is curated only when this origin's /recipes/index.json lists its name with
 * the sha256 of the bytes /recipes/<name>.sh returned.
 */
export async function loadScript(target: RunTarget, origin: string, fetchFn: Fetch): Promise<LoadedScript> {
  if (target.kind === 'lab') throw new RunLinkError('a lab: link has no script');
  if (target.kind === 'recipe') {
    // (parseRunUrl made the name; checked again here because the URL is built from it)
    if (!RECIPE_NAME.test(target.name) || RESERVED_NAME.test(target.name)) throw new RunLinkError('no such recipe');
    const url = `${origin}/recipes/${target.name}.sh`;
    let index: { recipes?: RecipeIndexEntry[] };
    const listBytes = await fetchSiteFile(`${origin}/recipes/index.json`, fetchFn, 1 << 20, 'the recipe list', 'this site has no recipe list');
    try { index = JSON.parse(new TextDecoder().decode(listBytes)); } catch { throw new RunLinkError('could not read the recipe list'); }
    const entry = Array.isArray(index?.recipes) ? index.recipes.find((r) => r && r.name === target.name) : undefined;
    if (!entry || typeof entry.sha256 !== 'string') throw new RunLinkError('no such recipe');
    const bytes = await fetchSiteFile(url, fetchFn, CURATED_MAX, 'the recipe', 'no such recipe');
    const sha256 = await sha256Hex(bytes);
    if (sha256 !== entry.sha256.toLowerCase()) throw new RunLinkError('the recipe does not match the recipe list (reload and try again)');
    const text = scriptText(bytes);
    if (!text.startsWith('#!')) throw new RunLinkError('no such recipe');
    return { name: target.name, curated: true, text, sha256, from: `${origin.replace(/^https?:\/\//, '')}/recipes/${target.name}.sh`, header: parseRecipeHeader(text) };
  }
  let bytes: Uint8Array;
  let from: string;
  if (target.kind === 'gh') {
    // HEAD: the repository's default branch
    const url = `https://raw.githubusercontent.com/${target.owner}/${target.repo}/HEAD/${target.path}`;
    from = `github.com/${target.owner}/${target.repo}, ${target.path}`;
    let res: Response;
    try { res = await fetchFn(url, { redirect: 'error', credentials: 'omit', cache: 'no-cache', referrerPolicy: 'no-referrer' }); } catch { throw new RunLinkError(`could not fetch ${from}`); }
    if (!res.ok) throw new RunLinkError(res.status === 404 ? `${from} does not exist (or the repository is private)` : `could not fetch ${from} (HTTP ${res.status})`);
    bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > SCRIPT_MAX) throw new RunLinkError('the script is too long');
  } else if (target.kind === 'gist') {
    // (parseRunUrl made these; checked again because the URLs are built from them)
    if (!GIST_ID.test(target.id) || (target.user && !GH_OWNER.test(target.user)) || (target.file && (!GH_SEGMENT.test(target.file) || target.file === '.' || target.file === '..'))) throw new RunLinkError('no such gist');
    let user = target.user;
    if (!user) user = await gistOwner(target.id, fetchFn);
    from = `gist.github.com/${user}/${target.id}, ${target.file || 'its first file'}`;
    bytes = await fetchRaw(`https://gist.githubusercontent.com/${user}/${target.id}/raw${target.file ? `/${target.file}` : ''}`, fetchFn, SCRIPT_MAX, from, `${from} does not exist (or the gist is secret and the link has no user)`);
  } else {
    bytes = target.bytes;
    from = 'the link itself';
  }
  const text = scriptText(bytes);
  const sha256 = await sha256Hex(bytes);
  const name = target.kind === 'sh' ? `sh-${sha256.slice(0, 12)}` : target.name;
  return { name, curated: false, text, sha256, from, header: parseRecipeHeader(text) };
}

export interface StartOptions {
  name: string; curated: boolean; from: string; sha256: string;
  onOpen?: string;
  /** The script already finished here: only its on-open line runs */
  done: boolean;
  ignored: string[];
}

/** The marker a finished script leaves in its directory */
export const doneMarker = (sha256: string): string => `.done-${sha256.slice(0, 16)}`;

/**
 * The file the Terminal sources (`. ~/run/<name>/.run-link`): one line saying
 * what runs and from where, the script in a subshell of tabcomputer's shell
 * (so `toolchain`, `gui`, `open` are there in Debian mode too), the marker,
 * then the on-open line in the Terminal's own shell (its `cd` stays).
 */
export function startScript(o: StartOptions): string {
  const what = `${o.curated ? 'recipe' : 'script'} ${o.name} (${plain(o.from)})`;
  const lines = ['# Written by a run link (docs/RUN_LINKS.md); the Terminal it opened sources this file.', `cd ~/run/${o.name} || return 1`];
  lines.push(`echo ${shq(o.done ? `${what} is already set up here` : `running ${what}`)}`);
  if (o.ignored.length) lines.push(`echo ${shq(`run link: ignored ${o.ignored.map((k) => plain(k, 32)).join(', ')} (not in its "# args:" header)`)}`);
  if (!o.done) {
    lines.push(
      `( . ./${SCRIPT_FILE} )`,
      '__run_status=$?',
      'if [ "$__run_status" -ne 0 ]; then',
      `  echo "run link: it stopped with status $__run_status. Run it again with: . ~/run/${o.name}/${START_FILE}"`,
      '  unset __run_status',
      '  return 1',
      'fi',
      'unset __run_status',
      `touch ${doneMarker(o.sha256)}`,
    );
  }
  if (o.onOpen) lines.push(o.onOpen);
  return lines.join('\n') + '\n';
}

export interface RunPromptInfo {
  name: string; from: string; script: string;
  /** RUN_* variables the link sets */
  env: Record<string, string>;
  ignored: string[];
  dir: string;
  /** It already ran here: Run only does this line */
  onOpenOnly?: string;
  /**
   * A link that is not a script (src/inbound-link.ts: a shared seed, a
   * repository): the prompt's own words. `script` is then what its box shows.
   */
  wording?: RunPromptWording;
}

export interface RunPromptWording {
  /** The window's title and the question */
  window: string; title: string;
  /** What is at stake, in place of the script's warning */
  warn: string;
  /** Under the box, in place of where the script runs */
  where: string;
  /** The box's label and the button that agrees */
  box: string; action: string;
}

export interface RunLinkDeps {
  search: string;
  origin: string;
  home: string;
  /** The page is inside another page's frame */
  framed: boolean;
  fetch: Fetch;
  fs: {
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
    writeFile(path: string, data: string): Promise<unknown>;
    exists(path: string): Promise<boolean>;
    /** Lab links read a clone's .git/config to see whose repository a folder holds */
    readFile?(path: string, encoding: 'utf8'): Promise<unknown>;
  };
  /** Drop the run link from the address (history.replaceState) */
  cleanUrl(): void;
  /** Resolves once the page has put back its saved windows (they take the focus and redraw the terminal) */
  ready?(): Promise<void>;
  /** Show a script that isn't curated; true only when the person chose Run */
  confirm(info: RunPromptInfo): Promise<boolean>;
  /** A new Terminal in `cwd` with `env` set, typing `command` */
  openTerminal(opts: { cwd: string; command: string; env: Record<string, string>; title: string }): void;
  /** Tell the person why a link didn't run */
  report(message: string): void;
}

export type RunOutcome = 'none' | 'ran' | 'on-open' | 'cancelled' | 'refused';

/** The `owner/repo` on github.com that a clone's .git/config names as origin, lower-cased; '' when it has none */
export function originRepo(gitConfig: string): string {
  let inOrigin = false;
  for (const line of gitConfig.split('\n')) {
    const section = /^\s*\[(.*)\]\s*$/.exec(line);
    if (section) { inOrigin = /^remote\s+"origin"$/.test(section[1].trim()); continue; }
    const url = inOrigin ? /^\s*url\s*=\s*(\S+)\s*$/.exec(line)?.[1] : undefined;
    const m = url ? /^(?:https?:\/\/(?:[^@/\s]+@)?(?:www\.)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url) : null;
    if (m) return `${m[1]}/${m[2]}`.toLowerCase();
  }
  return '';
}

/**
 * Where a lab link's repository lives: `~/src/<repo>`, or `~/src/<owner>/<repo>`
 * when that name already holds something else (the Git app's clones go to the
 * same places). `cloned` when the folder is a clone of that repository.
 */
export async function labFolder(fs: RunLinkDeps['fs'], home: string, owner: string, repo: string): Promise<{ dir: string; cloned: boolean }> {
  const want = `${owner}/${repo}`.toLowerCase();
  const candidates = [`${home}/src/${repo}`, `${home}/src/${owner}/${repo}`];
  let free = '';
  for (const dir of candidates) {
    if (!(await fs.exists(dir).catch(() => false))) { free ||= dir; continue; }
    const config = await fs.readFile?.(`${dir}/.git/config`, 'utf8').catch(() => '');
    if (typeof config === 'string' && originRepo(config) === want) return { dir, cloned: true };
  }
  if (!free) throw new RunLinkError(`${candidates[0].replace(home, '~')} and ${candidates[1].replace(home, '~')} both hold something else: move one away, then open the link again`);
  return { dir: free, cloned: false };
}

/** The prompt for a lab link that has to clone: what opening does, as lines (none of the repository's own text is in it) */
export function labPrompt(owner: string, repo: string, dir: string, home: string): RunPromptInfo {
  const short = dir.startsWith(home + '/') ? '~' + dir.slice(home.length) : dir;
  return {
    name: `lab-${owner}-${repo}`, from: `github.com/${owner}/${repo}`, env: {}, ignored: [], dir,
    script: [
      'gh auth login          only if the repository is private and this tab is not signed in to GitHub',
      `git clone https://github.com/${owner}/${repo} ${short}`,
      'toolchain install …    the sets .tabcomputer/lab.json names, if it names any',
      `code ${short}`,
    ].join('\n') + '\n',
    wording: {
      window: 'Open a class repository',
      title: `Open ${owner}/${repo}?`,
      warn: 'The repository is copied into this tab and opened in the Code app. Nothing in it runs until you press Run or Test, or run it in the Terminal. Those commands run as you: they can read the files here and use the accounts this tab is signed in to. Open it only if it is your class repository.',
      where: `The folder is ${short}. Submit in the Code app pushes it back to GitHub.`,
      box: 'What opening it does',
      action: 'Open',
    },
  };
}

/** A lab link (`?run=lab:owner/repo`): ask before the first clone, then `lab open` in a new Terminal */
async function handleLabLink(target: Extract<RunTarget, { kind: 'lab' }>, params: Record<string, string>, deps: RunLinkDeps): Promise<RunOutcome> {
  const { owner, repo } = target;
  const { dir, cloned } = await labFolder(deps.fs, deps.home, owner, repo);
  // A folder that is already a clone of it: nothing is fetched and nothing runs, so there is nothing to ask
  if (!cloned && !(await deps.confirm(labPrompt(owner, repo, dir, deps.home)))) return 'cancelled';
  const ignored = Object.keys(params);
  if (ignored.length) deps.report(`ignored ${ignored.map((k) => plain(k, 32)).join(', ')} (a lab link takes no arguments)`);
  // owner and repo are [A-Za-z0-9._-] (parseRunUrl), so this line needs no quoting
  deps.openTerminal({ cwd: deps.home, command: `lab open ${owner}/${repo}`, env: {}, title: `${owner}/${repo}` });
  return cloned ? 'on-open' : 'ran';
}

/** Handle the page's run link, if it has one. Never throws. */
export async function handleRunLink(deps: RunLinkDeps): Promise<RunOutcome> {
  let parsed: ParsedRun | null;
  try {
    try { parsed = parseRunUrl(deps.search); } finally { if (new URLSearchParams(deps.search).has('run')) deps.cleanUrl(); }
    await deps.ready?.();
    if (!parsed) return 'none';
    if (deps.framed) throw new RunLinkError('run links are ignored inside a frame; open the link in its own tab');
    if (parsed.target.kind === 'lab') return await handleLabLink(parsed.target, parsed.params, deps);
    const script = await loadScript(parsed.target, deps.origin, deps.fetch);
    const { env, ignored } = runEnv(parsed.params, script.header);
    const dir = `${deps.home}/run/${script.name}`;
    const done = await deps.fs.exists(`${dir}/${doneMarker(script.sha256)}`);
    const onOpen = script.header['on-open'];
    if (!script.curated) {
      const ok = await deps.confirm({ name: script.name, from: script.from, script: script.text, env, ignored, dir, onOpenOnly: done ? onOpen ?? '' : undefined });
      if (!ok) return 'cancelled';
    }
    await deps.fs.mkdir(dir, { recursive: true });
    await deps.fs.writeFile(`${dir}/${SCRIPT_FILE}`, script.text);
    await deps.fs.writeFile(`${dir}/${START_FILE}`, startScript({ name: script.name, curated: script.curated, from: script.from, sha256: script.sha256, onOpen, done, ignored }));
    // The name is [a-z0-9-] (parseRunUrl, loadScript), so this line needs no quoting
    deps.openTerminal({ cwd: dir, command: `. ~/run/${script.name}/${START_FILE}`, env, title: script.curated ? plain(script.header.title ?? script.name, 60) : script.name });
    return done ? 'on-open' : 'ran';
  } catch (e) {
    await deps.ready?.().catch(() => {});
    deps.report(e instanceof RunLinkError ? e.message : 'it failed to start');
    if (!(e instanceof RunLinkError)) console.warn('[run-link]', e);
    return 'refused';
  }
}
