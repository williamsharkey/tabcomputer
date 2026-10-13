# Notebook

A student opens a Jupyter notebook (`.ipynb`) and runs it, with nothing to install and nothing to choose. The Notebook app is a window of the desktop; cells run in the tab's own Python (Pyodide, in a Worker); the file is an ordinary nbformat 4 notebook in the tab's filesystem, so `git`, GitHub and Jupyter see what was saved.

Code: `src/notebook/` (`nbformat.ts` the file format and outputs, `magics.ts` cell source as Python and `jupyter`'s arguments, `markup.ts` Markdown and Python colors, `sanitize.ts` HTML from a notebook as safe nodes, `kernel.ts` the Python process), `src/pyodide-worker/notebook-guest.ts` and `notebook-py.ts` (the Worker's side), `src/desktop/apps/notebook.ts` (the window), `src/commands/jupyter.ts`. Tests: `tests/tests/shiro-vitest/notebook.test.ts`, `tests/browser/notebook.mjs`.

## Opening one

| How | What opens |
| --- | --- |
| The dock's **Notebook** | The notebooks under the home folder, newest first, and New Notebook. |
| `jupyter notebook FILE.ipynb`, `jupyter lab FILE.ipynb`, `jupyter FILE.ipynb` | That notebook. A name that does not exist yet is a new notebook. |
| `jupyter notebook`, `jupyter lab` (also with a folder) | The notebooks of the current (or that) folder. |
| A double-click on a `.ipynb` in Files | That notebook. |
| `code FILE.ipynb`, or a `.ipynb` clicked in the Code app's file list | That notebook, in the Notebook app. |
| A lab whose `.tabcomputer/lab.json` has `"notebook": "lab3.ipynb"` ([CLASSROOM.md](CLASSROOM.md)) | The lab link opens the Code app and that notebook. |
| `desktop open notebook PATH` | The same as the dock, on a file or folder. |

A notebook that is already open is shown, not opened twice. The window comes back after a reload (its restore command is `jupyter notebook PATH`). The server options of the real programs (`--no-browser`, `--port`, `--ip`, `--allow-root`, …) are accepted and do nothing: no server starts. `pip install jupyter` (also `jupyterlab`, `notebook`, `ipykernel`) installs nothing and says notebooks are built in.

## What the window does

- Cells: code and text (Markdown). **+ Code**, **+ Text**, and on the selected cell: change its kind, move it, clear its output, delete it. Text cells are drawn; a double-click (or Enter) edits one.
- **Run** (Shift+Enter) runs the selected cell and goes to the next; Ctrl+Enter runs it in place; Alt+Enter runs it and adds a cell. **Run All** runs top to bottom and stops at the first cell that fails, as Jupyter does.
- **Stop** raises `KeyboardInterrupt` in the running cell (also while it waits in `input()`, `time.sleep()`, an `await` or a `!command`). A cell inside one long call into compiled code does not see it; after 4 s the window offers Restart.
- **Restart** starts a new Python: variables are gone, the outputs on screen stay.
- **Save** (Ctrl+S). The notebook is also saved 2.5 s after a run ends, 20 s after an edit, and when its window closes. If the file changes on disk while it is open (a `git checkout`), the window shows the new file, or asks when it has edits of its own.
- Outputs: printed text (with terminal colors, and a progress bar that rewrites its line), values, pandas tables (`text/html`), matplotlib figures (`image/png`, drawn under the cell by `plt.show()` and at the end of a cell), images, SVG, Markdown, JSON, and errors with their traceback. `input()` asks in a box under the cell.
- Keys with a cell selected and no editor focused: Enter edit, Up/Down or K/J move, A/B add above/below, M/Y text/code, D D delete.

## Python

One Python per open notebook: a kernel process (`python3 -m notebook NAME` in `ps`) whose program is a Pyodide Worker, started when the notebook opens. It is the Pyodide the tab already uses for numpy programs (`pyodideIndexURL()` in `src/python/pyodide-dist.ts`; AGENTS.md "Languages And Toolchains"), so there is one distribution to host and one version.

- Its files are the tab's, at their own paths; its working directory is the notebook's folder. `pd.read_csv('data.csv')` reads the file beside the notebook, and a file it writes is one `git status` shows.
- Packages: when the notebook opens, the `import` lines of all its cells are read and those packages are fetched and loaded, so the first Run does not wait for them. Any package of the Pyodide distribution loads on import (numpy, pandas, matplotlib, scipy, scikit-learn, pillow, sympy, …), with no `pip install` first. Pure-Python packages from the tab's `pip` are on its path.
- Opening a notebook runs nothing from its folder. The folder becomes the working directory, and the first place `import` looks, at the first cell that runs, after that cell's packages are loaded (`enter` in `src/pyodide-worker/notebook-py.ts`). Loading packages imports modules of Python's own, and a notebook comes from a cloned repository: a `json.py` beside it must not be what Python finds before the person has run anything. From the first cell on, `import helper` finds `helper.py` beside the notebook, as in Jupyter.
- The page's main thread only answers the process's syscalls, so a long cell does not freeze the desktop (measured below).
- Top-level `await` works. `asyncio.run()` in a cell says a loop is already running, as in Jupyter.

