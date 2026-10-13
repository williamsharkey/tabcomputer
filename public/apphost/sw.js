// The service worker of an app origin (docs/APPS.md "The page's origin").
//
// An installed app's page lives on an origin of its own, app--….<zone>. That
// host serves only /__tabcomputer/ (this worker, the frame, tab.js); every
// other request of the app's page comes here and is handed to the tab the app
// is open in, which answers from the app's files or its backend:
//
//   the app's page ──fetch──▶ this worker ──▶ the frame around the page
//        (/__tabcomputer/frame.html?n=NONCE) ──MessagePort──▶ the tab
//
// Which frame a request belongs to: a page's requests carry its client id,
// bound to its frame's nonce when the page was navigated to (the frame says
// which navigation is its own just before it starts one). After this worker
// was restarted the binding is asked of the page's frame again.
const FRAME = '/__tabcomputer/frame.html';
const OWN = '/__tabcomputer/';
/** clientId → nonce of the frame around that page */
const owners = new Map();
/** The navigation a frame announced: { nonce, url, done } */
let expected = null;
let gate = Promise.resolve();

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('message', (e) => {
  const d = e.data;
  if (d?.type !== 'tc-expect' || typeof d.nonce !== 'string' || typeof d.url !== 'string' || !e.ports[0]) return;
  const reply = e.ports[0];
  // One announced navigation at a time: two tabs opening the same app can't take each other's
  gate = gate.then(() => new Promise((done) => {
    const mine = { nonce: d.nonce, url: d.url, done };
    expected = mine;
    reply.postMessage('go');
    setTimeout(() => { if (expected === mine) expected = null; done(); }, 5000);
  }));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith(OWN)) return;
  e.respondWith(handle(e, url));
});

const frames = async () => (await self.clients.matchAll({ type: 'window', includeUncontrolled: true }))
  .filter((c) => new URL(c.url).pathname === FRAME);
const nonceOf = (c) => new URL(c.url).searchParams.get('n');

function ask(client, msg, ms) {
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), ms);
    ch.port1.onmessage = (m) => { clearTimeout(timer); resolve(m.data); };
    client.postMessage(msg, [ch.port2]);
  });
}

async function ownerOf(e, url) {
  if (e.request.mode === 'navigate') {
    let nonce = null;
    if (expected && expected.url === url.href) {
      nonce = expected.nonce;
      expected.done();
      expected = null;
    } else {
      // A link inside the app: the frame whose page it came from
      const all = await frames();
      if (all.length === 1) nonce = nonceOf(all[0]);
      else {
        const pages = await self.clients.matchAll({ type: 'window' });
        const from = new Set(pages.filter((c) => c.url === e.request.referrer && owners.has(c.id)).map((c) => owners.get(c.id)));
        nonce = from.size ? [...from][0] : all.length ? nonceOf(all[0]) : null;
      }
    }
    if (nonce && e.resultingClientId) owners.set(e.resultingClientId, nonce);
    return nonce;
  }
  const id = e.clientId;
  if (!id) return null;
  if (owners.has(id)) return owners.get(id);
  // This worker was restarted: the page's frame answers for it (frame.js listens in the page)
  const client = await self.clients.get(id);
  if (!client) return null;
  for (let i = 0; i < 20; i++) {
    const r = await ask(client, { type: 'tc-whoami' }, 250);
    if (r && typeof r.nonce === 'string') { owners.set(id, r.nonce); return r.nonce; }
  }
  const all = await frames();
  return all.length === 1 ? nonceOf(all[0]) : null;
}

async function handle(e, url) {
  const request = e.request;
  const nonce = await ownerOf(e, url);
  const frame = nonce ? (await frames()).find((c) => nonceOf(c) === nonce) : null;
  if (!frame) {
    return new Response('This app is not open in a tabcomputer tab. Open it from tabcomputer.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  }
  const method = request.method.toUpperCase();
  const body = method === 'GET' || method === 'HEAD' ? null : await request.arrayBuffer();
  const headers = {};
  request.headers.forEach((v, k) => { headers[k] = v; });
  const navigate = request.mode === 'navigate';
  const msg = { type: 'tc-fetch', method, path: url.pathname + url.search, headers, body, navigate };
  const reply = await new Promise((resolve) => {
    const ch = new MessageChannel();
    const timer = setTimeout(() => resolve(null), 120000);
    ch.port1.onmessage = (m) => { clearTimeout(timer); resolve(m.data); };
    frame.postMessage(msg, body ? [ch.port2, body] : [ch.port2]);
  });
  if (!reply) return new Response('The tab did not answer.', { status: 504, headers: { 'content-type': 'text/plain; charset=utf-8' } });
  const h = new Headers();
  for (const [k, v] of Object.entries(reply.headers || {})) { try { h.set(k, v); } catch { /* not a header the Fetch API takes */ } }
  // The tab is cross-origin isolated: a document framed under it needs the same policy
  if (navigate) h.set('cross-origin-embedder-policy', 'credentialless');
  const noBody = method === 'HEAD' || reply.status === 204 || reply.status === 205 || reply.status === 304;
  return new Response(noBody ? null : reply.body, { status: reply.status || 200, statusText: reply.statusText || '', headers: h });
}
