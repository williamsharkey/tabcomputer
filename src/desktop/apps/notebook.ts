/**
 * Notebook: open, edit and run a Jupyter notebook (.ipynb) on the desktop.
 * Cells run in one Python per notebook (src/notebook/kernel.ts: Pyodide in a
 * Worker, as a kernel process on the tab's own files), and the file is read
 * and written in nbformat 4 (src/notebook/nbformat.ts), so git, GitHub and
 * Jupyter see an ordinary notebook. docs/NOTEBOOK.md has what it does and
 * what Jupyter does that it does not.
 *
 * Opened by the dock, `jupyter notebook FILE`, a double-click on a .ipynb in
 * Files, `code FILE.ipynb`, and a lab whose config names a notebook.
 */
import type { AppContext } from '../index';
import type { DesktopWindow } from '../wm';
import { NotebookKernel, kernelUnavailable } from '../../notebook/kernel';
import { isEmptyCell } from '../../notebook/magics';
import { escapeHtml, highlightPython, markdownToHtml } from '../../notebook/markup';
import {
  NotebookFormatError, OutputList, ansiSpans, newCell, newNotebook, notebookLanguage, parseNotebook, pickMime, serializeNotebook, stampKernel,
  unsupportedNote, type KernelOutput, type MimeBundle, type NbCell, type NbOutput, type Notebook,
} from '../../notebook/nbformat';
import { sanitizeHtml } from '../../notebook/sanitize';

const HOME = '/home/user';

