/**
 * Running apps (docs/APPS.md "Lifecycle"): one `AppInstance` per app that is
 * open in this tab. It owns the app's backend (supervisor.ts), answers its
 * page's requests (the files under `entry`, then the backend), serves its
 * tab.js channel (host.ts), and counts the views showing it: when the last
 * one closes the backend stops, unless the manifest says keepAlive.
 *
 * This is the shared core under every way of showing an app: a desktop
 * window and app mode (window.ts), `app dev`, and whatever else mounts an
 * app's frame (frame.ts) and wants its state and log (an app pane in the
 * Code app, a Studio). No DOM here beyond the browser's download.
 */
import type { AppManifest } from './manifest';
import { AppHost, type HostDeps, type RunHandle, type RunRequest } from './host';
import { resolveAllowed, normalizePath } from './access';
import { Supervisor, pickPort, type BackendState } from './supervisor';
import { AppError, appDataDir, expectedPath } from './registry';
import { iframeServer, type VirtualResponse } from '../iframe-server';
import { PAGE_SET_TIMEOUT, PAGE_CLEAR_TIMEOUT } from '../node-compat/page-globals';
import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';

export interface AppsDeps {
  fs: FileSystem;
  shell: Shell;
  /** Stand-ins for tests */
  toolchains?: HostDeps['toolchains'];
  download?: HostDeps['download'];
  reveal?: HostDeps['reveal'];
}

let deps: AppsDeps | null = null;
/** Called once at boot (main.ts) and by tests: the filesystem and the shell apps run on */
export function configureApps(d: AppsDeps | null): void { deps = d; }
export function appsDeps(): AppsDeps {
  if (!deps) throw new AppError('apps are not available here');
  return deps;
}
export const homeDir = (): string => appsDeps().shell.env['HOME'] || '/home/user';

/** One shell line in a process of its own, without a terminal */
export function runLine(req: RunRequest): RunHandle {
  const side = appsDeps().shell.fork();
  (side as unknown as { terminal: unknown }).terminal = null;
  side.cwd = req.cwd;
  Object.assign(side.env, req.env);
  const own = new AbortController();
  side.inheritedAbort = own;
  // (the shell writes line ends for a terminal: \r\n; a caller gets what the program wrote)
  const out = (s: string) => req.onStdout(s.replace(/\r\n/g, '\n'));
  const err = (s: string) => req.onStderr(s.replace(/\r\n/g, '\n'));
  const p = req.stdin !== undefined ? side.executeWithStdin(req.line, req.stdin, out, err) : side.execute(req.line, out, err);
  return { done: p.catch(() => 1), kill: () => own.abort() };
}

function browserDownload(name: string, bytes: Uint8Array, type: string): void {
  // An anchor that is never in the document: nothing else sees the click
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
  a.download = name;
  a.click();
  PAGE_SET_TIMEOUT(() => URL.revokeObjectURL(a.href), 60_000);
}

const realToolchains: HostDeps['toolchains'] = {
  async installed(sets) {
    const { listToolchains } = await import('../commands/toolchain');
    const all = await listToolchains(appsDeps().fs);
    return Object.fromEntries(sets.map((s) => [s, !!all.find((t) => t.id === s)?.installed]));
  },
  async install(set, onLine) {
    let buf = '';
    const out = (s: string) => {
      const parts = (buf + s.replace(/\r\n/g, '\n')).split('\n');
      buf = parts.pop() ?? '';
      for (const l of parts) if (l.trim()) onLine(l);
    };
    // (the set's name is one of the manifest's, checked to be a plain name)
    const code = await runLine({ line: `toolchain install ${set}`, cwd: homeDir(), env: {}, onStdout: out, onStderr: out }).done;
    if (buf.trim()) onLine(buf);
    return code;
  },
};

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8',
  wasm: 'application/wasm', pdf: 'application/pdf', map: 'application/json', xml: 'application/xml', mp3: 'audio/mpeg', mp4: 'video/mp4', webm: 'video/webm',
};

/**
 * What keeps the page of an app without network access on its own origin:
 * its requests, frames and forms go nowhere else. (Sent with every HTML
 * document of the app; docs/APPS.md says what this does and does not stop.)
 */
export const NO_NETWORK_CSP = [
  "default-src 'self' data: blob: 'unsafe-inline' 'unsafe-eval'",
  "connect-src 'self' data: blob:",
  "frame-src 'self' data: blob:",
  "form-action 'self'",
].join('; ');

