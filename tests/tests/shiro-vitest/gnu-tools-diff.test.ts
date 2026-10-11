/**
 * Differential check of the built-in tools against the real ones: every
 * command in tests/gnu-tools-cases.txt runs in tabcomputer's shell and in the
 * host's bash (GNU sed, coreutils, findutils, gawk, util-linux) on the same
 * files; the differences go to a report. Opt-in, since it needs those tools:
 *   GNU_DIFF=1 npx vitest run --config vitest.config.ts gnu-tools-diff
 * (GNU_DIFF_CASES / GNU_DIFF_OUT: another case list, another report path).
 * Known differences: --version lines, find -depth's order and -newer within
 * one millisecond, xargs -t's trace order against 2>&1, gawk's FPAT, |&,
 * @include and length() of an untyped name, sed's e command, cmp's older
 * "char" wording, fmt's line filling.
 */
import { it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createTestShell } from './helpers';

const FILES: Record<string, string> = {
  'a.txt': 'banana\napple\ncherry\napple\n10\n9\n-3\n2.5\nApple\n',
  'b.csv': 'name,age,city\nalice,30,NYC\nbob,25,LA\ncarol,35,NYC\ndave,,SF\n',
  'src/main.ts': 'import { x } from "./lib";\nconsole.log(x);\n// TODO: fix\n',
  'src/lib.ts': 'export const x = 1;\n// TODO later\n',
  'src/sub/deep.js': 'function f() {\n  return 42;\n}\n',
  'src/sub/notes.md': '# Title\n\nSome text.\n',
  'log.txt': '2024-01-01 INFO start\n2024-01-01 ERROR boom\n2024-01-02 WARN slow\n2024-01-02 ERROR bang\n2024-01-03 INFO done\n',
  'sp ace.txt': 'x y z\n',
  'tabs.tsv': 'k1\tv1\tz\nk2\tv2\tz\nk3\t\tz\n',
  'nums.txt': '3\n1\n2\n10\n1e3\n0x10\n 5\n',
  'ver.txt': 'v1.10.0\nv1.2.0\nv1.9.3\nv2.0.0-rc1\nv2.0.0\n',
  'h.txt': '1K\n2M\n512\n3G\n10K\n',
  'crlf.txt': 'one\r\ntwo\r\n',
  'noeol.txt': 'last line no newline',
  'pkg.json': '{"name":"x","version":"1.2.3","scripts":{"test":"vitest"}}\n',
};

it.skipIf(!process.env.GNU_DIFF)('tabcomputer vs the GNU tools', async () => {
  const CASES = readFileSync(process.env.GNU_DIFF_CASES || new URL('../../gnu-tools-cases.txt', import.meta.url), 'utf8');
  const real = mkdtempSync('/tmp/gnudiff-');
  for (const [p, c] of Object.entries(FILES)) { mkdirSync(`${real}/${p}`.replace(/\/[^/]*$/, ''), { recursive: true }); writeFileSync(`${real}/${p}`, c); }
  const { shell, fs } = await createTestShell();
  // (a fresh copy of the files per command, in both: commands write and delete)
  const lines = CASES.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const report: string[] = [];
  let same = 0;
  for (const cmd of lines) {
    const virt = `/tmp/gnudiff${Math.random().toString(36).slice(2, 8)}`;
    for (const [p, c] of Object.entries(FILES)) { await fs.mkdir(`${virt}/${p}`.replace(/\/[^/]*$/, ''), { recursive: true } as any).catch(() => {}); await fs.writeFile(`${virt}/${p}`, c); }
    const rd = mkdtempSync('/tmp/gnudiff-run-');
    execFileSync('cp', ['-r', `${real}/.`, rd]);
    let rOut = '', rCode = 0;
    try { rOut = execFileSync('bash', ['-c', cmd], { cwd: rd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, LC_ALL: 'C.UTF-8' } }); }
    catch (e: any) { rOut = e.stdout ?? ''; rCode = e.status ?? -1; }
    let vOut = '';
    const vCode = await Promise.race([shell.execute(`cd ${virt} && ${cmd}`, (s) => { vOut += s; }, () => {}), new Promise<number>((r) => setTimeout(() => r(-99), 10000))]);
    vOut = vOut.replace(/\r\n/g, '\n').split(virt).join('.').split(rd).join('.');
    rOut = rOut.split(rd).join('.');
    rmSync(rd, { recursive: true, force: true });
    if (vOut === rOut && vCode === rCode) { same++; continue; }
    report.push(`### ${cmd}\n--- real (${rCode})\n${rOut}--- tab (${vCode})\n${vOut}`);
  }
  rmSync(real, { recursive: true, force: true });
  console.log(`same ${same}/${lines.length}; report: ${process.env.GNU_DIFF_OUT || '/tmp/gnu-tools-diff.txt'}`);
  writeFileSync(process.env.GNU_DIFF_OUT || '/tmp/gnu-tools-diff.txt', `same ${same}/${lines.length}\n\n` + report.join('\n'));
}, 1200000);
