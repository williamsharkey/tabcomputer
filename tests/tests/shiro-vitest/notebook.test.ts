/**
 * The Notebook app's parts that need no browser (docs/NOTEBOOK.md): reading
 * and writing .ipynb files, turning what the kernel says into saved outputs,
 * cell source into Python (magics, shell lines), Markdown and Python colors,
 * `jupyter`'s arguments, the page's end of the kernel's control file, and a
 * lab config that names a notebook. Running cells in Pyodide is
 * tests/browser/notebook.mjs.
 */
import { describe, it, expect } from 'vitest';
import {
  NotebookFormatError, OutputList, STREAM_LIMIT, ansiSpans, applyControlChars, newNotebook, notebookLanguage, notebookScript, outputsText,
  parseNotebook, pickMime, serializeNotebook, splitLines, stampKernel, stripAnsi, unsupportedNote,
} from '@shiro/notebook/nbformat';
import { isEmptyCell, parseJupyterArgs, pyString, translateCell } from '@shiro/notebook/magics';
import { highlightPython, markdownToHtml } from '@shiro/notebook/markup';
import { ControlFile } from '@shiro/notebook/kernel';
import { parseLabConfig } from '@shiro/lab';
import { JUPYTER_BUILT_IN } from '@shiro/commands/pip';
import { NB_KERNEL_PY, NB_MPL_PY, NB_STUBS } from '@shiro/pyodide-worker/notebook-py';

/** A notebook as Jupyter writes it: sorted keys, one space of indent, sources as lines */
const JUPYTER_FILE = `{
 "cells": [
  {
   "cell_type": "markdown",
   "id": "a1b2c3d4",
   "metadata": {},
   "source": [
    "# Lab 3\\n",
    "\\n",
    "Plot the data."
   ]
  },
  {
   "cell_type": "code",
   "execution_count": 2,
   "id": "e5f6a7b8",
   "metadata": {
    "tags": [
     "keep"
    ]
   },
   "outputs": [
    {
     "name": "stdout",
     "output_type": "stream",
     "text": [
      "one\\n",
      "two\\n"
     ]
    },
    {
     "data": {
      "image/png": "iVBORw0KGgo=",
      "text/html": [
       "<table>\\n",
       "</table>"
      ],
      "text/plain": [
       "   a\\n",
       "0  1"
      ]
     },
     "execution_count": 2,
     "metadata": {},
     "output_type": "execute_result"
    }
   ],
   "source": [
    "import pandas as pd\\n",
    "pd.DataFrame({'a': [1]})"
   ]
  },
  {
   "cell_type": "code",
   "execution_count": null,
   "id": "c9d0e1f2",
   "metadata": {},
   "outputs": [],
   "source": []
  }
 ],
 "metadata": {
  "kernelspec": {
   "display_name": "Python 3 (ipykernel)",
   "language": "python",
   "name": "python3"
  },
  "language_info": {
   "name": "python",
   "version": "3.12.4"
  }
 },
 "nbformat": 4,
 "nbformat_minor": 5
}
`;

