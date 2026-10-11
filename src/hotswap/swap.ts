/**
 * Hot-swapping live classes (docs/HOTSWAP.md).
 *
 * A swap takes the namespaces of freshly built modules (keyed like the live
 * map, 'src/shell.ts') and, for each exported class whose live module exports
 * a class of the same name, moves the new class's prototype methods,
 * accessors and static methods onto the live class. Existing instances run
 * the new code from their next call. Every replaced descriptor is kept, so a
 * revert puts back exactly what was there.
 *
 * Hooks:
 * - `migrateFrom(old)` on the new class's prototype runs once per tracked
 *   live instance (live.ts trackInstance), `this` the instance and `old` an
 *   object carrying the previous methods. It isn't installed on the prototype.
 * - `export function __hotswap(ctx)` in a swapped module runs after its
 *   classes are swapped; it may return a function to run on revert.
 *
 * Instances made by the new code (`new Shell()` inside the swap) belong to
 * the new class; `instanceof` treats the live class and the classes swapped
 * into it as one, both ways.
 */
import { instancesOf, lineage, liveImport, liveModule } from './live';
import { onWedge } from '../watchdog';

export interface ClassReport {
  name: string;
  /** Prototype members moved onto the live class */
  swapped: number;
  /** Methods whose source changed since the previous swap (unknown against the page's minified build) */
  changed: string[];
  /** Methods the live class didn't have */
  added: string[];
  /** Number of live instances migrateFrom ran on */
  migrated: number;
  errors: string[];
}

export interface CommandReport {
  /** The export's name */
  name: string;
  /** The command's name (what you type) */
  command: string;
  /** Properties replaced on the live command object (exec, description, ...) */
  changed: string[];
}

export interface ModuleReport {
  module: string;
  /** The live module is loaded (otherwise nothing of it was swapped) */
  live: boolean;
  classes: ClassReport[];
  /** Registry commands (plain objects with name and exec) patched in place */
  commands: CommandReport[];
  /** Exports that aren't swappable classes: importers outside the swap keep the old ones */
  fixed: string[];
  /** Module state the new copy took from the live module (state.ts) */
  state: string[];
  hook: boolean;
}

export interface SwapRecord {
  id: number;
  label: string;
  files: string[];
  appliedAt: number;
  /** Auto-revert time (ms since epoch), null without a TTL */
  deadline: number | null;
  confirmed: boolean;
  /** The bundle (for persisting) and its hash */
  code: string;
  hash: string;
  report: ModuleReport[];
  /** Saved by `hotswap confirm --persist` (or re-applied from there at boot) */
  persisted?: boolean;
  /**
   * Earlier swaps squashed into this one (`hotswap watch`), oldest first, that
   * later ones don't fully replace: persisting saves them before this one
   */
  parts?: SwapPart[];
  /** The files `code` builds, when `files` also has squashed parts' (default: files) */
  bundleFiles?: string[];
  undo: (() => void)[];
  timer?: ReturnType<typeof setTimeout>;
}

export interface SwapPart { label: string; files: string[]; code: string; hash: string }

export interface ApplyMeta {
  label?: string;
  files?: string[];
  code?: string;
  hash?: string;
  /** Auto-revert after this many ms unless confirmed; null/0 for none */
  ttlMs?: number | null;
  /** Mark confirmed at once (a persisted swap re-applied at boot) */
  confirmed?: boolean;
}

const ordinaryHasInstance = Function.prototype[Symbol.hasInstance];

