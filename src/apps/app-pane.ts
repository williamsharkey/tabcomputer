/**
 * The Code app's app pane (docs/APPS.md "App mode in the Code app"): a
 * folder with an app.json opened in Code shows the app running beside the
 * editor (below it on a narrow screen), as `app dev` would in a window of its
 * own. Saving reloads it (dev-watch.ts); under it are the app.json's problems
 * as they are typed, the backend's output and what tab.js refused.
 *
 * It is the toolkit's core in a pane: `loadManifest`, `instanceFor` with a
 * view of kind 'pane', `createAppFrame`, `watchAppDir`, `shareFiles`.
 */
import type { FileSystem } from '../filesystem';
import type { Shell } from '../shell';
import type { AppInstance, AppView } from './runtime';
import type { AppFrame } from './frame';
import type { WatchFs } from './dev-watch';

const STYLE_ID = 'tc-app-pane-style';
const CSS = `
.tc-code-app { display: flex; }
.tc-code-app > .sd-iframe { flex: 1 1 55%; min-width: 0; width: auto; height: auto; }
.tc-pane { flex: 0 0 45%; min-width: 0; min-height: 0; display: flex; flex-direction: column; background: #1e1e2e; color: #cdd6f4; border-left: 1px solid #313244; }
.tc-code-app.tc-narrow { flex-direction: column; }
.tc-code-app.tc-narrow > .sd-iframe { flex: 1 1 50%; min-height: 0; }
.tc-code-app.tc-narrow > .tc-pane { flex: 0 0 50%; border-left: 0; border-top: 1px solid #313244; }
.tc-pane-frame { position: relative; flex: 1; min-height: 0; }
.tc-pane-frame iframe { position: absolute; inset: 0; }
.tc-pane-cover { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; text-align: center; font: 13px/1.5 system-ui, sans-serif; color: #a6adc8; }
.tc-pane-cover[hidden] { display: none; }
.tc-pane-log { flex: none; max-height: 34%; min-height: 0; overflow: auto; margin: 0; padding: 6px 10px; border-top: 1px solid #313244; background: #181825;
  font: 11.5px/1.45 ui-monospace, monospace; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
.tc-pane-log:empty { display: none; }
.tc-pane-log .bad { color: #f38ba8; }
.tc-pane-log .dim { color: #7f849c; }
`;

export interface AppPane {
  element: HTMLElement;
  /** The app's name, once its app.json has been read */
  name(): string;
  /** Run: load the page again, restarting the backend first */
  run(): Promise<string>;
  /** Share: the link for the folder's files, on the share screen */
  share(): Promise<void>;
  /** The app.json's problems as it is typed ([] when it has none) */
  problems(lines: string[]): void;
  dispose(): void;
}

