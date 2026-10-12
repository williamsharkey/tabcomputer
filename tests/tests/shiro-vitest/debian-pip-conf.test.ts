/**
 * tabcomputer#112: `pip install X` in Debian's python3 was refused by
 * PEP 668. Debian mode writes /etc/pip.conf with break-system-packages
 * (and no `user = true`, which is an error inside a venv), and never
 * replaces a pip.conf that is there.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestShell, run } from './helpers';
import { pipInstallsPackages } from '@shiro/debian/rootfs';

const haveRootfs = existsSync(resolve(__dirname, '../../../public/debian/rootfs.json'));

/** pip.conf as pip's configparser reads it: section → key → value */
function ini(text: string): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {};
  let section = '';
  for (const line of text.split('\n')) {
    if (!line.trim() || /^\s*[#;]/.test(line)) continue;
    const s = /^\[(.+)\]$/.exec(line.trim());
    if (s) { section = s[1]; out[section] ??= {}; continue; }
    const kv = /^([^=:]+?)\s*[=:]\s*(.*)$/.exec(line.trim());
    if (kv) (out[section] ??= {})[kv[1]] = kv[2];
  }
  return out;
}

describe('/etc/pip.conf (#112)', () => {
  it('break-system-packages, nothing that fails in a venv; an existing file is kept', async () => {
    const { fs } = await createTestShell();
    await fs.unlink('/etc/pip.conf').catch(() => {});
    await pipInstallsPackages(fs);
    const conf = ini(await fs.readFile('/etc/pip.conf', 'utf8') as string);
    expect(conf).toEqual({ global: { 'break-system-packages': 'true' } });
    await fs.writeFile('/etc/pip.conf', '[global]\nindex-url = https://pypi.example/simple\n');
    await pipInstallsPackages(fs);
    expect(await fs.readFile('/etc/pip.conf', 'utf8')).toBe('[global]\nindex-url = https://pypi.example/simple\n');
    await fs.unlink('/etc/pip.conf');
  });

  it.skipIf(!haveRootfs)('debian install writes it', async () => {
    const { fs, shell } = await createTestShell();
    await fs.unlink('/etc/pip.conf').catch(() => {});
    expect((await run(shell, 'debian install')).exitCode).toBe(0);
    expect(ini(await fs.readFile('/etc/pip.conf', 'utf8') as string).global['break-system-packages']).toBe('true');
  }, 60_000);
});
