/**
 * The page side of claude --vm's code cache (code-cache.ts): public/vm-sw.js,
 * registered at the first `claude --vm` and controlling this page from then
 * on, so the node worker that runs Claude Code can import its compiled bundle.
 * Pages that never run `claude --vm` get no service worker.
 *
 * Each launch reads /vm-sw.js first: deployed with ENABLED = false, or gone,
 * it is the off switch (the worker is unregistered, its cache emptied, and
 * this launch requires bundle.js).
 */
const SCRIPT = '/vm-sw.js';
const CACHE = 'tabcomputer-vm';

export interface SwDeps {
  fetch: typeof fetch;
  serviceWorker: ServiceWorkerContainer | undefined;
  caches: CacheStorage | undefined;
}

const defaults = (): SwDeps => ({
  fetch: (...a) => fetch(...a),
  serviceWorker: typeof navigator !== 'undefined' && typeof location !== 'undefined' && location.protocol !== 'file:' ? navigator.serviceWorker : undefined,
  caches: typeof caches !== 'undefined' ? caches : undefined,
});

/** Whether this launch can import the compiled bundle (false: it requires bundle.js) */
export async function ensureVmServiceWorker(deps: SwDeps = defaults(), timeoutMs = 5000): Promise<boolean> {
  const sw = deps.serviceWorker;
  if (!sw) return false;
  try {
    const script = await deps.fetch(SCRIPT, { cache: 'no-store' }).catch(() => null);
    // (only the worker itself, switched on: not a 404, nor a page the server answers with instead)
    const on = !!script?.ok && /^const ENABLED\s*=\s*true\b/m.test(await script.text());
    if (!on) {
      await retire(deps);
      return false;
    }
    const before = sw.controller;
    await sw.register(SCRIPT, { scope: '/' });
    if (before) return true;
    // (it claims this page once active, and its workers: the node workers already running too)
    return await new Promise<boolean>((resolve) => {
      const done = (v: boolean) => { clearTimeout(t); sw.removeEventListener('controllerchange', onChange); resolve(v); };
      const onChange = () => done(true);
      const t = setTimeout(() => done(!!sw.controller), timeoutMs);
      if (sw.controller) done(true);
      else sw.addEventListener('controllerchange', onChange);
    });
  } catch (e) {
    console.warn('[claude --vm] service worker unavailable; the bundle compiles each launch:', e);
    return false;
  }
}

/** The off switch: vm-sw.js unregistered (it still answers this page until it reloads) and the cache emptied */
async function retire(deps: SwDeps): Promise<void> {
  const regs = await deps.serviceWorker?.getRegistrations().catch(() => []) ?? [];
  for (const r of regs) {
    const w = r.active ?? r.waiting ?? r.installing;
    if (w && new URL(w.scriptURL).pathname === SCRIPT) await r.unregister().catch(() => false);
  }
  await deps.caches?.delete(CACHE).catch(() => false);
}
