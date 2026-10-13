/**
 * tabcomputer#71, what was still open after the detection: `doctor` says what
 * storage that is not persisted costs and how to get it (`doctor --persist`),
 * and after the browser deleted the filesystem the next load knows what it
 * had installed (src/install-inventory.ts) and offers it again
 * (src/storage-lost.ts, `doctor`).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { createTestShell } from './helpers';
import { FileSystem } from '@shiro/filesystem';
import { doctorCmd } from '@shiro/commands/doctor';
import {
  collectInventory, savedInventory, lostInventory, missingFrom, reinstallCommands, describeMissing, reinstallOffer, trackInventory, dismissLostInventory,
  INVENTORY_KEY, LOST_KEY, type Inventory,
} from '@shiro/install-inventory';
import { offerReinstall } from '@shiro/storage-lost';

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
  get length() { return store.size; }, key: (i: number) => [...store.keys()][i] ?? null,
};
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });

const deleteDb = () => new Promise<void>((resolve, reject) => {
  const req = indexedDB.deleteDatabase('tabcomputer-fs');
  req.onsuccess = () => resolve();
  req.onerror = () => reject(req.error);
});
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

/** A machine with things installed, as their installers record them */
async function install(fs: FileSystem): Promise<void> {
  await fs.mkdir('/var/lib/pkg', { recursive: true });
  await fs.mkdir('/var/lib/shiro', { recursive: true });
  await fs.mkdir('/var/lib/tabcomputer', { recursive: true });
  await fs.mkdir('/home/user/.claude', { recursive: true });
  await fs.writeFile('/var/lib/pkg/status.json', JSON.stringify({ python3: { name: 'python3' }, vim: { name: 'vim' }, 'ca-certificates': { name: 'ca-certificates' } }));
  await fs.writeFile('/var/lib/shiro/rootfs.json', JSON.stringify({ id: 'trixie', version: '13.1' }));
  await fs.writeFile('/var/lib/shiro/layers.json', JSON.stringify({ c: { id: 'c' }, python: { id: 'python' } }));
  await fs.writeFile('/var/lib/tabcomputer/claude-native.json', JSON.stringify({ '/home/user/.local/bin/claude': { version: '2.1.200', size: 1, mtime: 1 } }));
  await fs.writeFile('/home/user/.claude/.credentials.json', '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-doNotKeepThis"}}');
}

beforeEach(async () => { store.clear(); await deleteDb(); });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('the list of what is installed', () => {
  it('holds names only: packages, Debian, toolchain layers, native Claude, which sign-ins were files', async () => {
    const fs = new FileSystem();
    await fs.init();
    expect(await collectInventory(fs)).toMatchObject({ volume: fs.volumeId, pkg: [], debian: false, toolchains: [], claude: false, signins: [] });
    await install(fs);
    const inv = (await collectInventory(fs))!;
    expect(inv).toMatchObject({ volume: fs.volumeId, pkg: ['ca-certificates', 'python3', 'vim'], debian: true, toolchains: ['c', 'python'], claude: true, signins: ['claude'] });
    expect(JSON.stringify(inv)).not.toContain('sk-ant');
  });

  it('is saved soon after boot and again when an installer writes its state', async () => {
    const fs = new FileSystem();
    await fs.init();
    const stop = trackInventory(fs, { store: storage, firstAfterMs: 1, settleMs: 1 });
    await tick();
    expect(savedInventory(storage)).toMatchObject({ volume: fs.volumeId, pkg: [], debian: false });
    await fs.mkdir('/var/lib/pkg', { recursive: true });
    await fs.writeFile('/var/lib/pkg/status.json', JSON.stringify({ lua: {} }));
    await tick();
    expect(savedInventory(storage)!.pkg).toEqual(['lua']);
    await fs.writeFile('/tmp-unrelated', 'x');
    stop();
    expect(store.has(LOST_KEY)).toBe(false);
  });

  it('a name that could not be a package never reaches a command line', () => {
    store.set(LOST_KEY, JSON.stringify({ volume: 'v', pkg: ['vim', 'x; rm -rf ~', '$(id)', 7, 'a b'], toolchains: ['c', '../x', '`id`'], debian: 'yes', claude: 1, signins: ['claude', '<b>'] }));
    const lost = lostInventory(storage)!;
    expect(lost).toMatchObject({ pkg: ['vim'], toolchains: ['c'], debian: false, claude: false, signins: ['claude'] });
    expect(reinstallCommands(lost)).toEqual(['pkg install vim', 'toolchain install c']);
  });
});

