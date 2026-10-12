/**
 * App launches in progress (docs/DESKTOP.md "Launch feedback"): one record
 * per app from the moment it is asked for until its first window appears or
 * the launch fails or is cancelled.
 *
 *   requested → installing → starting → window → running
 *        └───────────┴──────────┴─────────┴──→ failed | cancelled
 *
 * - requested   asked for; nothing known yet
 * - installing  packages are being fetched and unpacked (a real fraction when
 *               the amount is known, else none)
 * - starting    the process exists; it has not reached the display
 * - window      it reached the display (an X connection, a splash screen);
 *               its first real window has not appeared
 * - running     the first window is up: the launch is over
 *
 * Stages only move forward, and nothing changes a launch that is over. The
 * tracker keeps one launch per app id: a second request while one is in
 * flight starts nothing and reports `again` (the dock and the placeholder
 * window answer it). No DOM here: the dock (index.ts) and the placeholder
 * windows (launch-ui.ts) listen; launchers (wm.openApp for built-in apps,
 * src/gui/launch.ts for Debian GUI apps) drive it.
 */

export type LaunchStage = 'requested' | 'installing' | 'starting' | 'window' | 'running' | 'failed' | 'cancelled';

const FORWARD: LaunchStage[] = ['requested', 'installing', 'starting', 'window', 'running'];
/** Output lines kept per launch ("Show details") */
export const LAUNCH_LOG_LINES = 200;

export interface LaunchInfo {
  id: string;
  name: string;
  /** Inline SVG markup or an image URL (the app's own icon) */
  icon?: string;
  /** Reserve a placeholder window (apps that take seconds or minutes: Debian GUI apps) */
  placeholder?: boolean;
  /** One line shown while it starts ("first start takes a few minutes") */
  note?: string;
  /** The first window's likely client size in CSS px, when nothing was remembered */
  size?: { width: number; height: number };
  /**
   * Stop the work behind the launch. Gets the stage it was in and returns one
   * sentence saying what happens now (shown to the person who cancelled).
   */
  onCancel?: (stage: LaunchStage) => string | void;
  /** Start the same launch again (the placeholder's Retry) */
  retry?: () => void;
}

/** A real amount: `done` of `total` */
export interface LaunchProgress { done: number; total: number; unit: 'bytes' | 'items' }

export type LaunchEvent =
  | 'request'   // a new launch
  | 'again'     // asked for again while in flight (or while its failure still shows)
  | 'stage'     // the stage changed
  | 'progress'  // the amount or the stage's words changed
  | 'log'       // output arrived
  | 'end';      // it left the tracker (running, cancelled, a failure dismissed or not held)

type Listener = (ev: LaunchEvent, launch: Launch) => void;

const mb = (b: number) => (b >= 10e6 ? `${Math.round(b / 1e6)} MB` : `${(b / 1e6).toFixed(1)} MB`);

