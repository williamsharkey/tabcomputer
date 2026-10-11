/**
 * Window layout across reloads: which desktop apps were open, where, and in
 * what state (a terminal's working directory, Files' folder, Settings' pane).
 * Saved to localStorage `tabcomputer-desktop-session` as windows change; restored
 * after the first prompt (the main terminal's own geometry is applied at boot).
 * The list is in stacking order, bottom to top, and marks the focused window:
 * the restore puts them back in that order and focuses it again.
 * Program windows (vim, htop, X11 apps) aren't restored: that would run them.
 */

import type { DesktopWindow, Geometry, WindowManager, WindowState } from './wm';

export const SESSION_KEY = 'tabcomputer-desktop-session';
const RESTORABLE = new Set(['terminal', 'files', 'settings', 'activity', 'about']);

export interface SavedWindow {
  id: string;
  app: string;
  g: Geometry;
  state: WindowState;
  cwd?: string;
  path?: string;
  pane?: string;
  /** It had the keyboard focus. */
  focused?: boolean;
}

export function loadSession(): SavedWindow[] {
  try {
    const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
    return Array.isArray(s?.windows) ? s.windows.filter((w: SavedWindow) => w && RESTORABLE.has(w.app) && w.g) : [];
  } catch { return []; }
}

function describe(w: DesktopWindow): SavedWindow | null {
  if (!w.appId || !RESTORABLE.has(w.appId) || w.state === 'closed' || w.options.override) return null;
  // A program running in a Terminal window (opened from the dock) has a fixed title: not restorable
  if (w.appId === 'terminal' && w.options.title && w.options.title !== 'Terminal') return null;
  const c = (w as { content?: any }).content;
  const out: SavedWindow = { id: w.id, app: w.appId, g: w.geometry(), state: w.state };
  if (w.focused) out.focused = true;
  if (typeof c?.cwd === 'function') out.cwd = c.cwd();
  if (typeof c?.path === 'function') out.path = c.path();
  if (typeof c?.pane === 'function') out.pane = c.pane();
  return out;
}

/** Keep the session saved as windows open, move and close. Returns stop. */
export function trackSession(wm: WindowManager): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    const windows = wm.windows().map(describe).filter((w): w is SavedWindow => !!w);
    try { localStorage.setItem(SESSION_KEY, JSON.stringify({ v: 1, windows })); } catch {}
  };
  const queue = () => { if (!timer) timer = setTimeout(save, 400); };
  const offs = (['window-created', 'window-closed', 'window-changed', 'focus-changed'] as const).map(ev => wm.on(ev, queue));
  window.addEventListener('pagehide', save);
  return () => { offs.forEach(o => o()); window.removeEventListener('pagehide', save); if (timer) clearTimeout(timer); };
}

/** Put a window where it was: geometry, then a maximized/snapped/minimized state. */
export function place(w: DesktopWindow, s: SavedWindow, wa: Geometry): void {
  // Only geometry that still fits on this screen
  if (s.g.width <= wa.width && s.g.x < wa.width - 40 && s.g.y < wa.height - 40) w.setGeometry(s.g);
  if (s.state === 'maximized') w.maximize();
  else if (s.state.startsWith('snapped-')) w.snap(s.state.slice('snapped-'.length) as Parameters<DesktopWindow['snap']>[0]);
  else if (s.state === 'minimized') w.minimize();
}

/**
 * Reopen the saved windows other than the main terminal, then stack all of
 * them (the main terminal too) as they were. Returns the window that had the
 * focus, for the caller to focus once the desktop shows (null: none saved).
 */
export async function restoreSession(wm: WindowManager, saved: SavedWindow[], openTerminal: (o: { cwd?: string }) => DesktopWindow | null): Promise<DesktopWindow | null> {
  const placed: [SavedWindow, DesktopWindow][] = [];
  for (const s of saved) {
    if (s.id === 'terminal') { const t = wm.get('terminal'); if (t) placed.push([s, t]); continue; }
    let w: DesktopWindow | null = null;
    try {
      if (s.app === 'terminal') w = openTerminal({ cwd: s.cwd || '/home/user' });
      else w = await wm.openApp(s.app, { newWindow: true, ...(s.path ? { path: s.path } : {}), ...(s.pane ? { pane: s.pane } : {}) });
    } catch (e) { console.warn('[desktop] restore', s.app, e); }
    if (w) { place(w, s, wm.workArea()); placed.push([s, w]); }
  }
  // Opening focused (raised) each window in turn, after the main terminal: restack bottom to top
  for (const [s, w] of placed) if (s.state !== 'minimized' && w.state !== 'closed') w.focus();
  return placed.find(([s, w]) => s.focused && w.state !== 'closed' && w.state !== 'minimized')?.[1] ?? null;
}
