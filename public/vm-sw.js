// Switched off. Earlier builds registered this worker at the first `claude --vm`
// to serve Claude Code's bundle from CacheStorage so that V8 would keep its
// compiled code; Chrome keeps none for a script a service worker serves a
// dedicated worker (docs/CLAUDE_VM.md). A browser that updates it gets this
// one, which unregisters itself and empties its cache (and `claude` does the
// same in a page that still has it: src/claude-vm/sw-host.ts).
const ENABLED = false;
const PREFIX = '/__vm/';
const CACHE = 'tabcomputer-vm';

self.addEventListener('install', (e) => {
  if (ENABLED) {
    try {
      e.addRoutes?.([{ condition: { not: { urlPattern: new URLPattern({ pathname: PREFIX + '*' }) } }, source: 'network' }]);
    } catch { /* no URLPattern or routes here: the fetch handler's check does it */ }
  }
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(ENABLED ? self.clients.claim() : Promise.all([caches.delete(CACHE), self.registration.unregister()]));
});

self.addEventListener('fetch', (e) => {
  if (!ENABLED) return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return;
  if (url.pathname === PREFIX + 'probe.mjs') {
    e.respondWith(new Response("export default 'tabcomputer-vm';\n", { headers: { 'content-type': 'text/javascript' } }));
    return;
  }
  e.respondWith(caches.open(CACHE).then((c) => c.match(e.request))
    .then((r) => r || new Response('not in the tabcomputer-vm cache', { status: 404, headers: { 'content-type': 'text/plain' } })));
});
