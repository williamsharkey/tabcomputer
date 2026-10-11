/**
 * node-compat's process.kill on the process itself: signal 0 asks whether it
 * exists (it does) and ends nothing. Claude Code asks it of the pid in a
 * session file, which after a reload can be the asking process's own: it
 * ended with status 128 at the resumed session's start.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';

describe('process.kill(process.pid, …)', () => {
  it('signal 0: true, and the process goes on', async () => {
    const { shell } = await createTestShell();
    const r = await run(shell, `node -e "console.log(process.kill(process.pid, 0)); console.log('alive')"; echo "status $?"`);
    expect(r.output.replace(/\r/g, '')).toContain('true\nalive\nstatus 0');
  });

  it('SIGTERM still ends it, with 143', async () => {
    const { shell } = await createTestShell();
    const r = await run(shell, `node -e "process.kill(process.pid, 'SIGTERM'); setTimeout(() => console.log('still here'), 50)"; echo "status $?"`);
    expect(r.output).not.toContain('still here');
    expect(r.output).toContain('status 143');
  });
});
