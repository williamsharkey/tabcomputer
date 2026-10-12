// Converter page. Talks to server.js (same origin, relative URLs) with fetch only:
// no tabcomputer-specific API, so it runs the same in a Preview window, in app
// mode, in a browser tab of its own, or against `node server.js` on any machine.
(function () {
  'use strict';
  var T0 = performance.now();
  var $ = function (id) { return document.getElementById(id); };
  var params = new URLSearchParams(location.search);
  var CONCURRENCY = Math.max(1, Number(params.get('c')) || 2);
  var state = { job: null, to: 'html', ready: false, status: null, rows: [], queue: [], active: 0, setup: null, marks: { script: Math.round(T0) } };
  window.__converter = state; // for tests and timing

  // Workaround (docs/research/APP_MAKER.md, gap "two fetch bridges"): in app mode the page is a
  // srcdoc frame, where only a '/'-rooted URL reaches the bridge that carries bytes; in a
  // Preview window the page lives under /__preview/TAB/PORT/, where relative URLs are the safe form.
  var SRCDOC = location.protocol === 'about:';
  function api(path, init) { return fetch((SRCDOC ? '/' : '') + path, init); }
  // In app mode a click on a link replaces the app (the host turns it into a navigation), so
  // results open from a blob instead.
  function openResult(e) {
    if (!SRCDOC) return;
    e.preventDefault(); e.stopPropagation();
    var href = e.currentTarget.getAttribute('href');
    var w = window.open('', '_blank');
    api(href).then(function (r) { return r.blob(); }).then(function (b) { if (w) w.location = URL.createObjectURL(b); });
  }
  function store(k, v) { try { if (v === undefined) return localStorage.getItem('converter-' + k); if (v === null) localStorage.removeItem('converter-' + k); else localStorage.setItem('converter-' + k, v); } catch (e) { return null; } }
  function newJob() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function enc(rel) { return rel.split('/').map(encodeURIComponent).join('/'); }
  function fmt(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }

  // ── status ──
  function loadStatus(fresh) {
    return api('api/status' + (fresh ? '?fresh=1' : '')).then(function (r) { return r.json(); }).then(function (st) {
      state.status = st; state.ready = st.ready;
      var sel = $('to'), keep = sel.value;
      sel.innerHTML = '';
      st.outputs.forEach(function (o) { var op = document.createElement('option'); op.value = o; op.textContent = o.toUpperCase(); sel.appendChild(op); });
      sel.value = st.outputs.indexOf(keep) >= 0 ? keep : 'html';
      state.to = sel.value;
      return st;
    });
  }

  // ── first use ──
  function ensureReady() {
    if (state.ready) return Promise.resolve(true);
    if (state.setup) return state.setup;
    $('setup').hidden = false;
    var log = $('setup-log'), t0 = performance.now();
    state.marks.setupStart = Math.round(t0);
    state.setup = api('api/setup', { method: 'POST' }).then(function (r) {
      var reader = r.body.getReader(), dec = new TextDecoder();
      function pump() {
        return reader.read().then(function (x) {
          if (x.done) return;
          var s = dec.decode(x.value, { stream: true });
          log.textContent += s; log.scrollTop = log.scrollHeight;
          var step = /== ([^\n]+)\n[^=]*$/.exec(log.textContent);
          if (step) $('setup-msg').textContent = step[1] + '… (' + Math.round((performance.now() - t0) / 1000) + ' s)';
          return pump();
        });
      }
      return pump();
    }).then(function () { return loadStatus(true); }).then(function (st) {
      state.setup = null;
      state.marks.setupMs = Math.round(performance.now() - t0);
      if (st.ready) { $('setup').hidden = true; return true; }
      $('setup-bar').hidden = true;
      $('setup-msg').textContent = 'The converters could not be installed. This needs tabcomputer\'s Debian and a network connection. Details below.';
      $('setup').querySelector('details').open = true;
      return false;
    }, function (e) {
      state.setup = null;
      $('setup-bar').hidden = true;
      $('setup-msg').textContent = 'Setup failed: ' + (e && e.message || e);
      return false;
    });
    return state.setup;
  }

  // ── the list ──
  function addRow(rel, size) {
    var li = document.createElement('li');
    li.innerHTML = '<span class="name"></span><span class="state">waiting</span>';
    li.querySelector('.name').textContent = rel + (size != null ? ' (' + fmt(size) + ')' : '');
    $('list').appendChild(li);
    var row = { rel: rel, li: li, status: 'waiting' };
    state.rows.push(row);
    return row;
  }
  function setRow(row, status, result) {
    row.status = status; row.result = result || null;
    row.li.className = status === 'done' ? 'ok' : status === 'failed' ? 'bad' : '';
    row.li.querySelector('.state').textContent = status === 'done' ? 'converted' + (result && result.ms ? ' in ' + (result.ms / 1000).toFixed(1) + ' s' : '') : status;
    row.li.querySelectorAll('.outs, .why').forEach(function (n) { n.remove(); });
    var outs = result && result.outputs;
    if (outs && outs.length) {
      var d = document.createElement('div'); d.className = 'outs';
      outs.forEach(function (o) {
        var a = document.createElement('a');
        a.href = 'results/' + state.job + '/' + enc(o.path); a.target = '_blank'; a.rel = 'noopener';
        a.textContent = o.path.split('/').pop();
        a.addEventListener('click', openResult);
        d.appendChild(a);
      });
      if (result.note) d.appendChild(document.createTextNode(result.note));
      row.li.appendChild(d);
    }
    if (status === 'failed') {
      var w = document.createElement('div'); w.className = 'why'; w.textContent = result && result.error || 'failed';
      row.li.appendChild(w);
    }
    summarize();
  }
  function summarize() {
    var done = 0, failed = 0, total = state.rows.length;
    state.rows.forEach(function (r) { if (r.status === 'done') done++; if (r.status === 'failed') failed++; });
    var left = total - done - failed;
    $('work').hidden = total === 0;
    $('summary').textContent = left ? 'Converting: ' + (done + failed) + ' of ' + total : total ? done + ' converted' + (failed ? ', ' + failed + ' failed' : '') : '';
    $('zip').disabled = done === 0 || left > 0;
    if (state.status && state.job) $('folder').textContent = 'Results folder on this computer: ' + state.status.results + '/' + state.job;
    var fl = $('failed-list'); fl.innerHTML = '';
    state.rows.forEach(function (r) {
      if (r.status !== 'failed') return;
      var li = document.createElement('li');
      li.textContent = r.rel;
      var w = document.createElement('div'); w.className = 'why'; w.textContent = r.result && r.result.error || 'failed';
      li.appendChild(w); fl.appendChild(li);
    });
    $('failed').hidden = failed === 0 || left > 0;
    if (!left && total && !state.marks.allDone) state.marks.allDone = Math.round(performance.now());
  }

  // ── converting ──
  function pumpQueue() {
    while (state.active < CONCURRENCY && state.queue.length) {
      (function (item) {
        state.active++;
        var t0 = performance.now();
        setRow(item.row, 'sending');
        item.file.arrayBuffer().then(function (buf) {
          return api('api/jobs/' + state.job + '/in/' + enc(item.row.rel), { method: 'PUT', body: buf, headers: { 'content-type': 'application/octet-stream' } });
        }).then(function (r) { if (!r.ok) throw new Error('upload: HTTP ' + r.status); return r.json(); }).then(function () {
          item.row.uploadMs = Math.round(performance.now() - t0);
          setRow(item.row, 'converting');
          return api('api/jobs/' + state.job + '/convert?path=' + encodeURIComponent(item.row.rel) + '&to=' + state.to, { method: 'POST' });
        }).then(function (r) { return r.json(); }).then(function (res) {
          item.row.totalMs = Math.round(performance.now() - t0);
          if (res.ok && !state.marks.firstDone) state.marks.firstDone = Math.round(performance.now());
          setRow(item.row, res.ok ? 'done' : 'failed', res);
        }).catch(function (e) {
          setRow(item.row, 'failed', { error: String(e && e.message || e) });
        }).then(function () { state.active--; pumpQueue(); });
      })(state.queue.shift());
    }
  }
  function take(files) {
    // files: [{ file: File, rel: 'folder/name.ext' }]
    if (!files.length) return;
    if (!state.marks.firstDrop) state.marks.firstDrop = Math.round(performance.now());
    if (!state.job) { state.job = newJob(); store('job', state.job); }
    state.to = $('to').value;
    var known = state.status ? state.status.extensions : [];
    var items = [];
    files.forEach(function (f) {
      if (/(^|\/)\.[^/]*$/.test(f.rel)) return; // .DS_Store and friends
      var row = addRow(f.rel, f.file.size);
      var ext = (f.rel.split('.').pop() || '').toLowerCase();
      if (known.length && known.indexOf(ext) < 0) return setRow(row, 'failed', { error: '.' + ext + ' is not a format this converter knows' });
      items.push({ file: f.file, row: row });
    });
    summarize();
    ensureReady().then(function (ok) {
      if (!ok) return items.forEach(function (i) { setRow(i.row, 'failed', { error: 'the converters are not installed' }); });
      items.forEach(function (i) { state.queue.push(i); });
      pumpQueue();
    });
  }

  // Dropped folders: walk the entries
  function walk(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) return entry.file(function (f) { out.push({ file: f, rel: prefix + f.name }); resolve(); }, function () { resolve(); });
      if (!entry.isDirectory) return resolve();
      var reader = entry.createReader(), all = [];
      (function more() {
        reader.readEntries(function (batch) {
          if (!batch.length) return Promise.all(all.map(function (e) { return walk(e, prefix + entry.name + '/', out); })).then(resolve);
          all = all.concat(Array.prototype.slice.call(batch)); more();
        }, function () { resolve(); });
      })();
    });
  }
  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });
  // A file dropped beside the box must not replace the page
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    var dt = e.dataTransfer, out = [], waits = [];
    var items = dt.items ? Array.prototype.slice.call(dt.items) : [];
    var entries = items.map(function (i) { return i.webkitGetAsEntry ? i.webkitGetAsEntry() : null; });
    if (entries.some(Boolean)) entries.forEach(function (en) { if (en) waits.push(walk(en, '', out)); });
    else Array.prototype.forEach.call(dt.files, function (f) { out.push({ file: f, rel: f.name }); });
    Promise.all(waits).then(function () { take(out); });
  });
  function picked(e) {
    take(Array.prototype.map.call(e.target.files, function (f) { return { file: f, rel: f.webkitRelativePath || f.name }; }));
    e.target.value = '';
  }
  $('pick').addEventListener('change', picked);
  $('pickdir').addEventListener('change', picked);
  $('to').addEventListener('change', function () { state.to = $('to').value; });

  // ── download all ──
  $('zip').addEventListener('click', function () {
    var b = $('zip'), label = b.textContent, t0 = performance.now();
    b.disabled = true; b.textContent = 'Zipping…';
    api('api/jobs/' + state.job + '/zip').then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      state.marks.zipMs = Math.round(performance.now() - t0); state.marks.zipBytes = blob.size;
      // An anchor that is not in the document: a host page's click handlers never see it
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([blob], { type: 'application/zip' }));
      a.download = 'converted-' + state.job + '.zip';
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
    }).catch(function (e) { alert('Could not make the zip: ' + (e && e.message || e)); })
      .then(function () { b.disabled = false; b.textContent = label; });
  });
  $('reset').addEventListener('click', function () {
    state.job = null; store('job', null); state.rows = []; state.queue = [];
    $('list').innerHTML = ''; summarize();
  });

  // ── start ──
  loadStatus().then(function () {
    state.marks.interactive = Math.round(performance.now());
    document.documentElement.setAttribute('data-ready', '1');
    // A reload: show what the last batch produced (the files are still in the results folder)
    var job = store('job');
    if (!job) return;
    return api('api/jobs/' + job).then(function (r) { return r.json(); }).then(function (j) {
      if (!j.files || !j.files.length) return store('job', null);
      state.job = job;
      j.files.forEach(function (f) {
        var row = addRow(f.path, null);
        setRow(row, 'done', { outputs: [f] });
      });
      state.marks.restored = j.files.length;
    });
  }).catch(function (e) {
    $('drop').querySelector('.big').textContent = 'The converter\'s backend is not answering (' + (e && e.message || e) + ').';
    document.documentElement.setAttribute('data-ready', 'error');
  });
})();