describe('nbformat: reading and writing .ipynb', () => {
  it('a file Jupyter wrote is written back byte for byte', () => {
    const nb = parseNotebook(JUPYTER_FILE);
    expect(nb.cells.map((c) => c.cell_type)).toEqual(['markdown', 'code', 'code']);
    expect(nb.cells[0].source).toBe('# Lab 3\n\nPlot the data.');
    expect(nb.cells[1].outputs?.[0]).toEqual({ output_type: 'stream', name: 'stdout', text: 'one\ntwo\n' });
    expect(nb.cells[1].outputs?.[1]).toMatchObject({ output_type: 'execute_result', execution_count: 2, data: { 'text/plain': '   a\n0  1', 'image/png': 'iVBORw0KGgo=' } });
    expect(serializeNotebook(nb)).toBe(JUPYTER_FILE);
  });

  it('what is written is what Jupyter and GitHub read: nbformat 4, lists of lines, sorted keys', () => {
    const nb = newNotebook();
    nb.cells[0].source = 'x = 1\nx';
    nb.cells[0].execution_count = 1;
    nb.cells[0].outputs = [{ output_type: 'execute_result', data: { 'text/plain': '1' }, metadata: {}, execution_count: 1 }];
    const raw = JSON.parse(serializeNotebook(nb));
    expect(raw.nbformat).toBe(4);
    expect(raw.nbformat_minor).toBe(5);
    expect(raw.metadata.kernelspec).toEqual({ display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' });
    expect(raw.cells[0].source).toEqual(['x = 1\n', 'x']);
    expect(raw.cells[0].id).toMatch(/^[a-f0-9]{8}$/);
    expect(raw.cells[0].outputs[0]).toEqual({ data: { 'text/plain': ['1'] }, execution_count: 1, metadata: {}, output_type: 'execute_result' });
    expect(Object.keys(raw.cells[0])).toEqual(['cell_type', 'execution_count', 'id', 'metadata', 'outputs', 'source']);
    expect(serializeNotebook(nb).endsWith('}\n')).toBe(true);
  });

  it('a notebook older than 4.5 gets no cell ids, and JSON outputs stay objects', () => {
    const text = JSON.stringify({ cells: [{ cell_type: 'code', metadata: {}, execution_count: 1, source: 'd', outputs: [{ output_type: 'display_data', metadata: {}, data: { 'application/json': { a: [1, 2] }, 'text/plain': 'x' } }] }], metadata: {}, nbformat: 4, nbformat_minor: 2 });
    const raw = JSON.parse(serializeNotebook(parseNotebook(text)));
    expect(raw.cells[0].id).toBeUndefined();
    expect(raw.cells[0].outputs[0].data['application/json']).toEqual({ a: [1, 2] });
    expect(raw.cells[0].source).toEqual(['d']);
  });

  it('an empty file is a new notebook; a format 3 notebook is read; anything else is refused in a sentence', () => {
    expect(parseNotebook('').cells).toHaveLength(1);
    const v3 = { nbformat: 3, nbformat_minor: 0, metadata: {}, worksheets: [{ cells: [
      { cell_type: 'heading', level: 2, source: ['Title'] },
      { cell_type: 'code', input: ['print(1)'], prompt_number: 4, outputs: [{ output_type: 'stream', stream: 'stdout', text: ['1\n'] }, { output_type: 'pyout', prompt_number: 4, text: ['1'] }] },
    ] }] };
    const nb = parseNotebook(JSON.stringify(v3));
    expect(nb.cells[0]).toMatchObject({ cell_type: 'markdown', source: '## Title' });
    expect(nb.cells[1]).toMatchObject({ cell_type: 'code', source: 'print(1)', execution_count: 4 });
    expect(nb.cells[1].outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: '1\n' },
      { output_type: 'execute_result', data: { 'text/plain': '1' }, metadata: {}, execution_count: 4 },
    ]);
    expect(() => parseNotebook('not json')).toThrow(NotebookFormatError);
    expect(() => parseNotebook('{"nbformat": 5, "cells": []}')).toThrow(/format 5/);
    expect(() => parseNotebook('[1]')).toThrow(/not a notebook/);
  });

  it('splitLines keeps each line break, as the file format does', () => {
    expect(splitLines('')).toEqual([]);
    expect(splitLines('a')).toEqual(['a']);
    expect(splitLines('a\nb\n')).toEqual(['a\n', 'b\n']);
    expect(splitLines('\n\nx')).toEqual(['\n', '\n', 'x']);
  });

  it('the language and the kernel stamp', () => {
    const nb = newNotebook();
    expect(notebookLanguage(nb)).toBe('python');
    stampKernel(nb, '3.13.2');
    expect(nb.metadata.language_info).toMatchObject({ name: 'python', version: '3.13.2', file_extension: '.py' });
    const r = parseNotebook(JSON.stringify({ cells: [], metadata: { kernelspec: { name: 'ir', language: 'R', display_name: 'R' } }, nbformat: 4, nbformat_minor: 4 }));
    expect(notebookLanguage(r)).toBe('r');
  });

  it('a notebook as a script', () => {
    const script = notebookScript(parseNotebook(JUPYTER_FILE));
    expect(script).toContain('# # Lab 3');
    expect(script).toContain('# In[2]:');
    expect(script).toContain("pd.DataFrame({'a': [1]})");
    const magic = newNotebook();
    magic.cells[0].source = '%matplotlib inline\n!pip install x\nprint(1)';
    expect(notebookScript(magic)).toContain('# %matplotlib inline\n# !pip install x\nprint(1)');
  });
});

