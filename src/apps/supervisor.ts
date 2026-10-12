/**
 * An app's backend, owned by the app and not by a terminal (docs/APPS.md
 * "Lifecycle"): started when the app opens (or on the page's first request,
 * `backend.lazy`), started again when it dies, and stopped when the app's
 * last window closes.
 *
 *   stopped → starting → running
 *                │           │ it died
 *                ▼           ▼
 *              backoff ──→ starting …      after MAX_FAILURES in a row: failed
 *
 * "Running" means the port is open and, when the manifest names a health
 * path, that path answered 2xx. A start that never gets there, or a backend
 * that dies within STABLE_MS of getting there, is a failure; the wait before
 * the next start doubles each time (BACKOFF_MS). After MAX_FAILURES failures
 * in a row the supervisor stops trying and keeps the error and the last
 * output for the window to show; `retry()` starts over. A backend that ran
 * for STABLE_MS is trusted again: its next death restarts it at once.
 *
 * No DOM and no shell here: `SupervisorDeps` starts the process and watches
 * the port (src/apps/runtime.ts for the tab, stand-ins in tests).
 */

export type BackendState = 'stopped' | 'starting' | 'running' | 'backoff' | 'failed';

export const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];
export const MAX_FAILURES = 5;
/** A backend that stayed up this long has its failures forgotten */
export const STABLE_MS = 10_000;
/** How long a start may take to open its port, without a health check's own timeout */
export const START_TIMEOUT_MS = 20_000;
export const LOG_LINES = 400;

export interface BackendSpec {
  id: string;
  /** The shell line that starts it */
  start: string;
  cwd: string;
  port: number;
  env: Record<string, string>;
  health: { path: string; timeout: number } | null;
}

export interface BackendProcess {
  /** Resolves with the exit status when the command ends (a server that stays in the foreground: never, until killed) */
  done: Promise<number>;
  kill(): void;
}

export interface SupervisorDeps {
  spawn(line: string, cwd: string, env: Record<string, string>, onOutput: (s: string) => void): BackendProcess;
  portUp(port: number): boolean;
  /** Called when a server starts or stops listening on any port; returns an unsubscribe */
  onPort(cb: (port: number, up: boolean) => void): () => void;
  /** GET a path of the server on `port`; the status */
  probe(port: number, path: string): Promise<number>;
  /** Stop whatever still listens on the port (the process is gone or would not die) */
  closePort(port: number): void;
  now?(): number;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(t: unknown): void;
}

type Listener = (state: BackendState, sup: Supervisor) => void;

export class Supervisor {
  state: BackendState = 'stopped';
  /** Failed starts and early deaths in a row */
  failures = 0;
  /** Why it is in `failed` (or what the last failure was) */
  error = '';
  /** How many times the process was started */
  starts = 0;
  readonly lines: string[] = [];
  private partial = '';
  private proc: BackendProcess | null = null;
  private listeners = new Set<Listener>();
  private logListeners = new Set<(text: string) => void>();
  private timer: unknown = null;
  private offPort: (() => void) | null = null;
  private upAt = 0;
  /** Bumped by every start and stop: a callback of an older run does nothing */
  private gen = 0;
  private waiters: ((ok: boolean) => void)[] = [];
  private now: () => number;
  private later: (fn: () => void, ms: number) => unknown;
  private cancel: (t: unknown) => void;

  constructor(readonly spec: BackendSpec, private deps: SupervisorDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.later = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
    this.cancel = deps.clearTimeout ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  }

  get port(): number { return this.spec.port; }

  on(cb: Listener): () => void { this.listeners.add(cb); return () => { this.listeners.delete(cb); }; }
  onLog(cb: (text: string) => void): () => void { this.logListeners.add(cb); return () => { this.logListeners.delete(cb); }; }

  /** Start it if it isn't running. Resolves true once it is running, false once it has failed for good or was stopped. */
  start(): Promise<boolean> {
    if (this.state === 'running') return Promise.resolve(true);
    const p = new Promise<boolean>((resolve) => { this.waiters.push(resolve); });
    if (this.state === 'stopped' || this.state === 'failed') {
      this.failures = 0;
      this.error = '';
      this.launch();
    }
    return p;
  }

  /** Start over after `failed` (the window's Retry) */
  retry(): Promise<boolean> {
    if (this.state !== 'failed' && this.state !== 'stopped') return this.start();
    return this.start();
  }

  /** Stop it and stop watching. Safe to call in any state. */
  stop(): void {
    this.gen++;
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
    this.offPort?.(); this.offPort = null;
    const proc = this.proc;
    this.proc = null;
    try { proc?.kill(); } catch { /* gone */ }
    if (this.deps.portUp(this.spec.port)) this.deps.closePort(this.spec.port);
    this.set('stopped');
    this.settle(false);
  }

  /** Kill the process and start it again now (`app dev` on save) */
  restart(): Promise<boolean> {
    this.stop();
    return this.start();
  }

