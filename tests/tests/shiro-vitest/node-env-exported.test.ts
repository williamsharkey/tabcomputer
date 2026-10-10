import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

// node's process.env is what a program started from the shell gets: exported
// variables only. It carried the shell's readonly, unexported SHELLOPTS and
// BASHOPTS too; codex passed them on and its shell snapshot failed with
// "export: BASHOPTS: readonly variable".
describe("node's process.env", () => {
  const run = async (cmd: string) => {
    const { shell } = await createTestShell();
    let out = '';
    await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
    return out.replace(/\r\n/g, '\n');
  };
  const show = `node -e 'for (const k of ["BASHOPTS", "SHELLOPTS", "MINE", "EXP", "ONCE"]) console.log(k + "=" + (process.env[k] ?? "unset"))'`;

  it('has exported variables and per-command assignments, not shell-only ones', async () => {
    const out = await run(`MINE=local; export EXP=exported; ONCE=cmd ${show}`);
    expect(out).toBe('BASHOPTS=unset\nSHELLOPTS=unset\nMINE=unset\nEXP=exported\nONCE=cmd\n');
  }, 60_000);

  it('a shell variable set for one command reaches it', async () => {
    expect(await run(`MINE=a; MINE=b ${show}`)).toContain('MINE=b\n');
  }, 60_000);
});
