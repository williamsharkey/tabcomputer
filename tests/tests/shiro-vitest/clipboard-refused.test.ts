/**
 * tabcomputer#25: when the browser refuses a clipboard write (the tab isn't
 * focused), pbcopy/xclip/xsel/wl-copy exit 1 with a message instead of 0; the
 * text is kept, so pbpaste and `xclip -o` print it, and it is written when the
 * window next gets focus.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestShell } from './helpers';
import type { Shell } from '@shiro/shell';
import { pbcopyCmd, pbpasteCmd, xclipCmd, xselCmd, wlCopyCmd } from '@shiro/commands/pbcopy';
import { resetClipboard } from '@shiro/utils/clipboard';

let shell: Shell;
const nav = navigator as any;
const realClipboard = nav.clipboard;
let clip = '';
let refuse = true;

async function sh(cmd: string) {
  let out = '', err = '';
  const code = await shell.execute(cmd, (s) => { out += s; }, (s) => { err += s; });
  return { out: out.replace(/\r\n/g, '\n'), err: err.replace(/\r\n/g, '\n'), code };
}

beforeEach(async () => {
  ({ shell } = await createTestShell());
  for (const c of [pbcopyCmd, pbpasteCmd, xclipCmd, xselCmd, wlCopyCmd]) shell.commands.register(c);
  resetClipboard();
  clip = 'old';
  refuse = true;
  const notFocused = () => new DOMException('Document is not focused.', 'NotAllowedError');
  Object.defineProperty(nav, 'clipboard', { configurable: true, value: {
    readText: async () => { if (refuse) throw notFocused(); return clip; },
    writeText: async (t: string) => { if (refuse) throw notFocused(); clip = t; },
  } });
  // (execCommand('copy') has no clipboard here either)
  (document as any).execCommand = () => false;
});
afterEach(() => { Object.defineProperty(nav, 'clipboard', { configurable: true, value: realClipboard }); });

describe('a refused clipboard write', () => {
  it('pbcopy exits 1 and says why; pbpaste gives the text back', async () => {
    const r = await sh('echo -n hello | pbcopy; echo st=$?');
    expect(r.out).toBe('st=1\n');
    expect(r.err).toMatch(/^pbcopy: could not write the browser clipboard/);
    expect((await sh('pbpaste')).out).toBe('hello');
  });

  it('xclip, xsel and wl-copy too; xclip -o and xsel -o read it back', async () => {
    expect((await sh('echo -n a | xclip -selection clipboard; echo st=$?')).out).toBe('st=1\n');
    expect((await sh('xclip -selection clipboard -o')).out).toBe('a');
    expect((await sh('echo -n b | xsel -b -i; echo st=$?')).out).toBe('st=1\n');
    expect((await sh('xsel -b -o')).out).toBe('b');
    expect((await sh('echo -n c | wl-copy; echo st=$?')).out).toBe('st=1\n');
    expect((await sh('pbpaste')).out).toBe('c');
  });

  it('is written when the window gets focus', async () => {
    await sh('echo -n later | pbcopy');
    expect(clip).toBe('old');
    refuse = false;
    window.dispatchEvent(new (window as any).Event('focus'));
    await vi.waitFor(() => expect(clip).toBe('later'));
    // (then reads are the browser's again)
    clip = 'copied elsewhere';
    expect((await sh('pbpaste')).out).toBe('copied elsewhere');
  });

  it('a write that works exits 0', async () => {
    refuse = false;
    expect((await sh('echo -n ok | pbcopy; echo st=$?')).out).toBe('st=0\n');
    expect(clip).toBe('ok');
  });
});
