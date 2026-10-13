/**
 * The share screen (`app share ID`, the Share button of an app's window;
 * docs/APPS.md "Sharing"): the link, a Copy button, and what a person who
 * opens the link gets. The sentences are share.ts's `shareStatement`; the
 * terminal prints the same ones.
 *
 * The app's name is the only text from the app, and it goes in with
 * textContent.
 */
import type { DesktopAPI, DesktopWindow } from '../desktop/wm';
import { shareStatement, type AppShare } from './share';
import { overlay } from './surface';
import { QR_MAX_BYTES, qrCode, qrSvg } from '../qr';

const STYLE_ID = 'tc-app-share-style';
const CSS = `
.tc-app-share { box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; height: 100%; min-height: 0; padding: 16px; overflow: auto;
  font: 13px/1.5 var(--sd-font, system-ui, sans-serif); color: var(--sd-text, #e6e6f0); background: var(--sd-window, #1b1d29); }
.tc-app-share * { box-sizing: border-box; }
.tc-app-share h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.tc-app-share p { margin: 0; overflow-wrap: anywhere; }
.tc-app-share .tc-app-share-promise { font-size: 14px; }
.tc-app-share .tc-app-share-details { color: var(--sd-text-2, #a4a8b8); }
.tc-app-share textarea { flex: none; width: 100%; height: 64px; padding: 8px 10px; resize: none; overflow: auto; word-break: break-all;
  font: 12px/1.45 var(--sd-mono, ui-monospace, monospace); color: var(--sd-text, #e6e6f0); background: var(--sd-field, rgba(255, 255, 255, .06));
  border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 8px; }
.tc-app-share-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; flex: none; margin-top: auto; }
.tc-app-share-actions span { margin-right: auto; color: var(--sd-text-2, #a4a8b8); }
.tc-app-share-actions button { font: inherit; min-height: 32px; padding: 6px 16px; border-radius: 8px; cursor: pointer; color: inherit;
  background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-app-share-actions button:focus-visible { outline: 2px solid var(--sd-accent, #6e6aff); outline-offset: 1px; }
.tc-app-share-actions button[data-act=copy] { background: var(--sd-accent, #6e6aff); border-color: transparent; color: #fff; }
@media (pointer: coarse) { .tc-app-share-actions button { min-height: 44px; } }
.tc-app-share-qr { flex: none; display: flex; justify-content: center; }
.tc-app-share-qr svg { width: min(200px, 100%); height: auto; border-radius: 6px; }
`;

/** The screen's style, for a caller that shows the screen in a place of its own (the Studio) */
export function ensureShareStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

export interface ShareScreenOptions {
  /** The link as a QR code too, when it fits one (for a phone's camera) */
  qr?: boolean;
  /** Buttons of the caller's, before Close (the Studio's Save to a gist); `say` writes the status line */
  actions?: (say: (text: string) => void) => HTMLElement[];
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** What the screen shows: a link, or why this app has none */
export type ShareShown = AppShare | { name: string; problem: string; title?: string };

/** The screen's content. `copy` puts the link on the clipboard and says whether it did. */
export function buildShareScreen(share: ShareShown, copy: (text: string) => Promise<boolean>, close: () => void, opts: ShareScreenOptions = {}): HTMLElement {
  const root = el('div', '', 'tc-app-share');
  root.setAttribute('role', 'dialog');
  const title = ('problem' in share && share.title) || `Share ${share.name}`;
  root.setAttribute('aria-label', title);
  root.append(el('h3', title));
  const actions = el('div', '', 'tc-app-share-actions');
  const done = el('button', 'Close');
  done.type = 'button';
  done.dataset.act = 'close';
  done.addEventListener('click', close);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  if ('problem' in share) {
    root.append(el('p', share.problem), actions);
    actions.append(done);
    return root;
  }
  const { promise, details } = shareStatement(share);
  root.append(el('p', promise.join(' '), 'tc-app-share-promise'));
  const link = el('textarea');
  link.readOnly = true;
  link.value = share.url;
  link.setAttribute('aria-label', 'The link');
  link.addEventListener('focus', () => link.select());
  root.append(link);
  const code = opts.qr && new TextEncoder().encode(share.url).length <= QR_MAX_BYTES ? qrCode(share.url) : null;
  if (code) {
    const picture = el('div', '', 'tc-app-share-qr');
    picture.dataset.part = 'qr';
    // (the markup is qr.ts's own: modules as a path)
    picture.innerHTML = qrSvg(code, code.size > 77 ? 3 : 4);
    picture.firstElementChild!.setAttribute('aria-label', 'The link as a QR code');
    root.append(picture);
  }
  root.append(el('p', details.join(' '), 'tc-app-share-details'));
  const status = el('span');
  status.setAttribute('role', 'status');
  const copyBtn = el('button', 'Copy link');
  copyBtn.type = 'button';
  copyBtn.dataset.act = 'copy';
  copyBtn.addEventListener('click', () => {
    void copy(share.url).then((ok) => {
      status.textContent = ok ? 'Copied.' : 'The browser did not allow the copy. Select the link and copy it by hand.';
      if (!ok) { link.focus(); link.select(); }
    });
  });
  actions.append(status, ...(opts.actions?.((t) => { status.textContent = t; }) ?? []), done, copyBtn);
  root.append(actions);
  return root;
}

/** Show the share screen: a desktop window, or an overlay where there is no desktop (or the tab is an app) */
export function showShareScreen(share: ShareShown, wm: DesktopAPI | null, copy: (text: string) => Promise<boolean>): DesktopWindow | null {
  ensureShareStyle();
  let close = () => {};
  const content = buildShareScreen(share, copy, () => close());
  let win: DesktopWindow | null = null;
  if (wm) {
    const wa = wm.workArea();
    const w = win = wm.createWindow({
      appId: 'app-share', title: ('problem' in share && share.title) || `Share ${share.name}`, content: { kind: 'dom', element: content },
      width: Math.min(520, Math.max(280, wa.width - 40)), height: Math.min(330, Math.max(240, wa.height - 80)), minWidth: 280, minHeight: 220,
    });
    close = () => { w.close(true); };
    w.focus();
  } else close = overlay(content, { onBackdrop: () => close() });
  content.querySelector<HTMLButtonElement>('[data-act=copy], [data-act=close]')?.focus();
  return win;
}
