/**
 * Claude Code's Ctrl+V image paste, from node (in the page, and as a kernel
 * guest under vitest.worker.config.ts): it runs `xclip -t TARGETS -o | grep
 * image/...` and `xclip -t image/png -o > file` through a shell (execa,
 * shell: true), and reads the file. Those reads must run for real; only a
 * plain clipboard write goes straight to the page's clipboard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestShell } from './helpers';
import { xclipCmd, xselCmd, pbpasteCmd, pbcopyCmd } from '@shiro/commands/pbcopy';
import { resetClipboard } from '@shiro/utils/clipboard';
import { isClipboardWrite } from '@shiro/node-compat/modules/child-process';

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00, 0xc3, 0x28, 0x80];

describe("Claude Code's Ctrl+V image paste from node", () => {
  const nav = navigator as any;
  const realClipboard = nav.clipboard;
  let clip = '';
  beforeEach(() => {
    resetClipboard();
    clip = 'text on the clipboard';
    Object.defineProperty(nav, 'clipboard', {
      configurable: true,
      value: {
        readText: async () => clip,
        writeText: async (t: string) => { clip = t; },
        read: async () => [{ types: ['image/png'], getType: async () => new Blob([new Uint8Array(PNG)], { type: 'image/png' }) }],
      },
    });
  });
  afterEach(() => { Object.defineProperty(nav, 'clipboard', { configurable: true, value: realClipboard }); });

  it('a clipboard write is told from a read', () => {
    for (const c of ['pbcopy', 'xclip -selection clipboard', 'xclip -selection primary', 'xsel --clipboard --input', 'wl-copy']) expect(isClipboardWrite(c), c).toBe(true);
    for (const c of ['xclip -selection clipboard -o', 'xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/png"',
      'xclip -selection clipboard -t image/png -o > /tmp/x.png 2>/dev/null || wl-paste --type image/png > /tmp/x.png', 'xsel --output', 'pbpaste', 'echo hi']) {
      expect(isClipboardWrite(c), c).toBe(false);
    }
  });

  it('lists the image target, saves its bytes through a redirect, and copies text', async () => {
    const { shell, fs } = await createTestShell();
    for (const c of [xclipCmd, xselCmd, pbpasteCmd, pbcopyCmd]) shell.commands.register(c);
    await fs.mkdir('/tmp/ip', { recursive: true });
    await fs.writeFile('/tmp/ip/t.js', `
      const cp = require("child_process");
      // (as execa runs a command string with shell: true)
      const run = (c) => new Promise((r) => {
        const ch = cp.spawn(c, [], { shell: true });
        let o = "";
        ch.stdout.on("data", (d) => { o += d; });
        ch.on("close", (code) => r([code, o.trim()]));
      });
      (async () => {
        console.log(JSON.stringify(await run('xclip -selection clipboard -t TARGETS -o 2>/dev/null | grep -E "image/(png|jpeg|jpg|gif|webp|bmp)"')));
        console.log(JSON.stringify(await run("xclip -selection clipboard -t image/png -o > /tmp/ip/shot.png 2>/dev/null || wl-paste --type image/png > /tmp/ip/shot.png 2>/dev/null")));
        console.log(JSON.stringify([...require("fs").readFileSync("/tmp/ip/shot.png")]));
        console.log(JSON.stringify(await run("xclip -selection clipboard -t text/plain -o 2>/dev/null || wl-paste 2>/dev/null")));
        const w = cp.spawn("xclip", ["-selection", "clipboard"]);
        w.stdin.write("copied by node");
        w.stdin.end();
        w.on("close", (code) => console.log("write", code));
      })();
    `);
    let out = '', err = '';
    const code = await shell.execute('node /tmp/ip/t.js < /dev/null', (s) => { out += s; }, (s) => { err += s; });
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(out.replace(/\r\n/g, '\n').split('\n')).toEqual([
      '[0,"image/png"]',
      '[0,""]',
      JSON.stringify(PNG),
      '[0,"text on the clipboard"]',
      'write 0',
      '',
    ]);
    await vi.waitFor(() => expect(clip).toBe('copied by node'));
  }, 60_000);
});