describe('outputs: what the kernel says, as a file stores it', () => {
  it('printed text joins up by stream, and other outputs keep their order', () => {
    const list = new OutputList();
    list.apply({ t: 'stream', name: 'stdout', text: 'a' });
    list.apply({ t: 'stream', name: 'stdout', text: 'b\n' });
    list.apply({ t: 'stream', name: 'stderr', text: 'warn\n' });
    list.apply({ t: 'display', data: { 'image/png': 'AAAA', 'text/plain': '<Figure>' }, metadata: {} });
    list.apply({ t: 'stream', name: 'stdout', text: 'after\n' });
    list.apply({ t: 'result', data: { 'text/plain': '42' }, count: 7 });
    expect(list.outputs).toEqual([
      { output_type: 'stream', name: 'stdout', text: 'ab\n' },
      { output_type: 'stream', name: 'stderr', text: 'warn\n' },
      { output_type: 'display_data', data: { 'image/png': 'AAAA', 'text/plain': '<Figure>' }, metadata: {} },
      { output_type: 'stream', name: 'stdout', text: 'after\n' },
      { output_type: 'execute_result', data: { 'text/plain': '42' }, metadata: {}, execution_count: 7 },
    ]);
    expect(outputsText(list.outputs)).toBe('ab\nwarn\n<Figure>\nafter\n42\n');
  });

  it('an error keeps its name, value and traceback', () => {
    const list = new OutputList();
    list.apply({ t: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['Traceback (most recent call last):', 'ZeroDivisionError: division by zero'] });
    expect(list.outputs[0]).toEqual({ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['Traceback (most recent call last):', 'ZeroDivisionError: division by zero'] });
  });

  it('clear_output, with and without wait; a display that is updated by its id', () => {
    const list = new OutputList();
    list.apply({ t: 'stream', name: 'stdout', text: '1\n' });
    list.apply({ t: 'clear' });
    expect(list.outputs).toEqual([]);
    list.apply({ t: 'stream', name: 'stdout', text: '2\n' });
    list.apply({ t: 'clear', wait: true });
    expect(list.outputs).toHaveLength(1);
    list.apply({ t: 'stream', name: 'stdout', text: '3\n' });
    expect(list.outputs).toEqual([{ output_type: 'stream', name: 'stdout', text: '3\n' }]);

    list.apply({ t: 'display', data: { 'text/plain': '10%' }, display_id: 'bar' });
    expect(list.apply({ t: 'display', data: { 'text/plain': '90%' }, display_id: 'bar', update: true })).toBe(true);
    expect(list.outputs[1]).toMatchObject({ output_type: 'display_data', data: { 'text/plain': '90%' } });
    expect(list.outputs).toHaveLength(2);
    expect(list.apply({ t: 'display', data: { 'text/plain': 'x' }, display_id: 'nobody', update: true })).toBe(false);
  });

  it('a progress bar that rewrites its line is one line', () => {
    expect(applyControlChars('10%\r50%\r100%\n')).toBe('100%\n');
    expect(applyControlChars('abc\b\bX')).toBe('aXc');
    expect(applyControlChars('line\r\nnext')).toBe('line\nnext');
    const list = new OutputList();
    list.apply({ t: 'stream', name: 'stderr', text: ' 10%|#' });
    list.apply({ t: 'stream', name: 'stderr', text: '\r100%|##########' });
    expect(list.outputs[0]).toMatchObject({ text: '100%|##########' });
  });

  it('printed text is cut at the limit, with a sentence saying so', () => {
    const list = new OutputList();
    const chunk = 'x'.repeat(100_000) + '\n';
    for (let i = 0; i < 8; i++) list.apply({ t: 'stream', name: 'stdout', text: chunk });
    const text = (list.outputs[0] as { text: string }).text;
    expect(text.length).toBeLessThan(STREAM_LIMIT + 200);
    expect(text).toContain('Output is cut here');
    expect(list.apply({ t: 'stream', name: 'stdout', text: 'more' })).toBe(false);
  });

  it('the richest entry that can be drawn is the one shown', () => {
    expect(pickMime({ 'text/plain': 'a', 'text/html': '<b>a</b>' })).toBe('text/html');
    expect(pickMime({ 'text/plain': 'a', 'image/png': 'AAAA' })).toBe('image/png');
    expect(pickMime({ 'application/vnd.jupyter.widget-view+json': {}, 'text/plain': 'IntSlider(value=1)' })).toBe('text/plain');
    expect(pickMime({ 'application/vnd.jupyter.widget-view+json': {} })).toBeNull();
    expect(unsupportedNote({ 'application/vnd.jupyter.widget-view+json': {} })).toMatch(/Widgets are not shown/);
    expect(unsupportedNote({ 'application/javascript': 'alert(1)' })).toMatch(/JavaScript/);
  });

  it('a traceback with colors, as runs and as plain text', () => {
    const tb = '\x1b[0;31mZeroDivisionError\x1b[0m: division by \x1b[1mzero\x1b[22m';
    expect(stripAnsi(tb)).toBe('ZeroDivisionError: division by zero');
    const spans = ansiSpans(tb);
    expect(spans.map((s) => s.text).join('')).toBe('ZeroDivisionError: division by zero');
    expect(spans[0]).toMatchObject({ text: 'ZeroDivisionError', fg: '#e75c58' });
    expect(spans[spans.length - 1]).toEqual({ text: 'zero', bold: true });
  });
});

