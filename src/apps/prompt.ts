/**
 * The window shown before an app that isn't curated is installed (src/apps/links.ts,
 * docs/APPS.md "Installing"). It says the fewest things a careful person
 * needs: the app's name as a question, where it comes from, what it does, the
 * exact command, what it installs, and one sentence on what it can touch that
 * is true of this app. The rest is one click away: "What it can reach" (every
 * line, and the way to open it in a guest) and the manifest itself. Nothing
 * is written or run unless the person chooses Install.
 *
 * The rules are the run link prompt's (src/run-prompt.ts): everything from
 * the app goes in with textContent, Cancel has the focus, closing the window
 * is Cancel, Install is off for the first moment, and a click that script
 * made (not a person) does nothing. On a phone the prompt fills the screen.
 */
import type { InstallChoice, InstallPromptInfo } from './links';
import { describeManifest, type AppManifest } from './manifest';
import { kindSaid } from './declare';
import { whenText } from './export';
import { overlay, phoneScreen } from './surface';
import type { DesktopAPI, DesktopWindow } from '../desktop/wm';

const STYLE_ID = 'tc-app-prompt-style';
const ARMS_AFTER_MS = 700;

const CSS = `
.tc-app-prompt { box-sizing: border-box; display: flex; flex-direction: column; gap: 10px; height: 100%; min-height: 0; padding: 16px; overflow: auto;
  font: 13px/1.5 var(--sd-font, system-ui, sans-serif); color: var(--sd-text, #e6e6f0); background: var(--sd-window, #1b1d29); }
.tc-app-prompt * { box-sizing: border-box; }
.tc-app-prompt h3 { margin: 0; font-size: 1.2em; font-weight: 600; overflow-wrap: anywhere; }
.tc-app-prompt p { margin: 0; overflow-wrap: anywhere; }
.tc-app-prompt .tc-app-from, .tc-app-prompt details p, .tc-app-prompt dt { color: var(--sd-text-2, #a4a8b8); }
.tc-app-prompt code, .tc-app-prompt pre { font: .92em/1.5 var(--sd-mono, ui-monospace, monospace); background: var(--sd-field, rgba(255, 255, 255, .06));
  border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); border-radius: 8px; user-select: text; -webkit-user-select: text; }
.tc-app-prompt code { display: block; margin-top: 4px; padding: 8px 10px; white-space: pre-wrap; overflow-wrap: anywhere; }
.tc-app-prompt dl { margin: 0; display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
.tc-app-prompt ul { margin: 0; padding: 0 0 0 18px; display: grid; gap: 2px; overflow-wrap: anywhere; }
.tc-app-prompt dd { margin: 0; overflow-wrap: anywhere; }
.tc-app-prompt dd.tc-app-flag { font-weight: 600; }
.tc-app-prompt details { flex: none; }
.tc-app-prompt details > * + * { margin-top: 6px; }
.tc-app-prompt summary { cursor: pointer; color: var(--sd-text-2, #a4a8b8); }
.tc-app-prompt pre { max-height: 220px; margin: 6px 0 0; padding: 10px 12px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
.tc-app-prompt .tc-app-link { font: inherit; padding: 0; border: 0; background: none; color: inherit; text-decoration: underline; cursor: pointer; }
.tc-app-prompt .tc-app-link:disabled { opacity: .5; cursor: default; }
.tc-app-prompt-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; flex: none; margin-top: auto; padding-top: 6px; }
.tc-app-prompt-actions button { font: inherit; min-width: 88px; padding: 6px 16px; border-radius: 8px; cursor: pointer; color: inherit;
  background: var(--sd-field, rgba(255, 255, 255, .06)); border: 1px solid var(--sd-sep, rgba(255, 255, 255, .12)); }
.tc-app-prompt button:focus-visible, .tc-app-prompt summary:focus-visible { outline: 2px solid var(--sd-accent, #6e6aff); outline-offset: 1px; }
.tc-app-prompt-actions button[data-act=install] { background: var(--sd-accent, #6e6aff); border-color: transparent; color: #fff; }
.tc-app-prompt-actions button:disabled { opacity: .5; cursor: default; }
.tc-full .tc-app-prompt-actions button { flex: 1; }
`;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = '', cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** What the page of an app can touch: `listed` when the prompt lists folders or commands the page may use */
const pageReach = (confined: boolean, listed: boolean): string => (confined
  ? `Its page runs on an address of its own: it cannot read this tab's files or sign-ins${listed ? ' except through what is listed here' : ''}.`
  : `This server gives app pages no address of their own: its page runs with this tab's own access${listed ? ', whatever is listed here' : ''}.`);
const PROGRAMS = 'What it runs are ordinary programs in this tab: they can read and change every file here and use its sign-ins (Claude, GitHub).';

