/**
 * Jupyter notebook files (.ipynb, nbformat 4): reading, writing, and turning
 * what a kernel says into the outputs a file stores. No DOM and no kernel
 * here; the Notebook app (src/desktop/apps/notebook.ts) and `jupyter`
 * (src/commands/jupyter.ts) are the callers.
 *
 * A file is written the way Jupyter writes one (keys sorted, one space of
 * indent, text as lists of lines), so opening and saving a notebook without
 * running it changes nothing git would show, and GitHub and Jupyter read
 * what is saved here.
 */

export type MimeBundle = Record<string, unknown>;

export type NbOutput =
  | { output_type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { output_type: 'display_data'; data: MimeBundle; metadata: Record<string, unknown> }
  | { output_type: 'execute_result'; data: MimeBundle; metadata: Record<string, unknown>; execution_count: number | null }
  | { output_type: 'error'; ename: string; evalue: string; traceback: string[] };

export interface NbCell {
  cell_type: 'code' | 'markdown' | 'raw';
  /** One string here; a list of lines in the file */
  source: string;
  metadata: Record<string, unknown>;
  /** nbformat 4.5 and later */
  id?: string;
  execution_count?: number | null;
  outputs?: NbOutput[];
  attachments?: Record<string, MimeBundle>;
}

export interface Notebook {
  cells: NbCell[];
  metadata: Record<string, unknown>;
  nbformat: 4;
  nbformat_minor: number;
}

/** What a kernel sends while a cell runs (src/notebook/kernel.ts) */
export type KernelOutput =
  | { t: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { t: 'display'; data: MimeBundle; metadata?: Record<string, unknown>; display_id?: string; update?: boolean }
  | { t: 'result'; data: MimeBundle; metadata?: Record<string, unknown>; count: number }
  | { t: 'error'; ename: string; evalue: string; traceback: string[] }
  | { t: 'clear'; wait?: boolean };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A file's "multiline string": text, or a list of pieces to join */
function joined(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map((s) => (typeof s === 'string' ? s : String(s ?? ''))).join('');
  return v == null ? '' : String(v);
}

/** Text as the lines a file stores, each keeping its line break */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const out = text.split('\n').map((l, i, a) => (i < a.length - 1 ? l + '\n' : l));
  if (out[out.length - 1] === '') out.pop();
  return out;
}

const isJsonMime = (mime: string) => mime === 'application/json' || mime.endsWith('+json');
/** The mime types whose text a file stores as lines (nbformat's rule) */
const splitsMime = (mime: string) => mime.startsWith('text/') || mime === 'application/javascript' || mime === 'image/svg+xml';

function readBundle(data: unknown): MimeBundle {
  const out: MimeBundle = {};
  if (!isObject(data)) return out;
  for (const [mime, v] of Object.entries(data)) out[mime] = isJsonMime(mime) ? v : joined(v);
  return out;
}

function writeBundle(data: MimeBundle): MimeBundle {
  const out: MimeBundle = {};
  for (const [mime, v] of Object.entries(data)) out[mime] = typeof v === 'string' && splitsMime(mime) ? splitLines(v) : v;
  return out;
}

function readOutput(o: unknown): NbOutput | null {
  if (!isObject(o)) return null;
  const meta = isObject(o.metadata) ? o.metadata : {};
  switch (o.output_type) {
    case 'stream':
      return { output_type: 'stream', name: o.name === 'stderr' ? 'stderr' : 'stdout', text: joined(o.text) };
    case 'display_data':
      return { output_type: 'display_data', data: readBundle(o.data), metadata: meta };
    case 'execute_result':
      return { output_type: 'execute_result', data: readBundle(o.data), metadata: meta, execution_count: typeof o.execution_count === 'number' ? o.execution_count : null };
    case 'error':
      return { output_type: 'error', ename: joined(o.ename), evalue: joined(o.evalue), traceback: Array.isArray(o.traceback) ? o.traceback.map((t) => joined(t)) : [] };
    default:
      return null;
  }
}

/** nbformat 3's outputs, in nbformat 4's shape */
function upgradeOutput3(o: Record<string, unknown>): unknown {
  const mimes: Record<string, string> = { text: 'text/plain', html: 'text/html', png: 'image/png', jpeg: 'image/jpeg', svg: 'image/svg+xml', latex: 'text/latex', json: 'application/json', javascript: 'application/javascript' };
  const bundle = () => {
    const data: MimeBundle = {};
    for (const [k, mime] of Object.entries(mimes)) if (o[k] !== undefined) data[mime] = o[k];
    return data;
  };
  if (o.output_type === 'pyout') return { output_type: 'execute_result', data: bundle(), metadata: o.metadata ?? {}, execution_count: o.prompt_number ?? null };
  if (o.output_type === 'display_data') return { output_type: 'display_data', data: bundle(), metadata: o.metadata ?? {} };
  if (o.output_type === 'pyerr') return { ...o, output_type: 'error' };
  if (o.output_type === 'stream') return { ...o, name: o.stream ?? o.name };
  return o;
}

function upgrade3(raw: Record<string, unknown>): Record<string, unknown> {
  const cells: unknown[] = [];
  for (const ws of Array.isArray(raw.worksheets) ? raw.worksheets : []) {
    for (const c of isObject(ws) && Array.isArray(ws.cells) ? ws.cells : []) {
      if (!isObject(c)) continue;
      if (c.cell_type === 'code') {
        cells.push({ cell_type: 'code', source: c.input, metadata: c.metadata ?? {}, execution_count: c.prompt_number ?? null, outputs: (Array.isArray(c.outputs) ? c.outputs : []).map((o) => (isObject(o) ? upgradeOutput3(o) : o)) });
      } else if (c.cell_type === 'heading') {
        const level = Math.min(6, Math.max(1, Number(c.level) || 1));
        cells.push({ cell_type: 'markdown', source: `${'#'.repeat(level)} ${joined(c.source).replace(/\n/g, ' ')}`, metadata: c.metadata ?? {} });
      } else {
        cells.push({ cell_type: c.cell_type === 'markdown' ? 'markdown' : 'raw', source: c.source, metadata: c.metadata ?? {} });
      }
    }
  }
  return { cells, metadata: raw.metadata ?? {}, nbformat: 4, nbformat_minor: 4 };
}

/** A notebook file that cannot be read: `message` is a sentence for the person */
export class NotebookFormatError extends Error {}

/** A file's text as a notebook. An empty file is an empty notebook, as in Jupyter. */
export function parseNotebook(text: string): Notebook {
  if (!text.trim()) return newNotebook();
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new NotebookFormatError('The file is not a notebook: it is not JSON.'); }
  if (!isObject(raw)) throw new NotebookFormatError('The file is not a notebook: it has no cells.');
  if (raw.nbformat === 3) raw = upgrade3(raw);
  const o = raw as Record<string, unknown>;
  if (o.nbformat !== 4) {
    throw new NotebookFormatError(typeof o.nbformat === 'number'
      ? `The notebook is in format ${o.nbformat}. This computer reads formats 3 and 4.`
      : 'The file is not a notebook: it does not say which notebook format it is.');
  }
  if (!Array.isArray(o.cells)) throw new NotebookFormatError('The file is not a notebook: it has no cells.');
  const cells: NbCell[] = [];
  for (const c of o.cells) {
    if (!isObject(c)) continue;
    const type = c.cell_type === 'code' || c.cell_type === 'markdown' ? c.cell_type : 'raw';
    const cell: NbCell = { cell_type: type, source: joined(c.source), metadata: isObject(c.metadata) ? c.metadata : {} };
    if (typeof c.id === 'string') cell.id = c.id;
    if (type === 'code') {
      cell.execution_count = typeof c.execution_count === 'number' ? c.execution_count : null;
      cell.outputs = (Array.isArray(c.outputs) ? c.outputs : []).map(readOutput).filter((x): x is NbOutput => !!x);
    } else if (isObject(c.attachments)) {
      cell.attachments = c.attachments as Record<string, MimeBundle>;
    }
    cells.push(cell);
  }
  return { cells, metadata: isObject(o.metadata) ? o.metadata : {}, nbformat: 4, nbformat_minor: typeof o.nbformat_minor === 'number' ? o.nbformat_minor : 0 };
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (!isObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) out[k] = sortKeys(v[k]);
  return out;
}

