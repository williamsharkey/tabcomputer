/**
 * tabcomputer#110: apt in a window without a terminal printed debconf's
 * "unable to initialize frontend: Readline ... falling back to frontend:
 * Noninteractive" on every install. apt, apt-get and dpkg started without a
 * terminal get DEBIAN_FRONTEND=noninteractive unless the user set one.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestShell } from './helpers';
import { debconfEnv } from '@shiro/debian/apt-guard';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

const haveRootfs = existsSync(resolve(__dirname, '../../../public/debian/rootfs.json'));

describe('debconfEnv', () => {
  it("noninteractive for apt and dpkg without a terminal; the user's value and other programs are left alone", () => {
    for (const p of ['apt', 'apt-get', 'dpkg', '/usr/bin/apt-get', '/usr/bin/apt.debian', '/usr/bin/apt-get.debian', 'dpkg-reconfigure']) {
      expect(debconfEnv(p, { A: '1' }, false), p).toEqual({ A: '1', DEBIAN_FRONTEND: 'noninteractive' });
    }
    const env = { A: '1' };
    expect(debconfEnv('apt', env, true)).toBe(env); // a terminal: debconf may ask
    for (const p of ['apt-cache', 'dpkg-query', 'python3', 'aptx', '/opt/apt/run']) expect(debconfEnv(p, env, false), p).toBe(env);
    const set = { DEBIAN_FRONTEND: 'readline' };
    expect(debconfEnv('apt', set, false)).toBe(set);
    const empty = { DEBIAN_FRONTEND: '' }; // set, to nothing: still the user's
    expect(debconfEnv('dpkg', empty, false)).toBe(empty);
    expect(env).toEqual({ A: '1' });
  });
});

describe.skipIf(!haveRootfs)('apt and dpkg without a terminal (Debian mode)', () => {
  let fs: FileSystem;
  let shell: Shell;
  const sh = async (cmd: string) => {
    let out = '';
    await shell.execute(cmd, (s: string) => { out += s; }, (s: string) => { out += s; });
    return out.replace(/\r+\n/g, '\n');
  };
  beforeAll(async () => {
    ({ fs, shell } = await createTestShell());
    expect(await shell.execute('debian install', () => {})).toBe(0);
    // Debian's printenv under the names: what the program is started with
    await fs.mkdir('/tmp/dfe', { recursive: true });
    await fs.symlink('/usr/bin/printenv', '/tmp/dfe/dpkg');
    await fs.symlink('/usr/bin/printenv', '/tmp/dfe/other');
    await fs.rename('/usr/bin/apt-get.debian', '/usr/bin/apt-get.debian.real');
    await fs.symlink('/usr/bin/printenv', '/usr/bin/apt-get.debian');
  }, 60_000);

  it('dpkg gets DEBIAN_FRONTEND=noninteractive, another program nothing', async () => {
    expect(await sh('/tmp/dfe/dpkg DEBIAN_FRONTEND; echo "rc=$?"')).toBe('noninteractive\nrc=0\n');
    expect(await sh('/tmp/dfe/other DEBIAN_FRONTEND; echo "rc=$?"')).toBe('rc=1\n');
    expect(await sh('sudo /tmp/dfe/dpkg DEBIAN_FRONTEND')).toBe('noninteractive\n');
  }, 120_000);

  it('a value the user set is kept', async () => {
    expect(await sh('DEBIAN_FRONTEND=readline /tmp/dfe/dpkg DEBIAN_FRONTEND')).toBe('readline\n');
    expect(await sh('export DEBIAN_FRONTEND=teletype; /tmp/dfe/dpkg DEBIAN_FRONTEND; unset DEBIAN_FRONTEND')).toBe('teletype\n');
  }, 120_000);

  it("apt-get through tabcomputer's wrapper, from the shell and from a Debian program", async () => {
    expect(String(await fs.readFile('/usr/bin/apt-get', 'utf8'))).toBe('#!/usr/bin/shiro-apt\n');
    expect(await sh('apt-get DEBIAN_FRONTEND')).toBe('noninteractive\n');
    expect(await sh('sudo apt-get DEBIAN_FRONTEND')).toBe('noninteractive\n');
    expect(await sh('DEBIAN_FRONTEND=readline apt-get DEBIAN_FRONTEND')).toBe('readline\n');
    // Debian's bash execs the stub itself: the wrapper runs as a kernel program
    expect(await sh("/usr/bin/bash -c 'apt-get DEBIAN_FRONTEND'")).toBe('noninteractive\n');
    expect(await sh("/usr/bin/bash -c 'DEBIAN_FRONTEND=readline apt-get DEBIAN_FRONTEND'")).toBe('readline\n');
  }, 120_000);
});
