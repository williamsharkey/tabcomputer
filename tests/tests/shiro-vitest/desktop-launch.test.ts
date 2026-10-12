/**
 * Launch feedback (docs/DESKTOP.md "Launch feedback"): the launch state
 * machine (src/desktop/launch-state.ts), the window manager's part (openApp,
 * windows opened behind the others, an app's first window ending its launch),
 * the Debian GUI launch path (src/gui/launch.ts) with a stand-in installer
 * and process, and the placeholder windows (src/desktop/launch-ui.ts), on
 * linkedom.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LaunchTracker, launches, elapsedText, placeholderId, isPlaceholder,
  rememberGeometry, rememberedGeometry, reservedGeometry, GEOMETRY_KEY, LAUNCH_LOG_LINES, type LaunchEvent,
} from '@shiro/desktop/launch-state';
import { WindowManager } from '@shiro/desktop/wm';
import { configureGuiLaunch, exitWords, startGuiApp } from '@shiro/gui/launch';
import { initLaunchUI } from '@shiro/desktop/launch-ui';

if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
  };
}
if (!(globalThis as any).requestAnimationFrame) (globalThis as any).requestAnimationFrame = (f: () => void) => setTimeout(f, 0);

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const click = (el: Element | null | undefined) => (el as HTMLElement).click();

describe('launch state machine', () => {
  let t: LaunchTracker;
  let events: string[];
  beforeEach(() => {
    t = new LaunchTracker();
    events = [];
    t.on((ev, l) => events.push(`${ev}:${l.stage}`));
  });

  it('goes requested → installing → starting → window → running, and ends', () => {
    const { launch: l, fresh } = t.request({ id: 'gimp', name: 'GIMP', placeholder: true });
    expect(fresh).toBe(true);
    expect([l.stage, l.active, t.starting('gimp'), l.text()]).toEqual(['requested', true, true, 'Preparing…']);
    expect(l.fraction()).toBeNull();

    expect(l.installing({ done: 0, total: 43e6, unit: 'bytes' })).toBe(true);
    expect(l.text()).toBe('Installing 43 MB…');
    expect(l.fraction()).toBe(0);
    l.installing({ done: 21.5e6, total: 43e6, unit: 'bytes' });
    expect(l.fraction()).toBe(0.5);
    expect(l.amountText()).toBe('22 of 43 MB');
    // the amount isn't known while the triggers run: no number at all
    l.installing(null, 'Setting up…');
    expect([l.text(), l.fraction(), l.amountText()]).toEqual(['Setting up…', null, '']);

    expect(l.starting(42)).toBe(true);
    expect([l.stage, l.pid, l.text(), l.fraction()]).toEqual(['starting', 42, 'Starting…', null]);
    expect(l.window()).toBe(true);
    expect(l.text()).toBe('Opening window…');
    const win = { id: 'w1' };
    expect(l.running(win)).toBe(true);
    expect([l.stage, l.active, l.firstWindow]).toEqual(['running', false, win]);
    // over: out of the tracker, and nothing changes it any more
    expect(t.get('gimp')).toBeUndefined();
    expect(t.starting('gimp')).toBe(false);
    expect(l.fail('late')).toBe(false);
    expect(l.installing()).toBe(false);
    expect(l.cancel()).toBe('');
    expect(l.stage).toBe('running');
    expect(events).toEqual([
      'request:requested', 'stage:installing', 'progress:installing', 'progress:installing', 'progress:installing',
      'stage:starting', 'stage:window', 'stage:running', 'end:running',
    ]);
  });

  it('only moves forward; an installed app skips installing', () => {
    const { launch: l } = t.request({ id: 'xeyes', name: 'xeyes' });
    expect(l.starting()).toBe(true);
    expect(l.installing({ done: 1, total: 2, unit: 'bytes' })).toBe(false);
    expect(l.stage).toBe('starting');
    expect(l.window()).toBe(true);
    expect(l.starting()).toBe(false);
    expect(l.stage).toBe('window');
    // the same progress twice says nothing twice
    const { launch: m } = t.request({ id: 'other', name: 'Other' });
    events.length = 0;
    m.installing({ done: 1, total: 4, unit: 'items' });
    m.installing({ done: 1, total: 4, unit: 'items' });
    expect(events).toEqual(['stage:installing', 'progress:installing']);
    expect([m.text(), m.amountText()]).toEqual(['Installing 4 packages…', '1 of 4']);
  });

  it('a failure ends the launch, unless a UI holds it to show the error', () => {
    const a = t.request({ id: 'a', name: 'A', placeholder: true }).launch;
    a.starting();
    expect(a.fail('A quit before opening a window (exit status 1).')).toBe(true);
    expect([a.stage, a.active, a.text()]).toEqual(['failed', false, 'A quit before opening a window (exit status 1).']);
    expect(t.get('a')).toBeUndefined();

    t.holdFailed = true;
    const b = t.request({ id: 'b', name: 'B', placeholder: true }).launch;
    b.fail('no');
    expect(t.get('b')).toBe(b);
    // asked for again while the failure shows: the same launch, nothing started
    const again = t.request({ id: 'b', name: 'B', placeholder: true });
    expect([again.fresh, again.launch]).toEqual([false, b]);
    t.dismiss(b);
    expect(t.get('b')).toBeUndefined();
    expect(t.request({ id: 'b', name: 'B', placeholder: true }).fresh).toBe(true);
    // a launch without a placeholder has nowhere to show a failure: it just ends
    const c = t.request({ id: 'c', name: 'C' }).launch;
    c.fail('chunk failed to load');
    expect(t.get('c')).toBeUndefined();
  });

  it('cancel runs the launcher’s onCancel with the stage it was in, once', () => {
    const seen: string[] = [];
    const { launch: l } = t.request({ id: 'gimp', name: 'GIMP', onCancel: (stage) => { seen.push(stage); return `stopped while ${stage}`; } });
    l.installing();
    expect(l.cancel()).toBe('stopped while installing');
    expect([l.stage, l.cancelNote, l.active]).toEqual(['cancelled', 'stopped while installing', false]);
    expect(l.cancel()).toBe('');
    expect(seen).toEqual(['installing']);
    expect(t.get('gimp')).toBeUndefined();
    // the install it left running finishes later: nothing happens to the cancelled launch
    expect(l.starting()).toBe(false);
    expect(l.running()).toBe(false);
    expect(events.slice(-2)).toEqual(['stage:cancelled', 'end:cancelled']);
  });

  it('a second request while one is in flight starts nothing', () => {
    const first = t.request({ id: 'gimp', name: 'GIMP' });
    const second = t.request({ id: 'gimp', name: 'GIMP' });
    expect([first.fresh, second.fresh, second.launch === first.launch, first.launch.requests]).toEqual([true, false, true, 2]);
    expect(events).toEqual(['request:requested', 'again:requested']);
    expect(t.list().length).toBe(1);
    // another app is its own launch
    expect(t.request({ id: 'geany', name: 'Geany' }).fresh).toBe(true);
    // once it is running, a request is a new launch (a second instance is the app's business)
    first.launch.running();
    expect(t.request({ id: 'gimp', name: 'GIMP' }).fresh).toBe(true);
  });

  it('keeps output as lines: the newest one, a bounded log, no control sequences', () => {
    const { launch: l } = t.request({ id: 'apt', name: 'apt' });
    l.log('Reading package lists...\nBuilding dep');
    expect(l.lines).toEqual(['Reading package lists...']);
    expect(l.lastLine()).toBe('Building dep');
    l.log('endency tree...\n\x1b[32mUnpacking\x1b[0m gimp\r\n');
    expect(l.lines).toEqual(['Reading package lists...', 'Building dependency tree...', 'Unpacking gimp']);
    // a progress line rewritten with \r: its last version
    l.log('10%\r50%\r100%\n');
    expect(l.lastLine()).toBe('100%');
    for (let i = 0; i < LAUNCH_LOG_LINES + 50; i++) l.log(`line ${i}\n`);
    expect(l.lines.length).toBe(LAUNCH_LOG_LINES);
    expect(l.lastLine()).toBe(`line ${LAUNCH_LOG_LINES + 49}`);
    // what was left unfinished when it failed is kept
    l.log('Segmentation fault');
    l.fail('quit');
    expect(l.lines[l.lines.length - 1]).toBe('Segmentation fault');
  });

  it('an app’s first window ends its launch; a splash, a menu, a dialog or the placeholder does not', () => {
    let created: ((w?: any) => void) | null = null;
    const off = t.attach({ on: (_ev, cb) => { created = cb; return () => { created = null; }; } });
    const { launch: l } = t.request({ id: 'gimp', name: 'GIMP', placeholder: true });
    l.starting();
    created!({ id: placeholderId('gimp'), appId: 'gimp', options: {} });
    created!({ id: 'w1', appId: 'gimp', options: { override: true } });
    created!({ id: 'w2', appId: 'gimp', options: { transientFor: 'w0' } });
    created!({ id: 'w3', appId: 'other', options: {} });
    expect(l.stage).toBe('starting');
    created!({ id: 'w4', appId: 'gimp', options: { splash: true } });
    expect(l.stage).toBe('window');
    const main = { id: 'w5', appId: 'gimp', options: {} };
    created!(main);
    expect([l.stage, l.firstWindow]).toEqual(['running', main]);
    off();
    expect(created).toBeNull();
    expect([isPlaceholder({ id: placeholderId('a.b') }), isPlaceholder({ id: 'w1' })]).toEqual([true, false]);
  });

  it('formats elapsed time and exit statuses', () => {
    expect([elapsedText(0), elapsedText(42_900), elapsedText(185_000)]).toEqual(['0:00', '0:42', '3:05']);
    expect([exitWords(1 << 8), exitWords(0), exitWords(11)]).toEqual(['exit status 1', 'exit status 0', 'killed by signal 11']);
  });
});

describe('where an app’s window was', () => {
  beforeEach(() => localStorage.removeItem(GEOMETRY_KEY));
  const wa = { width: 1000, height: 600 };

  it('reserves the last geometry, else a guess that fits, never off screen', () => {
    expect(reservedGeometry('gimp', { width: 1000, height: 680 }, wa)).toEqual({ width: 976, height: 538, remembered: false });
    expect(reservedGeometry('nothing', undefined, wa)).toEqual({ width: 800, height: 538, remembered: false });
    rememberGeometry('gimp', { x: 40.4, y: 20, width: 700, height: 420 });
    expect(rememberedGeometry('gimp')).toEqual({ x: 40, y: 20, width: 700, height: 420 });
    expect(reservedGeometry('gimp', { width: 1000, height: 680 }, wa)).toEqual({ x: 40, y: 20, width: 700, height: 420, remembered: true });
    // remembered on a bigger screen: it no longer fits here, so the guess again
    expect(reservedGeometry('gimp', { width: 300, height: 200 }, { width: 360, height: 500 })).toEqual({ width: 300, height: 200, remembered: false });
    // a phone: the guess fits the work area
    expect(reservedGeometry('geany', { width: 900, height: 600 }, { width: 360, height: 560 })).toEqual({ width: 336, height: 498, remembered: false });
    rememberGeometry('bad', { x: NaN, y: 0, width: 10, height: 10 });
    expect(rememberedGeometry('bad')).toBeNull();
    localStorage.setItem(GEOMETRY_KEY, 'not json');
    expect(rememberedGeometry('gimp')).toBeNull();
  });
});

describe('window manager and launches', () => {
  let wm: WindowManager;
  beforeEach(() => {
    for (const l of launches.list()) { if (l.active) l.cancel(); else launches.dismiss(l); }
    launches.holdFailed = false;
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    wm = new WindowManager(root, { workArea: () => ({ x: 0, y: 30, width: 1000, height: 600 }) });
  });

  it('opens a window behind the others without taking focus', () => {
    const a = wm.createWindow({ title: 'A' });
    const b = wm.createWindow({ title: 'B' });
    const back = wm.createWindow({ title: 'Behind', behind: true, focus: false });
    expect(wm.windows().map((w) => w.title)).toEqual(['Behind', 'A', 'B']);
    expect(wm.focused()).toBe(b);
    expect(Number(back.element.style.zIndex)).toBeLessThan(Number(a.element.style.zIndex));
    back.focus();
    expect(wm.windows().map((w) => w.title)).toEqual(['A', 'B', 'Behind']);
  });

  it('tracks a lazily loaded app from the request to its window, and starts it once', async () => {
    let started = 0;
    let finish!: () => void;
    const loaded = new Promise<void>((r) => { finish = r; });
    wm.registerApp({ id: 'files', name: 'Files', launch: async () => { started++; await loaded; return wm.createWindow({ appId: 'files', title: 'Files' }); } });
    const seen: string[] = [];
    const off = wm.launches.on((ev, l) => seen.push(`${ev}:${l.id}:${l.stage}`));
    const first = wm.openApp('files');
    expect(wm.launches.starting('files')).toBe(true);
    // asked for again while its module loads: not started twice
    const second = await wm.openApp('files');
    expect([started, second]).toEqual([1, null]);
    finish();
    const w = await first;
    expect(w?.appId).toBe('files');
    expect(wm.launches.starting('files')).toBe(false);
    expect(seen).toEqual(['request:files:requested', 'again:files:requested', 'stage:files:running', 'end:files:running']);
    // running: the app decides what another request means (here: another window)
    await wm.openApp('files');
    expect([started, wm.windows().filter((x) => x.appId === 'files').length]).toEqual([2, 2]);
    off();
  });

  it('does not track an app that opens at once (a second Terminal is normal)', async () => {
    const seen: LaunchEvent[] = [];
    const off = wm.launches.on((ev) => seen.push(ev));
    wm.registerApp({ id: 'terminal', name: 'Terminal', launch: () => wm.createWindow({ appId: 'terminal', title: 'Terminal' }) });
    await wm.openApp('terminal');
    await wm.openApp('terminal');
    expect(wm.windows().filter((w) => w.appId === 'terminal').length).toBe(2);
    expect(seen).toEqual([]);
    off();
  });

  it('a lazy app that fails to load ends its launch, so the next request tries again', async () => {
    let n = 0;
    wm.registerApp({ id: 'broken', name: 'Broken', launch: async () => { n++; throw new Error('chunk failed'); } });
    await expect(wm.openApp('broken')).rejects.toThrow('chunk failed');
    expect(wm.launches.get('broken')).toBeUndefined();
    await expect(wm.openApp('broken')).rejects.toThrow('chunk failed');
    expect(n).toBe(2);
  });
});

/** A stand-in for src/gui/apps.ts: an installer and a process the test drives */
function fakeApps(opts: { installed?: boolean } = {}) {
  const state = {
    installed: !!opts.installed, installs: 0, spawns: 0, killed: [] as [number, number][],
    progress: null as null | ((p: any) => void), log: null as null | ((s: string) => void), output: null as null | ((s: string) => void),
    finishInstall: null as null | ((err?: Error) => void), exit: null as null | ((st: number) => void),
  };
  const apps = {
    isAppInstalled: async () => state.installed,
    installApp: (_fs: unknown, _k: unknown, _name: string, onProgress?: (p: any) => void, log?: (s: string) => void) => {
      state.installs++;
      state.progress = onProgress ?? null;
      state.log = log ?? null;
      return new Promise<any>((res, rej) => { state.finishInstall = (err) => { if (err) rej(err); else { state.installed = true; res({}); } }; });
    },
    launchApp: async (_k: unknown, _name: string, _args?: string[], _env?: unknown, o?: { onOutput?: (s: string) => void }) => {
      state.spawns++;
      state.output = o?.onOutput ?? null;
      return { pid: 100 + state.spawns, exited: new Promise<number>((r) => { state.exit = r; }), output: () => '' };
    },
  };
  const procs = new Map<number, { pid: number; ppid: number }>([[101, { pid: 101, ppid: 1 }], [150, { pid: 150, ppid: 101 }], [102, { pid: 102, ppid: 1 }]]);
  const kernel = { procs, kill: (pid: number, sig: number) => { state.killed.push([pid, sig]); procs.delete(pid); return 0; } };
  configureGuiLaunch({ apps: apps as any });
  return { state, kernel: kernel as any };
}

