/** The line printed under a restored terminal's scrollback (as a dim shell comment, terminal.ts restoreScreen) */
export const RESTORED_NOTE = '── the output above is from before the page reloaded ──';

/** The lines a note may have under its first (session.ts `followUp`) */
const NOTE_MORE = /^# (resuming (Claude Code|Codex)|started again|was running: )/;

/**
 * `lines` without the restore notes of earlier reloads. The next restore
 * prints the note anew under everything, so a terminal has one note however
 * often its page was reloaded: also when something was printed after an
 * earlier note (a command, a refused link's message), which used to keep that
 * note and add another under it at each reload.
 */
export function dropNotes(lines: string[]): string[] {
  const mark = `# ${RESTORED_NOTE}`;
  if (!lines.some((l) => l.trimEnd() === mark)) return lines;
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() !== mark) { out.push(lines[i]); continue; }
    while (i + 1 < lines.length && NOTE_MORE.test(lines[i + 1])) i++;
  }
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}
