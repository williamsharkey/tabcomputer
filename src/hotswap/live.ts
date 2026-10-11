/**
 * The page's live modules and instances, for hot-swapping (docs/HOTSWAP.md).
 *
 * vite-plugin-hotswap.ts makes every module under src/ register its own
 * namespace here under its path ('src/shell.ts'), and the npm modules in its
 * LIVE_DEPS under 'npm:NAME'. A swap bundle imports these instead of fresh
 * copies, so it shares the page's singletons.
 *
 * Classes whose live instances should get `migrateFrom` after a swap call
 * trackInstance(this) in their constructor.
 */

export type LiveMap = Map<string, Record<string, unknown>>;

export function liveModules(): LiveMap {
  const g = globalThis as any;
  return (g.__tabcomputerLive ??= new Map());
}

/** A live module's namespace by path ('src/shell.ts'), or undefined if it isn't loaded */
export function liveModule(key: string): Record<string, unknown> | undefined {
  return liveModules().get(key);
}

export type LiveLoaders = Map<string, () => Promise<Record<string, unknown>>>;

/** Loaders for lazy modules, by path (the Vite plugin registers each import() of one) */
export function liveLoaders(): LiveLoaders {
  const g = globalThis as any;
  return (g.__tabcomputerLiveLoaders ??= new Map());
}

/**
 * A live module, loading it the page's way if it's a lazy chunk not loaded
 * yet. A swap bundle's import() of a module outside the swap set comes here.
 */
export async function liveImport(key: string): Promise<Record<string, unknown>> {
  const have = liveModules().get(key);
  if (have) return have;
  const load = liveLoaders().get(key);
  if (!load) throw new Error(`hotswap: ${key} isn't a live module and the page has no loader for it`);
  const ns = await load();
  if (!liveModules().has(key)) liveModules().set(key, ns);
  return liveModules().get(key)!;
}
(globalThis as any).__tabcomputerLiveImport = liveImport;

/** Register a namespace by hand (tests, and modules the Vite plugin doesn't see) */
export function registerLive(key: string, ns: Record<string, unknown>): void {
  liveModules().set(key, ns);
}

const tracked = new Map<Function, Set<WeakRef<object>>>();

/** Remember a live instance of its class, for a swap's migrateFrom (weakly) */
export function trackInstance(obj: object): void {
  if (typeof WeakRef === 'undefined') return;
  const cls = obj.constructor;
  let set = tracked.get(cls);
  if (!set) tracked.set(cls, (set = new Set()));
  // Prune now and then so a class with many short-lived instances (forked shells) stays small
  if (set.size >= 256 && (set.size & 63) === 0) for (const r of set) if (!r.deref()) set.delete(r);
  set.add(new WeakRef(obj));
}

/** The live tracked instances of a class (and of classes it was swapped with) */
export function instancesOf(cls: Function): object[] {
  const out: object[] = [];
  for (const [c, set] of tracked) {
    if (c !== cls && !(c.prototype instanceof cls) && !sameLineage(c, cls)) continue;
    for (const r of set) {
      const o = r.deref();
      if (o) out.push(o); else set.delete(r);
    }
  }
  return out;
}

/** Classes made equivalent by a swap (swap.ts records them) */
export const lineage = new Map<Function, Set<Function>>();
function sameLineage(a: Function, b: Function): boolean {
  return !!lineage.get(b)?.has(a) || !!lineage.get(a)?.has(b);
}