export function isClass(v: unknown): v is new (...a: any[]) => any {
  return typeof v === 'function' && /^class[\s{]/.test(Function.prototype.toString.call(v));
}

const SKIP_PROTO = new Set<PropertyKey>(['constructor', 'migrateFrom']);
const SKIP_STATIC = new Set<PropertyKey>(['length', 'name', 'prototype', Symbol.hasInstance]);

function swappable(d: PropertyDescriptor): boolean {
  return 'value' in d ? typeof d.value === 'function' : true;
}

function srcOf(d: PropertyDescriptor | undefined): string {
  if (!d) return '';
  const f = (x: unknown) => (typeof x === 'function' ? Function.prototype.toString.call(x) : String(x));
  return 'value' in d ? f(d.value) : `${f(d.get)}|${f(d.set)}`;
}

/** Functions a swap installed: their source is comparable with a new build's (the page's own is minified) */
const installed = new WeakSet<object>();
function markInstalled(d: PropertyDescriptor): void {
  for (const f of [d.value, d.get, d.set]) if (typeof f === 'function') installed.add(f);
}
function comparable(d: PropertyDescriptor): boolean {
  const f = d.value ?? d.get ?? d.set;
  return typeof f === 'function' && installed.has(f);
}

function keyName(k: PropertyKey): string {
  return typeof k === 'symbol' ? k.toString() : String(k);
}

const pristine = new WeakMap<object, Map<PropertyKey, PropertyDescriptor>>();

/** Move `next`'s methods onto `target` (a prototype or a constructor), recording the undo */
function moveMembers(target: object, source: object, also: object, skip: Set<PropertyKey>, undo: (() => void)[], report?: ClassReport): Record<PropertyKey, PropertyDescriptor | undefined> {
  const old: Record<PropertyKey, PropertyDescriptor | undefined> = {};
  // A revert puts old code on the new class too, so the same class applied again
  // (a cached module) takes its members from this first look
  let own = pristine.get(source);
  if (!own) {
    own = new Map(Reflect.ownKeys(source).map((k) => [k, Object.getOwnPropertyDescriptor(source, k)!]));
    pristine.set(source, own);
  }
  for (const [k, nd] of own) {
    if (skip.has(k)) continue;
    if (!swappable(nd)) continue;
    const od = Object.getOwnPropertyDescriptor(target, k);
    if (od && !od.configurable) continue;
    old[k as any] = od;
    if (report) {
      report.swapped++;
      if (!od) report.added.push(keyName(k));
      else if (comparable(od) && srcOf(od) !== srcOf(nd)) report.changed.push(keyName(k));
    }
    Object.defineProperty(target, k, { ...nd, configurable: true });
    markInstalled(nd);
    undo.push(() => {
      if (od) Object.defineProperty(target, k, od); else delete (target as any)[k];
      // Instances the new code made run the old code again too
      if (od) Object.defineProperty(also, k, od); else delete (also as any)[k];
    });
  }
  return old;
}

/** Swap one class; returns its report. Undo steps go on `undo`. */
export function swapClass(live: Function, next: Function, undo: (() => void)[], name = next.name || live.name): ClassReport {
  const report: ClassReport = { name, swapped: 0, changed: [], added: [], migrated: 0, errors: [] };
  const oldProto = moveMembers(live.prototype, next.prototype, next.prototype, SKIP_PROTO, undo, report);
  moveMembers(live, next, next, SKIP_STATIC, undo);

  // instanceof: the live class and every class swapped into it are one
  let set = lineage.get(live);
  if (!set) lineage.set(live, (set = new Set()));
  if (set.size === 0) {
    const saved = Object.getOwnPropertyDescriptor(live, Symbol.hasInstance);
    const members = set;
    Object.defineProperty(live, Symbol.hasInstance, {
      configurable: true,
      value(this: Function, o: unknown) {
        if (ordinaryHasInstance.call(this, o)) return true;
        if (this !== live) return false;
        for (const n of members) if (ordinaryHasInstance.call(n, o)) return true;
        return false;
      },
    });
    undo.push(() => {
      if (members.size) return;
      if (saved) Object.defineProperty(live, Symbol.hasInstance, saved);
      else delete (live as any)[Symbol.hasInstance];
    });
  }
  set.add(next);
  const members = set;
  // (undo runs in reverse: this runs before the hasInstance restore above, which checks it)
  undo.push(() => { members.delete(next); });
  if (!Object.prototype.hasOwnProperty.call(next, Symbol.hasInstance)) {
    Object.defineProperty(next, Symbol.hasInstance, {
      configurable: true,
      value(this: Function, o: unknown) {
        return ordinaryHasInstance.call(this, o) || (this === next && ordinaryHasInstance.call(live, o));
      },
    });
  }

  const migrate = Object.getOwnPropertyDescriptor(next.prototype, 'migrateFrom')?.value;
  if (typeof migrate === 'function') {
    const old = Object.create(Object.getPrototypeOf(live.prototype));
    for (const k of Reflect.ownKeys(oldProto)) {
      const d = oldProto[k as any];
      if (d) Object.defineProperty(old, k, d);
    }
    for (const inst of instancesOf(live)) {
      try { migrate.call(inst, old); report.migrated++; } catch (e: any) { report.errors.push(`migrateFrom: ${e?.message ?? e}`); }
    }
  }
  return report;
}

/** A registry command: { name, exec, ... } (src/commands/index.ts) */
export function isCommand(v: unknown): v is { name: string; exec: Function } & Record<string, unknown> {
  return !!v && typeof v === 'object' && typeof (v as any).name === 'string' && typeof (v as any).exec === 'function';
}

/**
 * Patch a live command object in place with the new one's properties, so
 * every holder of it (the command registry, a lazy command's cache, the
 * ModuleRegistry) runs the new code. Undo restores each property.
 */
export function swapCommand(live: Record<string, unknown>, next: Record<string, unknown>, undo: (() => void)[], exportName: string): CommandReport {
  const report: CommandReport = { name: exportName, command: String(live.name), changed: [] };
  for (const k of Reflect.ownKeys(next)) {
    if (k === 'name') continue;
    const nd = Object.getOwnPropertyDescriptor(next, k)!;
    const od = Object.getOwnPropertyDescriptor(live, k);
    if (od && !od.configurable) continue;
    if (od && 'value' in od && 'value' in nd && od.value === nd.value) continue;
    Object.defineProperty(live, k, { ...nd, configurable: true });
    report.changed.push(keyName(k));
    undo.push(() => { if (od) Object.defineProperty(live, k, od); else delete live[k as any]; });
  }
  return report;
}

export interface HookContext {
  /** The module's path ('src/shell.ts') */
  key: string;
  /** The live module's namespace (the old code) */
  old: Record<string, unknown>;
  /** Tracked live instances of a class */
  instances(cls: Function): object[];
  /** Run fn when this swap is reverted */
  onRevert(fn: () => void): void;
}

/**
 * Swap the given modules into the page (all or nothing). `modules` maps a
 * live key to the new module's namespace.
 */
export function swapModules(modules: Record<string, Record<string, unknown>>, undo: (() => void)[]): ModuleReport[] {
  const reports: ModuleReport[] = [];
  const start = undo.length;
  try {
    for (const [key, ns] of Object.entries(modules)) {
      const liveNs = liveModule(key);
      const rep: ModuleReport = { module: key, live: !!liveNs, classes: [], commands: [], fixed: [], state: [], hook: false };
      reports.push(rep);
      if (!liveNs) continue;
      for (const name of Object.keys(ns)) {
        if (name === '__hotswap' || name === '__hotswapState') continue;
        const v = ns[name], lv = liveNs[name];
        if (isClass(v) && isClass(lv)) {
          if (v !== lv) rep.classes.push(swapClass(lv, v, undo, name));
        } else if (isCommand(v) && isCommand(lv) && v.name === lv.name) {
          if (v !== lv) rep.commands.push(swapCommand(lv, v, undo, name));
        } else if (v !== lv) {
          rep.fixed.push(name);
        }
      }
      // State the new copy took (state.ts): on revert, the live module gets the `let` values back
      const st = ns.__hotswapState as { took: string[]; mutable: string[]; state: Record<string, unknown> } | undefined;
      const liveState = (globalThis as any).__tabcomputerLiveState?.get(key);
      if (st) {
        rep.state = [...st.took];
        const back = st.took.filter((n) => st.mutable.includes(n));
        if (liveState && back.length) {
          undo.push(() => { for (const n of back) try { liveState[n] = st.state[n]; } catch { /* gone */ } });
        }
      }
      const hook = ns.__hotswap;
      if (typeof hook === 'function') {
        rep.hook = true;
        const ctx: HookContext = { key, old: liveNs, instances: instancesOf, onRevert: (fn) => { undo.push(fn); } };
        const r = hook(ctx);
        if (typeof r === 'function') undo.push(r as () => void);
      }
    }
  } catch (e) {
    runUndo(undo.splice(start));
    throw e;
  }
  return reports;
}

function runUndo(steps: (() => void)[]): string[] {
  const errors: string[] = [];
  for (let i = steps.length - 1; i >= 0; i--) {
    try { steps[i](); } catch (e: any) { errors.push(e?.message ?? String(e)); }
  }
  return errors;
}

export type RevertReason = 'manual' | 'ttl' | 'error' | 'wedge';

// Hot-swap's own long work (a test run is on the page's thread, and so is an
// esbuild-wasm build where there are no Workers): a freeze during it isn't a
// swap's fault (revertOnWedge)
let quietDepth = 0;
const quietSpans: [number, number][] = [];
export async function quietDuring<T>(fn: () => Promise<T>): Promise<T> {
  quietDepth++;
  const t0 = Date.now();
  try { return await fn(); } finally {
    quietDepth--;
    quietSpans.push([t0, Date.now()]);
    if (quietSpans.length > 20) quietSpans.shift();
  }
}
function quietOverlaps(from: number, to: number): boolean {
  return quietDepth > 0 || quietSpans.some(([a, b]) => a <= to && b >= from);
}

/** The stack of applied swaps, with TTLs. One per page (`hotswap` below). */
export class HotswapManager {
  stack: SwapRecord[] = [];
  private nextId = 1;
  /** Called after a TTL (or anything other than a manual revert) undid swaps */
  onAutoRevert?: (records: SwapRecord[], reason: RevertReason) => void;

  apply(modules: Record<string, Record<string, unknown>>, meta: ApplyMeta = {}): SwapRecord {
    const undo: (() => void)[] = [];
    const report = swapModules(modules, undo);
    const ttl = meta.ttlMs && meta.ttlMs > 0 ? meta.ttlMs : null;
    const rec: SwapRecord = {
      id: this.nextId++,
      label: meta.label ?? (meta.files ?? Object.keys(modules)).join(' '),
      files: meta.files ?? Object.keys(modules),
      appliedAt: Date.now(),
      deadline: ttl && !meta.confirmed ? Date.now() + ttl : null,
      confirmed: !!meta.confirmed,
      code: meta.code ?? '',
      hash: meta.hash ?? '',
      report,
      undo,
    };
    this.stack.push(rec);
    if (rec.deadline) {
      rec.timer = setTimeout(() => {
        if (!this.stack.includes(rec) || rec.confirmed) return;
        const undone = this.revertThrough(rec);
        if (this.onAutoRevert) this.onAutoRevert(undone, 'ttl');
        else console.warn(`[hotswap] reverted ${undone.map((r) => `#${r.id}`).join(', ')}: #${rec.id} wasn't confirmed in time`);
      }, ttl!);
    }
    return rec;
  }

  /** Confirm every pending swap (or one by id): their TTLs stop */
  confirm(id?: number): SwapRecord[] {
    const out: SwapRecord[] = [];
    for (const r of this.stack) {
      if (r.confirmed || (id !== undefined && r.id !== id)) continue;
      r.confirmed = true;
      r.deadline = null;
      clearTimeout(r.timer);
      out.push(r);
    }
    return out;
  }

  /** Revert the newest swap, or all of them */
  revert(all = false): SwapRecord[] {
    if (!this.stack.length) return [];
    return this.revertThrough(all ? this.stack[0] : this.stack[this.stack.length - 1]);
  }

  /**
   * Fold `prev`, the swap right below `rec`, into `rec` (`hotswap watch`: one
   * record per editing session). Reverting `rec` then undoes both, its TTL
   * covers both, and `rec.files` is their union. `prev` must be unconfirmed.
   */
  squash(prev: SwapRecord, rec: SwapRecord): boolean {
    const i = this.stack.indexOf(rec);
    if (i < 1 || this.stack[i - 1] !== prev || prev.confirmed) return false;
    this.stack.splice(i - 1, 1);
    clearTimeout(prev.timer);
    // The files each record's own bundle (its code) builds
    const own = rec.bundleFiles ?? rec.files;
    const prevOwn = prev.bundleFiles ?? prev.files;
    rec.bundleFiles = own;
    // (runUndo runs steps newest first: rec's, then prev's)
    rec.undo = [...prev.undo, ...rec.undo];
    rec.files = [...new Set([...prev.files, ...own])];
    rec.label = rec.files.join(' ');
    rec.appliedAt = Math.min(prev.appliedAt, rec.appliedAt);
    const parts = [...(prev.parts ?? []), { label: prev.label, files: prevOwn, code: prev.code, hash: prev.hash }];
    // A part whose files later parts (or rec's own bundle) all rebuild isn't needed to persist this
    rec.parts = parts.filter((p, j) => {
      const later = new Set([...parts.slice(j + 1).flatMap((q) => q.files), ...own]);
      return !p.files.every((f) => later.has(f));
    });
    return true;
  }

  /** Revert `rec` and every swap applied after it (they may build on it), newest first */
  revertThrough(rec: SwapRecord): SwapRecord[] {
    const i = this.stack.indexOf(rec);
    if (i < 0) return [];
    const undone = this.stack.splice(i).reverse();
    for (const r of undone) {
      clearTimeout(r.timer);
      const errors = runUndo(r.undo);
      if (errors.length) console.warn(`[hotswap] revert #${r.id}: ${errors.join('; ')}`);
    }
    return undone;
  }

  pending(): SwapRecord[] {
    return this.stack.filter((r) => !r.confirmed);
  }

  /**
   * The page froze (watchdog onWedge) and runs again: an unconfirmed swap
   * applied before the freeze began may have caused it, so revert the oldest
   * such swap and everything after it, as its TTL would have. A freeze during
   * hot-swap's own builds and test runs (quietDuring) doesn't count.
   */
  revertOnWedge(frozenMs: number, since: number): SwapRecord[] {
    if (quietOverlaps(since, since + frozenMs)) return [];
    const first = this.stack.find((r) => !r.confirmed && r.appliedAt <= since);
    if (!first) return [];
    const undone = this.revertThrough(first);
    if (this.onAutoRevert) this.onAutoRevert(undone, 'wedge');
    else console.warn(`[hotswap] reverted ${undone.map((r) => `#${r.id}`).join(', ')}: the page froze for ${Math.round(frozenMs / 1000)} s`);
    return undone;
  }
}

export const hotswap = new HotswapManager();
onWedge((ms, since) => { hotswap.revertOnWedge(ms, since); });

/** Load a built swap bundle (build.ts) and return its modules by live key */
export async function evaluateBundle(code: string): Promise<Record<string, Record<string, unknown>>> {
  // Lazy live modules it imports statically (build.ts NEEDS_PREFIX)
  const first = /^\/\/ hotswap-needs: (.*)\n/.exec(code);
  if (first) for (const key of JSON.parse(first[1]) as string[]) await liveImport(key);
  const mod: any = await importCode(code);
  const keys: string[] = mod.__keys;
  if (!Array.isArray(keys)) throw new Error('not a hotswap bundle (no __keys)');
  const out: Record<string, Record<string, unknown>> = {};
  keys.forEach((k, i) => { out[k] = mod[`m${i}`]; });
  return out;
}

/** Import JavaScript source as an ES module (a blob: URL; a data: URL under Node) */
let imports = 0;
export async function importCode(code: string): Promise<any> {
  // (a fresh module every time, even for the same source: data: URLs are cached)
  code += `\n// ${++imports}\n`;
  let url: string | null = null;
  try { url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })); } catch { /* no blob: URLs */ }
  // (Node makes blob: URLs it can't import; it imports data: ones)
  if (url?.startsWith('blob:nodedata:')) { URL.revokeObjectURL(url); url = null; }
  try {
    return await import(/* @vite-ignore */ url ?? 'data:text/javascript;base64,' + btoa(unescape(encodeURIComponent(code))));
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}
