/**
 * A notebook cell's source as Python: IPython's line magics (`%pip install x`),
 * shell lines (`!ls`), cell magics (`%%time`) and `name?` become calls on
 * `get_ipython()`, which the kernel's Python side answers
 * (src/pyodide-worker/notebook-py.ts). Everything else is left as written,
 * line for line, so a traceback's line numbers are the cell's.
 */

/** A Python string literal for `s` */
export function pyString(s: string): string {
  // (JSON's escapes are Python's; the two line separators JSON leaves alone would end a Python line)
  return JSON.stringify(s).split(String.fromCharCode(0x2028)).join('\\u2028').split(String.fromCharCode(0x2029)).join('\\u2029');
}

/** Cell magics whose body is Python: the magics inside it are translated too */
const PYTHON_BODY = new Set(['time', 'timeit', 'capture', 'python', 'python3', 'prun']);

interface ScanState {
  /** The quote that opened a string still open at the end of the line (''' or """), or '' */
  triple: string;
  /** Open brackets */
  depth: number;
  /** The line ended with a backslash */
  continued: boolean;
}

/** Follow strings, comments and brackets across one line of Python */
function scanLine(line: string, st: ScanState): void {
  let i = 0;
  st.continued = false;
  while (i < line.length) {
    if (st.triple) {
      const end = line.indexOf(st.triple, i);
      if (end < 0) return;
      // (an escaped quote does not close it)
      let back = 0;
      while (end - 1 - back >= i && line[end - 1 - back] === '\\') back++;
      i = end + (back % 2 ? 1 : 3);
      if (back % 2 === 0) st.triple = '';
      continue;
    }
    const ch = line[i];
    if (ch === '#') return;
    if (ch === '"' || ch === "'") {
      if (line.startsWith(ch.repeat(3), i)) { st.triple = ch.repeat(3); i += 3; continue; }
      i++;
      while (i < line.length && line[i] !== ch) i += line[i] === '\\' ? 2 : 1;
      i++;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') st.depth++;
    else if (ch === ')' || ch === ']' || ch === '}') st.depth = Math.max(0, st.depth - 1);
    else if (ch === '\\' && i === line.length - 1) st.continued = true;
    i++;
  }
}

const LINE_MAGIC = /^(\s*)%([A-Za-z_][\w.]*)(?:\s+(.*))?$/;
const SHELL_LINE = /^(\s*)!(.*)$/;
const ASSIGN_SHELL = /^(\s*)([A-Za-z_][\w.,\s[\]]*?)\s*=\s*!(.*)$/;
const ASSIGN_MAGIC = /^(\s*)([A-Za-z_][\w.,\s[\]]*?)\s*=\s*%([A-Za-z_][\w.]*)(?:\s+(.*))?$/;
const HELP_AFTER = /^(\s*)([A-Za-z_][\w.]*)(\?\??)\s*$/;
const HELP_BEFORE = /^(\s*)(\?\??)([A-Za-z_][\w.]*)\s*$/;

function translateLines(lines: string[]): string[] {
  const st: ScanState = { triple: '', depth: 0, continued: false };
  const out: string[] = [];
  for (const line of lines) {
    const fresh = !st.triple && st.depth === 0 && !st.continued;
    if (fresh) {
      let m: RegExpExecArray | null;
      if ((m = LINE_MAGIC.exec(line))) { out.push(`${m[1]}get_ipython().run_line_magic(${pyString(m[2])}, ${pyString((m[3] ?? '').trim())})`); continue; }
      if ((m = SHELL_LINE.exec(line))) { out.push(`${m[1]}get_ipython().system(${pyString(m[2].trim())})`); continue; }
      if ((m = ASSIGN_SHELL.exec(line))) { out.push(`${m[1]}${m[2]} = get_ipython().getoutput(${pyString(m[3].trim())})`); continue; }
      if ((m = ASSIGN_MAGIC.exec(line))) { out.push(`${m[1]}${m[2]} = get_ipython().run_line_magic(${pyString(m[3])}, ${pyString((m[4] ?? '').trim())})`); continue; }
      if ((m = HELP_AFTER.exec(line))) { out.push(`${m[1]}get_ipython().run_line_magic(${pyString(m[3] === '??' ? 'pinfo2' : 'pinfo')}, ${pyString(m[2])})`); continue; }
      if ((m = HELP_BEFORE.exec(line))) { out.push(`${m[1]}get_ipython().run_line_magic(${pyString(m[2] === '??' ? 'pinfo2' : 'pinfo')}, ${pyString(m[3])})`); continue; }
    }
    out.push(line);
    scanLine(line, st);
  }
  return out;
}

/** A cell's source as the Python the kernel runs */
export function translateCell(source: string): string {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  // A cell magic is the first line that is not blank
  let first = 0;
  while (first < lines.length && !lines[first].trim()) first++;
  const cm = first < lines.length ? /^%%([A-Za-z_][\w.]*)(?:\s+(.*))?$/.exec(lines[first].trimEnd()) : null;
  if (cm) {
    const name = cm[1];
    let body = lines.slice(first + 1);
    if (PYTHON_BODY.has(name)) body = translateLines(body);
    // (blank lines before it keep a traceback's line numbers near the cell's)
    return `${'\n'.repeat(first)}get_ipython().run_cell_magic(${pyString(name)}, ${pyString((cm[2] ?? '').trim())}, ${pyString(body.join('\n'))})`;
  }
  return translateLines(lines).join('\n');
}

/** Whether running the cell would do nothing (only blank lines and comments) */
export function isEmptyCell(source: string): boolean {
  return source.split('\n').every((l) => !l.trim() || l.trim().startsWith('#'));
}

/**
 * `jupyter` as typed: which notebook to open, or what else was asked.
 * `jupyter notebook [FILE|DIR]`, `jupyter lab [FILE|DIR]`, `jupyter FILE.ipynb`,
 * `jupyter execute FILE…`, `jupyter nbconvert --to script FILE…`.
 */
export type JupyterCommand =
  | { action: 'open'; path: string | null }
  | { action: 'execute'; files: string[]; inplace: boolean; output: string | null }
  | { action: 'script'; files: string[]; stdout: boolean }
  | { action: 'version' }
  | { action: 'help' }
  | { action: 'kernelspec' }
  | { action: 'error'; message: string };

/** Options of the real programs that start a server or pick a browser: accepted and not needed here */
const SERVER_FLAG = /^--(no-browser|allow-root|debug|autoreload|collaborative|watch|dev-mode|core-mode|expose-app-in-browser|skip-dev-build|generate-config|y|log-level(=.*)?)$/;
const SERVER_VALUE = /^--(port|ip|notebook-dir|NotebookApp\.[\w.]+|ServerApp\.[\w.]+|LabApp\.[\w.]+|IdentityProvider\.[\w.]+|app-dir|browser|config|certfile|keyfile|port-retries)(=(.*))?$/;

export function parseJupyterArgs(args: string[]): JupyterCommand {
  const [sub, ...rest] = args;
  if (!sub) return { action: 'open', path: null };
  if (sub === '--version' || sub === '-V' || sub === 'version') return { action: 'version' };
  if (sub === '--help' || sub === '-h' || sub === 'help') return { action: 'help' };
  if (sub === 'kernelspec') return { action: 'kernelspec' };
  if (sub === 'notebook' || sub === 'lab' || sub === 'nbclassic' || sub === 'server' || sub === 'open') {
    let path: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--version') return { action: 'version' };
      if (a === '--help' || a === '-h') return { action: 'help' };
      if (SERVER_FLAG.test(a)) continue;
      const v = SERVER_VALUE.exec(a);
      if (v) {
        const value = v[2] !== undefined ? v[3] : rest[++i];
        if (v[1] === 'notebook-dir' || /\.(root_dir|notebook_dir)$/.test(v[1])) path ??= value ?? null;
        continue;
      }
      if (a.startsWith('-')) return { action: 'error', message: `jupyter ${sub}: option ${a} is not known here` };
      path = a;
    }
    return { action: 'open', path };
  }
  if (sub === 'execute' || sub === 'run') {
    const files: string[] = [];
    let inplace = false;
    let output: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--inplace') inplace = true;
      else if (a === '--output' || a === '-o') output = rest[++i] ?? null;
      else if (a.startsWith('--output=')) output = a.slice(9);
      else if (/^--(allow-errors|timeout(=.*)?|kernel_name(=.*)?|kernel-name(=.*)?)$/.test(a)) { if (/^--(timeout|kernel_name|kernel-name)$/.test(a)) i++; }
      else if (a.startsWith('-')) return { action: 'error', message: `jupyter ${sub}: option ${a} is not known here` };
      else files.push(a);
    }
    if (!files.length) return { action: 'error', message: `jupyter ${sub}: name a notebook, like jupyter ${sub} lab.ipynb` };
    return { action: 'execute', files, inplace, output };
  }
  if (sub === 'nbconvert') {
    const files: string[] = [];
    let to = '';
    let execute = false;
    let inplace = false;
    let stdout = false;
    let output: string | null = null;
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--to') to = rest[++i] ?? '';
      else if (a.startsWith('--to=')) to = a.slice(5);
      else if (a === '--execute') execute = true;
      else if (a === '--inplace') inplace = true;
      else if (a === '--stdout') stdout = true;
      else if (a === '--output') output = rest[++i] ?? null;
      else if (a.startsWith('--output=')) output = a.slice(9);
      else if (a.startsWith('-')) return { action: 'error', message: `jupyter nbconvert: option ${a} is not known here` };
      else files.push(a);
    }
    if (!files.length) return { action: 'error', message: 'jupyter nbconvert: name a notebook, like jupyter nbconvert --to script lab.ipynb' };
    if (to === 'script' || to === 'python') return { action: 'script', files, stdout };
    // (without --inplace or --output, nbconvert writes NAME.nbconvert.ipynb beside the notebook)
    if (to === 'notebook' && execute) return { action: 'execute', files, inplace, output: inplace ? null : output ?? '{stem}.nbconvert' };
    return { action: 'error', message: `jupyter nbconvert: this computer converts with --to script, or --to notebook --execute${to ? ` (got --to ${to})` : ''}` };
  }
  if (/\.ipynb$/i.test(sub)) return { action: 'open', path: sub };
  return { action: 'error', message: `jupyter: ${sub} is not a command here. Try: jupyter notebook FILE.ipynb` };
}
