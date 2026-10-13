/**
 * Phones and tablets (coarse pointer): the desktop follows the *visual*
 * viewport, which shrinks when the on-screen keyboard opens (iOS Safari keeps
 * the layout viewport and scrolls it). Keyboard open: the dock hides, windows
 * and the terminal relayout above the keyboard, the key bar hides unless it
 * is pinned. Changes crossfade (0.3 s, View Transitions; instant with
 * prefers-reduced-motion).
 *
 * The key bar: the keys the iOS keyboard makes awkward, in two rows of nine
 * that fit a 375 px screen. Ctrl and Alt are one-shot modifiers that also
 * apply to the next letter typed on the system keyboard. Mode (localStorage
 * `tabcomputer-keybar`): 'auto' (shown, hides while the keyboard is open), 'pinned'
 * (also above the keyboard), 'off'. The menu bar's keyboard button toggles it.
 * In every mode it shows only while a terminal has the focus: its keys go to
 * a terminal, and under an app's window they are noise (tabcomputer#139).
 *
 * The phone layout (docs/DESKTOP.md "Phone layout") differs: the page keeps
 * the height it has without the keyboard, so a terminal keeps its rows and
 * columns when the keyboard opens (tabcomputer#146); the windows move up just
 * far enough that the cursor's line shows above the keyboard. The keys are one
 * row that scrolls sideways, on top of the keyboard, there only while it is up.
 *
 * Loaded only on touch devices; the classic terminal UI keeps
 * src/mobile-input.ts.
 */

import { getActiveTerminal } from '../active-terminal';
import type { AppContext, DesktopLayout } from './index';

export type KeybarMode = 'auto' | 'pinned' | 'off';
export const KEYBAR_KEY = 'tabcomputer-keybar';
const KEYBOARD_MIN = 120; // px of viewport lost before we call it a keyboard

export function keybarMode(): KeybarMode {
  try {
    const m = localStorage.getItem(KEYBAR_KEY);
    return m === 'pinned' || m === 'off' ? m : 'auto';
  } catch { return 'auto'; }
}

const modeListeners = new Set<(m: KeybarMode) => void>();
export function setKeybarMode(m: KeybarMode): void {
  try { localStorage.setItem(KEYBAR_KEY, m); } catch {}
  for (const cb of modeListeners) cb(m);
}
export function onKeybarMode(cb: (m: KeybarMode) => void): () => void {
  modeListeners.add(cb);
  return () => { modeListeners.delete(cb); };
}

interface Key { label: string; data?: string; mod?: 'ctrl' | 'alt'; act?: 'paste' | 'hide'; aria?: string; wide?: boolean }

/** Row 1: Esc Tab Ctrl Alt | ~ `  ↑  hide.  Row 2: Paste / - $ & ;  ← ↓ → */
export const KEY_ROWS: Key[][] = [
  [
    { label: 'esc', data: '\x1b', aria: 'Escape' }, { label: 'tab', data: '\t', aria: 'Tab' },
    { label: 'ctrl', mod: 'ctrl', aria: 'Control' }, { label: 'alt', mod: 'alt', aria: 'Alt' },
    { label: '|', data: '|' }, { label: '~', data: '~' }, { label: '`', data: '`' },
    { label: '↑', data: '\x1b[A', aria: 'Up' }, { label: '⌄', act: 'hide', aria: 'Hide keys' },
  ],
  [
    { label: '⎘', act: 'paste', aria: 'Paste' }, { label: '/', data: '/' }, { label: '-', data: '-' },
    { label: '$', data: '$' }, { label: '&', data: '&' }, { label: ';', data: ';' },
    { label: '←', data: '\x1b[D', aria: 'Left' }, { label: '↓', data: '\x1b[B', aria: 'Down' }, { label: '→', data: '\x1b[C', aria: 'Right' },
  ],
];

/** The phone layout's one row: Esc Tab Ctrl Alt, the arrows, then the symbols, then paste */
export const PHONE_KEYS: Key[] = [
  KEY_ROWS[0][0], KEY_ROWS[0][1], KEY_ROWS[0][2], KEY_ROWS[0][3],
  KEY_ROWS[1][6], KEY_ROWS[1][7], KEY_ROWS[0][7], KEY_ROWS[1][8],
  KEY_ROWS[0][4], KEY_ROWS[0][5], KEY_ROWS[1][1], KEY_ROWS[1][2], KEY_ROWS[1][3], KEY_ROWS[1][4], KEY_ROWS[1][5], KEY_ROWS[0][6],
  KEY_ROWS[1][0],
];

function inject(data: string): void {
  (getActiveTerminal() ?? (globalThis as any).__tabcomputer?.terminal)?.injectInput?.(data);
}

