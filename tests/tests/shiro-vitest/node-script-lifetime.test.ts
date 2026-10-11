/**
 * Claude Code runs for hours while its Bash tool starts short node scripts. A
 * child is idle by its own activity, not its parent's; the script timeout ends
 * only an idle script; and stat gives a file another process wrote its own
 * mtime, the same on every call, so Claude's Edit sees no phantom change.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('node: script lifetime', () => {
  it('a child exits promptly while its parent keeps fs.promises busy', async () => {
    const { shell, fs } = await createTestShell();
    await run(shell, 'rm -rf /tmp/life-idle && mkdir -p /tmp/life-idle');
    await fs.writeFile('/tmp/life-idle/data.txt', 'x');
    await fs.writeFile('/tmp/life-idle/parent.mjs', `
      import { spawn } from 'child_process';
      import { promises as fsp } from 'fs';
      let busy = true;
      const churn = (async () => {
        while (busy) {
          await fsp.readFile('/tmp/life-idle/data.txt', 'utf8');
          await new Promise((r) => setImmediate(r));
        }
      })();
      const t0 = Date.now();
      const child = spawn('/bin/sh', ['-c', 'node -e "console.log(42)"'], { stdio: 'pipe' });
      const code = await new Promise((r) => child.on('close', r));
      const ms = Date.now() - t0;
      busy = false;
      await churn;
      console.log('CHILD code=' + code + ' fast=' + (ms < 6000));
    `);
    const { output } = await run(shell, 'node /tmp/life-idle/parent.mjs');
    expect(output).toContain('CHILD code=0 fast=true');
  }, 40000);

  it('a top-level await still working past 15 s finishes with its output', async () => {
    const { shell, fs } = await createTestShell();
    await run(shell, 'rm -rf /tmp/life-slow && mkdir -p /tmp/life-slow');
    await fs.writeFile('/tmp/life-slow/slow.mjs', `
      for (let i = 0; i < 17; i++) await new Promise((r) => setTimeout(r, 1000));
      console.log('DONE');
    `);
    const { output, exitCode } = await run(shell, 'node /tmp/life-slow/slow.mjs');
    expect(output).toContain('DONE');
    expect(exitCode).toBe(0);
  }, 40000);

  it('stat of a file written outside the script: one mtime, across calls', async () => {
    const { shell, fs } = await createTestShell();
    await run(shell, 'rm -rf /tmp/life-mt && mkdir -p /tmp/life-mt && echo before > /tmp/life-mt/early.txt');
    const early = (await fs.stat('/tmp/life-mt/early.txt')).mtime.getTime();
    await fs.writeFile('/tmp/life-mt/stat.mjs', `
      import fs from 'fs';
      console.log('EARLY ' + Math.floor(fs.statSync('/tmp/life-mt/early.txt').mtimeMs));
      fs.writeFileSync('/tmp/life-mt/ready', '1');
      let a;
      for (let i = 0; i < 250 && a === undefined; i++) {
        await new Promise((r) => setTimeout(r, 20));
        a = fs.statSync('/tmp/life-mt/late.txt', { throwIfNoEntry: false })?.mtimeMs;
      }
      await new Promise((r) => setTimeout(r, 60));
      const b = fs.statSync('/tmp/life-mt/late.txt').mtimeMs;
      const c = (await fs.promises.stat('/tmp/life-mt/late.txt')).mtimeMs;
      console.log(a !== undefined && a === b && b === c ? 'STABLE' : 'CHANGED ' + a + ' ' + b + ' ' + c);
      console.log('LATE ' + Math.floor(b));
    `);
    await sleep(30);
    const done = run(shell, 'node /tmp/life-mt/stat.mjs');
    // Written after the script started (so not preloaded), as the shell or git would
    for (let i = 0; i < 500 && !(await fs.exists('/tmp/life-mt/ready')); i++) await sleep(10);
    await fs.writeFile('/tmp/life-mt/late.txt', 'written outside the script');
    const { output } = await done;
    expect(output).toContain('STABLE');
    expect(output).toContain('EARLY ' + Math.floor(early));
    expect(output).toContain('LATE ' + Math.floor((await fs.stat('/tmp/life-mt/late.txt')).mtime.getTime()));
  }, 30000);
});
