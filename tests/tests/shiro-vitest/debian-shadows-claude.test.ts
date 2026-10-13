/**
 * Debian mode lets a program file take a builtin's name (src/debian/overlay.ts).
 * `claude` is the exception: the tab links /usr/local/bin/claude to the npm
 * build it installs itself, and that link must not replace the `claude` command.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';
import { enableDebianShadows, debianShadows, refreshShadows } from '@shiro/debian/overlay';
import { packageShadows } from '@shiro/pkg-manager';

describe('Debian mode: which files replace a builtin', () => {
  it('a file named like a builtin replaces it; the claude link the tab makes does not', async () => {
    const { fs } = await createTestShell();
    await fs.mkdir('/usr/local/bin', { recursive: true });
    await fs.mkdir('/usr/local/lib/node_modules/@anthropic-ai/claude-code', { recursive: true });
    await fs.writeFile('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', '#!/usr/bin/env node\n');
    await fs.symlink('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js', '/usr/local/bin/claude');
    await fs.writeFile('/usr/local/bin/frobnicate', '\x7fELF a real program, not a shim');
    const isCommand = (n: string) => n === 'claude' || n === 'frobnicate';
    await enableDebianShadows(fs, isCommand);
    expect(debianShadows(fs).has('frobnicate')).toBe(true);
    expect(debianShadows(fs).has('claude')).toBe(false);
    expect(packageShadows(fs).has('claude')).toBe(false);
    // and when the link is written again later (the boot install, an update)
    await refreshShadows(fs, 'claude');
    expect(debianShadows(fs).has('claude')).toBe(false);
  });
});
