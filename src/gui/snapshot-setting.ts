/**
 * Whether started GUI apps are kept as snapshots (src/gui/snapshot.ts,
 * docs/research/GUI_SNAPSHOTS.md). Small on purpose: the launcher and the X
 * session read it without loading the snapshot code.
 *
 *   localStorage `tabcomputer-gui-snapshots`: `0` off, `1` on for every app,
 *     unset the default
 *   TABCOMPUTER_GUI_SNAPSHOTS=0 (exported in ~/.profile): off
 *
 * The default is on for the apps `tests/browser/gui-snapshot.mjs` restores
 * and uses, in the browsers and on the machines it has run on: a Chromium
 * browser that is not a phone's, with 4 GB of memory or more. Everywhere
 * else an app starts the usual way unless the setting is `1`.
 */
import { isSafeMode } from '../safe-mode';

export const SNAPSHOT_SETTING = 'tabcomputer-gui-snapshots';

/** The apps the test restores, uses and quits (docs/research/GUI_SNAPSHOTS.md "What works after a restore") */
export const SNAPSHOT_TESTED = new Set(['xeyes', 'xclock', 'dillo', 'gpicview', 'l3afpad', 'galculator', 'geany', 'mousepad', 'featherpad', 'inkscape', 'gimp']);

export type SnapshotMode = 'off' | 'tested' | 'all';

interface Nav { userAgentData?: { brands?: { brand: string }[]; mobile?: boolean }; deviceMemory?: number }

/** Where snapshots are on without being asked for */
export function snapshotDefaultOn(nav: Nav | undefined = (globalThis as { navigator?: Nav }).navigator): boolean {
  const ua = nav?.userAgentData;
  if (!ua?.brands?.some((b) => b.brand === 'Chromium') || ua.mobile) return false;
  return (nav?.deviceMemory ?? 0) >= 4;
}

function shellEnv(): Record<string, string | undefined> {
  return (globalThis as { __tabcomputer?: { shell?: { env?: Record<string, string | undefined> } } }).__tabcomputer?.shell?.env ?? {};
}


export function snapshotMode(o: { stored?: string | null; env?: Record<string, string | undefined>; nav?: Nav; safe?: boolean } = {}): SnapshotMode {
  let stored = o.stored;
  if (stored === undefined) { try { stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(SNAPSHOT_SETTING) ?? null; } catch { stored = null; } }
  const env = (o.env ?? shellEnv()).TABCOMPUTER_GUI_SNAPSHOTS;
  if (stored === '0' || env === '0' || (o.safe ?? isSafeMode())) return 'off';
  if (stored === '1' || env === '1') return 'all';
  return snapshotDefaultOn(o.nav) ? 'tested' : 'off';
}

/** Snapshots are on for some app */
export const snapshotsOn = (): boolean => snapshotMode() !== 'off';

/** Snapshots are on for `app` */
export function snapshotsFor(app: string, mode: SnapshotMode = snapshotMode()): boolean {
  return mode === 'all' || (mode === 'tested' && SNAPSHOT_TESTED.has(app));
}

/** Whether Settings shows the switch: where snapshots are on unless turned off, or someone set the key by hand */
export function snapshotSwitchShown(): boolean {
  let stored: string | null = null;
  try { stored = (globalThis as { localStorage?: Storage }).localStorage?.getItem(SNAPSHOT_SETTING) ?? null; } catch { /* no storage */ }
  return snapshotDefaultOn() || stored !== null;
}

/** The switch in Settings: on is the default again, off is kept */
export function setSnapshotsEnabled(on: boolean): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (on) { if (ls?.getItem(SNAPSHOT_SETTING) === '0') ls.removeItem(SNAPSHOT_SETTING); } else ls?.setItem(SNAPSHOT_SETTING, '0');
  } catch { /* no storage: nothing is kept anyway */ }
}

// ── the apps someone starts: whose snapshot is worth taking again after a page load ──

const USED = 'tabcomputer-gui-snapshot-used';

/** `app` was started by the person now */
export function noteSnapshotApp(app: string, now = Date.now()): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    const used = JSON.parse(ls?.getItem(USED) ?? '{}') as Record<string, number>;
    used[app] = now;
    ls?.setItem(USED, JSON.stringify(used));
  } catch { /* not kept: its snapshot is not looked at after a page load */ }
}

const SIZES = 'tabcomputer-gui-snapshot-sizes';

/** The size of `app`'s image the last time a snapshot of it was taken (bytes of memory, not of storage) */
export function noteSnapshotSize(app: string, imageBytes: number): void {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    const sizes = JSON.parse(ls?.getItem(SIZES) ?? '{}') as Record<string, number>;
    sizes[app] = imageBytes;
    ls?.setItem(SIZES, JSON.stringify(sizes));
  } catch { /* not kept: a small machine then takes no snapshot of it in the background */ }
}
export function lastSnapshotSize(app: string): number | undefined {
  try {
    const n = (JSON.parse((globalThis as { localStorage?: Storage }).localStorage?.getItem(SIZES) ?? '{}') as Record<string, number>)[app];
    return typeof n === 'number' ? n : undefined;
  } catch { return undefined; }
}

/** The apps started in the last `within` ms, the most recent first */
export function recentSnapshotApps(within: number, now = Date.now()): string[] {
  try {
    const used = JSON.parse((globalThis as { localStorage?: Storage }).localStorage?.getItem(USED) ?? '{}') as Record<string, number>;
    return Object.entries(used).filter(([, t]) => typeof t === 'number' && t <= now + 60_000 && now - t < within).sort((a, b) => b[1] - a[1]).map(([app]) => app);
  } catch { return []; }
}
