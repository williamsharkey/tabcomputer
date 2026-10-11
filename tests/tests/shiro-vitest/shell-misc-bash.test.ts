/**
 * Smaller bash behaviours: a \x01 byte from $'…' is data; $[expr] is $((expr));
 * shopt -s nocasematch for [[ == ]], [[ =~ ]] and case; break/continue with
 * a bad count or too many arguments.
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

describe("$'…'", () => {
  it('keeps a \\x01 byte (\\001, \\ca)', async () => {
    expect((await sh("echo -n $'\\001' $'\\ca\\cz' | od -A n -t x1")).out).toBe(' 01 20 01 1a\n');
    expect((await sh("x=$'a\\001b'; printf %s \"$x\" | wc -c")).out).toBe('3\n');
  });
});

describe('$[expr]', () => {
  it('is $((expr))', async () => {
    expect((await sh('v=1; b=(4 5); echo $[1+2] "$[3 * 4]" $[$v+2] $[b[1]] \'$[1]\'')).out).toBe('3 12 3 5 $[1]\n');
  });
});

describe('nocasematch', () => {
  it('[[ == ]], [[ =~ ]] and case ignore case only when set', async () => {
    expect((await sh('[[ a == A ]]; echo $?; case A in a) echo y;; *) echo n;; esac')).out).toBe('1\nn\n');
    expect((await sh('shopt -s nocasematch; [[ a == A ]]; echo $?; [[ A == [a] ]]; echo $?; [[ aBc =~ ^AB ]]; echo $?; case A in a) echo y;; *) echo n;; esac')).out)
      .toBe('0\n0\n0\ny\n');
  });
});

describe('break and continue', () => {
  it('a bad count or extra arguments end the loop, as bash', async () => {
    expect((await sh('while true; do echo hi; break oops; echo no; done; echo st=$?')).out).toBe('hi\ntabcomputer: break: oops: numeric argument required\nst=128\n');
    expect((await sh('for x in a b c; do echo $x; continue 1 2 3; done; echo --')).out).toBe('a\ntabcomputer: continue: too many arguments\n--\n');
    expect((await sh('for i in 1 2; do for j in 1 2; do echo $i$j; break 2; done; done')).out).toBe('11\n');
  });
});
