/**
 * An app with its data as one file (docs/APPS.md "Export and import",
 * tabcomputer#138): a zip that holds
 *
 *   tabcomputer-app.json   a small header: the app's id, name, where it came from, when
 *   app/…                  the app's files (~/Apps/<id>)
 *   data/…                 its data folder (~/.local/share/apps/<id>)
 *
 * A tab keeps an app's data in one browser, so this file is how the data
 * reaches another machine, and how it survives the browser clearing its
 * storage. `app share` is the other thing: a link to the app, never its data.
 *
 * Here: making the file, reading one back (every name checked, since the
 * file comes from anywhere), what an import would replace, and the mark an
 * app shows when its data changed since the last export. No DOM: the
 * questions are asked by the callers (install.ts, prompt.ts).
 */
import { zipFiles, unzipFiles } from '../commands/zip';
import { APP_ID, MANIFEST_FILE } from './manifest';
import { AppError, FETCHED_BYTES_MAX, FETCHED_FILES_MAX, appDataDir, type InstalledApp, type RegistryFs } from './registry';
import { collectAppFiles } from './share';

export const EXPORT_HEADER = 'tabcomputer-app.json';
export const EXPORT_SUFFIX = '.app.zip';
/** When each app was last exported, by id. Kept outside the data folders: it is not the app's data, and it outlives a removed app. */
export const BACKUPS_FILE = '/var/lib/tabcomputer/app-backups.json';
/** The most data an export carries */
export const DATA_FILES_MAX = 10_000;
export const DATA_BYTES_MAX = 512 << 20;

export interface ExportHeader {
  format: 1;
  id: string;
  name: string;
  version: string;
  /** The registry's `source` of the exported copy: `site`, `gh:…@commit`, `dir:…`, … */
  source: string;
  /** ISO time */
  exported: string;
}

export interface DataFile { rel: string; size: number; mtime: number }

interface StatFs extends RegistryFs {
  stat(path: string): Promise<{ type: string; size: number; mtime?: Date; isDirectory(): boolean }>;
  lstat(path: string): Promise<{ type: string; size: number; mtime?: Date; isDirectory(): boolean }>;
}

/**
 * What in a data folder is not the person's data: the record of installed
 * programs, and the inputs and results a supplied page keeps until it is
 * next opened (`declared`: the app is its manifest).
 */
const notData = (rel: string, declared: boolean): boolean => rel === '.toolchains' || (declared && /^(in|out)(\/|$)/.test(rel));

const SAFE_REL = /^[^\x00-\x1f\x7f\\/]+(\/[^\x00-\x1f\x7f\\/]+)*$/;
const relOk = (rel: string): boolean => SAFE_REL.test(rel) && rel.length <= 1024 && !rel.split('/').some((s) => s === '.' || s === '..');

/** The files of an app's data folder: names, sizes and times, no contents */
export async function dataFiles(fs: RegistryFs, home: string, id: string, declared: boolean): Promise<DataFile[]> {
  const root = appDataDir(home, id);
  const out: DataFile[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const name of (await fs.readdir(dir).catch(() => [] as string[])).sort()) {
      const rel = prefix + name;
      if (notData(rel, declared)) continue;
      const st = await (fs as StatFs).lstat(`${dir}/${name}`).catch(() => null);
      if (!st || st.type === 'symlink') continue;
      if (st.isDirectory()) await walk(`${dir}/${name}`, `${rel}/`);
      else out.push({ rel, size: st.size, mtime: st.mtime?.getTime() ?? 0 });
    }
  };
  await walk(root, '');
  return out;
}

async function backups(fs: RegistryFs): Promise<Record<string, number>> {
  try {
    const j = JSON.parse((await fs.readFile(BACKUPS_FILE, 'utf8')) as string);
    return j && typeof j === 'object' && !Array.isArray(j) ? j as Record<string, number> : {};
  } catch { return {}; }
}

/** When `id` was last exported or imported (its data then was in a file), or 0 */
export async function lastExport(fs: RegistryFs, id: string): Promise<number> {
  const at = (await backups(fs))[id];
  return typeof at === 'number' && Number.isFinite(at) ? at : 0;
}

/** Called with an app's id when it was exported or imported (its window takes its mark away) */
export const exportListeners = new Set<(id: string) => void>();

