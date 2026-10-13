/**
 * App manifests (docs/APPS.md): `app.json` in an app's folder says what the
 * app is (id, name, icon, window), what its page is (`entry`), what runs
 * behind it (`backend`), what it needs before its first start (`toolchains`,
 * `files`, `needs`) and what its page may ask the tab for (`access`). An app
 * with `run`, `fields` or `table` has no page of its own: tabcomputer supplies
 * it, and derives its `access` (declare.ts).
 *
 * Validation is strict: an unknown key, a wrong type or a path that climbs
 * out of the app's folder is an error, and every problem found is reported,
 * each with the key it is about. Nothing here touches the DOM or the
 * filesystem: the `app` command, the desktop, the Code app and tests all
 * parse manifests through this one module.
 */

import { KIND_KEYS, KIND_WINDOW, NO_KIND, kindOf, kindSentences, validateKind, type KindKeys } from './declare';

/** The manifest format this build reads */
export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = 'app.json';
/** Largest app.json read (bytes) */
export const MANIFEST_MAX = 64 << 10;

export interface AppWindow {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  /** More than one window at a time (default: asking again focuses the one that is open) */
  multiple: boolean;
}

export interface AppBackend {
  /** A shell line run in the app's folder, with PORT (and APP_ID, APP_DIR, APP_DATA) set */
  start: string;
  /** The port it listens on; 'auto' picks a free one and passes it as $PORT */
  port: number | 'auto';
  /** A path that answers 2xx once the backend is ready (default: the port being open is enough) */
  health: { path: string; timeout: number } | null;
  /** Start on the page's first request to it instead of when the window opens */
  lazy: boolean;
  /** Keep running after the last window closes (until `app stop` or the tab closes) */
  keepAlive: boolean;
}

export interface AccessFolder {
  /** Absolute, or under `~` (the person's home) */
  path: string;
  mode: 'read' | 'write';
}

export interface AppAccess {
  /** Folders tab.fs, tab.files and tab.download may reach, beside the app's own data folder */
  fs: AccessFolder[];
  /** The page may reach other sites (false: a Content-Security-Policy keeps its requests on its own origin) */
  network: boolean;
  /** Programs `tab.run([name, ...args])` may start */
  commands: string[];
  /** `tab.run('a shell line')` is allowed: pipes, redirects, anything a shell does */
  shell: boolean;
}

export interface AppManifest extends KindKeys {
  manifest: number;
  id: string;
  name: string;
  description: string;
  version: string;
  /** Path of the icon in the app's folder (svg, png, jpg, webp), or '' */
  icon: string;
  window: AppWindow;
  /** A directory (its index.html) or an .html file in the app's folder; '' when the backend serves the page */
  entry: string;
  backend: AppBackend | null;
  /** Sets `toolchain install` applies before the first start */
  toolchains: string[];
  /** Paths that must exist before it starts; one ending in `/` is a folder that is made */
  files: string[];
  /** Debian packages installed before the first start */
  needs: string[];
  access: AppAccess;
}

/** What the place an app.json was found in says, for the keys it leaves out */
export interface ManifestHint {
  /** A name to make the id from: the folder's, the repository's (else the app's own `name` is used) */
  id?: string;
  /** The page found beside it, when it names none: '.' (index.html) or 'public' */
  page?: string;
}

/** A manifest that can't be used: every problem, one per line in `message` */
export class ManifestError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.map((p) => `${MANIFEST_FILE}: ${p}`).join('\n'));
    this.name = 'ManifestError';
  }
}

export const APP_ID = /^[a-z][a-z0-9-]{1,31}$/;
/** Ids the desktop's own apps and the site's routes use */
export const RESERVED_IDS = new Set([
  'terminal', 'files', 'settings', 'browser', 'activity', 'about', 'dataflow', 'preview', 'apps', 'git', 'code', 'run-link', 'app', 'studio', 'link', 'app-share',
  'api', 'oauth', 'offer', 'answer', 'git-proxy', 'channel', 'assets', 'guest', 'browse', 'tcp', 'relay', 'debian', 'claude-releases', 'recipes', 's',
]);

