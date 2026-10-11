/**
 * pbcopy / pbpaste / xclip / xsel / wl-copy on the browser clipboard.
 *
 * Programs like Claude Code shell out to these to copy and paste. Native
 * Claude Code probes xclip, then xsel, before falling back to a native
 * clipboard addon that hangs under the x86 emulator, so xclip and xsel
 * answer everything they're asked: text, and an image on the clipboard for
 * `xclip -t TARGETS -o` and `xclip -t image/png -o` (Claude Code's image
 * paste); a text read that can't be done (no permission) prints nothing
 * instead of failing into that fallback. A write the browser refuses (the tab isn't focused)
 * exits 1 with a message; the text is kept, so pbpaste and `xclip -o` give
 * it back, and it reaches the browser when the window next gets focus
 * (utils/clipboard.ts).
 *
 *   echo hi | pbcopy        xclip -selection clipboard -o        xsel -b -i
 */

import { Command, CommandContext } from './index';
import { readClipboard, readClipboardImage, writeClipboard } from '../utils/clipboard';
import { decodeBytes } from '../utils/byte-text';

/** Write the clipboard; on a refusal say so (the text is kept and retried on focus): exit 1 */
async function copy(ctx: CommandContext, name: string, text: string): Promise<number> {
  if (await writeClipboard(text)) return 0;
  ctx.stderr += `${name}: could not write the browser clipboard (is the tab focused?); kept here: it is written when the tab gets focus, and ${name === 'xclip' ? 'xclip -o' : name === 'xsel' ? 'xsel -o' : 'pbpaste'} prints it\n`;
  return 1;
}

async function copyStdin(ctx: CommandContext, name: string): Promise<number> {
  if (ctx.args.includes('-o') || ctx.args.includes('--paste')) {
    ctx.stdout += await readClipboard();
    return 0;
  }
  return copy(ctx, name, ctx.stdin || '');
}

const make = (name: string): Command => ({
  name,
  description: 'Copy stdin to the clipboard',
  exec: (ctx) => copyStdin(ctx, name),
});

export const pbcopyCmd = make('pbcopy');
export const wlCopyCmd = make('wl-copy');

export const pbpasteCmd: Command = {
  name: 'pbpaste',
  description: 'Print the clipboard',
  async exec(ctx) { ctx.stdout += await readClipboard(); return 0; },
};

const TEXT_TARGETS = ['TARGETS', 'UTF8_STRING', 'STRING', 'TEXT', 'text/plain', 'text/plain;charset=utf-8'];

export const xclipCmd: Command = {
  name: 'xclip',
  description: 'Copy to or paste from the clipboard (xclip-compatible: text, and images out)',
  async exec(ctx) {
    let out = false;
    let target: string | null = null;
    const files: string[] = [];
    const a = ctx.args;
    for (let i = 0; i < a.length; i++) {
      const arg = a[i].replace(/^--/, '-');
      if (/^-o(ut)?$/.test(arg)) out = true;
      else if (/^-(i(n)?|f(ilter)?|silent|quiet|verbose|noutf8|r(mlastnl)?)$/.test(arg)) { /* the defaults */ }
      else if (/^-(sel(ection)?|d(isplay)?|l(oops)?)$/.test(arg)) i++; // one clipboard
      else if (/^-t(arget)?$/.test(arg)) target = a[++i] ?? null;
      else if (arg === '-h' || arg === '-help') {
        ctx.stdout += 'Usage: xclip [-i|-o] [-selection clipboard|primary] [-t target] [file ...]\n'
          + 'Copies stdin or files to the clipboard, or prints it with -o (text only).\n';
        return 0;
      } else if (arg === '-version') { ctx.stdout += 'xclip version 0.13 (tabcomputer: the browser clipboard)\n'; return 0; }
      else if (a[i].startsWith('-') && a[i] !== '-') { ctx.stderr += `xclip: unknown option ${a[i]}\n`; return 1; }
      else files.push(a[i]);
    }
    if (out) {
      // An image on the clipboard is a target too (Claude Code's image paste lists the
      // targets, then saves `-t image/png -o > file`)
      if (target === 'TARGETS') {
        const image = await readClipboardImage();
        ctx.stdout += [...TEXT_TARGETS, ...(image ? [image.type] : [])].join('\n') + '\n';
        return 0;
      }
      if (target && /^image\//i.test(target)) {
        const image = await readClipboardImage();
        if (image && image.type.toLowerCase() === target.toLowerCase()) {
          if (ctx.stdoutBytes) ctx.stdoutBytes(image.bytes);
          else ctx.stdout += decodeBytes(image.bytes); // (byte-exact: a redirect writes the same bytes)
          return 0;
        }
      }
      if (target && !/^(UTF8_STRING|STRING|TEXT|text\/plain)/i.test(target)) {
        ctx.stderr += `Error: target ${target} not available\n`;
        return 1;
      }
      ctx.stdout += await readClipboard();
      return 0;
    }
    let text = files.length ? '' : ctx.stdin;
    for (const f of files) {
      try { text += await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string; } catch {
        ctx.stderr += `xclip: ${f}: No such file or directory\n`;
        return 1;
      }
    }
    return copy(ctx, 'xclip', text);
  },
};

export const xselCmd: Command = {
  name: 'xsel',
  description: 'Copy to or paste from the clipboard (xsel-compatible, text only)',
  async exec(ctx) {
    let mode: 'in' | 'out' | 'clear' | null = null;
    for (const arg of ctx.args) {
      if (arg === '-i' || arg === '--input') mode = 'in';
      else if (arg === '-o' || arg === '--output') mode = 'out';
      else if (arg === '-c' || arg === '--clear' || arg === '-d' || arg === '--delete') mode = 'clear';
      else if (arg === '-h' || arg === '--help') {
        ctx.stdout += 'Usage: xsel [-b|-p|-s] [-i|-o|-c]\nCopies stdin to the clipboard (-i) or prints it (-o; the default when nothing is piped in).\n';
        return 0;
      } else if (arg === '--version') { ctx.stdout += 'xsel version 1.2 (tabcomputer: the browser clipboard)\n'; return 0; }
      else if (/^-[bpsakfnvtl]+$|^--(clipboard|primary|secondary|append|keep|follow|nodetach|verbose|logfile|display|selectionTimeout|trim)/.test(arg)) { /* one clipboard */ }
      else { ctx.stderr += `xsel: unknown option ${arg}\n`; return 1; }
    }
    if (mode === null) mode = ctx.stdin ? 'in' : 'out';
    if (mode === 'out') { ctx.stdout += await readClipboard(); return 0; }
    return copy(ctx, 'xsel', mode === 'clear' ? '' : ctx.stdin);
  },
};
