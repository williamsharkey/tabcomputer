/**
 * Installing an app in this tab (docs/APPS.md "Installing"): the steps the
 * `app` command and an app link (`?app=`) share. Fetching and the trust
 * decision are links.ts; the files and the registry are registry.ts; the
 * dock entry and the launch feedback are window.ts and the desktop.
 */
import type { Launch } from '../desktop/launch-state';
import type { DesktopWindow, WindowManager } from '../desktop/wm';
import { appsConfig } from './frame';
import {
  archiveApp, fetchArchive, fetchGhApp, fetchGistApp, fetchSiteApp, handleAppLink, linkApp,
  type AppLinkOutcome, type AppTarget, type FetchedApp, type InstallChoice, type InstallPromptInfo,
} from './links';
import { AppError, findInstalled, installFromDir, installFromFiles, type InstalledApp } from './registry';
import { appsDeps, homeDir, instanceFor, instanceOf, runLine } from './runtime';
import { becomeApp, idTaken, installedRef, monogramIcon, openInstalled, registerInstalledApp, stopApp } from './window';
import type { AppManifest } from './manifest';
import { cleanRunUrl } from '../run-url';
import { setShippedHidden } from './shipped';

const desktop = (): WindowManager | null => ((globalThis as { __shiroDesktop?: WindowManager }).__shiroDesktop ?? null);

let confirmOverride: ((info: InstallPromptInfo) => Promise<InstallChoice>) | null = null;
/** Tests: answer the install prompt without a person */
export function setInstallConfirm(fn: ((info: InstallPromptInfo) => Promise<InstallChoice>) | null): void { confirmOverride = fn; }

async function hasGuests(): Promise<boolean> {
  try {
    const g = await import('../guest');
    return !g.guestInfo() && !!(await g.guestConfig()).origin;
  } catch { return false; }
}

/** Show an app that isn't curated and wait for the person's choice */
export async function confirmInstall(app: FetchedApp): Promise<InstallChoice> {
  const had = await findInstalled(appsDeps().fs, app.manifest.id);
  const info: InstallPromptInfo = {
    manifest: app.manifest, manifestText: app.manifestText, from: app.from,
    replaces: had ? had.source : undefined,
    guests: await hasGuests(),
    confined: !!(await appsConfig().catch(() => ({ origin: null }))).origin,
  };
  if (confirmOverride) return confirmOverride(info);
  if (typeof document === 'undefined') return 'cancel';
  const { showInstallPrompt } = await import('./prompt');
  return showInstallPrompt(info, desktop());
}

/** The app a target names, fetched (its manifest read; its other files on demand) */
export async function fetchApp(target: AppTarget, fetchFn: (url: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i), githubToken?: string | null): Promise<FetchedApp> {
  if (target.kind === 'site') return fetchSiteApp(target.id, location.origin, fetchFn);
  if (target.kind === 'gh') return fetchGhApp(target, fetchFn, githubToken);
  if (target.kind === 'gist') return fetchGistApp(target, fetchFn, githubToken);
  if (target.kind === 'link') return linkApp(target.payload);
  return archiveApp(await unpack(await fetchArchive(target.url, fetchFn), target.url), target.url);
}

