/**
 * `hotswap watch` (docs/HOTSWAP.md): on each save of a module under the
 * checkout's src/, rebuild it and swap it into the running page.
 *
 * - Saves are debounced, and a save during a build is picked up after it.
 * - Each swap goes on top of this watcher's previous unconfirmed one and is
 *   squashed into it (swap.ts squash): one record per editing session, so its
 *   TTL counts from the latest save, `hotswap confirm` keeps all of it and
 *   `hotswap revert` (or the TTL, or a wedge) undoes all of it.
 * - A build error changes nothing: the page keeps the code it had.
 */
import type { BuildResult } from './build';
import type { HotswapManager, ModuleReport, SwapRecord } from './swap';

export interface WatchFs {
  onChange(fn: (event: string, path: string, newPath?: string) => void): () => void;
}

export interface WatchDeps {
  fs: WatchFs;
  manager: HotswapManager;
  /** Build a swap of these absolute paths (build.ts buildSwap) */
  build(files: string[]): Promise<BuildResult>;
  /** Load a bundle's modules (swap.ts evaluateBundle) */
  evaluate(code: string): Promise<Record<string, Record<string, unknown>>>;
  /**
   * `hotswap watch --test`: run the suites for these files (relative to the
   * root) after a good save. Runs beside the next saves, never delaying them;
   * files saved during a run are tested together after it.
   */
  test?(files: string[], rec: SwapRecord | null): Promise<{ ok: boolean; line: string }>;
}

export interface WatchOptions {
  /** The checkout (has src/) */
  root: string;
  /** Absolute paths watched (files or directories under root/src); default root/src */
  paths?: string[];
  ttlMs: number | null;
  debounceMs?: number;
}

export interface WatchResult {
  /** Sequence number (1, 2, ...) */
  n: number;
  ok: boolean;
  /** The one-line summary */
  line: string;
  /** The files this save rebuilt, relative to root */
  files: string[];
  warnings: string[];
  /** Times: the build, and from the first save to the swap being live */
  buildMs: number;
  totalMs: number;
  record?: SwapRecord;
}

export const DEFAULT_DEBOUNCE_MS = 150;
const SOURCE = /\.(ts|tsx|js|mjs)$/;
const KEEP_RESULTS = 50;

/**
 * A short summary of what a swap changed. `stale` names free exports whose
 * code changed since the watcher's last build of the module: their importers
 * outside the swap keep the old ones, so the edit doesn't take effect there.
 */
export function summarize(report: ModuleReport[], stale: Record<string, string[]> = {}, seen: ReadonlySet<string> = new Set()): string {
  const out: string[] = [];
  for (const m of report) {
    if (!m.live) { out.push(`${m.module}: not loaded in the page, nothing swapped`); continue; }
    // (a module this watcher swapped before: its methods can be compared, so "nothing changed" is known)
    const again = seen.has(m.module);
    const bits: string[] = [];
    for (const c of m.classes) {
      if (c.errors.length) bits.push(`${c.name}: ${c.errors[0]}`);
      else if (c.changed.length || c.added.length) bits.push(`${c.name}.${[...c.changed, ...c.added].slice(0, 4).join(', .')}${c.changed.length + c.added.length > 4 ? ', ...' : ''}`);
      else if (c.swapped && !again) bits.push(`${c.name} (${c.swapped} members)`);
    }
    for (const c of m.commands) if (c.changed.length) bits.push(`command ${c.command}`);
    const st = stale[m.module] ?? [];
    if (st.length) bits.push(`changed but not swapped (importers keep the old one): ${st.slice(0, 3).join(', ')}${st.length > 3 ? ', ...' : ''}`);
    if (!bits.length && again) bits.push('no change in the built code');
    out.push(`${m.module}${bits.length ? ` (${bits.join('; ')})` : ''}`);
  }
  return out.join(', ');
}

export class HotswapWatcher {
  readonly root: string;
  readonly paths: string[];
  readonly ttlMs: number | null;
  readonly debounceMs: number;
  results: WatchResult[] = [];
  /** Called with each result */
  listeners = new Set<(r: WatchResult) => void>();
  /** This watcher's latest swap, while it's still the page's newest */
  record: SwapRecord | null = null;
  private pending = new Map<string, number>();
  /** Each module's exports as last built, to tell which free functions changed */
  private lastBuilt = new Map<string, Record<string, unknown>>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy: Promise<void> | null = null;
  private unsub: (() => void) | null = null;
  private idleWaiters: (() => void)[] = [];
  private testQueue = new Set<string>();
  private testing: Promise<void> | null = null;
  private seq = 0;

  constructor(private deps: WatchDeps, opts: WatchOptions) {
    this.root = opts.root.replace(/\/+$/, '');
    this.paths = (opts.paths?.length ? opts.paths : [`${this.root}/src`]).map((p) => p.replace(/\/+$/, ''));
    this.ttlMs = opts.ttlMs;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  }

  get running(): boolean { return !!this.unsub; }

  start(): void {
    if (this.unsub) return;
    this.unsub = this.deps.fs.onChange((event, path, newPath) => {
      if (event === 'write') this.changed(path);
      else if (event === 'rename' && newPath) this.changed(newPath);
    });
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.testQueue.clear();
    this.settle();
  }

  /** A file under a watched path, in the checkout's src/, that a swap can build */
  watches(path: string): boolean {
    if (!SOURCE.test(path) || path.endsWith('.d.ts') || !path.startsWith(`${this.root}/src/`)) return false;
    return this.paths.some((p) => path === p || path.startsWith(p + '/'));
  }

