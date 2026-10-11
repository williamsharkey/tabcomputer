/**
 * clipboard-napi.node for claude --vm: the browser clipboard.
 *
 * Claude Code 2.1.296 calls two functions of it, on Linux only, when DISPLAY
 * (or WAYLAND_DISPLAY) is set and none of wl-copy, xclip and xsel is on PATH
 * (tabcomputer's xclip and xsel builtins are, in /usr/local/bin, so this is
 * the fallback for a PATH without them):
 *
 *   setLinuxClipboardText(text) → true when written; false makes Claude Code
 *     stop using the addon (until a write has once succeeded) and emit OSC 52.
 *   getLinuxClipboardText(primary, timeoutMs) → a promise of the text, or
 *     null; a rejection is logged and read as null. Claude Code drops one
 *     trailing newline.
 *
 * A write the browser refuses (the tab isn't focused) is still a success
 * here: utils/clipboard.ts keeps the text, gives it to reads, and writes it
 * when the window next gets focus, as pbcopy and xclip do. The browser has no
 * PRIMARY selection: both selections are the clipboard, as for xclip.
 */
import type { PageBridge } from './bridge';

export interface ClipboardAddon {
  setLinuxClipboardText(text: string): boolean;
  getLinuxClipboardText(primary?: boolean, timeoutMs?: number): Promise<string | null>;
}

export function createClipboardAddon(page: PageBridge): ClipboardAddon {
  return {
    setLinuxClipboardText(text) {
      void page.call('clipboard.write', [String(text ?? '')]).catch(() => {});
      return true;
    },
    async getLinuxClipboardText(_primary, timeoutMs) {
      const text = await page.call('clipboard.read', [typeof timeoutMs === 'number' ? timeoutMs : 2000]);
      return typeof text === 'string' && text !== '' ? text : null;
    },
  };
}
