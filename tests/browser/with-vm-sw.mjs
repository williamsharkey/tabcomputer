// Run any browser test with claude --vm's service worker (public/vm-sw.js) in
// every page it opens, to show the rest of the app is unchanged under it:
//
//   node --import ./tests/browser/with-vm-sw.mjs tests/browser/hotswap.mjs [URL]
//
// Each page registers /vm-sw.js at scope / as it loads (as the first
// `claude --vm` does): the first load is taken mid-boot, later ones are
// controlled from the start. At exit it prints how many responses outside
// /__vm/ (and preview-sw.js's /__preview/) came from a service worker (there should be none).
import { createRequire } from 'node:module';
const require = createRequire(new URL('./x.mjs', import.meta.url));
let pw;
try { pw = require('playwright'); } catch { pw = require('/opt/node-tools/node_modules/playwright'); }

let viaWorker = 0, pages = 0, controlledLoads = 0;
const register = () => {
  if (window.top !== window || !navigator.serviceWorker || location.pathname.startsWith('/__preview/')) return;
  navigator.serviceWorker.register('/vm-sw.js', { scope: '/' }).catch((e) => console.warn('[with-vm-sw]', e));
};
const watch = (context) => {
  context.addInitScript(register);
  context.on('page', (p) => {
    pages++;
    p.on('load', () => { p.evaluate(() => navigator.serviceWorker?.controller?.scriptURL ?? '').then((u) => { if (u.endsWith('/vm-sw.js')) controlledLoads++; }, () => {}); });
    // (/__preview/ is preview-sw.js's scope: those it answers by design)
    p.on('response', (r) => { const path = new URL(r.url()).pathname; if (r.fromServiceWorker() && !path.startsWith('/__vm/') && !path.startsWith('/__preview/')) { viaWorker++; console.log(`[with-vm-sw] from the worker: ${r.url()}`); } });
  });
  return context;
};
const launch = pw.chromium.launch.bind(pw.chromium);
pw.chromium.launch = async (...a) => {
  const browser = await launch(...a);
  const newContext = browser.newContext.bind(browser);
  browser.newContext = async (...b) => watch(await newContext(...b));
  const newPage = browser.newPage.bind(browser);
  browser.newPage = async (...b) => { const p = await newPage(...b); watch(p.context()); pages++; return p; };
  return browser;
};
const persistent = pw.chromium.launchPersistentContext.bind(pw.chromium);
pw.chromium.launchPersistentContext = async (...a) => watch(await persistent(...a));
process.on('exit', () => console.log(`[with-vm-sw] ${pages} page(s), ${controlledLoads} load(s) controlled by vm-sw.js; responses outside /__vm/ from the worker: ${viaWorker}`));
