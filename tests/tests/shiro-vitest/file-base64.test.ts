/**
 * Builtins and binary data (williamsharkey/tabcomputer#24): base64 encodes
 * bytes, whatever they are; `file` checks magic numbers (ELF first) before
 * calling anything text, and never opens a FIFO.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import { Shell } from '@shiro/shell';
import { FileSystem } from '@shiro/filesystem';

let shell: Shell;
let fs: FileSystem;
beforeAll(async () => {
  ({ shell, fs } = await createTestShell());
});

async function sh(cmd: string) {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  const lf = (t: string) => t.replace(/\r\n/g, '\n');
  return { out: lf(out), err: lf(err), code };
}

/** A small ELF64 x86-64 file: an executable, or a PIE (ET_DYN, DF_1_PIE) with an interpreter */
function elf64(o: { pie?: boolean; interp?: string; symtab?: boolean; buildId?: boolean } = {}): Uint8Array {
  const phs: [number, Uint8Array][] = [[1, new Uint8Array(0)]];
  if (o.interp) phs.push([3, new TextEncoder().encode(o.interp + '\0')]);
  if (o.pie) {
    const dyn = new DataView(new ArrayBuffer(48));
    dyn.setBigUint64(0, 1n, true); dyn.setBigUint64(8, 0n, true); // DT_NEEDED
    dyn.setBigUint64(16, 0x6ffffffbn, true); dyn.setBigUint64(24, 0x08000000n, true); // DT_FLAGS_1: DF_1_PIE
    phs.push([2, new Uint8Array(dyn.buffer)]);
  }
  if (o.buildId) {
    const note = new Uint8Array(16 + 20);
    const nv = new DataView(note.buffer);
    nv.setUint32(0, 4, true); nv.setUint32(4, 20, true); nv.setUint32(8, 3, true);
    note.set([0x47, 0x4e, 0x55, 0], 12);
    for (let i = 0; i < 20; i++) note[16 + i] = i;
    phs.push([4, note]);
  }
  const phoff = 64, dataOff = phoff + 56 * phs.length;
  const payloadLen = phs.reduce((n, [, d]) => n + d.length, 0);
  const shoff = dataOff + payloadLen, shnum = 2;
  const b = new Uint8Array(shoff + 64 * shnum);
  const v = new DataView(b.buffer);
  b.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]);
  v.setUint16(16, o.pie ? 3 : 2, true); v.setUint16(18, 0x3e, true); v.setUint32(20, 1, true);
  v.setBigUint64(32, BigInt(phoff), true); v.setBigUint64(40, BigInt(shoff), true);
  v.setUint16(52, 64, true); v.setUint16(54, 56, true); v.setUint16(56, phs.length, true);
  v.setUint16(58, 64, true); v.setUint16(60, shnum, true); v.setUint16(62, 0, true);
  let at = dataOff;
  phs.forEach(([type, data], i) => {
    const p = phoff + i * 56;
    v.setUint32(p, type, true);
    v.setBigUint64(p + 8, BigInt(at), true);
    v.setBigUint64(p + 32, BigInt(data.length), true);
    b.set(data, at);
    at += data.length;
  });
  v.setUint32(shoff + 64 + 4, o.symtab ? 2 : 1, true); // the second section: SHT_SYMTAB or SHT_PROGBITS
  return b;
}

describe('base64 on bytes', () => {
  it('random bytes round-trip exactly, through pipes and files', async () => {
    expect((await sh('head -c 65536 /dev/urandom | base64 | base64 -d | wc -c')).out.trim()).toBe('65536');
    expect((await sh('head -c 65536 /dev/urandom > /tmp/r.bin; base64 /tmp/r.bin | base64 -d | cmp - /tmp/r.bin && echo same')).out).toBe('same\n');
    // every short input: 3 random bytes many times (the btoa failure came and went with the bytes)
    expect((await sh('i=0; while [ $i -lt 40 ]; do head -c 3 /dev/urandom > /tmp/s.bin; base64 -w0 /tmp/s.bin | base64 -d | cmp -s - /tmp/s.bin || echo BAD; i=$((i+1)); done; echo done')).out).toBe('done\n');
  });

  it('bytes that are not UTF-8, and UTF-8', async () => {
    expect((await sh("printf '\\377\\376' | base64")).out).toBe('//4=\n');
    expect((await sh("printf 'x\\342\\200\\246y\\n' | base64")).out).toBe('eOKApnkK\n');
    expect((await sh("printf '\\200\\201\\202' | base64 | base64 -d | od -An -tx1")).out.trim()).toBe('80 81 82');
  });

  it('-w: wraps, -w 0 has no newline of its own, --wrap=N, a bad size', async () => {
    expect((await sh('printf abcdefghi | base64 -w 4')).out).toBe('YWJj\nZGVm\nZ2hp\n');
    expect((await sh('printf abcdefghi | base64 -w4')).out).toBe('YWJj\nZGVm\nZ2hp\n');
    expect((await sh('printf abc | base64 -w 0')).out).toBe('YWJj');
    expect((await sh('printf abc | base64 -w0')).out).toBe('YWJj');
    expect((await sh('printf abcdefghi | base64 --wrap=8')).out).toBe('YWJjZGVm\nZ2hp\n');
    const bad = await sh('printf abc | base64 -w x');
    expect([bad.code, bad.err]).toEqual([1, "base64: invalid wrap size: 'x'\n"]);
  });
});

