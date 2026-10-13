/**
 * code - Rich code editor powered by CodeMirror 6
 *
 *   code file.js           # Open a file
 *   code src/              # Open directory with file tree
 *   code                   # Open editor in cwd
 */

import { Command, CommandContext } from './index';
import { createServerWindow, commandLine } from '../server-window';
import { noteEdited } from '../session-log';

const CM_CDN = 'https://esm.sh';

/** A desktop window as the lab bar sees it: a Terminal's view says where its shell is and whether it is busy */
interface DeskWindow {
  kind?: string;
  focus(): void;
  content?: { cwd?(): string | undefined; activeTerminal?(): { isBusy(): boolean; injectInput(data: string): void } | null };
}
const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The part of the desktop's window manager (src/desktop/wm.ts) this uses */
interface DesktopLike {
  windows?(): DeskWindow[];
  createWindow(o: { appId: string; title: string; width: number; height: number; minWidth?: number; minHeight?: number; content: { kind: 'iframe'; srcdoc: string } }): {
    iframe?: HTMLIFrameElement; on(ev: 'close', cb: () => void): () => void;
  };
}

function getLanguageForFile(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase() || '';
  const map: Record<string, string> = {
    js: 'javascript', mjs: 'javascript', cjs: 'javascript',
    ts: 'javascript', tsx: 'javascript', jsx: 'javascript',
    py: 'python', python: 'python',
    c: 'cpp', h: 'cpp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
    html: 'html', htm: 'html', xml: 'html', svg: 'html',
    css: 'css', scss: 'css', less: 'css',
    json: 'json',
    md: 'markdown', markdown: 'markdown',
    sql: 'sql',
    sh: 'shell', bash: 'shell', zsh: 'shell',
    rs: 'rust',
    go: 'go',
    java: 'java',
    yaml: 'yaml', yml: 'yaml',
    toml: 'toml',
  };
  return map[ext] || 'javascript';
}

/** localStorage: the first-open hint was shown */
export const CODE_HINT_KEY = 'tabcomputer-code-hint';
/** The hint: what this editor has, where to find it (no command palette here) */
export const CODE_HINT = 'File ▸ Open… in the menu bar opens a file or folder · Ctrl+S saves · ☰ (bottom left) shows the file list · Ctrl+F finds';

/** The same on a phone, where the menus are the pill's sheet (docs/DESKTOP.md "Phone layout") */
export const CODE_HINT_PHONE = 'Tap the pill twice for the menu: File ▸ Open… opens a file or folder · ☰ (bottom left) shows the file list';