function writeOutput(o: NbOutput): unknown {
  switch (o.output_type) {
    case 'stream': return { output_type: 'stream', name: o.name, text: splitLines(o.text) };
    case 'display_data': return { output_type: 'display_data', data: writeBundle(o.data), metadata: o.metadata };
    case 'execute_result': return { output_type: 'execute_result', data: writeBundle(o.data), metadata: o.metadata, execution_count: o.execution_count };
    case 'error': return { output_type: 'error', ename: o.ename, evalue: o.evalue, traceback: o.traceback };
  }
}

/** The notebook as the text of its file: what `json.dumps(nb, sort_keys=True, indent=1)` and a last line break give */
export function serializeNotebook(nb: Notebook): string {
  const withIds = nb.nbformat_minor >= 5;
  const cells = nb.cells.map((c) => {
    const out: Record<string, unknown> = { cell_type: c.cell_type, metadata: c.metadata, source: splitLines(c.source) };
    if (withIds) out.id = c.id ?? newCellId();
    if (c.cell_type === 'code') {
      out.execution_count = c.execution_count ?? null;
      out.outputs = (c.outputs ?? []).map(writeOutput);
    } else if (c.attachments) {
      out.attachments = c.attachments;
    }
    return out;
  });
  return JSON.stringify(sortKeys({ cells, metadata: nb.metadata, nbformat: 4, nbformat_minor: nb.nbformat_minor }), null, 1) + '\n';
}