### Magics and shell lines

`src/notebook/magics.ts` turns them into calls on `get_ipython()`; the Python side (`notebook-py.ts`) answers.

| In a cell | What happens |
| --- | --- |
| `%matplotlib inline` | Nothing: figures are always drawn under the cell. Another backend (`widget`, `notebook`, `qt`) prints one line saying so. |
| `%pip install X`, `!pip install X` | The tab's `pip`, in the tab's shell: a pure-Python package is installed from PyPI and importable in the next cell; a compiled one that Pyodide has is recorded and loads on import. |
| `!command`, `x = !command`, `%%bash` | The command runs in a fork of the tab's shell, in Python's working directory. Its output is the cell's; `x = !ls` captures the lines. `{name}` and `$name` are filled in from the notebook's variables. |
| `%cd`, `%pwd`, `%ls`, `%env`, `%run FILE`, `%time`, `%timeit`, `%%time`, `%%timeit`, `%%capture`, `%%writefile`, `%who`, `%whos`, `%reset`, `%lsmagic`, `%%html`, `%%markdown`, `name?` | As in IPython, in a plain form (`%timeit` reports the best of three runs). |
| `%load_ext`, `%autoreload`, `%config`, `%precision`, `%xmode`, … | Accepted and ignored. `%config InlineBackend.figure_format = 'retina'` doubles the figures' resolution. |
| `%conda`, `%apt` | One line: use `%pip install NAME`. |
| Anything else | `UsageError: Line magic function %name not found.` |

`IPython.display` (`display`, `HTML`, `Markdown`, `Image`, `SVG`, `JSON`, `Latex`, `clear_output`, `update_display`) and `get_ipython()` are stand-ins written by the kernel. Pyodide's own IPython package is kept out: it has no notebook to draw in.

## The file

