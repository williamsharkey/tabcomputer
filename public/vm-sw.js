// claude --vm's compiled code (src/claude-vm/code-cache.ts, docs/CLAUDE_VM.md).
// V8 keeps the code it compiled for a script a service worker serves from
// CacheStorage, which it never does for node-compat's `new Function`: bundle.js
// is put in the 'tabcomputer-vm' cache and imported from /__vm/. Registered by
// the first `claude --vm` (src/claude-vm/sw-host.ts). Every other request skips
// this worker (a static route where the browser has them; otherwise the fetch
// handler returns without answering, and the browser fetches it as usual).
//
// Off switch: deploy this file with ENABLED = false (or delete it). The next
// `claude --vm` reads it first, and on either the page unregisters the worker
// and empties the cache; a browser that updates this worker gets one that
// does the same. Launches until then require bundle.js as before.
const ENABLED = true;
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