/** "0:42", "3:05" */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export class Launch {
  stage: LaunchStage = 'requested';
  /** Set while a real fraction is known; null: show an indeterminate bar */
  progress: LaunchProgress | null = null;
  /** The current stage in other words than the default ("Setting up…") */
  detail = '';
  /** Why it failed */
  error = '';
  /** What cancelling did (LaunchInfo.onCancel's sentence) */
  cancelNote = '';
  pid: number | undefined;
  /** The window that ended the launch (opaque here: a DesktopWindow) */
  firstWindow: unknown = null;
  /** How many times it was asked for */
  requests = 1;
  readonly lines: string[] = [];
  private partial = '';
  readonly startedAt: number;
  stageAt: number;

  constructor(readonly info: LaunchInfo, private emit: (ev: LaunchEvent, l: Launch) => void, now = Date.now()) {
    this.startedAt = this.stageAt = now;
  }

  get id(): string { return this.info.id; }

  /** In flight: asked for, and neither running, failed nor cancelled */
  get active(): boolean { return this.stage !== 'running' && this.stage !== 'failed' && this.stage !== 'cancelled'; }

  /** 0..1 when a real amount is known, else null (never a made-up number) */
  fraction(): number | null {
    const p = this.progress;
    if (!p || this.stage !== 'installing' || !(p.total > 0)) return null;
    return Math.max(0, Math.min(1, p.done / p.total));
  }

  /** The stage in words */
  text(): string {
    switch (this.stage) {
      case 'requested': return 'Preparing…';
      case 'installing': {
        if (this.detail) return this.detail;
        const p = this.progress;
        if (p && p.total > 0) return p.unit === 'bytes' ? `Installing ${mb(p.total)}…` : `Installing ${p.total} packages…`;
        return 'Installing…';
      }
      case 'starting': return this.detail || 'Starting…';
      case 'window': return this.detail || 'Opening window…';
      case 'running': return 'Ready';
      case 'failed': return this.error || `${this.info.name} did not start`;
      case 'cancelled': return this.cancelNote || 'Cancelled';
    }
  }

  /** The amount in words ("21 of 53 MB"), '' when unknown */
  amountText(): string {
    const p = this.progress;
    if (this.fraction() === null || !p) return '';
    if (p.unit !== 'bytes') return `${p.done} of ${p.total}`;
    // one unit for both numbers ("21 of 53 MB")
    const digits = p.total >= 10e6 ? 0 : 1;
    return `${(p.done / 1e6).toFixed(digits)} of ${(p.total / 1e6).toFixed(digits)} MB`;
  }

  private to(stage: LaunchStage, now = Date.now()): boolean {
    if (!this.active) return false;
    const a = FORWARD.indexOf(this.stage), b = FORWARD.indexOf(stage);
    if (b >= 0 && b < a) return false;
    if (stage === this.stage) return true;
    this.stage = stage;
    this.stageAt = now;
    this.detail = '';
    if (stage !== 'installing') this.progress = null;
    this.emit('stage', this);
    return true;
  }

  /** Packages are being installed; `progress` only when the amount is real */
  installing(progress: LaunchProgress | null = null, detail = ''): boolean {
    const changed = this.stage !== 'installing';
    if (!this.to('installing')) return false;
    const same = !changed && detail === this.detail && progress?.done === this.progress?.done && progress?.total === this.progress?.total;
    this.progress = progress;
    this.detail = detail;
    if (!same) this.emit('progress', this);
    return true;
  }

  /** The process exists */
  starting(pid?: number): boolean {
    if (!this.to('starting')) return false;
    if (pid !== undefined) this.pid = pid;
    return true;
  }

  /** It reached the display: a connection or a splash screen, not yet its first real window */
  window(): boolean {
    return this.to('window');
  }

  /** Its first window is up (pass it, so the placeholder can hand over its place) */
  running(win: unknown = null): boolean {
    if (!this.active) return false;
    this.firstWindow = win;
    return this.to('running');
  }

  fail(error: string): boolean {
    if (!this.active) return false;
    this.flushPartial();
    this.error = error;
    this.stage = 'failed';
    this.stageAt = Date.now();
    this.progress = null;
    this.emit('stage', this);
    return true;
  }

  /** Cancel: runs LaunchInfo.onCancel with the stage it was in. Returns what that said. */
  cancel(): string {
    if (!this.active) return '';
    const was = this.stage;
    this.stage = 'cancelled';
    this.stageAt = Date.now();
    this.progress = null;
    let note: string | void = '';
    try { note = this.info.onCancel?.(was); } catch (e) { note = `Cancelling failed: ${(e as Error).message}`; }
    this.cancelNote = note || '';
    this.emit('stage', this);
    return this.cancelNote;
  }

  /** Output from the install or the app: any text; lines are split here, `\r` rewrites the line */
  log(text: string): void {
    if (!text) return;
    const parts = (this.partial + text).split('\n');
    this.partial = parts.pop() ?? '';
    for (const raw of parts) this.pushLine(raw);
    this.emit('log', this);
  }

  private pushLine(raw: string): void {
    // a progress line rewritten with \r: its last version; no control sequences
    const line = (raw.split('\r').filter(Boolean).pop() ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trimEnd();
    if (!line) return;
    this.lines.push(line);
    if (this.lines.length > LAUNCH_LOG_LINES) this.lines.splice(0, this.lines.length - LAUNCH_LOG_LINES);
  }

  private flushPartial(): void {
    if (this.partial) { this.pushLine(this.partial); this.partial = ''; }
  }

  /** The newest output line (the unfinished one counts) */
  lastLine(): string {
    const p = (this.partial.split('\r').filter(Boolean).pop() ?? '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
    return p || this.lines[this.lines.length - 1] || '';
  }
}

/** What the tracker needs of a window (a DesktopWindow) */
interface WindowLike {
  id: string;
  appId?: string;
  options: { override?: boolean; transientFor?: string; splash?: boolean };
}
interface WindowSource { on(ev: 'window-created', cb: (w?: WindowLike) => void): () => void }

/** Placeholder windows are named after their app, so nothing mistakes one for the app's own window */
export const PLACEHOLDER_PREFIX = 'launching-';
export const placeholderId = (appId: string) => PLACEHOLDER_PREFIX + appId.replace(/[^A-Za-z0-9_-]/g, '_');
export const isPlaceholder = (w: { id: string }) => w.id.startsWith(PLACEHOLDER_PREFIX);

export class LaunchTracker {
  private map = new Map<string, Launch>();
  private listeners = new Set<Listener>();
  /**
   * Keep a failed launch (so its placeholder can show the error, and a second
   * request goes to it) until `dismiss`. Set by the UI that shows failures;
   * without one a failure ends the launch at once.
   */
  holdFailed = false;

  /**
   * Ask for an app. `fresh: false` means one is already in flight (or its
   * failure is still showing): start nothing, the listeners were told `again`.
   */
  request(info: LaunchInfo): { launch: Launch; fresh: boolean } {
    const existing = this.map.get(info.id);
    if (existing) {
      existing.requests++;
      this.emit('again', existing);
      return { launch: existing, fresh: false };
    }
    const launch = new Launch(info, (ev, l) => this.changed(ev, l));
    this.map.set(info.id, launch);
    this.emit('request', launch);
    return { launch, fresh: true };
  }

  /** The launch in flight for an app (or its failure, while that still shows) */
  get(id: string): Launch | undefined { return this.map.get(id); }

  /** True while the app was asked for and has no window yet */
  starting(id: string): boolean { return !!this.map.get(id)?.active; }

  list(): Launch[] { return [...this.map.values()]; }

  /** Tell the listeners an in-flight launch was asked for again */
  again(launch: Launch): void {
    if (this.map.get(launch.id) !== launch) return;
    launch.requests++;
    this.emit('again', launch);
  }

  /** Forget a failed launch (its placeholder was closed, or Retry) */
  dismiss(launch: Launch): void {
    if (this.map.get(launch.id) !== launch || launch.active) return;
    this.map.delete(launch.id);
    this.emit('end', launch);
  }

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  /**
   * End launches when their app's first window is created: a splash screen
   * moves it to `window`, any other window of its own (not a menu or tooltip,
   * not a dialog of another window, not the placeholder) to `running`.
   */
  attach(wm: WindowSource): () => void {
    return wm.on('window-created', (w) => {
      if (!w || !w.appId || isPlaceholder(w) || w.options.override || w.options.transientFor) return;
      const l = this.map.get(w.appId);
      if (!l?.active) return;
      if (w.options.splash) l.window(); else l.running(w);
    });
  }

  private changed(ev: LaunchEvent, l: Launch): void {
    this.emit(ev, l);
    if (ev !== 'stage' || l.active) return;
    if (l.stage === 'failed' && this.holdFailed && l.info.placeholder) return;
    if (this.map.get(l.id) === l) { this.map.delete(l.id); this.emit('end', l); }
  }

  private emit(ev: LaunchEvent, l: Launch): void {
    for (const cb of [...this.listeners]) { try { cb(ev, l); } catch (e) { console.error('[launch]', e); } }
  }
}

/** The page's launches */
export const launches = new LaunchTracker();

// ── Where an app's window was last time ──

export interface SavedGeometry { x: number; y: number; width: number; height: number }
export const GEOMETRY_KEY = 'tabcomputer-launch-geometry';
/** Apps remembered at most (the oldest go first) */
const GEOMETRY_MAX = 60;

function readGeometry(): Record<string, SavedGeometry> {
  try {
    const v = JSON.parse(localStorage.getItem(GEOMETRY_KEY) || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

/** The frame position and client size an app's main window had last (CSS px, work-area coordinates) */
export function rememberedGeometry(id: string): SavedGeometry | null {
  const g = readGeometry()[id];
  if (!g || ![g.x, g.y, g.width, g.height].every((n) => Number.isFinite(n)) || g.width < 40 || g.height < 40) return null;
  return { x: g.x, y: g.y, width: g.width, height: g.height };
}

export function rememberGeometry(id: string, g: SavedGeometry): void {
  if (![g.x, g.y, g.width, g.height].every((n) => Number.isFinite(n)) || g.width < 40 || g.height < 40) return;
  try {
    const all = readGeometry();
    delete all[id]; // newest last
    all[id] = { x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.width), height: Math.round(g.height) };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - GEOMETRY_MAX))) delete all[k];
    localStorage.setItem(GEOMETRY_KEY, JSON.stringify(all));
  } catch { /* no storage */ }
}

/** A first window's size when nothing better is known: a guess, replaced by the remembered size after one run */
export const DEFAULT_LAUNCH_SIZE = { width: 800, height: 560 };

/**
 * Where to reserve an app's window: its last geometry if that still fits the
 * work area (`remembered`), else the given guess, sized to fit, without a
 * position (the window manager centers and cascades it).
 */
export function reservedGeometry(id: string, guess: { width: number; height: number } | undefined, wa: { width: number; height: number }): { x?: number; y?: number; width: number; height: number; remembered: boolean } {
  const r = rememberedGeometry(id);
  if (r && r.width <= wa.width && r.x < wa.width - 40 && r.y < wa.height - 40 && r.x > 40 - r.width && r.y >= 0) return { ...r, remembered: true };
  const g = guess ?? DEFAULT_LAUNCH_SIZE;
  return { width: Math.min(g.width, Math.max(200, wa.width - 24)), height: Math.min(g.height, Math.max(140, wa.height - 38 - 24)), remembered: false };
}
