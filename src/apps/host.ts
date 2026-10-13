/**
 * The tab's side of tab.js (docs/APPS.md "tab.js"): an app's page reaches the
 * tab only through a MessagePort, and every message on it is one of the
 * operations below, checked against the app's manifest before anything is
 * done. The page sends
 *
 *   { t: 'call', id, op, a }      start an operation
 *   { t: 'cancel', id }           stop one that is running (a command, a watch)
 *
 * and gets back
 *
 *   { t: 'ev', id, e, d }         something it produced so far (output, progress, a change)
 *   { t: 'ok', id, v }            its result
 *   { t: 'err', id, code, message }
 *
 * Nothing in a message is trusted: paths are resolved here (access.ts), a
 * command's program must be in `access.commands`, a toolchain set in
 * `toolchains`. The port, not anything the page says, decides which app is
 * talking: it was handed to that app's frame by the tab.
 *
 * No DOM here. The desktop supplies `HostDeps`; tests supply stand-ins.
 */
import type { AppManifest } from './manifest';
import { firstInstallText, plainInstallLine } from './progress';
import { expandHome } from './manifest';
import { AccessError, pagePath, resolveAllowed, safeRelPath, type AccessRoot } from './access';

export const PROTOCOL_VERSION = 1;
/** Largest single file a page may send or ask for in one message */
export const MESSAGE_FILE_MAX = 512 << 20;

export interface HostStat { type: 'file' | 'dir' | 'symlink'; size: number; mtime: Date; isDirectory(): boolean }
export interface HostFs {
  lstat(path: string): Promise<HostStat>;
  stat(path: string): Promise<HostStat>;
  realpath(path: string): Promise<string>;
  readFile(path: string, encoding?: 'utf8'): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<unknown>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  unlink(path: string): Promise<unknown>;
  rename(from: string, to: string): Promise<unknown>;
  onChange(cb: (event: string, path: string, newPath?: string) => void): () => void;
}

export interface RunHandle { done: Promise<number>; kill(): void }
export interface RunRequest {
  /** A shell line, built by the host: every argument of an argv call is quoted */
  line: string;
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
  onStdout(s: string): void;
  onStderr(s: string): void;
}

export interface HostDeps {
  fs: HostFs;
  home: string;
  /** Run a shell line in a process of its own, output as it is produced */
  run(req: RunRequest): RunHandle;
  /** Hand bytes to the person's real disk (the browser's download) */
  download(name: string, bytes: Uint8Array, type: string): void;
  toolchains: {
    /** Which of `sets` are installed */
    installed(sets: string[]): Promise<Record<string, boolean>>;
    /** Install one set; resolves to the exit status */
    install(set: string, onLine: (line: string) => void): Promise<number>;
  };
  /** The app's window, when it has one */
  window?: { setTitle(title: string): void; resize(width: number, height: number): void; close(): void } | null;
  /** Show a folder or file in Files */
  reveal?(path: string): void;
  /** One line for the app's log (`app dev` shows it) */
  log?(line: string): void;
}

export interface HostApp {
  manifest: AppManifest;
  /** The app's folder */
  dir: string;
  /** Its data folder (always readable and writable by its page) */
  dataDir: string;
  /** The page is on an origin of its own: it has no other way to the tab than this channel */
  confined: boolean;
}

/** What a MessagePort is to the host (tests pass a pair of these) */
export interface PortLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close?(): void;
  start?(): void;
}

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Variables a page may not set for a command it starts */
const ENV_REFUSED = new Set(['PATH', 'HOME', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'IFS', 'BASH_ENV', 'ENV', 'SHELL', 'USER']);

type Send = (e: string, d: unknown, transfer?: Transferable[]) => void;
interface Running { cancel(): void }

/** The folders an app's page may use: its manifest's, its data folder, its own folder read only */
export function accessRoots(app: HostApp, home: string): AccessRoot[] {
  return [
    { path: app.dataDir, mode: 'write' },
    ...app.manifest.access.fs.map((f) => ({ path: expandHome(f.path, home), mode: f.mode })),
    { path: app.dir, mode: 'read' as const },
  ];
}

