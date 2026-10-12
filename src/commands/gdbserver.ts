import type { Command } from './index';

/**
 * gdb's remote protocol for x86-64 programs (src/x86-engine/gdbserver.ts).
 * gdb starts it with `target extended-remote | exec tabcomputer-gdbserver`,
 * which /etc/gdb/gdbinit.d/tabcomputer.gdb does at `run`.
 */
export const gdbserverCmd: Command = {
  name: 'tabcomputer-gdbserver',
  description: 'Debug stub gdb connects to (target extended-remote | tabcomputer-gdbserver)',
  async exec(ctx) {
    ctx.stderr += 'tabcomputer-gdbserver: gdb runs this (target extended-remote | exec tabcomputer-gdbserver); it speaks gdb\'s remote protocol on stdin/stdout\n';
    return 1;
  },
  async program(proc, kernel) {
    const { gdbServerProgram } = await import('../x86-engine/gdbserver');
    return gdbServerProgram(proc, kernel);
  },
};