const CONTROL = /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\u061c\ufeff]/;
const ICON_EXT = /\.(svg|png|jpe?g|webp)$/i;
const TOOLCHAIN = /^[a-z][a-z0-9-]{0,31}$/;
const COMMAND = /^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,63}$/;

/**
 * A Debian package's name, or a toolchain set's (`needs: ["c"]`, runtime.ts): a set may have one letter.
 * It ends in a letter, a digit or `+`, as server.mjs's PACKAGE_NAME does: to apt, `name-` means "remove name".
 */
export const PACKAGE = /^[a-z0-9](?:[a-z0-9+.-]{0,61}[a-z0-9+])?$/;

/** Keys every app may have; a page app also has PAGE_KEYS, a declared one its kind's (declare.ts) */
const COMMON_KEYS = ['manifest', 'id', 'name', 'about', 'description', 'version', 'icon', 'window', 'toolchains', 'needs'];
const PAGE_KEYS = ['entry', 'backend', 'files', 'access'];
const WINDOW_KEYS = ['width', 'height', 'minWidth', 'minHeight', 'resizable', 'multiple'];
const BACKEND_KEYS = ['start', 'port', 'health', 'lazy', 'keepAlive'];
const ACCESS_KEYS = ['fs', 'network', 'commands', 'shell'];

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const show = (v: unknown): string => {
  const s = typeof v === 'string' ? JSON.stringify(v) : v === undefined ? 'nothing' : JSON.stringify(v) ?? String(v);
  return s.length > 60 ? s.slice(0, 57) + '…' : s;
};

/** A path inside the app's folder: relative, no `..`, no backslash; '' when it isn't one */
export function cleanRelPath(p: string): string {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.startsWith('~') || /[\\:]/.test(p) || CONTROL.test(p)) return '';
  const parts = p.split('/').filter((s) => s && s !== '.');
  if (!parts.length || parts.some((s) => s === '..')) return '';
  return parts.join('/');
}

/** An absolute path, or one under `~`, normalized; '' when it isn't one (or climbs with `..`) */
export function cleanAbsPath(p: string): string {
  if (typeof p !== 'string' || !p || p.includes('\\') || CONTROL.test(p)) return '';
  const home = p === '~' || p.startsWith('~/');
  if (!home && !p.startsWith('/')) return '';
  const parts = (home ? p.slice(1) : p).split('/').filter((s) => s && s !== '.');
  if (parts.some((s) => s === '..')) return '';
  return (home ? '~' : '') + (parts.length ? '/' + parts.join('/') : home ? '' : '/');
}

/** A name someone typed, as an app id: "My Notes!" → "my-notes"; '' when nothing usable is left */
export function idFromName(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return APP_ID.test(id) && !RESERVED_IDS.has(id) ? id : '';
}

/** `~/x` → `/home/user/x` */
export const expandHome = (p: string, home: string): string => (p === '~' ? home : p.startsWith('~/') ? home + p.slice(1) : p);

/**
 * Check a parsed app.json and fill in its defaults. Throws ManifestError with
 * every problem found.
 */
