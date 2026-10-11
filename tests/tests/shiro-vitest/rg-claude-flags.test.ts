/**
 * tabcomputer#44: the flags Claude Code's Grep and Glob tools give ripgrep:
 * --null is a switch (a NUL after each path), --json prints ripgrep's JSON
 * lines, -U/--multiline-dotall match across lines, -m limits matches, and a
 * binary file (a NUL near its start) is skipped without being read whole.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.mkdir('/tmp/rg44', { recursive: true } as any);
  await fs.writeFile('/tmp/rg44/A.md', '# Title\nOrient yourself\n\n- `doctor` here\nnothing\nanother doctor and doctor\n');
  await sh('cd /tmp/rg44');
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

describe("rg with Claude Code's flags", () => {
  it("--version and -V answer as ripgrep's do: Claude Code's first-use probe needs 'ripgrep ' (#57)", async () => {
    for (const cmd of ['rg --version', 'rg -V', 'rg --hidden --version']) {
      const r = await sh(cmd);
      // (the probe: code === 0 && stdout.startsWith("ripgrep "))
      expect(r.code, cmd).toBe(0);
      expect(r.out.startsWith('ripgrep '), `${cmd}: ${r.out}`).toBe(true);
    }
    // a -V that is a pattern still searches (in a directory of its own: the other tests list /tmp/rg44)
    await fs.mkdir('/tmp/rg57', { recursive: true } as any);
    await fs.writeFile('/tmp/rg57/v.txt', 'a -V b\n');
    expect((await sh('rg -e -V /tmp/rg57/v.txt')).out).toBe('/tmp/rg57/v.txt:1:a -V b\n');
    expect((await sh('rg -- -V /tmp/rg57/v.txt')).out).toBe('/tmp/rg57/v.txt:1:a -V b\n'); // (after --, the first word is the pattern)
  });

  it('--null: a switch, a NUL after each path (-l, -c -H, --files)', async () => {
    const l = await sh("rg --hidden --glob '!.git' --max-columns 500 -l --null doctor A.md");
    expect(l.out).toBe('A.md\0');
    expect(l.code).toBe(0);
    expect((await sh('rg --hidden --max-columns 500 -c -H --null doctor A.md')).out).toBe('A.md\x002\n');
    expect((await sh('rg --files --null')).out).toBe('A.md\0');
  });

  it("--json: ripgrep's begin / match / end / summary lines", async () => {
    const r = await sh("rg --hidden --glob '!.git' --max-columns 500 --json -n doctor A.md");
    const events = r.out.trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(['begin', 'match', 'match', 'end', 'summary']);
    expect(events[1].data).toMatchObject({ path: { text: 'A.md' }, lines: { text: '- `doctor` here\n' }, line_number: 4, submatches: [{ match: { text: 'doctor' }, start: 3, end: 9 }] });
    expect(events[2].data.submatches).toHaveLength(2);
    expect(events[4].data).toMatchObject({ matches: 3, matched_lines: 2, searches_with_match: 1 });
  });

  it('-U --multiline-dotall: a match across lines', async () => {
    expect((await sh("rg -U --multiline-dotall -n 'Orient.*?doctor' A.md")).out).toBe('A.md:2:Orient yourself\nA.md:3:\nA.md:4:- `doctor` here\n');
    expect((await sh("rg -U -n 'Orient.*doctor' A.md; echo rc=$?")).out).toBe('rc=1\n');
  });

  it('-m: at most N matching lines', async () => {
    expect((await sh('rg -m 1 -n doctor A.md')).out).toBe('A.md:4:- `doctor` here\n');
  });

  it('a binary file is skipped, a big one without being read whole', async () => {
    const big = new Uint8Array(3 << 20);
    big.set(new TextEncoder().encode('doctor'), 10);
    big[100] = 0;
    await fs.writeFile('/tmp/rg44/bin.dat', big);
    expect((await sh('rg -l doctor .')).out).toBe('./A.md\n');
  });
});
