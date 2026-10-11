/**
 * `{` and `}` are reserved words only as words of their own: a `{}` argument
 * (find -exec, xargs -I{}) inside a { …; } group or a function body is an
 * ordinary word, not the group's end.
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

describe('a {} word in a brace group', () => {
  it('is an argument', async () => {
    expect((await sh('{ echo {}; }')).out).toBe('{}\n');
    expect((await sh('{ echo a; echo -I{} item-{}; echo b; }')).out).toBe('a\n-I{} item-{}\nb\n');
    expect((await sh('{ echo q | xargs -I{} echo item-{}; }')).out).toBe('item-q\n');
  });

  it('in find -exec … {} \\;', async () => {
    expect((await sh('{ find /etc/passwd -exec echo F {} \\; ; }')).out).toBe('F /etc/passwd\n');
  });

  it('in a function body', async () => {
    expect((await sh('f() { echo in-{}; }; f')).out).toBe('in-{}\n');
  });

  it('in eval text, as Claude Code runs a command', async () => {
    expect((await sh(`eval '{ echo a; echo {}; echo b; }' && echo ok`)).out).toBe('a\n{}\nb\nok\n');
  });

  it('nested groups still close', async () => {
    expect((await sh('{ { echo in; } }; echo out')).out).toBe('in\nout\n');
    expect((await sh('{ echo }; }')).out).toBe('}\n');
  });
});