/**
 * What the prompt says about an app, in two parts: `shown` at once, and
 * `more` under "What it can reach". No DOM: the test reads these.
 */
export function promptWords(info: InstallPromptInfo): { title: string; from: string; shown: { text: string; code?: string; rows?: [string, string, boolean][] }[]; more: { text?: string; rows?: [string, string, boolean][] }[] } {
  const m: AppManifest = info.manifest;
  const shown: { text: string; code?: string; rows?: [string, string, boolean][] }[] = [];
  const more: { text?: string; rows?: [string, string, boolean][] }[] = [];
  if (m.description) shown.push({ text: m.description });
  if (m.kind !== 'page') {
    // An app that is its manifest: the exact command, what it installs, and what that program can touch
    const s = kindSaid(m);
    const reach = pageReach(info.confined, false);
    shown.push(s.run ? { text: `${s.does}:`, code: s.run } : { text: s.does });
    if (s.installs) shown.push({ text: s.installs });
    // A table kept as CSV runs no program: its page is all there is, so the page's reach is the sentence
    const pageOnly = !m.access.commands.length && !m.access.shell;
    shown.push({ text: !pageOnly ? s.touches : info.confined ? 'It runs no program, and its page may use only its own data folder.' : reach });
    for (const text of [s.named, s.page, ...(pageOnly && !info.confined ? [] : [reach])]) if (text) more.push({ text });
  } else {
    // An app with a page of its own: only the lines that ask for something
    const lines = describeManifest(m);
    const asks = lines.filter((l) => l.warn || l.label === 'Installs' || l.label === 'Expects' || (l.label === 'Files' && m.access.fs.length > 0));
    const reach = pageReach(info.confined, asks.some((l) => l.label === 'Files' || l.label === 'Commands'));
    if (asks.length) shown.push({ text: '', rows: asks.map((l) => [l.label, l.text, !!l.warn]) });
    const runs = !!m.backend || m.access.shell || m.access.commands.length > 0;
    shown.push({ text: runs ? PROGRAMS : reach });
    more.push({ rows: [['App', `${m.id}${m.version ? `, version ${m.version}` : ''}`, false], ...lines.map((l): [string, string, boolean] => [l.label, l.text, !!l.warn])] });
    if (runs) more.push({ text: `${reach} The list is what the app says it does, not a limit on those programs.` });
  }
  if (info.replaces) shown.push({ text: `It replaces the ${m.name} installed here.` });
  return { title: `Install ${m.name}?`, from: `From ${info.from}. Not reviewed by tabcomputer.`, shown, more };
}

/** The prompt's content. `done('install')` only from a person's click on Install. */
export function buildInstallPrompt(info: InstallPromptInfo, done: (choice: InstallChoice) => void): HTMLElement {
  const words = promptWords(info);
  const root = el('div', '', 'tc-app-prompt');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Install an app');
  root.append(el('h3', words.title), el('p', words.from, 'tc-app-from'));
  const rows = (list: [string, string, boolean][]) => {
    const dl = el('dl');
    for (const [label, text, warn] of list) dl.append(el('dt', label), el('dd', text, warn ? 'tc-app-flag' : ''));
    return dl;
  };
  for (const s of words.shown) {
    if (s.rows) { root.append(rows(s.rows)); continue; }
    const p = el('p', s.text);
    if (s.code) p.append(el('code', s.code));
    root.append(p);
  }
  const buttons: HTMLButtonElement[] = [];
  const reach = el('details');
  reach.append(el('summary', 'What it can reach'));
  for (const s of words.more) reach.append(s.rows ? rows(s.rows) : el('p', s.text));
  if (info.guests) {
    // A guest is offered here, not beside Install: it is a second place to work in, without this tab's sign-ins
    const p = el('p', 'To keep it away from your files and sign-ins, ');
    const guest = el('button', 'open it in a guest', 'tc-app-link');
    guest.type = 'button';
    guest.dataset.act = 'guest';
    guest.disabled = true;
    guest.addEventListener('click', (e) => { if (e.isTrusted !== false && !guest.disabled) done('guest'); });
    buttons.push(guest);
    p.append(guest, ': a separate tabcomputer that asks again there.');
    reach.append(p);
  }
  const file = el('details');
  file.append(el('summary', 'app.json, as it will be installed'));
  const pre = el('pre', info.manifestText);
  pre.tabIndex = 0;
  pre.setAttribute('aria-label', 'The manifest');
  file.append(pre);
  root.append(reach, file);

  const actions = el('div', '', 'tc-app-prompt-actions');
  const cancel = el('button', 'Cancel');
  cancel.type = 'button';
  cancel.dataset.act = 'cancel';
  const install = el('button', 'Install');
  install.type = 'button';
  install.dataset.act = 'install';
  install.disabled = true;
  buttons.push(install);
  actions.append(cancel, install);
  setTimeout(() => { for (const b of buttons) b.disabled = false; }, ARMS_AFTER_MS);
  cancel.addEventListener('click', () => done('cancel'));
  install.addEventListener('click', (e) => { if (e.isTrusted !== false && !install.disabled) done('install'); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done('cancel'); } });
  root.append(actions);
  return root;
}

