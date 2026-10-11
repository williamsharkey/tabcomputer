/**
 * tmux — Terminal multiplexer (tmux-lite)
 *
 * Single xterm.js instance — panes are virtual screen buffers composed via ANSI.
 * Ctrl-B prefix: % split-h, " split-v, arrows select pane, d detach, c new window, n/p next/prev
 */

import type { Command, CommandContext, TerminalLike } from './index';
import {
  TmuxSession, TmuxWindow, TmuxPane,
  renderWindow, renderStatusBar, snapshotSession,
  ScreenBuffer,
} from '../tmux-layout';
import { Shell } from '../shell';
import { openpty, attachKernelTty, type Pty } from '../kernel/pty';
import type { Kernel } from '../kernel/kernel';
import type { Process } from '../kernel/process';
import { SIGHUP } from '../kernel/abi';

// ── Session store (in-memory, persists within browser session) ───────

const sessions: Map<string, TmuxSession> = new Map();

function getOrCreateSession(name: string): TmuxSession {
  let session = sessions.get(name);
  if (!session) {
    session = new TmuxSession(name);
    sessions.set(name, session);
  }
  return session;
}

// ── Input buffer for each pane ──────────────────────────────────────

const paneInputBuffers: Map<number, string> = new Map();

function getPaneInput(paneId: number): string {
  return paneInputBuffers.get(paneId) || '';
}

function setPaneInput(paneId: number, input: string): void {
  paneInputBuffers.set(paneId, input);
}

// ── tmux command ────────────────────────────────────────────────────

export const tmuxCmd: Command = {
  name: 'tmux',
  description: 'Terminal multiplexer',

  async exec(ctx: CommandContext): Promise<number> {
    // Questions that need no terminal
    if (ctx.args[0] === '-V') {
      ctx.stdout += 'tmux 3.4-lite (built in; `pkg install tmux` for the real tmux)\n';
      return 0;
    }
    if (ctx.args[0] === '-h' || ctx.args[0] === '--help') {
      ctx.stdout += 'usage: tmux [-V] [new [-s NAME] | attach [-t NAME] | ls | kill-server]\n' +
        '       tmux new -d [-s NAME] [-c DIR] [-x W -y H] [CMD] | send-keys -t T KEYS... | capture-pane -p [-t T] [-S N]\n' +
        '       tmux has -t NAME | kill-session -t NAME | list-panes [-F FMT] | display -p FMT\n' +
        'Ctrl-B then: % split left/right, " split top/bottom, arrows move, c new window, n/p next/previous, d detach\n';
      return 0;
    }
    const scripted = await runScripted(ctx);
    if (scripted !== null) return scripted;

    const terminal = ctx.terminal;
    if (!terminal && ctx.args[0] !== 'ls' && ctx.args[0] !== 'list-sessions' && ctx.args[0] !== 'kill-server') {
      ctx.stderr += 'tmux: open terminal failed: not a terminal\n';
      return 1;
    }

    const sessionName = ctx.args[0] || 'main';

    // Handle subcommands
    if (ctx.args[0] === 'ls' || ctx.args[0] === 'list-sessions') {
      if (sessions.size === 0) {
        ctx.stdout += 'no server running on /tmp/tmux-user/default\n';
      } else {
        for (const [name, session] of sessions) {
          const winCount = session.windows.length;
          ctx.stdout += `${name}: ${winCount} windows\n`;
        }
      }
      return 0;
    }

    if (ctx.args[0] === 'kill-server') {
      for (const session of sessions.values()) endSession(session);
      sessions.clear();
      ctx.stdout += 'tmux: server killed\n';
      return 0;
    }

    if (!terminal) return 1; // (ls and kill-server returned above)

    // Create or attach to session
    const session = getOrCreateSession(
      ctx.args[0] === 'new' || ctx.args[0] === 'new-session'
        ? (ctx.args[1] || 'main')
        : (ctx.args[0] === 'attach' || ctx.args[0] === 'a'
          ? (ctx.args[1] || 'main')
          : sessionName)
    );

    const { rows: termRows, cols: termCols } = terminal.getSize();

    // Create initial window and pane if session is new
    if (session.windows.length === 0) {
      const win = new TmuxWindow('bash');
      const paneShell = ctx.shell.fork();
      const pane = new TmuxPane(paneShell, 0, 0, termCols, termRows - 1);

      // Show initial prompt
      pane.writeOutput(`${pane.getPrompt()}`);

      win.addPane(pane);
      session.addWindow(win);
    }

    // Enter TUI mode
    return runTmuxTUI(session, terminal, ctx);
  },
};