/** `phone`: the desktop's phone layout: the file list starts closed and opens over the editor, controls are finger-sized */
function buildEditorHtml(files: { path: string; content: string; language: string }[], cwd: string, hint = '', phone = false): string {
  const filesJson = JSON.stringify(files);
  const cwdJson = JSON.stringify(cwd);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { display: flex; height: 100vh; background: #1e1e2e; color: #cdd6f4; font-family: system-ui, -apple-system, sans-serif; }

  /* File tree sidebar */
  #sidebar { width: 200px; background: #181825; border-right: 1px solid #313244; overflow-y: auto; flex-shrink: 0; font-size: 13px; }
  #sidebar.hidden { display: none; }
  .tree-item { padding: 4px 8px 4px 12px; cursor: pointer; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #a6adc8; }
  .tree-item:hover { background: #313244; }
  .tree-item.active { background: #45475a; color: #cdd6f4; }
  .tree-item.dir { color: #89b4fa; }
  .tree-dir-label { padding: 4px 8px; font-weight: 600; color: #585b70; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }

  /* Tab bar */
  #tabs { display: flex; background: #181825; border-bottom: 1px solid #313244; overflow-x: auto; flex-shrink: 0; }
  .tab { padding: 6px 12px; font-size: 12px; cursor: pointer; border-right: 1px solid #313244; color: #a6adc8; display: flex; align-items: center; gap: 6px; white-space: nowrap; }
  .tab:hover { background: #313244; }
  .tab.active { background: #1e1e2e; color: #cdd6f4; border-bottom: 2px solid #89b4fa; }
  .tab .dot { width: 6px; height: 6px; border-radius: 50%; background: #f9e2af; display: none; }
  .tab.modified .dot { display: block; }
  .tab .close { font-size: 14px; color: #585b70; margin-left: 4px; }
  .tab .close:hover { color: #f38ba8; }

  /* Editor area */
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #editor-container { flex: 1; overflow: hidden; }

  /* Status bar */
  #status { height: 24px; background: #181825; border-top: 1px solid #313244; display: flex; align-items: center; padding: 0 12px; font-size: 11px; color: #585b70; gap: 16px; }
  #status .saved { color: #a6e3a1; }

  /* Toggle sidebar button */
  #toggle-sidebar { background: none; border: none; color: #585b70; font-size: 16px; cursor: pointer; padding: 2px 6px; }
  #toggle-sidebar:hover { color: #cdd6f4; }

  /* CodeMirror theme overrides */
  .cm-editor { height: 100%; font-size: 14px; }
  .cm-editor .cm-scroller { overflow: auto; }
  .cm-editor.cm-focused { outline: none; }

  /* First-open hint */
  #hint { display: flex; align-items: center; gap: 8px; padding: 6px 10px; background: #313244; color: #cdd6f4; font-size: 12px; border-bottom: 1px solid #45475a; flex-shrink: 0; }
  #hint span { flex: 1; }
  #hint button { background: none; border: 1px solid #585b70; color: #cdd6f4; border-radius: 4px; font: inherit; padding: 1px 8px; cursor: pointer; }

  /* Lab bar (src/lab.ts): Run, Test, Submit for a folder with .tabcomputer/lab.json */
  #lab { display: flex; align-items: center; gap: 6px; padding: 5px 10px; background: #181825; border-bottom: 1px solid #313244; font-size: 12px; flex-shrink: 0; flex-wrap: wrap; }
  #lab[hidden] { display: none; }
  #lab-name { color: #a6adc8; margin-right: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 14em; }
  #lab button { background: #313244; border: 1px solid #45475a; color: #cdd6f4; border-radius: 4px; font: inherit; padding: 2px 12px; cursor: pointer; }
  #lab button:hover { background: #45475a; }
  #lab button:disabled { opacity: .5; cursor: default; }
  #lab button[hidden] { display: none; }
  #lab-submit { background: #89b4fa; border-color: #89b4fa; color: #11111b; font-weight: 600; }
  #lab-submit:hover { background: #b4befe; }
  #lab-msg { flex: 1 1 12em; min-width: 0; color: #a6adc8; overflow-wrap: anywhere; user-select: text; -webkit-user-select: text; }
  #lab-msg.ok { color: #a6e3a1; }
  #lab-msg.bad { color: #f38ba8; }
  #status-git { margin-left: auto; white-space: nowrap; }
  #status-git.unsaved { color: #f9e2af; }
  #status-git.saved { color: #a6e3a1; }
  /* A phone (the desktop's phone layout) */
  body.phone #sidebar { position: absolute; z-index: 5; top: 0; bottom: 0; left: 0; width: min(280px, 80%); box-shadow: 8px 0 24px rgba(0, 0, 0, .4); }
  body.phone .tree-item { min-height: 44px; display: flex; align-items: center; }
  body.phone #toggle-sidebar { min-width: 44px; min-height: 44px; }
  body.phone #hint button { min-height: 44px; padding: 1px 14px; }
</style>
</head>
<body${phone ? ' class="phone"' : ''}>
<div id="sidebar"></div>
<div id="main">
  ${hint ? `<div id="hint"><span>${hint.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</span><button type="button" onclick="this.parentElement.remove()">Got it</button></div>` : ''}
  <div id="lab" hidden>
    <span id="lab-name"></span>
    <button id="lab-run" type="button" title="Save, then run the lab's run command in the Terminal">Run</button>
    <button id="lab-test" type="button" title="Save, then run the lab's tests in the Terminal">Test</button>
    <button id="lab-submit" type="button" title="Save, commit and push to GitHub">Submit</button>
    <span id="lab-msg" role="status" aria-live="polite"></span>
  </div>
  <div id="tabs"></div>
  <div id="editor-container"></div>
  <div id="status">
    <button id="toggle-sidebar" title="Toggle sidebar">&#9776;</button>
    <span id="status-file"></span>
    <span id="status-pos"></span>
    <span id="status-msg"></span>
    <span id="status-git"></span>
  </div>
</div>

<script>
// The lab bar and the saved mark (src/lab.ts). Not a module, so it works before the editor
// has loaded; everything the window's host sends goes in as text.
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var lab = window.__lab = { saveAll: function () {} };
  var send = function (m) { window.parent.postMessage(m, '*'); };
  var actions = ['run', 'test', 'submit'];
  actions.forEach(function (a) {
    $('lab-' + a).onclick = function () { lab.saveAll(); send({ type: 'shiro-editor-action', action: a }); };
  });
  var say = function (text, cls) { var m = $('lab-msg'); m.textContent = text || ''; m.className = cls || ''; };
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (e.source !== window.parent || !d) return;
    if (d.type === 'shiro-editor-lab') {
      $('lab').hidden = !d.show;
      $('lab-name').textContent = d.name || '';
      $('lab-run').hidden = !d.run;
      $('lab-test').hidden = !d.test;
      $('lab-submit').hidden = !d.submit;
      if (d.problem) say(d.problem, 'bad');
      else if ($('lab-msg').className === 'bad' && $('lab-msg').dataset.config) say('');
      $('lab-msg').dataset.config = d.problem ? '1' : '';
    } else if (d.type === 'shiro-editor-git') {
      var g = $('status-git');
      g.textContent = d.text || '';
      g.className = d.tracked ? (d.unsaved ? 'unsaved' : 'saved') : '';
      g.title = d.detail || '';
    } else if (d.type === 'shiro-editor-result') {
      say(d.text, d.ok === true ? 'ok' : d.ok === false ? 'bad' : '');
      $('lab-msg').dataset.config = '';
      actions.forEach(function (a) { $('lab-' + a).disabled = !!d.busy; });
    }
  });
  send({ type: 'shiro-editor-ready' });
})();
</script>

<script type="module">
const CDN = ${JSON.stringify(CM_CDN)};
const FILES = ${filesJson};
const CWD = ${cwdJson};

// Dynamic import from CDN
const [
  { EditorState },
  { EditorView, keymap, lineNumbers, highlightActiveLineGutter, highlightSpecialChars, drawSelection, highlightActiveLine, rectangularSelection, crosshairCursor },
  { defaultKeymap, history, historyKeymap, indentWithTab },
  { syntaxHighlighting, defaultHighlightStyle, indentOnInput, bracketMatching, foldGutter, foldKeymap },
  { closeBrackets, closeBracketsKeymap, autocompletion, completionKeymap },
  { searchKeymap, highlightSelectionMatches },
  { javascript },
  { oneDark },
] = await Promise.all([
  import(CDN + '/@codemirror/state@6'),
  import(CDN + '/@codemirror/view@6'),
  import(CDN + '/@codemirror/commands@6'),
  import(CDN + '/@codemirror/language@6'),
  import(CDN + '/@codemirror/autocomplete@6'),
  import(CDN + '/@codemirror/search@6'),
  import(CDN + '/@codemirror/lang-javascript@6'),
  import(CDN + '/@codemirror/theme-one-dark@6'),
]);

// Additional language modules (loaded on demand)
const langModules = {};
async function getLang(name) {
  if (name === 'javascript') return javascript();
  if (langModules[name]) return langModules[name];
  try {
    const m = await import(CDN + '/@codemirror/lang-' + name + '@6');
    const fn = m[name] || m[Object.keys(m).find(k => typeof m[k] === 'function')];
    if (fn) { langModules[name] = fn(); return langModules[name]; }
  } catch {}
  return javascript(); // fallback
}

// State
const openFiles = new Map(); // path -> { content, view, modified, original }
let activeFile = null;
let view = null;

const sidebar = document.getElementById('sidebar');
if (document.body.classList.contains('phone')) sidebar.classList.add('hidden');
const tabsEl = document.getElementById('tabs');
const editorContainer = document.getElementById('editor-container');
const statusFile = document.getElementById('status-file');
const statusPos = document.getElementById('status-pos');
const statusMsg = document.getElementById('status-msg');

// Build sidebar
function renderSidebar() {
  sidebar.innerHTML = '';
  const dirs = new Map();
  for (const f of FILES) {
    const parts = f.path.split('/');
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.';
    if (!dirs.has(dir)) dirs.set(dir, []);
    dirs.get(dir).push(f);
  }
  for (const [dir, files] of dirs) {
    if (dirs.size > 1) {
      const label = document.createElement('div');
      label.className = 'tree-dir-label';
      label.textContent = dir;
      sidebar.appendChild(label);
    }
    for (const f of files) {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.textContent = f.path.split('/').pop();
      item.title = f.path;
      item.onclick = () => openFile(f.path);
      item.dataset.path = f.path;
      sidebar.appendChild(item);
    }
  }
}

// Tabs
function renderTabs() {
  tabsEl.innerHTML = '';
  for (const [path, state] of openFiles) {
    const tab = document.createElement('div');
    tab.className = 'tab' + (path === activeFile ? ' active' : '') + (state.modified ? ' modified' : '');
    const dot = document.createElement('span');
    dot.className = 'dot';
    const name = document.createElement('span');
    name.textContent = path.split('/').pop();
    const close = document.createElement('span');
    close.className = 'close';
    close.textContent = '\\u00d7';
    close.onclick = (e) => { e.stopPropagation(); closeFile(path); };
    tab.appendChild(dot);
    tab.appendChild(name);
    tab.appendChild(close);
    tab.onclick = () => switchTo(path);
    tabsEl.appendChild(tab);
  }
  // The window's host counts files with edits that are not saved (the lab's saved mark)
  let dirty = 0;
  for (const state of openFiles.values()) if (state.modified) dirty++;
  if (dirty !== lastDirty) { lastDirty = dirty; window.parent.postMessage({ type: 'shiro-editor-dirty', count: dirty }, '*'); }
}
let lastDirty = 0;

// Run, Test and Submit save every edited file first
window.__lab.saveAll = () => {
  for (const [path, state] of openFiles) {
    if (path === activeFile && view) state.content = view.state.doc.toString();
    if (state.content === state.original) continue;
    window.parent.postMessage({ type: 'shiro-editor-save', path, content: state.content }, '*');
    state.original = state.content;
    state.modified = false;
  }
  renderTabs();
};

async function openFile(path) {
  // A notebook opens in the Notebook app, not as its JSON
  if (path.slice(-6).toLowerCase() === '.ipynb') { window.parent.postMessage({ type: 'shiro-editor-open-notebook', path: path }, '*'); return; }
  if (!openFiles.has(path)) {
    const f = FILES.find(f => f.path === path);
    if (!f) return;
    const lang = await getLang(f.language);
    const state = EditorState.create({
      doc: f.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightSpecialChars(),
        history(),
        foldGutter(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion(),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        lang,
        oneDark,
        keymap.of([
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...foldKeymap,
          ...completionKeymap,
          indentWithTab,
          { key: 'Mod-s', run: () => { saveFile(activeFile); return true; } },
        ]),
        EditorView.updateListener.of(update => {
          if (update.docChanged && activeFile) {
            const state = openFiles.get(activeFile);
            if (state) {
              state.content = update.state.doc.toString();
              state.modified = state.content !== state.original;
              renderTabs();
            }
          }
          if (update.selectionSet) {
            const pos = update.state.selection.main.head;
            const line = update.state.doc.lineAt(pos);
            statusPos.textContent = 'Ln ' + line.number + ', Col ' + (pos - line.from + 1);
          }
        }),
      ],
    });
    openFiles.set(path, { content: f.content, original: f.content, editorState: state, modified: false });
  }
  switchTo(path);
}

function switchTo(path) {
  // Save current view state
  if (activeFile && view) {
    openFiles.get(activeFile).editorState = view.state;
  }
  activeFile = path;

  const state = openFiles.get(path);
  if (!state) return;

  // Replace editor
  editorContainer.innerHTML = '';
  view = new EditorView({
    state: state.editorState,
    parent: editorContainer,
  });
  view.focus();

  statusFile.textContent = path;
  renderTabs();

  // Highlight sidebar
  sidebar.querySelectorAll('.tree-item').forEach(el => {
    el.classList.toggle('active', el.dataset.path === path);
  });
}

function closeFile(path) {
  openFiles.delete(path);
  if (activeFile === path) {
    const remaining = [...openFiles.keys()];
    if (remaining.length > 0) {
      switchTo(remaining[remaining.length - 1]);
    } else {
      activeFile = null;
      editorContainer.innerHTML = '';
      statusFile.textContent = '';
    }
  }
  renderTabs();
}

async function saveFile(path) {
  if (!path) return;
  const state = openFiles.get(path);
  if (!state) return;

  // Save current editor content
  if (view) state.content = view.state.doc.toString();

  // Send save message to parent
  window.parent.postMessage({
    type: 'shiro-editor-save',
    path: path,
    content: state.content,
  }, '*');

  state.original = state.content;
  state.modified = false;
  renderTabs();

  statusMsg.innerHTML = '<span class="saved">Saved</span>';
  setTimeout(() => { statusMsg.textContent = ''; }, 2000);
}

// Toggle sidebar
document.getElementById('toggle-sidebar').onclick = () => {
  sidebar.classList.toggle('hidden');
};

// Init
renderSidebar();
if (FILES.length > 0) openFile(FILES[0].path);
</script>
</body>
</html>`;
}

export const codeEditorCmd: Command = {
  name: 'code',
  description: 'Rich code editor (CodeMirror)',
  async exec(ctx: CommandContext): Promise<number> {
    const target = ctx.args[0] || '.';
    const resolved = ctx.fs.resolvePath(target, ctx.cwd);

    // A notebook opens in the Notebook app (docs/NOTEBOOK.md)
    const notebooks = (globalThis as { __shiroDesktop?: { openApp?(id: string, args?: Record<string, unknown>): Promise<unknown>; apps?(): { id: string }[] } }).__shiroDesktop;
    if (/\.ipynb$/i.test(resolved) && notebooks?.openApp && notebooks.apps?.().some((a) => a.id === 'notebook')) {
      await notebooks.openApp('notebook', { path: resolved });
      return 0;
    }

    // Collect files to open
    const files: { path: string; content: string; language: string }[] = [];

    let isDir = false;
    try {
      const s = await ctx.fs.stat(resolved);
      isDir = s.type === 'dir';
      if (isDir) {
        // Open directory — list files (non-recursive, skip hidden)
        const entries = await ctx.fs.readdir(resolved);
        const fileEntries: string[] = [];
        for (const entry of entries) {
          if (entry.startsWith('.')) continue;
          const entryPath = resolved === '/' ? `/${entry}` : `${resolved}/${entry}`;
          try {
            const es = await ctx.fs.stat(entryPath);
            if (es.type === 'file') fileEntries.push(entry);
          } catch {}
        }
        // Sort and limit to 50 files
        fileEntries.sort();
        for (const entry of fileEntries.slice(0, 50)) {
          const entryPath = resolved === '/' ? `/${entry}` : `${resolved}/${entry}`;
          try {
            const data = await ctx.fs.readFile(entryPath, 'utf8');
            const content = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
            // Skip binary files
            if (content.includes('\0')) continue;
            const relPath = target === '.' ? entry : `${target}/${entry}`;
            files.push({ path: relPath, content, language: getLanguageForFile(entry) });
          } catch {}
        }
      } else {
        // Single file
        const data = await ctx.fs.readFile(resolved, 'utf8');
        const content = typeof data === 'string' ? data : new TextDecoder().decode(data as Uint8Array);
        const displayPath = ctx.args[0] || resolved.split('/').pop() || 'untitled';
        files.push({ path: displayPath, content, language: getLanguageForFile(resolved) });
      }
    } catch (e: any) {
      ctx.stderr = `code: ${e.message}\n`;
      return 1;
    }

    if (files.length === 0) {
      // Open empty editor
      files.push({ path: 'untitled.js', content: '', language: 'javascript' });
    }

    const title = target === '.' ? ctx.cwd.split('/').pop() || 'code' : target;
    const savePathFor = async (path: string): Promise<string> => {
      // Resolve relative to the opened target
      try {
        const s = await ctx.fs.stat(resolved);
        if (s.type !== 'dir') return resolved;
        // Strip leading target prefix if present
        const cleanPath = path.startsWith(target + '/') ? path.slice(target.length + 1) : path;
        return resolved === '/' ? `/${cleanPath}` : `${resolved}/${cleanPath}`;
      } catch {
        return resolved;
      }
    };

    // On the desktop: a desktop window of the Code app, so the menu bar follows it (its File menu)
    const wm = (globalThis as { __shiroDesktop?: DesktopLike }).__shiroDesktop;
    if (wm?.createWindow) {
      const phone = !!(wm as { phone?: boolean }).phone;
      let hint = '';
      try { if (!localStorage.getItem(CODE_HINT_KEY)) { hint = phone ? CODE_HINT_PHONE : CODE_HINT; localStorage.setItem(CODE_HINT_KEY, String(Date.now())); } } catch {}
      const dwin = wm.createWindow({
        appId: 'code', title, width: 960, height: 620, minWidth: 360, minHeight: 220,
        content: { kind: 'iframe', srcdoc: buildEditorHtml(files, ctx.cwd, hint, phone) },
      });
      // session restore opens it again; File ▸ Open… starts in its folder
      (dwin as { restoreCommand?: { cmd: string; cwd: string } }).restoreCommand = { cmd: commandLine('code', ctx.args), cwd: ctx.cwd };
      const codeDir = isDir ? resolved : resolved.slice(0, resolved.lastIndexOf('/')) || '/';
      (dwin as { codeDir?: string }).codeDir = codeDir;
      // Saves from this window's editor only (another Code window has its own files), in the order they were sent
      let saving: Promise<void> = Promise.resolve();
      let lab: import('../lab').LabEditor | null = null;
      const onMessage = (e: MessageEvent) => {
        if (e.source !== dwin.iframe?.contentWindow || !e.data) return;
        if (e.data.type === 'shiro-editor-save') {
          const { path, content } = e.data;
          saving = saving.then(async () => {
            // (noteEdited: `link` records a file saved here as it is when the link is made, src/session-log.ts)
            try { const to = await savePathFor(path); await ctx.fs.writeFile(to, content); noteEdited(to); } catch (err: any) { console.error(`code: save error: ${err.message}`); }
          });
        } else if (e.data.type === 'shiro-editor-open-notebook' && typeof e.data.path === 'string') {
          void savePathFor(e.data.path).then((p) => notebooks?.openApp?.('notebook', { path: p }));
        } else lab?.message(e.data);
      };
      window.addEventListener('message', onMessage);
      // The classroom's side of the window (src/lab.ts): Run, Test, Submit and the saved mark
      let closed = false;
      let labTerminal: DeskWindow | null = null;
      const runInTerminal = (cwd: string, command: string, label: string): string | null => {
        const desk = (globalThis as { __shiroDesktopCtx?: { openTerminal(o: { cwd: string; command: string; title: string }): DeskWindow | null } }).__shiroDesktopCtx;
        if (!desk) return 'There is no Terminal to run it in.';
        const terminals = (wm.windows?.() ?? []).filter((w) => w.kind === 'terminal');
        const target = labTerminal && terminals.includes(labTerminal) ? labTerminal : terminals.find((w) => w.content?.cwd?.() === cwd) ?? null;
        const term = target?.content?.activeTerminal?.();
        if (target && term) {
          target.focus();
          if (term.isBusy()) return `The Terminal is still running a command. Stop it with Ctrl+C, then press ${label} again.`;
          labTerminal = target;
          // Ctrl+U first: a half-typed line must not run in front of the command
          term.injectInput(`\x15${target.content?.cwd?.() === cwd ? '' : `cd ${quote(cwd)} && `}${command}\r`);
          return null;
        }
        labTerminal = desk.openTerminal({ cwd, command, title });
        return null;
      };
      void import('../lab').then(({ attachLab }) => {
        if (closed) return;
        lab = attachLab({
          fs: ctx.fs, dir: codeDir,
          post: (msg) => dwin.iframe?.contentWindow?.postMessage(msg, '*'),
          setMark: (text) => (dwin as { setTitle?(t: string): void }).setTitle?.(text ? `${title} · ${text}` : title),
          flush: () => saving,
          runInTerminal,
          exec: async (cwd, line) => {
            const sh = ctx.shell.fork();
            sh.cwd = cwd;
            let out = '';
            const code = await sh.execute(line, (s) => { out += s; }, (s) => { out += s; });
            return { code, out };
          },
        });
      });
      dwin.on('close', () => { closed = true; window.removeEventListener('message', onMessage); lab?.dispose(); });
      return 0;
    }

    const html = buildEditorHtml(files, ctx.cwd);

    const win = createServerWindow({
      mode: 'iframe',
      title,
      width: '52em',
      height: '32em',
    });
    win.updateIframe(html);

    // Listen for save messages from the editor iframe
    const handler = async (e: MessageEvent) => {
      if (e.data?.type !== 'shiro-editor-save') return;
      const { path, content } = e.data;
      const savePath = await savePathFor(path);
      try {
        await ctx.fs.writeFile(savePath, content);
        noteEdited(savePath);
      } catch (err: any) {
        console.error(`code: save error: ${err.message}`);
      }
    };
    window.addEventListener('message', handler);

    // Clean up listener when window is closed
    const origClose = win.close;
    win.close = () => {
      window.removeEventListener('message', handler);
      origClose();
    };

    return 0;
  },
};