export function newCellId(): string {
  let s = '';
  for (let i = 0; i < 8; i++) s += Math.floor(Math.random() * 16).toString(16);
  return s;
}

export function newCell(type: NbCell['cell_type'], source = ''): NbCell {
  const cell: NbCell = { cell_type: type, source, metadata: {}, id: newCellId() };
  if (type === 'code') { cell.execution_count = null; cell.outputs = []; }
  return cell;
}

/** What Jupyter names the Python kernel: a file saved with it opens there without a question */
export const PYTHON_KERNELSPEC = { display_name: 'Python 3 (ipykernel)', language: 'python', name: 'python3' };

export function newNotebook(): Notebook {
  return {
    cells: [newCell('code')],
    metadata: { kernelspec: { ...PYTHON_KERNELSPEC }, language_info: { name: 'python' } },
    nbformat: 4,
    nbformat_minor: 5,
  };
}

/** The language a notebook is written in ('python' when it does not say) */
export function notebookLanguage(nb: Notebook): string {
  const info = nb.metadata.language_info;
  const spec = nb.metadata.kernelspec;
  const lang = (isObject(info) && typeof info.name === 'string' && info.name) || (isObject(spec) && typeof spec.language === 'string' && spec.language) || 'python';
  return /^i?python\d*$/i.test(lang) ? 'python' : lang.toLowerCase();
}

/** After a run: the file says which Python made the outputs, as Jupyter's does */
export function stampKernel(nb: Notebook, pythonVersion: string): void {
  if (!isObject(nb.metadata.kernelspec)) nb.metadata.kernelspec = { ...PYTHON_KERNELSPEC };
  const info = isObject(nb.metadata.language_info) ? nb.metadata.language_info : {};
  if (info.name === 'python' && info.version === pythonVersion) return;
  nb.metadata.language_info = {
    codemirror_mode: { name: 'ipython', version: 3 }, file_extension: '.py', mimetype: 'text/x-python',
    nbconvert_exporter: 'python', pygments_lexer: 'ipython3', ...info, name: 'python', version: pythonVersion,
  };
}

// ── Outputs ──

