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

  it('the key holds the engine\'s version and the build: a snapshot is never restored across a rebuilt engine, and says which changed', async () => {
    const { snapshotKey, keyChange, snapshotProblem, buildIds, VERSION } = await import('@shiro/gui/snapshot');
    const { fs } = await createTestShell();
    const base = { app: 'geany', argv: ['geany'], env: {}, packages: ['geany=1.38-1'], screen: [1440, 870, 96] as [number, number, number], textMode: 'false/false' };
    const was = snapshotKey(base, { build: 'abc', engine: 'engines/blink/v-1111/' });
    const rebuilt = snapshotKey(base, { build: 'abc', engine: 'engines/blink/v-2222/' });
    expect(rebuilt).not.toBe(was);
    expect(keyChange(was, rebuilt)).toBe('the engine');
    expect(keyChange(was, snapshotKey(base, { build: 'def', engine: 'engines/blink/v-2222/' }))).toBe('the build and the engine');
    expect(keyChange(was, snapshotKey({ ...base, screen: [1280, 700, 96] }, { build: 'abc', engine: 'engines/blink/v-1111/' }))).toBe('the screen');
    expect(keyChange(was, snapshotKey({ ...base, packages: ['geany=1.38-2'] }, { build: 'abc', engine: 'engines/blink/v-1111/' }))).toBe('its packages');
    const snap = { meta: { v: VERSION, key: was, taken: Date.now(), opened: [] } } as never;
    expect(await snapshotProblem(fs, snap, was)).toBeNull();
    expect(await snapshotProblem(fs, snap, rebuilt)).toBe('the engine changed');
    // the page's own ids: what the build compiled in, which a test can stand in for
    const g = globalThis as { __guiSnapshotEngine?: string };
    const before = snapshotKey(base);
    g.__guiSnapshotEngine = 'engines/blink/v-other/';
    try {
      expect(buildIds().engine).toBe('engines/blink/v-other/');
      expect(keyChange(before, snapshotKey(base))).toBe('the engine');
    } finally { delete g.__guiSnapshotEngine; }
  });

  it('is good for two weeks at most', async () => {
    const { snapshotProblem, MAX_AGE_MS, VERSION } = await import('@shiro/gui/snapshot');
    const { fs } = await createTestShell();
    const now = Date.now();
    const snap = (taken: number) => ({ meta: { v: VERSION, key: 'k', taken, opened: [] } }) as never;
    expect(await snapshotProblem(fs, snap(now - MAX_AGE_MS + 60_000), 'k', now)).toBeNull();
    expect(await snapshotProblem(fs, snap(now - MAX_AGE_MS - 60_000), 'k', now)).toMatch(/two weeks/);
  });

  it('a document is its bytes, wherever it is: one that was open and has changed since outdates the snapshot', async () => {
    const { fs } = await createTestShell();
    const { signaturesOf, snapshotProblem, VERSION } = await import('@shiro/gui/snapshot');
    await fs.mkdir('/home/user/project', { recursive: true });
    await fs.mkdir('/tmp/snapdoc', { recursive: true });
    await fs.writeFile('/home/user/project/notes.txt', 'one\ntwo\n');
    await fs.writeFile('/tmp/snapdoc/draft.txt', 'draft');
    await fs.writeFile('/tmp/snapdoc/app.lock', 'pid 7');
    const paths = ['/home/user/project/notes.txt', '/tmp/snapdoc/draft.txt', '/tmp/snapdoc/app.lock', '/tmp/snapdoc/gone', '/tmp/snapdoc', '/tmp/snapdoc/'];
    // (the app wrote its own lock file: that one doesn't count; nor does what isn't there under /tmp, a directory there, or its listing)
    const opened = await signaturesOf(fs, paths, new Set(['/tmp/snapdoc/app.lock']));
    expect(opened.map(([p]) => p)).toEqual(['/home/user/project/notes.txt', '/tmp/snapdoc/draft.txt']);
    const snap = { meta: { v: VERSION, key: 'k', taken: Date.now(), opened } } as never;
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    await fs.writeFile('/tmp/snapdoc/app.lock', 'pid 9');
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    // the same lines in another order are another document (only settings are compared by their lines)
    await fs.writeFile('/home/user/project/notes.txt', 'two\none\n');
    expect(await snapshotProblem(fs, snap, 'k')).toBe('/home/user/project/notes.txt changed');
    await fs.writeFile('/home/user/project/notes.txt', 'one\ntwo\n');
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    await fs.writeFile('/tmp/snapdoc/draft.txt', 'draft, edited in the terminal');
    expect(await snapshotProblem(fs, snap, 'k')).toBe('/tmp/snapdoc/draft.txt changed');
  });

  it('a path the app\'s own socket is bound to never counts: it is there while the app runs and gone once it quit', async () => {
    const { fs } = await createTestShell();
    const { signaturesOf, snapshotProblem, VERSION } = await import('@shiro/gui/snapshot');
    await fs.mkdir('/home/user/.config/snapsock', { recursive: true });
    await fs.writeFile('/home/user/.config/snapsock/app.conf', 'a=1\n');
    await fs.writeFile('/home/user/.config/snapsock/socket_host_0', '');
    const paths = ['/home/user/.config/snapsock/app.conf', '/home/user/.config/snapsock/socket_host_0'];
    const opened = await signaturesOf(fs, paths, new Set(), new Set(['/home/user/.config/snapsock/socket_host_0']));
    expect(opened.map(([p]) => p)).toEqual(['/home/user/.config/snapsock/app.conf']);
    const snap = { meta: { v: VERSION, key: 'k', taken: Date.now(), opened } } as never;
    await fs.rm('/home/user/.config/snapsock/socket_host_0');   // the app quit and removed it
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    // Geany's way: the socket is in /tmp, and the settings directory has a link to it
    await fs.mkdir('/tmp/snapsock', { recursive: true });
    await fs.writeFile('/tmp/snapsock/geany_socket.abc123', '');
    await fs.symlink('/tmp/snapsock/geany_socket.abc123', '/home/user/.config/snapsock/geany_socket_host__0');
    const linked = await signaturesOf(fs, [...paths, '/home/user/.config/snapsock/geany_socket_host__0', '/tmp/snapsock/geany_socket.abc123'], new Set(), new Set(['/tmp/snapsock/geany_socket.abc123']));
    expect(linked.map(([p]) => p)).toEqual(['/home/user/.config/snapsock/app.conf', '/home/user/.config/snapsock/socket_host_0']);
  });

  it('a directory the app listed is the names in it; one it only looked at is just there', async () => {
    const { fs } = await createTestShell();
    const { signaturesOf, snapshotProblem, VERSION } = await import('@shiro/gui/snapshot');
    await fs.mkdir('/home/user/.config/snapdemo2/brushes', { recursive: true });
    await fs.mkdir('/home/user/.config/snapdemo2/looked', { recursive: true });
    await fs.writeFile('/home/user/.config/snapdemo2/brushes/round.gbr', 'x');
    const opened = await signaturesOf(fs, ['/home/user/.config/snapdemo2/brushes/', '/home/user/.config/snapdemo2/brushes', '/home/user/.config/snapdemo2/looked']);
    const snap = { meta: { v: VERSION, key: 'k', taken: Date.now(), opened } } as never;
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    await fs.writeFile('/home/user/.config/snapdemo2/looked/new', 'x');
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    await fs.writeFile('/home/user/.config/snapdemo2/brushes/square.gbr', 'x');
    expect(await snapshotProblem(fs, snap, 'k')).toBe('/home/user/.config/snapdemo2/brushes/ changed');
    await fs.rm('/home/user/.config/snapdemo2/brushes/square.gbr');
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    await fs.rm('/home/user/.config/snapdemo2/brushes', { recursive: true });
    expect(await snapshotProblem(fs, snap, 'k')).toMatch(/brushes\/? changed/);
  });

  it('no snapshot of an app that read a sign-in: a credential file, or text with a token in it', async () => {
    const { fs } = await createTestShell();
    const { signInAmong } = await import('@shiro/gui/snapshot');
    await fs.mkdir('/home/user/.config/gh', { recursive: true });
    await fs.mkdir('/home/user/work', { recursive: true });
    await fs.writeFile('/home/user/.config/snapdemo-plain.conf', 'theme=light\n');
    await fs.writeFile('/home/user/work/readme.txt', 'nothing secret\n');
    const plain = ['/home/user/.config/snapdemo-plain.conf', '/home/user/work/readme.txt', '/home/user/work', '/home/user/work/', '/usr/bin/geany', '/home/user/.netrc'];
    expect(await signInAmong(fs, plain)).toBeNull();   // (a .netrc that isn't there was only looked for)
    await fs.writeFile('/home/user/.netrc', 'machine example.com login me password hunter2\n');
    expect(await signInAmong(fs, plain)).toBe('/home/user/.netrc');
    await fs.rm('/home/user/.netrc');
    await fs.writeFile('/home/user/.config/gh/hosts.yml', 'github.com:\n  oauth_token: x\n');
    expect(await signInAmong(fs, ['/home/user/.config/gh/hosts.yml'])).toBe('/home/user/.config/gh/hosts.yml');
    // a document that happens to hold a token
    await fs.writeFile('/home/user/work/deploy.sh', 'export GITHUB_TOKEN=ghp_' + 'a'.repeat(36) + '\n');
    expect(await signInAmong(fs, [...plain, '/home/user/work/deploy.sh'])).toBe('/home/user/work/deploy.sh');
  });

  it('is good while every file its processes opened is what it was: system files by size and time, home files by content', async () => {
    const { fs } = await createTestShell();
    const { signaturesOf, snapshotProblem, VERSION } = await import('@shiro/gui/snapshot');
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
    const snap = { meta: { v: VERSION, key: 'k', taken: Date.now(), opened } } as never;
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    expect(await snapshotProblem(fs, snap, 'another key')).toMatch(/changed/);
    // the app rewrote its settings with the same content (as it quit): still good
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'theme=light\n');
    await fs.writeFile('/home/user/.cache/snapdemo/cache', 'two, and longer');
    expect(await snapshotProblem(fs, snap, 'k')).toBeNull();
    // ... or with the same lines in another order (a table written out as it happens to iterate)
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'b=2\na=1\n');
    const reordered = { meta: { v: VERSION, key: 'k', taken: Date.now(), opened: await signaturesOf(fs, ['/home/user/.config/snapdemo/rc']) } } as never;
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'a=1\nb=2\n');
    expect(await snapshotProblem(fs, reordered, 'k')).toBeNull();
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'a=1\nb=3\n');
    expect(await snapshotProblem(fs, reordered, 'k')).toBe('/home/user/.config/snapdemo/rc changed');
    await fs.writeFile('/home/user/.config/snapdemo/rc', 'theme=light\n');
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

  it('logs what a process only looks at (stat, access) and lists, and which files it wrote', async () => {
    const { fs } = await createTestShell();
    const { Kernel } = await import('@shiro/kernel/kernel');
    const A = await import('@shiro/kernel/abi');
    const kernel = new Kernel({ fs, registerWithProcessTable: false });
    await fs.mkdir('/tmp/snap-look/dir', { recursive: true });
    await fs.writeFile('/tmp/snap-look/there', 'x');
    await fs.writeFile('/tmp/snap-look/dir/a', 'x');
    let done!: () => void;
    const proc = kernel.spawn({ path: 'demo', run: () => new Promise<number>((r) => { done = () => r(0); }) });
    proc.data.openLog = new Set<string>();
    proc.data.openWritten = new Set<string>();
    // a setting that is looked for with stat and never opened (GTK's gtk.css): there or not, it is logged
    expect(typeof await kernel.statPath(proc, '/tmp/snap-look/there')).toBe('object');
    expect(await kernel.statPath(proc, '/tmp/snap-look/absent.css')).toBe(-A.ENOENT);
    const log = proc.data.openLog as Set<string>;
    expect([...log]).toEqual(['/tmp/snap-look/there', '/tmp/snap-look/absent.css']);
    // a directory that is listed is logged with a trailing slash
    const dir = await kernel.open(proc, '/tmp/snap-look/dir', A.O_RDONLY | A.O_DIRECTORY);
    expect(typeof dir).not.toBe('number');
    const fd = proc.fds.alloc(dir as never);
    const buf = new Uint8Array(4096);
    expect(await kernel.syscall(proc, A.SYS_getdents64, [fd, buf.length], buf)).toBeGreaterThan(0);
    expect(log.has('/tmp/snap-look/dir')).toBe(true);
    expect(log.has('/tmp/snap-look/dir/')).toBe(true);
    // a file it writes
    const w = await kernel.open(proc, '/tmp/snap-look/made', A.O_WRONLY | A.O_CREAT, 0o644);
    expect(typeof w).not.toBe('number');
    expect([...(proc.data.openWritten as Set<string>)]).toEqual(['/tmp/snap-look/made']);
    if (typeof w !== 'number') await w.close();
    done();
    await proc.wait();
  });
});

