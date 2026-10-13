/**
 * Debian GUI apps on the desktop (src/gui/apps.ts). The dock's "Apps" entry
 * opens the Apps window (apps-sheet.ts), which lists them with sizes and
 * installs them; installed apps get their own dock icons. Opening an app
 * (`openApp`) goes through launch.ts: its dock icon shows it is starting and
 * a placeholder window says what stage it is in (installing first when it
 * isn't installed) until its own window appears.
 * Its X windows carry the app's id, so later clicks focus them.
 */
import type { DesktopAPI } from '../desktop/wm';
import { startGuiApp } from './launch';
import type { FileSystem } from '../filesystem';
import type { Kernel } from '../kernel/kernel';
import type { SheetApp } from './apps-sheet';

/** id, name, icon (public/gui/icons/, from the package: gen-apps.py) or a glyph, listed in the Apps window, note */
const APPS: [string, string, string, boolean, string?][] = [
  ['l3afpad', 'L3afpad', 'gui/icons/l3afpad.png', true],
  ['mousepad', 'Mousepad', 'gui/icons/mousepad.png', true],
  ['featherpad', 'FeatherPad', 'gui/icons/featherpad.svg', true],
  ['ristretto', 'Ristretto', 'gui/icons/ristretto.png', true],
  ['gpicview', 'GPicView', 'gui/icons/gpicview.png', true],
  // (GIMP's first start is like any other since its plug-in registry and babl's cache ship with it: docs/GUI_LAUNCH.md)
  ['gimp', 'GIMP', 'gui/icons/gimp.png', true, 'takes a while to start'],
  ['inkscape', 'Inkscape', 'gui/icons/inkscape.svg', true, 'first start takes a few minutes'],
  ['dillo', 'Dillo', 'gui/icons/dillo.png', true],
  ['netsurf', 'NetSurf', 'gui/icons/netsurf.png', true],
  ['gedit', 'Text Editor (gedit)', 'gui/icons/gedit.svg', true],
  ['evince', 'Document Viewer', 'gui/icons/evince.svg', true],
  ['eog', 'Image Viewer (eog)', 'gui/icons/eog.svg', true],
  ['qpdfview', 'qpdfview', 'gui/icons/qpdfview.svg', true],
  ['krita', 'Krita', 'gui/icons/krita.png', true, 'first start takes a minute'],
  ['thunar', 'Thunar', 'gui/icons/thunar.png', true],
  ['pcmanfm', 'PCManFM', '▤', true],
  ['galculator', 'Galculator', 'gui/icons/galculator.svg', true],
  ['kcalc', 'KCalc', '∑', true],
  ['gnumeric', 'Gnumeric', 'gui/icons/gnumeric.png', true],
  ['abiword', 'AbiWord', 'gui/icons/abiword.png', true],
  ['keepassxc', 'KeePassXC', 'gui/icons/keepassxc.svg', true],
  ['audacity', 'Audacity', '♫', true, 'first start takes a minute'],
  ['firefox-esr', 'Firefox ESR', 'gui/icons/firefox-esr.png', true, 'first start takes a few minutes'],
  ['libreoffice-writer', 'LibreOffice Writer', 'W', true, 'first start takes a few minutes'],
  ['thunderbird', 'Thunderbird', 'gui/icons/thunderbird.png', true, 'first start takes a few minutes'],
  ['pidgin', 'Pidgin', 'gui/icons/pidgin.svg', true],
  ['hexchat', 'HexChat', 'gui/icons/hexchat.svg', true],
  ['audacious', 'Audacious', 'gui/icons/audacious.svg', true],
  ['shotwell', 'Shotwell', 'gui/icons/shotwell.png', true],
  ['simple-scan', 'Document Scanner', 'gui/icons/simple-scan.svg', true],
  ['xournalpp', 'Xournal++', 'gui/icons/xournalpp.svg', true],
  ['zathura', 'Zathura', 'gui/icons/zathura.png', true],
  ['geany', 'Geany', 'gui/icons/geany.svg', true],
  ['xterm', 'XTerm', 'gui/icons/xterm.svg', true],
  ['qterminal', 'QTerminal', '›_', true],
  ['xeyes', 'xeyes', '◉', true],
  ['xclock', 'xclock', '◷', true],
  ['xcalc', 'xcalc', '±', true],
  ['xedit', 'xedit', '✎', true],
  ['lximage-qt', 'LXImage-Qt', 'gui/icons/lximage-qt.png', true],
];

function glyphIcon(glyph: string, hue: number): string {
  return `<svg viewBox="0 0 48 48" xmlns="http://www.w3.org/2000/svg"><rect x="4" y="4" width="40" height="40" rx="10" fill="hsl(${hue} 45% 42%)"/>` +
    `<text x="24" y="31" font-size="20" text-anchor="middle" fill="#fff" font-family="sans-serif">${glyph}</text></svg>`;
}

/** The Apps entry: a tile like the desktop's own icons (icons.ts) with a grid of apps */
const APPS_ICON = `<span class="sd-tile" style="--t1:#5b8cff;--t2:#7a4dff"><svg viewBox="3 3 58 58" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">` +
  [0, 1, 2].flatMap((r) => [0, 1, 2].map((c) => `<rect x="${15 + c * 12.5}" y="${15 + r * 12.5}" width="9" height="9" rx="2.6" fill="#fff" fill-opacity="${r === 1 && c === 1 ? 1 : 0.86}"/>`)).join('') +
  `</svg></span>`;

/** Registers the apps; resolves once the installed ones are in the dock */
export function registerGuiApps(wm: DesktopAPI, fs: FileSystem, kernel: Kernel): Promise<void> {
  const icons = APPS.map(([, , icon], i) => icon.includes('/') ? icon : glyphIcon(icon, (i * 47) % 360));
  const register = (installed: Set<string>) => APPS.forEach(([id, name, , , note], i) => {
    wm.registerApp({
      id, name, dock: installed.has(id), order: 60 + i, icon: icons[i],
      // Asked for before anything is awaited (wm.openApp sees the launch); its window comes later
      launch: () => {
        void startGuiApp(fs, kernel, id, { name, icon: icons[i], note, installed: () => void refresh() })
          .catch((e) => console.warn('[gui]', id, e));
        return null;
      },
    });
  });
  const refresh = async () => {
    // nothing installed yet (no GUI app status, no dpkg): no need to load the installer
    if (!(await fs.exists('/var/lib/shiro-gui/status.json').catch(() => false)) && !(await fs.exists('/var/lib/dpkg/status').catch(() => false))) return register(new Set());
    const apps = await import('./apps');
    const installed = new Set<string>();
    for (const [id] of APPS) if (await apps.isAppInstalled(fs, id).catch(() => false)) installed.add(id);
    register(installed);
  };
  const sheet: SheetApp[] = APPS.filter((a) => a[3]).map(([id, name, , , note]) => ({ id, name, icon: icons[APPS.findIndex((a) => a[0] === id)], note }));
  wm.registerApp({
    id: 'apps', name: 'Apps', icon: APPS_ICON, order: 19,
    launch: async () => (await import('./apps-sheet')).openAppsSheet(wm, fs, kernel, sheet, () => void refresh()),
  });
  register(new Set());
  // installs from the shell (`gui install`) too
  fs.onChange((_ev, path) => { if (path === '/var/lib/shiro-gui/status.json') void refresh(); });
  return refresh();
}