export function validateManifest(raw: unknown, hint: ManifestHint = {}): AppManifest {
  const problems: string[] = [];
  const bad = (msg: string) => { problems.push(msg); };
  if (!isObject(raw)) throw new ManifestError(['it must be a JSON object']);
  const unknown = (obj: Record<string, unknown>, keys: string[], where: string) => {
    for (const k of Object.keys(obj)) if (!keys.includes(k)) bad(`unknown key ${where}${k} (known: ${keys.join(', ')})`);
  };
  const kind = kindOf(raw);
  const topKeys = [...COMMON_KEYS, ...(kind === 'page' ? PAGE_KEYS : KIND_KEYS[kind])];
  for (const k of Object.keys(raw)) if (!topKeys.includes(k) && !PAGE_KEYS.includes(k)) bad(`unknown key ${k} (known: ${topKeys.join(', ')})`);
  const lead = kind === 'table' ? 'table' : kind === 'form' ? 'fields' : 'run';
  if (kind !== 'page') for (const k of PAGE_KEYS) if (raw[k] !== undefined) bad(`${k} does not go with ${lead}: tabcomputer supplies the page of an app that has ${lead}, and works out what it may use`);

  // manifest version
  const v = raw.manifest ?? MANIFEST_VERSION;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) bad(`manifest must be the format version, a whole number (got ${show(v)})`);
  else if (v > MANIFEST_VERSION) bad(`manifest is ${v}, and this tabcomputer reads up to ${MANIFEST_VERSION}: update tabcomputer, or the app`);

  // id, name
  const name = raw.name;
  const nameOk = typeof name === 'string' && !!name.trim() && name.length <= 60 && !CONTROL.test(name) && !/[<>]/.test(name);
  if (!nameOk) bad(`name ${name === undefined ? 'is missing' : 'must be 1 to 60 characters, without control characters, < or >'} (got ${show(name)})`);
  // Left out, the id comes from where the app was found (its folder, its repository), else from its name
  const id = raw.id ?? (idFromName(hint.id ?? '') || (nameOk ? idFromName(name as string) : ''));
  if (raw.id === undefined && !id) { if (nameOk) bad(`id is missing, and neither the folder nor the name ${show(name)} makes one: add an id (a-z, 0-9 and -)`); }
  else if (typeof id !== 'string' || !APP_ID.test(id)) bad(`id must be 2 to 32 of a-z, 0-9 and -, starting with a letter (got ${show(id)})`);
  else if (RESERVED_IDS.has(id)) bad(`id ${show(id)} is taken by tabcomputer itself`);
  const text = (key: string, max: number): string => {
    const t = raw[key];
    if (t === undefined) return '';
    if (typeof t !== 'string' || t.length > max || CONTROL.test(t.replace(/\n/g, ' '))) { bad(`${key} must be text of at most ${max} characters (got ${show(t)})`); return ''; }
    return t;
  };
  if (raw.about !== undefined && raw.description !== undefined) bad('about and description are the same thing: give one');
  const description = raw.about !== undefined ? text('about', 300) : text('description', 300);
  const version = text('version', 40);

  // icon
  let icon = '';
  if (raw.icon !== undefined) {
    icon = typeof raw.icon === 'string' ? cleanRelPath(raw.icon) : '';
    if (!icon) bad(`icon must be a path inside the app's folder (got ${show(raw.icon)})`);
    else if (!ICON_EXT.test(icon)) bad(`icon must be an .svg, .png, .jpg or .webp file (got ${show(raw.icon)})`);
  }

  // window
  const window: AppWindow = { ...KIND_WINDOW[kind], minWidth: 280, minHeight: 200, resizable: true, multiple: false };
  if (raw.window !== undefined) {
    if (!isObject(raw.window)) bad(`window must be an object (got ${show(raw.window)})`);
    else {
      const w = raw.window;
      unknown(w, WINDOW_KEYS, 'window.');
      for (const k of ['width', 'height', 'minWidth', 'minHeight'] as const) {
        if (w[k] === undefined) continue;
        if (typeof w[k] !== 'number' || !Number.isFinite(w[k]) || (w[k] as number) < 120 || (w[k] as number) > 10000) bad(`window.${k} must be a number from 120 to 10000 (got ${show(w[k])})`);
        else window[k] = Math.round(w[k] as number);
      }
      for (const k of ['resizable', 'multiple'] as const) {
        if (w[k] === undefined) continue;
        if (typeof w[k] !== 'boolean') bad(`window.${k} must be true or false (got ${show(w[k])})`);
        else window[k] = w[k] as boolean;
      }
      if (w.minWidth === undefined) window.minWidth = Math.min(window.minWidth, window.width);
      if (w.minHeight === undefined) window.minHeight = Math.min(window.minHeight, window.height);
      if (window.minWidth > window.width) bad(`window.minWidth (${window.minWidth}) is larger than window.width (${window.width})`);
      if (window.minHeight > window.height) bad(`window.minHeight (${window.minHeight}) is larger than window.height (${window.height})`);
    }
  }

  // backend
  let backend: AppBackend | null = null;
  if (raw.backend !== undefined && raw.backend !== null) {
    if (!isObject(raw.backend)) bad(`backend must be an object (got ${show(raw.backend)})`);
    else {
      const b = raw.backend;
      unknown(b, BACKEND_KEYS, 'backend.');
      backend = { start: '', port: 'auto', health: null, lazy: false, keepAlive: false };
      if (typeof b.start !== 'string' || !b.start.trim() || b.start.length > 2000 || CONTROL.test(b.start)) bad(`backend.start must be the command that starts it, one line (got ${show(b.start)})`);
      else backend.start = b.start.trim();
      if (b.port === undefined || b.port === 'auto') backend.port = 'auto';
      else if (typeof b.port !== 'number' || !Number.isInteger(b.port) || b.port < 1024 || b.port > 65535) bad(`backend.port must be "auto" or a port from 1024 to 65535 (got ${show(b.port)}); a unix socket is not supported`);
      else backend.port = b.port;
      if (b.health !== undefined && b.health !== null) {
        const h = typeof b.health === 'string' ? { path: b.health } : b.health;
        if (!isObject(h)) bad(`backend.health must be a path, or { "path", "timeout" } (got ${show(b.health)})`);
        else {
          for (const k of Object.keys(h)) if (k !== 'path' && k !== 'timeout') bad(`unknown key backend.health.${k} (known: path, timeout)`);
          const path = h.path;
          const timeout = h.timeout === undefined ? 20 : h.timeout;
          if (typeof path !== 'string' || !path.startsWith('/') || path.length > 200 || CONTROL.test(path) || /\s/.test(path)) bad(`backend.health.path must be a path starting with / (got ${show(path)})`);
          else if (typeof timeout !== 'number' || !Number.isFinite(timeout) || timeout <= 0 || timeout > 600) bad(`backend.health.timeout must be seconds, from 1 to 600 (got ${show(h.timeout)})`);
          else backend.health = { path, timeout };
        }
      }
      for (const k of ['lazy', 'keepAlive'] as const) {
        if (b[k] === undefined) continue;
        if (typeof b[k] !== 'boolean') bad(`backend.${k} must be true or false (got ${show(b[k])})`);
        else backend[k] = b[k] as boolean;
      }
    }
  }

  // the kind's own keys (an app without a page of its own)
  const declared = kind === 'page' ? { ...NO_KIND, commands: [] as string[] } : validateKind(raw, kind, bad);

  // entry
  let entry = '';
  if (kind !== 'page') { /* tabcomputer's page */ }
  else if (raw.entry === undefined && !backend && hint.page) entry = hint.page;
  else if (raw.entry !== undefined) {
    entry = typeof raw.entry === 'string' ? (raw.entry === '.' || raw.entry === './' ? '.' : cleanRelPath(raw.entry)) : '';
    if (!entry) bad(`entry must be a folder or an .html file inside the app's folder (got ${show(raw.entry)})`);
  } else if (!backend) bad('entry is missing: the folder (its index.html) or .html file that is the app\'s page. Or give run, fields or table, and tabcomputer supplies the page');
  if (backend?.lazy && !entry) bad('backend.lazy needs an entry: something has to serve the page before the backend starts');

  // toolchains, files
  const list = (key: string, check: (s: string) => string, what: string, max: number): string[] => {
    const a = raw[key];
    if (a === undefined) return [];
    if (!Array.isArray(a)) { bad(`${key} must be a list (got ${show(a)})`); return []; }
    if (a.length > max) bad(`${key} has ${a.length} entries; at most ${max}`);
    const out: string[] = [];
    for (const [i, s] of a.entries()) {
      const c = typeof s === 'string' ? check(s) : '';
      if (!c) bad(`${key}[${i}] must be ${what} (got ${show(s)})`);
      else if (!out.includes(c)) out.push(c);
    }
    return out;
  };
  const toolchains = list('toolchains', (s) => (TOOLCHAIN.test(s) ? s : ''), 'the name of a toolchain set (toolchain list)', 16);
  const needs = list('needs', (s) => (PACKAGE.test(s) ? s : ''), 'the name of a Debian package', 16);
  const files = list('files', (s) => {
    const dir = s.endsWith('/') && s.length > 1;
    const p = cleanAbsPath(s) || cleanRelPath(s);
    return p && p !== '/' && p !== '~' ? p + (dir ? '/' : '') : '';
  }, 'a path: absolute, under ~, or inside the app\'s folder', 64);

  // access
  const access: AppAccess = { fs: [], network: false, commands: declared.commands, shell: declared.shell };
  if (kind === 'page' && raw.access !== undefined) {
    if (!isObject(raw.access)) bad(`access must be an object (got ${show(raw.access)})`);
    else {
      const a = raw.access;
      unknown(a, ACCESS_KEYS, 'access.');
      if (a.fs !== undefined) {
        if (!Array.isArray(a.fs)) bad(`access.fs must be a list of folders (got ${show(a.fs)})`);
        else {
          if (a.fs.length > 32) bad(`access.fs has ${a.fs.length} entries; at most 32`);
          for (const [i, f] of a.fs.entries()) {
            const o = typeof f === 'string' ? { path: f } : f;
            if (!isObject(o)) { bad(`access.fs[${i}] must be a folder, or { "path", "mode" } (got ${show(f)})`); continue; }
            for (const k of Object.keys(o)) if (k !== 'path' && k !== 'mode') bad(`unknown key access.fs[${i}].${k} (known: path, mode)`);
            const path = typeof o.path === 'string' ? cleanAbsPath(o.path) : '';
            const mode = o.mode === undefined ? 'write' : o.mode;
            if (!path) bad(`access.fs[${i}] must be an absolute folder or one under ~, without .. (got ${show(o.path)})`);
            else if (path === '/') bad('access.fs may not be / (the whole filesystem): name the folders the app needs');
            else if (mode !== 'read' && mode !== 'write') bad(`access.fs[${i}].mode must be "read" or "write" (got ${show(o.mode)})`);
            else if (!access.fs.some((x) => x.path === path)) access.fs.push({ path, mode });
          }
        }
      }
      for (const k of ['network', 'shell'] as const) {
        if (a[k] === undefined) continue;
        if (typeof a[k] !== 'boolean') bad(`access.${k} must be true or false (got ${show(a[k])})`);
        else access[k] = a[k] as boolean;
      }
      if (a.commands !== undefined) {
        if (!Array.isArray(a.commands)) bad(`access.commands must be a list of program names (got ${show(a.commands)})`);
        else {
          if (a.commands.length > 128) bad(`access.commands has ${a.commands.length} entries; at most 128`);
          for (const [i, c] of a.commands.entries()) {
            if (typeof c !== 'string' || !COMMAND.test(c)) bad(`access.commands[${i}] must be a program's name, without a path or arguments (got ${show(c)})`);
            else if (!access.commands.includes(c)) access.commands.push(c);
          }
        }
      }
    }
  }

  if (problems.length) throw new ManifestError(problems);
  return {
    manifest: v as number, id: id as string, name: (name as string).trim(), description, version, icon,
    window, entry, backend, toolchains, files, needs, access, ...(({ commands: _c, ...k }) => k)(declared),
  };
}

