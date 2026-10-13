/**
 * Papercuts from a classroom test (tabcomputer#128, #123, #124): what a
 * beginner types first should answer in words they can act on.
 */
import { describe, it, expect } from 'vitest';
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
