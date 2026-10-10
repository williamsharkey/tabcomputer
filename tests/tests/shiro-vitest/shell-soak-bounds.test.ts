/**
 * What a long agent session (thousands of short commands) leaves in the page
 * shell stays bounded: history in memory and finished background jobs
 * (bench/soak.mjs found these growing).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;

beforeAll(async () => {
  ({ shell } = await createTestShell());
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, () => {});
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('soak bounds', () => {
  it('history in memory stays within twice maxHistorySize', async () => {
    const s = shell as unknown as { history: string[]; maxHistorySize: number; addToHistory?(c: string): void };
    const max = s.maxHistorySize;
    for (let i = 0; i < max * 2 + 50; i++) await sh(`true ${i}`);
    expect(s.history.length).toBeLessThan(max * 2);
    expect(s.history.length).toBeGreaterThanOrEqual(max);
    expect(s.history[s.history.length - 1]).toBe(`true ${max * 2 + 49}`);
  });

  it('a finished job keeps its status, not its shell', async () => {
    // (not waited for: wait removes the job it reports)
    await sh('true &');
    await new Promise((r) => setTimeout(r, 50));
    const jobs = [...(shell as unknown as { backgroundJobs: Map<number, { status: string; shell?: unknown }> }).backgroundJobs.values()];
    const done = jobs.filter((j) => j.status === 'done');
    expect(done.length).toBeGreaterThan(0);
    for (const j of done) expect(j.shell).toBeUndefined();
  });

  it('at most 256 finished jobs are kept; wait still reports the latest', async () => {
    await sh(`for i in $(seq 300); do true & done`);
    await new Promise((r) => setTimeout(r, 200));
    await sh('true &');
    const table = (shell as unknown as { backgroundJobs: Map<number, unknown> }).backgroundJobs;
    expect(table.size).toBeLessThanOrEqual(256);
    const r = await sh('(exit 3) & p=$!; wait $p; echo st=$?');
    expect(r.out).toContain('st=3');
  });
});
