/**
 * Sharing an installed app as a link (`app share ID`, docs/APPS.md "Sharing"):
 * what the link is, and the sentences the share screen and the terminal say.
 *
 *   an app this site ships       ?app=<id>
 *   an app from GitHub           ?app=gh:<owner>/<repo>[/<path>]
 *   an app from a gist           ?app=gist:<id>
 *   an app that is one app.json  #name=…&run=…   (its keys as words, src/link-fragment.ts)
 *   any other app (a folder, an archive, a link)
 *                                ?app=link#app=<the app's files>
 *
 * The form before the last is used when the app is one file and its link is
 * at most READABLE_MAX characters: a person can read what it runs, and write
 * one like it by hand.
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
import { MANIFEST_FILE, MANIFEST_VERSION, idFromName, validateManifest, type AppManifest } from './manifest';
import { READABLE_MAX, appFragment, manifestFromPairs, pairsFromManifest } from '../link-fragment';
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

/**
 * An app's files as the text a link carries. `id`: the app's id where its
 * app.json leaves it to the folder's name, so the copy made from the link is
 * the same app under the same id.
 */
export async function packApp(files: Map<string, Uint8Array>, id?: string): Promise<string> {
  const t: Record<string, string> = {};
  const b: Record<string, string> = {};
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  for (const [rel, bytes] of [...files].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (!relOk(rel)) throw new AppError(`the app has a file whose name a link cannot carry: ${JSON.stringify(rel.slice(0, 80))}`);
    // Text goes in as text (it compresses better); anything else as base64
    try { t[rel] = utf8.decode(bytes); } catch { b[rel] = b64(bytes); }
  }
  const json = new TextEncoder().encode(JSON.stringify({ v: 1, ...(id ? { id } : {}), t, b }));
  return toUrl(b64(await pipe(json, new CompressionStream('gzip') as never, 64 << 20)));
}

/** The files a link carries. Throws AppError for anything that is not a packed app. */
export async function unpackApp(payload: string): Promise<Map<string, Uint8Array>> {
  return (await unpackLink(payload)).files;
}

/** The files a link carries, and the id it names for an app.json that has none ('' without one) */
export async function unpackLink(payload: string): Promise<{ files: Map<string, Uint8Array>; id: string }> {
  if (!payload || payload.length > SHARE_PAYLOAD_MAX * 2 || !PAYLOAD.test(payload)) throw new AppError('the link does not hold an app (it may have been cut short when it was copied)');
  let doc: { v?: unknown; id?: unknown; t?: unknown; b?: unknown };
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
  // (only a hint: the manifest's own id wins, and what is not an id is ignored where it is used)
  return { files: out, id: typeof doc.id === 'string' ? doc.id.slice(0, 64) : '' };
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
  /** For 'files': the link is the one app.json written out after the `#`, key by key, not packed */
  readable?: boolean;
  /** For 'gh': github.com/<owner>/<repo>[, <path>]; for 'gist': gist.github.com/<id> */
  repo?: string;
  /** Does tabcomputer ask the person who opens the link before it installs? (No only for an app the site ships.) */
  asks: boolean;
}

/**
 * A one-file app as an address a person can read: `#name=…&run=…`, the keys
 * of its app.json. Null when the app has something those keys cannot say,
 * when the pairs would not read back as the same app, or when the address
 * would be longer than READABLE_MAX. `id`: the id the copy must get.
 */
export function readableAppUrl(manifestBytes: Uint8Array, id: string, origin: string): string | null {
  let raw: Record<string, unknown>;
  let want: AppManifest;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes).replace(/^﻿/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    raw = { ...(parsed as Record<string, unknown>) };
    want = validateManifest(raw, { id });
  } catch { return null; }
  if (want.kind === 'page') return null;
  // The format's own number says nothing a reader needs; the id is named only where the name would give another
  if (raw.manifest === MANIFEST_VERSION) delete raw.manifest;
  if (raw.id === undefined && idFromName(want.name) !== id) raw.id = id;
  const pairs = pairsFromManifest(raw);
  if (!pairs) return null;
  const back = manifestFromPairs(pairs);
  if (back.problems.length) return null;
  try { if (JSON.stringify(validateManifest(back.raw)) !== JSON.stringify(want)) return null; } catch { return null; }
  const url = `${origin}/#${appFragment(pairs)}`;
  return url.length <= READABLE_MAX ? url : null;
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
  const readable = files.size === 1 ? readableAppUrl(files.get(MANIFEST_FILE)!, app.id, origin) : null;
  if (readable) return { ...base, kind: 'files', url: readable, files: 1, bytes, readable: true, asks: true };
  let named = false;
  try { named = typeof JSON.parse(new TextDecoder().decode(files.get(MANIFEST_FILE)!)).id === 'string'; } catch { /* not valid: the person who opens the link is told */ }
  const payload = await packApp(files, named ? undefined : app.id);
  if (payload.length > SHARE_PAYLOAD_MAX) {
    throw new AppError(`${app.name} is too large for a link: its ${files.size} files pack to ${Math.ceil(payload.length / 1000)} KB and a link holds ${SHARE_PAYLOAD_MAX / 1000} KB. `
      + `Put its folder in a public GitHub repository and share ${origin}/?app=gh:OWNER/REPO instead`);
  }
  return { ...base, kind: 'files', url: `${origin}/?app=${LINK_APP}#app=${payload}`, files: files.size, bytes, asks: true };
}

const size = (n: number) => (n < 1000 ? `${n} bytes` : n < 1e6 ? `${Math.ceil(n / 1000)} KB` : `${(n / 1e6).toFixed(1)} MB`);

/**
 * What the share screen says, one sentence per fact, the app named once (a
 * long name five times over is a wall of it). The first two are the
 * promise (own copy, own data, nobody sees another's) and are the same for
 * every app; the rest say what the link is and what opening it does.
 */
export function shareStatement(s: AppShare): { promise: string[]; details: string[] } {
  const promise = [
    `Each person who opens this link gets their own copy of ${s.name}, with their own data.`,
    'Nobody sees your data, and you do not see theirs.',
  ];
  const details: string[] = [];
  if (s.kind === 'files') {
    details.push(s.readable
      ? 'The link is the app itself, written after the #. No server stores it.'
      : `The link holds its ${s.files === 1 ? 'file' : `${s.files} files`} (${size(s.bytes ?? 0)}). No server stores ${s.files === 1 ? 'it' : 'them'}.`);
    details.push('A later change here does not reach copies already made. Share a new link for that.');
  } else if (s.kind === 'gh' || s.kind === 'gist') {
    details.push(`The link names ${s.repo}. Each person gets what that ${s.kind === 'gist' ? 'gist' : 'repository'} holds when they open the link.`);
  } else details.push(`This site ships ${s.name}, so it installs without a question.`);
  if (s.asks) details.push('Each person sees what it does before it is installed.');
  return { promise, details };
}

/** The site's origin for a page at `origin`: a guest's page shares the site's link, not its own host's */
export function siteOriginOf(loc: { protocol: string; host: string }, isGuest: boolean): string {
  const host = isGuest ? loc.host.slice(loc.host.indexOf('.') + 1) : loc.host;
  return `${loc.protocol}//${host}`;
}