describe('cell source as Python', () => {
  it('Python is left as written, line for line', () => {
    const src = 'import numpy as np\nx = np.arange(3)\nprint(x % 2)\nx';
    expect(translateCell(src)).toBe(src);
  });

  it('line magics and shell lines become calls on get_ipython()', () => {
    expect(translateCell('%matplotlib inline')).toBe('get_ipython().run_line_magic("matplotlib", "inline")');
    expect(translateCell('%pip install seaborn==0.13')).toBe('get_ipython().run_line_magic("pip", "install seaborn==0.13")');
    expect(translateCell('!pip install -q requests')).toBe('get_ipython().system("pip install -q requests")');
    expect(translateCell('!ls "my dir"')).toBe('get_ipython().system("ls \\"my dir\\"")');
    expect(translateCell('files = !ls *.csv')).toBe('files = get_ipython().getoutput("ls *.csv")');
    expect(translateCell('t = %timeit -o sum(range(9))')).toBe('t = get_ipython().run_line_magic("timeit", "-o sum(range(9))")');
    expect(translateCell('%load_ext autoreload\n%autoreload 2\nimport x')).toBe('get_ipython().run_line_magic("load_ext", "autoreload")\nget_ipython().run_line_magic("autoreload", "2")\nimport x');
    expect(translateCell('for f in fs:\n    !wc -l {f}')).toBe('for f in fs:\n    get_ipython().system("wc -l {f}")');
    expect(translateCell('np.mean?')).toBe('get_ipython().run_line_magic("pinfo", "np.mean")');
    expect(translateCell('??np.mean')).toBe('get_ipython().run_line_magic("pinfo2", "np.mean")');
  });

  it('a % or ! that is Python stays Python', () => {
    const cont = 'x = (10\n     % 3)\ny = [1,\n!2]';
    expect(translateCell(cont).split('\n').slice(0, 2).join('\n')).toBe('x = (10\n     % 3)');
    const text = 's = """\n%matplotlib inline\n!rm -rf /\n"""\nprint(s)';
    expect(translateCell(text)).toBe(text);
    const cont2 = 'total = 7 \\\n% 2';
    expect(translateCell(cont2)).toBe(cont2);
    expect(translateCell('ok = a != b')).toBe('ok = a != b');
    expect(translateCell("print('50%')  # 100%\n%pwd")).toBe("print('50%')  # 100%\nget_ipython().run_line_magic(\"pwd\", \"\")");
    expect(translateCell("q = '''it''s'''\n!echo hi")).toBe("q = '''it''s'''\nget_ipython().system(\"echo hi\")");
  });

  it('a cell magic takes the rest of the cell', () => {
    expect(translateCell('%%time\nsum(range(10))')).toBe('get_ipython().run_cell_magic("time", "", "sum(range(10))")');
    expect(translateCell('%%writefile data/a.csv\nx,y\n1,2\n')).toBe('get_ipython().run_cell_magic("writefile", "data/a.csv", "x,y\\n1,2\\n")');
    expect(translateCell('%%bash\necho $HOME\n%not-a-magic')).toBe('get_ipython().run_cell_magic("bash", "", "echo $HOME\\n%not-a-magic")');
    // (a Python body has its own magics translated)
    expect(translateCell('%%capture out\n!pip install x\nprint(1)')).toBe('get_ipython().run_cell_magic("capture", "out", "get_ipython().system(\\"pip install x\\")\\nprint(1)")');
    expect(translateCell('\n\n%%html\n<b>x</b>')).toBe('\n\nget_ipython().run_cell_magic("html", "", "<b>x</b>")');
  });

  it('strings for Python, and cells with nothing to run', () => {
    expect(pyString('a"b\\c\n')).toBe('"a\\"b\\\\c\\n"');
    expect(pyString(`x${String.fromCharCode(0x2028)}y`)).toBe('"x\\u2028y"');
    expect(isEmptyCell('')).toBe(true);
    expect(isEmptyCell('  \n# only a comment\n')).toBe(true);
    expect(isEmptyCell('x')).toBe(false);
  });
});