/** A control character for a letter (Ctrl+C → \x03); other characters unchanged. */
export function ctrlChar(ch: string): string {
  const c = ch.toUpperCase().charCodeAt(0);
  if (c >= 64 && c <= 95) return String.fromCharCode(c - 64);
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  return ch;
}

export function initMobile(ctx: AppContext, layout: DesktopLayout): void {
  const root = ctx.wm.root;
  root.classList.add('sd-touch');
  const vv = window.visualViewport;

  // ── Key bar ──
  const bar = document.createElement('div');
  bar.className = 'sd-keybar';
  bar.setAttribute('role', 'toolbar');
  bar.setAttribute('aria-label', 'Extra keys');
  let pending: 'ctrl' | 'alt' | null = null;
  const modBtns = new Map<string, HTMLButtonElement>();
  /** The rows the bar shows now: two of nine, or the phone layout's one */
  let builtFor: boolean | null = null;
  const build = (rows: Key[][]) => {
    bar.textContent = '';
    modBtns.clear();
    for (const row of rows) {
      const r = document.createElement('div');
      r.className = 'sd-keyrow';
      for (const k of row) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'sd-key' + (k.mod ? ' sd-key-mod' : '') + (k.act ? ' sd-key-act' : '');
        b.textContent = k.label;
        if (k.aria) b.setAttribute('aria-label', k.aria);
        if (k.mod) { modBtns.set(k.mod, b); b.classList.toggle('sd-on', pending === k.mod); }
        // pointerdown + preventDefault: the terminal keeps focus, so the iOS keyboard stays up
        // (the phone layout's row scrolls: there a key answers the tap that ends on it)
        b.addEventListener('pointerdown', (e) => { e.preventDefault(); if (!layout.phone) press(k); });
        b.addEventListener('click', (e) => { e.preventDefault(); if (layout.phone) press(k); });
        r.appendChild(b);
      }
      bar.appendChild(r);
    }
  };
  root.appendChild(bar);

  const setPending = (m: 'ctrl' | 'alt' | null) => {
    pending = m;
    for (const [id, b] of modBtns) b.classList.toggle('sd-on', id === m);
  };
  const press = (k: Key) => {
    if (k.mod) { setPending(pending === k.mod ? null : k.mod); return; }
    if (k.act === 'hide') { setKeybarMode('off'); return; }
    if (k.act === 'paste') {
      const t = getActiveTerminal() as any;
      navigator.clipboard?.readText?.().then((s) => { if (s) t?.term?.paste?.(s); }).catch(() => {
        const s = prompt('Paste text:');
        if (s) t?.term?.paste?.(s);
      });
      return;
    }
    let data = k.data ?? '';
    if (pending === 'ctrl') data = data.length === 1 ? ctrlChar(data) : data;
    else if (pending === 'alt') data = '\x1b' + data;
    setPending(null);
    inject(data);
  };
  // Ctrl/Alt also apply to the next character typed on the system keyboard
  document.addEventListener('beforeinput', (e) => {
    if (!pending) return;
    const ie = e as InputEvent;
    const t = e.target as HTMLElement | null;
    if (!t?.classList?.contains('xterm-helper-textarea') || !ie.data || ie.data.length !== 1) return;
    e.preventDefault();
    const ch = ie.data;
    const out = pending === 'ctrl' ? ctrlChar(ch) : '\x1b' + ch;
    setPending(null);
    inject(out);
  }, true);

  // ── Layout from the visual viewport ──
  // Safe-area insets come from CSS env(): read once through a probe's padding
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;visibility:hidden;padding-top:env(safe-area-inset-top)';
  root.appendChild(probe);
  layout.topInset = parseFloat(getComputedStyle(probe).paddingTop) || 0;
  probe.remove();
  let kbOpen = false;
  let mode = keybarMode();
  // A window that holds a terminal: Terminal's tabs, or anything else drawn with xterm
  const terminalFocused = () => !!ctx.wm.focused()?.element.querySelector('.sd-term, .xterm');
  const measure = () => {
    const h = vv ? vv.height : window.innerHeight;
    const top = vv ? vv.offsetTop : 0;
    return { h, top, kb: window.innerHeight - h > KEYBOARD_MIN };
  };
  // The phone layout: the height without the keyboard (per width, so a rotation starts over),
  // and how far the windows are moved up for the cursor
  let fullH = 0, fullW = 0, shift = 0;
  let followed: { dispose(): void } | null = null;
  let followQueued = false;
  /** Move the windows up just far enough that the cursor's line is above the keyboard and the key row */
  const follow = () => {
    followQueued = false;
    let want = 0;
    const t = getActiveTerminal() as any;
    const el: HTMLElement | undefined = t?.term?.element;
    const scr = layout.phone && kbOpen && el && ctx.wm.focused()?.element.contains(el) ? el.querySelector<HTMLElement>('.xterm-screen') : null;
    if (scr) {
      const r = scr.getBoundingClientRect();
      const cell = r.height / Math.max(1, t.term.rows);
      // (where the line is without the shift)
      const cursorBottom = r.top + shift + (t.term.buffer.active.cursorY + 1) * cell;
      const m = measure();
      want = Math.max(0, Math.ceil(cursorBottom - (m.top + m.h - (bar.hidden ? 0 : bar.offsetHeight) - 2)));
    }
    if (want !== shift) { shift = want; root.style.setProperty('--sd-kb-shift', `${shift}px`); }
  };
  /** Follow the cursor of the terminal in front while the keyboard is up */
  const watch = () => {
    followed?.dispose();
    followed = null;
    const t = getActiveTerminal() as any;
    if (layout.phone && kbOpen && t?.term?.onRender) followed = t.term.onRender(() => { if (!followQueued) { followQueued = true; requestAnimationFrame(follow); } });
    follow();
  };
  const applyPhone = (m: { h: number; top: number }) => {
    // A keyboard takes more than a toolbar does: anything less is the browser's own bars, and the height follows
    if (window.innerWidth !== fullW || fullH - m.h <= KEYBOARD_MIN) { fullW = window.innerWidth; fullH = Math.max(window.innerHeight, m.h); }
    kbOpen = fullH - m.h > KEYBOARD_MIN;
    root.style.top = '0px';
    root.style.height = `${fullH}px`;
    root.style.bottom = 'auto';
    const showBar = kbOpen && mode !== 'off' && terminalFocused();
    bar.hidden = !showBar;
    // On top of the keyboard: the bottom of what is visible
    bar.style.top = `${Math.round(m.top + m.h - (showBar ? bar.offsetHeight : 0))}px`;
    root.classList.toggle('sd-kb-open', kbOpen);
    if (kbOpen) root.style.setProperty('--sd-kb-visible', `${Math.max(120, Math.round(m.top + m.h - layout.insets.top))}px`);
    else root.style.removeProperty('--sd-kb-visible');
    layout.keybarH = 0;
    layout.dockHidden = false;
    layout.viewportH = fullH;
    layout.relayout();
    watch();
  };
  const apply = () => {
    if (builtFor !== layout.phone) {
      builtFor = layout.phone;
      build(layout.phone ? [PHONE_KEYS] : KEY_ROWS);
      if (!layout.phone) {
        bar.style.top = '';
        followed?.dispose();
        followed = null;
        shift = fullH = 0;
        root.style.removeProperty('--sd-kb-shift');
        root.style.removeProperty('--sd-kb-visible');
      }
    }
    const m = measure();
    if (layout.phone) { applyPhone(m); return; }
    kbOpen = m.kb;
    // The desktop occupies exactly what is visible
    root.style.top = `${m.top}px`;
    root.style.height = `${m.h}px`;
    root.style.bottom = 'auto';
    const showBar = terminalFocused() && (mode === 'pinned' || (mode === 'auto' && !kbOpen));
    bar.hidden = !showBar;
    root.classList.toggle('sd-kb-open', kbOpen);
    layout.keybarH = showBar ? bar.offsetHeight : 0;
    layout.dockHidden = kbOpen;
    layout.viewportH = m.h;
    layout.relayout();
    // Keep the cursor line in view above the keyboard
    requestAnimationFrame(() => (getActiveTerminal() as any)?.term?.scrollToBottom?.());
  };
  layout.refresh = () => apply();
  // Keyboard open/close: crossfade old and new layout (0.3 s), no animated movement
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const transition = (fn: () => void) => {
    const d = document as any;
    if (typeof d.startViewTransition !== 'function' || reduced()) { fn(); return; }
    try { d.startViewTransition(fn); } catch { fn(); }
  };
  let last = measure();
  const onViewport = () => {
    const m = measure();
    // (the phone layout moves nothing but the key row: no crossfade)
    if (m.kb !== last.kb && !layout.phone) transition(apply);
    else apply();
    last = m;
  };
  vv?.addEventListener('resize', onViewport);
  vv?.addEventListener('scroll', onViewport);
  window.addEventListener('orientationchange', () => setTimeout(apply, 300));
  onKeybarMode((m) => { mode = m; transition(apply); });
  let barFor = terminalFocused();
  const onFocus = () => {
    if (terminalFocused() !== barFor) { barFor = !barFor; apply(); }
    else if (layout.phone && kbOpen) watch();
  };
  ctx.wm.on('focus-changed', onFocus);
  ctx.wm.on('window-closed', onFocus);
  apply();
}