const CSS = `
.nb-app { font-size: 13px; }
.nb-app .sd-toolbar { flex-wrap: wrap; row-gap: 6px; }
.nb-sep { width: 1px; height: 18px; background: var(--sd-sep); margin: 0 3px; }
.nb-status { margin-left: auto; display: flex; align-items: center; gap: 7px; color: var(--sd-text-2); font-size: 12px; white-space: nowrap; }
.nb-status .sd-dot { background: #9aa0ae; }
.nb-status[data-state='idle'] .sd-dot { background: #36c26e; }
.nb-status[data-state='busy'] .sd-dot, .nb-status[data-state='starting'] .sd-dot { background: #f2b53a; animation: nb-pulse 1s ease-in-out infinite; }
.nb-status[data-state='dead'] .sd-dot { background: #e5484d; }
@keyframes nb-pulse { 50% { opacity: .35; } }
.nb-notice { display: flex; align-items: center; gap: 10px; padding: 7px 14px; border-bottom: 1px solid var(--sd-sep); background: color-mix(in srgb, #f2b53a 14%, var(--sd-window)); font-size: 12.5px; }
.nb-notice span { flex: 1; min-width: 0; }
.nb-cells { flex: 1; min-height: 0; overflow: auto; padding: 14px 16px 60vh 6px; }
.nb-cell { display: flex; align-items: flex-start; gap: 4px; position: relative; padding: 4px 4px 4px 0; border-left: 3px solid transparent; border-radius: 3px; outline: none; }
.nb-cell.nb-selected { border-left-color: var(--sd-accent); }
.nb-gutter { flex: 0 0 62px; display: flex; align-items: center; justify-content: flex-end; gap: 2px; padding-top: 5px; font: 12px var(--sd-mono); color: var(--sd-text-3, var(--sd-text-2)); user-select: none; -webkit-user-select: none; }
.nb-run { width: 22px; height: 22px; border: 0; border-radius: 5px; background: transparent; color: var(--sd-text-2); cursor: default; visibility: hidden; padding: 0; font-size: 11px; }
.nb-cell:hover .nb-run, .nb-cell.nb-selected .nb-run { visibility: visible; }
.nb-run:hover { background: var(--sd-hover); color: var(--sd-accent); }
.nb-cell.nb-busy .nb-count { color: var(--sd-accent); }
.nb-main { flex: 1; min-width: 0; }
.nb-editor { position: relative; border: 1px solid var(--sd-window-border); border-radius: 6px; background: var(--sd-field); overflow: hidden; }
.nb-cell.nb-selected .nb-editor { border-color: color-mix(in srgb, var(--sd-accent) 55%, var(--sd-window-border)); }
.nb-editor pre, .nb-editor textarea { margin: 0; padding: 7px 10px; font: 13px/1.5 var(--sd-mono); tab-size: 4; white-space: pre; letter-spacing: 0; border: 0; }
.nb-editor pre { position: absolute; inset: 0; overflow: hidden; pointer-events: none; color: var(--sd-text); }
.nb-editor textarea { position: relative; display: block; width: 100%; box-sizing: border-box; resize: none; outline: none; overflow-x: auto; overflow-y: hidden; background: transparent; color: transparent; caret-color: var(--sd-text); }
.nb-editor textarea::selection { background: color-mix(in srgb, var(--sd-accent) 35%, transparent); }
.nb-md-edit textarea { color: var(--sd-text); white-space: pre-wrap; overflow-wrap: anywhere; }
.nb-c { color: #8a8f9c; font-style: italic; } .nb-s { color: #b5532f; } .nb-n { color: #0a7f5a; } .nb-k { color: #7a3fd0; font-weight: 600; }
.nb-o { color: #0b62c4; } .nb-b { color: #0b62c4; } .nb-f { color: #b0660a; } .nb-d { color: #9a5b00; } .nb-m { color: #0a7f5a; font-weight: 600; }
.sd-desktop[data-theme='dark'] .nb-s { color: #f0a078; } .sd-desktop[data-theme='dark'] .nb-n { color: #7fdcb4; } .sd-desktop[data-theme='dark'] .nb-k { color: #c3a6ff; }
.sd-desktop[data-theme='dark'] .nb-o, .sd-desktop[data-theme='dark'] .nb-b { color: #7db8ff; } .sd-desktop[data-theme='dark'] .nb-f { color: #f2c779; }
.sd-desktop[data-theme='dark'] .nb-d { color: #e6c07b; } .sd-desktop[data-theme='dark'] .nb-m { color: #7fdcb4; }
.nb-outputs { margin-top: 4px; }
.nb-outputs:empty { display: none; }
.nb-out { padding: 3px 10px; overflow-x: auto; }
.nb-out pre { margin: 0; font: 12.5px/1.45 var(--sd-mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.nb-out.nb-long { max-height: 420px; overflow-y: auto; }
.nb-stderr { background: color-mix(in srgb, #e5484d 10%, transparent); border-radius: 4px; }
.nb-error { background: color-mix(in srgb, #e5484d 13%, transparent); border-radius: 4px; padding: 7px 10px; }
.nb-out img { max-width: 100%; height: auto; background: #fff; border-radius: 3px; }
.nb-note { color: var(--sd-text-2); font-style: italic; }
.nb-html, .nb-md { line-height: 1.5; overflow-wrap: anywhere; }
.nb-md { padding: 4px 10px; font-size: 14px; min-height: 22px; }
.nb-md.nb-empty { color: var(--sd-text-2); font-style: italic; }
.nb-md h1 { font-size: 24px; margin: 10px 0 8px; } .nb-md h2 { font-size: 20px; margin: 10px 0 6px; } .nb-md h3 { font-size: 16.5px; margin: 8px 0 5px; }
.nb-md h4, .nb-md h5, .nb-md h6 { font-size: 14px; margin: 8px 0 4px; }
.nb-md p, .nb-html p { margin: 6px 0; } .nb-md ul, .nb-md ol, .nb-html ul, .nb-html ol { margin: 6px 0; padding-left: 26px; }
.nb-md code, .nb-html code { font: 12.5px var(--sd-mono); background: var(--sd-field); padding: 1px 4px; border-radius: 4px; }
.nb-md pre, .nb-html pre { font: 12.5px/1.45 var(--sd-mono); background: var(--sd-field); padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
.nb-md pre code, .nb-html pre code { background: none; padding: 0; }
.nb-md blockquote { margin: 6px 0; padding: 2px 12px; border-left: 3px solid var(--sd-sep); color: var(--sd-text-2); }
.nb-md a, .nb-html a { color: var(--sd-accent); } .sd-desktop[data-theme='dark'] .nb-md a, .sd-desktop[data-theme='dark'] .nb-html a { color: #a9a6ff; }
.nb-md hr { border: 0; border-top: 1px solid var(--sd-sep); margin: 10px 0; }
.nb-md img { max-width: 100%; }
.nb-md table, .nb-html table { border-collapse: collapse; font-size: 12.5px; margin: 6px 0; font-variant-numeric: tabular-nums; }
.nb-md th, .nb-md td, .nb-html th, .nb-html td { padding: 4px 9px; text-align: right; border: 0; white-space: nowrap; max-width: 420px; overflow: hidden; text-overflow: ellipsis; }
.nb-md th, .nb-md td { text-align: left; white-space: normal; }
.nb-md thead th, .nb-html thead th { border-bottom: 1px solid var(--sd-text-2); font-weight: 600; }
.nb-html tbody th { font-weight: 600; }
.nb-md tbody tr:nth-child(odd), .nb-html tbody tr:nth-child(odd) { background: var(--sd-hover); }
.nb-html tbody tr:hover { background: var(--sd-active, var(--sd-hover)); }
.nb-stdin { display: flex; align-items: center; gap: 8px; padding: 4px 10px; }
.nb-stdin label { font: 12.5px var(--sd-mono); white-space: pre-wrap; }
.nb-stdin input { flex: 1; min-width: 80px; max-width: 420px; height: 26px; }
.nb-tools { position: absolute; top: -9px; right: 10px; display: none; gap: 2px; padding: 2px; border-radius: 7px; background: var(--sd-window); border: 1px solid var(--sd-window-border); box-shadow: var(--sd-shadow-blur); z-index: 2; }
.nb-cell.nb-selected .nb-tools { display: flex; }
.nb-tools button { height: 22px; min-width: 24px; padding: 0 6px; border: 0; border-radius: 5px; background: transparent; color: var(--sd-text-2); font: inherit; font-size: 12px; cursor: default; }
.nb-tools button:hover { background: var(--sd-hover); color: var(--sd-text); }
.nb-list { flex: 1; min-height: 0; overflow: auto; padding: 6px 14px 14px; }
.nb-list button.nb-item { display: flex; width: 100%; gap: 12px; align-items: baseline; padding: 7px 10px; border: 0; border-radius: 7px; background: transparent; color: var(--sd-text); font: inherit; text-align: left; cursor: default; }
.nb-list button.nb-item:hover { background: var(--sd-hover); }
.nb-item b { font-weight: 600; } .nb-item span { color: var(--sd-text-2); font-size: 12px; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nb-empty-list { padding: 30px 14px; color: var(--sd-text-2); }
`;

function injectStyle(): void {
  if (document.getElementById('sd-nb-style')) return;
  const st = document.createElement('style');
  st.id = 'sd-nb-style';
  st.textContent = CSS;
  document.head.append(st);
}

/** Notebook windows by their file: opening one twice shows the window that has it */
const openWindows = new Map<string, DesktopWindow>();

const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/';
const baseOf = (path: string) => path.slice(path.lastIndexOf('/') + 1) || path;
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' };

// ── The list of notebooks ──

const SKIP_DIRS = new Set(['node_modules', '__pycache__', 'site-packages', 'venv', 'dist', 'build', 'Apps']);

async function findNotebooks(ctx: AppContext, root: string): Promise<{ path: string; mtime: number }[]> {
  const found: { path: string; mtime: number }[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (visited++ > 400 || found.length >= 200) return;
    let names: string[];
    try { names = await ctx.fs.readdir(dir); } catch { return; }
    for (const name of names.sort()) {
      if (name.startsWith('.') || SKIP_DIRS.has(name)) continue;
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      try {
        const st = await ctx.fs.stat(path);
        if (st.isDirectory()) { if (depth < 4) await walk(path, depth + 1); }
        else if (/\.ipynb$/i.test(name)) found.push({ path, mtime: st.mtime.getTime() });
      } catch { /* gone meanwhile */ }
    }
  };
  await walk(root, 0);
  return found.sort((a, b) => b.mtime - a.mtime);
}

