/**
 * tabcomputer#44: `rg -l doctor ~/.local` stalled the page for 2.9 s reading the
 * 250 MB claude binary whole. rg now reads a file a block at a time: a NUL in its
 * first block skips it without reading the rest, a big text file is searched
 * block by block (never one buffer or string), and -l stops at the first match.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import { FileSystem } from '@shiro/filesystem';
import type { Shell } from '@shiro/shell';

let shell: Shell;
let fs: FileSystem;
/** What rg read: whole files (readFile) and block numbers (readBlock) */
let wholeReads: string[];
let blockReads: number[];

const MiB = 1 << 20;
const BIG = 9 * MiB; // over FileSystem.CONTENT_BIG, so an idle copy leaves memory
const enc = new TextEncoder();

beforeEach(async () => {
  ({ shell, fs } = await createTestShell());
  // The test FileSystem is shared between tests (one IndexedDB): start each in an empty directory,
  // or `rg -l doctor .` also finds the files earlier tests left there
  await fs.rm('/tmp/rg44b', { recursive: true }).catch(() => {});
  await fs.mkdir('/tmp/rg44b', { recursive: true } as any);
  await sh('cd /tmp/rg44b');
  wholeReads = [];
  blockReads = [];
  const readFile = fs.readFile.bind(fs);
  const readBlock = fs.readBlock.bind(fs);
  (fs as any).readFile = (p: string, ...a: any[]) => { if (p.startsWith('/tmp/rg44b/')) wholeReads.push(p); return (readFile as any)(p, ...a); };
  (fs as any).readBlock = (id: string, i: number, keep?: boolean) => { blockReads.push(i); return readBlock(id, i, keep); };
});

async function sh(cmd: string) {
  let out = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { out += s; });
  return { out: out.replace(/\r\n/g, '\n'), code };
}

/** `size` bytes of 100-byte lines ('x' × 99 and a newline); `put` writes text at byte offsets */
function textFile(size: number, put: Record<number, string> = {}): Uint8Array {
  const b = new Uint8Array(size).fill(0x78);
  for (let i = 99; i < size; i += 100) b[i] = 0x0a;
  for (const [off, s] of Object.entries(put)) b.set(enc.encode(s), Number(off));
  return b;
}
/** The 1-based line number of a byte offset in textFile's layout */
const lineAt = (off: number) => Math.floor(off / 100) + 1;

/** Store a big file and let its bytes leave memory, as an idle 250 MB binary's do */
async function bigFile(path: string, bytes: Uint8Array) {
  await fs.writeFile(path, bytes);
  await fs.sync();
  fs.sweepContent(Date.now() + FileSystem.CONTENT_IDLE_MS + 1);
  expect(fs.blobOf(path)).toBeUndefined(); // (the case blobOf alone missed: rg read it whole)
  expect(await fs.blobId(path)).toBeTruthy();
}

describe('rg and binary or big files (#44)', () => {
  it('skips a file with a NUL near its start, named or found in a directory', async () => {
    await fs.writeFile('/tmp/rg44b/a.txt', 'doctor here\n');
    await fs.writeFile('/tmp/rg44b/b.bin', enc.encode('ELF\0doctor\n'));
    expect((await sh('rg -l doctor .')).out).toBe('./a.txt\n');
    expect((await sh('rg doctor b.bin; echo rc=$?')).out).toBe('rc=1\n');
  });

  it('a big binary is skipped after its first block, never read whole', async () => {
    const bytes = textFile(BIG, { [2 * MiB + 10]: 'doctor' });
    bytes[7] = 0; // an ELF header has NULs at once
    await bigFile('/tmp/rg44b/claude', bytes);
    expect((await sh('rg -l doctor claude; echo rc=$?')).out).toBe('rc=1\n');
    expect(wholeReads).toEqual([]);
    expect(blockReads).toEqual([0]);
  });

  it('a big text file is searched a block at a time, lines and characters split across blocks intact', async () => {
    // 'doc|tor' across the 1 MiB block boundary (one line), 'é' (2 bytes) split by the 2 MiB one,
    // and a match on the last, unterminated line
    const last = 9 * MiB + 216; // line start 9 MiB + 216 (9 MiB % 100 = 84), column 0
    const bytes = textFile(9 * MiB + 300, { [MiB - 3]: 'doc', [MiB]: 'tor', [2 * MiB - 1]: 'é', [last + 10]: 'doctor' });
    await bigFile('/tmp/rg44b/big.txt', bytes);
    expect((await sh('rg -n -o "doctor|é" big.txt')).out)
      .toBe(`big.txt:${lineAt(MiB - 3)}:doctor\nbig.txt:${lineAt(2 * MiB - 1)}:é\nbig.txt:${lineAt(last + 10)}:doctor\n`);
    expect(wholeReads).toEqual([]);
    expect(blockReads).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]); // through the empty block past the end
  });

  it('-l stops at the first match; -m 1 once it has its match', async () => {
    await bigFile('/tmp/rg44b/early.txt', textFile(BIG, { 150: 'doctor', [4 * MiB + 50]: 'doctor' }));
    expect((await sh('rg -l doctor early.txt')).out).toBe('early.txt\n');
    expect(blockReads).toEqual([0]);
    blockReads.length = 0;
    expect((await sh('rg -c -m 1 doctor early.txt')).out).toBe('early.txt:1\n');
    expect(blockReads).toEqual([0]);
  });

  it('--json offsets and before-context come out right in a later block', async () => {
    const at = 31460 * 100; // a line start in block 3
    await bigFile('/tmp/rg44b/j.txt', textFile(BIG, { [at]: 'doctor' }));
    const events = (await sh('rg --json -B1 doctor j.txt')).out.trim().split('\n').map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual(['begin', 'context', 'match', 'end', 'summary']);
    expect(events[1].data).toMatchObject({ line_number: lineAt(at) - 1, absolute_offset: at - 100 });
    expect(events[2].data).toMatchObject({ line_number: lineAt(at), absolute_offset: at, submatches: [{ start: 0, end: 6 }] });
    expect(events[2].data.lines.text).toBe('doctor' + 'x'.repeat(93) + '\n');
    expect(wholeReads).toEqual([]);
  });

  it('a NUL after the first block ends the search there, as in rg', async () => {
    const bytes = textFile(BIG, { 100: 'doctor', [3 * MiB + 100]: 'doctor' });
    bytes[2 * MiB + 5] = 0;
    await bigFile('/tmp/rg44b/late.bin', bytes);
    expect((await sh('rg -c doctor late.bin')).out).toBe('late.bin:1\n');
    expect(Math.max(...blockReads)).toBe(2);
  });

  it('a final newline ends the last line; it is no extra empty line', async () => {
    await fs.writeFile('/tmp/rg44b/s.txt', 'one\ntwo\n');
    expect((await sh('rg -c -v zzz s.txt')).out).toBe('s.txt:2\n');
    expect((await sh("rg -c '^' s.txt")).out).toBe('s.txt:2\n');
    expect((await sh('rg -n -v one s.txt')).out).toBe('s.txt:2:two\n');
  });

  it('--null is a switch: the pattern after it is still the pattern', async () => {
    await fs.writeFile('/tmp/rg44b/A.md', '# Title\n- `doctor` here\nnothing\n');
    expect((await sh('rg --null doctor A.md')).out).toBe('A.md\x002:- `doctor` here\n');
    expect((await sh('rg -0 -l doctor .')).out).toBe('./A.md\0');
  });
});
