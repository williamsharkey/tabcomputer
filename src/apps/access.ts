/**
 * Which paths an app's page may reach through tab.js (docs/APPS.md "What is
 * confined"): the manifest's `access.fs` folders, the app's data folder, and
 * its own folder read only. Every path the page names is resolved here, on
 * the host side: `..` is folded first, then symbolic links are followed with
 * the filesystem's own `realpath`, and the real path must still be inside an
 * allowed folder. A link that points out of the allowed folders, and a link
 * to nothing, are refused.
 *
 * This confines the page's own file calls. It does not confine a program the
 * page starts with tab.run, nor the app's backend: those are ordinary
 * processes of the profile.
 */

export interface AccessRoot { path: string; mode: 'read' | 'write' }

export type AccessCode = 'EACCES' | 'EINVAL' | 'ENOENT' | 'ENOSYS' | 'EEXIST' | 'EIO';

/** A refused or failed request; `code` and `message` go back to the page */
export class AccessError extends Error {
  constructor(readonly code: AccessCode, message: string) {
    super(message);
    this.name = 'AccessError';
  }
}

export interface AccessFs {
  lstat(path: string): Promise<unknown>;
  realpath(path: string): Promise<string>;
}

/** `/a/./b/../c` → `/a/c`. The path must be absolute. */
export function normalizePath(path: string): string {
  if (typeof path !== 'string' || !path.startsWith('/')) throw new AccessError('EINVAL', 'a path must be absolute');
  if (/[\x00-\x1f\x7f]/.test(path)) throw new AccessError('EINVAL', 'a path may not have control characters');
  if (path.length > 4096) throw new AccessError('EINVAL', 'the path is too long');
  const out: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  return '/' + out.join('/');
}

/** A path as the page gives it: absolute, `~/…`, or relative to `base` */
export function pagePath(path: unknown, home: string, base: string): string {
  if (typeof path !== 'string' || !path) throw new AccessError('EINVAL', 'a path is needed');
  const abs = path === '~' ? home : path.startsWith('~/') ? home + path.slice(1) : path.startsWith('/') ? path : `${base}/${path}`;
  return normalizePath(abs);
}

export const within = (path: string, root: string): boolean => path === root || root === '/' || path.startsWith(root + '/');

/**
 * Where `path` really is: the real path of its deepest existing part, plus
 * the rest (which does not exist yet). A link whose target is missing is
 * refused: writing through it would create a file wherever it points.
 */
export async function realOf(fs: AccessFs, path: string): Promise<string> {
  const parts = path.split('/').filter(Boolean);
  for (let n = parts.length; n >= 0; n--) {
    const head = '/' + parts.slice(0, n).join('/');
    const there = n === 0 ? true : await fs.lstat(head).then(() => true, () => false);
    if (!there) continue;
    let real: string;
    try { real = n === 0 ? '/' : await fs.realpath(head); } catch { throw new AccessError('EACCES', `${head} is a link to nothing`); }
    const rest = parts.slice(n);
    return rest.length ? (real === '/' ? '' : real) + '/' + rest.join('/') : real;
  }
  return path;
}

export interface Allowed {
  /** The path to use: links resolved */
  real: string;
  root: AccessRoot;
}

/**
 * The real path of `path` when the app may `want` it, else AccessError
 * (EACCES). `nofollow`: the last name is taken as it is (removing or renaming
 * a link acts on the link).
 */
export async function resolveAllowed(fs: AccessFs, roots: AccessRoot[], path: string, want: 'read' | 'write', opts: { nofollow?: boolean } = {}): Promise<Allowed> {
  const p = normalizePath(path);
  const usable = roots.filter((r) => want === 'read' || r.mode === 'write');
  const lexical = roots.filter((r) => within(p, r.path));
  if (!lexical.length) throw new AccessError('EACCES', `${p} is outside the folders this app may use`);
  if (!lexical.some((r) => usable.includes(r))) throw new AccessError('EACCES', `${p} is read only for this app`);
  let real: string;
  if (opts.nofollow && p !== '/') {
    const at = p.lastIndexOf('/');
    const dir = await realOf(fs, p.slice(0, at) || '/');
    real = (dir === '/' ? '' : dir) + p.slice(at);
  } else real = await realOf(fs, p);
  for (const r of usable) {
    const rootReal = await realOf(fs, r.path).catch(() => r.path);
    if (within(real, rootReal)) return { real, root: r };
  }
  throw new AccessError('EACCES', `${p} leads outside the folders this app may use (a link)`);
}

/** A name for a file inside a folder the page chose: no path tricks, no hidden control characters */
export function safeRelPath(rel: unknown): string {
  if (typeof rel !== 'string') throw new AccessError('EINVAL', 'a file name is needed');
  const parts = rel.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.' && s !== '..').map((s) => s.replace(/[\x00-\x1f\x7f]/g, '_'));
  if (!parts.length || parts.join('/').length > 1024) throw new AccessError('EINVAL', 'a file name is needed');
  return parts.join('/');
}
