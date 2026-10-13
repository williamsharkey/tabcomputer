// A script as an app (`app new NAME --from script.sh`): run.sh in the app's
// folder, started with the Run button, its output shown as it is written.
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { runs: 0, code: null, output: '' };
  window.__app = state; // for tests

  await tab.ready;
  let running = null;
  $('run').addEventListener('click', async () => {
    if (running) return;
    const out = $('out');
    out.textContent = '';
    state.output = '';
    state.code = null;
    $('run').disabled = true;
    $('stop').disabled = false;
    $('status').textContent = 'Running…';
    const show = (s) => { state.output += s; out.textContent += s; out.scrollTop = out.scrollHeight; };
    const args = $('args').value.split('\n').filter((l) => l !== '');
    try {
      // The script runs in the app's data folder; each line of the box is one argument
      running = tab.run(['sh', `${tab.app.dir}/run.sh`, ...args], { cwd: tab.app.dataDir, onStdout: show, onStderr: show });
      const { code } = await running;
      state.code = code;
      $('status').textContent = code === 0 ? 'Done' : `Exit status ${code}`;
    } catch (err) {
      state.code = -1;
      $('status').textContent = `Failed: ${err.message}`;
    }
    state.runs++;
    running = null;
    $('run').disabled = false;
    $('stop').disabled = true;
  });
  $('stop').addEventListener('click', () => running && running.kill());

  document.documentElement.setAttribute('data-ready', '1');
})();