// ── TUI Main Loop ───────────────────────────────────────────────────

async function runTmuxTUI(
  session: TmuxSession,
  terminal: TerminalLike,
  ctx: CommandContext,
): Promise<number> {
  let running = true;
  let prefixMode = false;
  let cols: number, rows: number;
  ({ rows, cols } = terminal.getSize());

  const write = (s: string) => terminal.writeOutput(s);

  // Enter alternate screen + hide cursor
  write('\x1b[?1049h\x1b[?25l');

  function render(): void {
    if (!running) return;

    const win = session.getActiveWindow();
    if (!win) return;

    // Clear screen and home cursor
    write('\x1b[2J\x1b[H');

    // Render all panes composited
    const content = renderWindow(win, cols, rows - 1);
    write(content);

    // Status bar on last line
    write(`\x1b[${rows};1H`);
    write(renderStatusBar(session, cols, prefixMode));
  }

  // Resize handler
  const unsubResize = terminal.onResize((newCols, newRows) => {
    cols = newCols;
    rows = newRows;

    // Resize all panes in active window
    const win = session.getActiveWindow();
    if (win && win.panes.length === 1) {
      win.panes[0].resize(0, 0, cols, rows - 1);
    }
    render();
  });

  // Periodic render for clock updates
  const renderInterval = setInterval(() => {
    if (running) render();
  }, 1000);

  function cleanup(): void {
    running = false;
    clearInterval(renderInterval);
    unsubResize();
    terminal.exitRawMode();
    write('\x1b[?25h');     // Show cursor
    write('\x1b[?1049l');   // Exit alternate screen
  }

  // Key handler
  function handleKey(key: string): void {
    if (!running) return;

    const win = session.getActiveWindow();
    if (!win) return;
    const pane = win.getActivePane();
    if (!pane) return;

    // Ctrl-B prefix mode
    if (key === '\x02' || key === 'Ctrl+B') {
      prefixMode = true;
      render();
      return;
    }

    if (prefixMode) {
      prefixMode = false;
      handlePrefixKey(key, session, win, pane, ctx, terminal, cleanup, render);
      render();
      return;
    }

    // Normal mode: forward keystrokes to active pane
    handlePaneInput(key, pane, ctx, render);
  }

  return new Promise<number>((resolve) => {
    const wrappedCleanup = () => {
      cleanup();
      resolve(0);
    };

    // Store resolve for prefix-d (detach)
    (session as any)._resolve = wrappedCleanup;

    terminal.enterRawMode(handleKey);

    // Handle abort signal (Ctrl+C from outer shell)
    const signal = ctx.shell?.abortController?.signal;
    if (signal) {
      signal.addEventListener('abort', () => {
        wrappedCleanup();
      }, { once: true });
    }

    render();
  });
}

// ── Prefix key handler ──────────────────────────────────────────────

