/**
 * Text tools against their real counterparts (util-linux 2.39 hexdump and
 * column, GNU coreutils 9.4 join, stat, split and truncate, gawk 5.2, GNU
 * sed 4.9, grep 3.11, findutils 4.9): each expected output is what the real
 * tool printed for the same input.
 * tests/gnu-tools-cases.txt and gnu-tools-diff.test.ts compare many more.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import type { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;
beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
  await fs.mkdir('/tmp/tt', { recursive: true } as any).catch(() => {});
  await fs.writeFile('/tmp/tt/j1', 'a 1\nb 2\nc 3\n');
  await fs.writeFile('/tmp/tt/j2', 'a x\nc y\nd z\n');
  await fs.writeFile('/tmp/tt/b.csv', 'name,age,city\nalice,30,NYC\ndave,,SF\n');
});

async function sh(cmd: string) {
  let out = '', err = '';
  const code = await shell.execute(`cd /tmp/tt && ${cmd}`, (s) => { out += s; }, (s) => { err += s; });
  return { code, out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n') };
}

describe('hexdump (util-linux)', () => {
  const BIN = "printf 'ab\\000\\377hello world 1234567890abcdef\\n'";
  it('-C takes the file operand; the ASCII column is as long as the line', async () => {
    expect(await sh(`${BIN} > hx.bin; hexdump -C hx.bin`)).toMatchObject({ code: 0, out:
      '00000000  61 62 00 ff 68 65 6c 6c  6f 20 77 6f 72 6c 64 20  |ab..hello world |\n' +
      '00000010  31 32 33 34 35 36 37 38  39 30 61 62 63 64 65 66  |1234567890abcdef|\n' +
      '00000020  0a                                                |.|\n' +
      '00000021\n' });
  });
  it('the default is little-endian two-byte words, short lines padded', async () => {
    expect((await sh(`${BIN} | hexdump`)).out).toBe(
      '0000000 6261 ff00 6568 6c6c 206f 6f77 6c72 2064\n' +
      '0000010 3231 3433 3635 3837 3039 6261 6463 6665\n' +
      '0000020 000a                                   \n' +
      '0000021\n');
  });
  it('-c, -n, -s, and repeated lines squeezed to * (not with -v)', async () => {
    expect((await sh(`${BIN} | hexdump -c -n 4`)).out).toBe(`0000000   a   b  \\0 377${' '.repeat(48)}\n0000004\n`);
    expect((await sh(`${BIN} | hexdump -C -s 4 -n 6`)).out).toBe('00000004  68 65 6c 6c 6f 20                                 |hello |\n0000000a\n');
    const a49 = `printf '${'a'.repeat(48)}z'`;
    expect((await sh(`${a49} | hexdump -C`)).out).toBe(
      '00000000  61 61 61 61 61 61 61 61  61 61 61 61 61 61 61 61  |aaaaaaaaaaaaaaaa|\n*\n' +
      '00000030  7a                                                |z|\n00000031\n');
    expect((await sh(`${a49} | hexdump -Cv | wc -l`)).out.trim()).toBe('5');
    expect((await sh("printf '' | hexdump -C")).out).toBe('');
    expect(await sh('hexdump nosuch')).toMatchObject({ code: 1, err: 'hexdump: nosuch: No such file or directory\nhexdump: all input file arguments failed\n' });
  });
});

describe('join (GNU)', () => {
  it('pairs lines on the join field; -a, -v, -e with -o', async () => {
    expect((await sh('join j1 j2')).out).toBe('a 1 x\nc 3 y\n');
    expect((await sh('join -a1 -a2 -e NA -o 0,1.2,2.2 j1 j2')).out).toBe('a 1 x\nb 2 NA\nc 3 y\nd NA z\n');
    expect((await sh('join -v2 j1 j2')).out).toBe('d z\n');
    expect((await sh('cat j1 | join - j2')).out).toBe('a 1 x\nc 3 y\n');
  });
  it('-t is the output separator too', async () => {
    expect((await sh("join -t, <(printf 'a,1\\nb,2\\n') <(printf 'a,x\\nb,y\\n')")).out).toBe('a,1,x\nb,2,y\n');
  });
});

describe('column (util-linux 2.39)', () => {
  it('-s keeps empty cells; a row that ends early still gets its separators', async () => {
    expect((await sh('column -t -s, b.csv')).out).toBe('name   age  city\nalice  30   NYC\ndave        SF\n');
    expect((await sh("printf 'a b c\\nd e\\n' | column -t -o '|'")).out).toBe('a|b|c\nd|e|\n');
  });
});

describe('awk (gawk)', () => {
  it('BEGINFILE and ENDFILE run around each input file', async () => {
    expect((await sh("awk 'BEGINFILE{print FILENAME} ENDFILE{print FNR}' j1 b.csv")).out).toBe('j1\n3\nb.csv\n3\n');
  });
  it('PROCINFO["sorted_in"] orders for-in', async () => {
    expect((await sh(`awk 'BEGIN{PROCINFO["sorted_in"]="@val_num_desc"; a["x"]=3;a["y"]=10;a["z"]=1; for(k in a) printf k " "; print ""}'`)).out).toBe('y x z \n');
    expect((await sh(`awk 'BEGIN{PROCINFO["sorted_in"]="@ind_num_asc"; a[10];a[9];a[100]; for(k in a) printf k " "; print ""}'`)).out).toBe('9 10 100 \n');
    expect((await sh(`awk 'BEGIN{PROCINFO["sorted_in"]="@ind_str_desc"; a["b"];a["a"];a["c"]; for(k in a) printf k; print ""}'`)).out).toBe('cba\n');
  });
  it("printf's ' flag (thousands grouping: none in the C locale)", async () => {
    expect((await sh(`awk 'BEGIN { printf "%'"'"'d\\n", 1234567 }'`)).out).toBe('1234567\n');
  });
});

describe('sed (GNU)', () => {
  it('-f /dev/stdin reads the script from stdin', async () => {
    expect((await sh("echo 's/a/Q/' | sed -f /dev/stdin j1")).out).toBe('Q 1\nb 2\nc 3\n');
  });
});

describe('stat (GNU)', () => {
  it('--format= and --printf (escapes, no newline of its own)', async () => {
    expect((await sh("stat --format='%n %s' j1")).out).toBe('j1 12\n');
    expect((await sh("stat --printf='%n\\t%s\\n' j1 b.csv")).out).toBe('j1\t12\nb.csv\t36\n');
  });
  it('%A has the type letter, %f the type bits; width and flags; an empty file', async () => {
    expect((await sh("mkdir -p d; stat -c '%A %a %f %F' j1 d")).out).toBe('-rw-r--r-- 644 81a4 regular file\ndrwxr-xr-x 755 41ed directory\n');
    expect((await sh("stat -c '%10s|%-4n|%05a' j1")).out).toBe('        12|j1  |00644\n');
    expect((await sh("touch e; stat -c '%F' e")).out).toBe('regular empty file\n');
  });
  it('a missing file is an error on stderr, status 1; the others still print', async () => {
    expect(await sh('stat -c %n nosuch j1')).toMatchObject({ code: 1, out: 'j1\n', err: "stat: cannot statx 'nosuch': No such file or directory\n" });
  });
});

describe('grep (GNU)', () => {
  it('empty input has no lines', async () => {
    expect((await sh('true | grep -v x; echo $?')).out).toBe('1\n');
    expect((await sh("printf '' | grep -c ''")).out).toBe('0\n');
  });
  it('-b: byte offsets of lines, or of matches with -o', async () => {
    expect((await sh('grep -b b j1')).out).toBe('4:b 2\n');
    expect((await sh('grep -o -b 2 j1')).out).toBe('6:2\n');
  });
  it('-Z ends file names with NUL; -z reads and writes NUL-terminated lines', async () => {
    expect((await sh('grep -lZ a j1 b.csv | od -An -c')).out).toBe('   j   1  \\0   b   .   c   s   v  \\0\n');
    expect((await sh("printf 'x\\0a b\\0y' | grep -z a | od -An -c")).out).toBe('   a       b  \\0\n');
  });
});

describe('find (GNU)', () => {
  it('-newermt DATE', async () => {
    expect((await sh('find . -newermt 2000-01-01 -name j1')).out).toBe('./j1\n');
    expect((await sh('find . -newermt 2999-01-01 -name j1')).out).toBe('');
  });
});

describe('split and truncate (GNU)', () => {
  it('split keeps every piece\'s last newline; -n, -d, suffixes that widen', async () => {
    expect((await sh('seq 1 7 > s; split -l 3 s p; cat pab | od -An -c')).out).toBe('   4  \\n   5  \\n   6  \\n\n');
    expect((await sh('seq 1 7 > s; split -n 3 -d s q; wc -c q00 q01 q02')).out).toBe(' 5 q00\n 5 q01\n 4 q02\n14 total\n');
    expect((await sh('seq 1 700 > big; split -l 1 big w; ls w* | tail -2')).out).toBe('wzabw\nwzabx\n');
  });
  it('split will not overwrite its input', async () => {
    expect(await sh('seq 1 1000 > big; split -l 1 big b')).toMatchObject({ code: 1, err: 'split: big would overwrite input; aborting\n' });
  });
  it('truncate: absolute and relative sizes, NUL fill, -c, -r', async () => {
    expect((await sh("printf abcdef > f; truncate -s 3 f; cat f; truncate -s '>5' f; od -An -c f")).out).toBe('abc   a   b   c  \\0  \\0\n');
    expect((await sh('truncate -s %4 f; wc -c < f; truncate -s 1K h; truncate -r h -s -24 i; wc -c < i')).out).toBe('8\n1000\n');
    expect(await sh('truncate -c -s 5 nofile; ls nofile')).toMatchObject({ code: 2, out: '' });
  });
});
