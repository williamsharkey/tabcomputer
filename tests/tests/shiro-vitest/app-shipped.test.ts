/**
 * The apps this site ships (src/apps/shipped.ts, docs/APPS.md "Shipped apps"):
 * their dock entries before they are installed and after they are removed,
 * and the sentences an app's first start shows (src/apps/progress.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { shippedApps, isShipped, hiddenShipped, setShippedHidden, registerShippedApps, shippedGlyph, HIDDEN_KEY } from '@shiro/apps/shipped';
import { idTaken } from '@shiro/apps/window';
import { firstInstallText, plainInstallLine } from '@shiro/apps/progress';

describe('apps this site ships', () => {
  const g = globalThis as { localStorage?: Storage };
  const had = g.localStorage;
  beforeEach(() => {
    // (vitest's page has no localStorage: a Map stands in)
    const m = new Map<string, string>();
    if (!had) g.localStorage = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, String(v)); }, removeItem: (k: string) => { m.delete(k); } } as Storage;
    g.localStorage!.removeItem(HIDDEN_KEY);
  });
  afterEach(() => { if (!had) delete g.localStorage; });

  it('the converter is one, named for what it does, with its icon', () => {
    const c = shippedApps().find((a) => a.id === 'converter')!;
    expect(c.name).toBe('Convert Old Files');
    expect(c.icon).toMatch(/^data:image\/svg\+xml;base64,/);
    // (the icon sets other than Classic draw a glyph; without one the dock shows two letters)
    expect(c.glyph).toBe(shippedGlyph('converter'));
    expect(c.glyph).toMatch(/^M[0-9hlHLvVmM .-]+$/);
    expect(isShipped('converter')).toBe(true);
    expect(isShipped('templates')).toBe(false);
    expect(shippedApps().every((a) => !['templates', 'file-tool'].includes(a.id))).toBe(true);
  });

  it('each has a dock entry until it is installed or removed', async () => {
    const entries = new Map<string, { id: string; name: string; launch: (args?: Record<string, unknown>) => unknown }>();
    const requests: string[] = [];
    const wm = {
      apps: () => [...entries.values()],
      registerApp: (a: { id: string; name: string; launch: () => unknown }) => { entries.set(a.id, a); },
      openApp: async () => null,
      get: () => null,
      launches: { request: (info: { id: string }) => { requests.push(info.id); return { launch: { id: info.id }, fresh: true }; } },
    };
    const opened: string[] = [];
    const open = async (a: { id: string }) => { opened.push(a.id); return null; };
    expect(registerShippedApps(wm as never, open as never)).toContain('converter');
    expect(entries.get('converter')!.name).toBe('Convert Old Files');
    // the click asks for the launch before anything is awaited, then installs and opens
    await entries.get('converter')!.launch();
    expect(requests).toEqual(['converter']);
    expect(opened).toEqual(['converter']);
    // an entry that is there already (the installed app's) is left alone
    expect(registerShippedApps(wm as never, open as never)).toEqual([]);
    // removed: no entry at the next boot, until it is installed again
    entries.clear();
    setShippedHidden('converter', true);
    expect(hiddenShipped()).toEqual(['converter']);
    expect(registerShippedApps(wm as never, open as never)).not.toContain('converter');
    setShippedHidden('converter', false);
    expect(hiddenShipped()).toEqual([]);
    expect(registerShippedApps(wm as never, open as never)).toContain('converter');
    setShippedHidden('not-shipped', true);
    expect(hiddenShipped()).toEqual([]);
  });

  it('a shipped app\'s entry does not make its id a built-in app\'s', () => {
    const g = globalThis as { __shiroDesktop?: unknown };
    const before = g.__shiroDesktop;
    g.__shiroDesktop = { apps: () => [{ id: 'converter' }, { id: 'files' }] };
    try {
      expect(idTaken('converter')).toBe(false);
      expect(idTaken('files')).toBe(true);
    } finally { g.__shiroDesktop = before; }
  });
});

describe('what a first start says', () => {
  it('sentences for the person, not the installer\'s lines', () => {
    expect(firstInstallText('Convert Old Files')).toBe('Convert Old Files needs some programs. They are being downloaded. This happens once.');
    expect(plainInstallLine('Installing Debian first (debian install)...')).toMatch(/^The Linux system .* is being downloaded\. This happens once\.$/);
    expect(plainInstallLine('Debian 13 (trixie, snapshot 20260101T000000Z): 148 packages, 9012 paths, 61.2 MB streamed on demand')).toBe('The Linux system is in place. The programs come next.');
    expect(plainInstallLine('File rescue: 31 packages to add, 2 already installed, 88 MB streamed on first use')).toBe('The programs are being added.');
    expect(plainInstallLine('File rescue: 31 packages installed in 0.9 s (4120 paths; files load on first use).')).toBe('The programs are installed.');
    expect(plainInstallLine('No prebuilt rescue layer on this server for this Debian base; installing with apt (this takes minutes).')).toMatch(/takes a few minutes/);
    expect(plainInstallLine('Get:1 http://deb.debian.org/debian trixie/main amd64 libwpd-tools')).toMatch(/being installed/);
    expect(plainInstallLine('some line nobody mapped')).toBeNull();
  });
});