describe('GUI snapshots: the setting', () => {
  const chromium = { userAgentData: { brands: [{ brand: 'Chromium' }, { brand: 'Google Chrome' }], mobile: false }, deviceMemory: 8 };
  it('is off unless asked for: one restored process in about a hundred ended at once, and the cause is not known', async () => {
    const { snapshotMode, SNAPSHOT_DEFAULT_ON } = await import('@shiro/gui/snapshot-setting');
    expect(SNAPSHOT_DEFAULT_ON).toBe(false);
    expect(snapshotMode({ stored: null, env: {}, safe: false, nav: chromium })).toBe('off');
    expect(snapshotMode({ stored: '1', env: {}, safe: false, nav: chromium })).toBe('tested');
    expect(snapshotMode({ stored: null, env: { TABCOMPUTER_GUI_SNAPSHOTS: '1' }, safe: false, nav: {} })).toBe('tested');
  });

  it('where it is the default: on for the tested apps in a desktop Chromium with 4 GB or more, and off elsewhere', async () => {
    const { snapshotMode, snapshotsFor, snapshotDefaultOn, SNAPSHOT_TESTED } = await import('@shiro/gui/snapshot-setting');
    const mode = (o: object) => snapshotMode({ stored: null, env: {}, safe: false, nav: chromium, defaultOn: true, ...o });
    expect(mode({})).toBe('tested');
    expect(snapshotsFor('geany', 'tested')).toBe(true);
    expect(snapshotsFor('gimp', 'tested')).toBe(true);
    expect(snapshotsFor('firefox-esr', 'tested')).toBe(false);
    expect(snapshotsFor('firefox-esr', 'all')).toBe(true);
    expect(snapshotsFor('geany', 'off')).toBe(false);
    expect(SNAPSHOT_TESTED.has('xterm')).toBe(false);   // a shell on a pty: no snapshot
    // a phone, a small machine, another engine: the usual start
    expect(snapshotDefaultOn({ ...chromium, userAgentData: { ...chromium.userAgentData, mobile: true } })).toBe(false);
    expect(snapshotDefaultOn({ ...chromium, deviceMemory: 2 })).toBe(false);
    expect(snapshotDefaultOn({})).toBe(false);
    expect(snapshotDefaultOn(undefined)).toBe(false);
    expect(mode({ nav: {} })).toBe('off');
  });

  it('the off switch: Settings (localStorage 0), TABCOMPUTER_GUI_SNAPSHOTS=0, safe mode; `all` turns it on for every app', async () => {
    const { snapshotMode } = await import('@shiro/gui/snapshot-setting');
    const mode = (o: object) => snapshotMode({ stored: null, env: {}, safe: false, nav: chromium, defaultOn: true, ...o });
    expect(mode({ stored: '0' })).toBe('off');
    expect(mode({ env: { TABCOMPUTER_GUI_SNAPSHOTS: '0' } })).toBe('off');
    expect(mode({ stored: '1', env: { TABCOMPUTER_GUI_SNAPSHOTS: '0' } })).toBe('off');
    expect(mode({ safe: true })).toBe('off');
    expect(mode({ stored: '1', safe: true })).toBe('off');
    expect(mode({ stored: 'all', safe: true })).toBe('off');
    expect(mode({ stored: '1' })).toBe('tested');
    expect(mode({ stored: 'all' })).toBe('all');
    expect(mode({ stored: 'all', nav: {} })).toBe('all');
    expect(mode({ env: { TABCOMPUTER_GUI_SNAPSHOTS: 'all' }, nav: {} })).toBe('all');
  });
});

