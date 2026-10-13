/**
 * Taking an app's snapshot again, in the background (docs/research/GUI_SNAPSHOTS.md
 * "Retakes"). A snapshot is good only while what it was made from is
 * unchanged, and an app that saves its settings when it quits (GIMP does
 * every time) outdates its own. So after an app quits, and once after the
 * page has loaded, the apps whose snapshot is missing or outdated are started
 * again where nobody sees them: no window on the desktop, no mark in the
 * dock. When the app has gone quiet its snapshot is kept and its processes
 * are ended. The next launch is then a restore.
 *
 * It waits for a moment when it takes nothing from the person:
 *
 * - never in safe mode, in a guest, or with the setting off;
 * - never while the page is hidden;
 * - not until QUIET_MS have passed without a key or a button pressed
 *   anywhere on the page, and without an app being started;
 * - a key or button pressed in a GUI app, an app being started, or the page
 *   being hidden ends it at once (its processes are killed); it is asked for
 *   again later;
 * - one at a time; an app whose hidden start failed TRIES_PER_APP times in a
 *   row is left alone for the rest of the page load.
 *
 * The rules are `retakeDecision` (a pure function); `RetakeQueue` applies
 * them with the page's clock, and src/gui/apps.ts gives it the app to start.
 */

/** Without input for this long before a hidden start, ms */
export const QUIET_MS = 10_000;
/** After the page has loaded, before the stored snapshots are looked at, ms */
export const BOOT_DELAY_MS = 20_000;
export const TRIES_PER_APP = 2;
/** Apps looked at after the page has loaded: those used in the last week, the most recent first, this many */
export const BOOT_APPS = 3;
export const RECENT_MS = 7 * 24 * 3600_000;

export interface RetakeState {
  on: boolean;
  safe: boolean;
  guest: boolean;
  hidden: boolean;
  /** An app is being installed or started for the person */
  launching: boolean;
  /** ms since a key or button was last pressed on the page (in any window) */
  sinceInput: number;
  /** ms since the app that asked for this quit (0 when none did) */
  sinceAsked: number;
  /** Hidden starts of this app that failed, since its last one that kept a snapshot */
  triedApp: number;
}

/** 'start' now, 'wait' (look again later), or 'no' (this page load never will) */
export function retakeDecision(s: RetakeState): 'start' | 'wait' | 'no' {
  if (!s.on || s.safe || s.guest) return 'no';
  if (s.triedApp >= TRIES_PER_APP) return 'no';
  if (s.hidden || s.launching) return 'wait';
  if (s.sinceInput < QUIET_MS || s.sinceAsked < QUIET_MS) return 'wait';
  return 'start';
}

/**
 * Whether this machine has the memory for a hidden start of an app whose
 * last image was `imageBytes`. A hidden start takes what the app takes, and
 * its image twice over while it is packed: measured in the browser's renderer
 * processes, 0.25 to 0.45 GB for Geany (a 57 MB image) and 1.1 GB for GIMP
 * (180 MB) at the peak (docs/research/GUI_SNAPSHOTS.md "Retakes"). With 8 GB
 * or more (`navigator.deviceMemory`, which says 8 at most) any app; with
 * less, only the small ones, and none whose size is not known yet.
 */
export const SMALL_IMAGE = 64_000_000;
export function retakeFits(deviceMemory: number | undefined, imageBytes: number | undefined): boolean {
  if ((deviceMemory ?? 0) >= 8) return true;
  return imageBytes !== undefined && imageBytes > 0 && imageBytes <= SMALL_IMAGE;
}

export interface RetakeResult { ok: boolean; why?: string; never?: boolean; cancelled?: boolean; ms?: number; bytes?: { image: number; stored: number; x: number } }

export interface RetakeDeps {
  now(): number;
  /** What the rules need that the queue doesn't know itself */
  state(): Pick<RetakeState, 'on' | 'safe' | 'guest' | 'hidden' | 'launching'>;
  /** When a key or button was last pressed on the page */
  lastInput(): number;
  /** Why `app` needs a new snapshot, or null when it has a good one or can't have one */
  needs(app: string): Promise<string | null>;
  /**
   * Start `app` hidden and keep its snapshot. `signal` aborts it: its processes
   * are killed at once, and `gone` is called when nothing of it is left (the
   * result may come later: a snapshot being packed is finished, then dropped).
   */
  take(app: string, signal: AbortSignal, gone: () => void): Promise<RetakeResult>;
  log(app: string, what: Record<string, unknown>): void;
  timer(cb: () => void, ms: number): unknown;
  /** Run `cb` when the page has nothing else to do */
  idle(cb: () => void): void;
}

