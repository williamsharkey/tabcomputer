/**
 * Apps on the desktop (docs/APPS.md "Lifecycle"): an installed app's dock
 * entry, its window, and app mode.
 *
 * - The window is the app's own: its name and icon, no toolbar, the size its
 *   manifest asks for. One per app unless `window.multiple`.
 * - Opening reports to the desktop's launch tracker (launch-state.ts): the
 *   dock marks the app as starting, and a placeholder window shows what is
 *   happening (a toolchain install's output, the backend starting) when that
 *   takes more than a moment. No launch has a time limit of its own.
 * - The window watches its backend: while it restarts the page is covered by
 *   a line saying so; after repeated failures the cover shows the error and
 *   the backend's last output, with Retry.
 * - Session restore reopens the window with `app open ID` (`app dev DIR`),
 *   which starts the backend again.
 * - App mode (`app open ID --become`, `?app=ID&become`): the tab is the app,
 *   at /<id>; a reload comes back to it (main.ts, become.ts).
 */
import type { DesktopWindow, WindowManager } from '../desktop/wm';
import { placeholderId, type Launch } from '../desktop/launch-state';
import { createAppFrame, type AppFrame } from './frame';
import { AppInstance, appsDeps, homeDir, instanceFor, instanceOf, type AppRef, type AppView } from './runtime';
import { AppError, findInstalled, listInstalled, loadManifest, type InstalledApp } from './registry';
import { ManifestError } from './manifest';
import { isShipped, shippedGlyph } from './shipped';
import { surface } from './surface';

const STYLE_ID = 'tc-app-style';
const CSS = `
.tc-app { position: relative; display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--sd-window, #1b1d29); }
.tc-app-body { position: relative; flex: 1; min-height: 0; }
.tc-app-cover { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; text-align: center; overflow: auto;
  font: 13px/1.5 var(--sd-font, system-ui, sans-serif); color: var(--sd-text, #e6e6f0);
  background: color-mix(in srgb, var(--sd-window, #1b1d29) 90%, transparent); -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px); }
.tc-app-cover[hidden] { display: none; }
.tc-app-cover b { display: block; font-size: 15px; margin-bottom: 4px; }
.tc-app-cover pre { max-width: min(640px, 100%); max-height: 180px; margin: 10px auto 0; padding: 8px 10px; overflow: auto; text-align: left; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 12px/1.45 var(--sd-mono, ui-monospace, monospace); background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 8px;
  user-select: text; -webkit-user-select: text; }
.tc-app-cover .tc-app-actions { display: flex; gap: 8px; justify-content: center; margin-top: 12px; }
.tc-app-cover button { font: inherit; padding: 6px 16px; border-radius: 8px; cursor: pointer; color: inherit;
  background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-app-titleicon { width: 16px; height: 16px; flex: none; z-index: 1; pointer-events: none; object-fit: contain; border-radius: 3px; }
.tc-app-note { flex: none; padding: 3px 10px; font: 11px/1.5 var(--sd-font, system-ui, sans-serif); color: var(--sd-text-2, #a4a8b8); background: var(--sd-window, #1b1d29); border-top: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-app-backup { flex: none; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 3px 6px 3px 12px; font: 12px/1.5 var(--sd-font, system-ui, sans-serif); color: var(--sd-text-2, #a4a8b8); background: var(--sd-window, #1b1d29); border-top: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-app-backup[hidden] { display: none; }
.tc-app-backup button { font: inherit; min-height: 26px; padding: 2px 10px; color: var(--sd-text, #e6e6f0); background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 6px; cursor: pointer; }
.tc-app-backup button:focus-visible { outline: 2px solid var(--sd-accent, #6e6aff); outline-offset: 1px; }
@media (pointer: coarse) { .tc-app-backup button { min-height: 36px; padding: 2px 14px; } }
.sd-compact .sd-win:has(.tc-app-tb) .sd-title { right: 44px; }
#become-container.tc-app-mode { display: flex; flex-direction: column; background: var(--sd-window); }
#become-container.tc-app-mode iframe { flex: 1; min-height: 0; height: auto !important; }
#become-container .tc-app-cover { position: fixed; background: var(--sd-window); }
#become-container.tc-app-backed .tc-app-cover { top: 41px; }
.tc-app-back { flex: none; display: flex; align-items: center; justify-content: space-between; min-height: 40px; padding: 0 6px; background: var(--sd-window); border-bottom: 1px solid var(--sd-sep); }
.tc-app-back a, .tc-app-back button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 10px; font: 13px/1 system-ui, sans-serif; color: var(--sd-text-2); text-decoration: none; background: none; border: 0; border-radius: 6px; cursor: pointer; }
.tc-app-back a:focus-visible, .tc-app-back button:focus-visible { outline: 2px solid var(--sd-accent); outline-offset: -2px; }
`;