async function freshName(ctx: AppContext, dir: string): Promise<string> {
  for (let i = 0; ; i++) {
    const path = `${dir === '/' ? '' : dir}/Untitled${i || ''}.ipynb`;
    if (!(await ctx.fs.exists(path).catch(() => false))) return path;
  }
}

function openChooser(ctx: AppContext, dir: string): DesktopWindow {
  const root = document.createElement('div');
  root.className = 'sd-app nb-app';
  root.innerHTML = `
    <div class="sd-toolbar"><div class="sd-path"></div><button class="sd-btn sd-primary" data-act="new">New Notebook</button></div>
    <div class="nb-list"></div>`;
  root.querySelector<HTMLElement>('.sd-path')!.textContent = `Notebooks in ${dir.replace(HOME, '~')}`;
  const list = root.querySelector<HTMLElement>('.nb-list')!;
  const win = ctx.wm.createWindow({ appId: 'notebook', title: 'Notebooks', width: 560, height: 420, minWidth: 300, minHeight: 200, content: { kind: 'dom', element: root } });
  (win as { restoreCommand?: { cmd: string; cwd: string } }).restoreCommand = { cmd: `jupyter notebook ${shq(dir)}`, cwd: dir };
  const pick = async (path: string) => {
    const w = await openEditor(ctx, path);
    if (w) win.close(true);
  };
  root.querySelector<HTMLButtonElement>('[data-act=new]')!.addEventListener('click', () => { void freshName(ctx, dir).then(pick); });
  const fmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  void findNotebooks(ctx, dir).then((found) => {
    if (!found.length) {
      list.innerHTML = '<div class="nb-empty-list">This folder has no notebooks yet. New Notebook makes one here.</div>';
      return;
    }
    for (const f of found) {
      const b = document.createElement('button');
      b.className = 'nb-item';
      b.dataset.path = f.path;
      const rel = f.path.startsWith(`${dir}/`) ? f.path.slice(dir.length + 1) : f.path;
      b.innerHTML = `<b></b><span></span><span style="flex:none"></span>`;
      b.children[0].textContent = baseOf(rel);
      b.children[1].textContent = rel.includes('/') ? dirOf(rel) : '';
      b.children[2].textContent = fmt.format(f.mtime);
      b.addEventListener('click', () => { void pick(f.path); });
      list.append(b);
    }
  });
  return win;
}

// ── A notebook ──

interface CellView {
  cell: NbCell;
  el: HTMLElement;
  outputs: OutputList;
  /** The nodes drawn for the outputs, and what each was drawn from */
  drawn: { output: NbOutput; key: unknown; node: HTMLElement }[];
  textarea: HTMLTextAreaElement | null;
  /** A Markdown cell being edited */
  editing: boolean;
  /** Waiting to run, or running */
  busy: boolean;
  redraw: number;
}