/** An archive's files, unpacked by the tab's own unzip or tar in a scratch folder (nothing of it runs) */
async function unpack(bytes: Uint8Array, url: string): Promise<Map<string, Uint8Array>> {
  const { fs } = appsDeps();
  const tmp = `/tmp/.app-install-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const zip = /\.zip$/i.test(new URL(url).pathname);
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  try {
    await fs.mkdir(`${tmp}/x`, { recursive: true });
    await fs.writeFile(`${tmp}/a`, bytes);
    let err = '';
    const code = await runLine({
      line: zip ? `unzip -q -o ${q(`${tmp}/a`)} -d ${q(`${tmp}/x`)}` : `tar -xzf ${q(`${tmp}/a`)} -C ${q(`${tmp}/x`)}`,
      cwd: tmp, env: {}, onStdout: () => {}, onStderr: (s) => { err += s; },
    }).done;
    if (code !== 0) throw new AppError(`the archive could not be unpacked${err.trim() ? `: ${err.trim().split('\n').pop()}` : ''}`);
    const out = new Map<string, Uint8Array>();
    const walk = async (dir: string, rel: string): Promise<void> => {
      for (const name of await fs.readdir(dir)) {
        const p = `${dir}/${name}`;
        const st = await fs.lstat(p);
        // (a link in an archive is left out: it could point anywhere in this tab)
        if (st.type === 'symlink') continue;
        if (st.isDirectory()) await walk(p, `${rel}${name}/`);
        else out.set(rel + name, (await fs.readFile(p)) as Uint8Array);
      }
    };
    await walk(`${tmp}/x`, '');
    return out;
  } finally { await fs.rm(tmp, { recursive: true }).catch(() => {}); }
}

function afterInstall(app: InstalledApp): void {
  setShippedHidden(app.id, false);
  if (!idTaken(app.id)) registerInstalledApp(app);
}

/**
 * The dock's click on an app this site ships that is not installed yet
 * (shipped.ts): install the site's copy, then open it. The launch shows each
 * step and, when one fails, why.
 */
export async function openShipped(id: string, launch: Launch): Promise<DesktopWindow | null> {
  try {
    if (!await findInstalled(appsDeps().fs, id)) {
      launch.installing(null, 'Its files are being downloaded from this site.');
      await installFetched(await fetchApp({ kind: 'site', id }));
    }
  } catch (e) {
    if (launch.active) launch.fail(`It could not be installed: ${(e as Error)?.message ?? e}`);
    return null;
  }
  if (!launch.active) return null;
  return openInstalled(id, { launch });
}

/** Write a fetched app's files, list it, put it in the dock. A running copy is stopped first. */
export async function installFetched(app: FetchedApp, files?: Map<string, Uint8Array>): Promise<{ app: InstalledApp; manifest: AppManifest; files: number; replaced: boolean }> {
  const { fs } = appsDeps();
  if (idTaken(app.manifest.id)) throw new AppError(`the id ${app.manifest.id} belongs to an app that is built in`);
  stopApp(app.manifest.id);
  const r = await installFromFiles(fs, files ?? await app.files(), { home: homeDir(), source: app.source, id: app.manifest.id });
  afterInstall(r.app);
  return r;
}

/** Install the app in a folder of this tab */
export async function installDir(dir: string): Promise<{ app: InstalledApp; manifest: AppManifest; files: number; replaced: boolean }> {
  const { fs } = appsDeps();
  const r = await installFromDir(fs, dir, { home: homeDir(), source: `dir:${dir}`, taken: idTaken });
  // (a running copy of the installed app keeps the old files' page until it is opened again)
  afterInstall(r.app);
  return r;
}

/**
 * What an installed app needs before its first start (its toolchain sets),
 * with the desktop's launch feedback: the dock marks it and a placeholder
 * window shows the installer's output. `line` also gets each line.
 */
export async function prepareInstalled(id: string, line: (text: string) => void = () => {}): Promise<void> {
  const { ref, app } = await installedRef(id);
  const installs = ref.manifest.toolchains.length + ref.manifest.needs.length;
  if (!installs && !ref.manifest.files.length) return;
  const had = !!instanceOf(id);
  const inst = instanceFor(ref);
  const wm = desktop();
  let launch: Launch | null = null;
  if (wm && installs && !wm.launches.get(id)) {
    launch = wm.launches.request({
      id, name: app.name, icon: app.icon || monogramIcon(app.name, id), placeholder: true, note: 'installing what it needs',
      size: { width: ref.manifest.window.width, height: ref.manifest.window.height },
      onCancel: () => `${app.name}'s install goes on in the background, so nothing is left half-installed.`,
    }).launch;
  }
  try {
    await inst.prepare((stage, l) => { launch?.installing(null, stage); if (l) { launch?.log(l + '\n'); line(l); } else line(stage); });
    // Nothing to show yet: the launch is over without a window
    if (launch?.active) launch.running(null);
  } catch (e) {
    if (launch?.active) launch.fail((e as Error).message);
    throw e;
  } finally { if (!had && !inst.views.size) inst.stop(); }
}

/** Boot (main.ts): the page's `?app=` link, through the same rules as a run link */
export async function startAppLink(o: {
  ready?: () => Promise<void>;
  report: (message: string) => void;
}): Promise<AppLinkOutcome> {
  let framed = true;
  try { framed = window.top !== window; } catch { /* a cross-origin parent */ }
  return handleAppLink({
    search: location.search, hash: location.hash, origin: location.origin, framed,
    fetch: (url, init) => fetch(url, init),
    cleanUrl: () => history.replaceState(history.state, '', cleanRunUrl(location.href)),
    ready: o.ready,
    github: async (action, run) => (await import('../github-needed')).fetchSignedIn(action, run),
    installedSource: async (id) => (await findInstalled(appsDeps().fs, id))?.source ?? null,
    confirm: confirmInstall,
    install: async (app, files) => {
      await installFetched(app, files);
      await prepareInstalled(app.manifest.id).catch((e) => o.report((e as Error).message));
    },
    open: async (id, become) => {
      // A phone has no room for a desktop around the app that was asked for: the tab is the app,
      // with a way back to the desktop (tabcomputer#139)
      const { compactViewport } = await import('../desktop/wm');
      const small = !become && compactViewport() && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
      if (become || small) await becomeApp((await installedRef(id)).ref, { back: small });
      else {
        const wm = desktop();
        if (wm?.apps().some((a) => a.id === id)) await wm.openApp(id); else await openInstalled(id);
      }
    },
    openInGuest: async (query) => {
      const g = await import('../guest');
      return !!(await g.openGuest({}, { search: query }));
    },
    report: o.report,
  });
}
