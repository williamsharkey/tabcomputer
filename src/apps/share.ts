/**
 * Sharing an installed app as a link (`app share ID`, docs/APPS.md "Sharing"):
 * what the link is, and the sentences the share screen and the terminal say.
 *
 *   an app this site ships       ?app=<id>
 *   an app from GitHub           ?app=gh:<owner>/<repo>[/<path>]
 *   an app from a gist           ?app=gist:<id>
 *   any other app (a folder, an archive, a link)
 *                                ?app=link#app=<the app's files>
 *
 * The last form carries the files themselves, gzipped, after the `#`: a
 * browser never sends that part of an address to a server, so nothing is
 * uploaded and nothing is stored anywhere. It is for small apps (a page and a
 * manifest); a larger one is shared as a repository.
 *
 * A link shares the app, never its data: each person who opens it installs a
 * copy in their own tabcomputer, with a data folder of its own. Opening one
 * goes through the install prompt (links.ts): an app from a link is never
 * curated.
 *
 * No DOM and no filesystem of its own here: the callers pass both.
 */
import { MANIFEST_FILE } from './manifest';
import { AppError, FETCHED_FILES_MAX, type InstalledApp, type RegistryFs } from './registry';

/** `?app=link`: the app's files are in the address, after `#app=` */
export const LINK_APP = 'link';
/** The longest payload a link carries, in characters. Browsers take far longer addresses; mail and chat programs do not. */
export const SHARE_PAYLOAD_MAX = 48_000;
/** The most a payload may unpack to: a link is for a small app */
export const SHARE_UNPACKED_MAX = 4 << 20;
const PAYLOAD = /^[A-Za-z0-9_-]+$/;
const SAFE_REL = /^[A-Za-z0-9._@+ -]+(\/[A-Za-z0-9._@+ -]+)*$/;
const relOk = (rel: string) => SAFE_REL.test(rel) && rel.length <= 300 && !rel.split('/').some((s) => s === '.' || s === '..' || s.startsWith(' ') || s.endsWith(' '));

function b64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function unb64(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const toUrl = (s: string) => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrl = (s: string) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);

/** `bytes` through a compression stream, stopping with an error past `max` bytes of output */
async function pipe(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }, max: number): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const written = writer.write(bytes).then(() => writer.close()).catch(() => {});
  const reader = stream.readable.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) { await reader.cancel().catch(() => {}); throw new AppError('the app in the link is too large'); }
    parts.push(value);
  }
  await written;
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** An app's files as the text a link carries */
export async function packApp(files: Map<string, Uint8Array>): Promise<string> {
  const t: Record<string, string> = {};
  const b: Record<string, string> = {};
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (const [rel, bytes] of [...files].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!relOk(rel)) throw new AppError(`the app has a file whose name a link cannot carry: ${JSON.stringify(rel.slice(0, 80))}`);
    // Text goes in as text (it compresses better); anything else as base64
    try { t[rel] = utf8.decode(bytes); } catch { b[rel] = b64(bytes); }
  }
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, t, b }));
  return toUrl(b64(await pipe(json, new CompressionStream('gzip') as never, 64 << 20)));
}

/** The files a link carries. Throws AppError for anything that is not a packed app. */
export async function unpackApp(payload: string): Promise<Map<string, Uint8Array>> {
  if (!payload || payload.length > SHARE_PAYLOAD_MAX * 2 || !PAYLOAD.test(payload)) throw new AppError('the link does not hold an app (it may have been cut short when it was copied)');
  let doc: { v?: unknown; t?: unknown; b?: unknown };
  try {
    const raw = await pipe(unb64(fromUrl(payload)), new DecompressionStream('gzip') as never, SHARE_UNPACKED_MAX);
    doc = JSON.parse(new TextDecoder().decode(raw));
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError('the link does not hold an app (it may have been cut short when it was copied)');
  }
  if (!doc || doc.v !== 1) throw new AppError('the link was made by a newer tabcomputer than this one');
  const out = new Map<string, Uint8Array>();
  const take = (group: unknown, decode: (s: string) => Uint8Array) => {
    if (group === undefined) return;
    if (!group || typeof group !== 'object' || Array.isArray(group)) throw new AppError('the link does not hold an app');
    for (const [rel, value] of Object.entries(group as Record<string, unknown>)) {
      if (typeof value !== 'string' || !relOk(rel) || out.has(rel)) throw new AppError('the app in the link has a file whose name is not a plain path');
      let bytes: Uint8Array;
      try { bytes = decode(value); } catch { throw new AppError('the link does not hold an app'); }
      out.set(rel, bytes);
    }
  };
  take(doc.t, (s) => new TextEncoder().encode(s));
  take(doc.b, unb64);
  if (!out.has(MANIFEST_FILE)) throw new AppError(`the app in the link has no ${MANIFEST_FILE}`);
  if (out.size > FETCHED_FILES_MAX) throw new AppError('the app in the link has too many files');
  return out;
}