/** The fixed path an app's page loads the client library from */
export const TAB_JS_PATH = '/__tabcomputer/tab.js';
let tabJs: Promise<string> | null = null;
/** tab.js, for pages that are not on an app origin (where the server itself serves it) */
export function tabJsSource(): Promise<string> {
  return tabJs ??= fetch('/apphost/tab.js', { cache: 'no-cache' }).then((r) => {
    if (!r.ok || /html/i.test(r.headers.get('content-type') ?? '')) throw new Error(`HTTP ${r.status}`);
    return r.text();
  }).catch((e) => { tabJs = null; throw e; });
}
/** Tests: the library's text without a server */
export function setTabJsSource(text: string | null): void { tabJs = text === null ? null : Promise.resolve(text); }

export interface AppRequest { method: string; path: string; headers?: Record<string, string>; body?: Uint8Array | null }
export type InstanceEvent = 'state' | 'log' | 'views' | 'reload';

export interface AppRef {
  manifest: AppManifest;
  dir: string;
  /** Where it came from (registry.ts `source`); `dev:<dir>` for `app dev` */
  source: string;
  dev?: boolean;
}

/** Something showing the app: a window, the tab in app mode, a pane */
export interface AppView { kind: 'window' | 'become' | 'pane'; close(): void; reload?(): void; focus?(): void }

export class AppInstance {
  readonly id: string;
  manifest: AppManifest;
  readonly dir: string;
  readonly dataDir: string;
  readonly source: string;
  readonly dev: boolean;
  supervisor: Supervisor | null = null;
  host: AppHost;
  readonly views = new Set<AppView>();
  /** The page is on an origin of its own (set by the frame that shows it) */
  confined = false;
  /** Lines from the backend and the host (`app dev` prints them; a pane shows them) */
  readonly log: string[] = [];
  private listeners = new Set<(ev: InstanceEvent, text?: string) => void>();
  private prepared: Promise<void> | null = null;
  private offs: (() => void)[] = [];
  /** The window its tab.js calls act on */
  window: HostDeps['window'] = null;

  constructor(ref: AppRef) {
    this.manifest = ref.manifest;
    this.id = ref.manifest.id;
    this.dir = ref.dir;
    this.source = ref.source;
    this.dev = !!ref.dev;
    this.dataDir = appDataDir(homeDir(), this.id);
    this.host = this.makeHost();
    this.makeSupervisor();
  }

  private makeHost(): AppHost {
    const d = appsDeps();
    const self = this;
    return new AppHost({ manifest: this.manifest, dir: this.dir, dataDir: this.dataDir, get confined() { return self.confined; } }, {
      fs: d.fs as unknown as HostDeps['fs'],
      home: homeDir(),
      run: runLine,
      download: d.download ?? browserDownload,
      toolchains: d.toolchains ?? realToolchains,
      get window() { return self.window; },
      reveal: d.reveal,
      log: (line) => this.say(`[tab.js] ${line}\n`),
    });
  }

  private makeSupervisor(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.supervisor?.stop();
    this.supervisor = null;
    const b = this.manifest.backend;
    if (!b) return;
    const port = b.port === 'auto' ? pickPort(this.id, (p) => iframeServer.isPortInUse(p), portsTaken()) : b.port;
    const sup = new Supervisor({
      id: this.id, start: b.start, cwd: this.dir, port, health: b.health,
      env: { APP_ID: this.id, APP_DIR: this.dir, APP_DATA: this.dataDir },
    }, {
      spawn: (line, cwd, env, onOutput) => runLine({ line, cwd, env, onStdout: onOutput, onStderr: onOutput }),
      portUp: (p) => iframeServer.isPortInUse(p),
      onPort: (cb) => iframeServer.onPortChange(cb),
      probe: async (p, path) => (await iframeServer.fetch(p, path)).status ?? 200,
      closePort: (p) => iframeServer.close(p),
      setTimeout: (fn, ms) => PAGE_SET_TIMEOUT(fn, ms),
      clearTimeout: (t) => PAGE_CLEAR_TIMEOUT(t as ReturnType<typeof setTimeout>),
    });
    this.offs.push(sup.on(() => this.emit('state')), sup.onLog((text) => this.say(text)));
    this.supervisor = sup;
  }