describe('jupyter, as typed', () => {
  it('notebook and lab open a notebook or a folder', () => {
    expect(parseJupyterArgs(['notebook'])).toEqual({ action: 'open', path: null });
    expect(parseJupyterArgs(['lab'])).toEqual({ action: 'open', path: null });
    expect(parseJupyterArgs(['notebook', 'lab3.ipynb'])).toEqual({ action: 'open', path: 'lab3.ipynb' });
    expect(parseJupyterArgs(['lab', 'notebooks/'])).toEqual({ action: 'open', path: 'notebooks/' });
    expect(parseJupyterArgs(['lab3.ipynb'])).toEqual({ action: 'open', path: 'lab3.ipynb' });
    expect(parseJupyterArgs([])).toEqual({ action: 'open', path: null });
  });

  it("the real programs' server options are accepted and not needed", () => {
    expect(parseJupyterArgs(['notebook', '--no-browser', '--port', '8888', '--ip=0.0.0.0', 'a.ipynb'])).toEqual({ action: 'open', path: 'a.ipynb' });
    expect(parseJupyterArgs(['lab', '--allow-root', '--NotebookApp.token=', '--notebook-dir', 'work'])).toEqual({ action: 'open', path: 'work' });
    expect(parseJupyterArgs(['notebook', '--frobnicate'])).toMatchObject({ action: 'error' });
  });

  it('execute and nbconvert', () => {
    expect(parseJupyterArgs(['execute', 'a.ipynb'])).toEqual({ action: 'execute', files: ['a.ipynb'], inplace: false, output: null });
    expect(parseJupyterArgs(['execute', '--inplace', 'a.ipynb', 'b.ipynb'])).toEqual({ action: 'execute', files: ['a.ipynb', 'b.ipynb'], inplace: true, output: null });
    expect(parseJupyterArgs(['nbconvert', '--to', 'notebook', '--execute', '--inplace', 'a.ipynb'])).toEqual({ action: 'execute', files: ['a.ipynb'], inplace: true, output: null });
    expect(parseJupyterArgs(['nbconvert', '--to=notebook', '--execute', 'a.ipynb'])).toEqual({ action: 'execute', files: ['a.ipynb'], inplace: false, output: '{stem}.nbconvert' });
    expect(parseJupyterArgs(['nbconvert', '--to', 'script', 'a.ipynb'])).toEqual({ action: 'script', files: ['a.ipynb'], stdout: false });
    expect(parseJupyterArgs(['nbconvert', '--to', 'python', '--stdout', 'a.ipynb'])).toEqual({ action: 'script', files: ['a.ipynb'], stdout: true });
    expect(parseJupyterArgs(['nbconvert', '--to', 'pdf', 'a.ipynb'])).toMatchObject({ action: 'error', message: expect.stringContaining('--to script') });
    expect(parseJupyterArgs(['execute'])).toMatchObject({ action: 'error' });
  });

  it('version, help, and what is not a command', () => {
    expect(parseJupyterArgs(['--version'])).toEqual({ action: 'version' });
    expect(parseJupyterArgs(['notebook', '--version'])).toEqual({ action: 'version' });
    expect(parseJupyterArgs(['--help'])).toEqual({ action: 'help' });
    expect(parseJupyterArgs(['kernelspec', 'list'])).toEqual({ action: 'kernelspec' });
    expect(parseJupyterArgs(['console'])).toMatchObject({ action: 'error', message: expect.stringContaining('jupyter notebook FILE.ipynb') });
  });
});

