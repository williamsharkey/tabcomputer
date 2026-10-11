/**
 * The kernel profiler (src/kernel/profiler.ts, Kernel.startProfile, strace -c):
 * per-syscall calls, sync vs async, kernel CPU and wall time, blocked time,
 * descriptor kinds, paths, followed children, and keystroke timing through a pty.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import * as A from '@shiro/kernel/abi';
import { Kernel } from '@shiro/kernel/kernel';
import { createPipe } from '@shiro/kernel/pipe';
import { openpty, makeRaw } from '@shiro/kernel/pty';
import { formatReport, syscallName } from '@shiro/kernel/profiler';

let shell: Shell;
beforeAll(async () => { ({ shell } = await createTestShell()); });

const enc = new TextEncoder();
const forever = () => new Promise<number>(() => {});
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

describe('kernel profiler', () => {
  it('counts the followed processes\' calls: sync and async, errors, paths, descriptor kinds, blocked reads', async () => {
    const kernel = new Kernel({ shell });
    const [r, w] = createPipe();
    const p = kernel.spawn({ path: 'prog', fds: { 0: r, 1: w }, run: forever });
    const other = kernel.spawn({ path: 'other', run: forever });
    const prof = kernel.startProfile({ pids: [p.pid] });
    expect(kernel.profiler).toBe(prof);
    const data = new Uint8Array(4096);

    for (let i = 0; i < 3; i++) expect(kernel.syscallSync(p, A.SYS_getpid, [0, 0, 0, 0, 0, 0], data)).toBe(p.pid);
    kernel.syscallSync(other, A.SYS_getpid, [0, 0, 0, 0, 0, 0], data); // not followed
    // a path call, twice, once failing
    const stat = async (path: string) => {
      const b = enc.encode(path);
      data.set(b);
      return kernel.syscall(p, A.SYS_stat, [b.length, 0, 0, 0, 0, 0], data);
    };
    expect(await stat('/tmp')).toBe(0);
    expect(await stat('/no/such/file')).toBe(-A.ENOENT);
    // a read on the pipe blocks until a write comes
    const reading = kernel.syscall(p, A.SYS_read, [0, 16, 0, 0, 0, 0], new Uint8Array(16));
    await tick(30);
    data.set(enc.encode('hi'));
    expect(kernel.syscallSync(p, A.SYS_write, [1, 2, 0, 0, 0, 0], data)).toBe(2);
    expect(await reading).toBe(2);

    // a wait with a timeout: by timeout, and whether it timed out
    expect(await kernel.syscall(p, A.SYS_poll, [0, 10, 0, 0, 0, 0], new Uint8Array(8))).toBe(0);

    const rep = kernel.stopProfile()!;
    expect(kernel.profiler).toBeNull();
    expect(rep.syscalls.find((s) => s.name === 'poll')).toMatchObject({ calls: 1, timeouts: { 10: 1 }, zero: 1, maxArgs: [0, 10, 0, 0, 0, 0] });
    expect(formatReport(rep)).toMatch(/poll +10: 1; 1 timed out/);
    const by = (name: string) => rep.syscalls.find((s) => s.name === name)!;
    expect(by('getpid')).toMatchObject({ calls: 3, sync: 3, errors: 0 });
    expect(by('stat')).toMatchObject({ calls: 2, errors: 1, sync: 0 });
    expect(by('read').calls).toBe(1);
    expect(by('read').wallUs).toBeGreaterThanOrEqual(20_000); // blocked ~30 ms
    expect(by('read').maxUs).toBe(by('read').wallUs);
    expect(by('write')).toMatchObject({ calls: 1, sync: 1 });
    expect(rep.totals.calls).toBe(8);
    expect(rep.totals.errors).toBe(1);
    expect(rep.byKind['read:pipe']).toMatchObject({ calls: 1, bytes: 2 });
    expect(rep.byKind['write:pipe']).toMatchObject({ calls: 1, bytes: 2 });
    expect(rep.paths.map((x) => [x.path, x.calls, x.errors])).toEqual(expect.arrayContaining([['/tmp', 1, 0], ['/no/such/file', 1, 1]]));
    expect(rep.procs.map((x) => x.pid)).toEqual([p.pid]);
    expect(rep.timeline.reduce((n, b) => n + b.calls, 0)).toBe(8);

    const text = formatReport(rep);
    expect(text).toMatch(/^8 calls in /);
    expect(text).toMatch(/\bgetpid\n/);
    expect(text).toMatch(/ total\n/);
    expect(text).toContain('/no/such/file  (stat)');

    // detached: nothing more is counted
    kernel.syscallSync(p, A.SYS_getpid, [0, 0, 0, 0, 0, 0], data);
    expect(prof.report().totals.calls).toBe(8);
  });

  it('follows children of followed processes; a filter picks processes by other rules', async () => {
    const kernel = new Kernel({ shell });
    const parent = kernel.spawn({ path: 'parent', run: forever });
    const prof = kernel.startProfile({ pids: [parent.pid] });
    const child = kernel.spawn({ path: 'child', parent, run: forever });
    const stranger = kernel.spawn({ path: 'stranger', run: forever });
    const data = new Uint8Array(64);
    for (const p of [parent, child, stranger]) kernel.syscallSync(p, A.SYS_getppid, [0, 0, 0, 0, 0, 0], data);
    let rep = kernel.stopProfile(prof)!;
    expect(rep.procs.map((x) => x.pid).sort()).toEqual([parent.pid, child.pid].sort());
    expect(rep.procs.find((x) => x.pid === child.pid)!.comm).toBe('child');

    kernel.startProfile({ filter: (p) => p.pid === stranger.pid, follow: false });
    for (const p of [parent, child, stranger]) kernel.syscallSync(p, A.SYS_getppid, [0, 0, 0, 0, 0, 0], data);
    rep = kernel.stopProfile()!;
    expect(rep.procs.map((x) => x.pid)).toEqual([stranger.pid]);
  });

  it('times keystrokes through a pty: input → read → the writes back, with the calls in between', async () => {
    const kernel = new Kernel({ shell });
    const { pty, slave } = openpty();
    pty.setTermios(makeRaw(pty.termios));
    const out: string[] = [];
    pty.onOutput((b) => out.push(new TextDecoder().decode(b)));
    const p = kernel.spawn({ path: 'tui', fds: { 0: slave, 1: slave }, run: forever });
    const prof = kernel.startProfile();
    const data = new Uint8Array(64);
    for (const key of ['a', 'b']) {
      const reading = kernel.syscall(p, A.SYS_read, [0, 64, 0, 0, 0, 0], data);
      await tick(5);
      pty.input(key);
      expect(await reading).toBe(1);
      await tick(10);
      for (const s of [`[${key}]`, '\r\n']) {
        data.set(enc.encode(s));
        expect(await kernel.syscall(p, A.SYS_write, [1, s.length, 0, 0, 0, 0], data)).toBe(s.length);
      }
      kernel.syscallSync(p, A.SYS_getpid, [0, 0, 0, 0, 0, 0], data);
    }
    const rep = kernel.stopProfile()!;
    expect(out.join('')).toBe('[a]\r\n[b]\r\n');
    expect(rep.keys).toHaveLength(2);
    for (const k of rep.keys) {
      expect(k).toMatchObject({ bytes: 1, writes: 2, writeBytes: 5 });
      expect(k.readMs).toBeGreaterThanOrEqual(0);
      expect(k.firstWriteMs).toBeGreaterThanOrEqual(5);
      expect(k.lastWriteMs).toBeGreaterThanOrEqual(k.firstWriteMs);
      expect(k.byName.write).toBe(2);
      expect(k.byName.getpid).toBe(1);
    }
    expect(rep.byKind['read:pty']).toMatchObject({ calls: 2, bytes: 2 });
    expect(formatReport(rep)).toMatch(/keystrokes: 2 \(2 read\); median ms: input→read [\d.]+, read→first write [\d.]+/);
    // the pty trace is off once the profile stops
    pty.input('c');
    expect(prof.report().keys).toHaveLength(2);
  });

  it('pread64/pwrite64 of a regular file take the sync path (native Claude Code reads its 250 MB binary with pread64)', async () => {
    const kernel = new Kernel({ shell });
    await shell.fs.writeFile('/tmp/pread.bin', 'hello, pread world');
    const p = kernel.spawn({ path: 'prog', run: forever });
    const data = new Uint8Array(256);
    const path = enc.encode('/tmp/pread.bin');
    data.set(path);
    const fd = await kernel.syscall(p, A.SYS_openat, [A.AT_FDCWD, path.length, A.O_RDWR, 0, 0, 0], data);
    expect(fd).toBeGreaterThanOrEqual(0);
    const prof = kernel.startProfile({ pids: [p.pid] });
    expect(kernel.syscallSync(p, A.SYS_pread64, [fd, 5, 7, 0, 0, 0], data)).toBe(5);
    expect(new TextDecoder().decode(data.subarray(0, 5))).toBe('pread');
    expect(kernel.syscallSync(p, A.SYS_pread64, [fd, 5, -1, -1, 0, 0], data)).toBe(-A.EINVAL);
    data.set(enc.encode('PREAD'));
    expect(kernel.syscallSync(p, A.SYS_pwrite64, [fd, 5, 7, 0, 0, 0], data)).toBe(5);
    // past the end: 0 bytes
    expect(kernel.syscallSync(p, A.SYS_pread64, [fd, 5, 100, 0, 0, 0], data)).toBe(0);
    // the offset isn't moved: read gets the start
    expect(kernel.syscallSync(p, A.SYS_read, [fd, 64, 0, 0, 0, 0], data)).toBe(18);
    expect(new TextDecoder().decode(data.subarray(0, 18))).toBe('hello, PREAD world');
    const rep = kernel.stopProfile(prof)!;
    expect(rep.syscalls.find((s) => s.name === 'pread64')).toMatchObject({ calls: 3, sync: 3, errors: 1 });
    expect(rep.byKind['pread64:file']).toMatchObject({ calls: 3, bytes: 5 });
    // a descriptor without the fast path (a pipe) falls through to the async path's ESPIPE
    const [r] = createPipe();
    const pfd = p.fds.alloc(r);
    expect(kernel.syscallSync(p, A.SYS_pread64, [pfd, 4, 0, 0, 0, 0], data)).toBeUndefined();
    expect(await kernel.syscall(p, A.SYS_pread64, [pfd, 4, 0, 0, 0, 0], data)).toBe(-A.ESPIPE);
  });

  it('names syscalls as strace does', () => {
    expect(syscallName(A.SYS_openat)).toBe('openat');
    expect(syscallName(99999)).toBe('syscall_99999');
  });
});
