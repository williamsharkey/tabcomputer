// page.js: the page of an app that has none of its own (docs/APPS.md "The manifest alone").
//
// An app.json with `run`, `fields` or `table` is a whole app. Its page is this script, the
// same for every such app, so a fix here reaches all of them. It reads the manifest from
// tab.app and builds one of three pages:
//
//   files   give it files; the command runs on each; a row per file; download the results
//   form    labelled inputs; Run; the command's output as it is written; Stop
//   table   a CSV or SQLite file as a table: add, edit, delete, sort, filter, total, export
//
// No library and no build step. The tab builds every command (tab.job): nothing typed or
// dropped here is ever read as shell text.
(async function () {
  'use strict';

  const CSS = `
:root { --bg: #fff; --fg: #1c1d22; --dim: #5d6170; --line: #d5d7de; --field: #fff; --soft: #f3f4f7; --accent: #2456c8; --on: #fff; --ok: #1d6b45; --bad: #b3261e; }
:root[data-theme=dark] { --bg: #1b1d29; --fg: #e9e9f1; --dim: #a4a8b8; --line: #3b3e50; --field: #24273a; --soft: #24273a; --accent: #8fa8ff; --on: #10121c; --ok: #6fd3a1; --bad: #ff8a80; }
* { box-sizing: border-box; }
html { color-scheme: light; }
html[data-theme=dark] { color-scheme: dark; }
body { margin: 0; font: 16px/1.5 system-ui, sans-serif; background: var(--bg); color: var(--fg); }
main { max-width: 680px; margin: 0 auto; padding: 20px 16px 28px; }
main.wide { max-width: 1100px; }
h1 { font-size: 21px; line-height: 1.3; margin: 0 0 4px; overflow-wrap: anywhere; }
p { margin: 0 0 12px; }
.about, .note, .dim { color: var(--dim); }
.note { font-size: 14px; margin: 18px 0 0; }
button, input, select, textarea { font: inherit; color: inherit; }
button { min-height: 44px; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--field); cursor: pointer; }
button.main { background: var(--accent); border-color: transparent; color: var(--on); font-weight: 600; }
button.small { min-height: 36px; padding: 4px 12px; font-size: 14px; }
button:disabled { opacity: .5; cursor: default; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
input[type=text], input[type=number], input[type=date], input[type=search], select, textarea { width: 100%; min-height: 44px; padding: 8px 10px; border-radius: 8px; border: 1px solid var(--line); background: var(--field); }
textarea { min-height: 120px; resize: vertical; font-family: ui-monospace, monospace; font-size: 14px; }
input[type=checkbox] { width: 20px; height: 20px; margin: 0; accent-color: var(--accent); }
label { display: block; font-weight: 600; margin: 0 0 4px; }
.field { margin: 0 0 14px; }
.check { display: flex; align-items: center; gap: 10px; min-height: 44px; }
.check label { margin: 0; font-weight: 400; }
fieldset { border: 0; padding: 0; margin: 0 0 6px; min-width: 0; }
legend { padding: 0; font-weight: 600; margin-bottom: 6px; }
.row { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.drop { border: 2px dashed var(--line); border-radius: 12px; padding: 24px 16px; text-align: center; }
.drop.over { border-color: var(--accent); background: var(--soft); }
.drop p { font-size: 18px; }
.drop .row { justify-content: center; }
.bar { justify-content: space-between; margin: 18px 0 6px; }
[role=status] { min-height: 24px; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; flex-wrap: wrap; gap: 4px 12px; align-items: center; padding: 8px 0; border-top: 1px solid var(--line); }
li .name { flex: 1 1 180px; overflow-wrap: anywhere; }
li .state { color: var(--dim); }
li.done .state { color: var(--ok); }
li.failed .state, li.skipped .state { color: var(--bad); }
li .why { flex: 1 1 100%; font-size: 14px; color: var(--dim); overflow-wrap: anywhere; }
pre, .rendered, iframe.rendered { margin: 12px 0 0; padding: 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); }
pre { min-height: 80px; max-height: 60vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 14px/1.45 ui-monospace, monospace; }
pre.err { min-height: 0; color: var(--bad); }
.rendered { overflow-wrap: anywhere; }
.rendered > :first-child { margin-top: 0; }
.rendered pre { background: var(--bg); min-height: 0; }
.rendered code { font: 14px ui-monospace, monospace; }
iframe.rendered { display: block; width: 100%; height: 50vh; padding: 0; background: #fff; }
.tools { margin: 8px 0 12px; }
.tools .grow { flex: 1 1 160px; }
.tools label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.sortby { display: none; }
.scroll { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 4px; text-align: left; vertical-align: middle; border-top: 1px solid var(--line); }
thead th { border-top: 0; white-space: nowrap; }
thead button { min-height: 36px; padding: 4px 8px; border-color: transparent; background: none; font-weight: 600; }
td input[type=text], td input[type=number], td input[type=date], td select { min-width: 96px; border-color: transparent; background: none; }
td input:hover, td select:hover, td input:focus, td select:focus { border-color: var(--line); background: var(--field); }
td.num input { text-align: right; }
td.act { width: 1%; }
tfoot td { font-weight: 600; padding: 10px 14px 10px 4px; }
tfoot td.num { text-align: right; }
@media (max-width: 560px) {
  .sortby { display: block; flex: 1 1 140px; }
  .scroll { overflow: visible; }
  table, tbody, tfoot, tr, td { display: block; }
  thead { display: none; }
  tbody tr, tfoot tr { border: 1px solid var(--line); border-radius: 10px; padding: 6px 10px; margin: 0 0 10px; }
  td { display: flex; align-items: center; gap: 10px; border: 0; padding: 2px 0; }
  td::before { content: attr(data-label); flex: 0 0 34%; font-size: 14px; color: var(--dim); overflow-wrap: anywhere; }
  td.act { width: auto; justify-content: flex-end; }
  td.act::before, tfoot td.blank { display: none; }
  td.num input, tfoot td.num { text-align: left; }
  tfoot td { padding: 6px 0; }
}
`;

  // el('button', { class: 'main', text: 'Run', onclick: fn }, child, ...)
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k in e && k !== 'list') e[k] = v;
      else e.setAttribute(k, v);
    }
    e.append(...kids.filter((x) => x != null));
    return e;
  }
  const lastLine = (s) => (s || '').trim().split('\n').pop().trim().slice(0, 300);
  const list = (a) => (a.length < 2 ? a.join('') : a.slice(0, -1).join(', ') + ' or ' + a[a.length - 1]);
  let ids = 0;
  const newId = () => 'i' + (++ids);

  document.head.append(el('style', { text: CSS }));
  let app;
  try { app = await tab.ready; } catch (e) {
    document.body.append(el('main', {}, el('p', { text: 'This page is part of a tabcomputer app. It works when the app is opened in tabcomputer.' })));
    document.documentElement.setAttribute('data-ready', 'error');
    return;
  }
  const m = app.manifest;
  const setTheme = (t) => { if (t) document.documentElement.setAttribute('data-theme', t); };
  setTheme(app.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
  tab.onTheme(setTheme);
  // A phone or tablet: there is nothing to drag, and its browser picks files, not folders
  const touch = matchMedia('(pointer: coarse)').matches;
  const folders = !touch && 'webkitdirectory' in HTMLInputElement.prototype;

  const main = el('main', {}, el('h1', { text: m.name }), m.description ? el('p', { class: 'about', text: m.description }) : null);
  document.body.append(main);
  const state = { kind: m.kind };
  window.__app = state; // for tests

  /** One of a form's fields or a file job's options: its element, and how to read it */
  function control(input) {
    const id = newId();
    const label = el('label', { for: id, text: input.label });
    if (input.type === 'checkbox') {
      const box = el('input', { type: 'checkbox', id, checked: !!input.value });
      return { el: el('div', { class: 'field check' }, box, label), value: () => box.checked };
    }
    if (input.type === 'choice') {
      const sel = el('select', { id }, ...input.choices.map((c) => el('option', { text: c.label, selected: c.label === input.value })));
      return { el: el('div', { class: 'field' }, label, sel), value: () => sel.value };
    }
    if (input.type === 'file') {
      let path = '';
      const name = el('span', { class: 'dim', text: 'No file chosen.' });
      const btn = el('button', {
        type: 'button', id, text: 'Choose a file',
        onclick: async () => {
          const r = await tab.files.pick({ multiple: false, accept: input.accept.join(','), dir: `${state.dirs.in}/${input.name}` });
          if (!r.files.length) return;
          path = r.files[0].path;
          name.textContent = r.files[0].rel;
          btn.dispatchEvent(new Event('input', { bubbles: true }));
        },
      });
      return { el: el('div', { class: 'field' }, label, el('div', { class: 'row' }, btn, name)), value: () => path };
    }
    const box = input.type === 'long text' ? el('textarea', { id, value: input.value, spellcheck: false })
      : el('input', { type: input.type === 'number' ? 'number' : 'text', id, value: input.value, ...(input.type === 'number' ? { step: 'any' } : { autocapitalize: 'off', spellcheck: false }) });
    return { el: el('div', { class: 'field' }, label, box), value: () => box.value };
  }
  function controls(inputs) {
    const made = inputs.map((i) => [i.name, control(i)]);
    return { els: made.map(([, c]) => c.el), values: () => Object.fromEntries(made.map(([n, c]) => [n, c.value()])) };
  }

  // ── files: a command run on each file ──
  async function filesPage() {
    state.rows = [];
    state.dirs = await tab.job.start();
    const options = controls(m.options);
    const status = el('p', { role: 'status', 'aria-live': 'polite' });
    const rows = el('ul', { 'aria-label': 'Files' });
    const all = el('button', { type: 'button', class: 'main', text: 'Download all', disabled: true, onclick: () => tab.download(state.dirs.out, { zip: true, name: `${app.id}.zip` }) });
    const work = el('section', { hidden: true }, el('div', { class: 'row bar' }, status, all), rows);
    const accept = m.accept.join(',');
    const pick = (directory) => tab.files.pick({ directory, accept: directory ? '' : accept, dir: nextDir() }).then(take);
    const drop = el('section', { class: 'drop', 'aria-label': 'Files to work on' },
      touch ? null : el('p', { text: folders ? 'Drop files or a folder here' : 'Drop files here' }),
      el('div', { class: 'row' },
        el('button', { type: 'button', class: 'main', text: 'Choose files', onclick: () => pick(false) }),
        folders ? el('button', { type: 'button', text: 'Choose a folder', onclick: () => pick(true) }) : null));
    if (m.options.length) main.append(el('fieldset', {}, el('legend', { text: 'Options' }), ...options.els));
    main.append(drop, work, el('p', { class: 'note', text: 'Your files stay on this computer.' }));

    let picks = 0, active = 0;
    const queue = [];
    const nextDir = () => `${state.dirs.in}/${++picks}`;
    function addRow(name) {
      const st = el('span', { class: 'state', text: 'waiting' });
      const li = el('li', {}, el('span', { class: 'name', text: name }), st);
      rows.append(li);
      const row = { name, li, st, status: 'waiting', out: null, why: '' };
      state.rows.push(row);
      return row;
    }
    function set(row, status, why, res) {
      Object.assign(row, { status, why: why || '', out: res ? res.out : null });
      row.li.className = status;
      row.st.textContent = status;
      row.li.querySelectorAll('button, .why').forEach((n) => n.remove());
      if (status === 'done') {
        const result = res.name.split('/').pop();
        row.result = res.name;
        row.li.append(el('button', { type: 'button', class: 'small', text: 'Download', 'aria-label': `Download ${result}`, onclick: () => tab.download(res.out) }));
        if (result !== row.name.split('/').pop()) row.li.append(el('span', { class: 'why', text: `Saved as ${res.name}` }));
      } else if (why) row.li.append(el('span', { class: 'why', text: why }));
      summarize();
    }
    function summarize() {
      const count = (s) => state.rows.filter((r) => r.status === s).length;
      const left = count('waiting') + count('working');
      const done = count('done');
      work.hidden = !state.rows.length;
      all.disabled = !done || left > 0;
      all.textContent = done > 1 ? 'Download all (.zip)' : 'Download as a .zip';
      const parts = [`${done} done`, count('failed') ? `${count('failed')} failed` : '', count('skipped') ? `${count('skipped')} skipped` : ''].filter(Boolean);
      status.textContent = left ? `Working: ${state.rows.length - left} of ${state.rows.length}.` : parts.join(', ') + '.';
    }
    function pump() {
      while (active < 2 && queue.length) {
        const { row, files } = queue.shift();
        active++;
        set(row, 'working');
        tab.job({ files, values: options.values() }).then((res) => {
          if (res.out) set(row, 'done', '', res);
          else set(row, 'failed', lastLine(res.stderr) || res.said || (res.code ? `The program ended with status ${res.code}.` : 'The program made no result.'));
        }, (e) => set(row, 'failed', e.message)).then(() => { active--; pump(); });
      }
    }
    function take(imported) {
      const wanted = [];
      for (const f of imported.files) {
        if (/(^|\/)\./.test(f.rel)) continue; // .DS_Store and other hidden files
        const ext = (/\.[^./]+$/.exec(f.rel) || [''])[0].toLowerCase();
        if (m.accept.length && !m.accept.includes(ext)) set(addRow(f.rel), 'skipped', `This is not a ${list(m.accept)} file.`);
        else wanted.push({ path: f.path, rel: f.rel });
      }
      if (!m.each && wanted.length) queue.push({ row: addRow(wanted.length === 1 ? wanted[0].rel : `${wanted.length} files`), files: wanted });
      else for (const f of wanted) queue.push({ row: addRow(f.rel), files: [f] });
      summarize();
      pump();
    }
    state.take = take;
    if (!touch) {
      for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); });
      for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('over'));
      // (import inside the event: a dropped folder's entries can only be read now)
      drop.addEventListener('drop', (e) => { e.preventDefault(); tab.files.import(e.dataTransfer, { dir: nextDir() }).then(take); });
    }
    // A file dropped beside the box must not replace the page
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', (e) => e.preventDefault());
  }

  // ── form: fields fill a command; its output shows ──
  /** Markdown as elements: headings, lists, quotes, code, bold, italic, links. Text only goes in as text. */
  function markdown(text) {
    const root = el('div', { class: 'rendered' });
    const inline = (into, s) => {
      const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*\s][^*]*\*|\[[^\]]+\]\([^)\s]+\))/;
      for (const part of s.split(re)) {
        if (!part) continue;
        if (/^`.+`$/.test(part)) into.append(el('code', { text: part.slice(1, -1) }));
        else if (/^\*\*.+\*\*$/.test(part)) into.append(el('strong', { text: part.slice(2, -2) }));
        else if (/^\*.+\*$/.test(part)) into.append(el('em', { text: part.slice(1, -1) }));
        else if (/^\[.+\]\(.+\)$/.test(part)) { const x = /^\[(.+)\]\((.+)\)$/.exec(part); into.append(x[1] === x[2] ? x[1] : `${x[1]} (${x[2]})`); }
        else into.append(part);
      }
      return into;
    };
    const lines = text.replace(/\r\n/g, '\n').split('\n');
    let para = [], items = null;
    const flush = () => { if (para.length) root.append(inline(el('p'), para.join(' '))); para = []; items = null; };
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      let x;
      if (/^```/.test(l)) {
        flush();
        const code = [];
        for (i++; i < lines.length && !/^```/.test(lines[i]); i++) code.push(lines[i]);
        root.append(el('pre', {}, el('code', { text: code.join('\n') })));
      } else if ((x = /^(#{1,6})\s+(.*)$/.exec(l))) { flush(); root.append(inline(el('h' + Math.min(6, x[1].length + 1)), x[2])); }
      else if ((x = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(l))) {
        const tag = /\d/.test(x[1]) ? 'ol' : 'ul';
        if (!items || items.tagName.toLowerCase() !== tag) { flush(); items = el(tag, { style: 'list-style: revert; padding-left: 24px; margin: 0 0 12px' }); root.append(items); }
        items.append(inline(el('li', { style: 'display: list-item; border: 0; padding: 0' }), x[2]));
      } else if ((x = /^>\s?(.*)$/.exec(l))) { flush(); root.append(inline(el('blockquote', { style: 'margin: 0 0 12px; padding-left: 12px; border-left: 3px solid var(--line)' }), x[1])); }
      else if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) { flush(); root.append(el('hr')); }
      else if (!l.trim()) flush();
      else { items = null; para.push(l.trim()); }
    }
    flush();
    return root;
  }

  async function formPage() {
    Object.assign(state, { runs: 0, code: null, output: '', running: false });
    state.dirs = await tab.job.start();
    const fields = controls(m.fields);
    const run = el('button', { type: 'submit', class: 'main', text: 'Run' });
    const stop = el('button', { type: 'button', text: 'Stop', disabled: true, onclick: () => current && current.kill() });
    const status = el('p', { role: 'status', 'aria-live': 'polite' });
    const save = el('button', { type: 'button', class: 'main', hidden: true });
    const out = el('pre', { tabIndex: 0, 'aria-label': 'Output' });
    const shown = el('div', { 'aria-label': 'Result' });
    const errs = el('pre', { class: 'err', hidden: true, 'aria-label': 'Messages' });
    const plain = m.output === 'text' || m.output === 'file';
    const form = el('form', { onsubmit: (e) => { e.preventDefault(); start(); } }, ...fields.els, el('div', { class: 'row' }, run, stop, save));
    main.append(form, status, plain ? out : shown, plain ? null : errs);
    if (m.fields.some((f) => f.type === 'file')) main.append(el('p', { class: 'note', text: 'Your files stay on this computer.' }));

    let current = null, token = 0;
    function render(text) {
      if (m.output === 'markdown') shown.replaceChildren(markdown(text));
      // (the command's HTML is shown as a document that runs no script and reaches nothing)
      else shown.replaceChildren(el('iframe', { class: 'rendered', sandbox: '', srcdoc: text, title: 'Result' }));
    }
    async function start() {
      const mine = ++token;
      if (current) { current.kill(); await current.catch(() => {}); }
      if (mine !== token) return;
      let text = '', err = '';
      state.running = true;
      stop.disabled = false;
      status.textContent = 'Running.';
      // As you type, the last result stays until the new one is whole; otherwise output shows as it is written
      if (!m.live) { out.textContent = ''; errs.hidden = true; save.hidden = true; }
      const live = (s) => { text += s; if (!m.live && plain) { out.textContent += s; out.scrollTop = out.scrollHeight; } };
      try {
        current = tab.job({ values: fields.values() }, { onStdout: live, onStderr: (s) => { err += s; if (plain) live(s); } });
        const res = await current;
        if (mine !== token) return;
        Object.assign(state, { code: res.code, output: text, out: res.out });
        if (plain) out.textContent = text; else if (res.code === 0 || text) render(text);
        if (!plain) { errs.textContent = err; errs.hidden = !err.trim(); }
        save.hidden = !res.out;
        if (res.out) { save.textContent = `Download ${res.name}`; save.onclick = () => tab.download(res.out); }
        status.textContent = res.code === 0 ? 'Done.' : res.code === 130 || res.code === 143 ? 'Stopped.' : `The program ended with status ${res.code}.`;
      } catch (e) {
        if (mine !== token) return;
        state.code = -1;
        status.textContent = e.message;
      }
      if (mine !== token) return;
      current = null;
      state.running = false;
      state.runs++;
      stop.disabled = true;
    }
    form.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); start(); } });
    if (m.live) {
      let timer = 0;
      form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(start, 250); });
      start();
    }
  }

  // ── table: a CSV or SQLite file ──
  function parseCsv(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (quoted) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false; } else cell += c; }
      else if (c === '"') quoted = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
      else if (c !== '\r') cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows;
  }
  const csvCell = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const formatCsv = (rows) => rows.map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
  const isNumber = (s) => /^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(String(s).trim());

  /** Where the table is kept: read() → { names, rows } (null: nothing changed), write(names, rows) */
  function csvStore(file) {
    let own = null;
    return {
      async read() {
        if (!await tab.fs.exists(file)) await tab.fs.write(file, own = formatCsv([m.columns.map((c) => c.name)]));
        const text = await tab.fs.readText(file);
        if (text === own && state.loads) return null;
        own = text;
        const [names = [], ...rows] = parseCsv(text);
        return { names, rows };
      },
      async write(names, rows) { await tab.fs.write(file, own = formatCsv([names, ...rows])); },
      exported: async () => file,
    };
  }
  function sqliteStore(file) {
    const q = (s) => `"${s.replace(/"/g, '""')}"`;
    const v = (s) => `'${s.replace(/'/g, "''")}'`;
    const t = q(m.table.replace(/\.sqlite$/, '').replace(/[^A-Za-z0-9_]/g, '_'));
    // One value comes back, as JSON on the last line: the same from every build of sqlite3
    const sql = async (text) => {
      const r = await tab.run(['sqlite3', file], { stdin: text });
      if (r.code !== 0) throw new Error(lastLine(r.stderr) || 'sqlite3 failed');
      return r.stdout.trim() ? JSON.parse(r.stdout.trim().split('\n').pop()) : [];
    };
    let own = null, busy = 0;
    // (the built-in sqlite3 writes the file back after every statement, a SELECT too: a change made by
    // one of this page's own calls is not another program's)
    const mine = (fn) => async (...a) => { busy++; try { return await fn(...a); } finally { busy--; } };
    const dump = async () => {
      const names = await sql(`CREATE TABLE IF NOT EXISTS ${t} (${m.columns.map((c) => `${q(c.name)} ${c.type === 'number' ? 'REAL' : 'TEXT'}`).join(', ')});\nSELECT json_group_array(name) FROM pragma_table_info(${v(t.slice(1, -1))});`);
      const rows = await sql(`SELECT json_group_array(json_array(${names.map(q).join(', ')})) FROM ${t};`);
      return { names, rows: rows.map((r) => r.map((x) => (x == null ? '' : String(x)))) };
    };
    return {
      busy: () => busy > 0,
      read: mine(async () => {
        const d = await dump();
        const text = JSON.stringify(d);
        if (text === own && state.loads) return null;
        own = text;
        return d;
      }),
      write: mine(async (names, rows) => {
        const had = (await dump()).names;
        const lit = (s, i) => (s === '' ? 'NULL' : state.cols[i].type === 'number' && isNumber(s) ? s.trim() : v(s));
        await sql([
          ...names.filter((n) => !had.includes(n)).map((n) => `ALTER TABLE ${t} ADD COLUMN ${q(n)} TEXT;`),
          'BEGIN;', `DELETE FROM ${t};`,
          ...rows.map((r) => `INSERT INTO ${t} (${names.map(q).join(', ')}) VALUES (${r.map(lit).join(', ')});`),
          'COMMIT;',
        ].join('\n'));
        own = JSON.stringify(await dump());
      }),
      async exported() {
        const csv = `${app.dataDir}/${m.table.replace(/\.sqlite$/, '.csv')}`;
        await tab.fs.write(csv, formatCsv([state.cols.map((c) => c.name), ...state.rows]));
        return csv;
      },
    };
  }

  async function tablePage() {
    main.classList.add('wide');
    const file = `${app.dataDir}/${m.table}`;
    const store = m.table.endsWith('.sqlite') ? sqliteStore(file) : csvStore(file);
    Object.assign(state, { file, cols: [], rows: [], saves: 0, loads: 0, sort: -1, down: false, filter: '' });
    const status = el('p', { role: 'status', 'aria-live': 'polite' });
    const filterId = newId(), sortId = newId();
    const filter = el('input', { type: 'search', id: filterId, placeholder: 'Filter', oninput: () => { state.filter = filter.value; draw(); } });
    const sortBy = el('select', { id: sortId, onchange: () => { state.sort = +sortBy.value; state.down = false; draw(); } });
    const table = el('table', {}, el('thead'), el('tbody'), el('tfoot'));
    main.append(
      el('div', { class: 'row tools' },
        el('div', { class: 'grow' }, el('label', { for: filterId, text: 'Filter the rows' }), filter),
        el('div', { class: 'sortby' }, el('label', { for: sortId, text: 'Sort by' }), sortBy),
        el('button', { type: 'button', class: 'main', text: 'Add a row', onclick: add }),
        el('button', { type: 'button', text: 'Download CSV', onclick: async () => tab.download(await store.exported(), { name: m.table.replace(/\.[a-z]+$/, '.csv') }) })),
      el('div', { class: 'scroll' }, table), status,
      el('p', { class: 'note', text: `The table is kept on this computer, in ${file.replace(app.home, '~')}.` }));

    async function save(said) {
      try {
        await store.write(state.cols.map((c) => c.name), state.rows);
        state.saves++;
        status.textContent = said || 'Saved.';
      } catch (e) { status.textContent = `The table could not be saved: ${e.message}`; }
    }
    async function load(said) {
      let d;
      try { d = await store.read(); } catch (e) { status.textContent = `The table could not be read: ${e.message}`; return; }
      if (!d) return;
      // The manifest's columns first; a column only the file has is kept, as text
      const extra = d.names.filter((n) => !m.columns.some((c) => c.name === n));
      state.cols = [...m.columns, ...extra.map((name) => ({ name, type: 'text', choices: [] }))];
      const at = state.cols.map((c) => d.names.indexOf(c.name));
      state.rows = d.rows.map((r) => at.map((i) => (i < 0 ? '' : r[i] ?? '')));
      state.loads++;
      draw();
      if (said) status.textContent = said;
    }
    /** The rows shown, as indexes into state.rows: filtered, then sorted */
    function view() {
      const f = state.filter.trim().toLowerCase();
      const ix = state.rows.map((_, i) => i).filter((i) => !f || state.rows[i].some((c) => c.toLowerCase().includes(f)));
      const s = state.sort;
      if (s >= 0) {
        const num = state.cols[s].type === 'number';
        ix.sort((a, b) => {
          const x = state.rows[a][s], y = state.rows[b][s];
          const d = num ? (parseFloat(x) || 0) - (parseFloat(y) || 0) : x.localeCompare(y, undefined, { numeric: true });
          return (state.down ? -d : d) || a - b;
        });
      }
      return ix;
    }
    function cell(r, c, n) {
      const col = state.cols[c], now = state.rows[r][c];
      const set = (val) => { if (state.rows[r][c] === val) return; state.rows[r][c] = val; totals(); save(); };
      const label = `${col.name}, row ${n}`;
      let box;
      if (col.type === 'checkbox') box = el('input', { type: 'checkbox', checked: /^(yes|true|1|x)$/i.test(now), 'aria-label': label, onchange: () => set(box.checked ? 'yes' : '') });
      else if (col.type === 'choice') {
        const choices = ['', ...col.choices, ...(now && !col.choices.includes(now) ? [now] : [])];
        box = el('select', { 'aria-label': label, onchange: () => set(box.value) }, ...choices.map((x) => el('option', { text: x, selected: x === now })));
      } else {
        box = el('input', { type: col.type === 'text' ? 'text' : col.type, value: now, 'aria-label': label, onchange: () => set(box.value), ...(col.type === 'number' ? { step: 'any' } : {}) });
        box.addEventListener('keydown', (e) => { if (e.key === 'Enter') box.blur(); });
      }
      return el('td', { class: col.type === 'number' ? 'num' : '', 'data-label': col.name }, box);
    }
    function totals() {
      const ix = view();
      const nums = state.cols.map((c) => c.type === 'number');
      if (!nums.includes(true)) return table.tFoot.replaceChildren();
      table.tFoot.replaceChildren(el('tr', {}, ...state.cols.map((c, i) => {
        if (!nums[i]) return el('td', { class: 'blank', text: i === 0 ? 'Total' : '' });
        const sum = ix.reduce((a, r) => a + (parseFloat(state.rows[r][i]) || 0), 0);
        return el('td', { class: 'num', 'data-label': `Total ${c.name}`, text: String(Math.round(sum * 100) / 100) });
      }), el('td', { class: 'blank' })));
    }
    function draw() {
      const ix = view();
      table.tHead.replaceChildren(el('tr', {}, ...state.cols.map((c, i) => el('th', { scope: 'col', 'aria-sort': state.sort === i ? (state.down ? 'descending' : 'ascending') : 'none' },
        el('button', { type: 'button', text: c.name + (state.sort === i ? (state.down ? ' (Z to A)' : ' (A to Z)') : ''), title: `Sort by ${c.name}`, onclick: () => { state.down = state.sort === i && !state.down; state.sort = i; draw(); } }))),
      el('th', {}, el('span', { class: 'dim', text: `${ix.length} of ${state.rows.length}`, hidden: ix.length === state.rows.length }))));
      sortBy.replaceChildren(el('option', { value: '-1', text: 'Sort by: as entered' }), ...state.cols.map((c, i) => el('option', { value: String(i), text: `Sort by: ${c.name}`, selected: state.sort === i })));
      table.tBodies[0].replaceChildren(...ix.map((r, n) => el('tr', {}, ...state.cols.map((_, c) => cell(r, c, n + 1)),
        el('td', { class: 'act' }, el('button', { type: 'button', class: 'small', text: 'Delete', 'aria-label': `Delete row ${n + 1}`, onclick: () => remove(r) })))));
      if (!state.rows.length) table.tBodies[0].replaceChildren(el('tr', {}, el('td', { colSpan: state.cols.length + 1, class: 'dim', text: 'No rows yet. Choose Add a row.' })));
      totals();
    }
    async function add() {
      state.filter = filter.value = '';
      state.rows.push(state.cols.map(() => ''));
      draw();
      const first = table.tBodies[0].lastElementChild.querySelector('input, select');
      if (first) first.focus();
      await save('A row was added.');
    }
    async function remove(r) {
      const [gone] = state.rows.splice(r, 1);
      draw();
      await save();
      status.replaceChildren('The row was deleted. ', el('button', { type: 'button', class: 'small', text: 'Undo', onclick: () => { state.rows.splice(r, 0, gone); draw(); save('The row is back.'); } }));
    }
    await load();
    // Another program changed the file: show what it holds now
    await tab.fs.watch(file, () => { if (!store.busy || !store.busy()) load('The file changed. The table shows what it holds now.'); }).ready;
  }

  try {
    await { files: filesPage, form: formPage, table: tablePage }[m.kind]();
    document.documentElement.setAttribute('data-ready', '1');
  } catch (e) {
    main.append(el('p', { role: 'alert', text: `${m.name} could not start: ${e && e.message || e}` }));
    document.documentElement.setAttribute('data-ready', 'error');
  }
})();
