/**
 * The freeze watchdog (src/watchdog.ts): lag and long-task events carry the
 * shell commands in flight, nested ones innermost first, and the ring stays
 * bounded.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  noteLag, noteLongTask, diagnostics, formatDiagnostics, clearWatchdog, clearActive,
  commandStarted, commandEnded, activeCommands, snapshot, LAG_RECORD_MS, STALL_MS, abortForeground,
} from '@shiro/watchdog';
import { createTestShell } from './helpers';

describe('freeze watchdog', () => {
  beforeEach(() => { clearWatchdog(); clearActive(); });

  it('records lag past the threshold, as a stall when long, with commands in flight', () => {
    const outer = commandStarted('claude', 0);
    const inner = commandStarted('runaway_fn', 1);
    noteLag(10);
    noteLag(LAG_RECORD_MS + 5);
    noteLag(STALL_MS + 100);
    const d = diagnostics({ kind: 'lag,stall' });
    expect(d.events.map((e) => e.kind)).toEqual(['lag', 'stall']);
    expect(d.events[1].active![0]).toMatch(/runaway_fn$/); // innermost first
    expect(d.lag.maxMs1m).toBe(STALL_MS + 100);
    expect(d.lag.samples1m).toBe(3);
    commandEnded(inner, 0);
    commandEnded(outer, 0);
    expect(activeCommands()).toEqual([]);
  });

  it('a stall names a command that froze the page and returned before the heartbeat', () => {
    const id = commandStarted("js-eval 'busy 4s'", 0);
    commandEnded(id, 0);
    noteLag(STALL_MS + 2000);
    const stall = diagnostics({ kind: 'stall' }).events[0];
    expect(stall.active!.join('\n')).toContain("js-eval 'busy 4s'");
  });

  it('counts long tasks and records only the long ones', () => {
    noteLongTask(60);
    noteLongTask(900, Date.now(), 'cli.js');
    const d = diagnostics();
    expect(d.longTasks).toMatchObject({ count1m: 2, ms1m: 960, count: 2, maxMs: 900 });
    expect(d.events.filter((e) => e.kind === 'longtask')).toHaveLength(1);
    expect(formatDiagnostics(d)).toContain('longtask 900ms cli.js');
  });

  it('keeps the ring bounded and filters by kind, time and limit', () => {
    for (let i = 0; i < 5000; i++) noteLag(LAG_RECORD_MS + i);
    const d = diagnostics({ limit: 1e9 });
    expect(d.events.length).toBeLessThanOrEqual(1500);
    expect(d.dropped).toBeGreaterThan(0);
    expect(diagnostics({ limit: 5 }).events).toHaveLength(5);
    expect(diagnostics({ since: Date.now() + 60_000 }).events).toHaveLength(0);
    expect(diagnostics({ kind: 'cmd' }).events).toHaveLength(0);
  });

  it('logs top-level shell commands, and nested lines while they run', async () => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute('f() { g; }; g() { echo inner; }; f', (s) => { out += s; });
    await shell.execute('false', () => {});
    expect(out).toContain('inner');
    const cmds = diagnostics({ kind: 'cmd,cmd-end' }).events;
    expect(cmds.filter((e) => e.kind === 'cmd').map((e) => e.text)).toEqual(['f() { g; }; g() { echo inner; }; f', 'false']);
    // a failing top-level command is logged with its status
    expect(cmds.find((e) => e.kind === 'cmd-end')?.text).toBe('1 false');
    expect(activeCommands()).toEqual([]);

    // While a function body runs, the line it was called from is in flight too
    const running = shell.execute('slow() { sleep 0.4; }; slow', () => {});
    await new Promise((r) => setTimeout(r, 150));
    const lines = activeCommands().map((c) => c.line);
    await running;
    expect(lines.at(-1)).toBe('slow() { sleep 0.4; }; slow');
    expect(activeCommands()).toEqual([]);
  }, 30_000);

  it('a snapshot names what is running, for the worker to save', () => {
    commandStarted('source ~/.profile', 0);
    commandStarted('while true; do :; done', 1);
    const s = snapshot();
    expect(s.active.map((a) => a.line)).toEqual(['while true; do :; done', 'source ~/.profile']);
    expect(s.recent).toContain('source ~/.profile');
  });

  it('abortForeground stops a running shell command like Ctrl-C', async () => {
    const { shell } = await createTestShell();
    const t0 = Date.now();
    const running = shell.execute('slow() { sleep 20; }; slow; echo after', () => {});
    await new Promise((r) => setTimeout(r, 200));
    const hit = abortForeground('test');
    expect(hit.join('\n')).toContain('slow() { sleep 20; }');
    const code = await running;
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(code).toBe(130);
    expect(diagnostics({ kind: 'note' }).events.at(-1)!.text).toMatch(/watchdog abort \(test\)/);
  }, 30_000);
});