function handlePrefixKey(
  key: string,
  session: TmuxSession,
  win: TmuxWindow,
  pane: TmuxPane,
  ctx: CommandContext,
  terminal: TerminalLike,
  cleanup: () => void,
  render: () => void,
): void {
  const { rows, cols } = terminal.getSize();

  switch (key) {
    case '%': {
      // Split horizontally
      const newShell = ctx.shell.fork();
      const newPane = win.splitHorizontal(newShell);
      newPane.writeOutput(newPane.getPrompt());
      break;
    }

    case '"': {
      // Split vertically
      const newShell = ctx.shell.fork();
      const newPane = win.splitVertical(newShell);
      newPane.writeOutput(newPane.getPrompt());
      break;
    }

    case 'd': {
      // Detach
      const resolve = (session as any)._resolve;
      if (resolve) resolve();
      return;
    }

    case 'c': {
      // New window
      const newWin = new TmuxWindow(`bash`);
      const newShell = ctx.shell.fork();
      const newPane = new TmuxPane(newShell, 0, 0, cols, rows - 1);
      newPane.writeOutput(newPane.getPrompt());
      newWin.addPane(newPane);
      session.addWindow(newWin);
      session.activeWindow = session.windows.length - 1;
      break;
    }

    case 'n': {
      // Next window
      session.nextWindow();
      break;
    }

    case 'p': {
      // Previous window
      session.prevWindow();
      break;
    }

    case 'ArrowLeft':
    case 'ArrowUp': {
      // Select previous pane
      if (win.panes.length > 1) {
        win.activePane = (win.activePane - 1 + win.panes.length) % win.panes.length;
      }
      break;
    }

    case 'ArrowRight':
    case 'ArrowDown': {
      // Select next pane
      if (win.panes.length > 1) {
        win.activePane = (win.activePane + 1) % win.panes.length;
      }
      break;
    }

    case 'x': {
      // Kill pane
      if (win.panes.length > 1) {
        win.removePane(pane.id);
        // Resize remaining pane to fill
        if (win.panes.length === 1) {
          win.panes[0].resize(0, 0, cols, rows - 1);
        }
      } else if (session.windows.length > 1) {
        // Kill window
        const idx = session.windows.indexOf(win);
        session.windows.splice(idx, 1);
        session.activeWindow = Math.min(session.activeWindow, session.windows.length - 1);
      } else {
        // Last pane in last window — detach
        const resolve = (session as any)._resolve;
        if (resolve) resolve();
        return;
      }
      break;
    }

    case '?': {
      // Show help (write to active pane)
      pane.writeOutput('\r\n  tmux key bindings:\r\n');
      pane.writeOutput('  Ctrl-B %       Split horizontal\r\n');
      pane.writeOutput('  Ctrl-B "       Split vertical\r\n');
      pane.writeOutput('  Ctrl-B arrows  Select pane\r\n');
      pane.writeOutput('  Ctrl-B c       New window\r\n');
      pane.writeOutput('  Ctrl-B n/p     Next/prev window\r\n');
      pane.writeOutput('  Ctrl-B x       Kill pane/window\r\n');
      pane.writeOutput('  Ctrl-B d       Detach\r\n');
      pane.writeOutput('  Ctrl-B ?       This help\r\n\r\n');
      pane.writeOutput(pane.getPrompt());
      break;
    }

    default:
      // Unknown prefix key — ignore
      break;
  }
}

// ── Pane input handler (simulated shell) ────────────────────────────

function handlePaneInput(
  key: string,
  pane: TmuxPane,
  ctx: CommandContext,
  render: () => void,
): void {
  const input = getPaneInput(pane.id);

  if (key === '\r' || key === 'Enter') {
    pane.writeOutput('\r\n');

    const command = input.trim();
    setPaneInput(pane.id, '');

    if (command === 'exit') {
      pane.writeOutput('[pane closed]\r\n');
      pane.running = false;
      render();
      return;
    }

    if (command) {
      // Execute command in pane's shell asynchronously
      executeInPane(pane, command, ctx).then(() => {
        pane.writeOutput(pane.getPrompt());
        render();
      });
    } else {
      pane.writeOutput(pane.getPrompt());
    }
    render();
    return;
  }

  if (key === '\x7f' || key === 'Backspace') {
    if (input.length > 0) {
      setPaneInput(pane.id, input.slice(0, -1));
      pane.writeOutput('\b \b');
    }
    render();
    return;
  }

  if (key === '\x03' || key === 'Ctrl+C') {
    setPaneInput(pane.id, '');
    pane.writeOutput('^C\r\n');
    pane.writeOutput(pane.getPrompt());
    render();
    return;
  }

  if (key === '\x0c' || key === 'Ctrl+L') {
    // Clear screen
    pane.buffer.clear();
    pane.writeOutput(pane.getPrompt() + getPaneInput(pane.id));
    render();
    return;
  }

  // Regular character
  if (key.length === 1 && key.charCodeAt(0) >= 32) {
    setPaneInput(pane.id, input + key);
    pane.writeOutput(key);
    render();
  }
}

// ── Execute command in pane ─────────────────────────────────────────

async function executeInPane(pane: TmuxPane, command: string, ctx: CommandContext): Promise<void> {
  try {
    await pane.shell.execute(command, (output: string) => {
      // Convert \n to \r\n for terminal display
      const converted = output.replace(/\n/g, '\r\n');
      pane.writeOutput(converted);
    });
  } catch (e: any) {
    pane.writeOutput(`\r\nError: ${e.message}\r\n`);
  }
}

