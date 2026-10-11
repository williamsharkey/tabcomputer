import { Command, CommandContext } from './index';
import { ExBuffer, ExIO, runExCommand } from './vi-ex';

/**
 * vi: Minimal vi-like text editor for the terminal
 *
 * A simplified modal text editor with basic vi keybindings.
 *
 * Modes:
 *   - Normal mode: Navigate and execute commands
 *   - Insert mode: Type text (i, a, o to enter)
 *   - Command mode: Execute commands (:w, :q, :wq)
 *   - Search mode: Search for text (/ to enter, n/N to navigate)
 *
 * Normal mode commands:
 *   h,j,k,l  - Move cursor left, down, up, right
 *   i        - Enter insert mode at cursor
 *   a        - Enter insert mode after cursor
 *   o        - Insert new line below and enter insert mode
 *   O        - Insert new line above and enter insert mode
 *   x        - Delete character under cursor
 *   dd       - Delete current line
 *   0        - Move to start of line
 *   $        - Move to end of line
 *   gg       - Move to first line
 *   G        - Move to last line
 *   /        - Enter search mode
 *   n        - Next search result
 *   N        - Previous search result
 *   :        - Enter command mode
 *
 * Command mode:
 *   :w       - Write (save) file
 *   :q       - Quit (if no changes)
 *   :q!      - Quit without saving
 *   :wq      - Write and quit
 *   other ex commands (:N, :%s/a/b/g, :g/re/d, ...): src/commands/vi-ex.ts
 *
 * Without a terminal, and with -e/-s (or as `ex`), it is an ex script runner:
 * the -c and +CMD commands run in order, then (ex mode) the lines of stdin,
 * so `vi -c '%s/a/b/g' -c wq FILE` and `vi -es FILE < script` work in
 * scripts and agents' shells (tabcomputer#62). With a terminal, -c commands
 * run before the editor opens (and a :wq among them never opens it).
 *
 * Insert mode:
 *   ESC      - Return to normal mode
 *   Any text - Insert at cursor
 */

type Mode = 'normal' | 'insert' | 'command' | 'search';

interface EditorState {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  mode: Mode;
  commandBuffer: string;
  lastKey: string;
  modified: boolean;
  scrollOffset: number;
  message: string;
  searchPattern: string;
  searchBuffer: string;
}

interface ViOptions { commands: string[]; ex: boolean; silent: boolean; readonly: boolean; files: string[] }

const USAGE = 'Usage: vi [-c CMD | +CMD]... [-e] [-s] [-R] [FILE]\n'
  + '  -c CMD, +CMD  run ex command CMD after loading FILE (+ alone: the last line; +N: line N)\n'
  + '  -e, -E        ex mode: run the commands, then the lines of stdin, with no screen (ex)\n'
  + '  -s            silent (with -e: -es): no messages, only :p output and errors\n'
  + '  -R            read-only (:w! writes all the same)\n';

function parseViArgs(args: string[], ex: boolean): ViOptions | string {
  const o: ViOptions = { commands: [], ex, silent: false, readonly: false, files: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { o.files.push(...args.slice(i + 1)); break; }
    if (a === '--cmd') { if (i + 1 >= args.length) return 'argument missing after --cmd'; o.commands.push(args[++i]); continue; }
    if (a === '-h' || a === '--help') return '';
    if (a.startsWith('--')) continue; // --clean, --noplugin, --not-a-term, ...: nothing to do here
    if (a.startsWith('+')) { o.commands.push(a.length === 1 ? '$' : a.slice(1)); continue; }
    if (a.startsWith('-') && a.length > 1) {
      for (let j = 1; j < a.length; j++) {
        const f = a[j];
        if (f === 'c') {
          const cmd = j + 1 < a.length ? a.slice(j + 1) : args[++i];
          if (cmd === undefined) return 'argument missing after -c';
          o.commands.push(cmd);
          break;
        }
        if (f === 'e' || f === 'E') o.ex = true;
        else if (f === 's') o.silent = true;
        else if (f === 'R') o.readonly = true;
        else if ('uUiTwW'.includes(f)) { if (j === a.length - 1) i++; break; } // options with an argument: ignored
        else if (!'nNXbylmMZv'.includes(f)) return `unknown option -${f}`;
      }
      continue;
    }
    o.files.push(a);
  }
  if (o.silent && !o.ex) return '-s SCRIPTIN (normal-mode keys) is not supported; for an ex script use -es';
  return o;
}

