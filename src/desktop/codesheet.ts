/**
 * Code's File ▸ Open… and Open Folder… (the menu bar's File menu while a Code
 * window is focused): a sheet asking for a path, which runs `code PATH` in a
 * shell of its own, as typing it would. A file opens in a new Code window; a
 * folder opens with its files in the sidebar.
 */
import type { AppContext } from './index';

const HOME = '/home/user';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
const tilde = (p: string) => (p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
const untilde = (p: string) => (p === '~' ? HOME : p.startsWith('~/') ? HOME + p.slice(1) : p);
/** Single-quote for the shell */
const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

export function openCodeSheet(ctx: AppContext, kind: 'file' | 'folder', startDir = HOME): void {
  const what = kind === 'file' ? 'File' : 'Folder';
  const el = document.createElement('div');
  el.className = 'sd-sheet sd-git-sheet';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `Open ${what}`);
  el.innerHTML = `
    <div class="sd-sheet-head"><div><h3>Open ${what}</h3>
      <p>${kind === 'file' ? 'A file opens in a new Code window.' : 'A folder opens with its files in the sidebar (☰).'}</p></div></div>
    <form class="sd-git-form">
      <input class="sd-input" name="path" type="text" autocomplete="off" autocapitalize="off" spellcheck="false" aria-label="Path"
        value="${esc(tilde(startDir) + (kind === 'file' && startDir !== '/' ? '/' : ''))}">
      <div class="sd-small sd-muted sd-git-dest" aria-live="polite"></div>
      <div class="sd-sheet-actions"><span class="sd-grow"></span>
        <button class="sd-btn" data-act="cancel" type="button">Cancel</button>
        <button class="sd-btn sd-primary" type="submit">Open</button></div>
    </form>`;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('sd-leaving');
    setTimeout(() => el.remove(), 220);
  };
  const input = el.querySelector<HTMLInputElement>('input[name=path]')!;
  const note = el.querySelector<HTMLElement>('.sd-git-dest')!;
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } });
  el.addEventListener('click', (e) => { if ((e.target as HTMLElement).closest('[data-act=cancel]')) close(); });
  el.querySelector('form')!.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = input.value.trim();
    const path = untilde(raw).replace(/(.)\/+$/, '$1');
    if (!raw) return;
    const st = await ctx.fs.stat(path).catch(() => null);
    if (!st) { note.textContent = `${raw}: no such ${kind}`; return; }
    if (kind === 'file' && st.type === 'dir') { note.textContent = `${raw} is a folder: File ▸ Open Folder… opens it`; return; }
    if (kind === 'folder' && st.type !== 'dir') { note.textContent = `${raw} is a file: File ▸ Open… opens it`; return; }
    close();
    const sh = ctx.shell.fork();
    sh.cwd = HOME;
    void sh.execute(`code ${shq(path)}`, () => {}, () => {});
  });
  ctx.wm.root.appendChild(el);
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
}
