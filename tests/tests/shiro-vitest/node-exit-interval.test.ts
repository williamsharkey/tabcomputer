/**
 * tabcomputer#105: process.exit(N) in a setInterval callback exits N silently,
 * as in a setTimeout callback. A Worker guest printed `node: process.exit(7)`
 * and exited 1; the page's node left the exit as an uncaught error.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;
beforeAll(async () => { ({ shell } = await createTestShell()); });

describe('process.exit() in a timer callback', () => {
  it('setInterval', async () => {
    const r = await run(shell, `node -e 'setInterval(() => process.exit(7), 50)' < /dev/null; echo "rc=$?"`);
    expect(r.output.replace(/\r\n/g, '\n').trim()).toBe('rc=7');
  });
  it('setTimeout', async () => {
    const r = await run(shell, `node -e 'setTimeout(() => process.exit(6), 50)' < /dev/null; echo "rc=$?"`);
    expect(r.output.replace(/\r\n/g, '\n').trim()).toBe('rc=6');
  });
});
