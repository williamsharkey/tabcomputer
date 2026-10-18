/**
 * The apps this site ships (the folders of `apps/` with an `app.json`,
 * docs/APPS.md "Shipped apps"): each has an entry in the dock before it is
 * installed, so a person reaches it with a click and no terminal. The first
 * click installs the site's copy (curated: `/apps/<id>/`, checked against
 * `/apps/index.json`) and opens it; after that the entry is the installed
 * app's own.
 *
 * `app remove ID` takes the entry out and it stays out (localStorage
 * `tabcomputer-apps-hidden`) until the app is installed again.
 *
 * Small on purpose: the desktop loads this at boot, and the toolkit itself
 * (runtime, frames, the installer) only when an app is asked for.
 */
import type { DesktopWindow, WindowManager } from '../desktop/wm';
import { placeholderId, type Launch } from '../desktop/launch-state';

export interface ShippedApp { id: string; name: string; description: string; icon: string; glyph?: string }

/**
 * Dock glyphs for the icon sets other than Classic (docs/DESKTOP.md "Icon
 * sets"): path data on a 24-unit grid. Without one the dock shows a monogram.
 */
const GLYPHS: Record<string, string> = {
  // two arrows, one each way: a file goes in, another comes out
  converter: 'M5 9h13l-3.5-3.5M19 15H6l3.5 3.5',
};
/** The glyph of the site's own copy of a shipped app (the installed entry keeps it) */
export const shippedGlyph = (id: string): string | undefined => GLYPHS[id];

const MANIFESTS = import.meta.glob('../../apps/*/app.json', { import: 'default', eager: true }) as Record<string, { id?: string; name?: string; description?: string }>;
const ICONS = import.meta.glob('../../apps/*/public/icon.svg', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;

function dataUrl(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

const SHIPPED: ShippedApp[] = Object.entries(MANIFESTS).flatMap(([path, m]) => {
  const folder = path.split('/').slice(-2, -1)[0];
  if (!m || m.id !== folder || typeof m.name !== 'string') return [];
  const svg = ICONS[path.replace(/app\.json$/, 'public/icon.svg')];
  return [{ id: m.id, name: m.name, description: m.description ?? '', icon: svg ? dataUrl(svg) : '', glyph: GLYPHS[m.id] }];
}).sort((a, b) => a.id.localeCompare(b.id));

/** The apps this build ships, by id */
export const shippedApps = (): ShippedApp[] => SHIPPED;
export const isShipped = (id: string): boolean => SHIPPED.some((a) => a.id === id);

export const HIDDEN_KEY = 'tabcomputer-apps-hidden';

/** Shipped apps the person removed: they get no dock entry */
export function hiddenShipped(): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}

/** `app remove` hides a shipped app's entry; installing it again shows it */
export function setShippedHidden(id: string, hidden: boolean): void {
  if (!isShipped(id)) return;
  try {
    const list = hiddenShipped().filter((x) => x !== id);
    if (hidden) list.push(id);
    if (list.length) localStorage.setItem(HIDDEN_KEY, JSON.stringify(list)); else localStorage.removeItem(HIDDEN_KEY);
  } catch { /* no storage: the entry is back after a reload */ }
}

/**
 * Boot: a dock entry for each shipped app that is neither installed (the
 * registry's entry is there already) nor removed. `open` installs and opens
 * it; it is given the launch, asked for here before anything is awaited
 * (docs/DESKTOP.md "Launch feedback").
 */
export function registerShippedApps(wm: WindowManager, open: (app: ShippedApp, launch: Launch, args?: Record<string, unknown>) => Promise<DesktopWindow | null>): string[] {
  const hidden = new Set(hiddenShipped());
  const added: string[] = [];
  for (const app of SHIPPED) {
    if (hidden.has(app.id) || wm.apps().some((a) => a.id === app.id)) continue;
    added.push(app.id);
    wm.registerApp({
      id: app.id, name: app.name, icon: app.icon || undefined, glyph: app.glyph, order: 40, dock: true,
      remove: async () => {
        setShippedHidden(app.id, true);
        (wm as WindowManager & { unregisterApp?: (id: string) => void }).unregisterApp?.(app.id);
        return `${app.name} is out of the dock. The site's apps page (/apps) has it.`;
      },
      launch: (args) => {
        const r = wm.launches.request({
          id: app.id, name: app.name, icon: app.icon || undefined, placeholder: true,
          retry: () => { void wm.openApp(app.id, args); },
          onCancel: () => `${app.name} won't open.`,
        });
        if (!r.fresh) return wm.get(placeholderId(app.id)) ?? null;
        return open(app, r.launch, args);
      },
    });
  }
  return added;
}