const SHARE_GLYPH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V3.5M7.5 7.5 12 3l4.5 4.5M5 12v7.5h14V12"/></svg>';

/** The tab is an app now (app mode): the desktop's windows are under it */
const inAppMode = (): boolean => document.body.classList.contains('become-active');

/**
 * The share screen of an installed app: the link, Copy, and what a person who
 * opens the link gets (`app share ID` prints the same sentences). An app too
 * large for a link gets the sentence that says what to do instead.
 */
export async function shareInstalled(id: string): Promise<void> {
  const { fs } = appsDeps();
  const [{ shareApp, siteOriginOf }, { showShareScreen }, { writeClipboard }, { guestInfo }] = await Promise.all([import('./share'), import('./share-ui'), import('../utils/clipboard'), import('../guest')]);
  const app = await findInstalled(fs, id);
  let shown: import('./share-ui').ShareShown;
  try {
    if (!app) throw new AppError(`${id} is not installed any more.`);
    shown = await shareApp(fs, app, siteOriginOf(location, !!guestInfo()));
  } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    shown = { name: app?.name ?? id, problem: /[.!?]$/.test(why) ? why : `${why}.` };
  }
  showShareScreen(shown, inAppMode() ? null : desktop(), (text) => writeClipboard(text).catch(() => false), { qr: true });
}

/** Export an installed app with its data to the person's disk (the menu, the mark's button). A failure is said in a window. */
export async function exportFromWindow(id: string, name: string): Promise<void> {
  try { await (await import('./install')).exportInstalled(id); } catch (e) {
    const why = (e as Error)?.message ?? String(e);
    (await import('./share-ui')).showShareScreen({ name, title: `Export ${name}`, problem: `${why.charAt(0).toUpperCase()}${why.slice(1)}${/[.!?]$/.test(why) ? '' : '.'}` }, inAppMode() ? null : desktop(), async () => false);
  }
}

/**
 * The mark an app shows when its data is in no file (export.ts `backupMark`):
 * a slim line under its page, "Not backed up since Tuesday", with Export
 * beside it. Nothing shows while there is nothing to say.
 */