  changed(path: string, at = Date.now()): void {
    if (!this.unsub || !this.watches(path)) return;
    if (!this.pending.has(path)) this.pending.set(path, at);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.debounceMs);
  }

  /** Resolves when no save is waiting and no build or test run is running */
  idle(): Promise<void> {
    if (!this.timer && !this.busy && !this.pending.size && !this.testing) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private settle(): void {
    if (this.timer || this.busy || this.pending.size || this.testing) return;
    const w = this.idleWaiters.splice(0);
    for (const r of w) r();
  }

  /** Build and swap what was saved (runs one at a time) */
  async flush(): Promise<void> {
    if (this.busy) { await this.busy; return this.flush(); }
    if (!this.pending.size) { this.settle(); return; }
    const run = this.swap();
    this.busy = run;
    try { await run; } finally {
      this.busy = null;
      if (this.pending.size && !this.timer) void this.flush(); else this.settle();
    }
  }

  private async swap(): Promise<void> {
    const changed = [...this.pending.keys()].sort();
    const firstSave = Math.min(...this.pending.values());
    this.pending.clear();
    const rel = changed.map((p) => p.slice(this.root.length + 1));
    const { manager } = this.deps;
    const t0 = Date.now();
    let built: BuildResult;
    let modules: Record<string, Record<string, unknown>>;
    try {
      built = await this.deps.build(changed);
      modules = await this.deps.evaluate(built.code);
    } catch (e: any) {
      const x = e?.errors?.[0] as { text: string; location?: { file: string; line: number; column: number } } | undefined;
      const file = x?.location?.file.replace(/^[\w-]+:(?=\/)/, ''); // (esbuild's namespace, hs-src:)
      const where = x?.location ? `${file!.startsWith(this.root + '/') ? file!.slice(this.root.length + 1) : file}:${x.location.line}:${x.location.column}: ` : '';
      const more = (e?.errors?.length ?? 0) > 1 ? ` (+${e.errors.length - 1} more)` : '';
      this.emit({ ok: false, line: `✗ ${rel.join(' ')}: ${where}${x?.text ?? e?.message ?? e}${more}; the page keeps the code it had`, files: rel, warnings: [], buildMs: Date.now() - t0, totalMs: Date.now() - firstSave });
      return;
    }
    const buildMs = Date.now() - t0;
    const prev = this.record && manager.stack[manager.stack.length - 1] === this.record && !this.record.confirmed ? this.record : null;
    let rec: SwapRecord;
    try {
      rec = manager.apply(modules, { files: built.keys, code: built.code, hash: built.hash, ttlMs: this.ttlMs });
    } catch (e: any) {
      this.emit({ ok: false, line: `✗ ${rel.join(' ')}: the swap threw, nothing changed: ${String(e?.message ?? e).split('\n')[0]}`, files: rel, warnings: built.warnings, buildMs, totalMs: Date.now() - firstSave });
      return;
    }
    if (prev) manager.squash(prev, rec);
    this.record = rec;
    const stale: Record<string, string[]> = {};
    const seen = new Set(rec.report.map((m) => m.module).filter((k) => this.lastBuilt.has(k)));
    for (const m of rec.report) {
      const before = this.lastBuilt.get(m.module), now = modules[m.module];
      if (before) stale[m.module] = m.fixed.filter((k) => typeof now?.[k] === 'function' && String(now[k]) !== String(before[k]));
      if (now) this.lastBuilt.set(m.module, now);
    }
    const errors = rec.report.some((m) => m.classes.some((c) => c.errors.length));
    const ttl = rec.deadline ? `reverts in ${Math.round((rec.deadline - Date.now()) / 1000)}s unless 'hotswap confirm'` : 'no TTL';
    const warn = built.warnings.length ? `, ${built.warnings.length} warning(s)` : '';
    this.emit({
      ok: !errors,
      line: `${errors ? '✗' : '✓'} #${rec.id} ${summarize(rec.report.filter((m) => built.keys.includes(m.module)), stale, seen)}: live ${Date.now() - firstSave} ms after the save (build ${buildMs} ms${warn}); ${ttl}`,
      files: rel, warnings: built.warnings, buildMs, totalMs: Date.now() - firstSave, record: rec,
    });
    if (!errors && this.deps.test) this.queueTests(rel);
  }

  private queueTests(files: string[]): void {
    for (const f of files) this.testQueue.add(f);
    if (this.testing) return;
    this.testing = (async () => {
      while (this.testQueue.size && this.unsub) {
        const batch = [...this.testQueue];
        this.testQueue.clear();
        let r: { ok: boolean; line: string };
        try { r = await this.deps.test!(batch, this.record); } catch (e: any) { r = { ok: false, line: `\u2717 tests for ${batch.join(' ')}: ${e?.message ?? e}` }; }
        this.emit({ ok: r.ok, line: r.line, files: batch, warnings: [], buildMs: 0, totalMs: 0 });
      }
    })().finally(() => { this.testing = null; this.settle(); });
  }

  /** A line from outside the watcher (an auto-revert of its swap) */
  note(line: string, ok = true): void {
    this.emit({ ok, line, files: [], warnings: [], buildMs: 0, totalMs: 0 });
  }

  private emit(r: Omit<WatchResult, 'n'>): void {
    const res = { ...r, n: ++this.seq };
    this.results.push(res);
    if (this.results.length > KEEP_RESULTS) this.results.shift();
    for (const fn of this.listeners) { try { fn(res); } catch { /* a listener never stops the watcher */ } }
  }
}

/** The page's watcher (`hotswap watch --detach`), if one is running */
export let current: HotswapWatcher | null = null;
export function setCurrent(w: HotswapWatcher | null): void { current = w; }
