/**
 * tabcomputer#108: gdb couldn't start a program (ptrace is ENOSYS), and the c
 * set said so in a note. gdb now debugs through the x86 engine's debug stub
 * (docs/research/GDB.md, gdb.test.ts), so the set advertises it again; what
 * it still can't do is in the agents' known issues.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell, run } from './helpers';
import { KNOWN_ISSUES } from '@shiro/agent-docs';

describe('toolchain c and gdb (#108)', () => {
  it('toolchain list: gdb is in the description, with no note', async () => {
    const { shell } = await createTestShell();
    const r = await run(shell, 'toolchain list');
    expect(r.exitCode).toBe(0);
    const lines = r.output.replace(/\r/g, '').split('\n');
    const i = lines.findIndex((l) => /^c\s/.test(l));
    expect(lines[i]).toMatch(/C and C\+\+: gcc, g\+\+, make, cmake, gdb, pkg-config/);
    expect(lines[i + 1] ?? '').not.toMatch(/note:/);
  });

  it('agents on the machine are told what gdb does not do', () => {
    const k = KNOWN_ISSUES.filter((x) => /gdb/.test(x.issue));
    expect(k.length).toBe(1);
    expect(k[0].issue).toMatch(/main thread only/);
    expect(k[0].issue).toMatch(/no ptrace/);
    expect(k[0].issue).not.toMatch(/can't run a program/);
  });
});
