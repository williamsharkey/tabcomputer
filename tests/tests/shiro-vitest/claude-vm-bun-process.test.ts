/**
 * Bun's process-side APIs for claude --vm (src/claude-vm/bun/): zstd, which,
 * sleepSync, spawn, file and stdin. Here on the host's own Node modules (the
 * shim takes node-compat's in the page, which follow Node's); the expected
 * values are what Bun 1.4.2 did for the same calls.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import { Readable } from 'node:stream';
import { createBun } from '@shiro/claude-vm/bun/index';

const env = { fs, process, childProcess, Buffer };
const Bun: any = createBun(env);
const text = async (s: any) => (s ? await new Response(s).text() : String(s));
const tmp = fs.mkdtempSync('/tmp/claude-vm-bun-');

describe('Bun.zstdDecompress(Sync)', () => {
  it("decodes Bun's own zstd frames to a Buffer", async () => {
    // (Bun.zstdCompressSync('hello hello hello'), and of 'x' * 100000 + 'end' at level 19)
    const small = Buffer.from('KLUv/SARZQAAMGhlbGxvIAEAMUoR', 'base64');
    const big = Buffer.from('KLUv/aCjhgEAZQAAIHhlbmQBAJyGORAC', 'base64');
    const out = Bun.zstdDecompressSync(small);
    expect(Buffer.isBuffer(out)).toBe(true);
    expect(out.toString()).toBe('hello hello hello');
    const b = await Bun.zstdDecompress(big);
    expect(b.length).toBe(100003);
    expect(b.toString().endsWith('xend')).toBe(true);
    expect(() => Bun.zstdDecompressSync(Buffer.from('not zstd'))).toThrow();
  });
});

describe('Bun.which and Bun.sleepSync', () => {
  it('which: PATH order, an explicit PATH, a path as given, nothing found', () => {
    const first = (process.env.PATH ?? '').split(':').map((d) => `${d}/sh`).find((p) => fs.existsSync(p));
    expect(Bun.which('sh')).toBe(first);
    expect(Bun.which('nonexistent-cmd')).toBe(null);
    expect(Bun.which('sh', { PATH: '/nowhere' })).toBe(null);
    expect(Bun.which('/bin/sh')).toBe('/bin/sh');
    expect(Bun.which('ls', { PATH: '/usr/bin:/bin' })).toBe('/usr/bin/ls');
  });
  it('sleepSync blocks for the time', () => {
    const t0 = performance.now();
    Bun.sleepSync(50);
    expect(performance.now() - t0).toBeGreaterThanOrEqual(49);
  });
});

describe('Bun.spawn', () => {
  it('stdout piped by default, stderr when asked, exit code; no stdin unless piped', async () => {
    const p = Bun.spawn(['sh', '-c', 'echo hi; echo err >&2; exit 3'], { stderr: 'pipe' });
    expect([await text(p.stdout), await text(p.stderr), await p.exited, p.exitCode, p.signalCode, typeof p.pid, typeof p.stdin])
      .toEqual(['hi\n', 'err\n', 3, 3, null, 'number', 'undefined']);
  });
  it('stdin: a FileSink when piped; bytes written and closed when given', async () => {
    let p = Bun.spawn(['cat'], { stdin: 'pipe' });
    p.stdin.write('abc'); p.stdin.write(new Uint8Array([100, 101])); p.stdin.end();
    expect([await text(p.stdout), await p.exited]).toEqual(['abcde', 0]);
    p = Bun.spawn(['cat'], { stdin: new TextEncoder().encode('from bytes') });
    expect([await text(p.stdout), await p.exited]).toEqual(['from bytes', 0]);
    p = Bun.spawn(['cat'], { stdin: new Response('from a response') });
    expect(await text(p.stdout)).toBe('from a response');
    let err: any;
    try { Bun.spawn(['cat'], { stdin: 'from string' }); } catch (e) { err = e; }
    expect([err?.name, err?.code]).toEqual(['TypeError', 'ERR_INVALID_ARG_TYPE']);
  });
  it('kill: signal codes, exited at 128 + the signal', async () => {
    let p = Bun.spawn(['sleep', '5']); p.kill();
    expect([await p.exited, p.exitCode, p.signalCode, p.killed]).toEqual([143, null, 'SIGTERM', true]);
    p = Bun.spawn(['sleep', '5']); p.kill(9);
    expect([await p.exited, p.exitCode, p.signalCode]).toEqual([137, null, 'SIGKILL']);
  });
  it('onExit runs after exited settles', async () => {
    let seen: unknown = null;
    const p = Bun.spawn(['sh', '-c', 'exit 2'], { onExit: (_p: unknown, code: number, sig: number | null, e?: Error) => { seen = [code, sig, e]; } });
    await p.exited;
    expect(seen).toBe(null);
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([2, null, undefined]);
  });
  it('a missing program throws at once (ENOENT)', () => {
    expect(() => Bun.spawn(['/nonexistent/x'])).toThrow("ENOENT: no such file or directory, posix_spawn '/nonexistent/x'");
    expect(() => Bun.spawn(['nocmd-zz'])).toThrow('Executable not found in $PATH: "nocmd-zz"');
  });
  it('the options form, env and cwd; ignore; Bun.file(fd) and Bun.file(path) as stdout', async () => {
    let p = Bun.spawn({ cmd: ['sh', '-c', 'echo $FOO; pwd'], env: { FOO: 'bar', PATH: process.env.PATH }, cwd: tmp });
    expect(await text(p.stdout)).toBe(`bar\n${fs.realpathSync(tmp)}\n`);
    p = Bun.spawn(['echo', 'x'], { stdout: 'ignore' });
    expect([String(p.stdout), await p.exited]).toEqual(['undefined', 0]);
    const f = `${tmp}/out.txt`;
    const fd = fs.openSync(f, 'w');
    p = Bun.spawn(['echo', 'to file'], { stdout: Bun.file(fd) });
    await p.exited;
    fs.closeSync(fd);
    expect([fs.readFileSync(f, 'utf8'), p.stdout]).toEqual(['to file\n', fd]);
    p = Bun.spawn(['echo', 'to path'], { stdout: Bun.file(f) });
    await p.exited;
    expect([fs.readFileSync(f, 'utf8'), p.stdout]).toEqual(['to path\n', undefined]);
  });
});

describe('Bun.file and Bun.stdin', () => {
  it('size, text, exists, name', async () => {
    const f = `${tmp}/f.txt`;
    fs.writeFileSync(f, 'to path\n');
    expect([Bun.file(f).size, await Bun.file(f).text(), await Bun.file('/nonexistent').exists(), await Bun.file(f).exists(), Bun.file(f).name])
      .toEqual([8, 'to path\n', false, true, f]);
  });
  it("stdin.stream(): the process's stdin as a web stream of bytes", async () => {
    const stdin = Readable.from([Buffer.from('a'), 'b', Buffer.from('c')]);
    const B: any = createBun({ ...env, process: { ...process, env: process.env, cwd: () => process.cwd(), stdin } });
    expect(await new Response(B.stdin.stream()).text()).toBe('abc');
  });
});
