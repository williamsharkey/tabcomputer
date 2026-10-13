/**
 * The Link window (`link`, System → "Share this setup as a link…";
 * docs/RUN_LINKS.md "link"): the script made from this tab's session, in a
 * box the person can change, with the line that says which form it fits, what
 * it downloaded here, what was left out, and the link with a Copy button.
 *
 * Nothing leaves the tab from here except by the person's own act: copying
 * the link, or, for a script too long for a link, the Make a gist button.
 * Everything from the session goes in as text.
 */
import type { DesktopAPI, DesktopWindow } from './desktop/wm';
import { buildLink, makeGist, type MadeLink } from './commands/link';
import { QR_MAX_BYTES, qrCode, qrSvg } from './qr';
import { overlay } from './apps/surface';

const STYLE_ID = 'tc-link-style';

const CSS = `
.tc-link { box-sizing: border-box; display: flex; flex-direction: column; gap: 8px; height: 100%; min-height: 0; padding: 14px 16px; overflow: auto;
  font: 13px/1.45 var(--sd-font, system-ui, sans-serif); color: var(--sd-text, #e6e6f0); background: var(--sd-window, #1b1d29); }
.tc-link * { box-sizing: border-box; }
.tc-link h3 { margin: 0; font-size: 15px; font-weight: 600; }
.tc-link p { margin: 0; color: var(--sd-text-2, #a4a8b8); overflow-wrap: anywhere; }
.tc-link p.tc-link-size { color: var(--sd-text, #e6e6f0); }
.tc-link p.tc-link-warn { color: var(--sd-text, #e6e6f0); font-weight: 600; }
.tc-link textarea { width: 100%; padding: 8px 10px; overflow: auto; tab-size: 4;
  font: 12px/1.5 var(--sd-mono, ui-monospace, monospace); color: var(--sd-text, #e6e6f0); background: var(--sd-field, rgba(255, 255, 255, .06));
  border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 8px; }
.tc-link textarea[data-part=script] { flex: 1 1 140px; min-height: 110px; resize: none; white-space: pre; }
.tc-link textarea[data-part=link] { flex: none; height: 54px; resize: none; word-break: break-all; }
.tc-link textarea:focus-visible, .tc-link button:focus-visible { outline: 2px solid var(--sd-accent, #6e6aff); outline-offset: 1px; }
.tc-link details { flex: none; color: var(--sd-text-2, #a4a8b8); }
.tc-link summary { cursor: pointer; }
.tc-link ul { margin: 4px 0 0; padding: 0 0 0 18px; max-height: 120px; overflow: auto; }
.tc-link li code { font: 12px var(--sd-mono, ui-monospace, monospace); color: var(--sd-text, #e6e6f0); overflow-wrap: anywhere; }
.tc-link-actions { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: flex-end; flex: none; }
.tc-link-actions span { margin-right: auto; color: var(--sd-text-2, #a4a8b8); }
.tc-link-actions button { font: inherit; padding: 6px 16px; border-radius: 8px; cursor: pointer; color: inherit;
  background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-link-actions button[data-act=copy] { background: var(--sd-accent, #6e6aff); border-color: transparent; color: #fff; }
.tc-link-actions button:disabled { opacity: .5; cursor: default; }
.tc-link-qr { flex: none; display: flex; justify-content: center; }
.tc-link-qr[hidden] { display: none; }
.tc-link-qr svg { max-width: 100%; height: auto; border-radius: 6px; }
.tc-surface.tc-overlay > .tc-link { height: min(600px, 100%); }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

export interface LinkWindowOptions {
  wm: DesktopAPI | null;
  /** The site's origin, for the link */
  origin: string;
  /** Put text on the clipboard; whether it did */
  copy: (text: string) => Promise<boolean>;
  /** Make a gist of a script and return its link (default: makeGist, with the desktop's sign-in sheet) */
  gist?: (script: string) => Promise<string>;
}

/** The window's content. `close` closes it. */
export function buildLinkWindow(made: MadeLink, o: LinkWindowOptions, close: () => void): HTMLElement {
  const root = el('div', '', 'tc-link');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Share this setup as a link');
  root.append(el('h3', 'Share this setup as a link'));
  root.append(el('p', made.trimmed
    ? 'These commands got this tab to where it is. You can change them here. The person who opens the link sees them and chooses Run before anything runs.'
    : 'The person who opens the link sees these commands and chooses Run before anything runs.'));
  const script = el('textarea');
  script.dataset.part = 'script';
  script.spellcheck = false;
  script.setAttribute('autocapitalize', 'off');
  script.setAttribute('aria-label', 'The script');
  script.value = made.script;
  root.append(script);
  const size = el('p', made.sizeLine, 'tc-link-size');
  size.dataset.part = 'size';
  size.setAttribute('role', 'status');
  root.append(size);
  if (made.trimmed) {
    const down = el('p', `What the script downloaded here: ${made.downloads.lines.join(' ')}`);
    down.dataset.part = 'downloads';
    root.append(down);
    if (made.downloads.warning) { const w = el('p', made.downloads.warning, 'tc-link-warn'); w.dataset.part = 'warning'; root.append(w); }
    for (const s of made.trimmed.notInLink) { const p = el('p', s, 'tc-link-warn'); p.dataset.part = 'not-in-link'; root.append(p); }
    if (made.trimmed.dropped.length) {
      const d = el('details');
      d.dataset.part = 'dropped';
      d.append(el('summary', `${made.trimmed.dropped.length} ${made.trimmed.dropped.length === 1 ? 'line was' : 'lines were'} left out`));
      const ul = el('ul');
      for (const x of made.trimmed.dropped) { const li = el('li'); li.append(el('code', x.line.split('\n')[0].slice(0, 200)), `: ${x.why}`); ul.append(li); }
      d.append(ul);
      root.append(d);
    }
  }
  const link = el('textarea');
  link.dataset.part = 'link';
  link.readOnly = true;
  link.value = made.link.url;
  link.setAttribute('aria-label', 'The link');
  link.addEventListener('focus', () => link.select());
  root.append(link);

  const actions = el('div', '', 'tc-link-actions');
  const status = el('span');
  status.setAttribute('role', 'status');
  const done = el('button', 'Close');
  done.type = 'button';
  done.dataset.act = 'close';
  done.addEventListener('click', close);
  const gist = el('button', 'Make a gist');
  gist.type = 'button';
  gist.dataset.act = 'gist';
  gist.title = 'GitHub keeps the script as a secret gist of your account. Anyone who has the link can read it.';
  const copy = el('button', 'Copy link');
  copy.type = 'button';
  copy.dataset.act = 'copy';
  // The link as a QR code, for a phone's camera: offered when the link fits one
  const qr = el('button', 'QR code');
  qr.type = 'button';
  qr.dataset.act = 'qr';
  qr.setAttribute('aria-expanded', 'false');
  const picture = el('div', '', 'tc-link-qr');
  picture.dataset.part = 'qr';
  picture.hidden = true;
  root.append(picture);
  let url = made.link.url;
  let form = made.link.form;
  const draw = () => {
    const code = picture.hidden ? null : qrCode(url);
    // (the markup is this module's own: modules as a path)
    picture.innerHTML = code ? qrSvg(code, code.size > 77 ? 3 : 4) : '';
    if (code) picture.firstElementChild!.setAttribute('aria-label', 'The link as a QR code');
  };
  const show = () => {
    link.value = url;
    copy.disabled = !url;
    gist.hidden = form !== 'gist' || !script.value.trim();
    qr.hidden = !url || new TextEncoder().encode(url).length > QR_MAX_BYTES;
    if (qr.hidden) { picture.hidden = true; qr.setAttribute('aria-expanded', 'false'); }
    draw();
  };
  qr.addEventListener('click', () => {
    picture.hidden = !picture.hidden;
    qr.setAttribute('aria-expanded', String(!picture.hidden));
    draw();
    if (!picture.hidden) picture.scrollIntoView?.({ block: 'nearest' });
  });
  show();
  // The link follows the box, a moment after the last key
  let timer: ReturnType<typeof setTimeout> | null = null;
  let turn = 0;
  script.addEventListener('input', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const mine = ++turn;
      void buildLink({ script: script.value, origin: o.origin }).then((m) => {
        if (mine !== turn) return;
        url = m.link.url;
        form = m.link.form;
        size.textContent = m.script.trim() ? m.sizeLine : 'The script is empty, so there is no link.';
        status.textContent = '';
        show();
      });
    }, 200);
  });
  copy.addEventListener('click', () => {
    if (!url) return;
    void o.copy(url).then((ok) => {
      status.textContent = ok ? 'The link is copied.' : 'The browser did not allow the copy. Select the link and copy it by hand.';
      if (!ok) { link.focus(); link.select(); }
    });
  });
  gist.addEventListener('click', () => {
    gist.disabled = true;
    status.textContent = 'The script is being sent to GitHub.';
    void (o.gist ?? ((s: string) => makeGist(s, o.origin)))(script.value.endsWith('\n') ? script.value : script.value + '\n').then((made) => {
      url = made;
      form = 'readable';
      size.textContent = `The script is in a gist of your GitHub account, and the link names the gist: ${made.length} characters.`;
      status.textContent = 'The gist is made.';
      show();
    }, (e: unknown) => { status.textContent = (e as Error)?.message ?? 'No gist was made.'; }).finally(() => { gist.disabled = false; });
  });
  actions.append(status, done, qr, gist, copy);
  root.append(actions);
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  return root;
}

/** Show the Link window: a desktop window, or an overlay where there is no desktop */
export function showLinkWindow(made: MadeLink, o: LinkWindowOptions): DesktopWindow | null {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  let close = () => {};
  const content = buildLinkWindow(made, o, () => close());
  let win: DesktopWindow | null = null;
  if (o.wm) {
    const wa = o.wm.workArea();
    const w = win = o.wm.createWindow({
      appId: 'link', title: 'Share this setup', content: { kind: 'dom', element: content },
      width: Math.min(620, Math.max(280, wa.width - 40)), height: Math.min(600, Math.max(300, wa.height - 80)), minWidth: 280, minHeight: 280,
    });
    close = () => { w.close(true); };
    w.focus();
  } else close = overlay(content);
  content.querySelector<HTMLButtonElement>('[data-act=copy]')?.focus();
  return win;
}