  private set(state: BackendState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of [...this.listeners]) { try { cb(state, this); } catch (e) { console.error('[app]', e); } }
  }

  private settle(ok: boolean): void {
    const w = this.waiters;
    this.waiters = [];
    for (const r of w) r(ok);
  }

  private log(text: string): void {
    if (!text) return;
    for (const cb of [...this.logListeners]) { try { cb(text); } catch { /* a listener's problem */ } }
    const parts = (this.partial + text.replace(/\r\n/g, '\n')).split('\n');
    this.partial = parts.pop() ?? '';
    for (const line of parts) this.lines.push(line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, ''));
    if (this.lines.length > LOG_LINES) this.lines.splice(0, this.lines.length - LOG_LINES);
  }

  /** The last output lines (the unfinished one included) */
  tail(n = 12): string[] {
    const all = this.partial.trim() ? [...this.lines, this.partial] : this.lines;
    return all.filter((l) => l.trim()).slice(-n);
  }

  private launch(): void {
    const gen = ++this.gen;
    const { spec, deps } = this;
    this.set('starting');
    this.starts++;
    this.upAt = 0;
    // Something else already listens there (a copy started by hand): it is not ours to supervise
    if (deps.portUp(spec.port)) deps.closePort(spec.port);
    let exited = false;
    let status = 0;
    this.log(`$ ${spec.start}\n`);
    let proc: BackendProcess;
    try { proc = deps.spawn(spec.start, spec.cwd, { ...spec.env, PORT: String(spec.port) }, (s) => { if (gen === this.gen) this.log(s); }); }
    catch (e) { this.died(gen, `it could not be started: ${(e as Error).message}`); return; }
    this.proc = proc;
    void proc.done.then((code) => { status = code; }, () => { status = 1; }).then(() => {
      exited = true;
      if (gen !== this.gen) return;
      // A server may hand its port to the page and return: it lives while the port is open
      if (deps.portUp(spec.port) && this.state === 'running') return;
      this.died(gen, this.state === 'running' ? `it exited (status ${status})` : `it exited with status ${status} before listening on port ${spec.port}`);
    });
    const limit = (spec.health?.timeout ?? START_TIMEOUT_MS / 1000) * 1000;
    const deadline = this.now() + limit;
    this.offPort?.();
    this.offPort = deps.onPort((port, up) => {
      if (port !== spec.port || gen !== this.gen) return;
      if (up) void check();
      else if (this.state === 'running') this.died(gen, exited ? `it exited (status ${status})` : `it stopped listening on port ${spec.port}`);
    });
    let checking = false;
    const check = async () => {
      if (checking || gen !== this.gen || this.state !== 'starting') return;
      if (!deps.portUp(spec.port)) return;
      checking = true;
      let ok = !spec.health;
      if (spec.health) {
        const code = await deps.probe(spec.port, spec.health.path).catch(() => 0);
        ok = code >= 200 && code < 300;
      }
      checking = false;
      if (gen !== this.gen || this.state !== 'starting') return;
      if (ok) {
        if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
        this.upAt = this.now();
        this.set('running');
        this.settle(true);
      }
    };
    const poll = () => {
      this.timer = null;
      if (gen !== this.gen || this.state !== 'starting') return;
      if (this.now() >= deadline) {
        this.died(gen, deps.portUp(spec.port) ? `${spec.health?.path} did not answer within ${Math.round(limit / 1000)} s` : `nothing listened on port ${spec.port} within ${Math.round(limit / 1000)} s`);
        return;
      }
      void check();
      this.timer = this.later(poll, 100);
    };
    poll();
  }

  /** The run `gen` is over without being asked to stop */
  private died(gen: number, why: string): void {
    if (gen !== this.gen) return;
    this.gen++;
    if (this.timer !== null) { this.cancel(this.timer); this.timer = null; }
    this.offPort?.(); this.offPort = null;
    const proc = this.proc;
    this.proc = null;
    try { proc?.kill(); } catch { /* gone */ }
    if (this.deps.portUp(this.spec.port)) this.deps.closePort(this.spec.port);
    const stable = this.upAt > 0 && this.now() - this.upAt >= STABLE_MS;
    this.failures = stable ? 0 : this.failures + 1;
    this.error = why;
    this.log(`[app] ${this.spec.id}: ${why}\n`);
    if (this.failures >= MAX_FAILURES) {
      this.error = `${why}; it failed ${this.failures} times in a row and was not started again`;
      this.set('failed');
      this.settle(false);
      return;
    }
    if (stable) { this.launch(); return; }
    const wait = BACKOFF_MS[Math.min(this.failures - 1, BACKOFF_MS.length - 1)];
    this.set('backoff');
    const mine = this.gen;
    this.timer = this.later(() => { this.timer = null; if (mine === this.gen) this.launch(); }, wait);
  }
}

/** A free port for a backend whose manifest says "auto": stable per app while it is free */
export function pickPort(id: string, inUse: (port: number) => boolean, taken: Set<number> = new Set()): number {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  for (let i = 0; i < 2000; i++) {
    const port = 4800 + ((h + i) % 2000);
    if (!inUse(port) && !taken.has(port)) return port;
  }
  throw new Error('no free port for the backend');
}