/** ExIO on the command's fs and output. */
function exIO(ctx: CommandContext, silent: boolean): ExIO {
  return {
    read: async (path) => (await ctx.fs.readFile(path, 'utf8')) as string,
    write: async (path, text, append) => {
      if (append) {
        let old = '';
        try { old = (await ctx.fs.readFile(path, 'utf8')) as string; } catch {}
        text = old + text;
      }
      await ctx.fs.writeFile(path, text);
    },
    resolve: (path) => ctx.fs.resolvePath(path, ctx.cwd),
    out: (t) => { ctx.stdout += t; },
    err: (t) => { ctx.stderr += t; },
    msg: (t) => { if (!silent) ctx.stderr += t; },
  };
}

async function viExec(ctx: CommandContext, asEx: boolean): Promise<number> {
  const name = asEx ? 'ex' : 'vi';
  const opts = parseViArgs(ctx.args, asEx);
  if (typeof opts === 'string') {
    ctx.stderr += (opts ? `${name}: ${opts}\n` : '') + USAGE;
    return opts ? 2 : 0;
  }
  const batch = opts.ex || !ctx.terminal;
  if (!batch && !opts.commands.length && !opts.files.length) {
    ctx.stderr += 'Usage: vi <file>\n';
    return 1;
  }
  if (!ctx.terminal && !opts.ex && !opts.commands.length) {
    ctx.stderr += 'vi: terminal not available for interactive editing\n';
    ctx.stderr += 'Run ex commands instead: vi -c \'%s/old/new/g\' -c wq FILE, or vi -es FILE < script (ed works too).\n';
    return 1;
  }

  // The -c commands (and, in ex mode, stdin's lines) on an ex buffer
  let seeded: ExBuffer | null = null;
  if (batch || opts.commands.length) {
    const buf = new ExBuffer();
    buf.filename = opts.files[0] ?? null;
    buf.readonly = opts.readonly;
    if (buf.filename) {
      try { buf.setText((await ctx.fs.readFile(ctx.fs.resolvePath(buf.filename, ctx.cwd), 'utf8')) as string); }
      catch { if (!opts.silent && batch) ctx.stderr += `"${buf.filename}" [New]\n`; }
    }
    buf.cur = opts.ex ? buf.lines.length : Math.min(1, buf.lines.length);
    const io = exIO(ctx, opts.silent);
    for (const cmd of opts.commands) {
      await runExCommand(buf, cmd, io);
      if (buf.quit !== null) break;
    }
    if (buf.quit === null && opts.ex && !ctx.stdinIsTTY) {
      const text = ctx.stdin || (ctx.readStdin ? await ctx.readStdin() : '');
      const lines = text ? text.replace(/\n$/, '').split('\n') : [];
      let at = 0;
      io.input = () => (at < lines.length ? lines[at++] : null);
      for (let l = io.input(); l !== null && buf.quit === null; l = io.input()) await runExCommand(buf, l, io);
    }
    if (buf.quit !== null) return buf.quit || (opts.ex && buf.errors ? 1 : 0);
    if (batch) {
      // The end of the commands without :q (vim would wait for more)
      if (buf.modified) {
        ctx.stderr += `${name}: E37: No write since last change: the changes were not saved (end the commands with :wq, or :q! to discard)\n`;
        return 1;
      }
      if (!opts.ex) ctx.stderr += 'vi: no terminal: the -c commands ran; end them with :wq or :q!\n';
      return opts.ex && !buf.errors ? 0 : 1;
    }
    seeded = buf;
  }

  const filename = opts.files[0];
  if (!filename) {
    ctx.stderr += 'Usage: vi <file>\n';
    return 1;
  }
  const filepath = ctx.fs.resolvePath(filename, ctx.cwd);

    // Read file or create new
    let initialContent = '';
    let fileExists = false;
    try {
      initialContent = await ctx.fs.readFile(filepath, 'utf8') as string;
      fileExists = true;
    } catch {
      // New file
      initialContent = '';
    }

    const state: EditorState = {
      lines: initialContent ? initialContent.split('\n') : [''],
      cursorRow: 0,
      cursorCol: 0,
      mode: 'normal',
      commandBuffer: '',
      lastKey: '',
      modified: false,
      scrollOffset: 0,
      message: fileExists ? `"${filename}" ${initialContent.split('\n').length} lines` : `"${filename}" [New File]`,
      searchPattern: '',
      searchBuffer: '',
    };

    if (seeded) {
      state.lines = [...seeded.lines, ''];
      state.cursorRow = Math.max(0, seeded.cur - 1);
      state.modified = seeded.modified;
      if (seeded.modified) state.message = `"${filename}" [Modified]`;
    }
    // Ex commands typed at ':' beyond w/q (vi-ex.ts), on the editor's lines
    const ex = seeded ?? new ExBuffer();
    ex.filename = filename;
    ex.readonly = opts.readonly;

    const terminal = ctx.terminal!;
    const { rows: termHeight, cols: termWidth } = terminal.getSize();

    // Run the editor in an interactive loop
    return new Promise<number>((resolve) => {
      let running = true;

      const write = (text: string) => {
        terminal.writeOutput(text);
      };

      const render = () => {
        // Clear screen and render editor
        write('\x1b[2J\x1b[H'); // Clear screen, move cursor to home

        const contentHeight = termHeight - 2; // Leave room for status and command line

        // Adjust scroll offset to keep cursor visible
        if (state.cursorRow < state.scrollOffset) {
          state.scrollOffset = state.cursorRow;
        } else if (state.cursorRow >= state.scrollOffset + contentHeight) {
          state.scrollOffset = state.cursorRow - contentHeight + 1;
        }

        // Render lines
        for (let i = 0; i < contentHeight; i++) {
          const lineIdx = i + state.scrollOffset;
          if (lineIdx < state.lines.length) {
            const line = state.lines[lineIdx];
            // Truncate line to terminal width
            write(line.slice(0, termWidth - 1));
          } else {
            write('\x1b[34m~\x1b[0m'); // Empty line indicator in blue
          }
          write('\x1b[K\r\n'); // Clear to end of line and newline
        }

        // Render status line
        const modeStr = state.mode === 'insert' ? '-- INSERT --' : state.mode === 'command' ? '' : '';
        const modifiedStr = state.modified ? '[+]' : '';
        const posStr = `${state.cursorRow + 1},${state.cursorCol + 1}`;
        const statusLine = ` ${modeStr} ${modifiedStr} ${filename} ${posStr}`.padEnd(termWidth);
        write(`\x1b[7m${statusLine.slice(0, termWidth)}\x1b[0m\r\n`); // Reverse video

        // Render command line or message
        if (state.mode === 'command') {
          write(`:${state.commandBuffer}`);
        } else if (state.mode === 'search') {
          write(`/${state.searchBuffer}`);
        } else {
          write(state.message);
        }
        write('\x1b[K'); // Clear to end of line

        // Move cursor to editing position
        const screenRow = state.cursorRow - state.scrollOffset;
        write(`\x1b[${screenRow + 1};${state.cursorCol + 1}H`);
      };

      const handleKey = async (key: string) => {
        state.message = ''; // Clear message

        if (state.mode === 'normal') {
          await handleNormalMode(key);
        } else if (state.mode === 'insert') {
          await handleInsertMode(key);
        } else if (state.mode === 'command') {
          await handleCommandMode(key);
        } else if (state.mode === 'search') {
          await handleSearchMode(key);
        }

        if (running) {
          render();
        }
      };

      const handleNormalMode = async (key: string) => {
        const currentLine = () => state.lines[state.cursorRow] || '';
        const clampCol = () => {
          const maxCol = Math.max(0, currentLine().length - 1);
          state.cursorCol = Math.min(state.cursorCol, maxCol);
        };

        switch (key) {
          case 'h': // Move left
            state.cursorCol = Math.max(0, state.cursorCol - 1);
            break;
          case 'j': // Move down
            if (state.cursorRow < state.lines.length - 1) {
              state.cursorRow++;
              clampCol();
            }
            break;
          case 'k': // Move up
            if (state.cursorRow > 0) {
              state.cursorRow--;
              clampCol();
            }
            break;
          case 'l': // Move right
            state.cursorCol = Math.min(currentLine().length, state.cursorCol + 1);
            break;
          case '0': // Start of line
            state.cursorCol = 0;
            break;
          case '$': // End of line
            state.cursorCol = Math.max(0, currentLine().length - 1);
            break;
          case 'i': // Insert mode at cursor
            state.mode = 'insert';
            break;
          case 'a': // Insert mode after cursor
            state.cursorCol = Math.min(currentLine().length, state.cursorCol + 1);
            state.mode = 'insert';
            break;
          case 'o': // New line below
            state.lines.splice(state.cursorRow + 1, 0, '');
            state.cursorRow++;
            state.cursorCol = 0;
            state.mode = 'insert';
            state.modified = true;
            break;
          case 'O': // New line above
            state.lines.splice(state.cursorRow, 0, '');
            state.cursorCol = 0;
            state.mode = 'insert';
            state.modified = true;
            break;
          case 'x': // Delete character
            if (currentLine().length > 0) {
              const line = currentLine();
              state.lines[state.cursorRow] = line.slice(0, state.cursorCol) + line.slice(state.cursorCol + 1);
              state.modified = true;
              clampCol();
            }
            break;
          case 'd': // Delete line (dd)
            if (state.lastKey === 'd') {
              state.lines.splice(state.cursorRow, 1);
              if (state.lines.length === 0) state.lines = [''];
              state.cursorRow = Math.min(state.cursorRow, state.lines.length - 1);
              state.modified = true;
              state.lastKey = '';
              return;
            }
            break;
          case 'g': // Go to first line (gg)
            if (state.lastKey === 'g') {
              state.cursorRow = 0;
              state.cursorCol = 0;
              state.lastKey = '';
              return;
            }
            break;
          case 'G': // Go to last line
            state.cursorRow = state.lines.length - 1;
            state.cursorCol = 0;
            break;
          case ':': // Command mode
            state.mode = 'command';
            state.commandBuffer = '';
            break;
          case '/': // Search mode
            state.mode = 'search';
            state.searchBuffer = '';
            break;
          case 'n': // Next search result
            if (state.searchPattern) {
              searchNext(state);
            } else {
              state.message = 'No previous search pattern';
            }
            break;
          case 'N': // Previous search result
            if (state.searchPattern) {
              searchPrevious(state);
            } else {
              state.message = 'No previous search pattern';
            }
            break;
        }

        state.lastKey = key;
      };

      const handleInsertMode = async (key: string) => {
        if (key === '\x1b' || key === 'Escape') {
          // ESC - return to normal mode
          state.mode = 'normal';
          state.cursorCol = Math.max(0, state.cursorCol - 1);
          return;
        }

        const currentLine = state.lines[state.cursorRow];

        if (key === 'Enter' || key === '\r' || key === '\n') {
          // Split line at cursor
          const before = currentLine.slice(0, state.cursorCol);
          const after = currentLine.slice(state.cursorCol);
          state.lines[state.cursorRow] = before;
          state.lines.splice(state.cursorRow + 1, 0, after);
          state.cursorRow++;
          state.cursorCol = 0;
          state.modified = true;
        } else if (key === 'Backspace' || key === '\x7f') {
          if (state.cursorCol > 0) {
            // Delete character before cursor
            state.lines[state.cursorRow] =
              currentLine.slice(0, state.cursorCol - 1) + currentLine.slice(state.cursorCol);
            state.cursorCol--;
            state.modified = true;
          } else if (state.cursorRow > 0) {
            // Join with previous line
            const prevLine = state.lines[state.cursorRow - 1];
            state.cursorCol = prevLine.length;
            state.lines[state.cursorRow - 1] = prevLine + currentLine;
            state.lines.splice(state.cursorRow, 1);
            state.cursorRow--;
            state.modified = true;
          }
        } else if (key.length === 1 && key >= ' ') {
          // Insert character
          state.lines[state.cursorRow] =
            currentLine.slice(0, state.cursorCol) + key + currentLine.slice(state.cursorCol);
          state.cursorCol++;
          state.modified = true;
        }
      };

      const searchNext = (state: EditorState) => {
        if (!state.searchPattern) return;

        const startRow = state.cursorRow;
        const startCol = state.cursorCol + 1;

        // Search from current position to end of file
        for (let row = startRow; row < state.lines.length; row++) {
          const line = state.lines[row];
          const searchStart = row === startRow ? startCol : 0;
          const index = line.indexOf(state.searchPattern, searchStart);

          if (index !== -1) {
            state.cursorRow = row;
            state.cursorCol = index;
            state.message = `Found: ${state.searchPattern}`;
            return;
          }
        }

        // Wrap to beginning of file
        for (let row = 0; row <= startRow; row++) {
          const line = state.lines[row];
          const searchEnd = row === startRow ? startCol - 1 : line.length;
          const index = line.indexOf(state.searchPattern);

          if (index !== -1 && index < searchEnd) {
            state.cursorRow = row;
            state.cursorCol = index;
            state.message = `Found: ${state.searchPattern} (wrapped)`;
            return;
          }
        }

        state.message = `Pattern not found: ${state.searchPattern}`;
      };

      const searchPrevious = (state: EditorState) => {
        if (!state.searchPattern) return;

        const startRow = state.cursorRow;
        const startCol = state.cursorCol - 1;

        // Search from current position backward to start of file
        for (let row = startRow; row >= 0; row--) {
          const line = state.lines[row];
          const searchEnd = row === startRow ? startCol : line.length - 1;

          // Search backward in the line
          for (let col = searchEnd; col >= 0; col--) {
            if (line.slice(col, col + state.searchPattern.length) === state.searchPattern) {
              state.cursorRow = row;
              state.cursorCol = col;
              state.message = `Found: ${state.searchPattern}`;
              return;
            }
          }
        }

        // Wrap to end of file
        for (let row = state.lines.length - 1; row >= startRow; row--) {
          const line = state.lines[row];
          const searchEnd = row === startRow ? line.length - 1 : line.length - 1;

          for (let col = searchEnd; col >= 0; col--) {
            if (line.slice(col, col + state.searchPattern.length) === state.searchPattern) {
              state.cursorRow = row;
              state.cursorCol = col;
              state.message = `Found: ${state.searchPattern} (wrapped)`;
              return;
            }
          }
        }

        state.message = `Pattern not found: ${state.searchPattern}`;
      };

      const handleSearchMode = async (key: string) => {
        if (key === '\x1b' || key === 'Escape') {
          // ESC - cancel search
          state.mode = 'normal';
          state.searchBuffer = '';
          return;
        }

        if (key === 'Enter' || key === '\r' || key === '\n') {
          // Execute search
          state.searchPattern = state.searchBuffer;
          state.mode = 'normal';

          if (state.searchPattern) {
            searchNext(state);
          }

          state.searchBuffer = '';
          return;
        }

        if (key === 'Backspace' || key === '\x7f') {
          // Delete character from search buffer
          state.searchBuffer = state.searchBuffer.slice(0, -1);
          if (state.searchBuffer.length === 0) {
            state.mode = 'normal';
          }
        } else if (key.length === 1 && key >= ' ') {
          // Add to search buffer
          state.searchBuffer += key;
        }
      };

      const handleCommandMode = async (key: string) => {
        if (key === '\x1b' || key === 'Escape') {
          // ESC - cancel command
          state.mode = 'normal';
          state.commandBuffer = '';
          return;
        }

        if (key === 'Enter' || key === '\r' || key === '\n') {
          // Execute command
          const cmd = state.commandBuffer.trim();

          if (cmd === 'w') {
            // Write file
            const content = state.lines.join('\n');
            await ctx.fs.writeFile(filepath, content);
            state.modified = false;
            state.message = `"${filename}" ${state.lines.length} lines written`;
          } else if (cmd === 'q') {
            // Quit
            if (state.modified) {
              state.message = 'No write since last change (use :q! to override)';
            } else {
              running = false;
              cleanup();
              resolve(0);
              return;
            }
          } else if (cmd === 'q!') {
            // Quit without saving
            running = false;
            cleanup();
            resolve(0);
            return;
          } else if (cmd === 'wq' || cmd === 'x') {
            // Write and quit
            const content = state.lines.join('\n');
            await ctx.fs.writeFile(filepath, content);
            running = false;
            cleanup();
            resolve(0);
            return;
          } else if (cmd) {
            // The editor's lines end with '' when the file ends with a newline
            ex.lines = state.lines.length > 1 && state.lines[state.lines.length - 1] === '' ? state.lines.slice(0, -1)
              : state.lines.length === 1 && state.lines[0] === '' ? [] : [...state.lines];
            ex.cur = Math.min(state.cursorRow + 1, ex.lines.length);
            ex.modified = state.modified;
            ex.quit = null;
            let said = '';
            await runExCommand(ex, cmd, {
              ...exIO(ctx, false),
              out: (t) => { said = t.trimEnd().split('\n').pop() ?? ''; },
              err: (t) => { said = t.trim(); },
              msg: (t) => { said = t.trim(); },
            });
            state.lines = [...ex.lines, ''];
            state.cursorRow = Math.max(0, Math.min(ex.cur - 1, state.lines.length - 1));
            state.cursorCol = 0;
            state.modified = ex.modified;
            if (said) state.message = said;
            if (ex.quit !== null) {
              running = false;
              cleanup();
              resolve(ex.quit);
              return;
            }
          }

          state.mode = 'normal';
          state.commandBuffer = '';
        } else if (key === 'Backspace' || key === '\x7f') {
          // Delete character from command buffer
          state.commandBuffer = state.commandBuffer.slice(0, -1);
          if (state.commandBuffer.length === 0) {
            state.mode = 'normal';
          }
        } else if (key.length === 1 && key >= ' ') {
          // Add to command buffer
          state.commandBuffer += key;
        }
      };

      // Cleanup function to exit raw mode and restore terminal
      const cleanup = () => {
        terminal.exitRawMode();
        write('\x1b[2J\x1b[H'); // Clear screen
      };

      // Handle keystroke from raw mode
      const onKey = async (key: string) => {
        if (!running) return;

        // Ctrl+C always exits (emergency escape)
        if (key === 'Ctrl+C') {
          running = false;
          cleanup();
          resolve(1);
          return;
        }

        state.message = ''; // Clear message

        if (state.mode === 'normal') {
          await handleNormalMode(key);
        } else if (state.mode === 'insert') {
          await handleInsertMode(key);
        } else if (state.mode === 'command') {
          await handleCommandMode(key);
        } else if (state.mode === 'search') {
          await handleSearchMode(key);
        }

        if (running) {
          render();
        }
      };

      // Enter raw mode to capture all keystrokes
      terminal.enterRawMode(onKey);

      // Initial render
      render();

      // The promise resolves when :q, :q!, or :wq is executed
      // The handleCommandMode function calls cleanup() and resolve() when quitting
    });
}

export const viCmd: Command = {
  name: 'vi',
  description: 'Minimal vi-like text editor',
  exec: (ctx) => viExec(ctx, false),
};

/** ex: vi in ex mode (vi -e). */
export const exCmd: Command = {
  name: 'ex',
  description: 'Line-oriented text editor (vi -e): ex commands from -c and stdin',
  exec: (ctx) => viExec(ctx, true),
};
