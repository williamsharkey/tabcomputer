/**
 * tabcomputer#97: an empty script file is a program that does nothing. node
 * exits 0 with no output; "no input provided" is only for no program at all.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('node with an empty script file (#97)', () => {
  it('exits 0 and prints nothing', async () => {
    const { shell, fs } = await createTestShell();
    await fs.writeFile('/tmp/empty97.js', '');
    await fs.writeFile('/tmp/empty97.mjs', '');
    for (const f of ['/tmp/empty97.js', '/tmp/empty97.mjs']) {
      const { output } = await run(shell, `node ${f} < /dev/null; echo rc=$?`);
      expect(output.replace(/\r/g, ''), f).toBe('rc=0\n');
    }
  });

  it('a missing script still fails', async () => {
    const { shell } = await createTestShell();
    const { output } = await run(shell, 'node /tmp/no-such-97.js < /dev/null; echo rc=$?');
    expect(output).toContain('Cannot find module');
    expect(output).toContain('rc=1');
  });
});