export class AppHost {
  private roots: AccessRoot[];
  private ports = new Set<PortLike>();
  private batch = 0;

  constructor(readonly app: HostApp, private deps: HostDeps) {
    this.roots = accessRoots(app, deps.home);
  }

  /** Serve a page's port. Returns a function that drops it (its commands and watches stop). */
  connect(port: PortLike): () => void {
    const running = new Map<number, Running>();
    let open = true;
    const post = (msg: unknown, transfer?: Transferable[]) => { if (open) { try { port.postMessage(msg, transfer); } catch { /* the page went away */ } } };
    port.onmessage = (ev) => {
      const m = ev.data as { t?: unknown; id?: unknown; op?: unknown; a?: unknown } | null;
      if (!m || typeof m !== 'object' || typeof m.id !== 'number' || !Number.isFinite(m.id)) return;
      const id = m.id;
      if (m.t === 'cancel') { running.get(id)?.cancel(); return; }
      if (m.t !== 'call' || typeof m.op !== 'string' || running.has(id)) return;
      const args = (m.a && typeof m.a === 'object' ? m.a : {}) as Record<string, unknown>;
      let cancel = () => {};
      running.set(id, { cancel: () => cancel() });
      const send: Send = (e, d, transfer) => post({ t: 'ev', id, e, d }, transfer);
      this.call(m.op, args, send, (fn) => { cancel = fn; }).then(
        (r) => { running.delete(id); post({ t: 'ok', id, v: r?.value }, r?.transfer); },
        (e) => {
          running.delete(id);
          const code = e instanceof AccessError ? e.code : 'EIO';
          const message = String((e as Error)?.message ?? e).slice(0, 500);
          if (code === 'EACCES') this.deps.log?.(`refused: ${m.op} (${message})`);
          post({ t: 'err', id, code, message });
        },
      );
    };
    port.start?.();
    this.ports.add(port);
    return () => {
      if (!open) return;
      open = false;
      this.ports.delete(port);
      for (const r of running.values()) r.cancel();
      running.clear();
      port.onmessage = null;
      try { port.close?.(); } catch { /* closed */ }
    };
  }

  private path(p: unknown, want: 'read' | 'write', nofollow = false) {
    return resolveAllowed(this.deps.fs, this.roots, pagePath(p, this.deps.home, this.app.dataDir), want, { nofollow });
  }

