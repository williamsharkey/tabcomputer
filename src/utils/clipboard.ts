/**
 * The page's clipboard for pbcopy, xclip, xsel, wl-copy and OSC 52.
 *
 * A browser refuses clipboard writes while the tab isn't focused. The text
 * written is kept here either way: pbpaste and `xclip -o` give it back, and a
 * write that was refused is tried again when the window next gets focus.
 */

/** The last text written; a refused write's text until it reaches the browser */
let localText: string | null = null;
/** A refused write is waiting for focus */
let pending = false;
let focusHooked = false;

/** Legacy copy via a hidden textarea; works where the async API is refused. */
function execCommandCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const ta = document.createElement('textarea');
  const prevFocus = document.activeElement as HTMLElement | null;
  let ok = false;
  try {
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.select();
    ok = document.execCommand('copy');
  } catch { ok = false; }
  ta.remove();
  prevFocus?.focus?.();
  return ok;
}

/** One try at the browser clipboard: the async API, then execCommand */
async function tryWrite(text: string): Promise<boolean> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip?.writeText) {
    try { await clip.writeText(text); return true; } catch { /* refused: not focused, no permission */ }
  }
  return execCommandCopy(text);
}

function retryOnFocus(): void {
  if (focusHooked || typeof window === 'undefined' || !window.addEventListener) return;
  focusHooked = true;
  window.addEventListener('focus', () => {
    if (!pending || localText === null) return;
    const text = localText;
    void tryWrite(text).then((ok) => {
      if (ok && localText === text) pending = false;
      console.log(`[clipboard] ${ok ? 'wrote' : 'still could not write'} ${text.length} chars on focus`);
    });
  });
}

/**
 * Write text to the clipboard. False when the browser refused it: the text is
 * kept (readClipboard returns it) and written when the window next gets focus.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  localText = text;
  const ok = await tryWrite(text);
  // (a later write may have replaced this one while it waited)
  if (localText === text) pending = !ok;
  if (!ok) retryOnFocus();
  return ok;
}

/** The clipboard's text: a refused write's text while it waits, else the browser's (or the last written) */
export async function readClipboard(): Promise<string> {
  if (pending && localText !== null) return localText;
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (clip?.readText) {
    try { return (await clip.readText()) ?? ''; } catch { /* no permission, not focused */ }
  }
  return localText ?? '';
}

/**
 * The image on the browser clipboard (navigator.clipboard.read: Chrome gives
 * images as image/png), or null when there is none or the browser refuses
 * (no permission, the tab isn't focused).
 */
export async function readClipboardImage(): Promise<{ type: string; bytes: Uint8Array } | null> {
  const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  if (!clip?.read) return null;
  try {
    for (const item of await clip.read()) {
      const type = item.types.find((t) => /^image\//.test(t));
      if (type) return { type, bytes: new Uint8Array(await (await item.getType(type)).arrayBuffer()) };
    }
  } catch { /* no permission, not focused */ }
  return null;
}

/** (tests) Forget the local text */
export function resetClipboard(): void {
  localText = null;
  pending = false;
}