/** Every file of an installed app's folder (links and the repository's own metadata left out) */
export async function collectAppFiles(fs: RegistryFs, dir: string): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  const walk = async (at: string, rel: string): Promise<void> => {
    for (const name of await fs.readdir(at)) {
      if (name === '.git' || name === '.DS_Store') continue;
      const p = `${at}/${name}`;
      const st = await fs.lstat(p);
      if (st.type === 'symlink') continue;
      if (st.isDirectory()) await walk(p, `${rel}${name}/`);
      else {
        if (out.size >= FETCHED_FILES_MAX) throw new AppError(`the app has more than ${FETCHED_FILES_MAX} files`);
        out.set(rel + name, (await fs.readFile(p)) as Uint8Array);
      }
    }
  };
  await walk(dir, '');
  return out;
}

export type ShareKind = 'site' | 'gh' | 'gist' | 'files';

export interface AppShare {
  id: string;
  name: string;
  url: string;
  kind: ShareKind;
  /** For 'files': how many the link carries and their size before packing */
  files?: number;
  bytes?: number;
  /** For 'gh': github.com/<owner>/<repo>[, <path>]; for 'gist': gist.github.com/<id> */
  repo?: string;
  /** Does tabcomputer ask the person who opens the link before it installs? (No only for an app the site ships.) */
  asks: boolean;
}

/** The link for an installed app. `origin` is the site's (not a guest's). */
export async function shareApp(fs: RegistryFs, app: InstalledApp, origin: string): Promise<AppShare> {
  const base = { id: app.id, name: app.name };
  if (app.source === 'site') return { ...base, kind: 'site', url: `${origin}/?app=${app.id}`, asks: false };
  const gh = /^gh:([^@]+)@[0-9a-f]{40}$/.exec(app.source);
  if (gh) {
    const [owner, repo, ...path] = gh[1].split('/');
    return { ...base, kind: 'gh', url: `${origin}/?app=gh:${gh[1]}`, repo: `github.com/${owner}/${repo}${path.length ? `, ${path.join('/')}` : ''}`, asks: true };
  }
  const gist = /^gist:([0-9a-f]{5,40})@[0-9a-f]{40}$/.exec(app.source);
  if (gist) return { ...base, kind: 'gist', url: `${origin}/?app=gist:${gist[1]}`, repo: `gist.github.com/${gist[1]}`, asks: true };
  const files = await collectAppFiles(fs, app.dir);
  if (!files.has(MANIFEST_FILE)) throw new AppError(`${app.name} has no ${MANIFEST_FILE} in ${app.dir}`);
  let bytes = 0;
  for (const b of files.values()) bytes += b.length;
  const payload = await packApp(files);
  if (payload.length > SHARE_PAYLOAD_MAX) {
    throw new AppError(`${app.name} is too large for a link: its ${files.size} files pack to ${Math.ceil(payload.length / 1000)} KB and a link holds ${SHARE_PAYLOAD_MAX / 1000} KB. `
      + `Put its folder in a public GitHub repository and share ${origin}/?app=gh:OWNER/REPO instead`);
  }
  return { ...base, kind: 'files', url: `${origin}/?app=${LINK_APP}#app=${payload}`, files: files.size, bytes, asks: true };
}

const size = (n: number) => (n < 1000 ? `${n} bytes` : n < 1e6 ? `${Math.ceil(n / 1000)} KB` : `${(n / 1e6).toFixed(1)} MB`);

/**
 * What the share screen says, one sentence per fact. The first three are the
 * promise (own copy, own data, nothing shared) and are the same for every app.
 */
export function shareStatement(s: AppShare): { promise: string[]; details: string[] } {
  const promise = [
    `Each person who opens this link gets their own copy of ${s.name}.`,
    'Each copy keeps its own data on that person\'s computer.',
    'Nothing is shared between the copies. Other people do not see your data, and you do not see theirs.',
  ];
  const details: string[] = [];
  if (s.kind === 'files') {
    details.push(`The link holds the app's files (${s.files} ${s.files === 1 ? 'file' : 'files'}, ${size(s.bytes ?? 0)}). The files are in the link itself and are not stored on a server.`);
    details.push(`A change you make to ${s.name} later does not reach copies made from this link. Share a new link for that.`);
  } else if (s.kind === 'gh' || s.kind === 'gist') {
    details.push(`The link names ${s.repo}. Each person gets the files that ${s.kind === 'gist' ? 'gist' : 'repository'} holds when they open the link.`);
  } else details.push(`This site ships ${s.name}. Each person gets the site's copy.`);
  details.push(`The link does not hold the data you stored in ${s.name}.`);
  details.push(s.asks
    ? `tabcomputer shows each person what ${s.name} asks for and installs it only when they choose Install.`
    : `tabcomputer installs ${s.name} without asking, because this site ships it.`);
  return { promise, details };
}

/** The site's origin for a page at `origin`: a guest's page shares the site's link, not its own host's */
export function siteOriginOf(loc: { protocol: string; host: string }, isGuest: boolean): string {
  const host = isGuest ? loc.host.slice(loc.host.indexOf('.') + 1) : loc.host;
  return `${loc.protocol}//${host}`;
}