  /** One operation. Exported through connect(); public for tests that call it directly. */
  async call(op: string, a: Record<string, unknown>, send: Send, onCancel: (fn: () => void) => void): Promise<{ value?: unknown; transfer?: Transferable[] } | void> {
    const { fs } = this.deps;
    const { manifest } = this.app;
    switch (op) {
      case 'hello':
        return {
          value: {
            v: PROTOCOL_VERSION, id: manifest.id, name: manifest.name, version: manifest.version, manifest,
            dir: this.app.dir, dataDir: this.app.dataDir, home: this.deps.home, confined: this.app.confined,
          },
        };

      // ── commands ──
      case 'run': return { value: await this.run(a, send, onCancel) };
      case 'commands': {
        const names = (Array.isArray(a.names) ? a.names : manifest.access.commands).filter((n): n is string => typeof n === 'string' && manifest.access.commands.includes(n));
        const have: Record<string, boolean> = {};
        if (!names.length) return { value: have };
        let out = '';
        // (names are checked against the manifest, whose names have no shell characters)
        const h = this.deps.run({
          line: names.map((n) => `command -v ${shq(n)} >/dev/null 2>&1 && echo ${shq(n)}`).join('; ') + '; true',
          cwd: this.app.dataDir, env: {}, onStdout: (s) => { out += s; }, onStderr: () => {},
        });
        onCancel(() => h.kill());
        await h.done;
        const found = new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
        for (const n of names) have[n] = found.has(n);
        return { value: have };
      }

      // ── files ──
      case 'fs.read': {
        const { real } = await this.path(a.path, 'read');
        const st = await fs.stat(real).catch(() => null);
        if (!st) throw new AccessError('ENOENT', `${String(a.path)}: no such file`);
        if (st.isDirectory()) throw new AccessError('EINVAL', `${String(a.path)} is a folder`);
        if (a.as === 'text') return { value: await fs.readFile(real, 'utf8') };
        const bytes = (await fs.readFile(real)) as Uint8Array;
        const buf = bytes.slice().buffer;
        return { value: buf, transfer: [buf] };
      }
      case 'fs.write': {
        const { real } = await this.path(a.path, 'write');
        const data = bytesOrText(a.data);
        await fs.mkdir(real.slice(0, real.lastIndexOf('/')) || '/', { recursive: true });
        await fs.writeFile(real, data);
        return { value: { path: real, size: typeof data === 'string' ? data.length : data.length } };
      }
      case 'fs.list': {
        const { real } = await this.path(a.path, 'read');
        const names = await fs.readdir(real).catch(() => { throw new AccessError('ENOENT', `${String(a.path)}: no such folder`); });
        const out = [];
        for (const name of names.sort()) {
          const st = await fs.lstat(`${real === '/' ? '' : real}/${name}`).catch(() => null);
          if (st) out.push({ name, type: st.type, size: st.size, mtime: st.mtime.getTime() });
        }
        return { value: out };
      }
      case 'fs.stat': {
        const { real } = await this.path(a.path, 'read');
        const st = await fs.stat(real).catch(() => null);
        return { value: st ? { path: real, type: st.type, size: st.size, mtime: st.mtime.getTime() } : null };
      }
      case 'fs.mkdir': {
        const { real } = await this.path(a.path, 'write');
        await fs.mkdir(real, { recursive: true });
        return { value: { path: real } };
      }
      case 'fs.remove': {
        const { real, root } = await this.path(a.path, 'write', true);
        if (real === root.path) throw new AccessError('EACCES', 'an app may not remove one of its folders itself');
        const st = await fs.lstat(real).catch(() => null);
        if (!st) return { value: false };
        if (st.type === 'dir') {
          if (a.recursive !== true) throw new AccessError('EINVAL', `${String(a.path)} is a folder: pass { recursive: true }`);
          await fs.rm(real, { recursive: true });
        } else await fs.unlink(real);
        return { value: true };
      }
      case 'fs.rename': {
        const from = await this.path(a.from, 'write', true);
        const to = await this.path(a.to, 'write', true);
        await fs.rename(from.real, to.real);
        return { value: { path: to.real } };
      }
      case 'fs.watch': {
        const { real } = await this.path(a.path, 'read');
        const off = fs.onChange((event, path, newPath) => {
          if (path === real || path.startsWith(real + '/')) send('change', { event, path });
          else if (newPath && (newPath === real || newPath.startsWith(real + '/'))) send('change', { event, path: newPath });
        });
        send('watching', { path: real });
        // Lasts until the page cancels it or goes away
        await new Promise<void>((resolve) => onCancel(() => { off(); resolve(); }));
        return { value: null };
      }
      case 'files.put': {
        // A dropped or picked file: into a folder the app may write, under a name made safe here
        const dir = a.dir === undefined || a.dir === null ? `${this.app.dataDir}/imports/${this.batchName(a.batch)}` : a.dir;
        const rel = safeRelPath(a.rel);
        const base = await this.path(dir, 'write');
        const { real } = await this.path(`${base.real}/${rel}`, 'write');
        const data = bytesOrText(a.data);
        await fs.mkdir(real.slice(0, real.lastIndexOf('/')), { recursive: true });
        await fs.writeFile(real, data);
        return { value: { path: real, dir: base.real, rel, size: data.length } };
      }
      case 'download': return { value: await this.download(a, onCancel) };
      case 'reveal': {
        const { real } = await this.path(a.path, 'read');
        if (!this.deps.reveal) throw new AccessError('ENOSYS', 'there is no Files app here');
        this.deps.reveal(real);
        return { value: null };
      }

      // ── toolchains ──
      case 'toolchain.status':
      case 'toolchain.ensure': {
        const sets = (Array.isArray(a.sets) ? a.sets : manifest.toolchains).filter((s): s is string => typeof s === 'string');
        const undeclared = sets.filter((s) => !manifest.toolchains.includes(s));
        if (undeclared.length) throw new AccessError('EACCES', `this app's manifest does not list the toolchain ${undeclared.join(', ')}`);
        const have = await this.deps.toolchains.installed(sets);
        if (op === 'toolchain.status') return { value: have };
        const installed: string[] = [];
        for (const set of sets) {
          if (have[set]) continue;
          // `text` is the sentence for a person (progress.ts); `line` is the installer's own output
          let text = firstInstallText(manifest.name);
          send('progress', { set, line: `Installing ${set}…`, text });
          const code = await this.deps.toolchains.install(set, (line) => { text = plainInstallLine(line) ?? text; send('progress', { set, line, text }); });
          if (code !== 0) throw new AccessError('EIO', `toolchain install ${set} failed (exit ${code})`);
          installed.push(set);
        }
        return { value: { installed, sets } };
      }

      // ── the window ──
      case 'window.set': {
        const w = this.deps.window;
        if (!w) return { value: false };
        if (typeof a.title === 'string') w.setTitle(a.title.replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, 120));
        if (typeof a.width === 'number' && typeof a.height === 'number' && a.width >= 120 && a.height >= 120 && a.width <= 10000 && a.height <= 10000) w.resize(Math.round(a.width), Math.round(a.height));
        return { value: true };
      }
      case 'window.close':
        this.deps.window?.close();
        return { value: !!this.deps.window };
    }
    throw new AccessError('ENOSYS', `tab.js: no operation named ${op.slice(0, 40)}`);
  }

  private batchName(batch: unknown): string {
    if (typeof batch === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(batch)) return batch;
    return `b${Date.now().toString(36)}${(this.batch++).toString(36)}`;
  }

  private async run(a: Record<string, unknown>, send: Send, onCancel: (fn: () => void) => void): Promise<{ code: number }> {
    const { access } = this.app.manifest;
    let line: string;
    if (Array.isArray(a.cmd)) {
      const argv = a.cmd;
      if (!argv.length || argv.some((x) => typeof x !== 'string' || x.includes('\0'))) throw new AccessError('EINVAL', 'tab.run takes [program, ...arguments], all strings');
      const prog = argv[0] as string;
      if (!access.commands.includes(prog)) throw new AccessError('EACCES', `this app's manifest does not list the command ${JSON.stringify(prog.slice(0, 64))} (access.commands)`);
      // The program is named by the manifest; every argument is one quoted word
      line = (argv as string[]).map(shq).join(' ');
    } else if (typeof a.cmd === 'string' && a.cmd.trim()) {
      if (!access.shell) throw new AccessError('EACCES', 'this app\'s manifest does not allow shell lines (access.shell); pass [program, ...arguments]');
      if (a.cmd.length > 100_000) throw new AccessError('EINVAL', 'the command is too long');
      line = a.cmd;
    } else throw new AccessError('EINVAL', 'tab.run needs a command');

    const cwd = (await this.path(a.cwd ?? this.app.dataDir, 'read')).real;
    // Output to a file: a path the app may write, opened by the shell, not by the program's arguments
    for (const [key, op] of [['stdout', '>'], ['stderr', '2>']] as const) {
      if (a[key] === undefined || a[key] === null) continue;
      const { real } = await this.path(a[key], 'write');
      await this.deps.fs.mkdir(real.slice(0, real.lastIndexOf('/')) || '/', { recursive: true });
      line = Array.isArray(a.cmd) ? `${line} ${op} ${shq(real)}` : `{ ${line}\n} ${op} ${shq(real)}`;
    }
    const env: Record<string, string> = {};
    if (a.env !== undefined && a.env !== null) {
      if (typeof a.env !== 'object') throw new AccessError('EINVAL', 'env must be an object of strings');
      for (const [k, v] of Object.entries(a.env as Record<string, unknown>)) {
        if (!ENV_NAME.test(k) || typeof v !== 'string' || v.includes('\0')) throw new AccessError('EINVAL', `env.${k.slice(0, 40)} must be a string under a plain name`);
        if (ENV_REFUSED.has(k)) throw new AccessError('EACCES', `a page may not set ${k} for a command`);
        env[k] = v;
      }
    }
    Object.assign(env, { APP_ID: this.app.manifest.id, APP_DIR: this.app.dir, APP_DATA: this.app.dataDir });
    if (a.stdin !== undefined && a.stdin !== null && typeof a.stdin !== 'string') throw new AccessError('EINVAL', 'stdin must be text');
    const h = this.deps.run({
      line, cwd, env, ...(typeof a.stdin === 'string' ? { stdin: a.stdin } : {}),
      onStdout: (s) => send('out', s),
      onStderr: (s) => send('err', s),
    });
    onCancel(() => h.kill());
    return { code: await h.done };
  }

  private async download(a: Record<string, unknown>, onCancel: (fn: () => void) => void): Promise<{ name: string; size: number; zip: boolean }> {
    const { fs } = this.deps;
    const asked = Array.isArray(a.paths) ? a.paths : [a.path ?? a.paths];
    if (!asked.length || asked.length > 10_000) throw new AccessError('EINVAL', 'tab.download needs a path, or a list of them');
    const items: { real: string; dir: boolean }[] = [];
    for (const p of asked) {
      const { real } = await this.path(p, 'read');
      const st = await fs.stat(real).catch(() => null);
      if (!st) throw new AccessError('ENOENT', `${String(p)}: no such file`);
      items.push({ real, dir: st.isDirectory() });
    }
    const leaf = (p: string) => p.slice(p.lastIndexOf('/') + 1) || 'files';
    const cleanName = (n: unknown, fallback: string) => (typeof n === 'string' && n.trim() ? n : fallback).replace(/[\x00-\x1f\x7f/\\]/g, '_').slice(0, 200);
    const zip = a.zip === true || items.length > 1 || items[0].dir;
    if (!zip) {
      const bytes = (await fs.readFile(items[0].real)) as Uint8Array;
      const name = cleanName(a.name, leaf(items[0].real));
      this.deps.download(name, bytes, 'application/octet-stream');
      return { name, size: bytes.length, zip: false };
    }
    // One folder: its contents at the top of the zip. Several paths: each by its own name.
    const tmp = `/tmp/.app-${this.app.manifest.id}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.zip`;
    const single = items.length === 1 && items[0].dir;
    const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
    let line: string;
    if (single) line = `cd ${shq(items[0].real)} && zip -q -r ${shq(tmp)} .`;
    else {
      const dir = parent(items[0].real);
      if (items.some((i) => parent(i.real) !== dir)) throw new AccessError('EINVAL', 'paths zipped together must be in one folder (or pass the folder)');
      line = `cd ${shq(dir)} && zip -q -r ${shq(tmp)} ${items.map((i) => shq(leaf(i.real))).join(' ')}`;
    }
    let err = '';
    const h = this.deps.run({ line, cwd: '/tmp', env: {}, onStdout: () => {}, onStderr: (s) => { err += s; } });
    onCancel(() => h.kill());
    const code = await h.done;
    try {
      const bytes = code === 0 ? ((await fs.readFile(tmp).catch(() => null)) as Uint8Array | null) : null;
      if (!bytes?.length) throw new AccessError('EIO', `zip failed${err.trim() ? `: ${err.trim().split('\n').pop()}` : ` (exit ${code})`}`);
      const name = cleanName(a.name, `${leaf(single ? items[0].real : parent(items[0].real))}.zip`).replace(/(\.zip)?$/i, '.zip');
      this.deps.download(name, bytes, 'application/zip');
      return { name, size: bytes.length, zip: true };
    } finally { await fs.unlink(tmp).catch(() => {}); }
  }
}

function bytesOrText(data: unknown): Uint8Array | string {
  if (typeof data === 'string') return data;
  let bytes: Uint8Array | null = null;
  if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
  else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (!bytes) throw new AccessError('EINVAL', 'data must be text, an ArrayBuffer or a typed array');
  if (bytes.length > MESSAGE_FILE_MAX) throw new AccessError('EINVAL', 'the file is too large for one message');
  return bytes;
}