async function openEditor(ctx: AppContext, path: string): Promise<DesktopWindow | null> {
  const { wm, fs } = ctx;
  const existing = openWindows.get(path);
  if (existing && existing.state !== 'closed') { existing.focus(); return existing; }
  const name = baseOf(path);
  const dir = dirOf(path);

  let nb: Notebook;
  let savedText = '';
  let problem = '';
  let isNew = false;
  try {
    savedText = await fs.readFile(path, 'utf8') as string;
    nb = parseNotebook(savedText);
  } catch (e) {
    if (e instanceof NotebookFormatError) problem = e.message;
    else if (await fs.exists(path).catch(() => false)) problem = `The file could not be read: ${(e as Error)?.message ?? e}`;
    else isNew = true;
    nb = newNotebook();
  }

  const root = document.createElement('div');
  root.className = 'sd-app nb-app';
  if (problem) {
    root.innerHTML = '<div class="sd-panel"><h2></h2><p class="sd-muted"></p></div>';
    root.querySelector('h2')!.textContent = name;
    root.querySelector('p')!.textContent = problem;
    return wm.createWindow({ appId: 'notebook', title: name, width: 520, height: 240, content: { kind: 'dom', element: root } });
  }
  if (isNew) {
    savedText = serializeNotebook(nb);
    try { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path, savedText); } catch { /* the first Save says why */ }
  }

  root.innerHTML = `
    <div class="sd-toolbar">
      <button class="sd-btn" data-act="save" title="Save (Ctrl+S)">Save</button>
      <span class="nb-sep"></span>
      <button class="sd-btn" data-act="add-code" title="Add a code cell below">+ Code</button>
      <button class="sd-btn" data-act="add-text" title="Add a text cell below">+ Text</button>
      <span class="nb-sep"></span>
      <button class="sd-btn sd-primary" data-act="run" title="Run the selected cell (Shift+Enter)">Run</button>
      <button class="sd-btn" data-act="run-all" title="Run every cell, top to bottom">Run All</button>
      <button class="sd-btn" data-act="stop" title="Stop the running cell" disabled>Stop</button>
      <button class="sd-btn" data-act="restart" title="Start Python again. Variables are cleared.">Restart</button>
      <div class="nb-status" data-state="dead"><span class="sd-dot"></span><span class="nb-status-text"></span></div>
    </div>
    <div class="nb-notices"></div>
    <div class="nb-cells"></div>`;
  const cellsEl = root.querySelector<HTMLElement>('.nb-cells')!;
  const noticesEl = root.querySelector<HTMLElement>('.nb-notices')!;
  const statusEl = root.querySelector<HTMLElement>('.nb-status')!;
  const statusText = root.querySelector<HTMLElement>('.nb-status-text')!;
  const button = (act: string) => root.querySelector<HTMLButtonElement>(`[data-act=${act}]`)!;

  let dirty = false;
  let closed = false;
  let ranHere = false;
  let saving: Promise<boolean> = Promise.resolve(true);
  let autosave: ReturnType<typeof setTimeout> | null = null;
  const views: CellView[] = [];
  let selected: CellView | null = null;
  const runQueue: CellView[] = [];
  let pumping = false;
  const blobUrls: string[] = [];

  const win = wm.createWindow({
    appId: 'notebook', title: name, width: 880, height: 660, minWidth: 340, minHeight: 240,
    content: { kind: 'dom', element: root },
    // Closing saves: a notebook's edits and outputs are never lost to a closed window
    onClose: () => {
      if (!dirty || closed) return;
      void save().then((ok) => { if (ok) win.close(true); });
      return false;
    },
  });
  openWindows.set(path, win);
  (win as { restoreCommand?: { cmd: string; cwd: string } }).restoreCommand = { cmd: `jupyter notebook ${shq(path)}`, cwd: dir };

  // ── Notices ──
  const notice = (id: string, text: string, actions: { label: string; run: () => void }[] = []) => {
    noticesEl.querySelector(`[data-notice="${id}"]`)?.remove();
    if (!text) return;
    const bar = document.createElement('div');
    bar.className = 'nb-notice';
    bar.dataset.notice = id;
    const span = document.createElement('span');
    span.textContent = text;
    bar.append(span);
    for (const a of actions) {
      const b = document.createElement('button');
      b.className = 'sd-btn';
      b.textContent = a.label;
      b.addEventListener('click', () => { notice(id, ''); a.run(); });
      bar.append(b);
    }
    noticesEl.append(bar);
  };

  // ── Saving ──
  const setDirty = (on: boolean) => {
    if (on !== dirty) { dirty = on; win.setTitle(on ? `${name} — Edited` : name); }
    if (autosave) clearTimeout(autosave);
    autosave = on && !closed ? setTimeout(() => { void save(); }, 20_000) : null;
  };
  const touch = () => setDirty(true);
  const sync = () => {
    nb.cells = views.map((v) => {
      if (v.textarea) v.cell.source = v.textarea.value;
      if (v.cell.cell_type === 'code') v.cell.outputs = v.outputs.outputs;
      return v.cell;
    });
  };
  function save(): Promise<boolean> {
    saving = saving.then(async () => {
      sync();
      if (ranHere && kernel.python) stampKernel(nb, kernel.python);
      const text = serializeNotebook(nb);
      try {
        await fs.writeFile(path, text);
        savedText = text;
        setDirty(false);
        notice('save', '');
        return true;
      } catch (e) {
        notice('save', `The notebook was not saved: ${(e as Error)?.message ?? e}`, [{ label: 'Try Again', run: () => { void save(); } }]);
        return false;
      }
    });
    return saving;
  }

  // The file changed under the window (git checkout, another program): show the new one, or ask when there are edits here
  const reload = async () => {
    let text: string;
    try { text = await fs.readFile(path, 'utf8') as string; } catch { return; }
    if (text === savedText || closed) return;
    const apply = () => {
      try { nb = parseNotebook(text); } catch { return; }
      savedText = text;
      build();
      setDirty(false);
    };
    if (!dirty) apply();
    else notice('changed', `${name} changed on this computer while it was open here.`, [{ label: 'Show the New File', run: apply }, { label: 'Keep Mine', run: () => {} }]);
  };
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;
  const unwatch = fs.onChange((_ev: unknown, p: string) => {
    if (p !== path) return;
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => { void saving.then(reload); }, 300);
  });

  // ── Python ──
  const kernel = new NotebookKernel({ kernel: ctx.kernel, fs, shell: ctx.shell, cwd: dir, name });
  const unavailable = kernelUnavailable();
  const language = notebookLanguage(nb);
  const showStatus = () => {
    const running = kernel.state === 'busy';
    const text = unavailable ? 'Python cannot run here'
      : kernel.statusText && kernel.state !== 'dead' ? `Python: ${kernel.statusText.replace(/^Loading /, 'loading ')}`
      : kernel.state === 'starting' ? 'Python is starting'
      : running ? 'Python is running a cell'
      : kernel.state === 'idle' ? 'Python is ready'
      : 'Python is stopped';
    statusEl.dataset.state = kernel.statusText && kernel.state === 'idle' ? 'starting' : kernel.state;
    statusText.textContent = text;
    button('stop').disabled = !running;
    if (kernel.state === 'idle' && !unavailable) notice('python', '');
    if (kernel.state === 'dead' && kernel.lastError && !closed) {
      notice('python', `Python stopped: ${kernel.lastError.trim().split('\n').pop()}`, [{ label: 'Start Python Again', run: () => { kernel.restart(); } }]);
    }
  };
  kernel.onChange(showStatus);
  if (unavailable) notice('python', unavailable);
  if (language !== 'python') notice('language', `This notebook is written in ${language}. This computer runs notebooks in Python, so its cells may not run.`);

  /** The import lines of every code cell: what Python fetches before the first run */
  const importLines = () => views.filter((v) => v.cell.cell_type === 'code').flatMap((v) => (v.textarea?.value ?? v.cell.source).split('\n').filter((l) => /^\s*(import|from)\s+[\w.]+/.test(l)).map((l) => l.trim())).join('\n');
  const startPython = () => {
    if (unavailable || closed) return;
    kernel.start();
    const imports = importLines();
    if (imports) void kernel.preload(imports);
  };

  // ── Outputs ──
  const resolveImage = (cell: NbCell | null) => (img: HTMLImageElement, src: string) => {
    const att = /^attachment:(.+)$/i.exec(src);
    if (att) {
      const bundle = cell?.attachments?.[decodeURIComponent(att[1])];
      const mime = bundle ? Object.keys(bundle).find((m) => m.startsWith('image/')) : undefined;
      if (!bundle || !mime || typeof bundle[mime] !== 'string') return false;
      img.src = `data:${mime};base64,${String(bundle[mime]).replace(/\s+/g, '')}`;
      return true;
    }
    const type = IMAGE_TYPES[src.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? ''];
    if (!type) return false;
    let file: string;
    try { file = fs.resolvePath(decodeURIComponent(src.split(/[?#]/)[0]), dir); } catch { return false; }
    void (fs.readFile(file) as Promise<Uint8Array>).then((data) => {
      // (an SVG file is shown as an image: nothing in it runs)
      const url = URL.createObjectURL(new Blob([data.slice()], { type }));
      blobUrls.push(url);
      img.src = url;
    }).catch(() => {});
    return true;
  };

  const textNode = (text: string, cls: string): HTMLElement => {
    const box = document.createElement('div');
    box.className = `nb-out ${cls}`;
    const pre = document.createElement('pre');
    if (text.includes('\x1b')) {
      for (const s of ansiSpans(text)) {
        if (!s.fg && !s.bg && !s.bold) { pre.append(s.text); continue; }
        const span = document.createElement('span');
        span.textContent = s.text;
        if (s.fg) span.style.color = s.fg;
        if (s.bg) span.style.backgroundColor = s.bg;
        if (s.bold) span.style.fontWeight = '600';
        pre.append(span);
      }
    } else {
      pre.textContent = text;
    }
    box.append(pre);
    if (text.length > 4000 || text.split('\n').length > 28) box.classList.add('nb-long');
    return box;
  };

  const bundleNode = (data: MimeBundle, metadata: Record<string, unknown>, cell: NbCell): HTMLElement => {
    const mime = pickMime(data);
    const box = document.createElement('div');
    box.className = 'nb-out';
    const value = mime ? data[mime] : undefined;
    if (!mime) {
      box.classList.add('nb-note');
      box.textContent = unsupportedNote(data);
    } else if (mime === 'text/html') {
      box.classList.add('nb-html');
      box.append(sanitizeHtml(String(value), { image: resolveImage(cell) }));
      // (HTML that was only a script, a frame or a widget: say so, or show its text form)
      if (!box.textContent?.trim() && !box.querySelector('img, hr, table')) {
        box.className = 'nb-out';
        if (typeof data['text/plain'] === 'string' && !/^<IPython|^<pandas/.test(data['text/plain'])) return textNode(data['text/plain'], '');
        box.classList.add('nb-note');
        box.textContent = 'This output needs JavaScript. It is not shown in this notebook.';
      }
    } else if (mime.startsWith('image/')) {
      const img = document.createElement('img');
      const text = String(value);
      img.src = mime === 'image/svg+xml' ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(text)}` : `data:${mime};base64,${text.replace(/\s+/g, '')}`;
      img.alt = typeof data['text/plain'] === 'string' ? data['text/plain'] : 'Output image';
      const m = metadata?.[mime] as { width?: number; height?: number } | undefined;
      if (m && Number(m.width) > 0) img.style.width = `${Number(m.width)}px`;
      box.append(img);
    } else if (mime === 'text/markdown') {
      box.classList.add('nb-md');
      box.append(sanitizeHtml(markdownToHtml(String(value)), { image: resolveImage(cell) }));
    } else if (mime === 'application/json') {
      return textNode(JSON.stringify(value, null, 2), '');
    } else {
      return textNode(String(value), '');
    }
    return box;
  };

  const outputNode = (o: NbOutput, cell: NbCell): HTMLElement => {
    if (o.output_type === 'stream') return textNode(o.text, o.name === 'stderr' ? 'nb-stderr' : '');
    if (o.output_type === 'error') {
      const text = o.traceback.length ? o.traceback.join('\n') : `${o.ename}: ${o.evalue}`;
      const node = textNode(text, 'nb-error');
      node.dataset.error = o.ename;
      return node;
    }
    return bundleNode(o.data, o.metadata, cell);
  };
  const outputKey = (o: NbOutput): unknown => (o.output_type === 'stream' ? o.text : o.output_type === 'error' ? o.traceback : o.data);

  /** Draw what changed of a cell's outputs: a stream that grew is one node updated */
  const drawOutputs = (v: CellView) => {
    const box = v.el.querySelector<HTMLElement>('.nb-outputs');
    if (!box) return;
    const outs = v.outputs.outputs;
    const next: CellView['drawn'] = [];
    outs.forEach((o, i) => {
      const old = v.drawn[i];
      const key = outputKey(o);
      if (old && old.output === o && old.key === key) { next.push(old); return; }
      const node = outputNode(o, v.cell);
      const atEnd = old?.node.classList.contains('nb-long') && old.node.scrollTop + old.node.clientHeight >= old.node.scrollHeight - 4;
      if (old) old.node.replaceWith(node); else box.insertBefore(node, box.querySelector('.nb-stdin'));
      if (atEnd && node.classList.contains('nb-long')) node.scrollTop = node.scrollHeight;
      next.push({ output: o, key, node });
    });
    for (const old of v.drawn.slice(outs.length)) old.node.remove();
    v.drawn = next;
  };
  const scheduleDraw = (v: CellView) => {
    if (v.redraw) return;
    v.redraw = requestAnimationFrame(() => { v.redraw = 0; drawOutputs(v); });
  };

  const askInput = (v: CellView, prompt: string, password: boolean, signal: AbortSignal): Promise<string> => new Promise((resolve, reject) => {
    const box = v.el.querySelector<HTMLElement>('.nb-outputs')!;
    drawOutputs(v);
    const row = document.createElement('div');
    row.className = 'nb-stdin';
    const label = document.createElement('label');
    label.textContent = prompt;
    const input = document.createElement('input');
    input.className = 'sd-input';
    input.type = password ? 'password' : 'text';
    input.setAttribute('aria-label', prompt || 'Input for the running cell');
    input.autocomplete = 'off';
    row.append(label, input);
    box.append(row);
    input.focus();
    const done = () => { row.remove(); signal.removeEventListener('abort', onAbort); };
    const onAbort = () => { done(); reject(new Error('stopped')); };
    signal.addEventListener('abort', onAbort);
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const value = input.value;
      done();
      // (the answer is part of the cell's output, as in Jupyter; a password is not)
      v.outputs.apply({ t: 'stream', name: 'stdout', text: `${prompt}${password ? '········' : value}\n` });
      scheduleDraw(v);
      resolve(value);
    });
  });

  // ── Running ──
  const setCount = (v: CellView) => {
    const el = v.el.querySelector<HTMLElement>('.nb-count');
    if (el) el.textContent = v.busy ? '[*]' : `[${v.cell.execution_count ?? ' '}]`;
    v.el.classList.toggle('nb-busy', v.busy);
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (runQueue.length && !closed) {
        const v = runQueue[0];
        const source = v.textarea?.value ?? v.cell.source;
        v.cell.source = source;
        if (!views.includes(v)) { runQueue.shift(); continue; }
        v.outputs.clear();
        v.cell.execution_count = null;
        drawOutputs(v);
        if (isEmptyCell(source)) { runQueue.shift(); v.busy = false; setCount(v); continue; }
        ranHere = true;
        const result = await kernel.execute(source, {
          onOutput: (m: KernelOutput) => { if (v.outputs.apply(m)) scheduleDraw(v); },
          onInput: (prompt, password, signal) => askInput(v, prompt, password, signal),
        });
        v.busy = false;
        v.cell.execution_count = result.count || null;
        v.cell.outputs = v.outputs.outputs;
        drawOutputs(v);
        setCount(v);
        touch();
        if (runQueue[0] === v) runQueue.shift();
        // (a cell that failed, or a Python that stopped: the cells after it do not run)
        if (result.status !== 'ok') dropQueue();
      }
    } finally {
      pumping = false;
      // outputs are saved soon after a run, without being asked
      if (dirty && !closed) { if (autosave) clearTimeout(autosave); autosave = setTimeout(() => { void save(); }, 2500); }
    }
  };
  const dropQueue = () => {
    for (const v of runQueue.splice(0)) { v.busy = false; setCount(v); }
  };
  const enqueue = (list: CellView[]) => {
    if (unavailable) return;
    for (const v of list) {
      if (v.cell.cell_type !== 'code' || v.busy) continue;
      v.busy = true;
      setCount(v);
      runQueue.push(v);
    }
    void pump();
  };
  const runCell = (v: CellView) => {
    if (v.cell.cell_type === 'markdown') { stopEditing(v); return; }
    if (v.cell.cell_type === 'code') enqueue([v]);
  };

  // ── Cells ──
  const select = (v: CellView | null, focus: 'editor' | 'cell' | 'none' = 'none') => {
    if (selected !== v) {
      selected?.el.classList.remove('nb-selected');
      selected = v;
      v?.el.classList.add('nb-selected');
    }
    if (!v) return;
    if (focus === 'editor' && v.textarea) v.textarea.focus();
    else if (focus === 'editor' && v.cell.cell_type !== 'code') { startEditing(v); }
    else if (focus === 'cell') v.el.focus();
    if (focus !== 'none') v.el.scrollIntoView({ block: 'nearest' });
  };

  const fit = (ta: HTMLTextAreaElement, wrap: boolean) => {
    if (!wrap) { ta.rows = Math.max(1, ta.value.split('\n').length); return; }
    ta.style.height = 'auto';
    ta.style.height = `${Math.max(34, ta.scrollHeight)}px`;
  };

  const editorKeys = (v: CellView, ta: HTMLTextAreaElement, e: KeyboardEvent, code: boolean) => {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === 'Enter' && (e.shiftKey || mod || e.altKey)) {
      e.preventDefault();
      runCell(v);
      const i = views.indexOf(v);
      if (e.altKey) select(insertCell(i + 1, newCell('code')), 'editor');
      else if (e.shiftKey) select(views[i + 1] ?? insertCell(i + 1, newCell('code')), views[i + 1]?.cell.cell_type === 'code' || !views[i + 1] ? 'editor' : 'cell');
      return;
    }
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
    if (e.key === 'Escape') { e.preventDefault(); if (!code) stopEditing(v); select(v, 'cell'); return; }
    const { selectionStart: a, selectionEnd: b, value } = ta;
    if (e.key === 'ArrowUp' && a === b && !value.slice(0, a).includes('\n') && !e.shiftKey) {
      const prev = views[views.indexOf(v) - 1];
      if (prev) { e.preventDefault(); select(prev, prev.cell.cell_type === 'code' ? 'editor' : 'cell'); }
      return;
    }
    if (e.key === 'ArrowDown' && a === b && !value.slice(b).includes('\n') && !e.shiftKey) {
      const next = views[views.indexOf(v) + 1];
      if (next) { e.preventDefault(); select(next, next.cell.cell_type === 'code' ? 'editor' : 'cell'); }
      return;
    }
    if (!code) return;
    const edit = (text: string, from: number, to: number, caret: number, caretEnd = caret) => {
      // (through the browser's own editing, so Ctrl+Z undoes it)
      ta.setSelectionRange(from, to);
      if (!document.execCommand?.('insertText', false, text)) ta.setRangeText(text, from, to, 'end');
      ta.setSelectionRange(caret, caretEnd);
      ta.dispatchEvent(new Event('input'));
    };
    if (e.key === 'Tab' && !mod && !e.altKey) {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      if (a === b && !e.shiftKey) { const n = 4 - ((a - lineStart) % 4); edit(' '.repeat(n), a, b, a + n); return; }
      const block = value.slice(lineStart, b);
      const changed = block.split('\n').map((l) => (e.shiftKey ? l.replace(/^ {1,4}/, '') : l.trim() ? `    ${l}` : l)).join('\n');
      edit(changed, lineStart, b, lineStart, lineStart + changed.length);
      return;
    }
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const line = value.slice(value.lastIndexOf('\n', a - 1) + 1, a);
      let indent = /^[ \t]*/.exec(line)![0];
      if (/:\s*(#.*)?$/.test(line)) indent += '    ';
      else if (/^\s*(return|pass|break|continue|raise)\b/.test(line)) indent = indent.slice(0, Math.max(0, indent.length - 4));
      edit(`\n${indent}`, a, b, a + 1 + indent.length);
      return;
    }
    if (e.key === 'Backspace' && a === b && a > 0) {
      const lineStart = value.lastIndexOf('\n', a - 1) + 1;
      const before = value.slice(lineStart, a);
      if (before && /^ +$/.test(before)) {
        e.preventDefault();
        const n = before.length % 4 || 4;
        edit('', a - n, a, a - n);
      }
    }
  };

  const startEditing = (v: CellView) => {
    if (v.cell.cell_type === 'code' || v.editing) return;
    v.editing = true;
    drawBody(v);
    v.textarea?.focus();
  };
  const stopEditing = (v: CellView) => {
    if (v.cell.cell_type === 'code' || !v.editing) return;
    if (v.textarea) v.cell.source = v.textarea.value;
    v.editing = false;
    drawBody(v);
  };

  /** The editor and (for text) the rendered form of a cell */
  function drawBody(v: CellView): void {
    const main = v.el.querySelector<HTMLElement>('.nb-main')!;
    const code = v.cell.cell_type === 'code';
    main.querySelector('.nb-editor')?.remove();
    main.querySelector('.nb-md')?.remove();
    v.textarea = null;
    if (!code && !v.editing) {
      const md = document.createElement('div');
      md.className = 'nb-md';
      if (!v.cell.source.trim()) { md.classList.add('nb-empty'); md.textContent = 'Empty text cell. Double-click to write.'; }
      else if (v.cell.cell_type === 'raw') { const pre = document.createElement('pre'); pre.textContent = v.cell.source; md.append(pre); }
      else md.append(sanitizeHtml(markdownToHtml(v.cell.source), { image: resolveImage(v.cell) }));
      md.addEventListener('dblclick', () => startEditing(v));
      main.prepend(md);
      return;
    }
    const ed = document.createElement('div');
    ed.className = code ? 'nb-editor' : 'nb-editor nb-md-edit';
    const ta = document.createElement('textarea');
    ta.spellcheck = false;
    ta.autocapitalize = 'off';
    ta.setAttribute('autocorrect', 'off');
    ta.setAttribute('aria-label', code ? 'Code cell' : 'Text cell');
    ta.value = v.cell.source;
    let pre: HTMLPreElement | null = null;
    if (code) {
      ta.wrap = 'off';
      pre = document.createElement('pre');
      pre.setAttribute('aria-hidden', 'true');
      ed.append(pre);
    }
    ed.append(ta);
    const paint = () => {
      // (the last line break needs something after it to take a line in the <pre>)
      if (pre) pre.innerHTML = language === 'python' ? `${highlightPython(ta.value)}\n` : `${escapeHtml(ta.value)}\n`;
      fit(ta, !code);
    };
    ta.addEventListener('input', () => { v.cell.source = ta.value; paint(); touch(); });
    ta.addEventListener('scroll', () => { if (pre) pre.scrollLeft = ta.scrollLeft; });
    ta.addEventListener('focus', () => select(v));
    ta.addEventListener('keydown', (e) => editorKeys(v, ta, e, code));
    if (!code) ta.addEventListener('blur', () => { setTimeout(() => { if (document.activeElement !== ta && views.includes(v)) stopEditing(v); }, 120); });
    v.textarea = ta;
    main.prepend(ed);
    paint();
    if (!code) requestAnimationFrame(() => fit(ta, true));
  }

  function makeView(cell: NbCell): CellView {
    const el = document.createElement('div');
    const code = cell.cell_type === 'code';
    el.className = `nb-cell ${code ? 'nb-code' : 'nb-text'}`;
    el.tabIndex = -1;
    el.innerHTML = `
      <div class="nb-gutter">${code ? '<button class="nb-run" title="Run this cell" aria-label="Run this cell">&#9654;</button><span class="nb-count"></span>' : ''}</div>
      <div class="nb-main">${code ? '<div class="nb-outputs"></div>' : ''}</div>
      <div class="nb-tools">
        <button data-tool="type" title="${code ? 'Make this a text cell' : 'Make this a code cell'}">${code ? 'Code' : 'Text'}</button>
        <button data-tool="up" title="Move up" aria-label="Move up">&uarr;</button>
        <button data-tool="down" title="Move down" aria-label="Move down">&darr;</button>
        ${code ? '<button data-tool="clear" title="Clear this cell\'s output">Clear</button>' : ''}
        <button data-tool="delete" title="Delete this cell" aria-label="Delete this cell">&#10005;</button>
      </div>`;
    const v: CellView = { cell, el, outputs: new OutputList(code ? cell.outputs ?? [] : []), drawn: [], textarea: null, editing: false, busy: false, redraw: 0 };
    drawBody(v);
    if (code) { setCount(v); drawOutputs(v); }
    el.addEventListener('mousedown', () => select(v));
    el.querySelector('.nb-run')?.addEventListener('click', () => runCell(v));
    el.querySelector('.nb-tools')!.addEventListener('click', (e) => {
      const tool = (e.target as HTMLElement).closest<HTMLElement>('[data-tool]')?.dataset.tool;
      const i = views.indexOf(v);
      if (tool === 'delete') removeCell(v);
      else if (tool === 'up' && i > 0) moveCell(v, i - 1);
      else if (tool === 'down' && i < views.length - 1) moveCell(v, i + 1);
      else if (tool === 'clear') { v.outputs.clear(); v.cell.execution_count = null; drawOutputs(v); setCount(v); touch(); }
      else if (tool === 'type') setType(v, code ? 'markdown' : 'code');
    });
    el.addEventListener('keydown', (e) => { if (e.target === el) commandKeys(v, e); });
    return v;
  }

  function insertCell(at: number, cell: NbCell): CellView {
    const v = makeView(cell);
    const before = views[at];
    views.splice(at, 0, v);
    cellsEl.insertBefore(v.el, before?.el ?? null);
    touch();
    return v;
  }
  function removeCell(v: CellView): void {
    const i = views.indexOf(v);
    if (i < 0) return;
    views.splice(i, 1);
    v.el.remove();
    if (!views.length) insertCell(0, newCell('code'));
    select(views[Math.min(i, views.length - 1)], 'cell');
    touch();
  }
  function moveCell(v: CellView, to: number): void {
    const i = views.indexOf(v);
    views.splice(i, 1);
    views.splice(to, 0, v);
    cellsEl.insertBefore(v.el, views[to + 1]?.el ?? null);
    v.el.scrollIntoView({ block: 'nearest' });
    touch();
  }
  function setType(v: CellView, type: 'code' | 'markdown'): void {
    const i = views.indexOf(v);
    if (i < 0 || v.cell.cell_type === type || v.busy) return;
    const source = v.textarea?.value ?? v.cell.source;
    const cell = newCell(type, source);
    if (v.cell.id) cell.id = v.cell.id;
    const next = makeView(cell);
    views[i] = next;
    v.el.replaceWith(next.el);
    select(next, type === 'code' ? 'editor' : 'cell');
    touch();
  }

  let lastD = 0;
  const commandKeys = (v: CellView, e: KeyboardEvent) => {
    const mod = e.ctrlKey || e.metaKey;
    const i = views.indexOf(v);
    const key = e.key;
    if (mod && key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
    if (mod || e.altKey) return;
    if (key === 'Enter' && e.shiftKey) { e.preventDefault(); runCell(v); select(views[i + 1] ?? v, 'cell'); return; }
    if (key === 'Enter') { e.preventDefault(); select(v, 'editor'); return; }
    if (key === 'ArrowUp' || key === 'k') { e.preventDefault(); if (views[i - 1]) select(views[i - 1], 'cell'); return; }
    if (key === 'ArrowDown' || key === 'j') { e.preventDefault(); if (views[i + 1]) select(views[i + 1], 'cell'); return; }
    if (key === 'a') { e.preventDefault(); select(insertCell(i, newCell('code')), 'cell'); return; }
    if (key === 'b') { e.preventDefault(); select(insertCell(i + 1, newCell('code')), 'cell'); return; }
    if (key === 'm') { e.preventDefault(); setType(v, 'markdown'); return; }
    if (key === 'y') { e.preventDefault(); setType(v, 'code'); return; }
    if (key === 'd') {
      const now = Date.now();
      if (now - lastD < 600) { e.preventDefault(); removeCell(v); lastD = 0; } else lastD = now;
    }
  };

  /** Draw the whole notebook (at open, and when the file changed under it) */
  function build(): void {
    dropQueue();
    views.length = 0;
    selected = null;
    cellsEl.textContent = '';
    if (!nb.cells.length) nb.cells.push(newCell('code'));
    for (const cell of nb.cells) {
      const v = makeView(cell);
      views.push(v);
      cellsEl.append(v.el);
    }
    select(views[0]);
  }
  build();

  // ── The toolbar ──
  const addBelow = (type: 'code' | 'markdown') => {
    const at = selected ? views.indexOf(selected) + 1 : views.length;
    const v = insertCell(at, newCell(type));
    select(v, 'editor');
  };
  button('save').addEventListener('click', () => { void save(); });
  button('add-code').addEventListener('click', () => addBelow('code'));
  button('add-text').addEventListener('click', () => addBelow('markdown'));
  button('run').addEventListener('click', () => {
    if (!selected) return;
    const i = views.indexOf(selected);
    runCell(selected);
    if (views[i + 1]) select(views[i + 1], 'cell');
  });
  button('run-all').addEventListener('click', () => {
    for (const v of views) stopEditing(v);
    enqueue(views);
  });
  let stuckTimer: ReturnType<typeof setTimeout> | null = null;
  button('stop').addEventListener('click', () => {
    dropQueue();
    kernel.interrupt();
    // Python takes an interrupt between two of its own steps: one long call into compiled code does not see it
    if (stuckTimer) clearTimeout(stuckTimer);
    stuckTimer = setTimeout(() => {
      if (closed || kernel.state !== 'busy') return;
      notice('python', 'The cell has not stopped. Restart ends it and clears the variables.', [{ label: 'Restart', run: () => button('restart').click() }]);
    }, 4000);
  });
  button('restart').addEventListener('click', () => {
    dropQueue();
    notice('python', unavailable);
    kernel.restart();
    const imports = importLines();
    if (imports) void kernel.preload(imports);
  });
  if (unavailable) for (const act of ['run', 'run-all', 'restart']) button(act).disabled = true;
  root.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); void save(); }
  });

  win.on('close', () => {
    closed = true;
    if (openWindows.get(path) === win) openWindows.delete(path);
    if (autosave) clearTimeout(autosave);
    if (reloadTimer) clearTimeout(reloadTimer);
    if (stuckTimer) clearTimeout(stuckTimer);
    unwatch();
    kernel.shutdown();
    for (const url of blobUrls) URL.revokeObjectURL(url);
  });

  // For tests and the console: the notebook behind a window
  (win as { notebook?: unknown }).notebook = {
    path, kernel,
    cells: () => { sync(); return nb.cells; },
    dirty: () => dirty,
    save,
    runAll: () => { enqueue(views); },
    idle: () => !pumping && !runQueue.length,
  };

  showStatus();
  startPython();
  return win;
}

/** `args.path`: a notebook to open, or a folder to list. Without one, the notebooks under the home folder. */
export async function open(ctx: AppContext, args?: Record<string, unknown>): Promise<DesktopWindow | null> {
  injectStyle();
  const path = typeof args?.path === 'string' && args.path ? args.path : '';
  if (!path) return openChooser(ctx, HOME);
  let isDir = false;
  try { isDir = (await ctx.fs.stat(path)).isDirectory(); } catch { /* a new notebook */ }
  if (isDir) return openChooser(ctx, path);
  return openEditor(ctx, path);
}
