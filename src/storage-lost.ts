/**
 * The page's warning when the filesystem's IndexedDB is deleted under it
 * (tabcomputer#71: eviction, "Clear site data", another tab): a banner over
 * everything, in the desktop and the terminal UI, with a Save button that
 * downloads what memory still holds as a tar. Nothing else can bring those
 * files back once the page reloads. On the load after a loss: a notice, and
 * an offer to install again what the lost disk had (offerReinstall).
 */

import type { FileSystem, StorageLost } from './filesystem';

const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

function banner(html: string): HTMLElement {
  const b = document.createElement('div');
  b.setAttribute('role', 'alert');
  b.className = 'tabcomputer-storage-lost';
  b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483646;padding:10px 16px;'
    + 'background:#7f1d1d;color:#fff;font:14px/1.4 system-ui,sans-serif;display:flex;gap:12px;align-items:center;flex-wrap:wrap;'
    + 'box-shadow:0 2px 8px rgba(0,0,0,.4)';
  const text = document.createElement('div');
  text.style.cssText = 'flex:1;min-width:240px';
  text.innerHTML = html;
  b.append(text);
  return b;
}

function button(label: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = label;
  btn.style.cssText = 'padding:6px 12px;border-radius:6px;border:1px solid #fff;background:#fff;color:#7f1d1d;font:inherit;font-weight:600;cursor:pointer';
  btn.addEventListener('click', onClick);
  return btn;
}

/** Download what memory still holds of the filesystem as tabcomputer-rescue-*.tar. */
export async function saveInMemoryFiles(fs: FileSystem): Promise<number> {
  const { packTar } = await import('./commands/tar');
  const nodes = fs.inMemoryFiles().filter((n) => n.path !== '/').sort((a, b) => a.path < b.path ? -1 : 1);
  const tar = packTar(nodes.map((n) => ({
    name: n.path.slice(1), type: n.type === 'dir' ? 'dir' : n.type === 'symlink' ? 'symlink' : 'file',
    mode: n.mode, mtime: n.mtime, content: n.type === 'file' ? n.content : null,
    target: n.type === 'symlink' ? n.symlinkTarget ?? new TextDecoder().decode(n.content ?? new Uint8Array(0)) : undefined,
  })));
  const url = URL.createObjectURL(new Blob([tar as BlobPart], { type: 'application/x-tar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `tabcomputer-rescue-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.tar`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return nodes.length;
}

/** Show the banner when `fs` loses its storage, and a notice if the storage before this load was lost. */
export function watchStorageLost(fs: FileSystem): void {
  if (typeof document === 'undefined') return;
  fs.onStorageLost((lost: StorageLost) => {
    const files = fs.inMemoryFiles().filter((n) => n.type === 'file');
    const bytes = files.reduce((n, f) => n + (f.content?.length ?? 0), 0);
    const at = new Date(lost.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const b = banner(`<b>Browser storage for this tab was deleted at ${at}</b> (likely eviction: storage is not persistent). `
      + `Files still in memory: ${files.length} (${mb(bytes)}). Save them before reloading: a reload starts from an empty disk. `
      + `Files not in memory read as "Input/output error".`);
    const save = button('Save files (.tar)', () => {
      save.disabled = true;
      void saveInMemoryFiles(fs).then((n) => { save.textContent = `Saved ${n} entries`; }, (e) => { save.textContent = 'Save failed'; console.error('[fs] rescue tar:', e); })
        .finally(() => { save.disabled = false; });
    });
    b.append(save);
    document.body.append(b);
  });
  if (fs.previousVolumeLost) {
    const b = banner(PREVIOUS_GONE);
    b.classList.add(PREVIOUS_CLASS);
    b.style.background = '#78350f';
    b.append(button('Dismiss', () => b.remove()));
    document.body.append(b);
  }
}

const PREVIOUS_GONE = '<b>This tab\'s previous files are gone.</b> The browser cleared or evicted its storage before this load, so tabcomputer started with an empty disk.';
const PREVIOUS_CLASS = 'tabcomputer-storage-previous';

/**
 * After a loss: what the lost disk had installed, with a button that installs
 * it again (src/install-inventory.ts). Called once the prompt is up; `run`
 * types the commands into a Terminal. The offer stands across reloads until
 * it is taken or dismissed, or everything is back. Resolves to whether it
 * was shown.
 */
export async function offerReinstall(fs: FileSystem, opts: { run(commands: string[]): void; skipPkg?: string[] }): Promise<boolean> {
  if (typeof document === 'undefined') return false;
  const { reinstallOffer, dismissLostInventory } = await import('./install-inventory');
  const offer = await reinstallOffer(fs, { skipPkg: opts.skipPkg });
  if (!offer) return false;
  // (in place of the plain notice watchStorageLost put up on the first load after the loss)
  document.querySelector(`.${PREVIOUS_CLASS}`)?.remove();
  const { describeMissing } = await import('./install-inventory');
  const b = banner(PREVIOUS_GONE);
  b.classList.add(PREVIOUS_CLASS);
  b.style.background = '#78350f';
  const text = b.firstElementChild as HTMLElement;
  // Names from the saved list go in as text
  const what = describeMissing(offer.missing);
  if (what) text.append(document.createElement('br'), `It had installed: ${what}.`);
  if (offer.signins.includes('claude')) text.append(document.createElement('br'), 'Claude\'s sign-in was among the files: run claude and sign in again.');
  const done = () => { dismissLostInventory(); b.remove(); };
  if (offer.commands.length) {
    const again = button('Reinstall', () => { done(); opts.run(offer.commands); });
    again.title = offer.commands.join(' ; ');
    b.append(again);
  }
  b.append(button('Dismiss', done));
  document.body.append(b);
  return true;
}