Read and written as nbformat 4 (`nbformat.ts`): keys sorted, one space of indent, sources and text outputs as lists of lines, `image/png` as base64, a last line break. A notebook written by Jupyter that is opened and saved without a change is the same bytes (`notebook.test.ts`), so `git diff` shows only what was edited or run. Cell ids are kept, and made for new cells in a 4.5 notebook. nbformat 3 files are read and saved as 4. After a run, `metadata.language_info` names Python and its version; `kernelspec` is left alone, or set to `python3` when missing. Checked by hand on the file `tests/browser/notebook.mjs --save-to` writes (13 cells, with a table, a plot and an error): `nbformat.validate` of nbformat 5.10.4 accepts it, `nbformat.writes` of it is the same bytes, and `jupyter nbconvert --to html` (the renderer GitHub's is built on) draws the plot and the table.

## What a notebook's author can do to the page

A notebook comes from a cloned repository; its Markdown and its saved outputs are whatever its author wrote, and the desktop's page holds the person's sign-ins. So HTML from a notebook is never put in the page as it is: `sanitize.ts` parses it in a document that runs nothing and copies out a fixed set of elements and attributes. No `<script>`, event handlers, `<iframe>`, `<form>`, `<style>`, inline SVG, or `javascript:` links; images are `data:` images, http(s) addresses (fetched without a referrer), files beside the notebook and cell attachments. `application/javascript` outputs are not run. `tests/browser/notebook.mjs` plants each of these and checks none ran.

What a notebook's code does when the person runs it is not confined: it is a program of the profile, like any script.

## `jupyter` in a terminal

```
jupyter notebook [FILE|DIR]     jupyter lab [FILE|DIR]
jupyter execute FILE...         run the cells here and print what they print (--inplace saves the outputs)
jupyter nbconvert --to script FILE...
jupyter nbconvert --to notebook --execute [--inplace] FILE...
```

`jupyter execute` works in the terminal UI too, where there is no Notebook app; `jupyter notebook` there says so.

## Measured

`tests/browser/notebook.mjs` on an Apple M3 (8 GB, other jobs running), headless Chrome, a local build. The notebook imports numpy, pandas and matplotlib in its first cell. The click is the double-click on the file in Files; Run All is pressed as soon as the notebook is drawn. "Cold" is a fresh browser profile: Pyodide and the three packages are fetched. "Warm" is the same notebook opened again after a reload, from the browser's cache.

| | Cold | Warm |
| --- | --- | --- |
| Double-click to the notebook drawn | 0.3 to 0.4 s | 0.3 s |
| Double-click to the first cell's output (the three imports done) | 5.7 and 6.9 s with Pyodide from the server's own copy (two runs); 4.5 to 9.8 s with it from cdn.jsdelivr.net (five runs of earlier builds) | 3.8 and 4.2 s |
| Double-click to the pandas table, and to the plot | under 0.1 s and 0.1 to 0.2 s after the first output | the same |
| Stop pressed to `KeyboardInterrupt` shown | 0.1 s | |
| Longest delay of the page's main thread during a 2.5 s numpy loop in a cell | 12 to 20 ms | |
| `jupyter execute` of a one-cell numpy notebook, whole command | | 1.7 and 1.9 s |

Warm is mostly Python importing pandas and matplotlib (about 2 s of it, as for `python3 chart.py`: docs/research/PYTHON_NATIVE_WHEELS.md).

The app adds 38 kB to the build (one lazy chunk), its Python process's page side 8 kB, `jupyter` 6 kB, and the Pyodide Worker's script carries 30 kB of Python (the kernel's side). Nothing new is hosted.

Every notebook's Python ends when the page goes away (`pagehide`): a reload with one still waiting for its next cell crashed the tab in headless Chrome, every time it was tried on a loaded machine. The cause was not found; ending the process first avoids it.

## Why not JupyterLite

Both routes were tried (2026-10-13). JupyterLite 0.6.4 with its Pyodide kernel 0.6.1, built to static files and served with the tab's isolation headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: credentialless`), runs: the page is cross-origin isolated and a cell with numpy, pandas and a plot works. Measured on the same machine, its files from a local server and Pyodide from jsdelivr, one run each:

| | JupyterLite | Notebook app |
| --- | --- | --- |
| First cell output, cold | 4.6 s (a `print`, nothing imported) | 4.5 to 9.8 s, with numpy, pandas and matplotlib imported |
| First plot, cold | 7.9 s | 0.1 to 0.2 s after that |
| First cell output / first plot, warm | 3.3 s / 5.8 s | 3.8 to 4.2 s / 0.1 s later |
| Files to host | 502 files, 19.0 MB (5.9 MB gzipped), plus 46 MB of source maps | none (about 50 kB in the build) |
| Python | its own: the kernel is built for one Pyodide (0.27.6 for kernel 0.6.1; the tab is on 0.29.5) and brings IPython and ipykernel | the tab's |
| Files | a store of its own in IndexedDB, mounted at `/drive` | the tab's files at their paths |

What decided it: JupyterLite keeps notebooks in its own storage, so a notebook from a cloned repository has to be copied in, and a saved one copied out, before `git` sees it. Making its file browser and its kernel use the tab's files means a JupyterLab extension (a contents provider) built with JupyterLab's own toolchain, and its service-worker or SharedArrayBuffer drive bridged to the tab's filesystem; neither was built. Its kernel pins a Pyodide version (`pyodideUrl` can point it at another address, not at another version), so the tab would host two Pyodides or move both together. `!command` and `%pip` would not reach the tab's shell and pip. It would be an app with another look and 19 MB to host (a pull-through cache of a built site, or a deploy step), for a student who needs to open, run and save.

What JupyterLite has that this does not is the list below. If widgets or extensions become the need, JupyterLite on an app origin is the route, and these measurements are where to start.

## Not Jupyter

- **Widgets** (ipywidgets, `interact`, ipympl, tqdm's notebook bar): not shown; the output's text form is shown instead, or a sentence. tqdm's text bar works (with one warning line: it cannot start its monitor thread).
- **JavaScript outputs** (plotly, bokeh, altair/vega, folium maps, `IPython.display.Javascript`, `<script>` in HTML): not run. A sentence says so.
- **Extensions, themes, the file browser, terminals, the debugger, the variable inspector, real-time collaboration**: none. It is one notebook per window.
- **Kernels other than Python** (R, Julia, …): none; a notebook written for one opens with a sentence saying so.
- **Threads, processes, sockets**: Pyodide has none. `threading.Thread().start()` raises "can't start new thread", `subprocess.run` raises "emscripten does not support processes", and `urllib`/`requests` cannot connect (docs/research/PYTHON_NATIVE_WHEELS.md). A `!command` is not Python's: it runs in the tab's shell (`!git`, `!pip`, `!ls`).
- **Math**: LaTeX in Markdown and `text/latex` outputs are shown as typed, not typeset.
- **Editor**: a plain text box with Python colors, auto-indent and Tab; no completion, no tooltips, no multiple cursors, no find and replace. No undo for a deleted cell. No cell copy and paste, no split or merge, no collapsing.
- **IPython**: a subset (the table above). No `%debug`, `%prun`, `%store`, history, `_ih`/`_oh`, custom display formatters, `%%script` with another interpreter. A notebook that needs the real IPython package gets the stand-in.
- **`plt.show()`** does not block and is not interactive: a PNG. `%matplotlib widget` is not there.
- **Format**: nbformat 4 (and 3 read). No signing or trust store: nothing a notebook contains runs until the person runs a cell.
- Each open notebook is a Pyodide of its own, with its own copy of every package it imports. Its memory was not measured.
- Where the page is not cross-origin isolated (no SharedArrayBuffer), a notebook opens and can be edited and saved; cells do not run, and the window says so. Stop for a cell that waits in an `await` and top-level `await` were tried in Chrome only.
