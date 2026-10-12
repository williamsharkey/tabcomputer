/**
 * A terminal's screen after a reload (terminal.ts restoreScreen, desktop/session.ts):
 * the old output, a dim comment under it, a fresh prompt at the bottom, and
 * nothing that rewrites the welcome banner's old row over the restored text.
 */
import { describe, it, expect } from 'vitest';
import { createTestOS } from './helpers';

const screen = (t: any) => {
  const b = t.term.buffer.active;
  const out: string[] = [];
  for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
  return out;
};
const flush = (t: any) => new Promise<void>((r) => t.term.write('', r));

describe('restoreScreen', () => {
  it('shows the old output, then the note as shell comments, then the prompt', async () => {
    const { terminal } = await createTestOS();
    terminal.restoreScreen('user@tab:~$ ls\na.txt  b.txt', 'line one\r\nline two');
    await flush(terminal);
    const lines = screen(terminal).filter((l) => l.trim());
    expect(lines.slice(0, 4)).toEqual(['user@tab:~$ ls', 'a.txt  b.txt', '# line one', '# line two']);
    expect(lines[4]).toMatch(/\$ $/);
  });

  it('forgets the banner it drew before, so status updates never write over the restored text', async () => {
    const { terminal } = await createTestOS();
    const t: any = terminal;
    t.drawHud();
    await flush(t);
    expect(t.isHudVisible()).toBe(true);
    t.restoreScreen('first restored line\nsecond restored line', 'restored');
    await flush(t);
    expect(t.isHudVisible()).toBe(false);
    t.updateHudRemoteCode('some-code');
    t.updateHudAt(0, 1, 'XXXX');
    await flush(t);
    expect(screen(t).slice(0, 2)).toEqual(['first restored line', 'second restored line']);
  });

  it('rememberCommand puts a line on the shell history once', async () => {
    const { terminal, shell } = await createTestOS();
    terminal.rememberCommand('claude --resume abc');
    terminal.rememberCommand('claude --resume abc');
    expect(shell.history.filter((h) => h === 'claude --resume abc').length).toBe(1);
    expect(shell.history.at(-1)).toBe('claude --resume abc');
  });
});
