/**
 * split, as GNU coreutils: pieces of -l lines (1000 by default), -b bytes,
 * -C at most SIZE bytes of whole lines, or -n N chunks; suffixes of -a
 * letters (or digits with -d, hex with -x) that widen as GNU's do when
 * they run out (…yz, zaaa…), and --additional-suffix. Bytes stay as they are:
 * a piece ends where its last line's newline does.
 */
import type { Command } from './index';
import { decodeBytes, encodeText } from '../utils/byte-text';

const USAGE = "Try 'split --help' for more information.\n";

/** The index'th suffix; null once fixed-length suffixes are used up */
function suffixFor(index: number, len: number, alphabet: string, widen: boolean): string | null {
  const A = alphabet.length;
  let prefix = '';
  let L = len;
  if (widen) {
    // GNU: the last letter in the first place starts a longer run (yz, then zaaa)
    for (;;) {
      const block = (A - 1) * A ** (L - 1);
      if (index < block) break;
      index -= block;
      prefix += alphabet[A - 1];
      L++;
    }
  } else if (index >= A ** L) return null;
  let s = '';
  for (let k = 0; k < L; k++) { s = alphabet[index % A] + s; index = Math.floor(index / A); }
  return prefix + s;
}

/** SIZE: a number with an optional K/KB/KiB, M, G, T suffix, or b (512) */
function parseSize(s: string): number {
  const m = /^(\d+)(b|[KMGTPE](?:i?B)?|kB)?$/i.exec(s);
  if (!m) return NaN;
  const n = Number(m[1]);
  const u = m[2] ?? '';
  if (u === 'b') return n * 512;
  if (!u) return n;
  const pow = 'KMGTPE'.indexOf(u[0].toUpperCase()) + 1;
  return n * (/^.B$/i.test(u) && !/iB$/i.test(u) ? 1000 : 1024) ** pow;
}

export const splitCmd: Command = {
  name: 'split',
  description: 'Split a file into pieces',
  async exec(ctx) {
    const args = ctx.args;
    let lines = 0, bytes = 0, lineBytes = 0, chunks = 0;
    let suffixLen = 2, suffixLenGiven = false, alphabet = 'abcdefghijklmnopqrstuvwxyz', extra = '';
    let startAt = 0;
    const operands: string[] = [];
    const bad = (msg: string, usage = false) => { ctx.stderr += `split: ${msg}\n${usage ? USAGE : ''}`; return 1; };
    const size = (v: string | undefined) => { const n = v === undefined ? NaN : parseSize(v); return n > 0 ? n : null; };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { operands.push(...args.slice(i + 1)); break; }
      if (a === '-' || !a.startsWith('-')) { operands.push(a); continue; }
      let opt: string, val: string | undefined;
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        const take = () => (eq < 0 ? args[++i] : a.slice(eq + 1));
        const map: Record<string, string> = { lines: 'l', bytes: 'b', 'line-bytes': 'C', number: 'n', 'suffix-length': 'a' };
        if (name in map) { opt = map[name]; val = take(); }
        else if (name === 'numeric-suffixes' || name === 'hex-suffixes') {
          alphabet = name === 'hex-suffixes' ? '0123456789abcdef' : '0123456789';
          if (eq >= 0) startAt = Number(a.slice(eq + 1)) || 0;
          continue;
        }
        else if (name === 'additional-suffix') { extra = take() ?? ''; continue; }
        else if (name === 'elide-empty-files' || name === 'unbuffered' || name === 'verbose') continue;
        else return bad(`unrecognized option '${a}'`, true);
      } else {
        // a cluster: -d and -x, then one option with its value
        let k = 1;
        while (a[k] === 'd' || a[k] === 'x' || a[k] === 'e' || a[k] === 'u') {
          if (a[k] === 'd') alphabet = '0123456789';
          if (a[k] === 'x') alphabet = '0123456789abcdef';
          k++;
        }
        if (k === a.length) continue;
        opt = a[k];
        if (/^\d+$/.test(a.slice(1))) { opt = 'l'; val = a.slice(1); }
        else val = a.length > k + 1 ? a.slice(k + 1) : args[++i];
      }
      switch (opt) {
        case 'l': { const n = Number(val); if (!Number.isInteger(n) || n < 1) return bad(`invalid number of lines: '${val ?? ''}'`); lines = n; break; }
        case 'b': { const n = size(val); if (n === null) return bad(`invalid number of bytes: '${val ?? ''}'`); bytes = n; break; }
        case 'C': { const n = size(val); if (n === null) return bad(`invalid number of bytes: '${val ?? ''}'`); lineBytes = n; break; }
        case 'n': { const n = Number(val); if (!Number.isInteger(n) || n < 1) return bad(`invalid number of chunks: '${val ?? ''}'`); chunks = n; break; }
        case 'a': { const n = Number(val); if (!Number.isInteger(n) || n < 1) return bad(`invalid suffix length: '${val ?? ''}'`); suffixLen = n; suffixLenGiven = true; break; }
        default: return bad(`invalid option -- '${opt}'`, true);
      }
    }
    if (operands.length > 2) return bad(`extra operand '${operands[2]}'`, true);
    const input = operands[0] ?? '-';
    const prefix = operands[1] ?? 'x';

    let data: Uint8Array;
    if (input === '-') data = encodeText(ctx.stdin);
    else {
      try { data = encodeText(await ctx.fs.readFile(ctx.fs.resolvePath(input, ctx.cwd), 'utf8') as string); }
      catch { return bad(`cannot open '${input}' for reading: No such file or directory`); }
    }

    // The pieces, as [start, end) byte ranges
    const ranges: [number, number][] = [];
    const n = data.length;
    if (chunks) {
      const base = Math.floor(n / chunks), rem = n % chunks;
      let at = 0;
      for (let k = 0; k < chunks; k++) { const len = base + (k < rem ? 1 : 0); ranges.push([at, at + len]); at += len; }
    } else if (bytes) {
      for (let at = 0; at < n; at += bytes) ranges.push([at, Math.min(n, at + bytes)]);
    } else if (lineBytes) {
      // whole lines up to SIZE bytes; a longer line is cut at SIZE
      let at = 0;
      while (at < n) {
        let end = at;
        for (;;) {
          const nl = data.indexOf(10, end);
          const lineEnd = nl < 0 ? n : nl + 1;
          if (lineEnd - at > lineBytes) { if (end === at) end = at + lineBytes; break; }
          end = lineEnd;
          if (end >= n) break;
        }
        ranges.push([at, end]);
        at = end;
      }
    } else {
      const per = lines || 1000;
      let at = 0;
      while (at < n) {
        let end = at;
        for (let k = 0; k < per && end < n; k++) { const nl = data.indexOf(10, end); end = nl < 0 ? n : nl + 1; }
        ranges.push([at, end]);
        at = end;
      }
    }

    for (let k = 0; k < ranges.length; k++) {
      const suffix = suffixFor(startAt + k, suffixLen, alphabet, !suffixLenGiven && startAt === 0);
      if (suffix === null) return bad('output file suffixes exhausted');
      const [a, b] = ranges[k];
      const out = ctx.fs.resolvePath(prefix + suffix + extra, ctx.cwd);
      if (input !== '-' && out === ctx.fs.resolvePath(input, ctx.cwd)) return bad(`${prefix + suffix + extra} would overwrite input; aborting`);
      await ctx.fs.writeFile(out, decodeBytes(data.subarray(a, b)));
    }
    return 0;
  },
};
