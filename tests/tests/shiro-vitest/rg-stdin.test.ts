/**
 * tabcomputer#23: the built-in rg searches piped or redirected stdin when it is
 * given no path (as ripgrep does), and its directory walks skip FIFOs instead of
 * waiting on them.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;

beforeEach(async () => {
  ({ shell } = await createTestShell());
  await sh('rm -rf /tmp/rg23 && mkdir -p /tmp/rg23 && cd /tmp/rg23 && echo "needle in file" > a.txt');
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe('rg reads stdin when given no path', () => {
  it('a pipe: matching lines, no file name or line number', async () => {
    expect((await sh("printf 'one needle\\ntwo\\nneedle three\\n' | rg needle; echo st=$?")).out)
      .toBe('one needle\nneedle three\nst=0\n');
    expect((await sh("printf 'x\\nneedle\\n' | rg -n needle")).out).toBe('2:needle\n');
    expect((await sh('echo zzz | rg needle; echo st=$?')).out).toBe('st=1\n');
  });

  it('< file, a here-doc and a here-string', async () => {
    expect((await sh('rg needle < a.txt')).out).toBe('needle in file\n');
    expect((await sh('rg -c ee <<E\neel\nbee\nE')).out).toBe('2\n');
    expect((await sh("rg -o 'n..dle' <<< 'a needle b'")).out).toBe('needle\n');
  });

  it('a terminal, /dev/null or a path given: the files', async () => {
    expect((await sh('rg needle')).out).toBe('a.txt:needle in file\n');
    expect((await sh('rg needle < /dev/null')).out).toBe('a.txt:needle in file\n');
    expect((await sh('echo needle | rg needle a.txt')).out).toBe('needle in file\n');
  });

  it('in a script run with no stdin', async () => {
    await sh("printf 'rg needle\\n' > /tmp/rg23.sh");
    expect((await sh('bash /tmp/rg23.sh')).out).toBe('a.txt:needle in file\n');
  });
});

describe('rg walks', () => {
  it('skip a FIFO (search and --files)', async () => {
    await sh('mkfifo p.fifo');
    expect((await sh('rg needle; echo st=$?')).out).toBe('a.txt:needle in file\nst=0\n');
    expect((await sh('rg --files')).out).toBe('a.txt\n');
  });

  it('print -- between groups only with context', async () => {
    expect((await sh("printf 'needle\\na\\nneedle\\n' | rg needle")).out).toBe('needle\nneedle\n');
    expect((await sh("printf 'needle\\na\\nb\\nc\\nneedle\\n' | rg -A1 needle")).out).toBe('needle\na\n--\nneedle\n');
  });
});
