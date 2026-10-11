/**
 * Reading stdin only as far as a command needs (ctx.stdinStream, given to
 * head, grep and sed by execLazyStdin in src/shell-stdio.ts). The command
 * stops reading once it has what it needs; its process then closes the pipe
 * and an endless writer gets SIGPIPE (tabcomputer#72). What was read becomes
 * ctx.stdin, so the command's usual code handles it unchanged.
 */
import type { CommandContext } from './index';
import { decodeBytes } from '../utils/byte-text';

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Read until `enough` returns true for the lines completed so far (called
 * with each new batch of them, without their line ends; at EOF a last line
 * without one), or to EOF. Then ctx.stdin is the text read. False when stdin
 * isn't a stream (the caller reads ctx.stdin as before). `keep` false: ctx.stdin is
 * left empty and nothing is held (the caller handled each batch itself).
 */
export async function takeStdinLines(ctx: CommandContext, enough: (lines: string[]) => boolean, eol = 0x0a, keep = true): Promise<boolean> {
  const stream = ctx.stdinStream;
  if (!stream) return false;
  const chunks: Uint8Array[] = [];
  let total = 0;
  let pending: Uint8Array[] = []; // bytes after the last line end
  let pendingLen = 0;
  for (;;) {
    const c = await stream.read();
    if (!c) {
      if (pendingLen) enough([decodeBytes(concat(pending, pendingLen))]);
      break;
    }
    // (`keep` false: the caller has used every batch; an endless stream isn't held in memory)
    if (keep) { chunks.push(c); total += c.length; }
    const last = c.lastIndexOf(eol);
    if (last < 0) { pending.push(c); pendingLen += c.length; continue; }
    // Complete lines: what was pending plus this chunk up to its last line end (a line end
    // byte never sits inside a UTF-8 sequence, so the batch decodes on its own)
    const batch = concat([...pending, c.subarray(0, last)], pendingLen + last);
    pending = last + 1 < c.length ? [c.subarray(last + 1)] : [];
    pendingLen = c.length - last - 1;
    const text = decodeBytes(batch);
    if (enough(text.split(String.fromCharCode(eol)))) break;
  }
  ctx.stdin = decodeBytes(concat(chunks, total));
  return true;
}

/** Read at least `n` bytes (or to EOF); then ctx.stdin is what was read. False when stdin isn't a stream. */
export async function takeStdinBytes(ctx: CommandContext, n: number): Promise<boolean> {
  const stream = ctx.stdinStream;
  if (!stream) return false;
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < n) {
    const c = await stream.read();
    if (!c) break;
    chunks.push(c);
    total += c.length;
  }
  ctx.stdin = decodeBytes(concat(chunks, total));
  return true;
}
