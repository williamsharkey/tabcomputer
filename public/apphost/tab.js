// tab.js: what an app's page uses to reach the tab it runs in (docs/APPS.md "tab.js").
//
//   <script src="/__tabcomputer/tab.js"></script>
//   await tab.ready;
//   const { paths } = await tab.files.import(event.dataTransfer);
//   const { code } = await tab.run(['wc', '-c', paths[0]], { onStdout: (s) => show(s) });
//   await tab.download(tab.app.dataDir + '/out', { zip: true });
//
// The page talks to the tab over one MessagePort and nothing else; the tab
// checks every request against the app's manifest (its `access` list). A
// refused request rejects with an Error whose `code` is 'EACCES'.
(function () {
  'use strict';
  if (globalThis.tab && globalThis.tab.__tabcomputer) return;

  var seq = 0;
  var calls = new Map(); // id → { resolve, reject, on }
  var port = null;

  function fail(code, message) { var e = new Error(message); e.code = code; return e; }

  var connected = new Promise(function (resolve, reject) {
    if (window.parent === window) return reject(fail('ENOTAB', 'tab.js: this page is not inside a tabcomputer app window'));
    var ch = new MessageChannel();
    port = ch.port1;
    port.onmessage = function (ev) {
      var m = ev.data;
      if (!m || typeof m.id !== 'number') return;
      var c = calls.get(m.id);
      if (!c) return;
      if (m.t === 'ev') { if (c.on) { try { c.on(m.e, m.d); } catch (e) { setTimeout(function () { throw e; }); } } return; }
      calls.delete(m.id);
      if (m.t === 'ok') c.resolve(m.v); else c.reject(fail(m.code || 'EIO', m.message || 'failed'));
    };
    // The frame around the page (or the tab itself) hands the other end to the tab
    window.parent.postMessage({ type: 'tc-tab-connect', v: 1 }, '*', [ch.port2]);
    resolve();
  });

  /** One operation. Returns a promise with `cancel()`. `on(event, data)` gets what it produces meanwhile. */
  function call(op, a, on, transfer) {
    var id = ++seq;
    var p = connected.then(function () {
      return new Promise(function (resolve, reject) {
        calls.set(id, { resolve: resolve, reject: reject, on: on });
        port.postMessage({ t: 'call', id: id, op: op, a: a || {} }, transfer || []);
      });
    });
    p.cancel = function () { if (calls.has(id)) port.postMessage({ t: 'cancel', id: id }); };
    return p;
  }

  var info = null;
  var ready = call('hello', { v: 1 }).then(function (v) { info = v; Object.assign(app, v); return v; });
  // (a page that never awaits tab.ready must not get an unhandled rejection from it)
  ready.catch(function () {});

  // ── tab.app ──
  var app = { id: '', name: '', version: '', manifest: null, dir: '', dataDir: '', home: '', confined: false };

  // ── tab.run ──
  /**
   * Run a program: tab.run(['prog', 'arg', …], opts), each argument one word (no shell).
   * With `access.shell` in the manifest, tab.run('a shell line', opts) too.
   * opts: cwd, env, stdin (text), stdout / stderr (a file to write that stream to),
   * onStdout(text), onStderr(text): called as output is produced.
   * Resolves to { code, stdout, stderr } (the text is collected unless the on* callback took it).
   * The returned promise has kill().
   */
  function run(cmd, opts) {
    opts = opts || {};
    var out = '', err = '';
    var c = call('run', { cmd: cmd, cwd: opts.cwd, env: opts.env, stdin: opts.stdin, stdout: opts.stdout, stderr: opts.stderr }, function (e, d) {
      if (e === 'out') { if (opts.onStdout) opts.onStdout(d); else out += d; }
      else if (e === 'err') { if (opts.onStderr) opts.onStderr(d); else err += d; }
    });
    var p = c.then(function (v) { return { code: v.code, stdout: out, stderr: err }; });
    p.kill = c.cancel;
    return p;
  }

  // ── tab.fs ──
  var fs = {
    /** The file's bytes (Uint8Array), or its text with { as: 'text' } */
    read: function (path, o) {
      var text = o && (o === 'text' || o.as === 'text' || o.encoding === 'utf8');
      return call('fs.read', { path: path, as: text ? 'text' : 'bytes' }).then(function (v) { return text ? v : new Uint8Array(v); });
    },
    readText: function (path) { return fs.read(path, 'text'); },
    /** data: text, an ArrayBuffer, a typed array or a Blob. Folders above it are made. */
    write: function (path, data) {
      return Promise.resolve(data instanceof Blob ? data.arrayBuffer() : data).then(function (d) { return call('fs.write', { path: path, data: d }); });
    },
    /** [{ name, type: 'file' | 'dir' | 'symlink', size, mtime }] */
    list: function (path) { return call('fs.list', { path: path }); },
    /** { path, type, size, mtime } or null */
    stat: function (path) { return call('fs.stat', { path: path }); },
    exists: function (path) { return call('fs.stat', { path: path }).then(function (s) { return !!s; }); },
    mkdir: function (path) { return call('fs.mkdir', { path: path }); },
    remove: function (path, o) { return call('fs.remove', { path: path, recursive: !!(o && o.recursive) }); },
    rename: function (from, to) { return call('fs.rename', { from: from, to: to }); },
    /** cb({ event: 'write' | 'delete' | 'mkdir' | 'rename' | 'attrib', path }) for changes under path. Returns { close(), ready }. */
    watch: function (path, cb) {
      var started;
      var ready = new Promise(function (resolve, reject) { started = { resolve: resolve, reject: reject }; });
      var c = call('fs.watch', { path: path }, function (e, d) { if (e === 'watching') started.resolve(d.path); else if (e === 'change') cb(d); });
      c.catch(function (e) { started.reject(e); });
      ready.catch(function () {});
      return { close: c.cancel, ready: ready };
    },
  };

  // ── tab.files ──
  function walkEntry(entry, prefix, out) {
    return new Promise(function (resolve) {
      if (entry.isFile) return entry.file(function (f) { out.push({ file: f, rel: prefix + f.name }); resolve(); }, function () { resolve(); });
      if (!entry.isDirectory) return resolve();
      var reader = entry.createReader(), all = [];
      (function more() {
        reader.readEntries(function (batch) {
          if (!batch.length) return Promise.all(all.map(function (e) { return walkEntry(e, prefix + entry.name + '/', out); })).then(resolve);
          all = all.concat(Array.prototype.slice.call(batch)); more();
        }, function () { resolve(); });
      })();
    });
  }
  /** What was dropped or picked, as [{ file, rel }]; folders are walked. Must be called inside the event. */
  function collect(source) {
    var out = [], waits = [];
    if (!source) return Promise.resolve(out);
    if (typeof DataTransfer !== 'undefined' && source instanceof DataTransfer) {
      // (entries are only readable during the drop event: take them all now)
      var items = source.items ? Array.prototype.slice.call(source.items) : [];
      var entries = items.map(function (i) { return i.kind === 'file' && i.webkitGetAsEntry ? i.webkitGetAsEntry() : null; });
      if (entries.some(Boolean)) entries.forEach(function (en) { if (en) waits.push(walkEntry(en, '', out)); });
      else Array.prototype.forEach.call(source.files || [], function (f) { out.push({ file: f, rel: f.name }); });
    } else {
      Array.prototype.forEach.call(source.length !== undefined ? source : [source], function (f) {
        if (f && f.file) out.push({ file: f.file, rel: f.rel || f.file.name });
        else if (f) out.push({ file: f, rel: f.webkitRelativePath || f.name });
      });
    }
    return Promise.all(waits).then(function () { return out; });
  }
  var batches = 0;
  var files = {
    /**
     * Put dropped or picked files into the tab's filesystem: a FileList, a DataTransfer (folders
     * are walked), an array of Files or of { file, rel }. opts.dir: where (a folder the app may
     * write; default a new folder under its data folder). opts.onProgress({ done, total, rel }).
     * Resolves to { dir, paths, files: [{ path, rel, size }] } in the order given.
     */
    import: function (source, opts) {
      opts = opts || {};
      var batch = 'b' + Date.now().toString(36) + (batches++).toString(36);
      return collect(source).then(function (list) {
        var results = new Array(list.length), next = 0, done = 0, dir = opts.dir || null;
        function one() {
          if (next >= list.length) return Promise.resolve();
          var i = next++, item = list[i];
          return item.file.arrayBuffer().then(function (buf) {
            return call('files.put', { dir: opts.dir, batch: batch, rel: item.rel, data: buf }, null, [buf]);
          }).then(function (r) {
            results[i] = { path: r.path, rel: r.rel, size: r.size };
            dir = dir || r.dir;
            done++;
            if (opts.onProgress) opts.onProgress({ done: done, total: list.length, rel: r.rel });
            return one();
          });
        }
        var lanes = [];
        for (var k = 0; k < Math.min(opts.concurrency || 3, list.length); k++) lanes.push(one());
        return Promise.all(lanes).then(function () {
          return { dir: dir, paths: results.map(function (r) { return r.path; }), files: results };
        });
      });
    },
    /** Open the browser's file picker, then import what was chosen. opts: multiple, directory, accept, and import's. */
    pick: function (opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        var input = document.createElement('input');
        input.type = 'file';
        input.multiple = opts.multiple !== false;
        if (opts.directory) input.webkitdirectory = true;
        if (opts.accept) input.accept = opts.accept;
        input.addEventListener('change', function () { files.import(input.files, opts).then(resolve, reject); });
        input.addEventListener('cancel', function () { resolve({ dir: null, paths: [], files: [] }); });
        input.click();
      });
    },
  };

  // ── tab.download ──
  /**
   * Save a file to the person's real disk. A list of paths, a folder, or { zip: true } gives a
   * zip (a folder's contents at the top of it). opts.name: the name offered.
   * Resolves to { name, size, zip }.
   */
  function download(paths, opts) {
    opts = opts || {};
    return call('download', { paths: Array.isArray(paths) ? paths : [paths], zip: !!opts.zip, name: opts.name });
  }

  // ── tab.toolchain ──
  var toolchain = {
    /** Install the manifest's toolchain sets that are missing. onProgress({ set, line }). Resolves to { installed, sets }. */
    ensure: function (sets, onProgress) {
      if (typeof sets === 'function') { onProgress = sets; sets = undefined; }
      return call('toolchain.ensure', { sets: sets }, function (e, d) { if (e === 'progress' && onProgress) onProgress(d); });
    },
    /** { set: installed? } */
    status: function (sets) { return call('toolchain.status', { sets: sets }); },
  };

  // ── tab.window ──
  var win = {
    setTitle: function (title) { return call('window.set', { title: String(title) }); },
    resize: function (width, height) { return call('window.set', { width: width, height: height }); },
    close: function () { return call('window.close'); },
  };

  globalThis.tab = {
    __tabcomputer: 1,
    version: 1,
    /** Resolves to tab.app once the tab has answered */
    ready: ready.then(function () { return app; }),
    app: app,
    run: run,
    /** { name: true | false } for the manifest's commands: which are installed */
    commands: function (names) { return call('commands', { names: names }); },
    fs: fs,
    files: files,
    download: download,
    /** Show a folder or file in the Files app */
    reveal: function (path) { return call('reveal', { path: path }); },
    toolchain: toolchain,
    window: win,
  };
  globalThis.tab.ready.catch(function () {});
})();
