/**
 * hexdump: util-linux's formats. -C (canonical hex+ASCII), -x (the default,
 * two-byte words, little-endian as on x86), -c, -b, -d, -o; -n, -s, -v.
 * Repeated lines are squeezed to "*" unless -v.
 */
import type { Command } from './index';
import { encodeText } from '../utils/byte-text';

const C_ESC: Record<number, string> = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };

/** A format: its offset column, and one line of up to 16 bytes */
interface Fmt { offset: (n: number) => string; line: (b: Uint8Array) => string }
const word = (b: Uint8Array, i: number) => b[i] | ((b[i + 1] ?? 0) << 8);
/** Two-byte words, `cell` each, padded to a full line's width */
const words = (cell: (w: number) => string) => (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < 16; i += 2) s += i < b.length ? cell(word(b, i)) : ' '.repeat(cell(0).length);
  return s;
};
const bytes = (cell: (x: number) => string) => (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < 16; i++) s += i < b.length ? cell(b[i]) : ' '.repeat(cell(0).length);
  return s;
};
const off7 = (n: number) => n.toString(16).padStart(7, '0');
const FORMATS: Record<string, Fmt> = {
  default: { offset: off7, line: words((w) => ' ' + w.toString(16).padStart(4, '0')) },
  x: { offset: off7, line: words((w) => '    ' + w.toString(16).padStart(4, '0')) },
  d: { offset: off7, line: words((w) => '   ' + String(w).padStart(5, '0')) },
  o: { offset: off7, line: words((w) => '  ' + w.toString(8).padStart(6, '0')) },
  b: { offset: off7, line: bytes((x) => ' ' + x.toString(8).padStart(3, '0')) },
  c: {
    offset: off7,
    line: bytes((x) => (C_ESC[x] ?? (x >= 32 && x < 127 ? String.fromCharCode(x) : x.toString(8).padStart(3, '0'))).padStart(4)),
  },
  C: {
    offset: (n) => n.toString(16).padStart(8, '0'),
    line: (b) => {
      let hex = ' ';
      for (let i = 0; i < 16; i++) hex += (i === 8 ? ' ' : '') + (i < b.length ? ' ' + b[i].toString(16).padStart(2, '0') : '   ');
      let ascii = '';
      for (const x of b) ascii += x >= 32 && x < 127 ? String.fromCharCode(x) : '.';
      return `${hex}  |${ascii}|`;
    },
  },
};

/** util-linux's numbers: decimal, 0x hex or 0 octal, with an optional b/k/m suffix */
function parseCount(s: string): number {
  const m = /^(0x[0-9a-f]+|0[0-7]*|[1-9][0-9]*)([bkm]?)$/i.exec(s);
  if (!m) return NaN;
  const n = m[1].toLowerCase().startsWith('0x') ? parseInt(m[1], 16) : m[1].length > 1 && m[1][0] === '0' ? parseInt(m[1], 8) : parseInt(m[1], 10);
  return n * ({ b: 512, k: 1024, m: 1048576 }[m[2].toLowerCase() as 'b'] ?? 1);
}

export const hexdump: Command = {
  name: 'hexdump',
  description: 'Display file contents in hexadecimal',
  async exec(ctx) {
    const formats: Fmt[] = [];
    let length = Infinity, skip = 0, verbose = false;
    const files: string[] = [];
    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a === '--canonical') { formats.push(FORMATS.C); continue; }
      if (a === '--no-squeezing') { verbose = true; continue; }
      if (!a.startsWith('-') || a === '-') { files.push(a); continue; }
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (ch === 'n' || ch === 's') {
          const v = a.slice(j + 1) || args[++i];
          const n = v === undefined ? NaN : parseCount(v);
          if (!Number.isFinite(n)) { ctx.stderr += `hexdump: invalid ${ch === 'n' ? 'length' : 'offset'} argument: '${v ?? ''}'\n`; return 1; }
          if (ch === 'n') length = n; else skip = n;
          break;
        }
        if (ch === 'v') verbose = true;
        else if ('Cxdobc'.includes(ch)) formats.push(FORMATS[ch]);
        else { ctx.stderr += `hexdump: invalid option -- '${ch}'\nTry 'hexdump --help' for more information.\n`; return 1; }
      }
    }
    if (!formats.length) formats.push(FORMATS.default);

    // The input: the files one after another, else stdin
    const chunks: Uint8Array[] = [];
    let failed = 0;
    if (!files.length) chunks.push(encodeText(ctx.stdin));
    for (const f of files) {
      try {
        chunks.push(encodeText(await ctx.fs.readFile(ctx.fs.resolvePath(f, ctx.cwd), 'utf8') as string));
      } catch {
        ctx.stderr += `hexdump: ${f}: No such file or directory\n`;
        failed++;
      }
    }
    if (files.length && failed === files.length) { ctx.stderr += 'hexdump: all input file arguments failed\n'; return 1; }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const all = new Uint8Array(total);
    let p = 0;
    for (const c of chunks) { all.set(c, p); p += c.length; }
    const data = all.subarray(Math.min(skip, total), Math.min(total, skip + length));
    if (!data.length) return failed ? 1 : 0;

    const out: string[] = [];
    let prev: Uint8Array | null = null, squeezed = false;
    for (let i = 0; i < data.length; i += 16) {
      const b = data.subarray(i, i + 16);
      // A full line the same as the one before it: one "*" for the run
      if (!verbose && prev && b.length === 16 && b.every((x, k) => x === prev![k])) {
        if (!squeezed) out.push('*');
        squeezed = true;
        continue;
      }
      squeezed = false;
      prev = b;
      for (const f of formats) out.push(f.offset(skip + i) + f.line(b));
    }
    out.push(formats[formats.length - 1].offset(skip + data.length));
    ctx.stdout += out.join('\n') + '\n';
    return failed ? 1 : 0;
  },
};
