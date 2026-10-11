/**
 * tabcomputer#60: zip parses bundled flags (-qr, -rq) and -q is quiet; zip and
 * unzip print what Info-ZIP's do. The flag surface is checked against zip 3.0 /
 * unzip 6.0 by tests/zip-cases.txt (GNU_DIFF=1 GNU_DIFF_CASES=../tests/zip-cases.txt).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.mkdir('/tmp/zip60/proj/sub', { recursive: true } as any);
  await fs.writeFile('/tmp/zip60/proj/a.txt', 'alpha alpha alpha alpha\n');
  await fs.writeFile('/tmp/zip60/proj/sub/b.txt', 'b');
  await sh('cd /tmp/zip60 && rm -rf x *.zip');
});

async function sh(cmd: string) {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err, code };
}

describe('zip and unzip, as Info-ZIP (#60)', () => {
  it('-qr and -rq: quiet and recursive, a full archive', async () => {
    for (const flags of ['-qr', '-rq', '-r -q']) {
      const r = await sh(`rm -f o.zip; zip ${flags} o.zip proj`);
      expect(r.out + r.err).toBe('');
      expect(r.code).toBe(0);
      expect((await sh('unzip -Z1 o.zip | sort')).out).toBe('proj/\nproj/a.txt\nproj/sub/\nproj/sub/b.txt\n');
    }
  });

  it("prints zip's lines: adding, updating, deleting, nothing to do", async () => {
    expect((await sh('zip o.zip proj/sub/b.txt')).out).toBe('  adding: proj/sub/b.txt (stored 0%)\n');
    expect((await sh('zip o.zip proj/sub/b.txt proj/a.txt')).out).toMatch(/^updating: proj\/sub\/b\.txt \(stored 0%\)\n {2}adding: proj\/a\.txt \(deflated \d+%\)\n$/);
    expect((await sh('zip -d o.zip proj/sub/b.txt')).out).toBe('deleting: proj/sub/b.txt\n');
    const r = await sh('zip n.zip nope; echo st=$?');
    expect(r.out).toBe('\tzip warning: name not matched: nope\n\nzip error: Nothing to do! (n.zip)\nst=12\n');
  });

  it('-j, -D, -x', async () => {
    expect((await sh('zip -qj o.zip proj/a.txt proj/sub/b.txt && unzip -Z1 o.zip')).out).toBe('a.txt\nb.txt\n');
    expect((await sh("rm o.zip; zip -qrD o.zip proj -x '*/b.txt' && unzip -Z1 o.zip")).out).toBe('proj/a.txt\n');
  });

  it("unzip prints Info-ZIP's lines and restores the files", async () => {
    await sh('zip -qr o.zip proj');
    const r = await sh('mkdir x && unzip -d x o.zip proj/a.txt proj/sub/b.txt');
    expect(r.out).toBe('Archive:  o.zip\n  inflating: x/proj/a.txt            \n extracting: x/proj/sub/b.txt        \n');
    expect((await sh('cat x/proj/a.txt')).out).toBe('alpha alpha alpha alpha\n');
    expect((await sh('unzip -p o.zip proj/sub/b.txt')).out).toBe('b');
    expect((await sh('unzip -qq -l o.zip proj/a.txt')).out).toMatch(/^ {7}24 {2}\d{4}-\d\d-\d\d \d\d:\d\d {3}proj\/a\.txt\n$/);
    const t = await sh('unzip -t o.zip');
    expect(t.out).toContain('    testing: proj/a.txt               OK\n');
    expect(t.out).toContain('No errors detected in compressed data of o.zip.\n');
    const miss = await sh('unzip o.zip nope; echo st=$?');
    expect(miss.err.replace(/\r\n/g, '\n')).toBe('caution: filename not matched:  nope\n');
    expect(miss.out).toBe('Archive:  o.zip\nst=11\n');
  });

  it.skipIf(!existsSync('/usr/bin/unzip') || !existsSync('/usr/bin/zip'))('archives open with the real unzip, and the real zip\'s with ours', async () => {
    await sh('zip -qr o.zip proj');
    const dir = mkdtempSync('/tmp/zip60-');
    try {
      writeFileSync(`${dir}/o.zip`, await fs.readFile('/tmp/zip60/o.zip') as Uint8Array);
      expect(execFileSync('unzip', ['-tq', 'o.zip'], { cwd: dir, encoding: 'utf8' })).toBe('No errors detected in compressed data of o.zip.\n');
      writeFileSync(`${dir}/c.txt`, 'from the real zip\n'.repeat(5));
      execFileSync('zip', ['-q', 'r.zip', 'c.txt'], { cwd: dir });
      await fs.writeFile('/tmp/zip60/r.zip', readFileSync(`${dir}/r.zip`));
      expect((await sh('unzip -p r.zip c.txt | head -1')).out).toBe('from the real zip\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