// ── Scripted use, no terminal needed ────────────────────────────────
// What agents and scripts run: `tmux new -d -s NAME 'cmd'`, send-keys,
// capture-pane -p, has-session, kill-session. A detached pane is a kernel pty
// (/dev/pts/N, sized by -x/-y) with a shell on it as a session leader: `sh -i`,
// or `sh -c CMD` for a pane's command. send-keys types into the pty, so its
// line discipline echoes and edits, Ctrl-C is SIGINT to the foreground job,
// and isatty, `tty`, `stty size`, REPLs and TUIs work; what the pane prints
// goes to its screen buffer, which capture-pane reads. The session ends when
// its process does, as in tmux (tabcomputer#14, #69).

const SCRIPTED = new Set([
  'new-session', 'new', 'send-keys', 'send', 'capture-pane', 'capturep',
  'has-session', 'has', 'kill-session', 'list-panes', 'lsp', 'display-message', 'display',
]);

/** A detached pane's terminal and the process on it */
interface PaneRun { pid: number; pty: Pty; proc: Process; kernel: Kernel }
const paneRuns = new Map<number, PaneRun>();

/** Parse `-x VALUE` style options; flags in `bool` take no value */
function parseOpts(args: string[], bool: string): { opts: Record<string, string | true>; rest: string[] } {
  const opts: Record<string, string | true> = {};
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (!/^-[A-Za-z]/.test(a)) break;
    for (let j = 1; j < a.length; j++) {
      const f = a[j];
      if (bool.includes(f)) { opts[f] = true; continue; }
      const v = a.slice(j + 1) || args[++i];
      opts[f] = v ?? '';
      break;
    }
  }
  return { opts, rest: args.slice(i) };
}

/** `-t session[:window[.pane]]` or `-t %PANE`: the pane it names (the session's active one by default) */
function resolveTarget(target: string | true | undefined): { session: TmuxSession; pane: TmuxPane } | string {
  const t = typeof target === 'string' ? target : '';
  if (t.startsWith('%')) {
    const id = Number(t.slice(1));
    for (const session of sessions.values()) {
      for (const win of session.windows) {
        const pane = win.panes.find((p) => p.id === id);
        if (pane) return { session, pane };
      }
    }
    return `can't find pane: ${t}`;
  }
  const [name, rest] = t.split(':', 2);
  const session = name ? sessions.get(name) : [...sessions.values()].pop();
  if (!session) return name ? `can't find session: ${name}` : 'no server running on /tmp/tmux-1000/default';
  let win = session.getActiveWindow();
  let paneIdx: number | undefined;
  if (rest) {
    const [w, p] = rest.split('.', 2);
    if (w !== '') win = session.windows[Number(w)] ?? session.windows.find((x) => x.name === w);
    if (p !== undefined) paneIdx = Number(p);
  }
  const pane = win && (paneIdx !== undefined ? win.panes[paneIdx] : win.getActivePane());
  if (!pane) return `can't find pane: ${t}`;
  return { session, pane };
}

/** Stop everything a session's panes run: SIGHUP to the pane's session, as closing a terminal does */
function endSession(session: TmuxSession): void {
  for (const win of session.windows) {
    for (const pane of win.panes) {
      pane.running = false;
      pane.shell.abortController?.abort();
      const run = paneRuns.get(pane.id);
      paneRuns.delete(pane.id);
      if (run) {
        run.kernel.kill(-run.proc.pid, SIGHUP);
        run.kernel.kill(run.proc.pid, SIGHUP);
        void run.pty.master.close();
      }
    }
  }
}

/** send-keys key names → the characters they type */
const KEY_NAMES: Record<string, string> = {
  'Enter': '\r', 'KPEnter': '\r', 'Tab': '\t', 'BTab': '\x1b[Z', 'Space': ' ', 'Escape': '\x1b', 'BSpace': '\x7f',
  'Up': '\x1b[A', 'Down': '\x1b[B', 'Right': '\x1b[C', 'Left': '\x1b[D', 'Home': '\x1b[H', 'End': '\x1b[F',
  'IC': '\x1b[2~', 'Insert': '\x1b[2~', 'DC': '\x1b[3~', 'Delete': '\x1b[3~',
  'PPage': '\x1b[5~', 'PageUp': '\x1b[5~', 'PgUp': '\x1b[5~', 'NPage': '\x1b[6~', 'PageDown': '\x1b[6~', 'PgDn': '\x1b[6~',
  'F1': '\x1bOP', 'F2': '\x1bOQ', 'F3': '\x1bOR', 'F4': '\x1bOS', 'F5': '\x1b[15~', 'F6': '\x1b[17~',
  'F7': '\x1b[18~', 'F8': '\x1b[19~', 'F9': '\x1b[20~', 'F10': '\x1b[21~', 'F11': '\x1b[23~', 'F12': '\x1b[24~',
};

