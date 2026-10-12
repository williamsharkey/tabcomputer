/**
 * Snapshots of started GUI apps (src/gui/snapshot.ts, docs/research/GUI_SNAPSHOTS.md):
 * what a snapshot is good for (its key, the files its processes opened), and
 * the kernel's part (a restored process gets the pid it had). The engine's
 * image is in x86-engine.test.ts, the X client's replay in x11.test.ts, and
 * the whole path with real apps in tests/browser/gui-snapshot.mjs.
 */
import { describe, it, expect } from 'vitest';
import { createTestShell } from './helpers';

describe('GUI snapshots: validity', () => {
  it('the key changes with the app, its arguments, environment, packages and screen', async () => {
    const { snapshotKey } = await import('@shiro/gui/snapshot');
    const base = { app: 'geany', argv: ['geany'], env: { B: '2', A: '1' }, packages: ['geany=1.38-1'], screen: [1440, 870, 96] as [number, number, number], textMode: 'false/false' };
    const key = snapshotKey(base);
    expect(snapshotKey({ ...base, env: { A: '1', B: '2' } })).toBe(key);   // the order of variables doesn't matter
    for (const other of [
      { ...base, app: 'gimp' }, { ...base, argv: ['geany', 'file.c'] }, { ...base, env: { A: '1', B: '3' } },
      { ...base, packages: ['geany=1.38-2'] }, { ...base, screen: [1280, 870, 96] as [number, number, number] }, { ...base, textMode: 'true/false' },
    ]) expect(snapshotKey(other)).not.toBe(key);
  });

  it('is good while every file its processes opened is what it was: system files by size and time, home files by content', async () => {
    const { fs } = await createTestShell();
    const { signaturesOf, snapshotProblem } = await import('@shiro/gui/snapshot');
    await fs.mkdir('/usr/lib/snapdemo', { recursive: true });
    await fs.mkdir('/home/user/.config/snapdemo', { recursive: true });
    await fs.mkdir('/home/user/.cache/snapdemo', { recursive: true });
    await fs.writeFile('/usr/lib/snapdemo/lib.so', 'library', { times: { mtime: 1_700_000_000_000 } });
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'theme=light\n');
    await fs.writeFile('/home/user/.cache/snapdemo/cache', 'one');
    await fs.rm('/home/user/.config/snapdemo/absent').catch(() => {});
    const paths = ['/usr/lib/snapdemo/lib.so', '/home/user/.config/snapdemo/rc', '/home/user/.config/snapdemo/absent', '/home/user/.cache/snapdemo/cache', '/tmp/x', '/dev/null', '/usr/lib/snapdemo'];
    const opened = await signaturesOf(fs, paths);
    // caches, /tmp and devices don't count
    expect(opened.map(([p]) => p)).toEqual(['/usr/lib/snapdemo/lib.so', '/home/user/.config/snapdemo/rc', '/home/user/.config/snapdemo/absent', '/usr/lib/snapdemo']);
    const snap = { meta: { v: 2, key: 'k', opened } } as never;
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    expect(await snapshotProblem(fs, snap, 'another key')).toMatch(/changed/);
    // the app rewrote its settings with the same content (as it quit): still good
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'theme=light\n');
    await fs.writeFile('/home/user/.cache/snapdemo/cache', 'two, and longer');
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    // the user changed a setting
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'theme=dark\n');
    expect(await snapshotProblem(fs, snap, 'k')).toBe('/home/user/.config/snapdemo/rc changed');
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'theme=light\n');
    // a file it looked for and didn't find is there now
    await fs.writeFile('/home/user/.config/snapdemo/absent', 'now here');
    expect(await snapshotProblem(fs, snap, 'k')).toBe('/home/user/.config/snapdemo/absent changed');
    await fs.rm('/home/user/.config/snapdemo/absent');
    // a library was replaced (another time, the same size)
    await fs.writeFile('/usr/lib/snapdemo/lib.so', 'librarY', { times: { mtime: 1_700_000_100_000 } });
    expect(await snapshotProblem(fs, snap, 'k')).toBe('/usr/lib/snapdemo/lib.so changed');
    // made by another version of this code
    expect(await snapshotProblem(fs, { meta: { v: 1, key: 'k', opened: [] } } as never, 'k')).toMatch(/version/);
  });

  it('gives an app the same X client number every time, each app its own', async () => {
    const { clientNumberFor } = await import('@shiro/gui/snapshot');
    const store = new Map<string, string>();
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } });
    try {
      const a = clientNumberFor('geany', 200, 202), b = clientNumberFor('gimp', 200, 202);
      expect([a, b]).toEqual([200, 201]);
      expect(clientNumberFor('geany', 200, 202)).toBe(200);
      expect(clientNumberFor('xeyes', 200, 202)).toBe(202);
      expect(clientNumberFor('dillo', 200, 202)).toBeNull();   // none left
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real); else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});

describe('GUI snapshots: the kernel side', () => {
  it('a process is given the pid it asks for when no process has it, and the counter steps over it', async () => {
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const { processTable } = await import('@shiro/process-table');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    const forever = () => { let end!: () => void; const p = new Promise<number>((r) => { end = () => r(0); }); return { run: async () => p, end }; };
    const next = processTable.allocatePid();
    const want = next + 3;
    const a = forever();
    const first = kernel.spawn({ path: 'demo', run: a.run, pid: want });
    expect(first.pid).toBe(want);
    // taken: another process asking for it gets the next one, and the counter never hands it out
    const b = forever();
    const second = kernel.spawn({ path: 'demo', run: b.run, pid: want });
    expect(second.pid).not.toBe(want);
    const handed = [second.pid];
    for (let i = 0; i < 6; i++) handed.push(processTable.allocatePid());
    expect(handed).not.toContain(want);
    expect(Math.max(...handed)).toBeGreaterThan(want);
    a.end(); b.end();
    await first.wait(); await second.wait();
    await kernel.waitpid(first.pid, 1).catch(() => undefined);
    // free again once its process is gone and reaped
    const c = forever();
    const third = kernel.spawn({ path: 'demo', run: c.run, pid: want });
    expect(third.pid).toBe(want);
    c.end();
    await third.wait();
  });

  it('logs the paths a process opens or looks for when asked, its children\'s too', async () => {
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    await fs.writeFile('/tmp/snap-open-there', 'x');
    let done!: () => void;
    const parent = kernel.spawn({ path: 'demo', run: () => new Promise<number>((r) => { done = () => r(0); }) });
    parent.data.openLog = new Set<string>();
    const there = await kernel.open(parent, '/tmp/snap-open-there', 0);
    expect(typeof there).not.toBe('number');
    expect(await kernel.open(parent, '/tmp/snap-open-missing', 0)).toBeLessThan(0);
    const child = kernel.spawn({ path: 'demo', parent, run: async () => 0 });
    expect(child.data.openLog).toBe(parent.data.openLog);
    expect([...(parent.data.openLog as Set<string>)]).toEqual(['/tmp/snap-open-there', '/tmp/snap-open-missing']);
    if (typeof there !== 'number') await there.close();
    done();
    await parent.wait();
  });
});