/** What a terminal would show for `text`: a carriage return goes back to the start of the line, a backspace one character back */
export function applyControlChars(text: string): string {
  if (!/[\r\b]/.test(text)) return text;
  const lines = text.split('\n');
  return lines.map((line, i) => {
    if (!/[\r\b]/.test(line)) return line;
    // (a line break written as \r\n is a line break)
    if (i < lines.length - 1 && line.endsWith('\r')) line = line.slice(0, -1);
    let out = '';
    let col = 0;
    for (const ch of line) {
      if (ch === '\r') col = 0;
      else if (ch === '\b') col = Math.max(0, col - 1);
      else { out = out.slice(0, col) + ch + out.slice(col + ch.length); col += ch.length; }
    }
    return out;
  }).join('\n');
}

/** A cell's printed text is cut at this many characters: more freezes a page and bloats the file */
export const STREAM_LIMIT = 500_000;
const CUT_NOTE = '\n[Output is cut here: it is longer than 500,000 characters.]\n';

/** The outputs of one cell as they build up while it runs */
export class OutputList {
  outputs: NbOutput[] = [];
  private ids = new Map<string, NbOutput[]>();
  private clearNext = false;
  private streamChars = 0;

  constructor(initial: NbOutput[] = []) { this.outputs = initial; }

  clear(): void {
    this.outputs = [];
    this.ids.clear();
    this.clearNext = false;
    this.streamChars = 0;
  }

  /** Add what the kernel said. Returns false when nothing changed (text past the limit). */
  apply(msg: KernelOutput): boolean {
    if (msg.t === 'clear') {
      if (msg.wait) this.clearNext = true; else this.clear();
      return true;
    }
    if (msg.t === 'display' && msg.update) {
      // (an update changes the displays that carry the id, and adds nothing)
      const targets = msg.display_id ? this.ids.get(msg.display_id) ?? [] : [];
      for (const o of targets) if (o.output_type === 'display_data') { o.data = msg.data; o.metadata = msg.metadata ?? {}; }
      return targets.length > 0;
    }
    if (this.clearNext) this.clear();
    switch (msg.t) {
      case 'stream': {
        if (!msg.text) return false;
        if (this.streamChars >= STREAM_LIMIT) return false;
        let text = msg.text;
        this.streamChars += text.length;
        if (this.streamChars >= STREAM_LIMIT) text = text.slice(0, Math.max(0, text.length - (this.streamChars - STREAM_LIMIT))) + CUT_NOTE;
        const last = this.outputs[this.outputs.length - 1];
        if (last && last.output_type === 'stream' && last.name === msg.name) last.text = applyControlChars(last.text + text);
        else this.outputs.push({ output_type: 'stream', name: msg.name, text: applyControlChars(text) });
        return true;
      }
      case 'display': {
        const o: NbOutput = { output_type: 'display_data', data: msg.data, metadata: msg.metadata ?? {} };
        this.outputs.push(o);
        if (msg.display_id) this.ids.set(msg.display_id, [...(this.ids.get(msg.display_id) ?? []), o]);
        return true;
      }
      case 'result':
        this.outputs.push({ output_type: 'execute_result', data: msg.data, metadata: msg.metadata ?? {}, execution_count: msg.count });
        return true;
      case 'error':
        this.outputs.push({ output_type: 'error', ename: msg.ename, evalue: msg.evalue, traceback: msg.traceback });
        return true;
    }
  }
}

/** The mime types the Notebook app draws, richest first */
export const RENDER_ORDER = ['text/html', 'image/svg+xml', 'image/png', 'image/jpeg', 'image/gif', 'text/markdown', 'text/latex', 'application/json', 'text/plain'];

/** Which entry of a bundle to show: the richest one that can be drawn (widgets and scripts cannot) */
export function pickMime(data: MimeBundle): string | null {
  for (const mime of RENDER_ORDER) if (data[mime] !== undefined && data[mime] !== null) return mime;
  return null;
}

/** A sentence for a bundle with nothing that can be drawn */
export function unsupportedNote(data: MimeBundle): string {
  const mimes = Object.keys(data);
  if (mimes.some((m) => m.startsWith('application/vnd.jupyter.widget'))) return 'This output is a widget. Widgets are not shown in this notebook.';
  if (mimes.some((m) => m === 'application/javascript' || m.includes('plotly') || m.includes('bokeh') || m.includes('vega'))) return 'This output needs JavaScript. It is not shown in this notebook.';
  return `This output (${mimes.join(', ') || 'empty'}) is not shown in this notebook.`;
}

