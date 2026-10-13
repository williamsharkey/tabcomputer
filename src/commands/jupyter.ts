/**
 * jupyter: notebooks on this computer (docs/NOTEBOOK.md).
 *
 *   jupyter notebook [FILE|DIR]   open a notebook in the Notebook app, or list a folder's
 *   jupyter lab [FILE|DIR]        the same
 *   jupyter execute FILE…         run a notebook's cells here; --inplace saves the outputs
 *   jupyter nbconvert --to script FILE…
 *   jupyter nbconvert --to notebook --execute [--inplace] FILE…
 *
 * No server starts and nothing is installed: cells run in the tab's own
 * Python (src/notebook/kernel.ts).
 */
import type { Command, CommandContext } from './index';
import { parseJupyterArgs } from '../notebook/magics';
import { NotebookFormatError, OutputList, notebookScript, outputsText, parseNotebook, serializeNotebook, stampKernel } from '../notebook/nbformat';
import { isEmptyCell } from '../notebook/magics';
import { PYODIDE_PYTHON } from '../python/pyodide-dist';

const USAGE = `usage: jupyter notebook [FILE|DIR]     open a notebook (or list a folder's notebooks)
       jupyter lab [FILE|DIR]          the same
       jupyter execute FILE...         run a notebook here and print what it prints
                                       (--inplace saves the outputs in the file)
       jupyter nbconvert --to script FILE...
       jupyter nbconvert --to notebook --execute [--inplace] FILE...

Notebooks run in this computer's Python. Nothing needs to be installed.
`;

type Desk = { openApp(id: string, args?: Record<string, unknown>): Promise<unknown>; apps(): { id: string }[] };

async function execute(ctx: CommandContext, path: string, saveTo: string | null): Promise<number> {
  let text: string;
  try { text = await ctx.fs.readFile(path, 'utf8') as string; } catch { ctx.stderr += `jupyter: ${path}: there is no such file\n`; return 1; }
  let nb;
  try { nb = parseNotebook(text); } catch (e) {
    ctx.stderr += `jupyter: ${path}: ${e instanceof NotebookFormatError ? e.message : (e as Error)?.message ?? e}\n`;
    return 1;
  }
  const { NotebookKernel, kernelUnavailable } = await import('../notebook/kernel');
  const why = kernelUnavailable();
  if (why) { ctx.stderr += `jupyter: ${why}\n`; return 1; }
  const { kernelForContext } = await import('../wasi/run-command');
  const dir = path.slice(0, path.lastIndexOf('/')) || '/';
  const kernel = new NotebookKernel({ kernel: kernelForContext(ctx), fs: ctx.fs, shell: ctx.shell, cwd: dir, name: path.slice(path.lastIndexOf('/') + 1) });
  const out = ctx.streamStdout ?? ((t: string) => { ctx.stdout += t; });
  const abort = (ctx.shell as { abortController?: AbortController | null }).abortController;
  let stopped = false;
  const onAbort = () => { stopped = true; kernel.shutdown(); };
  abort?.signal.addEventListener('abort', onAbort);
  let failed = false;
  try {
    kernel.start();
    for (const cell of nb.cells) {
      if (cell.cell_type !== 'code' || stopped) continue;
      const outputs = new OutputList();
      cell.execution_count = null;
      cell.outputs = outputs.outputs;
      if (isEmptyCell(cell.source)) continue;
      let shown = 0;
      const result = await kernel.execute(cell.source, {
        onOutput: (m) => {
          outputs.apply(m);
          // (text is printed as it comes; pictures and tables as their text form, when the cell ends)
          if (m.t === 'stream') { out(m.text); shown = outputs.outputs.length; }
        },
      });
      cell.outputs = outputs.outputs;
      cell.execution_count = result.count || null;
      const rest = outputs.outputs.slice(shown).filter((o) => o.output_type !== 'stream');
      if (rest.length) out(outputsText(rest));
      if (result.status !== 'ok') { failed = true; break; }
    }
    if (kernel.python) stampKernel(nb, kernel.python);
    if (kernel.state === 'dead' && kernel.lastError && !stopped) ctx.stderr += `jupyter: Python stopped: ${kernel.lastError.trim()}\n`;
  } finally {
    abort?.signal.removeEventListener('abort', onAbort);
    kernel.shutdown();
  }
  if (stopped) return 130;
  if (saveTo) {
    try { await ctx.fs.writeFile(saveTo, serializeNotebook(nb)); } catch (e) { ctx.stderr += `jupyter: ${saveTo} was not written: ${(e as Error)?.message ?? e}\n`; return 1; }
    ctx.stderr += `jupyter: the notebook and its outputs are saved in ${saveTo}\n`;
  }
  return failed ? 1 : 0;
}