  /** `app dev`: the manifest changed on disk */
  setManifest(m: AppManifest): void {
    if (m.id !== this.id) throw new AppError(`the id changed from ${this.id} to ${m.id}: close the app and open it again`);
    const backendChanged = JSON.stringify(m.backend) !== JSON.stringify(this.manifest.backend);
    this.manifest = m;
    this.host = this.makeHost();
    this.prepared = null;
    if (backendChanged) this.makeSupervisor();
  }

  on(cb: (ev: InstanceEvent, text?: string) => void): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  private emit(ev: InstanceEvent, text?: string): void {
    for (const cb of [...this.listeners]) { try { cb(ev, text); } catch (e) { console.error('[app]', e); } }
  }

  say(text: string): void {
    if (!text) return;
    for (const l of text.replace(/\r\n/g, '\n').split('\n')) if (l.trim()) this.log.push(l);
    if (this.log.length > 500) this.log.splice(0, this.log.length - 500);
    this.emit('log', text);
  }

  get state(): BackendState | 'static' { return this.supervisor ? this.supervisor.state : 'static'; }

  /**
   * What must be there before the first start: the manifest's toolchain sets
   * (installed with `toolchain install`), its `files`, the data folder. Done
   * once per instance; `report` gets a line per step and the installer's output.
   */
  prepare(report: (stage: string, line?: string) => void = () => {}): Promise<void> {
    return this.prepared ??= this.doPrepare(report).catch((e) => { this.prepared = null; throw e; });
  }

  private async doPrepare(report: (stage: string, line?: string) => void): Promise<void> {
    const d = appsDeps();
    const home = homeDir();
    await d.fs.mkdir(this.dataDir, { recursive: true });
    const sets = this.manifest.toolchains;
    if (sets.length) {
      const marker = `${this.dataDir}/.toolchains`;
      const done = new Set(((await d.fs.readFile(marker, 'utf8').catch(() => '')) as string).split('\n').filter(Boolean));
      const todo = sets.filter((s) => !done.has(s));
      if (todo.length) {
        const tc = d.toolchains ?? realToolchains;
        const have = await tc.installed(todo);
        for (const set of todo) {
          if (!have[set]) {
            report(`Installing ${set}…`);
            this.say(`[app] ${this.id}: toolchain install ${set}\n`);
            const code = await tc.install(set, (line) => { report(`Installing ${set}…`, line); this.say(line + '\n'); });
            if (code !== 0) throw new AppError(`toolchain install ${set} failed (exit ${code}); ${this.manifest.name} needs it`);
          }
          done.add(set);
        }
        await d.fs.writeFile(marker, [...done].join('\n') + '\n');
      }
    }
    const missing: string[] = [];
    for (const entry of this.manifest.files) {
      const { path, folder } = expectedPath(entry, this.dir, home);
      if (folder) await d.fs.mkdir(path, { recursive: true });
      else if (!await d.fs.exists(path)) missing.push(entry);
    }
    if (missing.length) throw new AppError(`${this.manifest.name} expects ${missing.join(', ')}, which ${missing.length > 1 ? 'are' : 'is'} not there`);
  }

  /** Start the backend unless it is lazy (then the first request does). True when there is nothing to wait for or it runs. */
  async startBackend(force = false): Promise<boolean> {
    if (!this.supervisor) return true;
    if (this.manifest.backend?.lazy && !force) return true;
    return this.supervisor.start();
  }

  // ── the page's requests ──

  private staticRoot(): { root: string; index: string } | null {
    const e = this.manifest.entry;
    if (!e) return null;
    if (/\.html?$/i.test(e)) {
      const at = e.lastIndexOf('/');
      return { root: at < 0 ? this.dir : `${this.dir}/${e.slice(0, at)}`, index: e.slice(at + 1) };
    }
    return { root: e === '.' ? this.dir : `${this.dir}/${e}`, index: 'index.html' };
  }

  /** The path of the page inside the app's address space */
  entryPath(): string { return '/'; }

