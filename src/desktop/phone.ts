/**
 * The phone layout (docs/DESKTOP.md "Phone layout", tabcomputer#154): in
 * place of the dock, the menu bar and window frames, a Home screen of apps,
 * one app on the whole screen, and one control, the pill at the bottom.
 *
 * It replaces chrome and navigation only. An open app is still a window of
 * the window manager (wm.ts, in its compact mode: every window fills the work
 * area), with the same content as on a large screen.
 *
 *   Home      icons in pages you swipe, folders for the dock's stacks, search
 *   the pill  tap: Home. up or held: the switcher. sideways: the next open
 *             app. two taps: the app's menus as a sheet.
 *   switcher  the open apps as cards (the windows themselves, scaled down);
 *             tap one to open it, swipe it up to close it
 *   terminal  pinch for the text size, two fingers tap for another terminal
 *             and swipe sideways between them
 *
 * Its own chunk: loaded the first time the rule (src/phone-rule.ts) says
 * phone, never on a large screen. The rules without a DOM are phone-model.ts.
 */

import phoneCss from './phone.css?inline';
import type { AppContext, DesktopLayout } from './index';
import type { AppDescriptor, DesktopWindow, MenuSpec } from './wm';
import { TerminalView } from './terminal-app';
import { ShiroTerminal } from '../terminal';
import { appIconIn, paintPixelTiles } from './iconsets';
import { GLYPHS } from './icons';
import { DEV_GROUPS, DEV_TOOLS } from './devtools';
import { networkStatus, onNetworkStatus, type NetworkStatus } from '../net-signin';
import { BRAND } from '../brand';
import {
  homeGrid, homePages, menuSheet, neighbour, phoneFont, pinchFont, PillGesture, PHONE_FONT_KEY,
  type HomeApp, type HomeEntry, type PillAction, type SheetItem, type SheetSection,
} from './phone-model';

export interface PhoneDeps {
  ctx: AppContext;
  layout: DesktopLayout;
  /** The menu bar's menus for the app in front (File, Edit, View, Window, the app's own, Help) */
  menus: () => MenuSpec[];
  systemMenu: () => MenuSpec;
  /** An app that installs on first use: is it there yet? */
  badge: (id: string) => 'installing' | 'missing' | null;
  /** Open the search (spotlight.ts) */
  search: () => void;
  /** The desktop is on screen (before that, windows are being put back and nothing is navigation) */
  revealed: () => boolean;
  /** The menu bar's appearance and network buttons: Home's status line borrows them */
  status: HTMLElement[];
  restoreStatus: () => void;
}

export interface PhoneUI {
  /** Turn the layout on or off (the window's size crossed the rule). `home`: start at Home. */
  setActive(on: boolean, home: boolean): void;
  /** The apps, their state or the open windows changed */
  refresh(): void;
  /** The desktop just appeared: show this app, or Home */
  arrive(win: DesktopWindow | null): void;
  home(): void;
  active(): boolean;
}

/** Apps the person took off Home (they stay in the search) */
export const HOME_HIDDEN_KEY = 'tabcomputer-home-hidden';
/** A Linux app's "made for a large screen" line was shown */
export const GUI_NOTE_KEY = 'tabcomputer-phone-gui-note';
/** The terminal's text size on a large screen (terminal.ts) */
const DESKTOP_FONT = 14;
/** The desktop's own apps that are neither in the dock nor Linux apps */
const PLAIN = new Set(['about', 'dataflow', 'preview']);

const NET_WORDS: Record<string, string> = {
  'signed-in': 'Online · signed in', online: 'Online · not signed in', 'needs-sign-in': 'Sign in to go online',
  offline: 'Offline', unavailable: 'No internet here',
};

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

function hiddenIds(): Set<string> {
  try {
    const list = JSON.parse(localStorage.getItem(HOME_HIDDEN_KEY) || '[]');
    return new Set(Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []);
  } catch { return new Set(); }
}
function saveHidden(ids: Set<string>): void {
  try { if (ids.size) localStorage.setItem(HOME_HIDDEN_KEY, JSON.stringify([...ids])); else localStorage.removeItem(HOME_HIDDEN_KEY); } catch { /* no storage */ }
}