describe('what to install again', () => {
  const lost: Inventory = { volume: 'old', at: 1, pkg: ['ca-certificates', 'python3', 'vim'], debian: true, toolchains: ['c'], claude: true, signins: ['claude'] };
  it('is what the lost disk had and this one lacks, without what boot installs by itself', () => {
    const now: Inventory = { volume: 'new', at: 2, pkg: ['vim'], debian: false, toolchains: [], claude: false, signins: [] };
    const m = missingFrom(lost, now, ['ca-certificates', 'claude-code']);
    expect(m).toMatchObject({ pkg: ['python3'], debian: true, toolchains: ['c'], claude: true, signins: ['claude'] });
    // toolchain install installs Debian first by itself
    expect(reinstallCommands(m)).toEqual(['pkg install python3', 'toolchain install c', 'claude install']);
    expect(describeMissing(m)).toBe('the package python3; Debian; the c toolchain; Claude Code (claude install)');
    expect(reinstallCommands({ ...m, toolchains: [] })).toEqual(['pkg install python3', 'debian install', 'claude install']);
  });
  it('is nothing once everything is back', () => {
    const m = missingFrom(lost, { ...lost, volume: 'new' });
    expect(reinstallCommands(m)).toEqual([]);
    expect(describeMissing(m)).toBe('');
  });
});

