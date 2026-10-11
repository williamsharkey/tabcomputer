/**
 * `ex`: vi in ex mode, as Vim's ex (ex-engine.ts runs the commands). A
 * script on stdin, -s silent, -c commands; without it `ex` was "command not
 * found" though scripts use `ex -s FILE <<EOF` (the #62 follow-up).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';
import { viCmd, exCmd } from '@shiro/commands/vi';

describe('ex', () => {
  let shell: Shell;
  let fs: FileSystem;
  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    shell.commands.register(viCmd);
    shell.commands.register(exCmd);
    await fs.writeFile('/tmp/ex.txt', 'line1\nline2\nline3\n');
  });
  const read = async () => (await fs.readFile('/tmp/ex.txt', 'utf8')) as string;

  it('ex -s FILE with a here-doc script', async () => {
    const r = await run(shell, "ex -s /tmp/ex.txt <<'EOF'\n%s/line/L/g\n2d\nwq\nEOF\necho rc=$?");
    expect(r.output).toContain('rc=0');
    expect(await read()).toBe('L1\nL3\n');
  });

  it('ex -s FILE < script', async () => {
    await fs.writeFile('/tmp/ex.script', 'g/2/d\nw\nq\n');
    await run(shell, 'ex -s /tmp/ex.txt < /tmp/ex.script');
    expect(await read()).toBe('line1\nline3\n');
  });

  it("ex -s -c '%p' -c 'q!' prints the file and changes nothing", async () => {
    const r = await run(shell, "ex -s -c '%p' -c 'q!' /tmp/ex.txt < /dev/null");
    expect(r.output.replace(/\r\n/g, '\n')).toContain('line1\nline2\nline3\n');
    expect(await read()).toBe('line1\nline2\nline3\n');
  });
});
