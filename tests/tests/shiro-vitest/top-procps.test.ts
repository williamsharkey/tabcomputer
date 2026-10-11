/**
 * tabcomputer#62: top -b prints procps-ng's layout as plain text (no escape
 * sequences), a blank line between frames; without -b or a terminal it fails
 * as procps's top does.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { topCmd } from '@shiro/commands/top';

async function sh(cmd: string) {
  const { shell } = await createTestShell();
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

describe('top (#62)', () => {
  it('-b: the summary and the task list, without escapes', async () => {
    const r = await sh('top -b -n 1');
    expect(r.code).toBe(0);
    expect(r.out).not.toMatch(/\x1b/);
    const lines = r.out.split('\n');
    expect(lines[0]).toMatch(/^top - \d\d:\d\d:\d\d up .+,  1 user,  load average: [\d.]+, [\d.]+, [\d.]+$/);
    expect(lines[1]).toMatch(/^Tasks: +\d+ total, +\d+ running, +\d+ sleeping, +\d+ stopped, +\d+ zombie$/);
    expect(lines[2]).toMatch(/^%Cpu\(s\): +[\d.]+ us, +[\d.]+ sy, +[\d.]+ ni, *[\d.]+ id, +[\d.]+ wa, +[\d.]+ hi, +[\d.]+ si, +[\d.]+ st $/);
    expect(lines[3]).toMatch(/^MiB Mem : +[\d.]+ total, +[\d.]+ free, +[\d.]+ used, +[\d.]+ buff\/cache {5}$/);
    expect(lines[4]).toMatch(/^MiB Swap: +[\d.]+ total, +[\d.]+ free, +[\d.]+ used\. +[\d.]+ avail Mem $/);
    expect(lines[5]).toBe('');
    expect(lines[6]).toBe('    PID USER      PR  NI    VIRT    RES    SHR S  %CPU  %MEM     TIME+ COMMAND');
    expect(lines[7]).toMatch(/^ +\d+ \S+ +20 +0 +\d+ +\d+ +\d+ [RSDZTI] +[\d.]+ +[\d.]+ +\d+:\d\d\.\d\d \S/);
  });

  it('-bn2: two frames a blank line apart; -w cuts lines with a +', async () => {
    const r = await sh('top -bn2 -d 0.05');
    expect(r.out.match(/^top - /gm)).toHaveLength(2);
    expect(r.out).toMatch(/\n\ntop - /);
    const w = await sh('top -b -n 1 -w 30');
    for (const l of w.out.split('\n')) expect(l.length).toBeLessThanOrEqual(30);
    expect(w.out).toMatch(/^ {4}PID USER {6}PR  NI {4}V\+$/m);
  });

  it('with neither -b nor a terminal: "failed tty get"', async () => {
    const r = await sh('top -n 1; echo st=$?');
    expect(r.err).toBe('top: failed tty get\n');
    expect(r.out).toBe('st=1\n');
  });

  it('on a terminal: a full-screen view that q leaves', async () => {
    let screen = '';
    let onKey: ((k: string) => void) | null = null;
    const terminal: any = {
      getSize: () => ({ rows: 24, cols: 80 }),
      writeOutput: (s: string) => { screen += s; },
      enterRawMode: (cb: (k: string) => void) => { onKey = cb; },
      exitRawMode: () => {},
      onResize: () => () => {},
    };
    const { fs } = await createTestShell();
    const ctx: any = { args: [], fs, cwd: '/', env: {}, stdin: '', stdout: '', stderr: '', terminal, stdoutIsTTY: true };
    const done = topCmd.exec(ctx);
    for (let i = 0; i < 50 && !/PID USER/.test(screen); i++) await new Promise((r) => setTimeout(r, 20));
    expect(screen).toContain('\x1b[?1049h');
    expect(screen).toMatch(/\x1b\[7m +PID USER/);
    onKey!('q');
    expect(await done).toBe(0);
  });
});