export function initPhone(deps: PhoneDeps): PhoneUI {
  const { ctx, layout } = deps;
  const wm = ctx.wm, root = wm.root, layer = wm.layer;
  if (!document.getElementById('sd-phone-style')) {
    const style = h('style');
    style.id = 'sd-phone-style';
    style.textContent = phoneCss;
    document.head.appendChild(style);
  }

  let active = false;
  let atHome = true;
  let switching = false;
  /** Was Home showing when the switcher opened */
  let fromHome = false;
  /** Open apps (window ids) in the order they were opened: the switcher's cards, the pill's sideways order */
  let order: string[] = [];
  let page = 0;

  // ── Elements ──
  const back = h('div', 'sd-phone-back');
  const home = h('div', 'sd-home');
  home.innerHTML = `<div class="sd-home-top">
      <div class="sd-home-status"><span class="sd-home-net" role="status"></span><span class="sd-home-grow"></span><span class="sd-home-tools"></span></div>
      <button type="button" class="sd-home-search" aria-label="Search apps, commands and files">${GLYPHS.search}<span>Search</span></button>
    </div>
    <div class="sd-home-pager" tabindex="-1" aria-label="Apps"></div>
    <div class="sd-home-dots"></div>`;
  const netText = home.querySelector<HTMLElement>('.sd-home-net')!;
  const tools = home.querySelector<HTMLElement>('.sd-home-tools')!;
  const pager = home.querySelector<HTMLElement>('.sd-home-pager')!;
  const dots = home.querySelector<HTMLElement>('.sd-home-dots')!;
  const pill = h('button', 'sd-pill');
  pill.type = 'button';
  pill.setAttribute('aria-label', 'Home. Swipe up for the open apps, sideways for the next one; tap twice for the menu.');
  pill.innerHTML = '<i></i>';
  const switchEnd = h('div', 'sd-switch-end');
  const switchEmpty = h('div', 'sd-switch-empty');
  switchEmpty.textContent = 'Nothing is open.';

  // ── Which apps are open ──
  const isCard = (w: DesktopWindow) => w.state !== 'closed' && !w.options.override && !w.options.skipTaskbar;
  const syncOrder = () => {
    const open = wm.windows().filter(isCard).map((w) => w.id);
    order = [...order.filter((id) => open.includes(id)), ...open.filter((id) => !order.includes(id))];
  };
  const cards = (): DesktopWindow[] => { syncOrder(); return order.map((id) => wm.get(id)!).filter(Boolean); };
  const appName = (w: DesktopWindow) => wm.app(w.appId)?.name ?? (w.title || 'App');
  /** Something runs in it: a command in a terminal, an install, a launch */
  const busy = (w: DesktopWindow): boolean => {
    const c = (w as { content?: unknown }).content;
    if (c instanceof TerminalView && c.terminals().some((t) => t.isBusy())) return true;
    return !!wm.launches.get(w.appId ?? '')?.active || deps.badge(w.appId ?? '') === 'installing' || w.element.classList.contains('sd-attention');
  };

  // ── Home and apps ──
  const showHome = () => {
    atHome = true;
    root.classList.add('sd-at-home');
    (document.activeElement as HTMLElement | null)?.blur?.();
    // No app is in front: the next focus, whatever asks for it, leaves Home
    wm.setFocus(null);
  };
  const showApp = (win?: DesktopWindow | null) => {
    atHome = false;
    root.classList.remove('sd-at-home');
    if (win && win.state !== 'closed') win.focus();
  };

  /** A line at the top that goes by itself */
  let noteEl: HTMLElement | null = null;
  let noteTimer: ReturnType<typeof setTimeout> | null = null;
  const note = (text: string, ms = 1600) => {
    noteEl?.remove();
    if (noteTimer) clearTimeout(noteTimer);
    const n = noteEl = h('div', 'sd-phone-note');
    n.setAttribute('role', 'status');
    n.textContent = text;
    root.append(n);
    noteTimer = setTimeout(() => { n.remove(); if (noteEl === n) noteEl = null; }, ms);
  };

  // ── Sheets ──
  let sheetEl: HTMLElement | null = null;
  const closeSheet = () => { sheetEl?.remove(); sheetEl = null; };
  const openSheet = (o: { title: string; lines?: string[]; sections: SheetSection[] }) => {
    closeSheet();
    const veil = sheetEl = h('div', 'sd-psheet-veil');
    const sheet = h('div', 'sd-psheet');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-label', o.title);
    sheet.append(h('div', 'sd-psheet-grab'));
    const title = h('h2');
    title.textContent = o.title;
    sheet.append(title);
    for (const line of o.lines ?? []) { const p = h('p'); p.textContent = line; sheet.append(p); }
    for (const sec of o.sections) {
      if (sec.title) { const t = h('h3'); t.textContent = sec.title; sheet.append(t); }
      const list = h('div', 'sd-psheet-list');
      for (const it of sec.items) {
        const b = h('button', 'sd-psheet-item' + (it.danger ? ' sd-danger' : ''));
        b.type = 'button';
        b.disabled = !!it.disabled;
        const label = h('span', 'sd-grow');
        label.textContent = it.label;
        b.append(label);
        if (it.checked) { const c = h('span', 'sd-check'); c.textContent = '✓'; b.append(c); b.setAttribute('aria-checked', 'true'); }
        // The app keeps the keyboard's focus (Paste goes to the terminal that had it)
        b.addEventListener('pointerdown', (e) => e.preventDefault());
        b.addEventListener('click', () => { closeSheet(); it.action?.(); });
        list.append(b);
      }
      sheet.append(list);
    }
    veil.append(sheet);
    // A tap beside the sheet closes it: one that began there (the finger that held an icon down is still lifting)
    let began = false;
    veil.addEventListener('pointerdown', (e) => { began = e.target === veil; });
    veil.addEventListener('click', (e) => { if (e.target === veil && began) closeSheet(); });
    veil.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeSheet(); } });
    root.append(veil);
  };

  /** The pill's sheet: what the desktop's menu bar holds for the app in front */
  const openMenuSheet = () => {
    const win = atHome ? null : wm.focused();
    const sys = deps.systemMenu();
    const hidden = hiddenIds();
    const sections = [
      ...menuSheet(deps.menus()),
      ...(hidden.size ? [{ title: 'Home', items: [{ label: 'Show All Apps on Home', action: () => { saveHidden(new Set()); render(); } }] }] : []),
      ...menuSheet([{ ...sys, title: BRAND.name }]),
    ];
    openSheet({ title: win ? appName(win) : BRAND.name, sections });
  };

  // ── Home: the apps ──
  const folderNames = (): Map<string, string> => {
    const names = new Map<string, string>(DEV_GROUPS.map((g) => [g.id, g.name]));
    names.set('debian', 'Linux apps');
    return names;
  };
  const isLinuxApp = (a: AppDescriptor) => (a.order ?? 0) >= 60 && !a.group && !PLAIN.has(a.id);
  /** The app toolkit's (docs/APPS.md): installed apps and the ones this site ships register at order 40 */
  const isToolkitApp = (a: AppDescriptor) => a.order === 40 && !a.group;
  /** Installed, not just offered (an installed app's entry has its App menu) */
  const isInstalledApp = (a: AppDescriptor) => isToolkitApp(a) && !!a.menus;
  const homeApps = (): { list: HomeApp[]; by: Map<string, AppDescriptor> } => {
    const hidden = hiddenIds();
    const names = folderNames();
    const by = new Map<string, AppDescriptor>();
    const list: HomeApp[] = [];
    for (const a of wm.apps()) {
      if (a.id === 'preview' || hidden.has(a.id)) continue;
      // What the dock shows, the two explainers its menus hold, and every Linux app (its folder is the catalog)
      if (a.dock === false && !isLinuxApp(a) && a.id !== 'about' && a.id !== 'dataflow') continue;
      by.set(a.id, a);
      const group = a.group && names.has(a.group) ? a.group : isLinuxApp(a) ? 'debian' : undefined;
      list.push({ id: a.id, name: a.name, group, installed: isToolkitApp(a) });
    }
    return { list, by };
  };
  const running = () => new Set(cards().map((w) => w.appId));
  const missing = (a: AppDescriptor) => deps.badge(a.id) === 'missing' || (isLinuxApp(a) && a.dock === false);

  let iconN = 0;
  const icon = (a: AppDescriptor) => appIconIn(ctx.iconSet(), a.id, a.name, a.icon, iconN++, a.glyph);
  const appTile = (a: AppDescriptor, open: Set<string | undefined>): HTMLElement => {
    const b = h('button', 'sd-home-app');
    b.type = 'button';
    b.dataset.app = a.id;
    b.innerHTML = `<span class="sd-home-icon">${icon(a)}</span><span class="sd-home-name"></span>`;
    b.querySelector('.sd-home-name')!.textContent = a.name;
    const starting = !!wm.launches.get(a.id)?.active || deps.badge(a.id) === 'installing';
    let label = a.name;
    if (starting) { b.classList.add('sd-starting'); b.setAttribute('aria-busy', 'true'); label += ', starting'; }
    else if (open.has(a.id)) { b.classList.add('sd-running'); label += ', open'; }
    else if (missing(a)) { b.classList.add('sd-not-installed'); label += ', installs when opened'; }
    b.setAttribute('aria-label', label);
    return b;
  };
  const folderTile = (e: Extract<HomeEntry, { kind: 'folder' }>, by: Map<string, AppDescriptor>, open: Set<string | undefined>): HTMLElement => {
    const b = h('button', 'sd-home-app sd-home-folder');
    b.type = 'button';
    b.dataset.folder = e.id;
    const members = e.apps.map((id) => by.get(id)!).filter(Boolean);
    b.innerHTML = `<span class="sd-home-icon"><span class="sd-stack-grid">${members.slice(0, 4).map((m) => `<span>${icon(m)}</span>`).join('')}</span></span><span class="sd-home-name"></span>`;
    b.querySelector('.sd-home-name')!.textContent = e.name;
    b.setAttribute('aria-label', `${e.name}, ${members.length} apps`);
    b.setAttribute('aria-haspopup', 'dialog');
    if (members.some((m) => open.has(m.id))) b.classList.add('sd-running');
    return b;
  };

  let pages: HomeEntry[][] = [[]];
  let folderEl: HTMLElement | null = null;
  let folderId = '';
  const closeFolder = () => { folderEl?.remove(); folderEl = null; folderId = ''; };
  const paintFolder = () => {
    if (!folderEl) return;
    const entry = pages.flat().find((e) => e.kind === 'folder' && e.id === folderId);
    if (!entry || entry.kind !== 'folder') { closeFolder(); return; }
    const { by } = homeApps();
    const open = running();
    folderEl.querySelector('h2')!.textContent = entry.name;
    const grid = folderEl.querySelector<HTMLElement>('.sd-folder')!;
    const top = grid.scrollTop;
    grid.textContent = '';
    for (const id of entry.apps) { const a = by.get(id); if (a) grid.append(appTile(a, open)); }
    grid.scrollTop = top;
    if (ctx.iconSet() === 'pixel') paintPixelTiles(grid, wm.theme(), (id) => wm.app(id)?.name ?? id);
  };
  const openFolder = (id: string) => {
    closeFolder();
    const veil = folderEl = h('div', 'sd-folder-veil');
    veil.dataset.iconset = ctx.iconSet();
    veil.innerHTML = '<h2></h2><div class="sd-folder" role="dialog"></div>';
    folderId = id;
    wireTiles(veil);
    veil.addEventListener('click', (e) => { if (e.target === veil || (e.target as HTMLElement).tagName === 'H2') closeFolder(); });
    root.append(veil);
    paintFolder();
  };

  const setPage = (n: number, smooth = true) => {
    page = Math.max(0, Math.min(pages.length - 1, n));
    pager.scrollTo({ left: page * pager.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    paintDots();
  };
  const paintDots = () => {
    [...dots.children].forEach((d, i) => d.setAttribute('aria-current', String(i === page)));
  };
  const render = () => {
    if (!active) return;
    home.dataset.iconset = ctx.iconSet();
    const { list, by } = homeApps();
    const open = running();
    const grid = homeGrid(pager.clientWidth || window.innerWidth, pager.clientHeight || window.innerHeight - 150);
    pages = homePages(list, [...folderNames()].map(([id, name]) => ({ id, name })), grid.cols * grid.rows);
    pager.style.setProperty('--cols', String(grid.cols));
    pager.style.setProperty('--rows', String(grid.rows));
    pager.textContent = '';
    dots.textContent = '';
    dots.dataset.pages = String(pages.length);
    iconN = 0;
    pages.forEach((entries, n) => {
      const pg = h('div', 'sd-home-page');
      pg.setAttribute('role', 'group');
      pg.setAttribute('aria-label', `Page ${n + 1} of ${pages.length}`);
      for (const e of entries) {
        if (e.kind === 'folder') pg.append(folderTile(e, by, open));
        else { const a = by.get(e.id); if (a) pg.append(appTile(a, open)); }
      }
      pager.append(pg);
      const d = h('button', 'sd-home-dot');
      d.type = 'button';
      d.setAttribute('aria-label', `Page ${n + 1}`);
      d.addEventListener('click', () => setPage(n));
      dots.append(d);
    });
    if (ctx.iconSet() === 'pixel') paintPixelTiles(pager, wm.theme(), (id) => wm.app(id)?.name ?? id);
    page = Math.min(page, pages.length - 1);
    pager.scrollLeft = page * pager.clientWidth;
    paintDots();
    paintFolder();
    if (switching) paintCards();
  };
  let queued = false;
  const queueRender = () => {
    if (queued || !active) return;
    queued = true;
    queueMicrotask(() => { queued = false; render(); });
  };
  pager.addEventListener('scroll', () => {
    const n = Math.round(pager.scrollLeft / Math.max(1, pager.clientWidth));
    if (n !== page) { page = n; paintDots(); }
  }, { passive: true });
  pager.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') setPage(page + 1); else if (e.key === 'ArrowLeft') setPage(page - 1);
  });

  const openApp = (id: string) => {
    closeFolder();
    const wins = wm.visibleOrder().filter((w) => w.appId === id);
    if (wins.length) { showApp(wins.find((w) => w.state !== 'minimized') ?? wins[0]); return; }
    void wm.openApp(id);
  };

  // What an icon held down offers: Open, Share (an installed app), Info, Remove
  const runQuiet = (cmd: string) => { const sh = ctx.shell.fork(); sh.cwd = ctx.shell.env['HOME'] || '/home/user'; return sh.execute(cmd, () => {}, () => {}); };
  const appInfo = (a: AppDescriptor): string[] => {
    const tool = DEV_TOOLS.find((t) => t.id === a.id);
    const lines: string[] = [];
    if (isInstalledApp(a)) lines.push(`${a.name} is an app installed on this computer. Its files are in ~/Apps/${a.id}.`);
    else if (isLinuxApp(a)) lines.push(`${a.name} is a Linux app from Debian. It was made for a large screen.`);
    else if (tool && !tool.window) lines.push(`${a.name} runs in a terminal.`);
    else lines.push(`${a.name} is part of ${BRAND.name}.`);
    if (tool?.install && deps.badge(a.id) === 'missing') lines.push(`It installs the first time it is opened: ${tool.install}${tool.time ? ` (${tool.time})` : ''}.`);
    else if (missing(a)) lines.push('It installs the first time it is opened.');
    if (tool?.note) lines.push(tool.note);
    if (cards().some((w) => w.appId === a.id)) lines.push('It is open now.');
    return lines;
  };
  const appMenu = (id: string) => {
    const a = wm.app(id);
    if (!a) return;
    const items: SheetItem[] = [{ label: 'Open', action: () => openApp(id) }];
    if (isInstalledApp(a)) items.push({ label: 'Share as a Link…', action: () => void import('../apps/runtime').then(async (rt) => {
      try { rt.appsDeps(); } catch { rt.configureApps({ fs: ctx.fs, shell: ctx.shell }); }
      await (await import('../apps/window')).shareInstalled(id);
    }).catch((e) => note(String((e as Error)?.message ?? e), 4000)) });
    items.push({ label: 'Info', action: () => openSheet({ title: a.name, lines: appInfo(a), sections: [{ title: '', items: [{ label: 'Done' }] }] }) });
    if (isInstalledApp(a)) {
      items.push({ label: 'Remove…', danger: true, action: () => openSheet({
        title: `Remove ${a.name}?`,
        lines: [`The app is removed from this computer. What it stored stays in its data folder.`],
        sections: [{ title: '', items: [
          { label: `Remove ${a.name}`, danger: true, action: () => void runQuiet(`app remove ${id}`).then((status) => note(status ? `${a.name} could not be removed.` : `${a.name} was removed.`, 2500)) },
          { label: 'Cancel' },
        ] }],
      }) });
    } else {
      items.push({ label: 'Remove from Home', danger: true, action: () => {
        const hidden = hiddenIds();
        hidden.add(id);
        saveHidden(hidden);
        render();
        note(`${a.name} is off Home. Search still finds it; the pill's menu puts it back.`, 4000);
      } });
    }
    closeFolder();
    openSheet({ title: a.name, sections: [{ title: '', items }] });
  };

  /** Taps and long presses on app icons, in `el` (Home's pages, an open folder) */
  function wireTiles(el: HTMLElement): void {
    let held: ReturnType<typeof setTimeout> | null = null;
    let swallow = false;
    let at = { x: 0, y: 0 };
    const clear = () => { if (held) { clearTimeout(held); held = null; } };
    el.addEventListener('pointerdown', (e) => {
      swallow = false;
      clear();
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-app]')?.dataset.app;
      if (!id || e.button) return;
      at = { x: e.clientX, y: e.clientY };
      held = setTimeout(() => { held = null; swallow = true; appMenu(id); }, 500);
    });
    el.addEventListener('pointermove', (e) => { if (held && Math.hypot(e.clientX - at.x, e.clientY - at.y) > 10) clear(); });
    el.addEventListener('pointerup', clear);
    el.addEventListener('pointercancel', clear);
    el.addEventListener('contextmenu', (e) => {
      const id = (e.target as HTMLElement).closest<HTMLElement>('[data-app]')?.dataset.app;
      if (!id) return;
      e.preventDefault();
      clear();
      if (!swallow) { swallow = true; appMenu(id); }
    });
    el.addEventListener('click', (e) => {
      if (swallow) { swallow = false; e.preventDefault(); return; }
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-app], [data-folder]');
      if (!t) return;
      if (t.dataset.folder) openFolder(t.dataset.folder); else openApp(t.dataset.app!);
    });
  }
  wireTiles(pager);
  home.querySelector('.sd-home-search')!.addEventListener('click', (e) => { e.stopPropagation(); deps.search(); });

  // Home's one status line: the network and the sign-in in words, beside the two buttons
  const paintNet = (s: NetworkStatus) => { netText.textContent = NET_WORDS[s] ?? 'Checking the network…'; };
  onNetworkStatus(paintNet);
  paintNet(networkStatus());

  // ── The switcher ──
  const paintCards = () => {
    const list = cards();
    for (const el of layer.querySelectorAll<HTMLElement>('.sd-win')) { delete el.dataset.phoneCard; delete el.dataset.phoneBusy; el.style.order = ''; }
    list.forEach((w, i) => {
      w.element.dataset.phoneCard = appName(w);
      if (busy(w)) w.element.dataset.phoneBusy = '';
      w.element.style.order = String(i);
      w.element.setAttribute('aria-label', `${appName(w)}${busy(w) ? ', busy' : ''}. Tap to open, swipe up to close.`);
    });
    switchEnd.style.order = String(list.length);
    if (list.length) switchEmpty.remove(); else root.append(switchEmpty);
  };
  const beginSwitch = () => {
    if (switching) return;
    closeSheet();
    closeFolder();
    (document.activeElement as HTMLElement | null)?.blur?.();
    switching = true;
    fromHome = atHome;
    const wa = wm.workArea();
    const full = layout.viewportH ?? window.innerHeight;
    const s = wa.width > wa.height ? 0.56 : 0.64;
    root.style.setProperty('--sw-s', String(s));
    root.style.setProperty('--sw-w', `${wa.width}px`);
    root.style.setProperty('--sw-h', `${wa.height}px`);
    root.style.setProperty('--sw-top', `${Math.max(34, Math.round((full - wa.height * s) / 2))}px`);
    root.style.setProperty('--sw-pad', `${Math.max(16, Math.round((window.innerWidth - wa.width * s) / 2))}px`);
    layer.append(switchEnd);
    paintCards();
    root.classList.add('sd-switching');
    // The app in front is the card in the middle
    const cur = wm.focused();
    layer.scrollLeft = 0;
    if (cur && isCard(cur)) layer.scrollLeft = order.indexOf(cur.id) * (wa.width * s + 16);
  };
  const endSwitch = (to: DesktopWindow | null) => {
    if (!switching) return;
    switching = false;
    root.classList.remove('sd-switching');
    switchEnd.remove();
    switchEmpty.remove();
    layer.scrollLeft = 0;
    for (const el of layer.querySelectorAll<HTMLElement>('.sd-win')) {
      const w = wm.get(el.dataset.id ?? '');
      delete el.dataset.phoneCard;
      delete el.dataset.phoneBusy;
      el.style.order = '';
      el.style.removeProperty('--sw-dy');
      el.style.removeProperty('--sw-o');
      el.classList.remove('sd-switch-snap', 'sd-switch-out');
      if (w) el.setAttribute('aria-label', w.title);
    }
    const list = cards();
    if (to) showApp(to);
    else if (fromHome || !list.length) showHome();
    else showApp(wm.focused() ?? list[list.length - 1]);
  };
  // A card: tap opens it, a swipe up closes it; sideways is the row's own scrolling
  let drag: { id: number; el: HTMLElement | null; x: number; y: number; up: boolean } | null = null;
  layer.addEventListener('pointerdown', (e) => {
    if (!switching) return;
    // (not the window's own handler: it would focus the app and raise the keyboard)
    e.stopPropagation();
    if (e.button) return;
    const el = (e.target as HTMLElement).closest<HTMLElement>('.sd-win[data-phone-card]');
    drag = { id: e.pointerId, el, x: e.clientX, y: e.clientY, up: false };
    if (el) { el.classList.remove('sd-switch-snap'); try { el.setPointerCapture(e.pointerId); } catch { /* gone */ } }
  }, true);
  layer.addEventListener('pointermove', (e) => {
    if (!switching || !drag?.el || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    if (!drag.up && dy < -8 && -dy > Math.abs(dx)) drag.up = true;
    if (!drag.up) return;
    drag.el.style.setProperty('--sw-dy', `${Math.min(0, dy)}px`);
    drag.el.style.setProperty('--sw-o', String(Math.max(0.3, 1 + dy / 400)));
  }, true);
  const dragEnd = (e: PointerEvent, cancelled: boolean) => {
    if (!switching || !drag || e.pointerId !== drag.id) return;
    e.stopPropagation();
    const d = drag;
    drag = null;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    const tap = !cancelled && !d.up && Math.hypot(dx, dy) < 8;
    if (!d.el) { if (tap) endSwitch(null); return; }
    const win = wm.get(d.el.dataset.id ?? '');
    if (tap && win) { endSwitch(win); return; }
    if (!cancelled && d.up && dy < -80 && win) {
      d.el.classList.add('sd-switch-out');
      // (an app that asks before it closes stays: its card comes back)
      setTimeout(() => { if (!win.close()) { d.el!.classList.remove('sd-switch-out'); d.el!.style.removeProperty('--sw-dy'); d.el!.style.removeProperty('--sw-o'); } }, 180);
      return;
    }
    d.el.classList.add('sd-switch-snap');
    d.el.style.removeProperty('--sw-dy');
    d.el.style.removeProperty('--sw-o');
  };
  layer.addEventListener('pointerup', (e) => dragEnd(e, false), true);
  layer.addEventListener('pointercancel', (e) => dragEnd(e, true), true);
  layer.addEventListener('click', (e) => { if (switching) { e.stopPropagation(); e.preventDefault(); } }, true);

  // ── The pill ──
  const onPill = (a: PillAction) => {
    if (!active) return;
    if (a === 'home') {
      closeSheet();
      const was = atHome && !switching && !folderEl;
      closeFolder();
      if (switching) { fromHome = true; endSwitch(null); } else showHome();
      // Already Home: back to its first page
      if (was) setPage(0);
    } else if (a === 'switcher') {
      if (switching) endSwitch(null); else beginSwitch();
    } else if (a === 'menu') {
      if (switching) endSwitch(null);
      openMenuSheet();
    } else {
      if (switching) endSwitch(null);
      closeSheet();
      const cur = atHome ? null : wm.focused();
      const list = cards();
      const next = neighbour(list.map((w) => w.id), cur && isCard(cur) ? cur.id : null, a === 'next' ? 1 : -1);
      if (next) { closeFolder(); showApp(wm.get(next)); } else if (!list.length) note('Nothing else is open.');
    }
  };
  const gesture = new PillGesture(onPill);
  pill.addEventListener('pointerdown', (e) => {
    if (e.button) return;
    // (the app keeps the keyboard's focus until the gesture says where to go)
    e.preventDefault();
    try { pill.setPointerCapture(e.pointerId); } catch { /* gone */ }
    gesture.down(e.clientX, e.clientY);
  });
  pill.addEventListener('pointermove', (e) => gesture.move(e.clientX, e.clientY));
  pill.addEventListener('pointerup', (e) => gesture.up(e.clientX, e.clientY));
  pill.addEventListener('pointercancel', () => gesture.cancel());
  pill.addEventListener('contextmenu', (e) => e.preventDefault());
  // From a keyboard: Enter is the tap
  pill.addEventListener('click', (e) => { if (e.detail === 0) onPill('home'); });

  // ── The terminal: pinch for the text size, two fingers for another terminal and between them ──
  let font = phoneFont();
  const setFont = (n: number | null) => {
    const opts = { ...ShiroTerminal.optionOverrides };
    if (n === null) delete opts.fontSize; else opts.fontSize = n;
    ShiroTerminal.optionOverrides = opts;
    for (const t of ShiroTerminal.instances) {
      if (t.term.options.fontSize === (n ?? DESKTOP_FONT)) continue;
      t.term.options.fontSize = n ?? DESKTOP_FONT;
      try { t.fitAddon.fit(); } catch { /* not on screen */ }
    }
  };
  const termViewOf = (target: EventTarget | null): TerminalView | null => {
    const el = (target as HTMLElement | null)?.closest?.<HTMLElement>('.sd-win');
    const c = el && (wm.get(el.dataset.id ?? '') as { content?: unknown } | undefined)?.content;
    return c instanceof TerminalView ? c : null;
  };
  const spread = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const middle = (t: TouchList) => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 });
  let two: { view: TerminalView; d: number; x: number; y: number; t: number; font: number; mode: '' | 'pinch' | 'swipe'; lastX: number; travel: number } | null = null;
  root.addEventListener('touchstart', (e) => {
    if (!active || switching || e.touches.length !== 2) { two = null; return; }
    const view = termViewOf(e.target);
    if (!view) return;
    e.preventDefault();
    e.stopPropagation();
    const m = middle(e.touches);
    two = { view, d: spread(e.touches), x: m.x, y: m.y, t: performance.now(), font, mode: '', lastX: m.x, travel: 0 };
  }, { capture: true, passive: false });
  root.addEventListener('touchmove', (e) => {
    if (!two || e.touches.length !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    const m = middle(e.touches), scale = spread(e.touches) / Math.max(1, two.d);
    two.travel = Math.max(two.travel, Math.hypot(m.x - two.x, m.y - two.y), Math.abs(scale - 1) * two.d);
    two.lastX = m.x;
    if (!two.mode) {
      if (Math.abs(scale - 1) > 0.12) two.mode = 'pinch';
      else if (Math.abs(m.x - two.x) > 36 && Math.abs(m.x - two.x) > 2 * Math.abs(m.y - two.y)) two.mode = 'swipe';
    }
    if (two.mode === 'pinch') {
      const f = pinchFont(two.font, scale);
      if (f !== font) { font = f; setFont(f); note(`Text size ${f}`, 900); }
    }
  }, { capture: true, passive: false });
  const twoEnd = (e: TouchEvent) => {
    if (!two) return;
    e.stopPropagation();
    if (e.touches.length >= 2) return;
    const g = two;
    two = null;
    if (g.mode === 'pinch') { try { localStorage.setItem(PHONE_FONT_KEY, String(font)); } catch { /* no storage */ } return; }
    if (g.mode === 'swipe') {
      const at = g.view.cycleTab(g.lastX < g.x ? 1 : -1);
      note(at.count > 1 ? `Terminal ${at.index} of ${at.count}` : 'One terminal is open. Tap with two fingers for another.');
      return;
    }
    if (e.type === 'touchend' && performance.now() - g.t < 450 && g.travel < 14) {
      g.view.newTab({ cwd: g.view.cwd() });
      const at = g.view.cycleTab(0);
      note(`Terminal ${at.index} of ${at.count}. Swipe sideways with two fingers to change.`, 2600);
    }
  };
  root.addEventListener('touchend', twoEnd, { capture: true });
  root.addEventListener('touchcancel', twoEnd, { capture: true });

  // ── Safe areas, and a browser whose scroll bars take no room ──
  const readInsets = (): boolean => {
    const p = h('div');
    p.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)';
    root.append(p);
    const cs = getComputedStyle(p);
    const now = { top: parseFloat(cs.paddingTop) || 0, right: parseFloat(cs.paddingRight) || 0, bottom: parseFloat(cs.paddingBottom) || 0, left: parseFloat(cs.paddingLeft) || 0 };
    p.remove();
    const was = layout.insets;
    layout.insets = now;
    return was.top !== now.top || was.right !== now.right || was.bottom !== now.bottom || was.left !== now.left;
  };
  const checkScrollBars = () => {
    const vp = layer.querySelector<HTMLElement>('.xterm-viewport');
    if (!vp || !vp.offsetWidth) return;
    const overlay = vp.offsetWidth - vp.clientWidth === 0;
    if (overlay !== root.classList.contains('sd-overlay-scroll')) {
      root.classList.toggle('sd-overlay-scroll', overlay);
      for (const t of ShiroTerminal.instances) { try { t.fitAddon.fit(); } catch { /* not on screen */ } }
    }
  };

  // ── What the window manager says ──
  wm.on('focus-changed', (w) => {
    if (!active || !deps.revealed() || switching) return;
    if (w) { if (atHome) showApp(); } else if (!atHome) showHome();
  });
  wm.on('window-created', (w) => {
    if (!active) return;
    // A Linux app's first window here: it was drawn for a large screen
    if (w && w.kind === 'surface' && isCard(w) && !w.options.transientFor && deps.revealed()) {
      let said = true;
      try { said = !!localStorage.getItem(GUI_NOTE_KEY); localStorage.setItem(GUI_NOTE_KEY, '1'); } catch { /* no storage */ }
      if (!said) note(`${appName(w)} was made for a large screen. It may be small here.`, 6000);
    }
    queueRender();
    requestAnimationFrame(checkScrollBars);
  });
  wm.on('window-closed', () => {
    if (!active) return;
    if (switching) paintCards();
    queueRender();
  });
  wm.on('theme-changed', () => { if (ctx.iconSet() === 'pixel') queueRender(); });
  ctx.onIconSet(() => queueRender());
  wm.launches.on(() => { if (switching) paintCards(); });
  window.addEventListener('resize', () => {
    if (!active) return;
    if (readInsets()) layout.relayout();
    if (switching) endSwitch(null);
    queueRender();
  });

  const ui: PhoneUI = {
    active: () => active,
    home: () => { if (active) onPill('home'); },
    refresh: queueRender,
    arrive(win) {
      if (!active) return;
      if (win && win.state !== 'closed') showApp(win); else showHome();
      requestAnimationFrame(checkScrollBars);
    },
    setActive(on, goHome) {
      if (on === active) return;
      active = on;
      if (on) {
        readInsets();
        root.append(back, home, pill);
        tools.append(...deps.status);
        font = phoneFont();
        setFont(font);
        syncOrder();
        if (goHome || !wm.focused()) showHome(); else showApp();
        render();
      } else {
        closeSheet();
        closeFolder();
        if (switching) { fromHome = false; endSwitch(null); }
        back.remove();
        home.remove();
        pill.remove();
        noteEl?.remove();
        deps.restoreStatus();
        root.classList.remove('sd-at-home', 'sd-overlay-scroll');
        setFont(null);
        atHome = false;
        // The desktop has a window in front again
        if (!wm.focused()) wm.visibleOrder().find((w) => w.state !== 'minimized')?.focus();
      }
    },
  };
  (ctx as AppContext & { phone?: PhoneUI }).phone = ui;
  return ui;
}