interface Wanted { app: string; asked: number; tries: number }

export class RetakeQueue {
  private wanted = new Map<string, Wanted>();
  private running: { app: string; abort: AbortController; done: Promise<void>; gone: Promise<void> } | null = null;
  private polling = false;
  /** Chosen to start at the next idle moment (it stays on the list until it does) */
  private starting: string | null = null;
  /** Failed tries per app in a row (kept when an app leaves the queue; a snapshot kept clears it) */
  private tries = new Map<string, number>();

  constructor(private d: RetakeDeps) {}

  /** `app` may need a new snapshot (it quit, or the page found its snapshot outdated) */
  request(app: string, asked = this.d.now()): void {
    if (this.wanted.has(app) || this.running?.app === app) return;
    this.wanted.set(app, { app, asked, tries: this.tries.get(app) ?? 0 });
    this.poll();
  }

  /** The person is starting `app` themselves: nothing hidden may be running, and that start takes its snapshot */
  async userLaunch(app: string): Promise<void> {
    this.wanted.delete(app);
    await this.cancel('an app was started');
  }

  /** End the hidden start in flight, if any, and wait until its processes are gone; it is asked for again later */
  async cancel(why: string): Promise<void> {
    const r = this.running;
    if (!r) return;
    r.abort.abort(why);
    await Promise.race([r.done, r.gone]).catch(() => undefined);
  }

  /** The app being started hidden now, if any */
  get current(): string | null { return this.running?.app ?? null; }
  get waiting(): string[] { return [...this.wanted.keys()]; }

  private poll(): void {
    if (this.polling) return;
    this.polling = true;
    const tick = () => {
      this.polling = false;
      if (this.running || this.starting || !this.wanted.size) return;
      const s = this.d.state();
      const now = this.d.now();
      let any = false;
      for (const w of [...this.wanted.values()]) {
        const decision = retakeDecision({ ...s, sinceInput: now - this.d.lastInput(), sinceAsked: now - w.asked, triedApp: w.tries });
        if (decision === 'no') { this.wanted.delete(w.app); continue; }
        any = true;
        if (decision === 'start') { this.starting = w.app; this.d.idle(() => void this.run(w)); return; }
      }
      if (any) { this.polling = true; this.d.timer(tick, 1000); }
    };
    this.d.timer(tick, 1000);
  }

  private async run(w: Wanted): Promise<void> {
    this.starting = null;
    // (the person started it themselves meanwhile: off the list)
    if (this.wanted.get(w.app) !== w) { this.poll(); return; }
    // (checked again at the idle moment: the page may have been hidden, or an app started, since)
    const s = this.d.state();
    const now = this.d.now();
    if (this.running || retakeDecision({ ...s, sinceInput: now - this.d.lastInput(), sinceAsked: now - w.asked, triedApp: w.tries }) !== 'start') {
      this.poll();
      return;
    }
    this.wanted.delete(w.app);
    const abort = new AbortController();
    let finish!: () => void, isGone!: () => void;
    const done = new Promise<void>((r) => { finish = r; });
    const gone = new Promise<void>((r) => { isGone = r; });
    this.running = { app: w.app, abort, done, gone };
    try {
      const why = await this.d.needs(w.app);
      if (why === null || abort.signal.aborted) return;
      this.d.log(w.app, { retake: 'started', why });
      const r = await this.d.take(w.app, abort.signal, isGone);
      this.d.log(w.app, r.ok ? { retaken: true, ms: r.ms, bytes: r.bytes } : { retaken: false, why: r.why, cancelled: !!r.cancelled });
      if (r.ok) this.tries.delete(w.app);
      // Ended for the person's sake: it did not fail, and is asked for again
      else if (r.cancelled) { w.asked = this.d.now(); this.wanted.set(w.app, w); }
      else { w.tries++; this.tries.set(w.app, w.tries); if (!r.never) this.wanted.set(w.app, w); }
    } catch (e) {
      this.d.log(w.app, { retaken: false, why: String((e as Error)?.message ?? e) });
    } finally {
      this.running = null;
      isGone();
      finish();
      if (this.wanted.size) this.poll();
    }
  }
}