  private async staticFile(pathname: string): Promise<VirtualResponse | null> {
    const s = this.staticRoot();
    if (!s) return null;
    const fs = appsDeps().fs;
    let file: string;
    try { file = normalizePath(s.root + pathname); } catch { return null; }
    if (file !== s.root && !file.startsWith(s.root + '/')) return null;
    // A link inside the folder is followed only while it stays in the app's folder
    let real: string;
    try { real = (await resolveAllowed(fs, [{ path: this.dir, mode: 'read' }], file, 'read')).real; } catch { return null; }
    let st = await fs.stat(real).catch(() => null);
    if (st?.isDirectory()) { real = `${real}/${file === s.root ? s.index : 'index.html'}`; st = await fs.stat(real).catch(() => null); }
    if (!st || st.isDirectory()) return null;
    const body = (await fs.readFile(real)) as Uint8Array;
    const type = MIME[real.slice(real.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
    return { status: 200, headers: { 'content-type': type, 'cache-control': 'no-cache' }, body };
  }

  /** Answer one request of the app's page: tab.js, a file under `entry`, else the backend. */
  async fetch(req: AppRequest): Promise<VirtualResponse> {
    const method = (req.method || 'GET').toUpperCase();
    let pathname = req.path.split('#')[0].split('?')[0] || '/';
    try { pathname = decodeURIComponent(pathname); } catch { /* served as written */ }
    let res: VirtualResponse | null = null;
    if (pathname === TAB_JS_PATH) {
      try { res = { status: 200, headers: { 'content-type': MIME.js, 'cache-control': 'no-cache' }, body: await tabJsSource() }; }
      catch { res = { status: 502, headers: { 'content-type': 'text/plain' }, body: 'tab.js could not be loaded from this site' }; }
      return res;
    }
    if (method === 'GET' || method === 'HEAD') res = await this.staticFile(pathname);
    if (!res && this.supervisor) {
      const up = this.supervisor.state === 'running' || await this.supervisor.start();
      if (!up) res = { status: 502, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `${this.manifest.name}'s backend is not running: ${this.supervisor.error || 'it was stopped'}` };
      else res = await iframeServer.fetch(this.supervisor.port, req.path, { method, headers: req.headers ?? {}, body: req.body ?? null });
    }
    res ??= { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: `Not found: ${pathname}` };
    return this.manifest.access.network ? res : withCsp(res);
  }

  // ── views ──

  attach(view: AppView): void {
    this.views.add(view);
    this.emit('views');
  }

  /** A view closed. The last one takes the backend with it, unless the manifest keeps it alive. */
  detach(view: AppView): void {
    if (!this.views.delete(view)) return;
    this.emit('views');
    if (this.views.size) return;
    if (this.manifest.backend?.keepAlive) return;
    this.stop();
  }

  /** Ask every view to load the page again (`app dev` after a change) */
  reload(): void {
    this.emit('reload');
    for (const v of this.views) v.reload?.();
  }

  /** Stop the backend; the views stay (and say it is stopped) */
  stopBackend(): void { this.supervisor?.stop(); }

  /** Stop the backend and forget the instance (its views are closed first by the caller) */
  stop(): void {
    this.supervisor?.stop();
    if (instances.get(this.id) === this) instances.delete(this.id);
    this.emit('state');
  }

  /** Close every view and stop (`app stop`, `app remove`) */
  close(): void {
    for (const v of [...this.views]) { try { v.close(); } catch { /* already gone */ } }
    this.views.clear();
    this.stop();
  }
}

function withCsp(res: VirtualResponse): VirtualResponse {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(res.headers ?? {})) headers[k.toLowerCase()] = String(v);
  const type = headers['content-type'] ?? res.contentType ?? '';
  if (!/html|svg|xml/i.test(type)) return res;
  headers['content-security-policy'] = NO_NETWORK_CSP;
  return { ...res, headers };
}

const instances = new Map<string, AppInstance>();
const portsTaken = (): Set<number> => new Set([...instances.values()].map((i) => i.supervisor?.port ?? 0));

/** The running instance of an app, if it is open */
export const instanceOf = (id: string): AppInstance | undefined => instances.get(id);
export const runningInstances = (): AppInstance[] => [...instances.values()];

/** The instance of an app, made on first use. An instance of another folder under the same id is refused. */
export function instanceFor(ref: AppRef): AppInstance {
  const existing = instances.get(ref.manifest.id);
  if (existing) {
    if (existing.dir !== ref.dir) throw new AppError(`${ref.manifest.id} is already open from ${existing.dir}: close it first (app stop ${ref.manifest.id})`);
    return existing;
  }
  const inst = new AppInstance(ref);
  instances.set(inst.id, inst);
  return inst;
}

/** Tests: stop everything */
export function resetApps(): void {
  for (const i of [...instances.values()]) i.close();
  instances.clear();
}
