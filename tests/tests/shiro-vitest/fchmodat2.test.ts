/**
 * fchmodat2(fd, "", mode, AT_EMPTY_PATH) is fchmod of the descriptor, O_PATH
 * ones included, as on Linux 6.6+. systemd 257's fchmod_opath() calls it, and
 * when Blink answered ENOENT (patch 0514's empty-path check), systemd-sysusers
 * failed in systemd's postinst and every apt install pulling in systemd (udev,
 * initramfs-tools, linux-image-*) with it. fixtures/x86/fchmodat2.c under Blink
 * prints what native Linux prints.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createTestShell, run } from './helpers';

const FIX = resolve(__dirname, 'fixtures/x86');
const bin = join(mkdtempSync(join(tmpdir(), 'shiro-fchmodat2-')), 'fchmodat2');
const haveBin = (() => {
  try { execFileSync('gcc', ['-static', '-O1', '-o', bin, 'fchmodat2.c'], { cwd: FIX, stdio: 'pipe', timeout: 120_000 }); return true; } catch { return false; }
})();

describe('fchmodat2 (x86 under Blink)', () => {
  it.skipIf(!haveBin)('AT_EMPTY_PATH changes the descriptor\'s file, O_PATH too; an empty path without it is ENOENT', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/work/prog', readFileSync(bin), { mode: 0o755 });
    const r = await run(shell, 'cd /home/user/work && ./prog');
    expect(r.output.replace(/\r\n/g, '\n')).toBe('fd ok 644\nopath ok 600\nnoflag ENOENT 600\nnamed ok 640\n');
  }, 120_000);
});