describe('file', () => {
  it('a static x86-64 ELF is an ELF, not text', async () => {
    await fs.writeFile('/tmp/static', elf64());
    expect((await sh('file /tmp/static')).out).toBe('/tmp/static: ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, stripped\n');
    await fs.writeFile('/tmp/static-sym', elf64({ symtab: true }));
    expect((await sh('file -b /tmp/static-sym')).out).toBe('ELF 64-bit LSB executable, x86-64, version 1 (SYSV), statically linked, not stripped\n');
    expect((await sh('file -b --mime-type /tmp/static')).out).toBe('application/x-executable\n');
  });

  it('a PIE with an interpreter and a build id', async () => {
    await fs.writeFile('/tmp/pie', elf64({ pie: true, interp: '/lib/ld-musl-x86_64.so.1', buildId: true }));
    expect((await sh('file -b /tmp/pie')).out).toBe(
      'ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), dynamically linked, interpreter /lib/ld-musl-x86_64.so.1, BuildID[sha1]=000102030405060708090a0b0c0d0e0f10111213, stripped\n');
  });

  it('a FIFO: named, not opened (it used to wait for a writer)', async () => {
    const t0 = Date.now();
    expect((await sh('mkfifo /tmp/ff && file /tmp/ff')).out).toBe('/tmp/ff: fifo (named pipe)\n');
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it('directories, symlinks (-L follows), empty files, data, missing files', async () => {
    await fs.writeFile('/tmp/empty', '');
    await sh('ln -sf /tmp/static /tmp/link');
    expect((await sh('file -b /tmp')).out).toBe('directory\n');
    expect((await sh('file -b /tmp/link')).out).toBe('symbolic link to /tmp/static\n');
    expect((await sh('file -bL /tmp/link')).out).toMatch(/^ELF 64-bit LSB executable/);
    expect((await sh('file -b /tmp/empty')).out).toBe('empty\n');
    expect((await sh('file -b /tmp/r.bin')).out).toBe('data\n');
    expect((await sh('file /nonexistent')).out).toBe("/nonexistent: cannot open `/nonexistent' (No such file or directory)\n");
  });

  it('magic numbers and text kinds, names aligned as file does', async () => {
    await fs.mkdir('/tmp/f', { recursive: true });
    await fs.writeFile('/tmp/f/s.sh', '#!/bin/sh\necho hi\n');
    await fs.writeFile('/tmp/f/d.json', '{"a": [1, 2]}\n');
    await fs.writeFile('/tmp/f/p.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 16, 0, 0, 0, 8, 8, 6, 0, 0, 0]));
    await fs.writeFile('/tmp/f/u.txt', 'héllo\r\nworld\r\n');
    await fs.writeFile('/tmp/f/m.wasm', new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]));
    const r = await sh('cd /tmp/f && file s.sh d.json p.png u.txt m.wasm');
    expect(r.out).toBe([
      's.sh:   POSIX shell script, ASCII text executable',
      'd.json: JSON text data',
      'p.png:  PNG image data, 16 x 8, 8-bit/color RGBA, non-interlaced',
      'u.txt:  Unicode text, UTF-8 text, with CRLF line terminators',
      'm.wasm: WebAssembly (wasm) binary module version 0x1 (MVP)',
      '',
    ].join('\n'));
    expect((await sh('file -b --mime-type /tmp/f/d.json')).out).toBe('application/json\n');
    expect((await sh('file -bi /tmp/f/u.txt')).out).toBe('text/plain; charset=utf-8\n');
  });
});