export const jupyterCmd: Command = {
  name: 'jupyter',
  description: 'Notebooks: open one in the Notebook app, or run one here',
  async exec(ctx) {
    const cmd = parseJupyterArgs(ctx.args);
    const abs = (p: string) => ctx.fs.resolvePath(p, ctx.cwd);
    switch (cmd.action) {
      case 'help':
        ctx.stdout += USAGE;
        return 0;
      case 'version':
        ctx.stdout += `Selected Jupyter core packages...\nnotebook         : tabcomputer (built in)\njupyterlab       : not installed\nPython           : ${PYODIDE_PYTHON} (Pyodide, in this tab)\n`;
        return 0;
      case 'kernelspec':
        ctx.stdout += 'Available kernels:\n  python3    this computer\'s Python (Pyodide), built in\n';
        return 0;
      case 'error':
        ctx.stderr += `${cmd.message}\n`;
        return 2;
      case 'script': {
        let rc = 0;
        for (const f of cmd.files) {
          const path = abs(f);
          try {
            const script = notebookScript(parseNotebook(await ctx.fs.readFile(path, 'utf8') as string));
            if (cmd.stdout) ctx.stdout += script;
            else {
              const to = path.replace(/\.ipynb$/i, '') + '.py';
              await ctx.fs.writeFile(to, script);
              ctx.stderr += `jupyter: ${f} is written as a script in ${to}\n`;
            }
          } catch (e) {
            ctx.stderr += `jupyter: ${f}: ${e instanceof NotebookFormatError ? e.message : 'the file could not be read'}\n`;
            rc = 1;
          }
        }
        return rc;
      }
      case 'execute': {
        let rc = 0;
        for (const f of cmd.files) {
          const path = abs(f);
          const stem = path.replace(/\.ipynb$/i, '');
          let saveTo: string | null = null;
          if (cmd.inplace) saveTo = path;
          else if (cmd.output) {
            // (a bare name is written beside the notebook, as nbconvert does)
            let name = cmd.output.replace('{stem}', stem.slice(stem.lastIndexOf('/') + 1));
            if (!/\.ipynb$/i.test(name)) name += '.ipynb';
            saveTo = name.includes('/') ? abs(name) : `${path.slice(0, path.lastIndexOf('/')) || ''}/${name}`;
          }
          rc = Math.max(rc, await execute(ctx, path, saveTo));
          if (rc === 130) break;
        }
        return rc;
      }
      case 'open': {
        const desk = (globalThis as { __shiroDesktop?: Desk }).__shiroDesktop;
        const path = cmd.path ? abs(cmd.path) : ctx.cwd;
        if (!desk?.apps().some((a) => a.id === 'notebook')) {
          ctx.stderr += cmd.path
            ? `jupyter: the Notebook app is on the desktop, and this page shows the terminal only.\nRun the notebook here with: jupyter execute ${cmd.path}\nOr switch to the desktop with: desktop\n`
            : 'jupyter: the Notebook app is on the desktop, and this page shows the terminal only. Switch with: desktop\n';
          return 1;
        }
        if (cmd.path && !/\.ipynb$/i.test(path)) {
          const st = await ctx.fs.stat(path).catch(() => null);
          if (!st) { ctx.stderr += `jupyter: ${cmd.path}: there is no such file or folder\n`; return 1; }
          if (!st.isDirectory()) { ctx.stderr += `jupyter: ${cmd.path} is not a notebook (a notebook's name ends in .ipynb)\n`; return 1; }
        }
        await desk.openApp('notebook', { path });
        return 0;
      }
    }
  },
};

/** `jupyter-notebook` and `jupyter-lab`, the names the real programs also have */
export const jupyterAlias = (name: string, sub: string): Command => ({
  name,
  description: `The same as jupyter ${sub}`,
  async exec(ctx) {
    const args = ctx.args;
    ctx.args = [sub, ...args];
    try { return await jupyterCmd.exec(ctx); } finally { ctx.args = args; }
  },
});