describe('the Debian GUI launch path, with a stand-in installer and process', () => {
  let wm: WindowManager;
  let toasts: string[];
  let stopUI: (() => void) | undefined;
  const fs = {} as any;
  beforeEach(() => {
    for (const l of launches.list()) { if (l.active) l.cancel(); else launches.dismiss(l); }
    stopUI?.();
    localStorage.removeItem(GEOMETRY_KEY);
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    wm = new WindowManager(root, { workArea: () => ({ x: 0, y: 30, width: 1000, height: 600 }) });
    (globalThis as any).__shiroDesktop = wm;
    launches.holdFailed = true;
    toasts = [];
    stopUI = initLaunchUI(wm, launches, { toast: (s) => toasts.push(s) });
  });
  // (a window left open would have its geometry remembered during the next test)
  afterEach(() => { for (const w of wm.windows()) w.close(true); });
  const placeholder = () => wm.get(placeholderId('gimp'));
  const el = (sel: string) => placeholder()?.body.querySelector(sel) as HTMLElement | null;
  const text = (sel: string) => el(sel)?.textContent ?? null;
  const hidden = (sel: string) => el(sel)?.hidden;

  it('installs, starts, and hands the placeholder’s place to the app’s window', async () => {
    const f = fakeApps();
    const term = wm.createWindow({ appId: 'terminal', title: 'Terminal' });
    const installed = vi.fn();
    const result = startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP', note: 'first start takes a few minutes', installed });
    const l = launches.get('gimp')!;
    expect(l.stage).toBe('requested');
    await tick(5);
    expect([l.stage, f.state.installs]).toEqual(['installing', 1]);
    // an install is never instant: the placeholder is there at once, behind, unfocused, out of the dock's running list
    const ph = placeholder()!;
    expect(ph).toBeTruthy();
    expect(wm.windows()[0]).toBe(ph);
    expect(wm.focused()).toBe(term);
    expect([ph.options.skipTaskbar, ph.appId, ph.element.classList.contains('sd-launch-win')]).toEqual([true, 'gimp', true]);
    expect([text('.sd-launch-name'), text('.sd-launch-stage')]).toEqual(['GIMP', 'Installing…']);
    const bar = el('.sd-launch-bar')!;
    expect([bar.classList.contains('sd-indeterminate'), bar.hasAttribute('aria-valuenow')]).toEqual([true, false]);

    f.state.progress!({ phase: 'unpack', done: 10, total: 83, bytes: 5e6, totalBytes: 53e6, doneBytes: 26.5e6 });
    f.state.log!('trigger glib-compile-schemas: status 0 in 812 ms');
    await tick(20);
    expect([l.fraction(), text('.sd-launch-stage'), text('.sd-launch-amount')]).toEqual([0.5, 'Installing 53 MB…', '27 of 53 MB']);
    expect([bar.classList.contains('sd-indeterminate'), bar.getAttribute('aria-valuenow'), (bar.firstElementChild as HTMLElement).style.width]).toEqual([false, '50', '50.0%']);
    expect([text('.sd-launch-last'), hidden('.sd-launch-more'), hidden('.sd-launch-log')]).toEqual(['trigger glib-compile-schemas: status 0 in 812 ms', false, true]);
    click(el('.sd-launch-more'));
    expect([hidden('.sd-launch-log'), text('.sd-launch-log'), el('.sd-launch-more')!.getAttribute('aria-expanded')]).toEqual([false, 'trigger glib-compile-schemas: status 0 in 812 ms', 'true']);
    f.state.progress!({ phase: 'triggers', done: 83, total: 83, bytes: 53e6, totalBytes: 53e6, doneBytes: 53e6 });
    await tick(20);
    expect([text('.sd-launch-stage'), bar.classList.contains('sd-indeterminate')]).toEqual(['Setting up…', true]);

    f.state.finishInstall!();
    expect((await result).status).toBe('started');
    expect([l.stage, l.pid, f.state.spawns]).toEqual(['starting', 101, 1]);
    expect(installed).toHaveBeenCalledTimes(1);
    f.state.output!('gimp: loading plug-ins\n');
    await tick(20);
    expect([text('.sd-launch-stage'), hidden('.sd-launch-note'), text('.sd-launch-note')]).toEqual(['Starting…', false, 'first start takes a few minutes']);
    expect(l.lastLine()).toBe('gimp: loading plug-ins');

    // its splash: the placeholder stays, saying so
    const splash = wm.createWindow({ appId: 'gimp', title: 'GIMP Startup', decorations: 'none', splash: true, width: 300, height: 200 });
    expect([l.stage, placeholder()?.state]).toEqual(['window', 'normal']);
    await tick(20);
    expect(text('.sd-launch-stage')).toBe('Opening window…');
    // the person moved the placeholder meanwhile: the app's window goes there
    ph.setGeometry({ x: 120, y: 60, width: 640, height: 400 });
    splash.close(true);
    expect(l.stage).toBe('window');
    const main = wm.createWindow({ appId: 'gimp', title: 'GNU Image Manipulation Program', width: 500, height: 300 });
    expect(l.stage).toBe('running');
    expect(main.geometry()).toEqual({ x: 120, y: 60, width: 640, height: 400 });
    expect([placeholder(), main.element.classList.contains('sd-opening'), wm.focused()]).toEqual([undefined, false, main]);
    expect(launches.get('gimp')).toBeUndefined();
    // where it is now is where the next placeholder will be
    main.move(200, 80);
    await tick(450);
    expect(rememberedGeometry('gimp')).toEqual({ x: 200, y: 80, width: 640, height: 400 });
    // the process ending later is not a failed launch
    f.state.exit!(0);
    await tick(5);
    expect(launches.get('gimp')).toBeUndefined();
  });

  it('an installed app goes straight to starting; a guessed size is not forced on the app', async () => {
    const f = fakeApps({ installed: true });
    const r = await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    expect([r.status, launches.get('gimp')!.stage, f.state.installs]).toEqual(['started', 'starting', 0]);
    // not shown for the first quarter second (a quick app never flashes one)
    expect(placeholder()).toBeUndefined();
    await tick(300);
    const ph = placeholder()!;
    const at = ph.geometry();
    expect([at.width, at.height]).toEqual([976, 538]); // gimp's guess, fitted to this work area
    const main = wm.createWindow({ appId: 'gimp', title: 'GIMP', width: 500, height: 300 });
    const g = main.geometry();
    expect([g.x, g.y, g.width, g.height]).toEqual([at.x, at.y, 500, 300]);
    expect(placeholder()).toBeUndefined();
  });

  it('reserves the remembered geometry and gives it to the app', async () => {
    rememberGeometry('gimp', { x: 30, y: 40, width: 720, height: 450 });
    const f = fakeApps({ installed: true });
    await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    await tick(300);
    expect(placeholder()!.geometry()).toEqual({ x: 30, y: 40, width: 720, height: 450 });
    const main = wm.createWindow({ appId: 'gimp', title: 'GIMP', width: 500, height: 300 });
    expect(main.geometry()).toEqual({ x: 30, y: 40, width: 720, height: 450 });
    // an app whose window can't be resized keeps its size
    main.close(true);
    rememberGeometry('gimp', { x: 30, y: 40, width: 720, height: 450 });
    await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    await tick(300);
    const fixed = wm.createWindow({ appId: 'gimp', title: 'GIMP', width: 500, height: 300, resizable: false });
    expect(fixed.geometry()).toEqual({ x: 30, y: 40, width: 500, height: 300 });
  });

  it('a second request focuses and flashes the placeholder instead of starting a copy', async () => {
    const f = fakeApps({ installed: true });
    const term = wm.createWindow({ appId: 'terminal', title: 'Terminal' });
    wm.registerApp({ id: 'gimp', name: 'GIMP', launch: () => { void startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' }); return null; } });
    expect(await wm.openApp('gimp')).toBeNull();
    await tick(5);
    expect(f.state.spawns).toBe(1);
    // from the dock, a stack, the launcher or `desktop open`: all wm.openApp
    const again = await wm.openApp('gimp');
    expect([again?.id, f.state.spawns, wm.focused()?.id]).toEqual([placeholderId('gimp'), 1, placeholderId('gimp')]);
    expect(again!.element.classList.contains('sd-launch-flash')).toBe(true);
    // from `gui gimp`
    term.focus();
    expect(await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' })).toEqual({ status: 'busy' });
    expect([f.state.spawns, wm.focused()?.id, launches.get('gimp')!.requests]).toEqual([1, placeholderId('gimp'), 3]);
    // once its window is up, asking again is a new launch (a second instance is the app's call)
    wm.createWindow({ appId: 'gimp', title: 'GIMP' });
    expect((await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' })).status).toBe('started');
    expect(f.state.spawns).toBe(2);
  });

  it('a process that exits before a window: the placeholder says so, with Close and Retry', async () => {
    const f = fakeApps({ installed: true });
    const term = wm.createWindow({ appId: 'terminal', title: 'Terminal' });
    await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    f.state.output!('gimp: error while loading shared libraries: libfoo.so.1\n');
    f.state.exit!(127 << 8);
    await tick(5);
    const l = launches.get('gimp')!;
    expect([l.stage, l.error]).toEqual(['failed', 'GIMP quit before opening a window (exit status 127).']);
    // shown even though the launch was quicker than the placeholder's delay; in front, the keyboard left alone
    const ph = placeholder()!;
    expect(wm.windows()[wm.windows().length - 1]).toBe(ph);
    expect(wm.focused()).toBe(term);
    expect([text('.sd-launch-error'), hidden('.sd-launch-error'), hidden('.sd-launch-stage'), hidden('.sd-launch-bar')]).toEqual(['GIMP quit before opening a window (exit status 127).', false, true, true]);
    expect([hidden('.sd-launch-log'), text('.sd-launch-log')]).toEqual([false, 'gimp: error while loading shared libraries: libfoo.so.1']);
    expect([hidden('[data-act=cancel]'), hidden('[data-act=close]'), hidden('[data-act=retry]')]).toEqual([true, false, false]);
    expect(ph.title).toBe('GIMP did not start');
    // asked for again: the failure, not another silent try
    expect(await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' })).toEqual({ status: 'busy' });
    expect(f.state.spawns).toBe(1);
    // Retry starts it again
    click(el('[data-act=retry]'));
    await tick(5);
    expect([f.state.spawns, launches.get('gimp')!.stage, launches.get('gimp') === l]).toEqual([2, 'starting', false]);
    // …and Close on a failure forgets it
    f.state.exit!(1 << 8);
    await tick(5);
    click(el('[data-act=close]'));
    expect([launches.get('gimp'), placeholder(), toasts]).toEqual([undefined, undefined, []]);
  });

  it('a failed install is a failed launch, with the reason', async () => {
    const f = fakeApps();
    const result = startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    await tick(5);
    f.state.finishInstall!(new Error('pool/main/g/gimp/gimp_2.10.deb: HTTP 502'));
    expect(await result).toEqual({ status: 'failed', error: 'Could not install GIMP: pool/main/g/gimp/gimp_2.10.deb: HTTP 502' });
    expect([launches.get('gimp')!.stage, f.state.spawns, text('.sd-launch-error')]).toEqual(['failed', 0, 'Could not install GIMP: pool/main/g/gimp/gimp_2.10.deb: HTTP 502']);
  });

  it('closing the placeholder while it installs: the install finishes, the app is not started', async () => {
    const f = fakeApps();
    const result = startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    await tick(5);
    placeholder()!.close();
    expect([launches.get('gimp'), placeholder()]).toEqual([undefined, undefined]);
    expect(toasts).toEqual(['GIMP won\'t open. Its install finishes in the background, so nothing is left half-installed; open it again when you want it.']);
    expect(f.state.killed).toEqual([]);
    f.state.finishInstall!();
    expect(await result).toEqual({ status: 'cancelled' });
    expect([f.state.spawns, f.state.installed]).toEqual([0, true]);
    // the next request starts it without installing again
    expect((await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' })).status).toBe('started');
    expect([f.state.installs, f.state.spawns]).toEqual([1, 1]);
  });

  it('closing the placeholder while it starts ends the process and its children', async () => {
    const f = fakeApps({ installed: true });
    await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    await tick(300);
    click(el('[data-act=cancel]'));
    expect(toasts).toEqual(['GIMP was stopped before it opened a window.']);
    // the child first, then the app (pid 101); the other process is left alone
    expect(f.state.killed).toEqual([[150, 15], [101, 15]]);
    expect([launches.get('gimp'), placeholder()]).toEqual([undefined, undefined]);
    // its exit after that is not reported as a failure
    f.state.exit!(15);
    await tick(5);
    expect(launches.get('gimp')).toBeUndefined();
  });

  it('a single-instance app that hands over to its running window just focuses it', async () => {
    const f = fakeApps({ installed: true });
    const open = wm.createWindow({ appId: 'gimp', title: 'GIMP' });
    wm.createWindow({ appId: 'terminal', title: 'Terminal' });
    await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    f.state.exit!(0);
    await tick(5);
    expect([launches.get('gimp'), wm.focused(), placeholder()]).toEqual([undefined, open, undefined]);
  });

  it('on a phone the placeholder is the window in front, and fills the work area', async () => {
    const f = fakeApps({ installed: true });
    wm.createWindow({ appId: 'terminal', title: 'Terminal' });
    wm.compact = true;
    await startGuiApp(fs, f.kernel, 'gimp', { name: 'GIMP' });
    await tick(300);
    const ph = placeholder()!;
    expect([wm.windows()[wm.windows().length - 1], wm.focused(), ph.state]).toEqual([ph, ph, 'maximized']);
  });

  it('without a desktop the app is just installed and started', async () => {
    delete (globalThis as any).__shiroDesktop;
    const f = fakeApps();
    const result = startGuiApp(fs, f.kernel, 'gimp', {});
    await tick(5);
    f.state.finishInstall!();
    expect((await result).status).toBe('started');
    expect([launches.list().length, f.state.spawns]).toEqual([0, 1]);
  });
});
