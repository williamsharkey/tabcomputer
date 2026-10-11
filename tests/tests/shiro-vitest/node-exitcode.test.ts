/**
 * process.exitCode reads back what was set (undefined until then), and
 * process.exit() with no code exits with it, as node. vitest 3 ends a failed
 * start with `if (process.exitCode == null) process.exitCode = 1; process.exit()`,
 * which exited 0, so `npx vitest run` said success after a startup error.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;
beforeAll(async () => { ({ shell } = await createTestShell()); });
const node = async (code: string) => {
  const r = await run(shell, `node -e '${code}' < /dev/null; echo "rc=$?"`);
  return r.output.replace(/\r\n/g, '\n').trim();
};

describe('process.exitCode', () => {
  it('is undefined until set, then reads back', async () => {
    expect(await node(`console.log(process.exitCode); process.exitCode = 3; console.log(process.exitCode); process.exitCode = 0`)).toBe('undefined\n3\nrc=0');
  });
  it("process.exit() with no code uses it (vitest's failed start)", async () => {
    expect(await node(`if (process.exitCode == null) process.exitCode = 1; process.exit()`)).toBe('rc=1');
    expect(await node(`process.exitCode = 4; process.exit()`)).toBe('rc=4');
  });
  it('process.exit(code) still wins, and the script ending uses exitCode', async () => {
    expect(await node(`process.exitCode = 4; process.exit(2)`)).toBe('rc=2');
    expect(await node(`process.exitCode = 5`)).toBe('rc=5');
    expect(await node(`process.exit()`)).toBe('rc=0');
  });
});