export async function appPane(o: { fs: FileSystem; shell: Shell; dir: string; container: HTMLElement; onReload?: () => void }): Promise<AppPane> {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  const { fs, dir } = o;
  const el = document.createElement('div');
  el.className = 'tc-pane';
  el.dataset.appPane = dir;
  const box = document.createElement('div');
  box.className = 'tc-pane-frame';
  const cover = document.createElement('div');
  cover.className = 'tc-pane-cover';
  cover.setAttribute('role', 'status');
  box.append(cover);
  const log = document.createElement('pre');
  log.className = 'tc-pane-log';
  log.setAttribute('aria-label', 'What the app said');
  const typed = document.createElement('div');
  const said = document.createElement('div');
  log.append(typed, said);
  el.append(box, log);
  o.container.classList.add('tc-code-app');
  o.container.append(el);
  const narrow = new ResizeObserver(() => { o.container.classList.toggle('tc-narrow', o.container.clientWidth < 720); });
  narrow.observe(o.container);

  const cover$ = (text: string) => { cover.textContent = text; cover.hidden = !text; };
  const line = (text: string, cls = '') => {
    for (const l of text.replace(/\r\n/g, '\n').split('\n')) {
      if (!l.trim()) continue;
      const d = document.createElement('div');
      d.textContent = l;
      if (cls || /refused|not valid|failed|error/i.test(l)) d.className = cls || 'bad';
      said.append(d);
    }
    while (said.childElementCount > 200) said.firstElementChild!.remove();
    log.scrollTop = log.scrollHeight;
  };

  const [runtime, registry, { createAppFrame }, { watchAppDir }] = await Promise.all([import('./runtime'), import('./registry'), import('./frame'), import('./dev-watch')]);
  try { runtime.appsDeps(); } catch { runtime.configureApps({ fs, shell: o.shell }); }
  let inst: AppInstance | null = null;
  let frame: AppFrame | null = null;
  let gone = false;
  let stopWatch = () => {};
  let offLog = () => {};
  const view: AppView = { kind: 'pane', close: () => {}, reload: () => frame?.reload() };

  /** Start the app once its app.json is valid (now, or after a save that makes it so) */
  const begin = async (): Promise<void> => {
    if (inst || gone) return;
    let manifest;
    try { manifest = await registry.loadManifest(fs, dir); } catch (e) {
      cover$('The app starts once app.json is valid.');
      line((e as Error).message);
      return;
    }
    try { inst = runtime.instanceFor({ manifest, dir, source: `dev:${dir}`, dev: true }); } catch (e) { cover$((e as Error).message); return; }
    inst.attach(view);
    offLog = inst.on((ev, text) => {
      if (ev === 'reload') o.onReload?.();
      if (ev === 'log' && text) line(text);
      if (ev === 'state' && inst?.supervisor) line(`[app] backend ${inst.supervisor.state}${inst.supervisor.state === 'failed' ? `: ${inst.supervisor.error}` : ''}`, inst.supervisor.state === 'failed' ? 'bad' : 'dim');
    });
    stopWatch = watchAppDir(fs as unknown as WatchFs, dir, inst, (l) => line(l, /not valid/.test(l) ? 'bad' : 'dim'));
    cover$(`Starting ${manifest.name}…`);
    try {
      await inst.prepare((stage) => cover$(stage));
      if (!await inst.startBackend()) { cover$(`The backend did not start: ${inst.supervisor?.error ?? ''}`); return; }
      if (gone) return;
      frame = await createAppFrame(inst, { onError: (msg) => cover$(msg) });
      if (gone) { frame.dispose(); return; }
      box.append(frame.element);
      cover$('');
    } catch (e) { cover$((e as Error).message); }
  };
  // A folder whose app.json is not valid yet: the app starts on the first save that makes it valid
  const offWait = (fs as unknown as WatchFs).onChange((_ev, path) => { if (!inst && path === `${dir}/app.json`) void begin(); });
  void begin();

  return {
    element: el,
    name: () => inst?.manifest.name ?? '',
    async run() {
      if (!inst) { await begin(); return inst ? '' : 'The app starts once app.json is valid.'; }
      if (inst.supervisor) await inst.supervisor.restart();
      inst.reload();
      return `${inst.manifest.name} was loaded again.`;
    },
    async share() {
      const [{ shareFiles, collectAppFiles, siteOriginOf }, { showShareScreen }, { writeClipboard }, { guestInfo }] = await Promise.all([
        import('./share'), import('./share-ui'), import('../utils/clipboard'), import('../guest'),
      ]);
      const wm = (globalThis as { __shiroDesktop?: import('../desktop/wm').DesktopAPI }).__shiroDesktop ?? null;
      let shown: import('./share-ui').ShareShown;
      const origin = siteOriginOf(location, !!guestInfo());
      // A gist holds text files side by side: the app can be one when it is that (Save to a gist, as in the Studio)
      let texts: Record<string, string> | null = null;
      let name = '';
      try {
        const m = await registry.loadManifest(fs, dir);
        name = m.name;
        const files = await collectAppFiles(fs, dir);
        shown = await shareFiles(files, { id: m.id, name: m.name }, origin);
        texts = {};
        for (const [path, bytes] of files) {
          let text: string | null = null;
          try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { /* not text */ }
          if (path.includes('/') || text === null || text.includes('\0')) { texts = null; break; }
          texts[path] = text;
        }
      } catch (e) { shown = { name: inst?.manifest.name ?? 'The app', problem: (e as Error).message }; }
      let signedIn = false;
      try { signedIn = !!localStorage.getItem((await import('../github-auth')).GITHUB_TOKEN_KEY); } catch { /* no storage */ }
      let win: ReturnType<typeof showShareScreen> = null;
      win = showShareScreen(shown, wm, (t) => writeClipboard(t).catch(() => false), {
        qr: true,
        actions: (status) => {
          if (!signedIn || !texts || 'problem' in shown) return [];
          const gist = document.createElement('button');
          gist.type = 'button';
          gist.dataset.act = 'gist';
          gist.textContent = 'Save to a gist';
          gist.title = 'GitHub keeps the app as a secret gist of your account. The link then names the gist.';
          gist.addEventListener('click', () => {
            gist.disabled = true;
            status('The app is being sent to GitHub.');
            void import('../commands/link').then(({ saveGist }) => saveGist(texts!, name, origin)).then((g) => {
              win?.close(true);
              showShareScreen({ id: (shown as { id: string }).id, name, kind: 'gist', url: `${origin}/?app=gist:${g.id}`, repo: `gist.github.com/${g.id}`, asks: true }, wm, (t) => writeClipboard(t).catch(() => false), { qr: true });
            }, (e: unknown) => { status((e as Error)?.message ?? 'No gist was made.'); gist.disabled = false; });
          });
          return [gist];
        },
      });
    },
    problems(lines) {
      typed.replaceChildren(...lines.map((l) => { const d = document.createElement('div'); d.className = 'bad'; d.textContent = `app.json: ${l}`; return d; }));
    },
    dispose() {
      gone = true;
      narrow.disconnect();
      offWait();
      stopWatch();
      offLog();
      frame?.dispose();
      // (the last view takes the backend with it)
      inst?.detach(view);
      el.remove();
      o.container.classList.remove('tc-code-app', 'tc-narrow');
    },
  };
}
