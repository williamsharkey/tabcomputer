/**
 * What the toolkit shows outside the desktop's own element: the tab in app
 * mode, and a prompt or the share screen over the page. The desktop's colors
 * are not in scope there, so `surface` gives the ones the toolkit's styles
 * use, in the appearance apps follow: the desktop's where there is one, else
 * the browser's.
 *
 * On a phone a prompt is such a surface too, and fills the screen: there is
 * no room for a desktop around a question.
 */

type Theme = 'light' | 'dark';
interface ThemedDesktop { theme(): Theme; on(ev: 'theme-changed', cb: () => void): () => void; compact?: boolean }
const desktop = (): ThemedDesktop | undefined => (globalThis as { __shiroDesktop?: ThemedDesktop }).__shiroDesktop;

/** The appearance apps and prompts follow, and a call when it changes */
export const appTheme = {
  get(): Theme {
    const wm = desktop();
    if (wm) return wm.theme();
    return typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  },
  on(cb: () => void): () => void {
    const wm = desktop();
    if (wm) return wm.on('theme-changed', cb);
    if (typeof matchMedia !== 'function') return () => {};
    const q = matchMedia('(prefers-color-scheme: light)');
    q.addEventListener('change', cb);
    return () => q.removeEventListener('change', cb);
  },
};

/**
 * A phone: the desktop's compact layout (wm.ts `compactViewport`, repeated
 * here so that a prompt does not load the desktop) on a screen that is
 * touched. An app link opens as the app there, and a prompt fills the screen.
 */
export function phoneScreen(): boolean {
  if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) return false;
  if (window.innerWidth <= 640) return true;
  const s = typeof screen === 'object' ? Math.min(screen.width, screen.height) : 0;
  return s > 0 && s <= 500 && window.innerHeight <= 500;
}

const STYLE_ID = 'tc-surface-style';
const CSS = `
.tc-surface { --sd-text: #e6e6f0; --sd-text-2: #a4a8b8; --sd-window: #1b1d29; --sd-field: rgba(255, 255, 255, .06); --sd-sep: rgba(255, 255, 255, .12); --sd-accent: #6e6aff; }
.tc-surface[data-tc-theme=light] { --sd-text: #1c1d26; --sd-text-2: #555a6b; --sd-window: #fbfbfd; --sd-field: rgba(0, 0, 0, .045); --sd-sep: rgba(0, 0, 0, .14); }
.tc-overlay { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center; justify-content: center; padding: 12px; background: rgba(0, 0, 0, .5); }
.tc-overlay > * { width: min(600px, 100%); height: auto; max-height: 100%; border: 1px solid var(--sd-sep); border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, .4); }
.tc-overlay.tc-full { padding: 0; background: var(--sd-window); }
.tc-overlay.tc-full > * { width: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; font-size: 15px;
  padding: max(20px, env(safe-area-inset-top)) 18px max(18px, env(safe-area-inset-bottom)); }
.tc-overlay.tc-full button { min-height: 44px; }
`;

/** Give `el` those colors and keep them in step with the appearance. Returns stop. */
export function surface(el: HTMLElement): () => void {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  el.classList.add('tc-surface');
  const set = () => { el.dataset.tcTheme = appTheme.get(); };
  set();
  return appTheme.on(set);
}

/**
 * `content` over the page: a card in the middle, or the whole screen with
 * `full` (a prompt on a phone). Returns what takes it away.
 */
export function overlay(content: HTMLElement, opts: { full?: boolean; onBackdrop?: () => void } = {}): () => void {
  const box = document.createElement('div');
  box.className = opts.full ? 'tc-overlay tc-full' : 'tc-overlay';
  const off = surface(box);
  box.append(content);
  if (opts.onBackdrop) box.addEventListener('pointerdown', (e) => { if (e.target === box) opts.onBackdrop!(); });
  document.body.appendChild(box);
  return () => { off(); box.remove(); };
}
