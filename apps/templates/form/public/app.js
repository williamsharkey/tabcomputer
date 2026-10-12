// A form over a command. Change command() and the fields in index.html, and
// list the program in app.json under access.commands.
(async function () {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const state = { runs: 0, code: null, output: '' };
  window.__app = state; // for tests

  await tab.ready;

  // The command, as [name, ...arguments]. Each field's value is one argument, whatever it holds:
  // nothing typed into the form is ever read as shell text.
  const command = (f) => ['seq', f.first.value, f.step.value, f.last.value];

  let running = null;
  $('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (running) return;
    const out = $('out');
    out.textContent = '';
    state.output = '';
    state.code = null;
    $('run').disabled = true;
    $('stop').disabled = false;
    $('status').textContent = 'Running…';
    const show = (s) => { state.output += s; out.textContent += s; out.scrollTop = out.scrollHeight; };
    try {
      // Output arrives as the program writes it
      running = tab.run(command(e.target), { onStdout: show, onStderr: show });
      const { code } = await running;
      state.code = code;
      $('status').textContent = code === 0 ? 'Done' : `Exit status ${code}`;
    } catch (err) {
      state.code = -1;
      $('status').textContent = err.code === 'EACCES' ? `Not allowed: ${err.message}` : `Failed: ${err.message}`;
    }
    state.runs++;
    running = null;
    $('run').disabled = false;
    $('stop').disabled = true;
  });
  $('stop').addEventListener('click', () => running && running.kill());

  document.documentElement.setAttribute('data-ready', '1');
})();
