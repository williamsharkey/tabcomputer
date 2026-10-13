// A table over a CSV file in the app's data folder. The file is the state: the
// page reads it, writes it back on every edit, and reloads when something else
// changes it (try `echo 'Ada,ada@example.com,new' >> FILE` in a Terminal).
//
// For SQLite instead: list "sqlite3" under access.commands in app.json and read
// rows with  tab.run(['sqlite3', '-csv', '-header', db, 'select * from people'])
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { rows: [], file: '', saves: 0, loads: 0 };
  window.__app = state; // for tests

  await tab.ready;
  state.file = `${tab.app.dataDir}/table.csv`;
  const START = 'Name,Email,Note\nGrace Hopper,grace@example.com,first row\n';

  function parse(text) {
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
  const quote = (s) => (/[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const format = (rows) => rows.map((r) => r.map(quote).join(',')).join('\n') + '\n';

  let own = ''; // what this page last wrote: a change that is ours is not reloaded
  async function save() {
    own = format(state.rows);
    await tab.fs.write(state.file, own);
    state.saves++;
    $('status').textContent = 'Saved';
  }
  async function load() {
    if (!await tab.fs.exists(state.file)) await tab.fs.write(state.file, START);
    const text = await tab.fs.readText(state.file);
    if (text === own && state.loads) return;
    own = text;
    state.rows = parse(text);
    state.loads++;
    render();
  }

  function render() {
    const [head = [], ...body] = state.rows;
    const cols = Math.max(1, ...state.rows.map((r) => r.length));
    const line = (cells, tag, r) => {
      const tr = document.createElement('tr');
      for (let c = 0; c < cols; c++) {
        const td = document.createElement(tag);
        td.textContent = cells[c] ?? '';
        td.contentEditable = 'plaintext-only';
        td.addEventListener('blur', () => {
          const v = td.textContent;
          if ((state.rows[r][c] ?? '') === v) return;
          while (state.rows[r].length <= c) state.rows[r].push('');
          state.rows[r][c] = v;
          save();
        });
        td.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); td.blur(); } });
        tr.append(td);
      }
      return tr;
    };
    $('table').tHead.replaceChildren(line(head, 'th', 0));
    $('table').tBodies[0].replaceChildren(...body.map((cells, i) => line(cells, 'td', i + 1)));
    $('where').textContent = `${body.length} row${body.length === 1 ? '' : 's'} in ${state.file}`;
  }

  $('add').addEventListener('click', async () => {
    state.rows.push(new Array(Math.max(1, state.rows[0]?.length ?? 1)).fill(''));
    render();
    await save();
    $('table').tBodies[0].lastElementChild?.firstElementChild?.focus();
  });
  $('download').addEventListener('click', () => tab.download(state.file, { name: 'table.csv' }));

  await load();
  // Another program wrote the file: show what it holds now
  const watch = tab.fs.watch(state.file, () => { load().then(() => { $('status').textContent = 'Reloaded'; }); });
  await watch.ready;
  document.documentElement.setAttribute('data-ready', '1');
})();
