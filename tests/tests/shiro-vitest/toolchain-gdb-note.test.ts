/**
 * tabcomputer#108: gdb can't start a program (ptrace is ENOSYS). Until it
 * can, the c set doesn't advertise gdb, and `toolchain list` (and install)
 * say so in a note.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
import { KNOWN_ISSUES } from '@shiro/agent-docs';

describe('toolchain c and gdb (#108)', () => {
  it('toolchain list: gdb is not in the description, a note says why', async () => {
    const { shell } = await createTestShell();
    const r = await run(shell, 'toolchain list');
    expect(r.exitCode).toBe(0);
    const lines = r.output.replace(/\r/g, '').split('\n');
    const i = lines.findIndex((l) => /^c\s/.test(l));
    expect(lines[i]).toMatch(/C and C\+\+: gcc, g\+\+, make, cmake, pkg-config/);
    expect(lines[i]).not.toContain('gdb');
    expect(lines[i + 1].trim()).toBe("note: gdb is installed but can't run programs yet (no ptrace, tabcomputer#108)");
  });

  it('agents on the machine are told', () => {
    expect(KNOWN_ISSUES.some((k) => /gdb/.test(k.issue) && /tabcomputer#108/.test(k.issue))).toBe(true);
  });
});
