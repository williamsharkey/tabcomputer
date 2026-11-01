/**
 * Earlier builds registered /vm-sw.js at the first `claude --vm`, to serve
 * Claude Code's bundle from CacheStorage so that V8 would keep its compiled
 * code. Chrome keeps none for a script a service worker serves a dedicated
 * worker that way, so it bought nothing (docs/CLAUDE_VM.md). The worker is
 * now shipped switched off (it unregisters itself when the browser updates
 * it); this takes it out at once, with its cache, in a page that still has it.
 */
const SCRIPT = '/vm-sw.js';
const CACHE = 'tabcomputer-vm';
let done = false;

export async function retireVmServiceWorker(sw: ServiceWorkerContainer | undefined = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined,
  storage: CacheStorage | undefined = typeof caches !== 'undefined' ? caches : undefined): Promise<void> {
  if (done || !sw) return;
  done = true;
  for (const r of await sw.getRegistrations().catch(() => [] as readonly ServiceWorkerRegistration[])) {
    const w = r.active ?? r.waiting ?? r.installing;
    if (w && new URL(w.scriptURL).pathname === SCRIPT) await r.unregister().catch(() => false);
  }
  await storage?.delete(CACHE).catch(() => false);
}