describe('text cells and code colors', () => {
  it('Markdown: headings, emphasis, lists, code, links, tables', () => {
    expect(markdownToHtml('# Title\n\nSome *text* and **bold** and `x < 1`.')).toBe('<h1>Title</h1>\n<p>Some <em>text</em> and <strong>bold</strong> and <code>x &#60; 1</code>.</p>');
    expect(markdownToHtml('- one\n- two\n\n1. a\n2. b')).toBe('<ul><li>one</li><li>two</li></ul>\n<ol><li>a</li><li>b</li></ol>');
    expect(markdownToHtml('```python\nif a < b:\n    pass\n```')).toBe('<pre><code>if a &#60; b:\n    pass</code></pre>');
    expect(markdownToHtml('[docs](https://example.com/a_b) ![plot](img/p.png)')).toBe('<p><a href="https://example.com/a_b">docs</a> <img src="img/p.png" alt="plot"></p>');
    expect(markdownToHtml('| a | b |\n|---|--:|\n| 1 | 2 |')).toBe('<table><thead><tr><th>a</th><th align="right">b</th></tr></thead><tbody><tr><td>1</td><td align="right">2</td></tr></tbody></table>');
    expect(markdownToHtml('> quoted\n\n---')).toBe('<blockquote><p>quoted</p></blockquote>\n<hr>');
  });

  it('Markdown: math is left as typed, a bare < is text, snake_case is not emphasis', () => {
    expect(markdownToHtml('Energy is $E = m_0 c^2$ here.')).toBe('<p>Energy is $E = m_0 c^2$ here.</p>');
    expect(markdownToHtml('if a < b and my_var_name')).toBe('<p>if a &lt; b and my_var_name</p>');
    // (HTML the author wrote passes through; sanitize.ts decides what of it is shown)
    expect(markdownToHtml('<b>x</b>')).toBe('<p><b>x</b></p>');
  });

  it('Python colors: every character of the source is in the result, escaped', () => {
    const src = 'import numpy as np\n@decor\ndef f(x):  # sum\n    return "a<b" + str(1.5e3) if x is None else f\'{x}\'\n%matplotlib inline\n!ls';
    const html = highlightPython(src);
    const text = html.replace(/<[^>]+>/g, '').replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
    expect(text).toBe(src);
    expect(html).toContain('<span class="nb-k">import</span>');
    expect(html).toContain('<span class="nb-f">f</span>');
    expect(html).toContain('<span class="nb-c"># sum</span>');
    expect(html).toContain('<span class="nb-s">&#34;a&#60;b&#34;</span>');
    expect(html).toContain('<span class="nb-n">1.5e3</span>');
    expect(html).toContain('<span class="nb-o">None</span>');
    expect(html).toContain('<span class="nb-m">%matplotlib inline</span>');
    expect(html).toContain('<span class="nb-d">@decor</span>');
    expect(highlightPython('x = """open')).toBe('x = <span class="nb-s">&#34;&#34;&#34;open</span>');
  });
});

