/**
 * rg takes Rust regex flag groups, which models use often in Claude Code's Grep
 * tool: a leading (?i) or (?i)(?s), (?-i), a group mid-pattern scoped to its
 * enclosing group, (?i:…), and x and U, which JavaScript has no flag for.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import { toJs } from '@shiro/commands/rg';

let shell: Shell;

beforeEach(async () => {
  ({ shell } = await createTestShell());
  await sh("rm -rf /tmp/rgflags && mkdir -p /tmp/rgflags && cd /tmp/rgflags && printf 'Hello\\nworld WORLD\\nab\\na b\\nHELLO there\\n' > f.txt");
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('toJs: Rust flag groups', () => {
  it('folds leading groups into flags', () => {
    expect(toJs('(?i)foo')).toEqual({ src: 'foo', flags: 'i' });
    expect(toJs('(?is)a.b')).toEqual({ src: 'a.b', flags: 'is' });
    expect(toJs('(?i)(?m)^x')).toEqual({ src: '^x', flags: 'im' });
    expect(toJs('plain')).toEqual({ src: 'plain', flags: '' });
  });

  it('scopes a later group to the end of its enclosing group, across |', () => {
    expect(toJs('a(?i)b')).toEqual({ src: 'a(?i:b)', flags: '' });
    expect(toJs('(a(?i)b|c)d')).toEqual({ src: '(a(?i:b)|(?i:c))d', flags: '' });
    expect(toJs('(?-i)x')).toEqual({ src: '(?-i:x)', flags: '' });
    expect(toJs('(?i)x', false)).toEqual({ src: '(?i:x)', flags: '' });
  });

  it('applies x and U itself', () => {
    expect(toJs('(?x) a b # comment\n c [ ] \\ ').src).toBe('abc[ ] ');
    expect(toJs('(?U)a+b*?c{2,}').src).toBe('a+?b*c{2,}?');
    expect(toJs('(?U:a+)b+').src).toBe('(?:a+?)b+');
  });

  it('keeps (?P<n>, lookarounds and POSIX classes', () => {
    expect(toJs('(?P<w>\\w+)').src).toBe('(?<w>\\w+)');
    expect(toJs('(?=a)(?<!b)(?<n>c)?').src).toBe('(?=a)(?<!b)(?<n>c)?');
    expect(toJs('[[:digit:]x]+').src).toBe('[0-9x]+');
  });
});

describe('rg with flag groups', () => {
  it('matches as ripgrep does', async () => {
    expect((await sh("rg '(?i)(?m)^hello' f.txt")).out).toBe('Hello\nHELLO there\n');
    expect((await sh("rg 'world (?i)WORLD' f.txt")).out).toBe('world WORLD\n');
    expect((await sh("rg -i '(?-i)Hello' f.txt")).out).toBe('Hello\n');
    expect((await sh("rg '(?x)a b' f.txt")).out).toBe('ab\n');
    expect((await sh("rg -o '(?U)l+' f.txt")).out).toBe('l\nl\nl\n');
  });

  it('one pattern\'s (?i) applies only to that pattern', async () => {
    expect((await sh("rg -e '(?i)hello' -e 'xorld' f.txt")).out).toBe('Hello\nHELLO there\n');
    expect((await sh("rg -e '(?i)nothing' -e 'Hello' f.txt")).out).toBe('Hello\n');
  });
});