/** Escape sequences out of a traceback or a program's colored text */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*(\x07|\x1b\\)/g, '');
}

export interface AnsiSpan { text: string; fg?: string; bg?: string; bold?: boolean }

const ANSI_COLORS = ['#3e424d', '#e75c58', '#00a250', '#c9a100', '#208ffb', '#d160c4', '#60c6c8', '#c5c1b4'];
const ANSI_BRIGHT = ['#282c36', '#b22b31', '#007427', '#b27d12', '#0065ca', '#a03196', '#258f8f', '#a1a6b2'];

/** Text with SGR color codes as runs with their colors; other escape sequences are dropped */
export function ansiSpans(text: string): AnsiSpan[] {
  const out: AnsiSpan[] = [];
  let fg: string | undefined;
  let bg: string | undefined;
  let bold = false;
  // eslint-disable-next-line no-control-regex
  const re = /\x1b\[([0-9;]*)m|\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
  let pos = 0;
  const push = (s: string) => { if (s) out.push({ text: s, ...(fg ? { fg } : {}), ...(bg ? { bg } : {}), ...(bold ? { bold } : {}) }); };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    push(text.slice(pos, m.index));
    pos = m.index + m[0].length;
    if (m[1] === undefined) continue;
    const codes = m[1] === '' ? [0] : m[1].split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) { fg = bg = undefined; bold = false; }
      else if (c === 1) bold = true;
      else if (c === 22) bold = false;
      else if (c >= 30 && c <= 37) fg = ANSI_COLORS[c - 30];
      else if (c >= 90 && c <= 97) fg = ANSI_BRIGHT[c - 90];
      else if (c === 39) fg = undefined;
      else if (c >= 40 && c <= 47) bg = ANSI_COLORS[c - 40];
      else if (c >= 100 && c <= 107) bg = ANSI_BRIGHT[c - 100];
      else if (c === 49) bg = undefined;
      else if (c === 38 || c === 48) {
        // 38;5;N and 38;2;R;G;B
        let color: string | undefined;
        if (codes[i + 1] === 5) { const n = codes[i + 2] ?? 0; color = n < 8 ? ANSI_COLORS[n] : n < 16 ? ANSI_BRIGHT[n - 8] : undefined; i += 2; }
        else if (codes[i + 1] === 2) { color = `rgb(${codes[i + 2] ?? 0},${codes[i + 3] ?? 0},${codes[i + 4] ?? 0})`; i += 4; }
        if (c === 38) fg = color; else bg = color;
      }
    }
  }
  push(text.slice(pos));
  return out;
}

/** The notebook's code cells as one Python script (`jupyter nbconvert --to script`) */
export function notebookScript(nb: Notebook): string {
  const parts = ['#!/usr/bin/env python', '# coding: utf-8', ''];
  for (const c of nb.cells) {
    if (c.cell_type === 'code') {
      parts.push(`# In[${c.execution_count ?? ' '}]:`, '', '');
      parts.push(c.source.replace(/^(\s*)([%!])/gm, (_m, indent: string, ch: string) => `${indent}# ${ch}`), '', '');
    } else if (c.cell_type === 'markdown' && c.source.trim()) {
      parts.push(c.source.split('\n').map((l) => (l ? `# ${l}` : '#')).join('\n'), '');
    }
  }
  return parts.join('\n').replace(/\n{4,}/g, '\n\n\n').replace(/\n*$/, '\n');
}

/** A cell's outputs as plain text, for a terminal (`jupyter execute`) */
export function outputsText(outputs: NbOutput[]): string {
  let out = '';
  for (const o of outputs) {
    if (o.output_type === 'stream') out += o.text;
    else if (o.output_type === 'error') out += stripAnsi(o.traceback.join('\n')) + '\n';
    else {
      const text = o.data['text/plain'];
      const mime = pickMime(o.data);
      if (typeof text === 'string') out += text + '\n';
      else if (mime) out += `[${mime}]\n`;
    }
  }
  return out;
}
