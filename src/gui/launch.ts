/**
 * Starting a Debian GUI app, with its stages reported to the desktop
 * (src/desktop/launch-state.ts; docs/DESKTOP.md "Launch feedback"): the dock
 * icon, the Apps window's Open, the launcher, `desktop open APP` and `gui APP`
 * all come through here.
 *
 *   requested   → is it installed?
 *   installing  → apps.installApp: bytes of packages unpacked / bytes to install
 *                 (Debian mode: apt's output, no amount)
 *   starting    → the x86-64 process exists (its output is the launch's log)
 *   window      → a client connected to Xshiro since, or the app's splash mapped
 *   running     → its first window mapped (the window manager reports it)
 *
 * No time limit ends a launch: only the process exiting without a window,
 * a failed install, or the person closing the placeholder.
 *
 * Without a desktop (the classic terminal UI) there is nothing to report to
 * and the app is just installed and started.
 */
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';
import type { Launch, LaunchStage, LaunchTracker } from '../desktop/launch-state';
import type { InstallProgress, LaunchedApp } from './apps';

export interface GuiLaunchOptions {
  /** The app's display name and icon (default: its id) */
  name?: string;
  icon?: string;
  /** One line shown while it starts ("first start takes a few minutes") */
  note?: string;
  args?: string[];
  onProgress?: (p: InstallProgress) => void;
  /** The installer's log lines */
  log?: (line: string) => void;
  /** Called once an install finished (the dock registers the app) */
  installed?: () => void;
}

export type GuiLaunchResult =
  | { status: 'started'; app: LaunchedApp }
  /** It was already starting: nothing new was started */
  | { status: 'busy' }
  | { status: 'cancelled' }
  | { status: 'failed'; error: string };

/**
 * First-window sizes (client area, CSS px) for apps whose window is far from
 * the default. Guesses from the apps' usual first windows, not measurements:
 * after one run the remembered size is used instead (launch-state.ts).
 */
const SIZE_GUESS: Record<string, [number, number]> = {
  gimp: [1000, 680], inkscape: [1000, 700], krita: [1000, 700], 'firefox-esr': [1000, 700], thunderbird: [1000, 700],
  'libreoffice-writer': [1000, 700], geany: [900, 600], gnumeric: [900, 600], abiword: [900, 600], audacity: [900, 600],
  l3afpad: [640, 480], mousepad: [640, 480], featherpad: [700, 500], gedit: [760, 560],
  xterm: [484, 316], qterminal: [640, 420], xeyes: [150, 100], xclock: [164, 164], xcalc: [226, 304], xedit: [500, 400],
  galculator: [320, 260], kcalc: [360, 320], dillo: [780, 580],
};

type AppsModule = Pick<typeof import('./apps'), 'isAppInstalled' | 'installApp' | 'launchApp'>;
let appsOverride: AppsModule | null = null;

/** Tests: a stand-in for the installer and the process (src/gui/apps.ts); null: the real one */
export function configureGuiLaunch(o: { apps?: AppsModule | null }): void {
  if (o.apps !== undefined) appsOverride = o.apps;
}

function tracker(): LaunchTracker | null {
  const d = (globalThis as { __shiroDesktop?: { launches?: LaunchTracker } }).__shiroDesktop;
  return d?.launches ?? null;
}

/** A wait status in words */
export function exitWords(st: number): string {
  const sig = st & 0x7f;
  if (sig) return `killed by signal ${sig}`;
  return `exit status ${(st >> 8) & 0xff}`;
}

const SIGTERM = 15, SIGKILL = 9;

/**
 * Install `id` if needed, then start it. The launch is asked for before
 * anything is awaited, so a caller can tell at once whether it was fresh.
 */
