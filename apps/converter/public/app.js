// Converter page, on tabcomputer's app toolkit (docs/APPS.md). No server of its own:
// dropped files go into the tab's filesystem with tab.files.import, Debian's converter
// programs run with tab.run, results are read with tab.fs and saved with tab.download.
// What it may run and touch is app.json's access list; the tab checks every call.
(async function () {
  'use strict';
  var T0 = performance.now();
  var $ = function (id) { return document.getElementById(id); };
  var state = { job: null, to: 'html', ready: false, status: null, rows: [], queue: [], active: 0, setup: null, concurrency: 2, marks: { script: Math.round(T0) } };
  window.__converter = state; // for tests and timing

  // extension → family. A family names the program for each output it can make.
  var DOC = function (html) { return { kind: 'document', html: html }; };
  var SHEET = function (csv) { return { kind: 'spreadsheet', csv: csv }; };
  var FAMILIES = {
    wpd: DOC('wpd2html'), wp: DOC('wpd2html'), wp5: DOC('wpd2html'), wp6: DOC('wpd2html'),
    pub: DOC('pub2xhtml'),
    wps: DOC('wps2html'),
    wks: SHEET('wks2csv'), wk1: SHEET('wks2csv'), wk3: SHEET('wks2csv'), wk4: SHEET('wks2csv'), 123: SHEET('wks2csv'), wq1: SHEET('wks2csv'), wq2: SHEET('wks2csv'),
    wdb: SHEET('wdb2csv'),
    cwk: { kind: 'claris', html: 'mwaw2html', csv: 'mwaw2csv' },
    cws: { kind: 'claris', html: 'mwaw2html', csv: 'mwaw2csv' },
    mdb: { kind: 'database' },
  };
  var LABELS = { wpd: 'WordPerfect', wp: 'WordPerfect', wp5: 'WordPerfect', wp6: 'WordPerfect', pub: 'Publisher', wps: 'Works document', wks: 'Works/Lotus spreadsheet', wk1: 'Lotus 1-2-3', wk3: 'Lotus 1-2-3', wk4: 'Lotus 1-2-3', 123: 'Lotus 1-2-3', wq1: 'Quattro Pro', wq2: 'Quattro Pro', wdb: 'Works database', cwk: 'ClarisWorks', cws: 'ClarisWorks', mdb: 'Access database' };
  // Needed before anything converts; the optional ones widen what converts (Debian 13's
  // libmwaw-tools and libwps-tools ship no mwaw2csv or wdb2csv)
  var TOOLS = ['wpd2html', 'pub2xhtml', 'wps2html', 'wks2csv', 'mwaw2html', 'mdb-tables', 'mdb-export', 'mdb-schema'];

  function store(k, v) { try { if (v === undefined) return localStorage.getItem('converter-' + k); if (v === null) localStorage.removeItem('converter-' + k); else localStorage.setItem('converter-' + k, v); } catch (e) { return null; } }
  function newJob() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function fmt(n) { return n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB'; }
  var dirname = function (p) { var i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  var basename = function (p) { return p.slice(p.lastIndexOf('/') + 1); };

  try { await tab.ready; } catch (e) {
    $('drop').querySelector('.big').textContent = 'This page is tabcomputer\'s Convert Old Files app. It works when it is opened in tabcomputer (' + (e && e.message || e) + ').';
    document.documentElement.setAttribute('data-ready', 'error');
    return;
  }
  var RESULTS = tab.app.home + '/Converted';            // what the person keeps
  var WORK = tab.app.dataDir + '/in';                   // dropped originals, removed once converted
  var resultsOf = function (job) { return RESULTS + '/' + job; };

  // ── which programs are here ──
  async function loadStatus() {
    var t0 = performance.now();
    var tools = await tab.commands();
    var outputs = ['html', 'csv'];
    if (tools.pandoc) outputs.push('docx');
    if (tools.soffice || tools.pandoc) outputs.push('pdf');
    var st = { ready: TOOLS.every(function (n) { return tools[n]; }), tools: tools, outputs: outputs, extensions: Object.keys(FAMILIES), results: RESULTS, checkMs: Math.round(performance.now() - t0) };
    state.status = st; state.ready = st.ready;
    var sel = $('to'), keep = sel.value;
    sel.innerHTML = '';
    st.outputs.forEach(function (o) { var op = document.createElement('option'); op.value = o; op.textContent = o.toUpperCase(); sel.appendChild(op); });
    sel.value = st.outputs.indexOf(keep) >= 0 ? keep : 'html';
    state.to = sel.value;
    return st;
  }

  // ── first use: the converters are a toolchain set the manifest names; the tab installs it ──
  function ensureReady() {
    if (state.ready) return Promise.resolve(true);
    if (state.setup) return state.setup;
    $('setup').hidden = false;
    var log = $('setup-log'), t0 = performance.now();
    state.marks.setupStart = Math.round(t0);
    state.setup = tab.toolchain.ensure(function (p) {
      log.textContent += p.line + '\n'; log.scrollTop = log.scrollHeight;
      // The sentence the tab gives for this step; the installer's own lines are under Details
      $('setup-msg').textContent = (p.text || 'The converter programs are being downloaded. This happens once.') + ' (' + Math.round((performance.now() - t0) / 1000) + ' s so far)';
    }).then(loadStatus).then(function (st) {
      state.setup = null;
      state.marks.setupMs = Math.round(performance.now() - t0);
      if (st.ready) { $('setup').hidden = true; return true; }
      throw new Error('the converter programs are still missing after the install');
    }).catch(function (e) {
      state.setup = null;
      $('setup-bar').hidden = true;
      $('setup-msg').textContent = 'The converter programs could not be installed (' + (e && e.message || e) + '). The install needs a network connection. No file of yours was sent anywhere. The details are below.';
      $('setup').querySelector('details').open = true;
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
        var a = document.createElement('button');
        a.type = 'button'; a.className = 'link';
        a.textContent = basename(o.path);
        a.addEventListener('click', function () { view(o.path); });
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
    if (state.job) $('folder').textContent = 'Results folder on this computer: ' + resultsOf(state.job).replace(tab.app.home, '~');
    var fl = $('failed-list'); fl.innerHTML = '';
    state.rows.forEach(function (r) {
      if (r.status !== 'failed') return;
      var li = document.createElement('li');
      li.textContent = r.rel;
      var w = document.createElement('div'); w.className = 'why'; w.textContent = r.result && r.result.error || 'failed';
      li.appendChild(w); fl.appendChild(li);
    });
    $('failed').hidden = failed === 0 || left > 0;
    var appName = (tab.app && tab.app.name) || 'Convert Old Files';
    tab.window.setTitle(left ? appName + ': ' + (done + failed) + ' of ' + total : appName);
    if (!left && total && !state.marks.allDone) {
      state.marks.allDone = Math.round(performance.now());
      // The dropped originals are copies: once converted they are not kept
      if (state.job && !state.importing) tab.fs.remove(WORK + '/' + state.job, { recursive: true }).catch(function () {});
    }
  }

  // ── looking at one result, in the page ──
  function save(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 60000);
  }
  function view(rel) {
    var name = basename(rel), ext = (name.split('.').pop() || '').toLowerCase();
    var path = resultsOf(state.job) + '/' + rel;
    if (['html', 'csv', 'txt', 'sql'].indexOf(ext) < 0) return tab.download(path);
    tab.fs.readText(path).then(function (text) {
      var v = $('viewer'), body = $('viewer-body');
      $('viewer-title').textContent = name;
      body.innerHTML = '';
      if (ext === 'html') {
        var f = document.createElement('iframe');
        f.setAttribute('sandbox', ''); // converted documents never run script
        f.srcdoc = text; f.title = name;
        body.appendChild(f);
      } else {
        var pre = document.createElement('pre'); pre.textContent = text; body.appendChild(pre);
      }
      $('viewer-save').onclick = function () { tab.download(path); };
      v.hidden = false;
      state.viewing = rel;
    }).catch(function (e) { alert('Could not open ' + name + ': ' + (e && e.message || e)); });
  }
  $('viewer-close').addEventListener('click', function () { $('viewer').hidden = true; $('viewer-body').innerHTML = ''; state.viewing = null; });

  // ── one conversion ──
  function csvToHtml(csv, title) {
    var rows = [], row = [], cell = '', inq = false;
    for (var i = 0; i < csv.length; i++) {
      var c = csv[i];
      if (inq) { if (c === '"') { if (csv[i + 1] === '"') { cell += '"'; i++; } else inq = false; } else cell += c; }
      else if (c === '"') inq = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    var e = function (s) { return String(s).replace(/[&<>]/g, function (ch) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]; }); };
    return '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' + e(title) + '</title><style>body{font:14px system-ui,sans-serif}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:3px 8px;text-align:left}</style></head><body><h1>' + e(title) + '</h1><table>\n' +
      rows.map(function (r, i) { return '<tr>' + r.map(function (c) { return i ? '<td>' + e(c) + '</td>' : '<th>' + e(c) + '</th>'; }).join('') + '</tr>'; }).join('\n') + '\n</table></body></html>\n';
  }

  // pub2xhtml writes XHTML whose drawing is namespace-prefixed SVG (<svg:svg>, <svg:text>).
  // A browser opening that as .html (the HTML parser) draws none of it: only loose text shows.
  // Without the prefix it is inline SVG, which the HTML parser draws.
  function htmlFromPubXhtml(x, title) {
    if (x.indexOf('<svg:svg') < 0) return null;
    var body = x.slice(x.indexOf('<body>') + 6, x.lastIndexOf('</body>'))
      .replace(/<\?import[^>]*\?>/g, '').replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<(\/?)svg:/g, '<$1').replace(/\sxmlns:svg="[^"]*"/g, '')
      .replace(/<svg /g, '<svg xmlns="http://www.w3.org/2000/svg" ');
    // Its font sizes are inches in a drawing measured in points (14 pt comes out as 0.1944): ×72.
    // Each text frame is still one unwrapped line at the frame's corner, so the words are also
    // given as plain paragraphs under each page: that part is what can be read and copied.
    var pages = body.split(/(?=<svg xmlns)/).filter(function (p) { return p.indexOf('<svg') >= 0; });
    var out = pages.map(function (p, i) {
      var drawing = p.replace(/font-size="([\d.]+)"/g, function (m, v) { return 'font-size="' + (parseFloat(v) * 72).toFixed(2) + '"'; });
      var paras = [];
      (p.match(/<text[\s\S]*?<\/text>/g) || []).forEach(function (t) {
        var cur = '';
        (t.match(/<tspan[^>]*>[\s\S]*?<\/tspan>/g) || []).forEach(function (s) {
          var words = s.replace(/<[^>]+>/g, '').replace(/^\n/, '');
          if (!words.trim()) { if (cur.trim()) paras.push(cur); cur = ''; } else cur += words;
        });
        if (cur.trim()) paras.push(cur);
      });
      return '<section class="page">\n' + drawing + '\n<div class="words"><h2>Page ' + (i + 1) + ': the words</h2>\n' + (paras.map(function (w) { return '<p>' + w + '</p>'; }).join('\n') || '<p><i>No text on this page.</i></p>') + '\n</div></section>';
    }).join('\n');
    return '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><title>' + title.replace(/[<&]/g, '') + '</title>\n<style>body{margin:0;background:#888;font:15px/1.5 system-ui,sans-serif}svg{display:block;margin:12px auto;background:#fff;box-shadow:0 1px 6px #0006;max-width:100%;height:auto}.words{max-width:46em;margin:0 auto 24px;background:#fff;padding:8px 20px}.words h2{font-size:15px;color:#555}</style></head>\n<body>\n<p class="words">Converted from Microsoft Publisher by pub2xhtml. The drawing keeps where things were on the page; long text does not wrap in it and some pictures are missing. The words of each page follow its drawing.</p>\n' + out + '\n</body></html>\n';
  }

  var stems = new Map(); // "job/dir/name-without-extension" → the input that owns that output name

  // One program, its output to a file. { ms } or { error, ms }
  async function run(argv, outFile) {
    var t0 = performance.now();
    var r = await tab.run(argv, { stdout: outFile });
    var st = await tab.fs.stat(outFile);
    var ms = Math.round(performance.now() - t0);
    if (r.code !== 0 || !st || !st.size) {
      await tab.fs.remove(outFile).catch(function () {});
      var why = (r.stderr.trim().split('\n').pop() || '').slice(0, 300);
      return { error: why || (r.code ? 'exit ' + r.code : 'the converter wrote nothing'), ms: ms };
    }
    return { ms: ms, size: st.size };
  }
  async function sizes(job, files) {
    var out = [];
    for (var i = 0; i < files.length; i++) {
      var st = await tab.fs.stat(files[i]);
      out.push({ path: files[i].slice(resultsOf(job).length + 1), size: st ? st.size : 0 });
    }
    return out;
  }
  async function csvFileToHtml(csv, html, title) {
    await tab.fs.write(html, csvToHtml(await tab.fs.readText(csv), title));
    await tab.fs.remove(csv);
  }

  async function convert(job, input, rel, to) {
    var t0 = performance.now(), toolMs = 0;
    var ext = (rel.split('.').pop() || '').toLowerCase();
    var fam = FAMILIES[ext];
    var dir = dirname(rel);
    var outDir = resultsOf(job) + (dir ? '/' + dir : '');
    // budget.wks and budget.wdb in one folder: the second keeps its extension (budget.wdb.html)
    var plain = (dir ? dir + '/' : '') + basename(rel).replace(/\.[^.]+$/, '');
    var owner = stems.has(job + '/' + plain) ? stems.get(job + '/' + plain) : rel;
    stems.set(job + '/' + plain, owner);
    var stem = owner === rel ? basename(plain) : basename(rel);
    var out = function (suffix) { return outDir + '/' + stem + suffix; };
    var done = async function (files, extra) { return Object.assign({ ok: true, path: rel, outputs: await sizes(job, files), ms: Math.round(performance.now() - t0), toolMs: toolMs }, extra || {}); };
    var fail = function (error, extra) { return Object.assign({ ok: false, path: rel, error: error, ms: Math.round(performance.now() - t0), toolMs: toolMs }, extra || {}); };
    if (!fam) return fail('.' + ext + ' is not a format this converter knows');
    // A family's CSV program may not be installed: Works databases then go through wks2csv
    var have = state.status.tools;
    var csvTool = fam.csv && (have[fam.csv] ? fam.csv : fam.csv === 'wdb2csv' ? 'wks2csv' : null);
    var r;

    if (fam.kind === 'database') {
      var t = await tab.run(['mdb-tables', '-1', input]);
      if (t.code !== 0) return fail((t.stderr.trim().split('\n').pop() || 'mdb-tables: exit ' + t.code).slice(0, 300));
      var tables = t.stdout.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
      if (!tables.length) return fail('no tables in this database');
      var folder = out(''), files = [], bad = [];
      for (var i = 0; i < tables.length; i++) {
        var csv = folder + '/' + tables[i].replace(/[\/\\]/g, '_') + '.csv';
        r = await run(['mdb-export', input, tables[i]], csv);
        toolMs += r.ms;
        if (r.error) { bad.push(tables[i] + ': ' + r.error); continue; }
        if (to === 'html') {
          var h = csv.replace(/\.csv$/, '.html');
          await csvFileToHtml(csv, h, tables[i]);
          files.push(h);
        } else files.push(csv);
      }
      r = await run(['mdb-schema', input], folder + '/schema.sql');
      toolMs += r.ms;
      if (!r.error) files.push(folder + '/schema.sql');
      if (!files.length) return fail(bad.join('; ') || 'nothing could be exported');
      return done(files, { note: bad.length ? 'tables that failed: ' + bad.join('; ') : tables.length + ' table(s)' });
    }

    if (to === 'csv') {
      if (!fam.csv) return fail('a ' + LABELS[ext] + ' file is a document, not a table: pick HTML');
      if (!csvTool) return fail(fam.csv + ' is not installed here: pick HTML');
      r = await run([csvTool, input], out('.csv'));
      toolMs += r.ms;
      return r.error ? fail(r.error) : done([out('.csv')]);
    }

    // html, and docx/pdf by way of html
    var html = out('.html');
    if (fam.html) {
      r = await run([fam.html, input], html);
      toolMs += r.ms;
      // ClarisWorks spreadsheets: mwaw2html refuses them, mwaw2csv takes them
      if (r.error && csvTool) {
        var c = await run([csvTool, input], out('.csv'));
        toolMs += c.ms;
        if (c.error) return fail(r.error);
        await csvFileToHtml(out('.csv'), html, stem);
      } else if (r.error) return fail(r.error);
      else if (fam.html === 'pub2xhtml') {
        var fixed = htmlFromPubXhtml(await tab.fs.readText(html), stem);
        if (fixed) await tab.fs.write(html, fixed);
      }
    } else {
      r = await run([csvTool, input], out('.csv'));
      toolMs += r.ms;
      if (r.error) return fail(r.error);
      await csvFileToHtml(out('.csv'), html, stem);
    }
    if (to === 'html') return done([html]);

    if (state.status.outputs.indexOf(to) < 0) return fail(to.toUpperCase() + ' needs pandoc, which is not installed here; the HTML was kept', { outputs: await sizes(job, [html]) });
    var target = out('.' + to);
    var p = to === 'pdf' && have.soffice
      ? await tab.run(['soffice', '--headless', '--convert-to', 'pdf', '--outdir', outDir, html])
      : await tab.run(['pandoc', html, '-o', target]);
    var made = await tab.fs.stat(target);
    if (p.code !== 0 || !made || !made.size) return fail((p.stderr.trim().split('\n').pop() || 'exit ' + p.code).slice(0, 300) + '; the HTML was kept', { outputs: await sizes(job, [html]) });
    await tab.fs.remove(html);
    return done([target]);
  }

  // ── converting ──
  function pumpQueue() {
    while (state.active < state.concurrency && state.queue.length) {
      (function (item) {
        state.active++;
        var t0 = performance.now();
        setRow(item.row, 'converting');
        convert(item.job, item.file.path, item.row.rel, state.to).then(function (res) {
          item.row.convertMs = Math.round(performance.now() - t0);
          item.row.uploadMs = item.file.ms;
          item.row.totalMs = item.row.convertMs + (item.file.ms || 0);
          if (res.ok && !state.marks.firstDone) state.marks.firstDone = Math.round(performance.now());
          setRow(item.row, res.ok ? 'done' : 'failed', res);
        }).catch(function (e) {
          setRow(item.row, 'failed', { error: String(e && e.message || e) });
        }).then(function () { state.active--; pumpQueue(); });
      })(state.queue.shift());
    }
  }
  // source: a DataTransfer (a drop, folders walked by tab.js) or a FileList (the pickers)
  function take(source) {
    if (!state.marks.firstDrop) state.marks.firstDrop = Math.round(performance.now());
    if (!state.job) { state.job = newJob(); store('job', state.job); }
    state.marks.allDone = 0;
    state.to = $('to').value;
    var job = state.job, known = Object.keys(FAMILIES), waiting = [];
    state.importing = (state.importing || 0) + 1;
    // The tab stores each file and says where; converting one starts as soon as it has landed
    var imported = tab.files.import(source, {
      dir: WORK + '/' + job,
      onProgress: function (p) {
        var f = p.file;
        if (/(^|\/)\.[^/]*$/.test(f.rel)) return; // .DS_Store and friends
        var row = addRow(f.rel, f.size);
        var ext = (f.rel.split('.').pop() || '').toLowerCase();
        if (known.indexOf(ext) < 0) return setRow(row, 'failed', { error: '.' + ext + ' is not a format this converter knows' });
        waiting.push({ file: f, row: row, job: job });
        if (state.ready) { state.queue.push(waiting.pop()); pumpQueue(); }
      },
    });
    Promise.all([imported, ensureReady()]).then(function (r) {
      state.importing--;
      if (!r[1]) return waiting.splice(0).forEach(function (i) { setRow(i.row, 'failed', { error: 'the converters are not installed' }); });
      waiting.splice(0).forEach(function (i) { state.queue.push(i); });
      pumpQueue();
      summarize();
    }, function (e) {
      state.importing--;
      alert('The files could not be taken in: ' + (e && e.message || e));
    });
  }

  var drop = $('drop');
  ['dragenter', 'dragover'].forEach(function (t) { drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('over'); }); });
  ['dragleave', 'drop'].forEach(function (t) { drop.addEventListener(t, function () { drop.classList.remove('over'); }); });
  // A file dropped beside the box must not replace the page
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  drop.addEventListener('drop', function (e) { e.preventDefault(); take(e.dataTransfer); });
  function picked(e) { take(e.target.files); e.target.value = ''; }
  $('pick').addEventListener('change', picked);
  $('pickdir').addEventListener('change', picked);
  $('to').addEventListener('change', function () { state.to = $('to').value; });

  // ── download all ──
  $('zip').addEventListener('click', function () {
    var b = $('zip'), label = b.textContent, t0 = performance.now();
    b.disabled = true; b.textContent = 'Zipping…';
    tab.download(resultsOf(state.job), { zip: true, name: 'converted-' + state.job + '.zip' }).then(function (r) {
      state.marks.zipMs = Math.round(performance.now() - t0); state.marks.zipBytes = r.size;
    }).catch(function (e) { alert('Could not make the zip: ' + (e && e.message || e)); })
      .then(function () { b.disabled = false; b.textContent = label; });
  });
  $('reset').addEventListener('click', function () {
    state.job = null; store('job', null); state.rows = []; state.queue = []; state.marks.allDone = 0;
    $('list').innerHTML = ''; summarize();
  });

  // ── start ──
  async function tree(dir, prefix, out) {
    var list = await tab.fs.list(dir).catch(function () { return []; });
    for (var i = 0; i < list.length; i++) {
      if (list[i].type === 'dir') await tree(dir + '/' + list[i].name, prefix + list[i].name + '/', out);
      else out.push({ path: prefix + list[i].name, size: list[i].size });
    }
    return out;
  }
  try {
    await loadStatus();
    state.marks.interactive = Math.round(performance.now());
    document.documentElement.setAttribute('data-ready', '1');
    // A reload: show what the last batch produced (the files are still in the results folder)
    var job = store('job');
    if (job) {
      var files = await tree(resultsOf(job), '', []);
      if (!files.length) store('job', null);
      else {
        state.job = job;
        files.forEach(function (f) { setRow(addRow(f.path, null), 'done', { outputs: [f] }); });
        state.marks.restored = files.length;
      }
    }
  } catch (e) {
    $('drop').querySelector('.big').textContent = 'The converter could not reach its tab (' + (e && e.message || e) + ').';
    document.documentElement.setAttribute('data-ready', 'error');
  }
})();
