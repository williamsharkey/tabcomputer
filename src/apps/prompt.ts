/**
 * The window shown before an app that isn't curated is installed (src/apps/links.ts,
 * docs/APPS.md "Installing"): where it comes from, what it will run, what its
 * page may touch, and the manifest itself, with Install and Cancel. Nothing
 * is written or run unless the person chooses Install.
 *
 * The rules are the run link prompt's (src/run-prompt.ts): everything from
 * the app goes in with textContent, Cancel has the focus, closing the window
 * is Cancel, Install is off for the first moment, and a click that script
 * made (not a person) does nothing.
 */
import type { InstallChoice, InstallPromptInfo } from './links';
import { describeManifest, manifestSentences } from './manifest';
import type { DesktopAPI, DesktopWindow } from '../desktop/wm';

const STYLE_ID = 'tc-app-prompt-style';
const ARMS_AFTER_MS = 700;

const CSS = `
.tc-app-prompt { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 14px 16px; overflow: auto;
  font: 13px/1.45 var(--sd-font, system-ui, sans-serif); color: var(--sd-text, #e6e6f0); background: var(--sd-window, #1b1d29); }
.tc-app-prompt * { box-sizing: border-box; }
.tc-app-prompt h3 { margin: 0; font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.tc-app-prompt p { margin: 0; color: var(--sd-text-2, #a4a8b8); overflow-wrap: anywhere; }
.tc-app-prompt .tc-app-warn { color: var(--sd-text, #e6e6f0); }
.tc-app-prompt dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
.tc-app-prompt dt { color: var(--sd-text-2, #a4a8b8); }
.tc-app-prompt dd { margin: 0; overflow-wrap: anywhere; }
.tc-app-prompt dd.tc-app-flag { color: var(--sd-text, #e6e6f0); font-weight: 600; }
.tc-app-prompt details { flex: none; }
.tc-app-prompt summary { cursor: pointer; color: var(--sd-text-2, #a4a8b8); }
.tc-app-prompt pre { max-height: 220px; margin: 6px 0 0; padding: 10px 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
  font: 12px/1.5 var(--sd-mono, ui-monospace, monospace); background: var(--sd-field, rgba(255, 255, 255, .06));
  border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 8px; user-select: text; -webkit-user-select: text; }
.tc-app-prompt-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; flex: none; margin-top: auto; }
.tc-app-prompt-actions button { font: inherit; padding: 6px 16px; border-radius: 8px; cursor: pointer; color: inherit;
  background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-app-prompt-actions button:focus-visible { outline: 2px solid var(--sd-accent, #6e6aff); outline-offset: 1px; }
.tc-app-prompt-actions button[data-act=install] { background: var(--sd-accent, #6e6aff); border-color: transparent; color: #fff; }
.tc-app-prompt-actions button:disabled { opacity: .5; cursor: default; }
.tc-app-prompt-overlay { position: fixed; inset: 0; z-index: 2147483000; display: flex; align-items: center; justify-content: center; padding: 12px; background: rgba(0, 0, 0, .5); }
.tc-app-prompt-overlay .tc-app-prompt { width: min(640px, 100%); height: auto; max-height: 100%; border: 1px solid #3d3d5c; border-radius: 10px; box-shadow: 0 8px 24px rgba(0, 0, 0, .4); }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** The prompt's content. `done('install')` only from a person's click on Install. */
export function buildInstallPrompt(info: InstallPromptInfo, done: (choice: InstallChoice) => void): HTMLElement {
  const m = info.manifest;
  const root = el('div', '', 'tc-app-prompt');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Install an app');
  root.append(el('h3', `Install ${m.name}?`));
  root.append(el('p', `From ${info.from}. tabcomputer has not reviewed it.`));
  if (m.description) root.append(el('p', m.description));
  if (m.kind === 'page') {
    const dl = el('dl');
    dl.append(el('dt', 'App'), el('dd', `${m.id}${m.version ? `, version ${m.version}` : ''}${info.replaces ? ' (replaces the one installed here)' : ''}`));
    for (const line of describeManifest(m)) dl.append(el('dt', line.label), el('dd', line.text, line.warn ? 'tc-app-flag' : ''));
    root.append(dl);
  } else {
    // An app that is its manifest reads as sentences: the exact command, what it installs (the first is its description, above)
    for (const s of manifestSentences(m).slice(m.description ? 1 : 0)) root.append(el('p', s, 'tc-app-warn'));
    if (info.replaces) root.append(el('p', `It replaces the ${m.name} installed here.`));
  }
  const runs = !!m.backend || m.access.shell || m.access.commands.length > 0;
  root.append(el('p', info.confined
    ? 'Its page runs on an address of its own: it cannot read this tab\'s files or sign-ins except through what is listed above.'
    : 'This server gives app pages no address of their own: its page runs with this tab\'s own access, whatever is listed above.', info.confined ? '' : 'tc-app-warn'));
  if (runs && m.kind === 'page') {
    root.append(el('p', `What it runs are ordinary programs in this tab: they can read and change every file here and use the accounts this tab is signed in to (Claude, GitHub). The list above is what the app says it does, not a limit on those programs.${info.guests ? ' To keep it away from your files and sign-ins, open it in a guest.' : ''}`, 'tc-app-warn'));
  }
  const details = el('details');
  details.append(el('summary', 'app.json, as it will be installed'));
  const pre = el('pre', info.manifestText);
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'The manifest');
  details.append(pre);
  root.append(details);

  const actions = el('div', '', 'tc-app-prompt-actions');
  const cancel = el('button', 'Cancel');
  cancel.type = 'button';
  cancel.dataset.act = 'cancel';
  const install = el('button', 'Install');
  install.type = 'button';
  install.dataset.act = 'install';
  install.disabled = true;
  const buttons: HTMLButtonElement[] = [install];
  actions.append(cancel);
  if (info.guests) {
    const guest = el('button', 'Open in a guest');
    guest.type = 'button';
    guest.dataset.act = 'guest';
    guest.disabled = true;
    guest.title = 'A separate tabcomputer that cannot read this one\'s files or sign-ins; it asks again there';
    guest.addEventListener('click', (e) => { if (e.isTrusted !== false && !guest.disabled) done('guest'); });
    buttons.push(guest);
    actions.append(guest);
  }
  actions.append(install);
  setTimeout(() => { for (const b of buttons) b.disabled = false; }, ARMS_AFTER_MS);
  cancel.addEventListener('click', () => done('cancel'));
  install.addEventListener('click', (e) => { if (e.isTrusted !== false && !install.disabled) done('install'); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done('cancel'); } });
  root.append(actions);
  return root;
}

/** Ask before installing an app that isn't curated. Closing the window is Cancel. */
export function showInstallPrompt(info: InstallPromptInfo, wm: DesktopAPI | null): Promise<InstallChoice> {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  return new Promise<InstallChoice>((resolve) => {
    let settled = false;
    let close = () => {};
    const done = (choice: InstallChoice) => {
      if (settled) return;
      settled = true;
      close();
      resolve(choice);
    };
    const content = buildInstallPrompt(info, done);
    let win: DesktopWindow | null = null;
    if (wm) {
      const wa = wm.workArea();
      const w = win = wm.createWindow({
        appId: 'run-link', title: 'Install app', alwaysOnTop: true, content: { kind: 'dom', element: content },
        width: Math.min(620, Math.max(280, wa.width - 40)), height: Math.min(560, Math.max(260, wa.height - 80)), minWidth: 280, minHeight: 240,
      });
      close = () => { w.close(true); };
      w.on('close', () => done('cancel'));
    } else {
      const overlay = el('div', '', 'tc-app-prompt-overlay');
      overlay.append(content);
      document.body.appendChild(overlay);
      close = () => overlay.remove();
    }
    const cancel = content.querySelector<HTMLButtonElement>('[data-act=cancel]');
    const focus = () => { if (!settled) { win?.focus(); cancel?.focus(); } };
    focus();
    setTimeout(focus, ARMS_AFTER_MS);
  });
}