/** A send-keys word: a key name (C-x, M-x, Enter, Up ...) or text */
function keyText(word: string, literal: boolean): string {
  if (literal) return word;
  if (word in KEY_NAMES) return KEY_NAMES[word];
  const m = /^((?:[CM]-)+)(.+)$/.exec(word);
  if (m) {
    const base = m[2].length === 1 ? m[2] : KEY_NAMES[m[2]];
    if (base !== undefined) {
      let t = base;
      if (m[1].includes('C-') && t.length === 1) {
        const c = t.toLowerCase().charCodeAt(0);
        t = c >= 0x61 && c <= 0x7a ? String.fromCharCode(c - 0x60) : t === ' ' || t === '@' ? '\0' : t === '?' ? '\x7f' : String.fromCharCode(c & 0x1f);
      }
      if (m[1].includes('M-')) t = '\x1b' + t;
      return t;
    }
  }
  return word;
}

async function runScripted(ctx: CommandContext): Promise<number | null> {
  const [cmd, ...args] = ctx.args;
  if (!SCRIPTED.has(cmd)) return null;
  const fail = (msg: string) => { ctx.stderr += msg + '\n'; return 1; };

  switch (cmd) {
    case 'new-session': case 'new': {
      const { opts, rest } = parseOpts(args, 'dADEPX');
      // Attaching needs the terminal: the TUI path below handles it
      if (!opts.d) {
        if (ctx.terminal) {
          ctx.args = typeof opts.s === 'string' ? ['new', opts.s] : ['new'];
          return null;
        }
        return fail('open terminal failed: not a terminal');
      }
      const name = typeof opts.s === 'string' ? opts.s : String(sessions.size);
      if (sessions.has(name)) return fail(`duplicate session: ${name}`);
      const cols = Number(opts.x) || 80;
      const rows = Number(opts.y) || 24;
      const session = new TmuxSession(name);
      const win = new TmuxWindow(typeof opts.n === 'string' ? opts.n : (rest[0]?.split(/\s+/)[0] || 'bash'));
      const paneShell = ctx.shell.fork();
      paneShell.inheritedAbort = null;
      const cwd = typeof opts.c === 'string' ? ctx.fs.resolvePath(opts.c, ctx.cwd) : ctx.cwd;
      paneShell.cwd = cwd;
      const pane = new TmuxPane(paneShell, 0, 0, cols, rows);
      // The pane's terminal: a kernel pty of its size, its output on the pane's screen
      const { kernelForContext } = await import('../wasi/run-command');
      const kernel = kernelForContext(ctx);
      attachKernelTty(kernel);
      const { pty, slave } = openpty({ winsize: { rows, cols } });
      const decoder = new TextDecoder();
      pty.onOutput((b) => pane.writeOutput(decoder.decode(b, { stream: true })));
      // TMUX: socket, server pid, session (the built-in server is the page: pid 1)
      const env: Record<string, string> = { ...ctx.env, TERM: ctx.env.TERM || 'xterm-256color', TMUX: `/tmp/tmux-1000/default,1,${sessions.size}`, TMUX_PANE: `%${pane.id}` };
      const command = rest.join(' ').trim();
      // A session leader with the pty as its controlling terminal (the pane's shell, or its command)
      const proc = kernel.spawn({
        path: '/bin/sh', argv: command ? ['sh', '-c', command] : ['sh', '-i'], env, cwd,
        fds: { 0: slave, 1: slave, 2: slave }, setsid: true,
      });
      proc.ctty = slave;
      const leader = pty.jc.get(proc.pid);
      if (leader) pty.acquire(leader);
      paneShell.env['TMUX'] = env.TMUX;
      paneShell.env['TMUX_PANE'] = `%${pane.id}`;
      win.addPane(pane);
      session.addWindow(win);
      sessions.set(name, session);
      paneRuns.set(pane.id, { pid: proc.pid, pty, proc, kernel });
      // The pane's process is the pane: when it ends, so does the session (tmux without remain-on-exit)
      void proc.wait().then(() => {
        pane.running = false;
        if (paneRuns.get(pane.id)?.proc === proc) {
          paneRuns.delete(pane.id);
          void pty.master.close();
        }
        if (sessions.get(name) === session) sessions.delete(name);
      });
      if (opts.P) ctx.stdout += typeof opts.F === 'string' ? formatPane(opts.F, session, pane) + '\n' : `${name}:\n`;
      return 0;
    }

    case 'send-keys': case 'send': {
      const { opts, rest } = parseOpts(args, 'lRMX');
      const found = resolveTarget(opts.t);
      if (typeof found === 'string') return fail(found);
      const { pane } = found;
      const run = paneRuns.get(pane.id);
      if (!run || !pane.running) return fail(`pane %${pane.id} is not running`);
      // typed into the pane's terminal: its line discipline echoes, edits, and sends Ctrl-C as SIGINT
      for (const word of rest) run.pty.input(keyText(word, !!opts.l));
      return 0;
    }

    case 'capture-pane': case 'capturep': {
      const { opts } = parseOpts(args, 'aCeJNpPqT');
      const found = resolveTarget(opts.t);
      if (typeof found === 'string') return fail(found);
      const buf = found.pane.buffer;
      const screen = buf.toLines();
      const history = buf.scrollback.map((r) => r.join(''));
      // -S/-E: line numbers, 0 the top of the screen, negative into the history, `-` its start/end
      const all = [...history, ...screen];
      const at = (v: string | true | undefined, dflt: number, dash: number) =>
        typeof v !== 'string' || v === '' ? dflt : v === '-' ? dash : history.length + Number(v);
      const start = Math.max(0, at(opts.S, history.length, 0));
      const end = Math.min(all.length - 1, at(opts.E, all.length - 1, all.length - 1));
      const text = all.slice(start, end + 1).map((l) => l.replace(/\s+$/, '')).join('\n') + '\n';
      if (opts.p) ctx.stdout += text;
      else captureBuffer = text;
      return 0;
    }

    case 'has-session': case 'has': {
      const { opts } = parseOpts(args, '');
      const found = resolveTarget(opts.t);
      if (typeof found === 'string') return fail(found);
      return 0;
    }

    case 'kill-session': {
      const { opts } = parseOpts(args, 'aC');
      const found = resolveTarget(opts.t);
      if (typeof found === 'string') return fail(found);
      endSession(found.session);
      for (const [n, s] of sessions) if (s === found.session) sessions.delete(n);
      return 0;
    }

    case 'list-panes': case 'lsp': {
      const { opts } = parseOpts(args, 'as');
      const found = resolveTarget(opts.t);
      if (typeof found === 'string') return fail(found);
      const win = found.session.getActiveWindow();
      for (const [i, pane] of (win?.panes ?? []).entries()) {
        ctx.stdout += (typeof opts.F === 'string' ? formatPane(opts.F, found.session, pane)
          : `${i}: [${pane.width}x${pane.height}] %${pane.id}${pane === found.pane ? ' (active)' : ''}`) + '\n';
      }
      return 0;
    }

    case 'display-message': case 'display': {
      const { opts, rest } = parseOpts(args, 'apIv');
      const found = resolveTarget(opts.t);
      if (typeof found === 'string') return fail(found);
      const text = formatPane(rest.join(' '), found.session, found.pane);
      if (opts.p || !ctx.terminal) ctx.stdout += text + '\n';
      return 0;
    }
  }
  return null;
}

/** The last capture-pane without -p (tmux keeps it as a paste buffer) */
let captureBuffer = '';

/** `#{session_name}`, `#{pane_id}`, `#{pane_pid}` … in a -F format */
function formatPane(fmt: string, session: TmuxSession, pane: TmuxPane): string {
  const run = paneRuns.get(pane.id);
  // what runs in the pane now: its terminal's foreground job (else the pane's process)
  const fg = run ? run.kernel.procs.get(run.pty.fgPgrp) ?? run.proc : undefined;
  const vars: Record<string, string> = {
    session_name: session.name,
    pane_id: `%${pane.id}`,
    pane_pid: String(run?.pid ?? ''),
    pane_tty: run?.pty.name ?? '',
    pane_current_command: fg?.comm ?? '',
    pane_dead: pane.running ? '0' : '1',
    pane_current_path: fg?.cwd ?? pane.shell.cwd,
    pane_width: String(pane.width),
    pane_height: String(pane.height),
    window_name: session.getActiveWindow()?.name ?? '',
    window_index: String(session.activeWindow),
  };
  return fmt.replace(/#\{(\w+)\}/g, (_, k) => vars[k] ?? '').replace(/#S/g, session.name).replace(/#D/g, `%${pane.id}`);
}
