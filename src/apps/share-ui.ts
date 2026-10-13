/**
 * The share screen (`app share ID`, docs/APPS.md "Sharing"): the link, a Copy
 * button, and what a person who opens the link gets. The sentences are
 * share.ts's `shareStatement`; the terminal prints the same ones.
 *
 * The app's name is the only text from the app, and it goes in with
 * textContent.
 */
import type { DesktopAPI, DesktopWindow } from '../desktop/wm';
import { shareStatement, type AppShare } from './share';

const STYLE_ID = 'tc-app-share-style';
const CSS = `
.tc-app-share { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 14px 16px; overflow: auto;
  font: 13px/1.45 var(--sd-font, system-ui, sans-serif); color: var(--sd-text, #e6e6f0); background: var(--sd-window, #1b1d29); }
.tc-app-share * { box-sizing: border-box; }
.tc-app-share h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.tc-app-share ul { margin: 0; padding: 0 0 0 18px; display: grid; gap: 4px; }
.tc-app-share .tc-app-share-promise { font-size: 14px; }
.tc-app-share .tc-app-share-details { color: var(--sd-text-2, #a4a8b8); }
.tc-app-share textarea { flex: none; width: 100%; height: 64px; padding: 8px 10px; resize: none; overflow: auto; word-break: break-all;
  font: 12px/1.45 var(--sd-mono, ui-monospace, monospace); color: var(--sd-text, #e6e6f0); background: var(--sd-field, rgba(255, 255, 255, .06));
  border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 8px; }
.tc-app-share-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; flex: none; margin-top: auto; }
.tc-app-share-actions span { margin-right: auto; color: var(--sd-text-2, #a4a8b8); }
.tc-app-share-actions button { font: inherit; padding: 6px 16px; border-radius: 8px; cursor: pointer; color: inherit;
  background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-app-share-actions button:focus-visible { outline: 2px solid var(--sd-accent, #6e6aff); outline-offset: 1px; }
.tc-app-share-actions button[data-act=copy] { background: var(--sd-accent, #6e6aff); border-color: transparent; color: #fff; }
.tc-app-share-overlay { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 12px; background: rgba(0, 0, 0, .5); }
.tc-app-share-overlay .tc-app-share { width: min(560px, 100%); height: auto; max-height: 100%; border: 1px solid #3d3d5c; border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, .4); }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The screen's content. `copy` puts the link on the clipboard and says whether it did. */
export function buildShareScreen(share: AppShare, copy: (text: string) => Promise<boolean>, close: () => void): HTMLElement {
  const root = el('div', '', 'tc-app-share');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Share an app');
  root.append(el('h3', `Share ${share.name} as a link`));
  const { promise, details } = shareStatement(share);
  const top = el('ul', '', 'tc-app-share-promise');
  for (const line of promise) top.append(el('li', line));
  root.append(top);
  const link = el('textarea');
  link.readOnly = true;
  link.value = share.url;
  link.setAttribute('aria-label', 'The link');
  link.addEventListener('focus', () => link.select());
  root.append(link);
  const more = el('ul', '', 'tc-app-share-details');
  for (const line of details) more.append(el('li', line));
  root.append(more);
  const actions = el('div', '', 'tc-app-share-actions');
  const status = el('span');
  status.setAttribute('role', 'status');
  const done = el('button', 'Close');
  done.type = 'button';
  done.dataset.act = 'close';
  done.addEventListener('click', close);
  const copyBtn = el('button', 'Copy link');
  copyBtn.type = 'button';
  copyBtn.dataset.act = 'copy';
  copyBtn.addEventListener('click', () => {
    void copy(share.url).then((ok) => {
      status.textContent = ok ? 'The link is copied.' : 'The browser did not allow the copy. Select the link and copy it by hand.';
      if (!ok) { link.focus(); link.select(); }
    });
  });
  actions.append(status, done, copyBtn);
  root.append(actions);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  return root;
}

/** Show the share screen: a desktop window, or an overlay where there is no desktop */
export function showShareScreen(share: AppShare, wm: DesktopAPI | null, copy: (text: string) => Promise<boolean>): DesktopWindow | null {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let close = () => {};
  const content = buildShareScreen(share, copy, () => close());
  let win: DesktopWindow | null = null;
  if (wm) {
    const wa = wm.workArea();
    const w = win = wm.createWindow({
      appId: 'app-share', title: `Share ${share.name}`, content: { kind: 'dom', element: content },
      width: Math.min(560, Math.max(280, wa.width - 40)), height: Math.min(470, Math.max(260, wa.height - 80)), minWidth: 280, minHeight: 240,
    });
    close = () => { w.close(true); };
    w.focus();
  } else {
    const overlay = el('div', '', 'tc-app-share-overlay');
    overlay.append(content);
    document.body.appendChild(overlay);
    close = () => overlay.remove();
  }
  content.querySelector<HTMLButtonElement>('[data-act=copy]')?.focus();
  return win;
}