function backupNote(inst: AppInstance): { el: HTMLElement; dispose(): void } {
  const el = document.createElement('div');
  el.className = 'tc-app-backup';
  el.hidden = true;
  const text = document.createElement('span');
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'Export';
  btn.title = 'Save the app and its data as one file';
  btn.addEventListener('click', () => { void exportFromWindow(inst.id, inst.manifest.name); });
  el.append(text, btn);
  const { fs } = appsDeps();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let gone = false;
  const paint = async () => {
    const { backupMark } = await import('./export');
    const mark = await backupMark(fs, homeDir(), inst.id, inst.manifest.kind !== 'page').catch(() => '');
    if (gone) return;
    text.textContent = mark;
    el.hidden = !mark;
  };
  // A change in the data folder while nothing is shown: look again, once the writing has settled
  const offFs = fs.onChange((_ev, path) => {
    if (!el.hidden || timer || !path.startsWith(inst.dataDir + '/')) return;
    timer = setTimeout(() => { timer = null; void paint(); }, 1200);
  });
  const onExport = (id: string) => { if (id === inst.id) void paint(); };
  void import('./export').then((x) => { if (!gone) x.exportListeners.add(onExport); });
  void paint();
  return {
    el,
    dispose() {
      gone = true;
      offFs();
      if (timer) clearTimeout(timer);
      void import('./export').then((x) => x.exportListeners.delete(onExport));
    },
  };
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

const desktop = (): WindowManager | null => ((globalThis as { __shiroDesktop?: WindowManager }).__shiroDesktop ?? null);

/** A dock tile for an app without an icon of its own: its first letter */
export function monogramIcon(name: string, id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) % 360;
  const letter = (name.trim()[0] ?? '?').toUpperCase().replace(/[&<>"']/g, '?');
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="4" y="4" width="40" height="40" rx="10" fill="hsl(${h} 45% 42%)"/>` +
    `<text x="24" y="32" font-size="22" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif">${letter}</text></svg>`;
}

/** The ref of an installed app: its manifest read from its folder now */
export async function installedRef(id: string): Promise<{ ref: AppRef; app: InstalledApp }> {
  const { fs } = appsDeps();
  const app = await findInstalled(fs, id);
  if (!app) throw new AppError(`no app named ${id} is installed (app list)`);
  const manifest = await loadManifest(fs, app.dir);
  return { ref: { manifest, dir: app.dir, source: app.source }, app };
}

interface Cover { show(title: string, detail?: string, log?: string[], actions?: [string, () => void][]): void; hide(): void; el: HTMLElement }
function makeCover(): Cover {
  const el = document.createElement('div');
  el.className = 'tc-app-cover';
  el.hidden = true;
  el.setAttribute('role', 'status');
  return {
    el,
    hide() { el.hidden = true; el.textContent = ''; },
    show(title, detail = '', log = [], actions = []) {
      el.textContent = '';
      const box = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = title;
      box.append(b);
      if (detail) { const d = document.createElement('div'); d.textContent = detail; box.append(d); }
      if (log.length) { const pre = document.createElement('pre'); pre.textContent = log.join('\n'); box.append(pre); }
      if (actions.length) {
        const row = document.createElement('div');
        row.className = 'tc-app-actions';
        for (const [label, fn] of actions) {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.textContent = label;
          btn.addEventListener('click', fn);
          row.append(btn);
        }
        box.append(row);
      }
      el.append(box);
      el.hidden = false;
    },
  };
}

/** Keep a view's cover in step with the backend: restarting, failed (with Retry), running again */
function watchBackend(inst: AppInstance, cover: Cover, frame: () => AppFrame | null, close: () => void): () => void {
  let wasDown = false;
  const update = () => {
    const sup = inst.supervisor;
    if (!sup) return;
    const name = inst.manifest.name;
    if (sup.state === 'running') {
      if (wasDown) {
        wasDown = false;
        cover.hide();
        // A page the backend served is stale; a page from the app's own files only lost its requests
        if (!inst.manifest.entry) frame()?.reload();
      }
    } else if (sup.state === 'failed') {
      wasDown = true;
      cover.show(`${name} stopped working`, sup.error, sup.tail(), [['Retry', () => { cover.show(`Starting ${name}…`); void sup.retry(); }], ['Close', close]]);
    } else if (sup.state === 'backoff' || (sup.state === 'starting' && sup.starts > 1)) {
      wasDown = true;
      cover.show(`Restarting ${name}…`, sup.error);
    } else if (sup.state === 'stopped' && !inst.manifest.backend?.lazy && inst.views.size) {
      wasDown = true;
      cover.show(`${name} is stopped`, 'Its backend was stopped.', [], [['Start', () => { cover.show(`Starting ${name}…`); void sup.start(); }], ['Close', close]]);
    }
  };
  const off = inst.on((ev) => { if (ev === 'state') update(); });
  update();
  return off;
}

function windowsOf(wm: WindowManager, id: string): DesktopWindow[] {
  return wm.windows().filter((w) => w.appId === id && w.state !== 'closed' && w.id !== placeholderId(id));
}

async function buildWindow(wm: WindowManager, inst: AppInstance, icon: string, restore: string): Promise<DesktopWindow> {
  ensureStyle();
  const m = inst.manifest;
  const root = document.createElement('div');
  root.className = 'sd-app tc-app';
  const body = document.createElement('div');
  body.className = 'tc-app-body';
  const cover = makeCover();
  root.append(body, cover.el);
  const wa = wm.workArea();
  const win = wm.createWindow({
    appId: m.id, title: m.name, icon: icon || undefined,
    width: Math.min(m.window.width, Math.max(200, wa.width - 24)), height: Math.min(m.window.height, Math.max(140, wa.height - 62)),
    minWidth: Math.min(m.window.minWidth, m.window.width), minHeight: Math.min(m.window.minHeight, m.window.height),
    resizable: m.window.resizable, content: { kind: 'dom', element: root },
  });
  if (icon.startsWith('data:')) {
    const img = document.createElement('img');
    img.className = 'tc-app-titleicon';
    img.alt = '';
    img.src = icon;
    win.element.querySelector('.sd-titlebar .sd-lights')?.after(img);
  }
  if (!inst.dev && win.titlebarExtra) {
    const share = document.createElement('button');
    share.type = 'button';
    share.className = 'sd-tb-btn tc-app-tb';
    share.title = 'Share';
    share.setAttribute('aria-label', `Share ${m.name}`);
    share.innerHTML = SHARE_GLYPH;
    share.addEventListener('pointerdown', (e) => e.stopPropagation());
    share.addEventListener('click', (e) => { e.stopPropagation(); void shareInstalled(m.id); });
    win.titlebarExtra.append(share);
  }
  // Session restore opens it again; its backend comes back with it
  (win as { restoreCommand?: { cmd: string; cwd: string } }).restoreCommand = { cmd: restore, cwd: homeDir() };

  let frame: AppFrame | null = null;
  const view: AppView = {
    kind: 'window',
    close: () => { win.close(true); },
    reload: () => frame?.reload(),
    focus: () => win.focus(),
  };
  inst.attach(view);
  inst.window = { setTitle: (t) => win.setTitle(t || m.name), resize: (w, h) => win.resize(w, h), close: () => { win.close(); } };
  const offBackend = watchBackend(inst, cover, () => frame, () => win.close(true));
  const backup = inst.dev ? null : backupNote(inst);
  if (backup) root.append(backup.el);
  // A click inside the frame goes to the frame's document: the window still has to come forward
  const onBlur = () => { if (frame && document.activeElement === frame.element && !win.focused) win.focus(); };
  window.addEventListener('blur', onBlur);
  win.on('close', () => {
    window.removeEventListener('blur', onBlur);
    offBackend();
    backup?.dispose();
    frame?.dispose();
    inst.detach(view);
  });
  try {
    frame = await createAppFrame(inst, { onError: (msg) => cover.show(`${m.name} could not be shown`, msg) });
    if (win.state === 'closed') { frame.dispose(); return win; }
    body.append(frame.element);
    if (!frame.confined) {
      const note = document.createElement('div');
      note.className = 'tc-app-note';
      note.textContent = 'This server has no app origins: the page runs with this tab\'s own access.';
      root.append(note);
    }
  } catch (e) {
    cover.show(`${m.name} could not be shown`, (e as Error).message);
  }
  return win;
}

export interface OpenOptions {
  /** Another window even when one is open */
  newWindow?: boolean;
  /** The command session restore runs to bring the window back */
  restore?: string;
  /** The icon as a data: URL (an installed app's is in the registry) */
  icon?: string;
  /** The launch already asked for (the dock's click asks before anything is awaited) */
  launch?: Launch;
}

/**
 * Open an app in a desktop window: what it needs first, its backend, then
 * the window. Resolves to the window, or null when it did not open (the
 * launch tracker holds why). In the terminal UI the tab becomes the app.
 */
export async function openAppWindow(ref: AppRef, opts: OpenOptions = {}): Promise<DesktopWindow | null> {
  const wm = desktop();
  if (!wm) { await becomeApp(ref); return null; }
  const id = ref.manifest.id;
  const inst = instanceFor(ref);
  const name = inst.manifest.name;
  const open = windowsOf(wm, id);
  let launch: Launch | null = opts.launch ?? null;
  if (open.length && !(inst.manifest.window.multiple && opts.newWindow)) {
    const w = open[open.length - 1];
    if (w.state === 'minimized') w.restore();
    w.focus();
    launch?.running(w);
    return w;
  }
  const icon = opts.icon ?? '';
  if (!launch && !open.length) {
    const r = wm.launches.request({
      id, name, icon: icon || monogramIcon(name, id), placeholder: true,
      size: { width: inst.manifest.window.width, height: inst.manifest.window.height },
      retry: () => { void openAppWindow(ref, { ...opts, launch: undefined }); },
      onCancel: () => `${name} won't open.`,
    });
    if (!r.fresh) return wm.get(placeholderId(id)) ?? null;
    launch = r.launch;
  }
  const offLog = launch ? inst.on((ev, text) => { if (ev === 'log' && text) launch!.log(text); }) : () => {};
  try {
    await inst.prepare((stage) => { launch?.installing(null, stage); });
    if (launch && !launch.active) { if (!inst.views.size) inst.stop(); return null; }
    launch?.starting();
    if (!await inst.startBackend()) {
      const why = inst.supervisor?.error || 'it was stopped';
      launch?.fail(`${name}'s backend did not start: ${why}`);
      if (!inst.views.size) inst.stop();
      return null;
    }
    if (launch && !launch.active) { if (!inst.views.size) inst.stop(); return null; }
    // (the tracker ends the launch when the window appears: it carries the app's id)
    return await buildWindow(wm, inst, icon, opts.restore ?? `app open ${id}`);
  } catch (e) {
    const msg = e instanceof ManifestError || e instanceof AppError ? e.message : `${name} did not open: ${(e as Error)?.message ?? e}`;
    if (launch?.active) launch.fail(msg);
    if (!inst.views.size) inst.stop();
    if (!launch) throw e;
    return null;
  } finally { offLog(); }
}

// ── the dock ──

const registered = new Set<string>();

/** Put an installed app in the dock (and in `desktop open ID`) */
export function registerInstalledApp(app: InstalledApp): void {
  const wm = desktop();
  if (!wm) return;
  registered.add(app.id);
  wm.registerApp({
    id: app.id, name: app.name, icon: app.icon || monogramIcon(app.name, app.id), order: 40, dock: true,
    // (the site's own copy of a shipped app keeps the glyph its entry had before it was installed)
    glyph: app.source === 'site' ? shippedGlyph(app.id) : undefined,
    menus: () => [{ title: 'App', items: [
      { label: 'Share as a Link…', action: () => void shareInstalled(app.id) },
      { label: 'Export with Its Data', action: () => void exportFromWindow(app.id, app.name) },
      { label: 'Edit in Studio', action: () => void wm.openApp('studio', { id: app.id }) },
    ] }],
    launch: (args) => {
      const open = windowsOf(wm, app.id);
      const newWindow = !!args?.newWindow;
      if (open.length && !newWindow) {
        const w = open[open.length - 1];
        if (w.state === 'minimized') w.restore();
        w.focus();
        return w;
      }
      // Asked for before anything is awaited, so wm.openApp sees this launch and starts none of its own
      const r = wm.launches.request({
        id: app.id, name: app.name, icon: app.icon || monogramIcon(app.name, app.id), placeholder: true,
        retry: () => { void wm.openApp(app.id, args); },
        onCancel: () => `${app.name} won't open.`,
      });
      if (!r.fresh) return wm.get(placeholderId(app.id)) ?? null;
      return openInstalled(app.id, { newWindow, launch: r.launch });
    },
  });
}

export function unregisterInstalledApp(id: string): void {
  if (!registered.delete(id)) return;
  (desktop() as (WindowManager & { unregisterApp?: (id: string) => void }) | null)?.unregisterApp?.(id);
}

/** Is `id` an app of the desktop that the toolkit did not put there? */
export function idTaken(id: string): boolean {
  const wm = desktop();
  // (a shipped app's entry before it is installed is the toolkit's own: shipped.ts)
  return !!wm && !registered.has(id) && !isShipped(id) && wm.apps().some((a) => a.id === id);
}

/** Boot: every installed app gets its dock entry (the registry holds name and icon; no app file is read) */
export async function registerInstalledApps(): Promise<number> {
  if (!desktop()) return 0;
  const apps = await listInstalled(appsDeps().fs);
  for (const app of apps) if (!idTaken(app.id)) registerInstalledApp(app);
  return apps.length;
}

/** Open an installed app by id: a window, or (installed with --guest) its guest */
export async function openInstalled(id: string, opts: OpenOptions = {}): Promise<DesktopWindow | null> {
  let found: { ref: AppRef; app: InstalledApp };
  try { found = await installedRef(id); }
  catch (e) {
    // The dock's own click has nowhere to print: the launch shows the reason
    if (opts.launch?.active) { opts.launch.fail((e as Error).message); return null; }
    throw e;
  }
  return openAppWindow(found.ref, { ...opts, icon: found.app.icon, restore: `app open ${id}` });
}

// ── app mode ──

const BECOME_KEY = 'tabcomputer-become';

/**
 * The tab becomes the app, at /<id>: a reload comes back to it. `back`: a
 * slim bar above the app with one link, to the desktop.
 */
export async function becomeApp(ref: AppRef, opts: { back?: boolean } = {}): Promise<void> {
  ensureStyle();
  const inst = instanceFor(ref);
  const m = inst.manifest;
  document.body.classList.add('become-active');
  let container = document.getElementById('become-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'become-container';
    document.body.appendChild(container);
  }
  (container as { _navCleanup?: () => void })._navCleanup?.();
  container.textContent = '';
  const cover = makeCover();
  // The bar, the cover and the frame's edge follow the appearance the page has
  container.classList.add('tc-app-mode');
  // (with the bar, what covers the page while it starts leaves the bar and its way back in sight)
  container.classList.toggle('tc-app-backed', !!opts.back);
  const offTheme = surface(container);
  if (opts.back) {
    const bar = document.createElement('nav');
    bar.className = 'tc-app-back';
    bar.setAttribute('aria-label', 'tabcomputer');
    const a = document.createElement('a');
    a.href = '/?unbecome';
    a.textContent = '\u2039 tabcomputer';
    a.title = 'Leave the app and open the tabcomputer desktop';
    const share = document.createElement('button');
    share.type = 'button';
    share.textContent = 'Share';
    share.addEventListener('click', () => { void shareInstalled(m.id); });
    bar.append(a, ...(inst.dev ? [] : [share]));
    container.append(bar);
  }
  const backup = inst.dev ? null : backupNote(inst);
  container.append(cover.el, ...(backup ? [backup.el] : []));
  const leave = () => { location.href = '/?unbecome'; };
  cover.show(`Starting ${m.name}…`);
  let frame: AppFrame | null = null;
  const view: AppView = {
    kind: 'become',
    close: () => { void import('../commands/become').then((b) => b.deactivateBecomeMode()); },
    reload: () => frame?.reload(),
  };
  const offBackend = { off: () => {} };
  (container as { _navCleanup?: () => void })._navCleanup = () => { offBackend.off(); offTheme(); backup?.dispose(); container!.classList.remove('tc-app-mode', 'tc-app-backed', 'tc-surface'); frame?.dispose(); inst.detach(view); };
  // (the tab's title is the app's window title: a files run puts "3 of 12" there)
  inst.window = { setTitle: (t) => { document.title = t || m.name; }, resize: () => {}, close: () => {} };
  try {
    // (the slug is the id; `app` says the toolkit brings it back, not `serve`)
    localStorage.setItem(BECOME_KEY, JSON.stringify({ directory: inst.dir, port: 0, slug: m.id, title: m.name, app: m.id, ...(opts.back ? { back: true } : {}) }));
  } catch { /* no storage: it works until the reload */ }
  if (location.pathname !== '/' + m.id) history.pushState({}, '', '/' + m.id);
  document.title = m.name;
  inst.attach(view);
  try {
    await inst.prepare((stage) => cover.show(`Starting ${m.name}…`, stage));
    if (!await inst.startBackend()) {
      cover.show(`${m.name} did not start`, inst.supervisor?.error ?? '', inst.supervisor?.tail() ?? [], [['Retry', () => { void becomeApp(ref, opts); }], ['Back to the desktop', leave]]);
      return;
    }
    frame = await createAppFrame(inst, { onError: (msg) => cover.show(`${m.name} could not be shown`, msg, [], [['Back to the desktop', leave]]) });
    container.insertBefore(frame.element, cover.el);
    cover.hide();
    offBackend.off = watchBackend(inst, cover, () => frame, leave);
  } catch (e) {
    cover.show(`${m.name} did not start`, (e as Error).message, [], [['Back to the desktop', leave]]);
  }
}

/** Boot (main.ts): the tab was an app before the reload. False: it is not installed any more. */
export async function restoreBecomeApp(id: string, back = false): Promise<boolean> {
  let found: { ref: AppRef };
  try { found = await installedRef(id); } catch { return false; }
  await becomeApp(found.ref, { back });
  return true;
}

/** The running instance's views closed and its backend stopped. False: it was not running. */
export function stopApp(id: string): boolean {
  const inst = instanceOf(id);
  const wm = desktop();
  if (!inst) return false;
  inst.close();
  for (const w of wm ? windowsOf(wm, id) : []) w.close(true);
  return true;
}
