/**
 * tabcomputer#62: the built-in vi runs Vim's ex commands without a terminal:
 * -c CMD / +CMD, -es (and ex scripts on stdin), with Vim's regexes. The
 * command surface is checked against Vim 9 by tests/vi-cases.txt
 * (GNU_DIFF=1 GNU_DIFF_CASES=../tests/vi-cases.txt ... gnu-tools-diff).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.mkdir('/tmp/vi62', { recursive: true } as any);
  await fs.writeFile('/tmp/vi62/f.txt', 'foo bar\nbaz foo\nqux\n');
  await sh('cd /tmp/vi62');
});

async function sh(cmd: string) {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

describe('vi without a terminal (#62)', () => {
  it('-c commands edit and write the file', async () => {
    const r = await sh("vi -c '%s/foo/X/g' -c wq f.txt; echo st=$?; cat f.txt");
    expect(r.out).toBe('st=0\nX bar\nbaz X\nqux\n');
    expect((await sh("vi -c 'g/X/d' -c 'x' f.txt; cat f.txt")).out).toBe('qux\n');
  });

  it("Vim regexes: \\( \\) groups, \\v, \\< \\>, \\zs, & and \\u in the replacement", async () => {
    await sh("vi -c '%s/\\(\\w\\+\\) \\(\\w\\+\\)/\\2 \\1/' -c wq f.txt");
    expect((await sh('cat f.txt')).out).toBe('bar foo\nfoo baz\nqux\n');
    await sh("vi -c '%s/\\v<(\\w)(\\w*)>/\\u\\1\\2/g' -c '%s/o\\zso/0/' -c wq f.txt");
    expect((await sh('cat f.txt')).out).toBe('Bar Fo0\nFo0 Baz\nQux\n');
  });

  it('-es: silent, exit 1 after an error; ex scripts on stdin', async () => {
    expect((await sh("vi -es -c '%s/zzz/y/' -c wq f.txt; echo st=$?")).out).toBe('st=1\n');
    expect((await sh("printf '1d\\n$a\\nlast\\n.\\nwq\\n' | vi -e -s f.txt; cat f.txt")).out).toBe('baz foo\nqux\nlast\n');
    expect((await sh("vi -e -s -c 'g/foo/nu' -c q f.txt")).out).toBe('      1 baz foo\n');
  });

  it('commands that leave vi running end it, unwritten, as Vim does on EOF', async () => {
    const r = await sh("vi -c '%s/foo/X/' f.txt; echo st=$?; cat f.txt");
    expect(r.err).toBe('Vim: Error reading input, exiting...\n');
    expect(r.out).toBe('st=1\nfoo bar\nbaz foo\nqux\n');
  });
});
