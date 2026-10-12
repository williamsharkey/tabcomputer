/**
 * Installed apps (docs/APPS.md "Installing"): each is a folder
 * `~/Apps/<id>/` holding the app's files, listed in
 * `/var/lib/tabcomputer/apps.json` with where it came from. Its data lives
 * apart, in `~/.local/share/apps/<id>/`, and survives a reinstall.
 *
 * No DOM here: the `app` command, the desktop's dock (src/apps/window.ts)
 * and tests use it with any filesystem object.
 */
import { MANIFEST_FILE, MANIFEST_MAX, ManifestError, parseManifest, expandHome, type AppManifest } from './manifest';

export const REGISTRY_FILE = '/var/lib/tabcomputer/apps.json';
export const ICON_MAX = 256 << 10;
/** Limits on an app fetched from somewhere else */
export const FETCHED_FILES_MAX = 400;
export const FETCHED_BYTES_MAX = 32 << 20;

export interface InstalledApp {
  id: string;
  name: string;
  version: string;
  /** Its folder: ~/Apps/<id> */
  dir: string;
  /**
   * Where it came from: `dir:/path`, `site` (shipped by this site),
   * `gh:owner/repo[/path]@<commit>`, `url:https://…`, `template:<name>`, `script:<file>`
   */
  source: string;
  installedAt: number;
  /** The icon as a data: URL (the dock shows it before any file is read), or '' */
  icon: string;
  /** Open it in a guest instead of here (`app install --guest`) */
  guest?: string;
}

export interface Registry { v: 1; apps: Record<string, InstalledApp> }

export interface RegistryFs {
  readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<unknown>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ type: string; size: number; isDirectory(): boolean }>;
  lstat(path: string): Promise<{ type: string; size: number; isDirectory(): boolean }>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  exists(path: string): Promise<boolean>;
  readlink?(path: string): Promise<string>;
  symlink?(target: string, path: string): Promise<unknown>;
  chmod?(path: string, mode: number): Promise<unknown>;
}

/** Why an install, open or removal did not happen: a sentence for the person */
export class AppError extends Error {
  constructor(message: string) { super(message); this.name = 'AppError'; }
}

export const appsDir = (home: string): string => `${home}/Apps`;
export const appDir = (home: string, id: string): string => `${home}/Apps/${id}`;
export const appDataDir = (home: string, id: string): string => `${home}/.local/share/apps/${id}`;

export async function readRegistry(fs: RegistryFs): Promise<Registry> {
  try {
    const j = JSON.parse((await fs.readFile(REGISTRY_FILE, 'utf8')) as string);
    if (j && typeof j === 'object' && j.apps && typeof j.apps === 'object') {
      const apps: Record<string, InstalledApp> = {};
      for (const [id, a] of Object.entries(j.apps as Record<string, InstalledApp>)) {
        if (a && typeof a === 'object' && a.id === id && typeof a.dir === 'string') apps[id] = a;
      }
      return { v: 1, apps };
    }
  } catch { /* none yet, or unreadable: start empty */ }
  return { v: 1, apps: {} };
}