/** `content` as a question: a window on the desktop, the whole screen on a phone, a card where there is no desktop. Closing it is `no`. */
function ask<T>(wm: DesktopAPI | null, title: string, height: number, no: T, build: (done: (answer: T) => void) => HTMLElement): Promise<T> {
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  return new Promise<T>((resolve) => {
    let settled = false;
    let close = () => {};
    const done = (answer: T) => {
      if (settled) return;
      settled = true;
      close();
      resolve(answer);
    };
    const content = build(done);
    let win: DesktopWindow | null = null;
    // A phone has no room for a desktop around a question: the prompt is the screen
    const full = phoneScreen();
    if (wm && !full) {
      const wa = wm.workArea();
      const w = win = wm.createWindow({
        appId: 'run-link', title, alwaysOnTop: true, content: { kind: 'dom', element: content },
        width: Math.min(560, Math.max(280, wa.width - 40)), height: Math.min(height, Math.max(260, wa.height - 80)), minWidth: 280, minHeight: 240,
      });
      close = () => { w.close(true); };
      w.on('close', () => done(no));
    } else close = overlay(content, { full });
    const cancel = content.querySelector<HTMLButtonElement>('[data-act=cancel]');
    const focus = () => { if (!settled) { win?.focus(); cancel?.focus(); } };
    focus();
    setTimeout(focus, ARMS_AFTER_MS);
  });
}

/** Ask before installing an app that isn't curated. Closing the window is Cancel. */
export function showInstallPrompt(info: InstallPromptInfo, wm: DesktopAPI | null): Promise<InstallChoice> {
  return ask<InstallChoice>(wm, 'Install app', 440, 'cancel', (done) => buildInstallPrompt(info, done));
}

/** What importing an app's export would replace (src/apps/export.ts `replacePlan`) */
export interface ReplaceInfo {
  name: string;
  /** The data files here that would change or go, newest first */
  replaced: { rel: string; mtime: number }[];
  /** How many data files the export holds, and when it was made (0: it does not say) */
  files: number;
  exportedAt: number;
  now?: number;
}

/** What the question says: `lines` are the files that would be replaced, each with when it last changed */
export function replaceWords(info: ReplaceInfo): { title: string; says: string; lines: string[]; more: string } {
  const now = info.now ?? Date.now();
  const SHOWN = 6;
  const made = info.exportedAt ? `, exported ${whenText(info.exportedAt, now)}` : '';
  return {
    title: `Replace the data ${info.name} has here?`,
    says: `The file holds ${info.files ? `${info.files} ${info.files === 1 ? 'file' : 'files'} of data${made}` : `no data${made}`}. Importing it replaces what ${info.name} has here:`,
    lines: info.replaced.slice(0, SHOWN).map((f) => `${f.rel}, changed ${whenText(f.mtime, now)}`),
    more: info.replaced.length > SHOWN ? `and ${info.replaced.length - SHOWN} more ${info.replaced.length - SHOWN === 1 ? 'file' : 'files'}` : '',
  };
}

/** The question before an import replaces data: Cancel (focused) or Replace. `done(true)` only from a person's click on Replace. */
export function buildReplacePrompt(info: ReplaceInfo, done: (replace: boolean) => void): HTMLElement {
  const words = replaceWords(info);
  const root = el('div', '', 'tc-app-prompt');
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-label', 'Replace an app\'s data');
  root.append(el('h3', words.title), el('p', words.says));
  const list = el('ul');
  for (const line of words.lines) list.append(el('li', line));
  if (words.more) list.append(el('li', words.more));
  root.append(list);
  const actions = el('div', '', 'tc-app-prompt-actions');
  const cancel = el('button', 'Cancel');
  cancel.type = 'button';
  cancel.dataset.act = 'cancel';
  const replace = el('button', 'Replace');
  replace.type = 'button';
  replace.dataset.act = 'install';
  replace.disabled = true;
  setTimeout(() => { replace.disabled = false; }, ARMS_AFTER_MS);
  cancel.addEventListener('click', () => done(false));
  replace.addEventListener('click', (e) => { if (e.isTrusted !== false && !replace.disabled) done(true); });
  root.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false); } });
  actions.append(cancel, replace);
  root.append(actions);
  return root;
}

/** Ask before an import replaces the data an app has here. Closing the window is Cancel. */
export function showReplacePrompt(info: ReplaceInfo, wm: DesktopAPI | null): Promise<boolean> {
  return ask<boolean>(wm, 'Import app', 320, false, (done) => buildReplacePrompt(info, done));
}