describe("the kernel's control file (fd 3 of its process)", () => {
  it('lines from the guest arrive whole, however they were written', async () => {
    const f = new ControlFile();
    const lines: string[] = [];
    f.onLine = (l) => lines.push(l);
    const enc = new TextEncoder();
    await f.write(enc.encode('{"t":"rea'));
    await f.write(enc.encode('dy"}\n{"t":"status","text":"caf'));
    expect(lines).toEqual(['{"t":"ready"}']);
    // a multi-byte character split across two writes
    const rest = enc.encode('é"}\n');
    await f.write(rest.subarray(0, 1));
    await f.write(rest.subarray(1));
    expect(lines).toEqual(['{"t":"ready"}', '{"t":"status","text":"café"}']);
  });

  it('a read waits for a line, takes it in pieces, and a signal ends the wait', async () => {
    const f = new ControlFile();
    const dec = new TextDecoder();
    const buf = new Uint8Array(4);
    const pending = f.read(buf);
    f.push('abcdef');
    expect(await pending).toBe(4);
    expect(dec.decode(buf)).toBe('abcd');
    expect(await f.read(buf)).toBe(3);
    expect(dec.decode(buf.subarray(0, 3))).toBe('ef\n');
    const abort = new AbortController();
    const waiting = f.read(buf, abort.signal);
    abort.abort();
    expect(await waiting).toBe(-4);
    f.end();
    expect(await f.read(buf)).toBe(0);
  });
});

describe('the kernel\'s Python side', () => {
  it('is plain text a JavaScript template did not change', () => {
    // (a `${` or a backtick in the Python would have been taken by the template)
    expect(NB_KERNEL_PY).toContain('async def run_cell(source):');
    expect(NB_KERNEL_PY).toContain('"\\n".join(self)');
    expect(NB_KERNEL_PY).toContain("os.environ[\"MPLBACKEND\"] = \"module://tabcomputer_nb_mpl\"");
    expect(NB_MPL_PY).toContain('FigureCanvas = FigureCanvasNotebook');
    expect(Object.keys(NB_STUBS)).toEqual(['IPython', 'matplotlib_inline']);
    expect(NB_STUBS.IPython['IPython/display.py']).toContain('from tabcomputer_nb import display, update_display, clear_output');
  });
});

describe('a lab that names a notebook', () => {
  it('the config takes a notebook inside the repository', () => {
    expect(parseLabConfig('{"lab":1,"notebook":"labs/lab3.ipynb"}')).toMatchObject({ config: { notebook: 'labs/lab3.ipynb', run: '', test: '' }, problems: [] });
    expect(parseLabConfig('{"lab":1,"notebook":"./lab3.ipynb"}').config?.notebook).toBe('lab3.ipynb');
    expect(parseLabConfig('{"lab":1}').config?.notebook).toBe('');
  });

  it('a notebook outside the repository, or not a notebook, is a problem named by its key', () => {
    expect(parseLabConfig('{"lab":1,"notebook":"../x.ipynb"}').problems[0]).toMatch(/^lab\.json: notebook must be a path inside the repository/);
    expect(parseLabConfig('{"lab":1,"notebook":"/etc/x.ipynb"}').problems[0]).toMatch(/inside the repository/);
    expect(parseLabConfig('{"lab":1,"notebook":"main.py"}').problems[0]).toMatch(/must name a \.ipynb file/);
    expect(parseLabConfig('{"lab":1,"notebook":7}').problems[0]).toMatch(/notebook must be the path/);
  });
});

describe('pip install jupyter', () => {
  it("Jupyter's own programs and its kernel package are the built-in ones; other packages are not", () => {
    for (const spec of ['jupyter', 'jupyterlab', 'JupyterLab>=4', 'notebook==7.2.1', 'ipykernel', 'jupyter-server', 'jupyter_core', 'notebook[test]', 'nbclient ; python_version > "3.8"']) expect(JUPYTER_BUILT_IN.test(spec), spec).toBe(true);
    for (const spec of ['jupyterlab-widgets', 'notebook-shim', 'numpy', 'ipywidgets', 'ipython', 'nbformat', 'jupytext']) expect(JUPYTER_BUILT_IN.test(spec), spec).toBe(false);
  });
});
