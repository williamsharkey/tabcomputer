// File in → file out. Change PROGRAM and outName() to make it yours, and list
// the program in app.json under access.commands: the page may run only those.
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { rows: [], out: '' };
  window.__app = state; // for tests

  await tab.ready;
  // Results go to a folder of the app's own data; a new one each time the page loads
  state.out = `${tab.app.dataDir}/out/${Date.now().toString(36)}`;

  // The program run on each file, as [name, ...arguments]: no shell, so a file's name is only ever one argument
  const PROGRAM = (path) => ['base64', path];
  const outName = (rel) => rel + '.b64';

  function row(rel) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = rel;
    const st = document.createElement('span');
    st.className = 'state';
    st.textContent = 'waiting';
    li.append(name, st);
    $('list').append(li);
    const r = { rel, li, st, status: 'waiting', error: '' };
    state.rows.push(r);
    return r;
  }
  function set(r, status, error) {
    r.status = status;
    r.error = error || '';
    r.st.textContent = status === 'failed' ? `failed: ${r.error}` : status;
    r.li.className = status === 'done' ? 'ok' : status === 'failed' ? 'bad' : '';
    const done = state.rows.filter((x) => x.status === 'done').length;
    const left = state.rows.filter((x) => x.status === 'waiting' || x.status === 'working').length;
    $('work').hidden = false;
    $('summary').textContent = left ? `Working: ${state.rows.length - left} of ${state.rows.length}` : `${done} done${done < state.rows.length ? `, ${state.rows.length - done} failed` : ''}`;
    $('zip').disabled = !done || left > 0;
  }

  async function take(imported) {
    // imported.files: [{ path, rel, size }], already in the tab's filesystem
    const rows = imported.files.map((f) => ({ f, r: row(f.rel) }));
    for (const { f, r } of rows) {
      set(r, 'working');
      try {
        const res = await tab.run(PROGRAM(f.path), { stdout: `${state.out}/${outName(f.rel)}` });
        if (res.code === 0) set(r, 'done');
        else set(r, 'failed', res.stderr.trim().split('\n').pop() || `exit ${res.code}`);
      } catch (e) { set(r, 'failed', e.message); }
    }
  }

  const drop = $('drop');
  for (const t of ['dragenter', 'dragover']) drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); });
  for (const t of ['dragleave', 'drop']) drop.addEventListener(t, () => drop.classList.remove('over'));
  // A file dropped beside the box must not replace the page
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    // (call import inside the event: a dropped folder's entries can only be read now)
    tab.files.import(e.dataTransfer).then(take);
  });
  $('pick').addEventListener('click', () => tab.files.pick().then(take));
  $('zip').addEventListener('click', () => tab.download(state.out, { zip: true, name: 'results.zip' }));

  document.documentElement.setAttribute('data-ready', '1');
})();
