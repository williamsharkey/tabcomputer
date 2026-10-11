import { Command, CommandContext } from './index';
import { ExSession, ExError, newBuffer, type ExHost, type ExResult } from './ex-engine';

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

export const viCmd: Command = {
  name: 'vi',
  description: 'Minimal vi-like text editor',

  async exec(ctx: CommandContext): Promise<number> {
    // vim's options: -c CMD and +CMD (run after loading), +N, -e/-E (ex mode:
    // commands from stdin), -s (silent, with -e), and the ones that change nothing here
    const cmds: string[] = [];
    let exMode = false, silent = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a === '-c' || a === '--cmd') { cmds.push(args[++i] ?? ''); continue; }
      if (a.startsWith('+')) { cmds.push(a === '+' ? '$' : a.slice(1)); continue; } // +N, +/pat, +cmd
      if (a === '-u' || a === '-U' || a === '-T' || a === '-i' || a === '-w' || a === '-W' || a === '-S' || a === '-t' || a === '-q') { i++; continue; }
      if (a.startsWith('--')) continue; // --clean, --noplugin, --not-a-term, ...
      if (a.startsWith('-') && a.length > 1) {
        for (let k = 1; k < a.length; k++) {
          const ch = a[k];
          if (ch === 'e' || ch === 'E') exMode = true;
          else if (ch === 's') silent = true;
          else if (ch === 'c') { cmds.push(a.slice(k + 1) || (args[++i] ?? '')); break; } // -sc CMD
        }
        continue;
      }
      files.push(a);
    }
    if (ctx.args[0] === undefined && !ctx.terminal) {
      ctx.stderr += 'Usage: vi [file]\n';
      return 1;
    }

    const filename = files[0] ?? '';
    const filepath = filename ? ctx.fs.resolvePath(filename, ctx.cwd) : '';
    const readText = async (path: string) => { try { return await ctx.fs.readFile(path, 'utf8') as string; } catch { return null; } };
    const initial = filepath ? await readText(filepath) : null;
    const buf = newBuffer(filename, filepath, initial);
    if (exMode) buf.cur = buf.lines.length - 1; // ex starts on the last line

    const script = exMode ? (ctx.readStdin ? await ctx.readStdin() : ctx.stdin ?? '').split('\n') : [];
    let scriptAt = 0;
    const host: ExHost = {
      readFile: readText,
      writeFile: async (path, text, append) => {
        const old = append ? (await readText(path)) ?? '' : '';
        await ctx.fs.writeFile(path, old + text);
      },
      resolve: (p) => ctx.fs.resolvePath(p, ctx.cwd),
      print: (t) => { ctx.stdout += t; },
      message: (t) => { if (!silent) ctx.stdout += t; },
      run: ctx.shell ? async (cmd, input) => {
        const tmp = `/tmp/.vi-filter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
        await ctx.fs.writeFile(tmp, input);
        let out = '';
        await ctx.shell!.execute(`{ ${cmd}\n} < ${tmp}`, (o: string) => { out += o.replace(/\r\n/g, '\n'); }, (e: string) => { ctx.stderr += e.replace(/\r\n/g, '\n'); });
        await ctx.fs.unlink(tmp).catch(() => {});
        return out;
      } : undefined,
      nextLine: () => (scriptAt < script.length ? script[scriptAt++] : null),
    };
    const session = new ExSession(buf, host);
    let failed = false;
    const runEx = async (line: string): Promise<ExResult> => {
      try { return await session.run(line); }
      catch (e) {
        if (!(e instanceof ExError)) throw e;
        failed = true;
        if (!silent) ctx.stderr += e.message + '\n';
        return { quit: false };
      }
    };

    for (const c of cmds) {
      const r = await runEx(c);
      if (r.quit) return r.code || (exMode && failed ? 1 : 0);
    }
    if (exMode) {
      // the script on stdin, a command a line; its end quits without writing
      while (scriptAt < script.length) {
        const line = script[scriptAt++];
        if (scriptAt === script.length && line === '') break;
        const r = await runEx(line);
        if (r.quit) return r.code || (failed ? 1 : 0);
      }
      return failed ? 1 : 0;
    }

    if (!ctx.terminal) {
      if (cmds.length) {
        // what vim does when its commands leave it running with no terminal to read
        ctx.stderr += 'Vim: Error reading input, exiting...\n';
        return 1;
      }
      ctx.stderr += 'vi: terminal not available for interactive editing\n';
      ctx.stderr += 'Run its commands instead: vi -c \'%s/old/new/g\' -c wq FILE, or ex -s FILE with commands on stdin (vi -es).\n';
      return 1;
    }

    const fileExists = initial !== null;
    const state: EditorState = {
      lines: buf.lines.map((l) => l.t),
      cursorRow: exMode ? buf.cur : Math.max(0, Math.min(buf.cur, buf.lines.length - 1)),
      cursorCol: 0,
      mode: 'normal',
      commandBuffer: '',
      lastKey: '',
      modified: buf.modified,
      scrollOffset: 0,
      message: !filename ? '' : fileExists ? `"${filename}" ${buf.lines.length}L, ${initial!.length}B` : `"${filename}" [New]`,
      searchPattern: '',
      searchBuffer: '',
    };

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
          // the editor's lines into the ex buffer, the command, and back
          const before = state.lines.join('\n');
          if (before !== buf.lines.map((l) => l.t).join('\n')) { buf.lines = state.lines.map((t) => ({ t })); buf.empty = false; }
          buf.cur = state.cursorRow;
          buf.modified = state.modified;
          let r: ExResult = { quit: false };
          try { r = await session.run(cmd); }
          catch (e) { state.message = e instanceof Error ? e.message : String(e); }
          state.lines = buf.lines.map((l) => l.t);
          state.cursorRow = Math.max(0, Math.min(buf.cur, state.lines.length - 1));
          state.cursorCol = Math.min(state.cursorCol, Math.max(0, state.lines[state.cursorRow].length - 1));
          state.modified = buf.modified;
          if (r.quit) {
            running = false;
            cleanup();
            resolve(r.code);
            return;
          }
          if (!state.message && /^(w|wr|wri|writ|write|up|update)!?(\s|$)/.test(cmd)) state.message = `"${buf.name}" ${state.lines.length}L written`;
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
  },
};