describe('GUI snapshots: storage', () => {
  const entry = (app: string, stored: number, used: number) => ({ meta: { app, sizes: { image: stored * 2, stored, x: 0 }, taken: used }, used }) as never;

  it('drops the least recently used until the rest fit, the one just kept last, and that one when it alone is over', async () => {
    const { evictions } = await import('@shiro/gui/snapshot');
    const all = [entry('gimp', 85, 100), entry('geany', 20, 300), entry('inkscape', 67, 200), entry('xeyes', 3, 50)];
    expect(evictions(all, 256)).toEqual([]);
    expect(evictions(all, 160)).toEqual(['xeyes', 'gimp']);                 // 175 → 172 → 87
    expect(evictions(all, 160, 'xeyes')).toEqual(['gimp']);                 // the new one is spared while others can go
    expect(evictions(all, 30)).toEqual(['xeyes', 'gimp', 'inkscape']);
    // the new one is over the cap alone: it goes, and the others are not dropped for it
    expect(evictions(all, 84, 'gimp')).toEqual(['xeyes', 'inkscape', 'gimp']);      // (the rest still has to fit: 90 → 87 → 20)
    expect(evictions([entry('gimp', 85, 100), entry('geany', 20, 300)], 50, 'gimp')).toEqual(['gimp']);
    expect(evictions([], 10)).toEqual([]);
  });

  it('the cap is 256 MB, or a tenth of what the site may still use when that is less', async () => {
    const { snapshotCap, SNAPSHOT_CAP } = await import('@shiro/gui/snapshot');
    expect(SNAPSHOT_CAP).toBe(256_000_000);
    expect(await snapshotCap(null, 0)).toBe(SNAPSHOT_CAP);
    expect(await snapshotCap({ quota: 100e9, usage: 2e9 }, 0)).toBe(SNAPSHOT_CAP);
    // 1 GB free: 100 MB. What the snapshots take already counts as free for them
    expect(await snapshotCap({ quota: 3e9, usage: 2e9 }, 0)).toBe(100_000_000);
    expect(await snapshotCap({ quota: 3e9, usage: 2e9 }, 50e6)).toBe(105_000_000);
    expect(await snapshotCap({ quota: 2e9, usage: 2.5e9 }, 0)).toBe(0);
  });

  it('keeps snapshots in IndexedDB with an index that is read without the images; a save over the cap drops the oldest', async () => {
    await createTestShell();   // (fake-indexeddb)
    const S = await import('@shiro/gui/snapshot');
    await S.dropAllSnapshots();
    const snap = (app: string, bytes: number) => ({ meta: { v: S.VERSION, app, key: 'k', taken: Date.now(), procs: [], files: [], x: { index: 200, atoms: [], bytes: 0, time: 0 }, opened: [], sizes: { image: bytes * 2, stored: bytes, x: 0 } }, images: [new ArrayBuffer(bytes)], x: new ArrayBuffer(0) }) as never;
    expect(await S.saveSnapshot(snap('one', 400), 1000)).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    expect(await S.saveSnapshot(snap('two', 400), 1000)).toEqual([]);
    await new Promise((r) => setTimeout(r, 5));
    // a restore of the first makes the second the least recently used
    await S.touchSnapshot('one');
    await new Promise((r) => setTimeout(r, 5));
    expect(await S.saveSnapshot(snap('three', 400), 1000)).toEqual(['two']);
    expect((await S.listSnapshots()).map((e) => e.meta.app).sort()).toEqual(['one', 'three']);
    expect(await S.loadSnapshot('two')).toBeNull();
    const one = await S.loadSnapshot('one');
    expect(one?.images[0].byteLength).toBe(400);
    const usage = await S.snapshotUsage();
    expect(usage.total).toBe(800);
    expect(usage.apps.map((a) => a.app).sort()).toEqual(['one', 'three']);
    // one that is over the cap alone is not kept
    expect(await S.saveSnapshot(snap('huge', 5000), 1000)).toContain('huge');
    expect(await S.loadSnapshot('huge')).toBeNull();
    // a use noted for a snapshot that was dropped meanwhile does not bring its entry back
    await S.dropSnapshot('one');
    await Promise.all([S.touchSnapshot('one'), S.touchSnapshot('three')]);
    expect((await S.listSnapshots()).map((e) => e.meta.app)).toEqual(['three']);
    await S.dropAllSnapshots();
    expect(await S.listSnapshots()).toEqual([]);
  });

  it('remembers an app that can take no snapshot until what it was asked with changes', async () => {
    const S = await import('@shiro/gui/snapshot');
    const store = new Map<string, string>();
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); }, removeItem: (k: string) => { store.delete(k); } } });
    try {
      expect(S.skipReason('xterm', 'key 1')).toBeNull();
      S.setSkip('xterm', 'key 1', 'its shell is on a pty');
      expect(S.skipReason('xterm', 'key 1')).toBe('its shell is on a pty');
      expect(S.skippedOnThisBuild('xterm')).toBe(true);
      expect(S.skipReason('xterm', 'key 2')).toBeNull();
      expect(S.skipReason('geany', 'key 1')).toBeNull();
      const g = globalThis as { __guiSnapshotEngine?: string };
      g.__guiSnapshotEngine = 'another engine';
      try { expect(S.skippedOnThisBuild('xterm')).toBe(false); } finally { delete g.__guiSnapshotEngine; }
      S.setSkip('xterm', 'key 1', null);
      expect(S.skipReason('xterm', 'key 1')).toBeNull();
    } finally {
      if (real) Object.defineProperty(globalThis, 'localStorage', real); else delete (globalThis as { localStorage?: unknown }).localStorage;
    }
  });
});
