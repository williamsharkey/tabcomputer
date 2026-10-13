/**
 * The phone layout's rules (docs/DESKTOP.md "Phone layout", tabcomputer#154):
 * which screens get it, what is on which page of Home, what a touch on the
 * pill means, and what the menu bar's menus become in the pill's sheet.
 * The layout itself is checked in Chromium by tests/browser/phone-layout.mjs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { layoutChoice, phoneFor, LAYOUT_KEY, setLayoutChoice, savedLayout, onLayoutChoice } from '@shiro/phone-rule';
import {
  homeGrid, homePages, menuSheet, neighbour, pillStrip, pinchFont, phoneFont, PillGesture, PAGE_ONE,
  PHONE_FONT, PHONE_FONT_KEY, PILL_DOUBLE, PILL_HOLD, type HomeApp, type PillAction,
} from '@shiro/desktop/phone-model';
import { WindowManager, type MenuSpec } from '@shiro/desktop/wm';
import { uiMode } from '@shiro/ui-mode';

if (!(globalThis as any).localStorage) {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, String(v)); },
    removeItem: (k: string) => { store.delete(k); }, clear: () => store.clear(),
  };
}
beforeEach(() => { localStorage.removeItem(LAYOUT_KEY); localStorage.removeItem(PHONE_FONT_KEY); localStorage.removeItem('tabcomputer-ui'); });

describe('which screens get the phone layout', () => {
  const touch = (width: number, height: number) => ({ width, height, coarse: true, screenShort: Math.min(width, height) });
  const mouse = (width: number, height: number) => ({ width, height, coarse: false });

  it('phones, upright and on their side', () => {
    expect(phoneFor(touch(393, 852))).toBe(true);
    expect(phoneFor(touch(375, 667))).toBe(true);
    expect(phoneFor(touch(360, 740))).toBe(true);
    expect(phoneFor(touch(852, 393))).toBe(true);
    expect(phoneFor(touch(667, 375))).toBe(true);
  });

  it('a tablet keeps the desktop, upright too', () => {
    expect(phoneFor(touch(820, 1180))).toBe(false);
    expect(phoneFor(touch(1180, 820))).toBe(false);
    expect(phoneFor(touch(768, 1024))).toBe(false);
    expect(phoneFor(touch(600, 960))).toBe(false);
    // its keyboard up: the viewport is short, the screen is not
    expect(phoneFor({ width: 1180, height: 420, coarse: true, screenShort: 820 })).toBe(false);
  });

  it('a large screen keeps the desktop; a narrow window on it gets the phone layout', () => {
    expect(phoneFor(mouse(1280, 800))).toBe(false);
    expect(phoneFor(mouse(1440, 900))).toBe(false);
    expect(phoneFor(mouse(599, 900))).toBe(true);
    expect(phoneFor(mouse(600, 900))).toBe(false);
    expect(phoneFor(mouse(420, 300))).toBe(true);
    // a short, wide window is not a phone on its side: nothing touches it
    expect(phoneFor(mouse(1280, 450))).toBe(false);
    expect(phoneFor(mouse(700, 450))).toBe(false);
  });

  it('on its side, a touched screen is a phone under 500 px of short side', () => {
    expect(phoneFor(touch(900, 520))).toBe(false);
    expect(phoneFor(touch(900, 499))).toBe(true);
    expect(phoneFor(touch(560, 900))).toBe(true);
  });

  it('a choice forces either', () => {
    expect(phoneFor(mouse(1280, 800), 'phone')).toBe(true);
    expect(phoneFor(touch(393, 852), 'desktop')).toBe(false);
    expect(phoneFor(touch(820, 1180), 'phone')).toBe(true);
  });

  it('the address chooses for its page, the setting is remembered, and the address wins', () => {
    expect(layoutChoice('')).toBe('auto');
    expect(layoutChoice('?ui=phone')).toBe('phone');
    expect(layoutChoice('?ui=desktop')).toBe('desktop');
    expect(layoutChoice('?ui=terminal')).toBe('auto');
    let told = 0;
    const off = onLayoutChoice(() => { told++; });
    setLayoutChoice('phone');
    expect([savedLayout(), layoutChoice(''), layoutChoice('?ui=desktop'), told]).toEqual(['phone', 'phone', 'desktop', 1]);
    setLayoutChoice('auto');
    expect([savedLayout(), localStorage.getItem(LAYOUT_KEY), told]).toEqual(['auto', null, 2]);
    off();
  });

  it('?ui=phone is the desktop UI (its phone layout), remembered as the desktop', () => {
    expect(uiMode({ search: '?ui=phone', hostname: 'shiro.computer' }, false)).toBe('desktop');
    expect(localStorage.getItem('tabcomputer-ui')).toBe('desktop');
  });

  it('the window manager is compact while the phone layout is on, and counts no title bar', () => {
    document.body.innerHTML = '';
    const root = document.createElement('div');
    document.body.appendChild(root);
    const wm = new WindowManager(root, { workArea: () => ({ x: 0, y: 0, width: 393, height: 830 }) });
    const w = wm.createWindow({ title: 'A', width: 300, height: 200 });
    const before = w.geometry();
    wm.phone = true;
    wm.relayout();
    expect(wm.compact).toBe(true);
    expect(w.state).toBe('maximized');
    // the client area is the whole work area: no 38 px of title bar
    expect(w.geometry()).toEqual({ x: 0, y: 0, width: 393, height: 830 });
    expect(before.height).toBe(200);
    // every later window fills it too
    expect(wm.createWindow({ title: 'B', width: 200, height: 100 }).geometry()).toEqual({ x: 0, y: 0, width: 393, height: 830 });
  });
});

describe('Home', () => {
  const app = (id: string, group?: string, installed = false): HomeApp => ({ id, name: id, group, installed });
  // the desktop's apps in dock order (src/desktop/index.ts, devtools.ts, gui/desktop-apps.ts)
  const APPS: HomeApp[] = [
    app('terminal'), app('files'), app('settings'), app('activity'), app('browser'), app('notebook'), app('apps'),
    app('htop'), app('python3'),
    app('nano', 'editors'), app('vim', 'editors'), app('neovim', 'editors'), app('emacs', 'editors'), app('code', 'editors'), app('geany', 'editors'),
    app('converter', undefined, true), app('expenses', undefined, true),
    app('git', 'developer'), app('tmux', 'developer'),
    app('claude', 'agents'), app('gemini', 'agents'), app('codex', 'agents'),
    app('gimp', 'debian'), app('xeyes', 'debian'), app('xclock', 'debian'),
    app('about'), app('dataflow'),
  ];
  const FOLDERS = [{ id: 'editors', name: 'Text Editors' }, { id: 'developer', name: 'Developer Tools' }, { id: 'agents', name: 'AI agents' }, { id: 'debian', name: 'Linux apps' }];
  const ids = (page: ReturnType<typeof homePages>[number]) => page.map((e) => (e.kind === 'folder' ? `[${e.name}: ${e.apps.join(' ')}]` : e.id));

  it('four across upright, more on its side, as many rows as fit', () => {
    expect(homeGrid(393, 700)).toEqual({ cols: 4, rows: 7 });
    expect(homeGrid(375, 517)).toEqual({ cols: 4, rows: 5 });
    expect(homeGrid(852, 260).cols).toBe(8);
    expect(homeGrid(852, 260).rows).toBe(3);
    expect(homeGrid(320, 40).rows).toBe(1);
  });

  it('page one is the nine, in order, then the installed apps', () => {
    const pages = homePages(APPS, FOLDERS, 28);
    expect(ids(pages[0])).toEqual([...PAGE_ONE, 'expenses']);
    expect(PAGE_ONE).toEqual(['terminal', 'files', 'code', 'notebook', 'browser', 'python3', 'claude', 'settings', 'converter']);
  });

  it('later pages hold the rest, the dock\'s stacks as folders where their first member stood', () => {
    const pages = homePages(APPS, FOLDERS, 28);
    expect(pages.length).toBe(2);
    expect(ids(pages[1])).toEqual([
      'activity', 'apps', 'htop', '[Text Editors: nano vim neovim emacs geany]', '[Developer Tools: git tmux]',
      '[AI agents: gemini codex]', '[Linux apps: gimp xeyes xclock]', 'about', 'dataflow',
    ]);
    // an app on page one is not in its folder as well
    const all = pages.flat().flatMap((e) => (e.kind === 'folder' ? e.apps : [e.id]));
    expect(all.length).toBe(new Set(all).size);
    expect(all.sort()).toEqual(APPS.map((a) => a.id).sort());
  });

  it('a folder of one is the app itself, and an app without a known folder stands alone', () => {
    const pages = homePages([app('terminal'), app('git', 'developer'), app('x', 'nowhere')], FOLDERS, 28);
    expect(ids(pages[1])).toEqual(['git', 'x']);
  });

  it('pages run on when they are full, page one first', () => {
    const many = [...APPS, ...Array.from({ length: 12 }, (_, i) => app(`mine${i}`, undefined, true))];
    const pages = homePages(many, FOLDERS, 8);
    expect(pages.every((p) => p.length <= 8)).toBe(true);
    expect(ids(pages[0])).toEqual(PAGE_ONE.slice(0, 8));
    expect(ids(pages[1])[0]).toBe('converter');
    // the rest starts on a page of its own
    expect(ids(pages[3])[0]).toBe('activity');
    expect(homePages([], FOLDERS, 8)).toEqual([[]]);
  });
});

describe('the pill', () => {
  let said: PillAction[];
  let g: PillGesture;
  beforeEach(() => { vi.useFakeTimers(); said = []; g = new PillGesture((a) => said.push(a)); });
  afterEach(() => { vi.useRealTimers(); });
  const tap = (x = 100, y = 800) => { g.down(x, y); g.up(x + 1, y - 1); };

  it('a tap is Home, said once the wait for a second tap is over', () => {
    tap();
    expect(said).toEqual([]);
    vi.advanceTimersByTime(PILL_DOUBLE);
    expect(said).toEqual(['home']);
  });

  it('two taps are the menu, and no Home', () => {
    tap();
    vi.advanceTimersByTime(PILL_DOUBLE - 80);
    tap();
    vi.advanceTimersByTime(1000);
    expect(said).toEqual(['menu']);
  });

  it('two slow taps are Home twice', () => {
    tap();
    vi.advanceTimersByTime(PILL_DOUBLE + 20);
    tap();
    vi.advanceTimersByTime(PILL_DOUBLE);
    expect(said).toEqual(['home', 'home']);
  });

  it('a swipe up is the switcher, said while the finger still moves, and once', () => {
    g.down(100, 800);
    g.move(101, 790);
    expect(said).toEqual([]);
    g.move(103, 770);
    expect(said).toEqual(['switcher']);
    g.move(104, 700);
    g.up(104, 650);
    vi.advanceTimersByTime(1000);
    expect(said).toEqual(['switcher']);
  });

  it('held still is the switcher; held and then moved is not', () => {
    g.down(100, 800);
    vi.advanceTimersByTime(PILL_HOLD);
    expect(said).toEqual(['switcher']);
    g.up(100, 800);
    vi.advanceTimersByTime(1000);
    expect(said).toEqual(['switcher']);

    said.length = 0;
    g.down(100, 800);
    g.move(120, 801);
    vi.advanceTimersByTime(PILL_HOLD * 2);
    g.up(121, 801);
    vi.advanceTimersByTime(1000);
    // (20 px sideways: neither a tap nor a swipe)
    expect(said).toEqual([]);
  });

  it('sideways is the next app (leftwards) or the previous one', () => {
    g.down(100, 800); g.move(70, 802); g.up(60, 803);
    expect(said).toEqual(['next']);
    g.down(100, 800); g.move(130, 798); g.up(150, 797);
    expect(said).toEqual(['next', 'previous']);
    vi.advanceTimersByTime(1000);
    expect(said).toEqual(['next', 'previous']);
  });

  it('a slanted swipe goes by its longer side; a small wobble is still a tap', () => {
    g.down(100, 800); g.move(140, 780); g.up(160, 770);
    expect(said).toEqual(['previous']);
    said.length = 0;
    g.down(100, 800); g.move(104, 796); g.up(105, 795);
    vi.advanceTimersByTime(PILL_DOUBLE);
    expect(said).toEqual(['home']);
  });

  it('a cancelled touch says nothing', () => {
    g.down(100, 800);
    g.cancel();
    vi.advanceTimersByTime(2000);
    g.up(100, 800);
    expect(said).toEqual([]);
  });

  it('the next and previous open app, in the order they were opened', () => {
    expect(neighbour(['a', 'b', 'c'], 'a', 1)).toBe('b');
    expect(neighbour(['a', 'b', 'c'], 'c', 1)).toBe('a');
    expect(neighbour(['a', 'b', 'c'], 'a', -1)).toBe('c');
    // from Home: the first, or the last
    expect(neighbour(['a', 'b'], null, 1)).toBe('a');
    expect(neighbour(['a', 'b'], null, -1)).toBe('b');
    expect(neighbour(['a'], 'a', 1)).toBe(null);
    expect(neighbour([], null, 1)).toBe(null);
  });

  it('its strip is thin, thinner on a phone on its side, and clears a home indicator', () => {
    expect(pillStrip(852)).toBe(22);
    expect(pillStrip(393)).toBe(18);
    expect(pillStrip(852, 34)).toBe(44);
    // what is left for the app: 95% of the screen and more
    expect((852 - pillStrip(852)) / 852).toBeGreaterThan(0.95);
    expect((667 - pillStrip(667)) / 667).toBeGreaterThan(0.95);
    expect((393 - pillStrip(393)) / 393).toBeGreaterThan(0.95);
  });
});

describe('the menu bar as a sheet', () => {
  const ran: string[] = [];
  const MENUS: MenuSpec[] = [
    { title: 'File', items: [
      { label: 'Open…', action: () => ran.push('open') },
      'separator',
      { label: 'New Terminal Window', shortcut: 'Alt+Shift+Enter', action: () => ran.push('term') },
      { label: 'New Tab', shortcut: 'Alt+Shift+T', disabled: true },
      'separator',
      { label: 'Close Window', shortcut: 'Alt+Shift+W', action: () => ran.push('close') },
    ] },
    { title: 'View', items: [{ label: 'Light' }, { label: 'Dark', checked: true }] },
    { title: 'Window', items: [
      { label: 'Minimize', phone: false }, { label: 'Zoom', phone: false }, { label: 'Tile Left', phone: false },
      'separator',
      { label: 'Terminal', checked: true, action: () => ran.push('focus') },
    ] },
    { title: 'Empty', items: [{ label: 'Tile Right', phone: false }, 'separator'] },
  ];

  it('each menu is a section with its commands, in order', () => {
    const sheet = menuSheet(MENUS);
    expect(sheet.map((s) => s.title)).toEqual(['File', 'View', 'Window']);
    expect(sheet[0].items.map((i) => i.label)).toEqual(['Open…', 'New Terminal Window', 'New Tab', 'Close Window']);
  });

  it('moving and tiling windows is left out, and a menu with nothing left', () => {
    const sheet = menuSheet(MENUS);
    expect(sheet[2].items.map((i) => i.label)).toEqual(['Terminal']);
    expect(sheet.some((s) => s.title === 'Empty')).toBe(false);
  });

  it('a command keeps its action, its check mark and whether it is off; no shortcut is shown', () => {
    const sheet = menuSheet(MENUS);
    sheet[0].items[1].action!();
    sheet[2].items[0].action!();
    expect(ran).toEqual(['term', 'focus']);
    expect(sheet[0].items[2].disabled).toBe(true);
    expect(sheet[1].items.map((i) => !!i.checked)).toEqual([false, true]);
    expect(JSON.stringify(sheet)).not.toContain('Alt+Shift');
  });
});

describe('the terminal\'s text size', () => {
  it('the default, and what a pinch saved', () => {
    expect(phoneFont()).toBe(PHONE_FONT);
    localStorage.setItem(PHONE_FONT_KEY, '16');
    expect(phoneFont()).toBe(16);
    localStorage.setItem(PHONE_FONT_KEY, '400');
    expect(phoneFont()).toBe(PHONE_FONT);
  });

  it('a pinch scales it, within what can be read and what fits', () => {
    expect(pinchFont(13, 1)).toBe(13);
    expect(pinchFont(13, 1.5)).toBe(20);
    expect(pinchFont(13, 0.7)).toBe(9);
    expect(pinchFont(13, 0.1)).toBe(8);
    expect(pinchFont(13, 9)).toBe(28);
  });
});
