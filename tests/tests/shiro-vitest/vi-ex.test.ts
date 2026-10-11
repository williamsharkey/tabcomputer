import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell, run } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';
import { viCmd, exCmd } from '@shiro/commands/vi';
import { ExBuffer, ExIO, runExCommand, vimRegex } from '@shiro/commands/vi-ex';

// tabcomputer#62: the builtin vi refused -c commands without a terminal, so
// `vi -c CMD -c wq FILE` and `vi -es FILE < script` (what scripts and agents
// use) failed. Now ex commands run without a terminal.

describe('ex commands (vi-ex)', () => {
  async function ex(text: string, cmds: string[], input = '') {
    const files: Record<string, string> = {};
    const buf = new ExBuffer();
    buf.filename = 'f';
    buf.setText(text);
    buf.cur = Math.min(1, buf.lines.length);
    let out = '', err = '';
    const lines = input ? input.split('\n') : [];
    const io: ExIO = {
      read: async (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
      write: async (p, t, append) => { files[p] = append ? (files[p] ?? '') + t : t; },
      resolve: (p) => p,
      out: (t) => { out += t; },
      err: (t) => { err += t; },
      input: () => lines.shift() ?? null,
    };
    for (const c of cmds) { await runExCommand(buf, c, io); if (buf.quit !== null) break; }
    return { text: buf.text(), out, err, quit: buf.quit, errors: buf.errors, files };
  }
  const T = 'line1\nline2\nline3\n';

  it.each([
    ['2d', T, ['2d'], 'line1\nline3\n'],
    [':N then d', T, [':3', 'd'], 'line1\nline2\n'],
    ['%s///g', 'a a\nb a\n', ['%s/a/X/g'], 'X X\nb X\n'],
    ['s first only', 'a a\n', ['s/a/X/'], 'X a\n'],
    ['groups', 'foo bar\n', ['s/\\(foo\\) \\(bar\\)/\\2 \\1/'], 'bar foo\n'],
    ['\\u& and \\+', 'foo bar\n', ['s/\\w\\+/\\u&/g'], 'Foo Bar\n'],
    ['\\r splits the line', 'a,b\n', ['s/,/\\r/'], 'a\nb\n'],
    ['other delimiter', '/usr/bin\n', ['s#/usr#/opt#'], '/opt/bin\n'],
    ['literal ( ) + in magic', 'f(x) + 1\n', ['s/f(x) + 1/ok/'], 'ok\n'],
    ['[[:digit:]]', 'a1b2\n', ['s/[[:digit:]]/#/g'], 'a#b#\n'],
    ['\\< \\>', 'cat concat\n', ['s/\\<cat\\>/dog/g'], 'dog concat\n'],
    ['g/re/d', 'x1\ny\nx2\nz\n', ['g/^x/d'], 'y\nz\n'],
    ['g!/re/d', 'x1\ny\nx2\nz\n', ['g!/^x/d'], 'x1\nx2\n'],
    ['v/re/d', 'x1\ny\nx2\nz\n', ['v/^x/d'], 'x1\nx2\n'],
    ['g/re/s', 'x1\ny\nx2\n', ['g/x/s/\\d/N/'], 'xN\ny\nxN\n'],
    ['g/^/m0 reverses', 'a\nb\nc\n', ['g/^/m0'], 'c\nb\na\n'],
    ['/re/,/re/d', 'a\nstart\nb\nend\nc\n', ['/start/,/end/d'], 'a\nc\n'],
    ['$-1d', T, ['$-1d'], 'line1\nline3\n'],
    ['1t$', T, ['1t$'], 'line1\nline2\nline3\nline1\n'],
    ['1m$', T, ['1m$'], 'line2\nline3\nline1\n'],
    ['1,2j', T, ['1,2j'], 'line1 line2\nline3\n'],
    ['| joins commands', T, ['1d|1d'], 'line3\n'],
    ['%d on an empty buffer', '', ['%d'], ''],
  ])('%s', async (_name, text, cmds, want) => {
    const r = await ex(text, cmds);
    expect(r.err).toBe('');
    expect(r.text).toBe(want);
  });

  it('a, i and c take text lines up to "." from the script', async () => {
    expect((await ex(T, ['1a'], 'new\n.')).text).toBe('line1\nnew\nline2\nline3\n');
    expect((await ex(T, ['1i'], 'top\n.')).text).toBe('top\nline1\nline2\nline3\n');
    expect((await ex(T, ['2c'], 'changed\n.')).text).toBe('line1\nchanged\nline3\n');
  });

  it('p, nu and = print; errors are reported and counted', async () => {
    expect((await ex(T, ['%p'])).out).toBe(T);
    expect((await ex(T, ['1,2nu'])).out).toBe('  1 line1\n  2 line2\n');
    expect((await ex(T, ['='])).out).toBe('3\n');
    const nf = await ex(T, ['s/zzz/y/']);
    expect([nf.err, nf.errors]).toEqual(['E486: Pattern not found: zzz\n', 1]);
    expect((await ex(T, ['s/zzz/y/e'])).errors).toBe(0);
    expect((await ex(T, ['frobnicate'])).err).toMatch(/^E492/);
  });

  it('w, wq, x and q follow vim', async () => {
    const wq = await ex(T, ['2d', 'wq']);
    expect([wq.quit, wq.files.f]).toEqual([0, 'line1\nline3\n']);
    const q = await ex(T, ['2d', 'q']);
    expect([q.quit, q.err]).toEqual([null, 'E37: No write since last change (add ! to override)\n']);
    expect((await ex(T, ['2d', 'q!'])).quit).toBe(0);
    const x = await ex(T, ['x']); // unmodified: no write
    expect([x.quit, x.files.f]).toEqual([0, undefined]);
    const w = await ex(T, ['1,2w part', 'w >> part']);
    expect(w.files.part).toBe('line1\nline2\n' + T);
    expect((await ex(T, ['cq'])).quit).toBe(1);
  });

  it('translates vim regexes', () => {
    expect(vimRegex('a\\{2,3\\}b\\{-}c').source).toBe('a{2,3}b*?c');
    expect(vimRegex('\\(a\\|b\\)\\+').source).toBe('(a|b)+');
    expect(vimRegex('x$y').source).toBe('x\\$y');
    expect(vimRegex('foo\\c').ignoreCase).toBe(true);
  });
});

describe('vi and ex without a terminal', () => {
  let shell: Shell;
  let fs: FileSystem;
  const read = async (p: string) => (await fs.readFile(p, 'utf8')) as string;

  beforeEach(async () => {
    ({ shell, fs } = await createTestShell());
    shell.commands.register(viCmd);
    shell.commands.register(exCmd);
    await fs.writeFile('/tmp/w.txt', 'line1\nline2\nline3\n');
  });

  it("vi -c ':2d' -c ':wq' FILE edits and writes (#62's example)", async () => {
    const { output, exitCode } = await run(shell, "vi -c ':2d' -c ':wq' /tmp/w.txt 2>/tmp/err; echo rc=$?");
    expect(output).toContain('rc=0');
    expect(exitCode).toBe(0);
    expect(await read('/tmp/w.txt')).toBe('line1\nline3\n');
    expect(await read('/tmp/err')).toBe('');
  });

  it('vi -es FILE < script runs the script from stdin', async () => {
    await fs.writeFile('/tmp/script', '%s/line/L/g\ng/2/d\nwq\n');
    await run(shell, 'vi -es /tmp/w.txt < /tmp/script');
    expect(await read('/tmp/w.txt')).toBe('L1\nL3\n');
  });

  it("ex -s with a here-doc; '+%p' prints to stdout", async () => {
    await run(shell, "ex -s /tmp/w.txt <<'EOF'\n1d\nw\nEOF");
    expect(await read('/tmp/w.txt')).toBe('line2\nline3\n');
    await run(shell, "vi -es '+%p' '+q!' /tmp/w.txt > /tmp/out");
    expect(await read('/tmp/out')).toBe('line2\nline3\n');
  });

  it('an error in ex mode exits 1; unsaved changes at the end are not written', async () => {
    const bad = await run(shell, "vi -es -c 'frobnicate' -c 'q!' /tmp/w.txt 2>/tmp/err < /dev/null; echo rc=$?");
    expect(bad.output).toContain('rc=1');
    expect(await read('/tmp/err')).toMatch(/E492/);
    const unsaved = await run(shell, "vi -c '1d' /tmp/w.txt 2>/tmp/err; echo rc=$?");
    expect(unsaved.output).toContain('rc=1');
    expect(await read('/tmp/err')).toMatch(/E37/);
    expect(await read('/tmp/w.txt')).toBe('line1\nline2\nline3\n');
  });

  it('plain vi FILE without a terminal still refuses, and says how to script it', async () => {
    const r = await run(shell, 'vi /tmp/w.txt 2>/tmp/err; echo rc=$?');
    expect(r.output).toContain('rc=1');
    expect(await read('/tmp/err')).toMatch(/vi -c/);
  });

  it('a new file: :w creates it', async () => {
    await run(shell, "vi -es /tmp/new.txt <<'EOF'\na\nhello\n.\nwq\nEOF");
    expect(await read('/tmp/new.txt')).toBe('hello\n');
  });
});
