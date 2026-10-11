/**
 * join: GNU's merge join of two files sorted on their join fields.
 * -1/-2/-j, -t, -a, -v, -e, -o (a list or `auto`), -i, --header; `-` is stdin.
 */
import type { Command } from './index';
import { readFileText } from './flags';

const USAGE = "Try 'join --help' for more information.\n";

export const join: Command = {
  name: 'join',
  description: 'Join lines of two files on a common field',
  async exec(ctx) {
    const args = ctx.args;
    let field1 = 0, field2 = 0, sep: string | null = null, empty: string | null = null;
    let format: string | null = null, ignoreCase = false, header = false;
    const unpaired = new Set<number>();
    let onlyUnpaired = false;
    const files: string[] = [];
    const fieldNum = (v: string): number | null => {
      const n = Number(v);
      if (!v || !Number.isInteger(n) || n < 1) { ctx.stderr += `join: invalid field number: '${v}'\n`; return null; }
      return n - 1;
    };
    const fileNum = (v: string): number | null => {
      if (v !== '1' && v !== '2') { ctx.stderr += `join: invalid file number: '${v}'\n`; return null; }
      return Number(v);
    };
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a === '-' || !a.startsWith('-')) { files.push(a); continue; }
      const long = /^--([a-z-]+)(?:=(.*))?$/.exec(a);
      let opt: string, val: string | undefined;
      if (long) {
        const name = long[1];
        if (name === 'ignore-case') { ignoreCase = true; continue; }
        if (name === 'header') { header = true; continue; }
        if (name === 'check-order' || name === 'nocheck-order' || name === 'zero-terminated') continue;
        ctx.stderr += `join: unrecognized option '${a}'\n${USAGE}`;
        return 1;
      }
      // a cluster of short options: -i, then one that takes the rest or the next argument
      let k = 1;
      while (a[k] === 'i') { ignoreCase = true; k++; }
      if (k === a.length) continue;
      opt = a[k];
      if (!'12jtaveo'.includes(opt)) { ctx.stderr += `join: invalid option -- '${opt}'\n${USAGE}`; return 1; }
      val = a.length > k + 1 ? a.slice(k + 1) : args[++i];
      if (val === undefined) { ctx.stderr += `join: option requires an argument -- '${opt}'\n${USAGE}`; return 1; }
      let n: number | null;
      switch (opt) {
        case '1': if ((n = fieldNum(val)) === null) return 1; field1 = n; break;
        case '2': if ((n = fieldNum(val)) === null) return 1; field2 = n; break;
        case 'j': if ((n = fieldNum(val)) === null) return 1; field1 = field2 = n; break;
        case 't':
          if (val.length > 1 && val !== '\\0') { ctx.stderr += `join: multi-character tab '${val}'\n`; return 1; }
          sep = val === '\\0' ? '\0' : val;
          break;
        case 'a': if ((n = fileNum(val)) === null) return 1; unpaired.add(n); break;
        case 'v': if ((n = fileNum(val)) === null) return 1; unpaired.add(n); onlyUnpaired = true; break;
        case 'e': empty = val; break;
        case 'o': format = format === null ? val : `${format},${val}`; break;
      }
    }
    if (files.length < 2) {
      ctx.stderr += files.length ? `join: missing operand after '${files[0]}'\n${USAGE}` : `join: missing operand\n${USAGE}`;
      return 1;
    }
    if (files.length > 2) { ctx.stderr += `join: extra operand '${files[2]}'\n${USAGE}`; return 1; }

    const read = async (f: string): Promise<string | null> => {
      if (f === '-') return ctx.stdin;
      try { return await readFileText(ctx.fs, ctx.fs.resolvePath(f, ctx.cwd)); }
      catch { ctx.stderr += `join: ${f}: No such file or directory\n`; return null; }
    };
    const text1 = await read(files[0]);
    if (text1 === null) return 1;
    const text2 = files[1] === '-' && files[0] === '-' ? '' : await read(files[1]);
    if (text2 === null) return 1;

    const split = (line: string): string[] => {
      if (sep !== null) return sep === '' ? [line] : line.split(sep);
      const t = line.replace(/^[ \t]+/, '');
      return t === '' ? [] : t.replace(/[ \t]+$/, '').split(/[ \t]+/);
    };
    const toRecords = (text: string) => {
      const lines = text.split('\n');
      if (lines[lines.length - 1] === '') lines.pop();
      return lines.map(split);
    };
    const recs1 = toRecords(text1), recs2 = toRecords(text2);
    const outSep = sep ?? ' ';
    const fill = empty ?? '';
    const keyOf = (r: string[], f: number) => { const k = r[f] ?? ''; return ignoreCase ? k.toLowerCase() : k; };
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

    // -o auto: as many fields as each file's first line has
    let spec: [number, number][] | null = null;
    if (format === 'auto') {
      const n1 = recs1[0]?.length ?? 0, n2 = recs2[0]?.length ?? 0;
      spec = [[0, 0]];
      for (let i = 0; i < n1; i++) if (i !== field1) spec.push([1, i]);
      for (let i = 0; i < n2; i++) if (i !== field2) spec.push([2, i]);
    } else if (format !== null) {
      spec = [];
      for (const s of format.split(/[,\s]+/).filter(Boolean)) {
        const m = /^(?:0|([12])\.(\d+))$/.exec(s);
        if (!m || (m[2] !== undefined && Number(m[2]) < 1)) { ctx.stderr += `join: invalid field specifier: '${s}'\n`; return 1; }
        spec.push(m[1] ? [Number(m[1]), Number(m[2]) - 1] : [0, 0]);
      }
    }

    const out: string[] = [];
    const emit = (r1: string[] | null, r2: string[] | null) => {
      if (spec) {
        out.push(spec.map(([f, i]) => {
          if (f === 0) return (r1 ? r1[field1] : r2![field2]) ?? fill;
          const r = f === 1 ? r1 : r2;
          return r?.[i] ?? fill;
        }).join(outSep));
        return;
      }
      const parts: string[] = [];
      const key = r1 ? r1[field1] : r2![field2];
      parts.push(key ?? fill);
      if (r1) r1.forEach((x, i) => { if (i !== field1) parts.push(x); });
      if (r2) r2.forEach((x, i) => { if (i !== field2) parts.push(x); });
      out.push(parts.join(outSep));
    };

    let i = 0, j = 0;
    if (header) {
      if (recs1.length || recs2.length) emit(recs1[0] ?? null, recs2[0] ?? null);
      i = j = 1;
    }
    while (i < recs1.length && j < recs2.length) {
      const k1 = keyOf(recs1[i], field1), k2 = keyOf(recs2[j], field2);
      const c = cmp(k1, k2);
      if (c < 0) { if (unpaired.has(1)) emit(recs1[i], null); i++; continue; }
      if (c > 0) { if (unpaired.has(2)) emit(null, recs2[j]); j++; continue; }
      // The runs of lines with this key in each file: every pair
      let i2 = i, j2 = j;
      while (i2 < recs1.length && keyOf(recs1[i2], field1) === k1) i2++;
      while (j2 < recs2.length && keyOf(recs2[j2], field2) === k2) j2++;
      if (!onlyUnpaired) for (let a = i; a < i2; a++) for (let b = j; b < j2; b++) emit(recs1[a], recs2[b]);
      i = i2; j = j2;
    }
    if (unpaired.has(1)) for (; i < recs1.length; i++) emit(recs1[i], null);
    if (unpaired.has(2)) for (; j < recs2.length; j++) emit(null, recs2[j]);

    ctx.stdout += out.map((l) => l + '\n').join('');
    return 0;
  },
};