/** Parse the text of an app.json. Throws ManifestError. */
export function parseManifest(text: string | Uint8Array, hint: ManifestHint = {}): AppManifest {
  let s: string;
  if (typeof text === 'string') s = text;
  else {
    if (text.length > MANIFEST_MAX) throw new ManifestError([`it is larger than ${MANIFEST_MAX >> 10} KB`]);
    try { s = new TextDecoder('utf-8', { fatal: true }).decode(text); } catch { throw new ManifestError(['it is not UTF-8 text']); }
  }
  if (s.length > MANIFEST_MAX) throw new ManifestError([`it is larger than ${MANIFEST_MAX >> 10} KB`]);
  let raw: unknown;
  try { raw = JSON.parse(s.replace(/^\ufeff/, '')); } catch (e) { throw new ManifestError([`it is not valid JSON (${(e as Error).message})`]); }
  return validateManifest(raw, hint);
}

/** The manifest as app.json text (what `app new` writes): defaults left out */
export function manifestText(m: Partial<AppManifest> & { id: string; name: string }): string {
  const out: Record<string, unknown> = { manifest: MANIFEST_VERSION, id: m.id, name: m.name };
  if (m.description) out.description = m.description;
  if (m.version) out.version = m.version;
  if (m.icon) out.icon = m.icon;
  if (m.window) out.window = m.window;
  if (m.entry) out.entry = m.entry;
  if (m.backend) {
    const b = m.backend;
    out.backend = { start: b.start, port: b.port, ...(b.health ? { health: b.health.path } : {}), ...(b.lazy ? { lazy: true } : {}), ...(b.keepAlive ? { keepAlive: true } : {}) };
  }
  if (m.toolchains?.length) out.toolchains = m.toolchains;
  if (m.files?.length) out.files = m.files;
  if (m.access) {
    const a = m.access;
    out.access = {
      fs: a.fs.map((f) => (f.mode === 'write' ? f.path : { path: f.path, mode: f.mode })),
      network: a.network,
      ...(a.commands.length ? { commands: a.commands } : {}),
      ...(a.shell ? { shell: true } : {}),
    };
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/** One section of what an app asks for, in words (the install prompt, `app list -l`) */
export interface AccessLine { label: string; text: string; warn?: boolean }

/**
 * What a manifest asks for, in plain sentences: what it will run and what its
 * page may touch. The install prompt shows exactly these lines.
 */
export function describeManifest(m: AppManifest): AccessLine[] {
  // A declared app reads as sentences (declare.ts); the first is its own description, shown apart
  if (m.kind !== 'page') return manifestSentences(m).slice(m.description ? 1 : 0).map((text) => ({ label: '', text, warn: / runs this /.test(text) }));
  const lines: AccessLine[] = [];
  if (m.backend) {
    lines.push({
      label: 'Runs', warn: true,
      text: `${m.backend.start}  (a program in this tab, started when the app opens${m.backend.keepAlive ? ' and kept running after its window closes' : ''}; it can read and change every file here and use the tab's sign-ins)`,
    });
  } else lines.push({ label: 'Runs', text: 'nothing in the background: the app is a page' });
  const installs = [m.toolchains.length ? `toolchain ${m.toolchains.join(', ')}` : '', m.needs.join(', ')].filter(Boolean);
  if (installs.length) lines.push({ label: 'Installs', text: `${installs.join('; ')} (Debian packages, before its first start)` });
  if (m.access.shell) lines.push({ label: 'Commands', warn: true, text: 'any shell command (the page can then do everything a terminal here can)' });
  else if (m.access.commands.length) lines.push({ label: 'Commands', warn: true, text: `${m.access.commands.join(', ')}  (each is an ordinary program: what it is given, it can read and write)` });
  else lines.push({ label: 'Commands', text: 'none' });
  const folders = m.access.fs.map((f) => `${f.path}${f.mode === 'read' ? ' (read only)' : ''}`);
  const whole = m.access.fs.some((f) => f.path === '~' || f.path === '/home/user' || f.path === '/home');
  lines.push({ label: 'Files', warn: whole, text: folders.length ? `${folders.join(', ')}, and its own data folder${whole ? '  (your whole home folder, sign-ins included)' : ''}` : 'only its own data folder' });
  lines.push({ label: 'Network', warn: m.access.network, text: m.access.network ? 'its page may reach other sites' : 'its page is kept from other sites' });
  if (m.files.length) lines.push({ label: 'Expects', text: m.files.join(', ') });
  return lines;
}

/** A declared app (run, fields or table) as the sentences a person reads before installing it; [] for an app with its own page */
export function manifestSentences(m: AppManifest): string[] {
  return m.kind === 'page' ? [] : kindSentences(m);
}
