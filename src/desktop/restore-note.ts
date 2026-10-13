/** The line printed under a restored terminal's scrollback (as a dim shell comment, terminal.ts restoreScreen) */
export const RESTORED_NOTE = '── the output above is from before the page reloaded ──';

/**
 * `lines` without the restore notes at their end: a terminal that was only
 * reloaded again gets one note under its output, not one per reload.
 */
export function dropTrailingNotes(lines: string[]): string[] {
  const mark = `# ${RESTORED_NOTE}`;
  let end = lines.length;
  for (;;) {
    let i = end - 1;
    // (the note's other lines, "# resuming …", sit under the mark)
    while (i >= 0 && lines[i].trimEnd() !== mark && lines[i].startsWith('# ')) i--;
    if (i < 0 || lines[i].trimEnd() !== mark) break;
    end = i;
    while (end > 0 && !lines[end - 1].trim()) end--;
  }
  return end === lines.length ? lines : lines.slice(0, end);
}