async function writeRegistry(fs: RegistryFs, reg: Registry): Promise<void> {
  await fs.mkdir(REGISTRY_FILE.slice(0, REGISTRY_FILE.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(REGISTRY_FILE, JSON.stringify(reg, null, 1) + '\n');
}

export async function listInstalled(fs: RegistryFs): Promise<InstalledApp[]> {
  return Object.values((await readRegistry(fs)).apps).sort((a, b) => a.installedAt - b.installedAt);
}

export async function findInstalled(fs: RegistryFs, id: string): Promise<InstalledApp | null> {
  return (await readRegistry(fs)).apps[id] ?? null;
}

/** The manifest of the app in `dir`, with the files it names checked. Throws ManifestError or AppError. */
export async function loadManifest(fs: RegistryFs, dir: string): Promise<AppManifest> {
  const file = `${dir}/${MANIFEST_FILE}`;
  let bytes: Uint8Array | string;
  try {
    const st = await fs.stat(file);
    if (st.size > MANIFEST_MAX) throw new ManifestError([`it is larger than ${MANIFEST_MAX >> 10} KB`]);
    bytes = await fs.readFile(file);
  } catch (e) {
    if (e instanceof ManifestError) throw e;
    throw new AppError(`${dir} has no ${MANIFEST_FILE}: it is not an app (app new NAME makes one)`);
  }
  const m = parseManifest(bytes);
  const problems: string[] = [];
  if (m.entry) {
    const p = m.entry === '.' ? dir : `${dir}/${m.entry}`;
    const st = await fs.stat(p).catch(() => null);
    if (!st) problems.push(`entry ${JSON.stringify(m.entry)} does not exist in ${dir}`);
    else if (st.isDirectory()) { if (!await fs.exists(`${p}/index.html`)) problems.push(`entry ${JSON.stringify(m.entry)} is a folder without an index.html`); }
    else if (!/\.html?$/i.test(m.entry)) problems.push(`entry ${JSON.stringify(m.entry)} must be a folder or an .html file`);
  }
  if (m.icon) {
    const st = await fs.stat(`${dir}/${m.icon}`).catch(() => null);
    if (!st || st.isDirectory()) problems.push(`icon ${JSON.stringify(m.icon)} does not exist in ${dir}`);
    else if (st.size > ICON_MAX) problems.push(`icon ${JSON.stringify(m.icon)} is larger than ${ICON_MAX >> 10} KB`);
  }
  if (problems.length) throw new ManifestError(problems);
  return m;
}

const ICON_TYPES: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

/** The app's icon as a data: URL ('' without one). An <img> draws it, so an SVG's scripts never run. */
export async function iconDataUrl(fs: RegistryFs, dir: string, m: AppManifest): Promise<string> {
  if (!m.icon) return '';
  try {
    const bytes = (await fs.readFile(`${dir}/${m.icon}`)) as Uint8Array;
    if (bytes.length > ICON_MAX) return '';
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${ICON_TYPES[m.icon.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream'};base64,${btoa(bin)}`;
  } catch { return ''; }
}

/** Folders never copied into an installed app */
const SKIP = new Set(['.git', '.DS_Store']);

async function copyTree(fs: RegistryFs, from: string, to: string): Promise<number> {
  let n = 0;
  await fs.mkdir(to, { recursive: true });
  for (const name of await fs.readdir(from)) {
    if (SKIP.has(name)) continue;
    const src = `${from}/${name}`, dst = `${to}/${name}`;
    const st = await fs.lstat(src);
    if (st.type === 'symlink') {
      // (a link is kept as a link: node_modules/.bin; where it points is not followed here)
      if (fs.readlink && fs.symlink) { await fs.symlink(await fs.readlink(src), dst).catch(() => {}); n++; }
    } else if (st.isDirectory()) n += await copyTree(fs, src, dst);
    else {
      await fs.writeFile(dst, (await fs.readFile(src)) as Uint8Array);
      const mode = (st as { mode?: number }).mode;
      if (fs.chmod && mode !== undefined && (mode & 0o111)) await fs.chmod(dst, mode & 0o777).catch(() => {});
      n++;
    }
  }
  return n;
}

export interface InstallOptions {
  home: string;
  source: string;
  /** Is this id something else's (a built-in app's)? */
  taken?(id: string): boolean;
  guest?: string;
  now?: number;
}

async function register(fs: RegistryFs, m: AppManifest, dir: string, o: InstallOptions): Promise<InstalledApp> {
  const reg = await readRegistry(fs);
  const app: InstalledApp = {
    id: m.id, name: m.name, version: m.version, dir, source: o.source, installedAt: o.now ?? Date.now(),
    icon: await iconDataUrl(fs, dir, m), ...(o.guest ? { guest: o.guest } : {}),
  };
  reg.apps[m.id] = app;
  await writeRegistry(fs, reg);
  await fs.mkdir(appDataDir(o.home, m.id), { recursive: true });
  return app;
}

/**
 * Install the app in the folder `src`: its files are copied to ~/Apps/<id>
 * (replacing an earlier install of that id; its data folder is kept).
 */
export async function installFromDir(fs: RegistryFs, src: string, o: InstallOptions): Promise<{ app: InstalledApp; manifest: AppManifest; files: number; replaced: boolean }> {
  const m = await loadManifest(fs, src);
  if (o.taken?.(m.id)) throw new AppError(`the id ${m.id} belongs to an app that is built in: pick another id in ${MANIFEST_FILE}`);
  const dir = appDir(o.home, m.id);
  const replaced = await fs.exists(dir);
  let files = 0;
  if (src !== dir) {
    if (src.startsWith(dir + '/') || dir.startsWith(src + '/')) throw new AppError(`${src} and ${dir} are inside one another`);
    // Copied beside it first: a failed copy leaves the installed app as it was
    const staging = `${dir}.installing`;
    await fs.rm(staging, { recursive: true }).catch(() => {});
    try { files = await copyTree(fs, src, staging); } catch (e) { await fs.rm(staging, { recursive: true }).catch(() => {}); throw e; }
    if (replaced) await fs.rm(dir, { recursive: true });
    await renameDir(fs, staging, dir);
  }
  return { app: await register(fs, m, dir, o), manifest: m, files, replaced };
}

async function renameDir(fs: RegistryFs, from: string, to: string): Promise<void> {
  const rename = (fs as unknown as { rename?: (a: string, b: string) => Promise<unknown> }).rename;
  if (rename) { await rename.call(fs, from, to); return; }
  await copyTree(fs, from, to);
  await fs.rm(from, { recursive: true });
}

/**
 * Install an app from files already in hand (a site's curated app, a
 * repository's, an archive's): relative path → bytes, `app.json` among them.
 */
export async function installFromFiles(fs: RegistryFs, files: Map<string, Uint8Array>, o: InstallOptions): Promise<{ app: InstalledApp; manifest: AppManifest; files: number; replaced: boolean }> {
  const text = files.get(MANIFEST_FILE);
  if (!text) throw new AppError(`there is no ${MANIFEST_FILE} among the app's files`);
  const m = parseManifest(text);
  if (o.taken?.(m.id)) throw new AppError(`the id ${m.id} belongs to an app that is built in`);
  let total = 0;
  for (const b of files.values()) total += b.length;
  if (files.size > FETCHED_FILES_MAX || total > FETCHED_BYTES_MAX) throw new AppError(`the app is too large to install from here (${files.size} files, ${(total / 1e6).toFixed(1)} MB; the limits are ${FETCHED_FILES_MAX} files and ${FETCHED_BYTES_MAX >> 20} MB)`);
  const dir = appDir(o.home, m.id);
  const staging = `${dir}.installing`;
  await fs.rm(staging, { recursive: true }).catch(() => {});
  for (const [rel, bytes] of files) {
    // (the callers made these names; checked again because they become paths)
    if (!rel || rel.startsWith('/') || rel.split('/').some((s) => !s || s === '.' || s === '..') || /[\x00-\x1f\x7f\\]/.test(rel)) throw new AppError(`the app has a file with a name that is not a plain path: ${JSON.stringify(rel.slice(0, 80))}`);
    const p = `${staging}/${rel}`;
    await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(p, bytes);
  }
  try { await loadManifest(fs, staging); } catch (e) { await fs.rm(staging, { recursive: true }).catch(() => {}); throw e; }
  const replaced = await fs.exists(dir);
  if (replaced) await fs.rm(dir, { recursive: true });
  await renameDir(fs, staging, dir);
  return { app: await register(fs, m, dir, o), manifest: m, files: files.size, replaced };
}

/** Forget an app and delete its folder; `data: true` deletes its data folder too. False: no such app. */
export async function removeInstalled(fs: RegistryFs, id: string, o: { home: string; data?: boolean }): Promise<boolean> {
  const reg = await readRegistry(fs);
  const app = reg.apps[id];
  if (!app) return false;
  delete reg.apps[id];
  await writeRegistry(fs, reg);
  // Only ever a folder under ~/Apps: the registry is a file anyone can edit
  if (app.dir === appDir(o.home, id)) await fs.rm(app.dir, { recursive: true }).catch(() => {});
  if (o.data) await fs.rm(appDataDir(o.home, id), { recursive: true }).catch(() => {});
  return true;
}

/** The absolute form of one of a manifest's `files` entries */
export function expectedPath(entry: string, dir: string, home: string): { path: string; folder: boolean } {
  const folder = entry.endsWith('/');
  const p = folder ? entry.slice(0, -1) : entry;
  return { path: p.startsWith('/') || p.startsWith('~') ? expandHome(p, home) : `${dir}/${p}`, folder };
}
