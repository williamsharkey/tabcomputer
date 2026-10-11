/**
 * tabcomputer#73: a function definition inside ( … ) split the subshell:
 * parseCompound counted the ) of `f()` as the subshell's end, so
 * `(echo a; f() { echo fn; }; f)` ran `(echo a` and `f)` as commands
 * ("command not found: (echo").
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';

describe('function definitions inside a subshell (#73)', () => {
  let shell: Shell;
  beforeEach(async () => { ({ shell } = await createTestShell()); });
  const out = async (cmd: string) => {
    const r = await run(shell, cmd);
    return { text: r.output.replace(/\r\n/g, '\n'), code: r.exitCode };
  };

  it.each([
    ['v=1; (echo $v; f() { echo fn; }; f) | cat', '1\nfn\n'],
    ['(echo a; f() { echo fn; }; f)', 'a\nfn\n'],
    ['(f() { echo fn; }; f)', 'fn\n'],
    ['(g() ( echo sub ); g)', 'sub\n'],
    ['h() { echo h1; }; (h; i() { echo i1; }; i) && echo ok', 'h1\ni1\nok\n'],
    ['(echo a; f() { echo fn; }; f) > /tmp/sfd.txt; cat /tmp/sfd.txt', 'a\nfn\n'],
  ])('%s', async (cmd, want) => {
    const r = await out(cmd);
    expect(r.text).toBe(want);
    expect(r.code).toBe(0);
  });

  it('the definition stays in the subshell', async () => {
    const r = await out('(f() { echo fn; }; f); type f > /dev/null 2>&1 || echo "no f outside"');
    expect(r.text).toBe('fn\nno f outside\n');
  });

  it('neighbouring syntax is unchanged: case patterns, extglob, $( ), arrays, top-level definitions', async () => {
    expect((await out('x=b; case $x in a) echo A;; b) echo B;; esac; (case $x in b) echo inB;; esac)')).text).toBe('B\ninB\n');
    expect((await out('shopt -s extglob; x=foo; [[ $x == @(foo|bar) ]] && echo ext')).text).toBe('ext\n');
    expect((await out('a=(1 2 3); echo ${#a[@]} $(echo $(echo nest))')).text).toBe('3 nest\n');
    expect((await out('f() { echo top; }; f; (f)')).text).toBe('top\ntop\n');
    expect((await out('(echo "f() (x)"; echo done)')).text).toBe('f() (x)\ndone\n');
  });
});
