import type { Terminal } from '@xterm/xterm';

/**
 * Answer the terminal queries xterm.js leaves unanswered, so a program that
 * asks and waits doesn't hang. Claude Code's fullscreen renderer stopped in a
 * blocking read of the tty right after the user turned it on, and xterm.js
 * answered DECRQM ?1016 (SGR pixel mouse) as recognized but stayed silent on
 * the follow-ups:
 * - window reports, CSI 14t / 16t / 18t / 19t: xterm.js implements them but has
 *   them off (`windowOptions`); text area and cell size in pixels, rows/cols
 * - XTVERSION, CSI > q: `DCS > | name ST`
 * - XTGETTCAP, DCS + q: "not found" (DCS 0 + r ST), as xterm does for names
 *   it doesn't know
 * The kitty keyboard query (CSI ? u) stays unanswered: a reply claims the
 * protocol, and programs would then expect CSI u key encoding xterm.js
 * doesn't send; they fall back after the DA1 that follows it.
 */
export function installTermQueries(term: Terminal): void {
  term.options.windowOptions = {
    ...term.options.windowOptions,
    getWinSizePixels: true,
    getCellSizePixels: true,
    getWinSizeChars: true,
    getScreenSizeChars: true,
  };
  term.parser.registerCsiHandler({ prefix: '>', final: 'q' }, (params) => {
    if ((params[0] ?? 0) !== 0) return false;
    term.input('\x1bP>|tabcomputer(xterm.js)\x1b\\', false);
    return true;
  });
  term.parser.registerDcsHandler({ intermediates: '+', final: 'q' }, () => {
    term.input('\x1bP0+r\x1b\\', false);
    return true;
  });
}
