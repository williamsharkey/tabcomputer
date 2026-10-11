/**
 * truncate, as GNU coreutils: -s [+-<>/%]SIZE, -r REF (with -s a relative
 * size is applied to REF's), -c (don't create). A file grows with NUL bytes.
 */
import type { Command } from './index';
import { decodeBytes, encodeText } from '../utils/byte-text';

const USAGE = "Try 'truncate --help' for more information.\n";

/** SIZE with K/KB/KiB, M, G, T suffixes (K = 1024, KB = 1000) */
function parseSize(s: string): number {
  const m = /^(\d+)([KMGTPE](?:i?B)?|kB)?$/i.exec(s);
  if (!m) return NaN;
  const u = m[2] ?? '';
  if (!u) return Number(m[1]);
  const pow = 'KMGTPE'.indexOf(u[0].toUpperCase()) + 1;
  return Number(m[1]) * (/^.B$/i.test(u) ? 1000 : 1024) ** pow;
}

export const truncateCmd: Command = {
  name: 'truncate',
  description: 'Shrink or extend the size of a file',
  async exec(ctx) {
    const args = ctx.args;
    let sizeArg: string | null = null, ref: string | null = null, noCreate = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      const long = /^--(size|reference|no-create|io-blocks)(?:=(.*))?$/.exec(a);
      if (long) {
        if (long[1] === 'no-create') noCreate = true;
        else if (long[1] === 'size') sizeArg = long[2] ?? args[++i] ?? '';
        else if (long[1] === 'reference') ref = long[2] ?? args[++i] ?? '';
        continue;
      }
      if (a.length < 2 || a[0] !== '-') { files.push(a); continue; }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'c') noCreate = true;
        else if (c === 'o') { /* -o: blocks; sizes here are bytes */ }
        else if (c === 's' || c === 'r') {
          const v = a.slice(j + 1) || args[++i];
          if (v === undefined) { ctx.stderr += `truncate: option requires an argument -- '${c}'\n${USAGE}`; return 1; }
          if (c === 's') sizeArg = v; else ref = v;
          break;
        } else { ctx.stderr += `truncate: invalid option -- '${c}'\n${USAGE}`; return 1; }
      }
    }
    if (sizeArg === null && ref === null) { ctx.stderr += `truncate: you must specify either '--size' or '--reference'\n${USAGE}`; return 1; }
    if (!files.length) { ctx.stderr += `truncate: missing file operand\n${USAGE}`; return 1; }

    let op = '', amount = 0;
    if (sizeArg !== null) {
      const m = /^([-+<>/%]?)(.*)$/.exec(sizeArg)!;
      op = m[1];
      amount = parseSize(m[2]);
      if (!Number.isFinite(amount)) { ctx.stderr += `truncate: Invalid number: '${sizeArg}'\n`; return 1; }
      if ((op === '/' || op === '%') && amount === 0) { ctx.stderr += 'truncate: division by zero\n'; return 1; }
    }
    let refSize: number | null = null;
    if (ref !== null) {
      try { refSize = (await ctx.fs.stat(ctx.fs.resolvePath(ref, ctx.cwd))).size; }
      catch { ctx.stderr += `truncate: cannot stat '${ref}': No such file or directory\n`; return 1; }
      if (sizeArg !== null && op !== '' && op !== '+' && op !== '-') {
        ctx.stderr += 'truncate: you must specify a relative \'--size\' with \'--reference\'\n'; return 1;
      }
    }

    let status = 0;
    for (const f of files) {
      const path = ctx.fs.resolvePath(f, ctx.cwd);
      let data: Uint8Array | null = null;
      try { data = encodeText(await ctx.fs.readFile(path, 'utf8') as string); } catch { /* missing */ }
      if (!data) {
        if (noCreate) continue;
        data = new Uint8Array(0);
      }
      const cur = refSize ?? data.length;
      let want: number;
      switch (op) {
        case '+': want = cur + amount; break;
        case '-': want = Math.max(0, cur - amount); break;
        case '<': want = Math.min(cur, amount); break;
        case '>': want = Math.max(cur, amount); break;
        case '/': want = Math.floor(cur / amount) * amount; break;
        case '%': want = Math.ceil(cur / amount) * amount; break;
        default: want = sizeArg === null ? cur : amount;
      }
      if (want === data.length) {
        // nothing to change, but a missing file is created
        if (data.length === 0) {
          try { await ctx.fs.writeFile(path, ''); } catch { ctx.stderr += `truncate: cannot open '${f}' for writing: No such file or directory\n`; status = 1; }
        }
        continue;
      }
      const out = new Uint8Array(want);
      out.set(data.subarray(0, Math.min(want, data.length)));
      try { await ctx.fs.writeFile(path, decodeBytes(out)); }
      catch { ctx.stderr += `truncate: cannot open '${f}' for writing: No such file or directory\n`; status = 1; }
    }
    return status;
  },
};
