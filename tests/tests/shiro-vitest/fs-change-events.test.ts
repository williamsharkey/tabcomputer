import { describe, it, expect } from 'vitest';
import { FileSystem, type FSChangeEvent, type FSChangeDetail } from '@shiro/filesystem';
import { Kernel } from '@shiro/kernel/kernel';
import * as A from '@shiro/kernel/abi';
import { createTestShell, run } from './helpers';

// FileSystem.onChange, the one event source of fs.watch and inotify: 'attrib'
// for chmod and utimes, `created` on a write that made the path, `dir` on a
// directory's delete or rename, and notify() for writers outside it.
describe('FileSystem change events', { timeout: 60_000 }, () => {
  type Ev = [FSChangeEvent, string, string | undefined, FSChangeDetail | undefined];
  async function watched(): Promise<{ fs: FileSystem; ev: Ev[]; take: () => Ev[] }> {
    const fs = new FileSystem();
    await fs.init();
    const ev: Ev[] = [];
    fs.onChange((e, p, n, d) => { ev.push([e, p, n, d]); });
    return { fs, ev, take: () => ev.splice(0) };
  }

  it('writes say whether they made the path; chmod and utimes are attrib', async () => {
    const { fs, take } = await watched();
    await fs.mkdir('/tmp/ce1', { recursive: true });
    take();
    await fs.writeFile('/tmp/ce1/a', 'one');
    await fs.writeFile('/tmp/ce1/a', 'two');
    expect(take()).toEqual([['write', '/tmp/ce1/a', undefined, { created: true }], ['write', '/tmp/ce1/a', undefined, undefined]]);
    await fs.writeNow('/tmp/ce1/b', new Uint8Array([1]));
    await fs.writeNow('/tmp/ce1/b', new Uint8Array([2]));
    expect(take()).toEqual([['write', '/tmp/ce1/b', undefined, { created: true }], ['write', '/tmp/ce1/b', undefined, undefined]]);
    await fs.appendFile('/tmp/ce1/c', 'x');
    await fs.appendFile('/tmp/ce1/c', 'y');
    expect(take().map((e) => e[3])).toEqual([{ created: true }, undefined]);
    await fs.chmod('/tmp/ce1/a', 0o600);
    await fs.utimes('/tmp/ce1/a', 1000, 2000);
    expect(take()).toEqual([['attrib', '/tmp/ce1/a', undefined, undefined], ['attrib', '/tmp/ce1/a', undefined, undefined]]);
    await fs.symlink('a', '/tmp/ce1/ln');
    await fs.link('/tmp/ce1/a', '/tmp/ce1/hard');
    await fs.mkfifo('/tmp/ce1/fifo');
    expect(take()).toEqual([
      ['write', '/tmp/ce1/ln', undefined, { created: true }],
      ['write', '/tmp/ce1/hard', undefined, { created: true }],
      ['write', '/tmp/ce1/fifo', undefined, { created: true }],
    ]);
    const w = await fs.createWriter('/tmp/ce1/streamed');
    await w.write(new Uint8Array(10));
    await w.close();
    expect(take()).toEqual([['write', '/tmp/ce1/streamed', undefined, { created: true }]]);
  });

  it('a directory\'s delete and rename say dir; a file\'s don\'t', async () => {
    const { fs, take } = await watched();
    await fs.mkdir('/tmp/ce2/d/e', { recursive: true });
    await fs.mkdir('/tmp/ce2/x');
    await fs.writeFile('/tmp/ce2/d/f', 'f');
    await fs.writeFile('/tmp/ce2/g', 'g');
    take();
    await fs.rename('/tmp/ce2/d', '/tmp/ce2/d2');
    await fs.rename('/tmp/ce2/g', '/tmp/ce2/g2');
    await fs.exchange('/tmp/ce2/d2', '/tmp/ce2/g2');
    expect(take()).toEqual([
      ['rename', '/tmp/ce2/d', '/tmp/ce2/d2', { dir: true }],
      ['rename', '/tmp/ce2/g', '/tmp/ce2/g2', undefined],
      ['rename', '/tmp/ce2/d2', '/tmp/ce2/g2', { dir: true }],
      ['rename', '/tmp/ce2/g2', '/tmp/ce2/d2', undefined],
    ]);
    await fs.rmdir('/tmp/ce2/x');
    await fs.unlink('/tmp/ce2/d2');
    await fs.rm('/tmp/ce2/g2', { recursive: true });
    expect(take()).toEqual([
      ['delete', '/tmp/ce2/x', undefined, { dir: true }],
      ['delete', '/tmp/ce2/d2', undefined, undefined],
      ['delete', '/tmp/ce2/g2', undefined, { dir: true }],
    ]);
  });

  it('notify() reaches the listeners as given', async () => {
    const { fs, take } = await watched();
    fs.notify('write', '/tmp/k', undefined, { created: true });
    fs.notify('attrib', '/tmp/k');
    expect(take()).toEqual([['write', '/tmp/k', undefined, { created: true }], ['attrib', '/tmp/k', undefined, undefined]]);
  });

  it('the kernel\'s sync O_CREAT open says created', async () => {
    const { fs, shell } = await createTestShell();
    const kernel = new Kernel({ shell });
    try {
      const proc = kernel.spawn({ path: 'p', cwd: '/tmp', fds: {}, run: () => new Promise<number>(() => {}) });
      await fs.mkdir('/tmp/ce3', { recursive: true });
      await fs.readdir('/tmp/ce3');
      const ev: Ev[] = [];
      fs.onChange((e, p, n, d) => { ev.push([e, p, n, d]); });
      const p = new TextEncoder().encode('/tmp/ce3/new');
      const d = new Uint8Array(256); d.set(p);
      const fd = await kernel.syscall(proc, A.SYS_openat, [A.AT_FDCWD, p.length, A.O_WRONLY | A.O_CREAT, 0o644], d);
      expect(fd).toBeGreaterThanOrEqual(0);
      expect(ev[0]).toEqual(['write', '/tmp/ce3/new', undefined, { created: true }]);
      kernel.kill(proc.pid, A.SIGKILL);
    } finally { kernel.dispose(); }
  });

  it('node\'s fs.watch reports a chmod as change', async () => {
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/tmp/ce4', { recursive: true });
    await fs.writeFile('/tmp/ce4/f', 'x');
    await fs.writeFile('/tmp/ce4/w.js', `const fs = require('fs'); const ev = [];
const w = fs.watch('/tmp/ce4/f', (type) => ev.push(type));
fs.chmodSync('/tmp/ce4/f', 0o600);
setTimeout(() => { w.close(); console.log('events:' + ev.join(',')); process.exit(0); }, 200);`);
    const r = await run(shell, 'node /tmp/ce4/w.js');
    expect(r.output).toContain('events:change');
  });
});
