import { describe, it, expect } from 'vitest';
import { createTestShell, run as runRaw } from './helpers';
import type { Shell } from '@shiro/shell';

const run = async (shell: Shell, cmd: string) => { const r = await runRaw(shell, cmd); return { ...r, output: r.output.replace(/\r\n/g, '\n') }; };

// A named pipe is not a regular file (tabcomputer#21): stat says so, and the
// builtins that read what they find while walking a tree don't open one
// (reading it waits for a writer: they hung).
describe('named pipes met while walking', { timeout: 20_000 }, () => {
  let n = 0;
  async function tree() {
    const t = await createTestShell();
    // Each test its own tree (the store is shared): /tmp/fw is a link to it
    const root = `/tmp/fw-${++n}`;
    await t.fs.mkdir(root, { recursive: true });
    await t.fs.unlink('/tmp/fw').catch(() => {});
    await t.fs.symlink(root, '/tmp/fw');
    await t.fs.mkdir('/tmp/fw/a/sub', { recursive: true });
    await t.fs.writeFile('/tmp/fw/a/text.txt', 'needle here\n');
    await t.fs.writeFile('/tmp/fw/a/sub/more.txt', 'more needle\n');
    await t.fs.mkfifo('/tmp/fw/a/sub/pipe');
    return t;
  }

  it('stat, test and node see a fifo, not a regular file', async () => {
    const { fs, shell } = await tree();
    const st = await fs.stat('/tmp/fw/a/sub/pipe');
    expect([st.isFile(), st.isFIFO()]).toEqual([false, true]);
    expect((await fs.stat('/tmp/fw/a/text.txt')).isFile()).toBe(true);
    expect((await run(shell, 'stat -c %F /tmp/fw/a/sub/pipe /tmp/fw/a/text.txt /tmp/fw/a')).output).toBe('fifo\nregular file\ndirectory\n');
    expect((await run(shell, 'test -f /tmp/fw/a/sub/pipe; echo $?; test -p /tmp/fw/a/sub/pipe; echo $?')).output).toBe('1\n0\n');
    await fs.symlink('sub/pipe', '/tmp/fw/a/plink');
    expect((await run(shell, 'stat -c %F /tmp/fw/a/plink; stat -L -c %F /tmp/fw/a/plink')).output).toBe('symbolic link\nfifo\n');
    const r = await run(shell, `node -e "const s = require('fs').statSync('/tmp/fw/a/sub/pipe'); console.log(s.isFile(), s.isFIFO(), (s.mode & 0o170000).toString(8))"`);
    expect(r.output).toContain('false true 10000');
  });

  it('grep -r skips it; diff -r reports it', async () => {
    const { fs, shell } = await tree();
    expect((await run(shell, 'cd /tmp/fw && grep -rn needle a | sort')).output).toBe('a/sub/more.txt:1:more needle\na/text.txt:1:needle here\n');
    await run(shell, 'cp -r /tmp/fw/a /tmp/fw/b');
    const d = await run(shell, 'cd /tmp/fw && diff -r a b; echo "exit $?"');
    expect(d.output).toContain('File a/sub/pipe is a fifo while file b/sub/pipe is a fifo');
    expect(d.output).toContain('exit 1');
    await fs.unlink('/tmp/fw/b/sub/pipe');
    expect((await run(shell, 'cd /tmp/fw && diff -r a b')).output).toBe('Only in a/sub: pipe\n');
  });

  it('cp -r makes a new pipe; tar archives and extracts it as one; zip leaves it out', async () => {
    const { fs, shell } = await tree();
    await run(shell, 'cp -r /tmp/fw/a /tmp/fw/c');
    expect((await fs.stat('/tmp/fw/c/sub/pipe')).isFIFO()).toBe(true);
    expect(await fs.readFile('/tmp/fw/c/sub/more.txt', 'utf8')).toBe('more needle\n');
    const t = await run(shell, 'cd /tmp/fw && tar cf a.tar a && tar tvf a.tar | grep pipe');
    expect(t.output).toMatch(/^p.* a\/sub\/pipe\n$/);
    await run(shell, 'mkdir -p /tmp/fw/x && cd /tmp/fw/x && tar xf ../a.tar');
    expect((await fs.stat('/tmp/fw/x/a/sub/pipe')).isFIFO()).toBe(true);
    expect(await fs.readFile('/tmp/fw/x/a/text.txt', 'utf8')).toBe('needle here\n');
    const z = await run(shell, 'cd /tmp/fw && zip -r a.zip a 2>&1; unzip -l a.zip | grep -c pipe');
    expect(z.output).toContain('ignoring FIFO');
    expect(z.output.trim().split('\n').pop()).toBe('0');
  });

  it('git status and git add pass it by', async () => {
    const { shell } = await tree();
    const r = await run(shell, 'cd /tmp/fw/a && git init -q && git add -A && git commit -qm one && git status --short && git ls-files');
    expect(r.output).toBe('sub/more.txt\ntext.txt\n'); // (git's order: by path)
    // Untracked: a new file is listed, a new pipe isn't, and neither is read
    const r2 = await run(shell, 'cd /tmp/fw/a && echo new > new.txt && mkfifo sub/pipe2 && git ls-files -o && git status --short');
    expect(r2.output).toBe('new.txt\n?? new.txt\n');
  });
});
