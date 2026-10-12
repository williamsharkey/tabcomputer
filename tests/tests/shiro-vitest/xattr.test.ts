/**
 * Extended attributes under Blink (issue #107, Blink patch 0539): the kernel's
 * files have none, and the twelve xattr calls say so the way a Linux
 * filesystem without them does (a list is empty, a get is ENODATA, a set or a
 * remove is ENOTSUP) instead of ENOSYS, which Python's shutil.copy2 does not
 * forgive: `python3 -m venv` failed in ensurepip. fixtures/x86/xattr.c prints
 * one line per call.
 *
 * The fixture is built with the host's gcc, or with `zig cc` for
 * x86_64-linux-musl where there is no Linux gcc (macOS: put zig on PATH or
 * set ZIG); without either the test is skipped.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run } from './helpers';

const FIX = resolve(__dirname, 'fixtures/x86');
const bin = join(mkdtempSync(join(tmpdir(), 'shiro-xattr-')), 'xattr');
const build = (cmd: string, args: string[]) => {
  try {
    execFileSync(cmd, [...args, '-static', '-O1', '-o', bin, 'xattr.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 });
    // a Linux x86-64 ELF (macOS's gcc is clang and builds for the host)
    const h = readFileSync(bin);
    return h.readUInt32BE(0) === 0x7f454c46 && h.readUInt16LE(18) === 62;
  } catch { return false; }
};
const haveBin = build('gcc', []) || build(process.env.ZIG || 'zig', ['cc', '-target', 'x86_64-linux-musl']);
// the built engine has patch 0539 (it exports blink_shiro_xattr)
const blinkHasXattr = readFileSync(resolve(__dirname, '../../../public/engines/blink/blink.mjs'), 'utf8').includes('blink_shiro_xattr');

describe('xattr calls (x86 under Blink)', () => {
  it.skipIf(!haveBin || !blinkHasXattr)('no attributes: list 0, get ENODATA, set and remove ENOTSUP, after the fd, name and path checks', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', readFileSync(bin), { mode: 0o755 });
    const r = await run(shell, 'cd /home/user/work && ./prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe([
      'listxattr 0',
      'listxattr size 0 0',
      'llistxattr 0',
      'flistxattr 0',
      'listxattr dir 0',
      'getxattr ENODATA',
      'lgetxattr ENODATA',
      'fgetxattr ENODATA',
      'setxattr ENOTSUP',
      'lsetxattr ENOTSUP',
      'fsetxattr ENOTSUP',
      'removexattr ENOTSUP',
      'lremovexattr ENOTSUP',
      'fremovexattr ENOTSUP',
      // the path is resolved: the l* calls take the link itself
      'listxattr missing ENOENT',
      'getxattr missing ENOENT',
      'setxattr missing ENOENT',
      'removexattr missing ENOENT',
      'listxattr empty path ENOENT',
      'listxattr under a file ENOTDIR',
      'listxattr dangling ENOENT',
      'llistxattr dangling 0',
      'getxattr dangling ENOENT',
      'lgetxattr dangling ENODATA',
      // the fd: bad or O_PATH
      'flistxattr bad fd EBADF',
      'fgetxattr bad fd EBADF',
      'fsetxattr bad fd EBADF',
      'fremovexattr bad fd EBADF',
      'flistxattr O_PATH EBADF',
      'fgetxattr O_PATH EBADF',
      // the name, and set's flags and size
      'getxattr empty name ERANGE',
      'getxattr long name ERANGE',
      'getxattr bad name EFAULT',
      'setxattr bad flags EINVAL',
      'setxattr too big E2BIG',
      'listxattr null path EFAULT',
      '',
    ].join('\n'));
    expect(r.exitCode).toBe(0);
  }, 120_000);
});