describe('after the browser deleted the filesystem', () => {
  /** Install, save the list, lose IndexedDB (localStorage survives), and load again */
  async function lostAndReloaded(): Promise<FileSystem> {
    const before = new FileSystem();
    await before.init();
    await install(before);
    const stop = trackInventory(before, { store: storage, firstAfterMs: 1 });
    await tick();
    stop();
    expect(savedInventory(storage)!.pkg).toEqual(['ca-certificates', 'python3', 'vim']);
    await before.sync();
    await deleteDb();
    await tick(250);   // the page notices (the reopen check)
    const after = new FileSystem();
    await after.init();
    expect(after.previousVolumeLost).toBe(savedInventory(storage)!.volume);
    return after;
  }

  it('a page whose storage is lost under it keeps the last list instead of saving an empty one', async () => {
    const fs = new FileSystem();
    await fs.init();
    await install(fs);
    const stop = trackInventory(fs, { store: storage, firstAfterMs: 1, settleMs: 1 });
    await tick();
    await fs.sync();
    const good = store.get(INVENTORY_KEY);
    await deleteDb();
    await tick(250);
    expect(fs.storageLost).not.toBeNull();
    expect(await collectInventory(fs)).toBeNull();
    await fs.writeFile('/var/lib/pkg/status.json', '{}').catch(() => {});
    await tick();
    stop();
    expect(store.get(INVENTORY_KEY)).toBe(good);
  });

  it('the next load sets the lost list aside and offers what is missing, across reloads, until it is back', async () => {
    const fs = await lostAndReloaded();
    const stop = trackInventory(fs, { store: storage, firstAfterMs: 1, settleMs: 1 });
    expect(lostInventory(storage)).toMatchObject({ pkg: ['ca-certificates', 'python3', 'vim'], debian: true, toolchains: ['c', 'python'], claude: true });
    const offer = (await reinstallOffer(fs, { store: storage, skipPkg: ['ca-certificates'] }))!;
    expect(offer.commands).toEqual(['pkg install python3 vim', 'toolchain install c python', 'claude install']);
    expect(offer.signins).toEqual(['claude']);
    await tick();
    stop();
    // the current list is this (empty) filesystem's now; the offer does not depend on it
    expect(savedInventory(storage)).toMatchObject({ volume: fs.volumeId, pkg: [] });

    // a reload later: no loss this time, the offer still stands
    const again = new FileSystem();
    await again.init();
    expect(again.previousVolumeLost).toBeNull();
    trackInventory(again, { store: storage, firstAfterMs: 1 })();
    expect((await reinstallOffer(again, { store: storage }))!.commands[0]).toBe('pkg install ca-certificates python3 vim');

    // part of it comes back: only the rest is offered; all of it: the offer is withdrawn
    await again.mkdir('/var/lib/pkg', { recursive: true });
    await again.writeFile('/var/lib/pkg/status.json', JSON.stringify({ python3: {}, vim: {}, 'ca-certificates': {} }));
    expect((await reinstallOffer(again, { store: storage }))!.commands).toEqual(['toolchain install c python', 'claude install']);
    await install(again);
    expect(await reinstallOffer(again, { store: storage })).toBeNull();
    expect(store.has(LOST_KEY)).toBe(false);
  });

  it('without the list (localStorage cleared too) there is no offer, and a first boot has none', async () => {
    const first = new FileSystem();
    await first.init();
    trackInventory(first, { store: storage, firstAfterMs: 1 })();
    expect(await reinstallOffer(first, { store: storage })).toBeNull();
    const fs = await lostAndReloaded();
    store.delete(INVENTORY_KEY);
    trackInventory(fs, { store: storage, firstAfterMs: 1 })();
    expect(await reinstallOffer(fs, { store: storage })).toBeNull();
  });

  it('the page shows what it had, and Reinstall types the commands once', async () => {
    const fs = await lostAndReloaded();
    trackInventory(fs, { store: storage, firstAfterMs: 60_000 })();
    const ran: string[][] = [];
    expect(await offerReinstall(fs, { run: (c) => ran.push(c), skipPkg: ['ca-certificates'] })).toBe(true);
    const banner = document.querySelector('.tabcomputer-storage-previous')!;
    expect(banner.textContent).toContain('previous files are gone');
    expect(banner.textContent).toContain('It had installed: the packages python3, vim; Debian; the c, python toolchains; Claude Code (claude install).');
    expect(banner.textContent).toContain('run claude and sign in again');
    expect(banner.textContent).not.toContain('sk-ant');
    const buttons = [...banner.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Reinstall', 'Dismiss']);
    buttons[0].click();
    expect(ran).toEqual([['pkg install python3 vim', 'toolchain install c python', 'claude install']]);
    expect(document.querySelector('.tabcomputer-storage-previous')).toBeNull();
    expect(store.has(LOST_KEY)).toBe(false);   // taken: not offered again
    expect(await offerReinstall(fs, { run: (c) => ran.push(c) })).toBe(false);
  });

  it('Dismiss drops the offer and runs nothing', async () => {
    const fs = await lostAndReloaded();
    trackInventory(fs, { store: storage, firstAfterMs: 60_000 })();
    const ran: string[][] = [];
    await offerReinstall(fs, { run: (c) => ran.push(c) });
    ([...document.querySelectorAll('.tabcomputer-storage-previous button')].find((b) => b.textContent === 'Dismiss') as HTMLButtonElement).click();
    expect(ran).toEqual([]);
    expect(lostInventory(storage)).toBeNull();
    dismissLostInventory(storage);
  });
});

describe('doctor and storage that is not persisted', () => {
  async function doctor(args: string, nav: { persisted: boolean; grant?: boolean; persist?: boolean }, prepare?: (fs: FileSystem) => Promise<void> | void) {
    let asked = 0;
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      storage: {
        estimate: async () => ({ usage: 300e6, quota: 10e9 }),
        persisted: async () => nav.persisted,
        ...(nav.persist === false ? {} : { persist: async () => { asked++; if (nav.grant) nav.persisted = true; return !!nav.grant; } }),
      },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    const { fs, shell } = await createTestShell();
    shell.commands.register(doctorCmd);
    await prepare?.(fs);
    let out = '';
    const code = await shell.execute(`doctor ${args}`.trim(), (s) => { out += s; }, (s) => { out += s; });
    return { out: out.replace(/\r\n/g, '\n'), code, asked: () => asked };
  }
  const storageLine = (out: string) => out.split('\n').find((l) => /^\S+\s+storage\s/.test(l)) ?? '';

  it('WARN says what it costs and what to do', async () => {
    const { out } = await doctor('', { persisted: false });
    expect(storageLine(out)).toMatch(/^WARN\s+storage\s+300 MB of 10000 MB \(3\.0%\) · not persisted: the browser may delete every file here when the disk runs low, with no warning\. To keep them, bookmark this site or install it as an app, then run: doctor --persist$/);
  }, 120_000);

  it('OK when persisted', async () => {
    const { out } = await doctor('', { persisted: true });
    expect(storageLine(out)).toMatch(/^OK\s+storage\s+.* · persisted$/);
  }, 120_000);

  it('after a loss it prints the commands that put back what the lost disk had', async () => {
    store.set(LOST_KEY, JSON.stringify({ volume: 'old', at: 1, pkg: ['python3'], debian: true, toolchains: [], claude: true, signins: ['claude'] }));
    const { out } = await doctor('', { persisted: true });
    expect(storageLine(out)).toMatch(/^WARN\s+storage\s+.* · persisted · the filesystem before this one was lost; to put back what it had: pkg install python3 ; debian install ; claude install ; claude \(sign in again\)$/);
  }, 120_000);

  it('--persist reports a refusal with what makes a browser grant it, and exits 1', async () => {
    const r = await doctor('--persist', { persisted: false, grant: false });
    expect(r.asked()).toBe(1);
    expect(r.code).toBe(1);
    expect(r.out).toContain('did not grant persistent storage');
    expect(r.out).toContain('bookmarked, installed as an app');
    expect(r.out).toContain('run doctor --persist again');
    // asked again on the next run, not remembered as refused
    const again = await doctor('--persist', { persisted: false, grant: false });
    expect(again.asked()).toBe(1);
  });

  it('--persist on a browser without it says so', async () => {
    const r = await doctor('--persist', { persisted: false, persist: false });
    expect(r.code).toBe(1);
    expect(r.out).toContain('no persistent storage to ask for');
  });

  // (last: a grant holds for the rest of the page load)
  it('--persist asks the browser and reports a grant', async () => {
    const r = await doctor('--persist', { persisted: false, grant: true });
    expect(r.asked()).toBe(1);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Storage is persistent');
  });
});