export function startGuiApp(fs: FileSystem, kernel: Kernel, id: string, o: GuiLaunchOptions = {}): Promise<GuiLaunchResult> {
  const name = o.name ?? id;
  const t = tracker();
  let launch: Launch | null = null;
  let app: LaunchedApp | null = null;
  if (t) {
    const size = SIZE_GUESS[id];
    const r = t.request({
      id, name, icon: o.icon, note: o.note, placeholder: true,
      size: size ? { width: size[0], height: size[1] } : undefined,
      retry: () => { void startGuiApp(fs, kernel, id, o); },
      onCancel: (stage: LaunchStage) => {
        if (stage === 'requested' || stage === 'installing') {
          // Stopping an unpack (or apt) half way would leave packages half installed: it runs on
          return stage === 'installing'
            ? `${name} won't open. Its install finishes in the background, so nothing is left half-installed; open it again when you want it.`
            : `${name} won't open.`;
        }
        if (app) stop(kernel, app.pid);
        return `${name} was stopped before it opened a window.`;
      },
    });
    if (!r.fresh) return Promise.resolve({ status: 'busy' });
    launch = r.launch;
  }
  return run();

  async function run(): Promise<GuiLaunchResult> {
    const apps: AppsModule = appsOverride ?? await import('./apps');
    try {
      const installed = await apps.isAppInstalled(fs, id);
      // (cancelled before anything began)
      if (launch && !launch.active) return { status: 'cancelled' };
      if (!installed) {
        launch?.installing();
        await apps.installApp(fs, kernel, id, (p) => {
          if (p.phase === 'triggers' || p.phase === 'done') launch?.installing(null, 'Setting up…');
          else launch?.installing(p.totalBytes > 0 ? { done: p.doneBytes ?? 0, total: p.totalBytes, unit: 'bytes' } : null);
          o.onProgress?.(p);
        }, (line) => { launch?.log(line + '\n'); o.log?.(line); });
        o.installed?.();
      }
    } catch (e) {
      const error = `Could not install ${name}: ${(e as Error).message}`;
      launch?.fail(error);
      return { status: 'failed', error };
    }
    // (cancelled while installing: installed, not started)
    if (launch && !launch.active) return { status: 'cancelled' };
    launch?.starting();
    try {
      app = await apps.launchApp(kernel, id, o.args ?? [], {}, launch ? { onOutput: (s) => launch!.log(s) } : {});
    } catch (e) {
      const error = `Could not start ${name}: ${(e as Error).message}`;
      launch?.fail(error);
      return { status: 'failed', error };
    }
    if (!launch) return { status: 'started', app };
    // (cancelled while the session bus came up: the process just made goes too)
    if (!launch.active) { stop(kernel, app.pid); return { status: 'cancelled' }; }
    launch.pid = app.pid;
    watch(launch, app);
    return { status: 'started', app };
  }

  /** Until the first window: the display connection, and the process ending without one */
  function watch(l: Launch, a: LaunchedApp): void {
    const clients = () => (globalThis as { __shiroX?: { server?: { clients?: { size: number } } } }).__shiroX?.server?.clients?.size ?? 0;
    const before = clients();
    const poll = setInterval(() => {
      if (!l.active) { clearInterval(poll); return; }
      // a client connected since the app started: its own, or a helper's on its behalf
      if (l.stage === 'starting' && clients() > before) l.window();
    }, 500);
    void a.exited.then((st) => {
      clearInterval(poll);
      if (!l.active) return;
      const d = (globalThis as { __shiroDesktop?: { windows(): { appId?: string; id: string; options: { override?: boolean }; focus(): void }[] } }).__shiroDesktop;
      const open = d?.windows().filter((w) => w.appId === id && !w.options.override && !w.id.startsWith('launching-')) ?? [];
      // A single-instance app handed over to the one already running
      if (st === 0 && open.length) { open[open.length - 1].focus(); l.running(open[open.length - 1]); return; }
      l.fail(`${name} quit before opening a window (${exitWords(st)}).`);
    });
  }
}

/**
 * End an app that has no window yet, with the processes it started (GIMP's
 * plug-ins, LibreOffice's soffice.bin): SIGTERM, then SIGKILL for what is left.
 */
function stop(kernel: Kernel, pid: number): void {
  const family = (): number[] => {
    const out = [pid];
    for (let i = 0; i < out.length; i++) for (const p of kernel.procs.values()) if (p.ppid === out[i] && !out.includes(p.pid)) out.push(p.pid);
    return out.filter((p) => kernel.procs.has(p));
  };
  for (const p of family().reverse()) { try { kernel.kill(p, SIGTERM); } catch { /* gone */ } }
  setTimeout(() => { for (const p of family().reverse()) { try { kernel.kill(p, SIGKILL); } catch { /* gone */ } } }, 2000);
}
