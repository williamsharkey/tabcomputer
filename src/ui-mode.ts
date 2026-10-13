/**
 * Which UI the page boots: the desktop (src/desktop, the Unix edition) or
 * shiro.computer's full-page terminal.
 *
 * `?ui=desktop` / `?ui=terminal` choose and remember (localStorage
 * `tabcomputer-ui`). `?ui=phone` is the desktop in its phone layout, and
 * `?ui=desktop` its windowed one, whatever the screen (src/phone-rule.ts). Embedded pages (seeds), `?demo=1` and app ("become") mode
 * always use the terminal, and so does safe mode. Otherwise the product profile decides
 * (src/profile.ts): shiro.computer and its subdomains get the terminal, every
 * other host (tabcomputer.com, localhost) the desktop.
 */
import { selectProfile } from './profile';
import { isSafeMode } from './safe-mode';
import { phoneLayoutNow } from './phone-rule';

export type UiMode = 'desktop' | 'terminal';

export const UI_MODE_KEY = 'tabcomputer-ui';

/** The app an earlier build's phone app link left this tab as: the desktop's phone layout opens it (main.ts) */
export const PHONE_APP_KEY = 'tabcomputer-phone-app';

/**
 * An app link on a phone used to make the tab the app, with a bar back to the
 * desktop (src/apps/window.ts `becomeApp`, `back`). The phone layout shows an
 * app on the whole screen with its pill instead: such a tab is the desktop
 * again, and the app is noted for main.ts to open in it. True when it was one.
 */
function phoneAppLink(): boolean {
  try {
    const cfg = JSON.parse(localStorage.getItem('tabcomputer-become') || 'null');
    if (!cfg?.back || typeof cfg.app !== 'string' || localStorage.getItem(UI_MODE_KEY) === 'terminal' || !phoneLayoutNow()) return false;
    sessionStorage.setItem(PHONE_APP_KEY, cfg.app);
    localStorage.removeItem('tabcomputer-become');
    return true;
  } catch { return false; }
}

export function uiMode(loc: Pick<Location, 'search' | 'hostname'> = location, embedded = window.parent !== window): UiMode {
  const q = new URLSearchParams(loc.search);
  // Safe mode (src/safe-mode.ts): the terminal, without the desktop's saved windows
  if (typeof location !== 'undefined' && loc === location && isSafeMode()) return 'terminal';
  const asked = q.get('ui');
  if (asked === 'desktop' || asked === 'terminal') {
    try { localStorage.setItem(UI_MODE_KEY, asked); } catch {}
    return asked;
  }
  // The phone layout is the desktop's (src/phone-rule.ts reads the same parameter)
  if (asked === 'phone') {
    try { localStorage.setItem(UI_MODE_KEY, 'desktop'); } catch {}
    return 'desktop';
  }
  if (q.get('demo') === '1' || embedded) return 'terminal';
  // (`?unbecome` is leaving app mode on this very load: back to whatever the UI was)
  try { if (localStorage.getItem('tabcomputer-become') && !q.has('unbecome') && !phoneAppLink()) return 'terminal'; } catch {}
  try {
    const saved = localStorage.getItem(UI_MODE_KEY);
    if (saved === 'desktop' || saved === 'terminal') return saved;
  } catch {}
  return selectProfile(loc).ui;
}
