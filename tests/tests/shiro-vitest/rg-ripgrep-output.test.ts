/**
 * tabcomputer#68: the built-in rg prints what ripgrep 14 prints. Line numbers
 * and a heading per file only on a terminal (or -n / --heading), the path only
 * for a directory search or several paths (-H / -I override); --count-matches,
 * -r/--replace, --stats. The whole flag surface is checked against the real
 * ripgrep by tests/rg-cases.txt (GNU_DIFF=1 GNU_DIFF_CASES=../tests/rg-cases.txt).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import { rgCmd } from '@shiro/commands/rg';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.mkdir('/tmp/rg68/src', { recursive: true } as any);
  await fs.writeFile('/tmp/rg68/sample.txt', 'the cat sat\non the mat\nThe end\n');
  await fs.writeFile('/tmp/rg68/src/a.ts', 'const sat = 1;\n');
  await sh('cd /tmp/rg68');
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

/** rg run as on a terminal */
async function onTty(...args: string[]) {
  const ctx: any = { args, fs, cwd: '/tmp/rg68', env: {}, stdin: '', stdout: '', stderr: '', terminal: {}, stdoutIsTTY: true };
  await rgCmd.exec(ctx);
  return ctx.stdout as string;
}

describe('rg prints as ripgrep does (#68)', () => {
  it('one file: no path, and no line numbers off a terminal', async () => {
    expect((await sh('rg sat sample.txt | cat')).out).toBe('the cat sat\n');
    expect((await sh('rg -n sat sample.txt')).out).toBe('1:the cat sat\n');
    expect((await sh('rg -N sat sample.txt')).out).toBe('the cat sat\n');
    expect((await sh('rg -H sat sample.txt')).out).toBe('sample.txt:the cat sat\n');
  });

  it('a directory search shows paths; -I / --no-filename hide them', async () => {
    expect((await sh('rg --sort path sat | cat')).out).toBe('sample.txt:the cat sat\nsrc/a.ts:const sat = 1;\n');
    expect((await sh('rg --sort path -I sat')).out).toBe('the cat sat\nconst sat = 1;\n');
    expect((await sh('rg --sort path --no-filename -n sat')).out).toBe('1:the cat sat\n1:const sat = 1;\n');
  });

  it('counts: -c lines, --count-matches matches', async () => {
    expect((await sh('rg --count the sample.txt')).out).toBe('2\n');
    expect((await sh('rg --count-matches -i -w the sample.txt')).out).toBe('3\n');
    expect((await sh('rg -c sat sample.txt src')).out).toBe('sample.txt:1\nsrc/a.ts:1\n');
  });

  it('-r / --replace, with capture groups', async () => {
    expect((await sh('rg -r X sat sample.txt')).out).toBe('the cat X\n');
    expect((await sh('rg --replace=X sat sample.txt')).out).toBe('the cat X\n');
    expect((await sh("rg -o -r '$2 $1' '(\\w+) (\\w+)$' sample.txt")).out).toBe('sat cat\nmat the\nend The\n');
    expect((await sh("rg -r '${w}!' '(?P<w>end)' sample.txt")).out).toBe('The end!\n');
  });

  it('--stats ends with the totals', async () => {
    const out = (await sh('rg --stats the sample.txt')).out;
    expect(out).toMatch(/^the cat sat\non the mat\n\n2 matches\n2 matched lines\n1 files contained matches\n1 files searched\n\d+ bytes printed\n31 bytes searched\n/);
  });

  it('on a terminal: line numbers, and a coloured heading per file', async () => {
    expect(await onTty('sat', 'sample.txt')).toBe('\x1b[0m\x1b[32m1\x1b[0m:the cat \x1b[0m\x1b[1m\x1b[31msat\x1b[0m\n');
    expect(await onTty('--color', 'never', '--sort', 'path', 'sat')).toBe('sample.txt\n1:the cat sat\n\nsrc/a.ts\n1:const sat = 1;\n');
  });

  it("keeps Claude Code's Grep forms", async () => {
    expect((await sh('rg -n --no-heading sat src sample.txt')).out).toBe('src/a.ts:1:const sat = 1;\nsample.txt:1:the cat sat\n');
    expect((await sh('rg -l --null sat sample.txt')).out).toBe('sample.txt\0');
    const json = (await sh('rg --json -n sat sample.txt')).out.trim().split('\n').map((l) => JSON.parse(l));
    expect(json.map((e) => e.type)).toEqual(['begin', 'match', 'end', 'summary']);
    expect(json[3].data.stats).toMatchObject({ matches: 1, matched_lines: 1, searches: 1 });
  });
});
