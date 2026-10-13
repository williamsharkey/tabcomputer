/**
 * Papercuts from a classroom test (tabcomputer#128, #123, #124): what a
 * beginner types first should answer in words they can act on.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createTestShell, run } from './helpers';

describe('which after a toolchain install (#128)', () => {
  it("stays tabcomputer's when Debian's which is on PATH: it names what is missing and finds Debian's programs", async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/usr/bin', { recursive: true });
    await fs.writeFile('/usr/bin/which', '#!/bin/sh\necho "debian which: $*"\nexit 1\n', { mode: 0o755 });
    await fs.writeFile('/usr/bin/clang', '#!/bin/sh\necho clang\n', { mode: 0o755 });
    const { extraShadows } = await import('@shiro/pkg-manager');
    extraShadows.set(fs, new Set(['which']));
    try {
      const missing = await run(shell, 'which java');
      expect(missing.output).not.toContain('debian which');
      expect(missing.output).toContain('java not found');
      expect(missing.exitCode).toBe(1);
      const found = await run(shell, 'which clang');
      expect(found.output.trim()).toBe('/usr/bin/clang');
      expect(found.exitCode).toBe(0);
    } finally { extraShadows.delete(fs); }
  });
});

describe('the built-in gcc on a program it cannot compile (#123)', () => {
  it('a scanf program fails with a line that says to run toolchain install c; one it can compile gets no note', async () => {
    const { shell, fs } = await createTestShell();
    const { ccCmd, gccCmd, FULL_TOOLCHAIN_NOTE } = await import('@shiro/commands/cc');
    shell.commands.register(ccCmd);
    shell.commands.register(gccCmd);
    // the compiler archive the site serves at /wccfiles.zip
    const zip = readFileSync(path.resolve(__dirname, '../../../public/wccfiles.zip'));
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (url: any) => {
      if (String(url).endsWith('/wccfiles.zip')) return new Response(zip);
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    try {
      await fs.writeFile('/tmp/in.c', '#include <stdio.h>\nint main(void) { int n; scanf("%d", &n); printf("%d\\n", n * 2); return 0; }\n');
      const bad = await run(shell, 'cd /tmp && gcc in.c -o in');
      expect(bad.exitCode).not.toBe(0);
      expect(bad.output.replace(/\r/g, '')).toContain(FULL_TOOLCHAIN_NOTE);
      expect(bad.output).toMatch(/toolchain install c/);
      await fs.writeFile('/tmp/ok.c', '#include <stdio.h>\nint main(void) { printf("hi\\n"); return 0; }\n');
      const ok = await run(shell, 'cd /tmp && gcc ok.c -o ok && ./ok');
      expect(ok.output.replace(/\r/g, '')).not.toContain('note:');
      expect(ok.output).toContain('hi');
      expect(ok.exitCode).toBe(0);
    } finally { globalThis.fetch = realFetch; }
  }, 60_000);

  it('-E and a missing library say it too', async () => {
    const { shell, fs } = await createTestShell();
    const { ccCmd } = await import('@shiro/commands/cc');
    shell.commands.register(ccCmd);
    await fs.writeFile('/tmp/a.c', 'int main(void) { return 0; }\n');
    expect((await run(shell, 'cc -E /tmp/a.c')).output).toMatch(/toolchain install c/);
    expect((await run(shell, 'cc /tmp/a.c -lcs50')).output).toMatch(/cannot find -lcs50[\s\S]*toolchain install c/);
  });
});

describe('Python for a beginner (#124)', () => {
  it("the welcome card's Python runs the built-in python3, not the Debian toolchain", async () => {
    const { DEMOS } = await import('@shiro/desktop/welcome');
    const py = DEMOS.find((d) => d.id === 'python')!;
    expect(py.title).toBe('Write some Python');
    expect(py.command).toMatch(/^python3 /);
    expect(`${py.command} ${py.detail}`).not.toMatch(/toolchain|apt|debian/i);
  });

  it('toolchain list says what the python set costs', async () => {
    const { shell } = await createTestShell();
    const lines = (await run(shell, 'toolchain list')).output.replace(/\r/g, '').split('\n');
    const i = lines.findIndex((l) => /^python\s/.test(l));
    expect(lines[i + 1]).toMatch(/note: .*slower than the built-in python3/);
  });

  it('the built-in Python gets a tkinter that says what to do, and leaves a real one alone', async () => {
    const { fs } = await createTestShell();
    const { ensurePythonHints, TKINTER_STUB } = await import('@shiro/python-hints');
    const site = '/usr/lib/pkg/python3/lib/python3.13/site-packages';
    // not installed: nothing written, and asked again once it is
    await ensurePythonHints(fs);
    expect(await fs.exists('/usr/lib/pkg/python3')).toBe(false);
    await fs.mkdir(site, { recursive: true });
    await ensurePythonHints(fs);
    expect(await fs.readFile(`${site}/tkinter/__init__.py`, 'utf8')).toBe(TKINTER_STUB);
    expect(TKINTER_STUB).toMatch(/ModuleNotFoundError[\s\S]*toolchain install python[\s\S]*name='tkinter'/);
    const other = (await createTestShell()).fs;
    await other.mkdir(`${site}/tkinter`, { recursive: true });
    await other.writeFile(`${site}/tkinter/__init__.py`, 'X = 1\n');
    await ensurePythonHints(other);
    expect(await other.readFile(`${site}/tkinter/__init__.py`, 'utf8')).toBe('X = 1\n');
  });
});

describe('valgrind (#128)', () => {
  it('command not found says what to use instead', async () => {
    const { shell } = await createTestShell();
    const r = await run(shell, 'valgrind ./a.out');
    expect(r.exitCode).toBe(127);
    expect(r.output).toContain('command not found: valgrind');
    expect(r.output).toMatch(/-fsanitize=address/);
    expect(r.output).toMatch(/toolchain install c/);
    // other names get the plain message
    const o = await run(shell, 'nosuchprogram');
    expect(o.output).toContain('command not found: nosuchprogram');
    expect(o.output).not.toMatch(/sanitize/);
  });
});
