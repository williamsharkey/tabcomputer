// The frame around an app's page, on the app's own origin (docs/APPS.md "The page's origin").
// server.mjs serves it at /__tabcomputer/frame.html?n=NONCE on app hosts only.
//
// It is the one thing on this origin that holds a port to the tab. It registers the origin's
// service worker (sw.js), tells the tab it is ready, takes the port the tab answers with, and
// then shows the app's page in a frame of its own. The worker hands it the page's requests;
// it passes them to the tab and the answers back. A page's tab.js port goes the same way.
(function () {
  'use strict';
  var script = document.currentScript;
  var patterns = (script.getAttribute('data-apps') || '').split(' ').filter(Boolean);
  var zone = script.getAttribute('data-zone') || '';
  var nonce = new URLSearchParams(location.search).get('n') || '';
  var sw = navigator.serviceWorker;
  var tab = null, inner = null, current = '/', worker = null, seq = 0;
  var pending = new Map(); // id → the worker's reply port
  var text = function (s) { return new TextEncoder().encode(s).buffer; };

  // The tab: an origin the server lists, never a browse origin or another app's
  function allowed(origin) {
    var m = /^(https?:\/\/)([^/]+)$/.exec(String(origin).toLowerCase());
    if (!m) return false;
    var host = m[2], first = host.split('.')[0];
    if (/^app--/.test(first)) return false;
    if (zone && host.endsWith('.' + zone) && first.indexOf('-') >= 0 && !/^guest--[a-z0-9]{1,32}(--(t|x|tx))?$/.test(first)) return false;
    return patterns.some(function (p) {
      var star = p.indexOf('://*.');
      if (star < 0) return p === m[1] + host;
      return p.slice(0, star + 3) === m[1] && host.endsWith(p.slice(star + 4)) && host.length > p.length - star - 4;
    });
  }

  function refuse(port, status, why) {
    port.postMessage({ status: status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: text(why) });
  }

  if (!sw || window.parent === window || !nonce) {
    document.body.textContent = 'This address is part of tabcomputer: an app shows here when it is opened from the desktop.';
    return;
  }

  sw.addEventListener('message', function (e) {
    var d = e.data, reply = e.ports[0];
    if (!d || d.type !== 'tc-fetch' || !reply) return;
    if (!tab) return refuse(reply, 503, 'The app is not connected to its tab yet.');
    var id = ++seq;
    pending.set(id, reply);
    tab.postMessage({ t: 'fetch', id: id, method: d.method, path: d.path, headers: d.headers, body: d.body, navigate: d.navigate }, d.body ? [d.body] : []);
  });
  sw.startMessages();

  function fromTab(e) {
    var m = e.data;
    if (!m) return;
    if (m.t === 'res') {
      var reply = pending.get(m.id);
      if (!reply) return;
      pending.delete(m.id);
      var msg = { status: m.status, statusText: m.statusText, headers: m.headers, body: m.body };
      try { reply.postMessage(msg, m.body && typeof m.body === 'object' ? [m.body] : []); }
      catch (err) { refuse(reply, 502, 'The answer could not be passed on: ' + err); }
    } else if (m.t === 'go') show(typeof m.path === 'string' && m.path.charAt(0) === '/' ? m.path : '/');
    else if (m.t === 'reload') show(current);
  }

  // The worker binds the next navigation to this URL to this frame
  function expect(url) {
    return new Promise(function (resolve) {
      if (!worker) return resolve();
      var ch = new MessageChannel();
      var timer = setTimeout(resolve, 3000);
      ch.port1.onmessage = function () { clearTimeout(timer); resolve(); };
      worker.postMessage({ type: 'tc-expect', nonce: nonce, url: url }, [ch.port2]);
    });
  }

  function hook() {
    // The page answers for its frame when a restarted worker asks whose it is
    try {
      var w = inner.contentWindow;
      w.navigator.serviceWorker.addEventListener('message', function (e) {
        if (e.data && e.data.type === 'tc-whoami' && e.ports[0]) e.ports[0].postMessage({ nonce: nonce });
      });
      w.navigator.serviceWorker.startMessages();
      if (tab) tab.postMessage({ t: 'loaded', path: w.location.pathname + w.location.search, title: w.document.title });
    } catch (err) { /* the page went elsewhere */ }
  }

  function show(path) {
    current = path;
    var url = new URL(path, location.origin).href;
    expect(url).then(function () {
      if (inner) inner.remove();
      inner = document.createElement('iframe');
      inner.setAttribute('allow', 'clipboard-write; fullscreen');
      inner.addEventListener('load', hook);
      inner.src = url;
      document.body.appendChild(inner);
    });
  }

  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d) return;
    if (e.source === window.parent && d.type === 'tc-app-init' && e.ports[0] && allowed(e.origin)) {
      if (tab) tab.close();
      tab = e.ports[0];
      tab.onmessage = fromTab;
      show(typeof d.path === 'string' && d.path.charAt(0) === '/' ? d.path : '/');
    } else if (inner && e.source === inner.contentWindow && d.type === 'tc-tab-connect' && e.ports[0] && tab) {
      tab.postMessage({ t: 'connect' }, [e.ports[0]]);
    }
  });

  sw.register('/__tabcomputer/sw.js', { scope: '/' }).then(function () { return sw.ready; }).then(function (reg) {
    worker = reg.active;
    window.parent.postMessage({ type: 'tc-app-ready', nonce: nonce }, '*');
  }).catch(function (err) {
    document.body.textContent = 'This browser did not start the app\'s service worker (' + err + ').';
    window.parent.postMessage({ type: 'tc-app-failed', nonce: nonce, error: String(err) }, '*');
  });
})();
