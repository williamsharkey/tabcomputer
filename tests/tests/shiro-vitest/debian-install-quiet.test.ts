/**
 * tabcomputer#110: `toolchain install X` on a tab without Debian printed 25
 * `overlay: ... now tabcomputer's` lines before the one that matters. They
 * are behind -v/--verbose now; without it, one line counts them.
 */
import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTestShell, run } from './helpers';
import { overlayReport } from '@shiro/debian/overlay';

const haveRootfs = existsSync(resolve(__dirname, '../../../public/debian/rootfs.json'));

describe('overlayReport', () => {
  const changed = ["/usr/bin/grep: now tabcomputer's (grep); Debian's file is /usr/bin/grep.debian", "/usr/bin/sed: now Debian's"];
  const refused = '/usr/bin/cut: /usr/bin/cut.debian exists; refusing to overwrite it';
  const ONE = '  overlay: 2 programs set to their defaults (-v lists each; tabcomputer-alternatives --list)';
  it('one line with the count, every change with -v, nothing when nothing changed', () => {
    expect(overlayReport(changed, false)).toEqual([ONE]);
    expect(overlayReport(changed.slice(0, 1), false)[0]).toContain('1 program set to');
    expect(overlayReport(changed, true)).toEqual(changed.map((c) => `  overlay: ${c}`));
    expect(overlayReport([], false)).toEqual([]);
    expect(overlayReport([], true)).toEqual([]);
  });
  it('a change that was refused is shown either way', () => {
    expect(overlayReport([changed[0], refused, changed[1]], false)).toEqual([ONE, `  overlay: ${refused}`]);
    expect(overlayReport([refused], false)).toEqual([`  overlay: ${refused}`]);
    expect(overlayReport([changed[0], refused], true)).toEqual([`  overlay: ${changed[0]}`, `  overlay: ${refused}`]);
  });
});

/** A machine with an empty disk (createTestShell's machines share one otherwise) */
async function freshMachine() {
  await new Promise<void>((res, rej) => {
    const req = indexedDB.deleteDatabase('tabcomputer-fs');
    req.onsuccess = () => res();
    req.onerror = () => rej(req.error);
  });
  return createTestShell();
}

describe.skipIf(!haveRootfs)('the overlay lines of debian install and toolchain install', () => {
  const overlayLines = (out: string) => out.replace(/\r/g, '').split('\n').filter((l) => l.includes('overlay:'));
  const ONE = /^ {2}overlay: \d+ programs set to their defaults \(-v lists each; tabcomputer-alternatives --list\)$/;
  const EACH = /^ {2}overlay: \/\S+: now tabcomputer's \(/;

  it('debian install prints one line', async () => {
    const { shell } = await freshMachine();
    const r = await run(shell, 'debian install');
    expect(r.exitCode).toBe(0);
    const lines = overlayLines(r.output);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(ONE);
    expect(r.output).not.toContain("now tabcomputer's");
    // the programs are overlaid all the same
    expect((await run(shell, 'tabcomputer-alternatives --display grep')).output).toMatch(/tabcomputer \(grep\)/);
  }, 60_000);

  it('debian install -v lists each change', async () => {
    for (const flag of ['-v', '--verbose']) {
      const { shell } = await freshMachine();
      const r = await run(shell, `debian install ${flag}`);
      expect(r.exitCode).toBe(0);
      const lines = overlayLines(r.output);
      expect(lines.length).toBeGreaterThan(10);
      for (const l of lines) expect(l).toMatch(EACH);
    }
  }, 60_000);

  // (no layer server and no package lists here: the set itself fails once Debian is in)
  it('toolchain install on a machine without Debian: one line, or each with -v', async () => {
    let { shell } = await freshMachine();
    let out = (await run(shell, 'toolchain install c')).output;
    expect(out).toContain('Installing Debian first');
    let lines = overlayLines(out);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(ONE);
    ({ shell } = await freshMachine());
    out = (await run(shell, 'toolchain install c -v')).output;
    lines = overlayLines(out);
    expect(lines.length).toBeGreaterThan(10);
    for (const l of lines) expect(l).toMatch(EACH);
  }, 240_000);
});
