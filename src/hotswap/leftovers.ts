/**
 * What a `hotswap test` run can leave behind in the live page (#47), and
 * putting it back.
 *
 * A suite runs its own copies of every module, in the page. They reach the
 * page through its globals: the `__tabcomputer*` handles (the kernel, the
 * live module maps) and the live kernel's program hooks. A copy of
 * node-worker/boot.ts that installs its loader on the page's kernel, or a
 * copy of getKernel() that publishes its own kernel while the page's was
 * unset, made every `node` in the page's terminals run the suite's
 * blob-evaluated copy of host.ts ("Invalid URL"). The runner snapshots these
 * before a run and restores them after; `hotswap status` reports what it had
 * to restore, and kernel hooks that weren't there when the page booted.
 */

/** Page globals a run may replace, add or delete: every `__tabcomputer*` but the log (shared on purpose) */
const isPageGlobal = (k: string) => k.startsWith('__tabcomputer') && k !== '__tabcomputerKlog';
/** Live maps a run may add entries to (live.ts, vite-plugin-hotswap.ts) */
const LIVE_MAPS = ['__tabcomputerLive', '__tabcomputerLiveLoaders', '__tabcomputerLiveUrls', '__tabcomputerLiveState'];

interface KernelHooks { loaders: unknown[]; execDirect: unknown[] }

export interface PageSnapshot {
  globals: Map<string, unknown>;
  maps: Map<string, Map<unknown, unknown>>;
  kernel: { k: object; hooks: KernelHooks } | null;
}

/** A kernel's program hooks (Kernel's `loaders` is private; execDirect is public) */
function hooksOf(k: any): KernelHooks | null {
  return k && Array.isArray(k.loaders) && Array.isArray(k.execDirect) ? { loaders: k.loaders, execDirect: k.execDirect } : null;
}

export function snapshotPage(g: any = globalThis): PageSnapshot {
  const globals = new Map<string, unknown>();
  for (const k of Object.keys(g)) if (isPageGlobal(k)) globals.set(k, g[k]);
  const maps = new Map<string, Map<unknown, unknown>>();
  for (const name of LIVE_MAPS) if (g[name] instanceof Map) maps.set(name, new Map(g[name]));
  const k = g.__tabcomputerKernel;
  const hooks = hooksOf(k);
  return { globals, maps, kernel: hooks ? { k, hooks: { loaders: [...hooks.loaders], execDirect: [...hooks.execDirect] } } : null };
}

/** Put the page back as `snap` had it; returns what had changed (for `hotswap status`) */
export function restorePage(snap: PageSnapshot, g: any = globalThis): string[] {
  const changed: string[] = [];
  for (const k of Object.keys(g)) {
    if (!isPageGlobal(k) || snap.globals.has(k) || k === '__tabcomputerTestLeftovers') continue;
    changed.push(`global ${k} added`);
    delete g[k];
  }
  for (const [k, v] of snap.globals) {
    if (g[k] === v) continue;
    changed.push(`global ${k} replaced`);
    g[k] = v;
  }
  for (const [name, before] of snap.maps) {
    const now: Map<unknown, unknown> | undefined = g[name];
    if (!(now instanceof Map)) continue;
    for (const key of [...now.keys()]) {
      if (!before.has(key)) { now.delete(key); changed.push(`${name} ${String(key)} added`); }
    }
    for (const [key, v] of before) {
      if (now.get(key) !== v) { now.set(key, v); changed.push(`${name} ${String(key)} replaced`); }
    }
  }
  if (snap.kernel) {
    const hooks = hooksOf(snap.kernel.k)!;
    for (const which of ['loaders', 'execDirect'] as const) {
      const live = hooks[which], was = snap.kernel.hooks[which];
      const added = live.filter((h) => !was.includes(h)).length;
      if (added || live.length !== was.length) {
        changed.push(`kernel ${which}: ${added} added by the run, removed`);
        live.splice(0, live.length, ...was);
      }
    }
  }
  return changed;
}

/** The page's kernel hooks at boot (main.ts), to tell later additions apart */
const baseline = new WeakMap<object, KernelHooks>();
export function markKernelBaseline(k: object): void {
  const hooks = hooksOf(k);
  if (hooks) baseline.set(k, { loaders: [...hooks.loaders], execDirect: [...hooks.execDirect] });
}

/** Hooks on the page's kernel that weren't there at boot (a swap or a test's copy installed them) */
export function foreignKernelHooks(g: any = globalThis): string[] {
  const k = g.__tabcomputerKernel;
  const hooks = hooksOf(k), base = k && baseline.get(k);
  if (!hooks || !base) return [];
  const out: string[] = [];
  const extra = (which: 'loaders' | 'execDirect') => hooks[which].filter((h) => !base[which].includes(h)).length;
  for (const which of ['loaders', 'execDirect'] as const) {
    const n = extra(which);
    if (n) out.push(`${n} kernel ${which === 'loaders' ? 'program loader' : 'exec-in-place hook'}${n === 1 ? '' : 's'} added since boot`);
  }
  return out;
}

/** What the last test run left that the runner had to restore (kept for `hotswap status`) */
export function recordTestLeftovers(changed: string[], g: any = globalThis): void {
  g.__tabcomputerTestLeftovers = { at: Date.now(), changed };
}
export function lastTestLeftovers(g: any = globalThis): { at: number; changed: string[] } | null {
  return g.__tabcomputerTestLeftovers ?? null;
}
