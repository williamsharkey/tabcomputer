/**
 * tabcomputer#30: after `2>&1` fd 2 is fd 1, so what a command writes to each
 * comes out in the order it was written, through a pipe or into a file (a
 * script, sh -c and node printed all of stdout, then all of stderr). And a
 * streamed `> f 2>&1` writes \n line ends, not the terminal's \r\n.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.writeFile('/tmp/ord.sh', 'echo out1\necho err1 >&2\necho out2\nls /nope\necho out3\n');
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

const ORDERED = "out1\nerr1\nout2\nls: cannot access '/nope': No such file or directory\nout3\n";

describe('2>&1 keeps the order of writes', () => {
  it('a script and sh -c, through a pipe or not', async () => {
    expect((await sh('bash /tmp/ord.sh 2>&1 | cat')).out).toBe(ORDERED);
    expect((await sh('bash /tmp/ord.sh 2>&1')).out).toBe(ORDERED);
    expect((await sh("sh -c 'ls /nope; echo o2' 2>&1 | cat")).out).toBe("ls: cannot access '/nope': No such file or directory\no2\n");
  });

  it('node', async () => {
    expect((await sh("node -e 'console.log(1); console.error(2); console.log(3)' 2>&1 | cat")).out).toBe('1\n2\n3\n');
  });

  it('into a file, with \\n line ends', async () => {
    await sh('bash /tmp/ord.sh > /tmp/o.txt 2>&1');
    expect(await fs.readFile('/tmp/o.txt', 'utf8')).toBe(ORDERED);
    await sh("sh -c 'echo a; echo b >&2' > /tmp/o3.txt 2>&1");
    expect(await fs.readFile('/tmp/o3.txt', 'utf8')).toBe('a\nb\n');
  });

  it('without 2>&1 the streams stay apart', async () => {
    let out = '', err = '';
    await shell.execute('bash /tmp/ord.sh | cat', (s) => { out += s; }, (s) => { err += s; });
    expect(out.replace(/\r\n/g, '\n')).toBe('out1\nout2\nout3\n');
    expect(err).toMatch(/err1/);
  });
});