export async function noteExported(fs: RegistryFs, id: string, at: number): Promise<void> {
  const all = await backups(fs);
  all[id] = at;
  await fs.mkdir(BACKUPS_FILE.slice(0, BACKUPS_FILE.lastIndexOf('/')), { recursive: true });
  await fs.writeFile(BACKUPS_FILE, JSON.stringify(all) + '\n');
  for (const cb of [...exportListeners]) { try { cb(id); } catch { /* a window that went away */ } }
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/** A moment as a person says it looking back from `now`: "14:05" today, "Tuesday" this week, "3 October" before */
export function sinceText(at: number, now: number): string {
  const d = new Date(at), n = new Date(now);
  const days = Math.round((new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 86_400_000);
  if (days <= 0) return clock(d);
  if (days < 7) return DAYS[d.getDay()];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${d.getFullYear() === n.getFullYear() ? '' : ` ${d.getFullYear()}`}`;
}
/** The same in a sentence: "today at 14:05", "on Tuesday", "on 3 October" */
export function whenText(at: number, now: number): string {
  const s = sinceText(at, now);
  return /^\d\d:\d\d$/.test(s) ? `today at ${s}` : `on ${s}`;
}

/**
 * What an app's window says when its data is in no file: '' (nothing to
 * say: no data, or none changed since the last export), "Not backed up", or
 * "Not backed up since Tuesday" (the day of the last export).
 */
export async function backupMark(fs: RegistryFs, home: string, id: string, declared: boolean, now = Date.now()): Promise<string> {
  const files = await dataFiles(fs, home, id, declared);
  if (!files.length) return '';
  const last = await lastExport(fs, id);
  if (!last) return 'Not backed up';
  return files.some((f) => f.mtime > last) ? `Not backed up since ${sinceText(last, now)}` : '';
}

export interface AppExport { name: string; bytes: Uint8Array; header: ExportHeader; appFiles: number; dataFiles: number }

/** The export of an installed app: its files and its data in one zip, named `<id>-<date>.app.zip` */
export async function exportApp(fs: RegistryFs, app: InstalledApp, home: string, declared: boolean, now = Date.now()): Promise<AppExport> {
  const files = await collectAppFiles(fs, app.dir);
  if (!files.has(MANIFEST_FILE)) throw new AppError(`${app.name} has no ${MANIFEST_FILE} in ${app.dir}`);
  const data = await dataFiles(fs, home, app.id, declared);
  let total = 0;
  for (const f of data) total += f.size;
  if (data.length > DATA_FILES_MAX || total > DATA_BYTES_MAX) throw new AppError(`${app.name} has more data than one file carries (${data.length} files, ${Math.ceil(total / 1e6)} MB; the limits are ${DATA_FILES_MAX.toLocaleString('en')} files and ${DATA_BYTES_MAX >> 20} MB)`);
  const d = new Date(now);
  const header: ExportHeader = { format: 1, id: app.id, name: app.name, version: app.version, source: app.source, exported: d.toISOString() };
  const members: { name: string; bytes: Uint8Array; mtime: number }[] = [{ name: EXPORT_HEADER, bytes: new TextEncoder().encode(JSON.stringify(header, null, 2) + '\n'), mtime: now }];
  for (const [rel, bytes] of files) members.push({ name: `app/${rel}`, bytes, mtime: now });
  const root = appDataDir(home, app.id);
  for (const f of data) members.push({ name: `data/${f.rel}`, bytes: (await fs.readFile(`${root}/${f.rel}`)) as Uint8Array, mtime: f.mtime || now });
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return { name: `${app.id}-${day}${EXPORT_SUFFIX}`, bytes: await zipFiles(members), header, appFiles: files.size, dataFiles: data.length };
}

export interface ReadExport { header: ExportHeader; app: Map<string, Uint8Array>; data: Map<string, Uint8Array>; exportedAt: number }

/** Is this a zip with an export's header in it? (a dropped file: anything else is left to whatever else takes drops) */
export function looksLikeExport(bytes: Uint8Array): boolean {
  if (bytes.length < 30 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
  // (the header is the first member, so its name is right behind the first local header)
  return new TextDecoder().decode(bytes.subarray(30, 30 + EXPORT_HEADER.length)) === EXPORT_HEADER;
}

/** The app and data an export file holds. Throws AppError, in a sentence, for anything that is not one. */
export async function readExport(bytes: Uint8Array): Promise<ReadExport> {
  const not = 'the file is not an app exported from tabcomputer';
  let files: Map<string, Uint8Array> | null;
  try { files = await unzipFiles(bytes, { files: FETCHED_FILES_MAX + DATA_FILES_MAX + 1, bytes: FETCHED_BYTES_MAX + DATA_BYTES_MAX }); } catch (e) { throw new AppError(`the file cannot be read: ${(e as Error).message}`); }
  const head = files?.get(EXPORT_HEADER);
  if (!files || !head) throw new AppError(not);
  let header: ExportHeader;
  try { header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(head)); } catch { throw new AppError(not); }
  if (!header || typeof header !== 'object') throw new AppError(not);
  if (header.format !== 1) throw new AppError('the file was made by a newer tabcomputer than this one');
  if (typeof header.id !== 'string' || !APP_ID.test(header.id) || typeof header.name !== 'string' || typeof header.source !== 'string') throw new AppError(not);
  const app = new Map<string, Uint8Array>(), data = new Map<string, Uint8Array>();
  for (const [name, b] of files) {
    if (name === EXPORT_HEADER) continue;
    const at = name.indexOf('/');
    const part = name.slice(0, at), rel = name.slice(at + 1);
    if ((part !== 'app' && part !== 'data') || !relOk(rel)) throw new AppError(`the file holds something that is not a plain path (${JSON.stringify(name.slice(0, 80))})`);
    (part === 'app' ? app : data).set(rel, b);
  }
  if (!app.has(MANIFEST_FILE)) throw new AppError(`the file holds no ${MANIFEST_FILE}: it is not an app`);
  if (app.size > FETCHED_FILES_MAX) throw new AppError('the app in the file has too many files');
  // (which programs are installed here is this tab's to know, never a file's to say)
  data.delete('.toolchains');
  const exportedAt = Date.parse(String(header.exported));
  return { header: { format: 1, id: header.id, name: header.name.slice(0, 60), version: String(header.version ?? ''), source: header.source.slice(0, 300), exported: String(header.exported ?? '') }, app, data, exportedAt: Number.isFinite(exportedAt) ? exportedAt : 0 };
}

export interface ReplacePlan {
  /** Data files here that the import would change or remove, newest first */
  replaced: DataFile[];
  /** Data files here that the file holds byte for byte */
  same: number;
}

/**
 * What importing `data` would do to the data `id` has here. Nothing to ask
 * when `replaced` is empty: there is no data here, or it is what the file
 * holds.
 */
export async function replacePlan(fs: RegistryFs, home: string, id: string, declared: boolean, data: Map<string, Uint8Array>): Promise<ReplacePlan> {
  const root = appDataDir(home, id);
  const replaced: DataFile[] = [];
  let same = 0;
  for (const f of await dataFiles(fs, home, id, declared)) {
    const theirs = data.get(f.rel);
    const mine = theirs && theirs.length === f.size ? (await fs.readFile(`${root}/${f.rel}`)) as Uint8Array : null;
    if (mine && theirs && mine.every((b, i) => b === theirs[i])) same++; else replaced.push(f);
  }
  replaced.sort((a, b) => b.mtime - a.mtime);
  return { replaced, same };
}

/** Make the data folder of `id` what the export holds: the data that was there goes, what the file holds is written */
export async function restoreData(fs: RegistryFs, home: string, id: string, declared: boolean, data: Map<string, Uint8Array>): Promise<void> {
  const root = appDataDir(home, id);
  for (const f of await dataFiles(fs, home, id, declared)) if (!data.has(f.rel)) await fs.rm(`${root}/${f.rel}`).catch(() => {});
  await fs.mkdir(root, { recursive: true });
  for (const [rel, bytes] of data) {
    if (notData(rel, declared)) continue;
    const p = `${root}/${rel}`;
    await fs.mkdir(p.slice(0, p.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(p, bytes);
  }
}

/** Are the files of the app installed in `dir` exactly these? */
export async function sameApp(fs: RegistryFs, dir: string, files: Map<string, Uint8Array>): Promise<boolean> {
  const mine = await collectAppFiles(fs, dir).catch(() => null);
  if (!mine || mine.size !== files.size) return false;
  for (const [rel, bytes] of files) {
    const b = mine.get(rel);
    if (!b || b.length !== bytes.length || !b.every((x, i) => x === bytes[i])) return false;
  }
  return true;
}
