/**
 * Which layout the desktop shows: its windows, dock and menu bar, or the
 * phone layout (docs/DESKTOP.md "Phone layout"): a home screen of apps and
 * one app on the whole screen.
 *
 * The rule: a phone is a touched screen whose short side is under 500 CSS px,
 * or any viewport under 600 px wide (a narrow browser window too). A tablet
 * (short side 600 or more) keeps the desktop, upright as well. `?ui=phone`
 * and `?ui=desktop` choose for the page that carries them; Settings →
 * Appearance → Layout chooses and remembers (localStorage
 * `tabcomputer-layout`).
 *
 * No imports: the toolkit's prompts ask this without loading the desktop.
 */

export type LayoutChoice = 'auto' | 'phone' | 'desktop';
export const LAYOUT_KEY = 'tabcomputer-layout';

export interface ScreenInfo {
  /** The viewport, CSS px */
  width: number;
  height: number;
  /** The pointer is a finger */
  coarse: boolean;
  /** The screen's short side (the on-screen keyboard does not change it); 0 or absent: unknown */
  screenShort?: number;
}

/** Does this screen get the phone layout? */
export function phoneFor(s: ScreenInfo, choice: LayoutChoice = 'auto'): boolean {
  if (choice !== 'auto') return choice === 'phone';
  const short = Math.min(s.width, s.height);
  // A tablet, upright too
  if (short >= 600) return false;
  // A phone upright, or a narrow window on a desktop
  if (s.width < 600) return true;
  // A phone on its side. (A tablet's viewport is short while its keyboard is up; its screen is not.)
  return s.coarse && short < 500 && (!s.screenShort || s.screenShort < 500);
}

/** The choice in force: the address's `?ui=`, else the saved setting, else the rule */
export function layoutChoice(search: string = typeof location === 'undefined' ? '' : location.search): LayoutChoice {
  const asked = new URLSearchParams(search).get('ui');
  if (asked === 'phone' || asked === 'desktop') return asked;
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved === 'phone' || saved === 'desktop') return saved;
  } catch { /* no storage */ }
  return 'auto';
}

/** The saved setting alone (Settings shows it) */
export function savedLayout(): LayoutChoice {
  try {
    const saved = localStorage.getItem(LAYOUT_KEY);
    if (saved === 'phone' || saved === 'desktop') return saved;
  } catch { /* no storage */ }
  return 'auto';
}

const listeners = new Set<() => void>();

/** Settings: choose a layout (or leave it to the rule). The desktop switches at once. */
export function setLayoutChoice(c: LayoutChoice): void {
  try { if (c === 'auto') localStorage.removeItem(LAYOUT_KEY); else localStorage.setItem(LAYOUT_KEY, c); } catch { /* no storage */ }
  for (const cb of listeners) cb();
}

export function onLayoutChoice(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** The page's own screen, now */
export function phoneLayoutNow(): boolean {
  if (typeof window === 'undefined') return false;
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const screenShort = typeof screen === 'object' && screen ? Math.min(screen.width, screen.height) : 0;
  return phoneFor({ width: window.innerWidth, height: window.innerHeight, coarse, screenShort }, layoutChoice());
}
