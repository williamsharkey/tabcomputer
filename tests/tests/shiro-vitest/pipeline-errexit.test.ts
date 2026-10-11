/**
 * Statuses and set -e around pipelines and empty commands, as bash:
 * a command whose words expand to nothing has the last $(…)'s status; set -e
 * and exit in a loop that is a pipeline element end that element (its
 * subshell); a pipeline element's word assignments stay in its subshell;
 * a `!` that came from an expansion is a command name, not negation.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;

beforeEach(async () => {
  ({ shell } = await createTestShell());
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('a command that expands to nothing', () => {
  it("has the last command substitution's status", async () => {
    expect((await sh('`false`; echo $?; $(true); echo $?; $(exit 42) $(exit 43); echo $?; true $(false); echo $?')).out)
      .toBe('1\n0\n43\n0\n');
    expect((await sh('e=; false; $e; echo $?')).out).toBe('0\n');
    expect((await sh('if `false`; then echo T; else echo F; fi')).out).toBe('F\n');
  });
});

describe('set -e and exit in a pipeline element', () => {
  it('a failing command ends a piped while loop (its subshell)', async () => {
    const r = await sh("set -e; printf 'a\\nb\\n' | while read l; do echo \"[$l]\"; false; done; echo after");
    expect(r.out).toBe('[a]\n');
    expect(r.code).toBe(1);
  });

  it('exit in a piped loop or group is that element\'s status', async () => {
    expect((await sh("printf 'a\\nb\\n' | while read l; do echo \"[$l]\"; exit 3; done; echo st=$?")).out).toBe('[a]\nst=3\n');
    expect((await sh("echo a | { cat; exit 4; }; echo st=$?")).out).toBe('a\nst=4\n');
  });
});

describe('pipeline elements are subshells', () => {
  it("their words' assignments stay there", async () => {
    expect((await sh('${cmd=echo} hi | wc -l; echo "cmd=$cmd"')).out).toBe('1\ncmd=\n');
    expect((await sh('i=0; echo $((i++)) | cat; echo i=$i')).out).toBe('0\ni=0\n');
  });
});

describe('negation', () => {
  it('a ! from an expansion is a command name', async () => {
    const r = await sh("v='!'; $v echo hi; echo st=$?");
    expect(r.out).toBe("tabcomputer: command not found: !\nst=127\n");
    expect((await sh('! false; echo $?')).out).toBe('0\n');
  });
});

describe('set -e in a new shell process', () => {
  // Claude Code's Bash tool runs `… && eval 'CMD' && pwd`: the caller's && list
  // suppressed set -e in every script it started
  it('applies though the caller is in an && list or a condition', async () => {
    await sh("printf 'set -e\\nfalse\\necho BAD\\n' > /tmp/errexit-child.sh");
    expect((await sh('true && bash /tmp/errexit-child.sh; echo rc=$?')).out).toBe('rc=1\n');
    expect((await sh('if bash /tmp/errexit-child.sh; then echo T; else echo F; fi')).out).toBe('F\n');
    expect((await sh("true && bash -c 'set -e; false; echo BAD'; echo rc=$?")).out).toBe('rc=1\n');
  });

  it('a subshell in a condition still ignores it', async () => {
    expect((await sh('set -e; if (false; echo in); then echo T; fi; echo after')).out).toBe('in\nT\nafter\n');
  });
});
