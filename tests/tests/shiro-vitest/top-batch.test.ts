/**
 * tabcomputer#62: `top -b` printed bold, colour and reverse-video escapes.
 * procps top in batch mode writes plain text; so does a snapshot whose output
 * isn't the terminal (`top | head`). The interactive screen keeps its colours.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { topCmd } from '@shiro/commands/top';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

const ESC = '\x1b';

/** A terminal that records what is written to it */
function fakeTerminal() {
  const written: string[] = [];
  let rawKey: ((k: string) => void) | null = null;
  return {
    written,
    get raw() { return rawKey !== null; },
    getSize: () => ({ rows: 24, cols: 80 }),
    writeOutput: (s: string) => { written.push(s); },
    enterRawMode: (onKey: (k: string) => void) => { rawKey = onKey; },
    exitRawMode: () => { rawKey = null; },
    onResize: () => () => {},
  };
}

describe('top output (#62)', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeEach(async () => { ({ shell, fs } = await createTestShell()); });

  it('top -b prints plain text: no escape sequences', async () => {
    const r = await run(shell, 'top -b -n 1');
    expect(r.exitCode).toBe(0);
    // (what reaches the terminal has \r\n, as a tty's onlcr makes of every program's \n)
    const out = r.output.replace(/\r\n/g, '\n');
    expect(out).toMatch(/^top - \d\d:\d\d:\d\d up /);
    expect(out).toContain('  PID  STATUS     TIME  COMMAND\n');
    expect(out).not.toContain(ESC);
  });

  it('into a file or a pipe, top -b writes plain \\n lines: no \\r, no escapes', async () => {
    await fs.mkdir('/tmp/top62', { recursive: true } as any);
    await run(shell, 'top -b -n 1 > /tmp/top62/file.txt; top -b -n 1 | cat > /tmp/top62/pipe.txt');
    for (const p of ['/tmp/top62/file.txt', '/tmp/top62/pipe.txt']) {
      const text = (await fs.readFile(p, 'utf8')) as string;
      expect(text, p).toMatch(/^top - .*\nTasks: .*\n/);
      expect(text, p).toContain('\n  PID  STATUS     TIME  COMMAND\n');
      expect(text, p).not.toContain('\r');
      expect(text, p).not.toContain(ESC);
    }
    await fs.rm('/tmp/top62', { recursive: true } as any).catch(() => {});
  });

  it('in a pipe too (top -b | head, top | head)', async () => {
    for (const cmd of ['top -b -n 1 | head -3', 'top -n 1 | head -3']) {
      const r = await run(shell, cmd);
      expect(r.output, cmd).toMatch(/^top - /);
      expect(r.output, cmd).not.toContain(ESC);
    }
  });

  it("with a terminal but output that isn't it: one plain snapshot, the terminal left alone", async () => {
    const term = fakeTerminal();
    const ctx: any = { args: ['-n', '1'], fs: null, cwd: '/', env: {}, stdin: '', stdout: '', stderr: '', shell, terminal: term, stdoutIsTTY: false };
    expect(await topCmd.exec(ctx)).toBe(0);
    expect(ctx.stdout).toMatch(/^top - /);
    expect(ctx.stdout).not.toContain(ESC);
    expect(term.written).toEqual([]); // (no alternate screen, no raw mode)
  });

  it('the interactive screen keeps its colours, and -n 1 leaves no render timer behind', async () => {
    const term = fakeTerminal();
    const ctx: any = { args: ['-n', '1', '-d', '0.05'], fs: null, cwd: '/', env: {}, stdin: '', stdout: '', stderr: '', shell, terminal: term, stdoutIsTTY: true };
    // The intervals it starts, and which of them are cleared
    const g = globalThis as any;
    const realSet = g.setInterval, realClear = g.clearInterval;
    const open = new Set<unknown>();
    g.setInterval = (...a: unknown[]) => { const id = realSet(...a); open.add(id); return id; };
    g.clearInterval = (id: unknown) => { open.delete(id); return realClear(id); };
    try {
      expect(await topCmd.exec(ctx)).toBe(0);
    } finally {
      g.setInterval = realSet;
      g.clearInterval = realClear;
    }
    for (const id of open) realClear(id); // (don't leak it from the test either)
    const screen = term.written.join('');
    expect(screen).toContain(`${ESC}[1mtop${ESC}[0m - `);
    expect(screen).toContain(`${ESC}[7m  PID  STATUS`);
    // (its interval used to start after the last render's cleanup, never to be cleared)
    expect(open.size).toBe(0);
  });
});
