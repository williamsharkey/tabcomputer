import type { Terminal } from '@xterm/xterm';
import { writeClipboard } from './clipboard';

/** Decode base64 to a UTF-8 string. */
function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Copy to the clipboard (kept and retried on focus when the browser refuses: utils/clipboard.ts). */
export function copyText(text: string): void {
  void writeClipboard(text).then((ok) => console.log(`[osc52] ${ok ? 'copied' : 'FAILED to copy (kept, retried on focus)'} ${text.length} chars`));
}

/**
 * OSC 52 clipboard writes (`ESC ] 52 ; c ; <base64> BEL`). TUIs that handle the
 * mouse themselves, like Claude Code's fullscreen mode, copy a selection this
 * way, since the highlight they draw isn't an xterm selection Cmd+C can see.
 * Clipboard reads (`?`) are ignored.
 */
export function installOsc52(term: Terminal): void {
  term.parser.registerOscHandler(52, (data) => {
    const sep = data.indexOf(';');
    const payload = sep >= 0 ? data.slice(sep + 1) : data;
    if (!payload || payload === '?') return true;
    let text: string;
    try {
      text = decodeBase64Utf8(payload);
    } catch (e: any) {
      console.warn('[osc52] bad payload:', e?.message || e);
      return true;
    }
    copyText(text);
    return true;
  });
}
