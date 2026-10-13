/**
 * psql's output formats: aligned (the default table), unaligned (-A),
 * expanded (\x) and CSV, laid out as PostgreSQL's psql lays them out.
 */
import type { Column } from './wire';

export interface FormatOptions {
  format: 'aligned' | 'unaligned' | 'csv';
  expanded: boolean;
  tuplesOnly: boolean;
  fieldSep: string;
  /** What NULL prints as */
  nullText: string;
}

export const defaultFormat = (): FormatOptions => ({ format: 'aligned', expanded: false, tuplesOnly: false, fieldSep: '|', nullText: '' });

/** Type OIDs psql right-aligns: the integer, float, numeric, money and oid types */
const NUMERIC = new Set([20, 21, 23, 26, 28, 700, 701, 790, 1700]);

const width = (s: string): number => [...s].length;
const pad = (s: string, w: number, right = false): string => (right ? ' '.repeat(Math.max(0, w - width(s))) + s : s + ' '.repeat(Math.max(0, w - width(s))));

export interface Table {
  title?: string;
  columns: Column[];
  rows: (string | null)[][];
  /** Lines after the table instead of the row count (\d's Indexes: ...) */
  footers?: string[];
}

function rowCount(n: number): string { return `(${n} row${n === 1 ? '' : 's'})`; }

function csvCell(s: string): string { return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

export function formatTable(t: Table, o: FormatOptions): string {
  const cell = (v: string | null) => v ?? o.nullText;
  if (o.format === 'csv') {
    let out = o.tuplesOnly ? '' : t.columns.map((c) => csvCell(c.name)).join(',') + '\n';
    for (const r of t.rows) out += r.map((v) => csvCell(cell(v))).join(',') + '\n';
    return out;
  }
  if (o.expanded) return formatExpanded(t, o);
  if (o.format === 'unaligned') {
    let out = '';
    if (!o.tuplesOnly) {
      if (t.title) out += t.title + '\n';
      out += t.columns.map((c) => c.name).join(o.fieldSep) + '\n';
    }
    for (const r of t.rows) out += r.map(cell).join(o.fieldSep) + '\n';
    if (!o.tuplesOnly) out += t.footers ? t.footers.join('\n') + (t.footers.length ? '\n' : '') : rowCount(t.rows.length) + '\n';
    return out;
  }
  // aligned
  const n = t.columns.length;
  const right = t.columns.map((c) => NUMERIC.has(c.typeOid));
  const cells = t.rows.map((r) => r.map((v) => cell(v).split('\n')));
  const widths = t.columns.map((c, i) => Math.max(...c.name.split('\n').map(width), ...cells.map((r) => Math.max(0, ...r[i].map(width)))));
  let out = '';
  const total = widths.reduce((a, w) => a + w + 2, 0) + Math.max(0, n - 1);
  if (!o.tuplesOnly) {
    if (t.title) out += ' '.repeat(Math.max(0, Math.floor((total - width(t.title)) / 2))) + t.title + '\n';
    out += t.columns.map((c, i) => {
      const left = Math.floor((widths[i] - width(c.name)) / 2);
      return ' ' + ' '.repeat(left) + c.name + ' '.repeat(widths[i] - width(c.name) - left) + ' ';
    }).join('|') + '\n';
    out += widths.map((w) => '-'.repeat(w + 2)).join('+') + '\n';
  }
  for (const r of cells) {
    const lines = Math.max(1, ...r.map((c) => c.length));
    for (let l = 0; l < lines; l++) {
      let line = '';
      for (let i = 0; i < n; i++) {
        const text = r[i][l] ?? '';
        const more = l + 1 < r[i].length;
        const last = i === n - 1;
        // a line of a value that goes on ends in "+"; the last column is not padded
        let body = pad(text, widths[i], right[i] && r[i].length === 1);
        if (last && !more && !right[i]) body = text;
        line += ' ' + body + (more ? '+' : last ? '' : ' ') + (last ? '' : '|');
      }
      out += line + '\n';
    }
  }
  if (!o.tuplesOnly) out += t.footers ? t.footers.join('\n') + (t.footers.length ? '\n' : '') : rowCount(t.rows.length) + '\n';
  return out + '\n';
}

function formatExpanded(t: Table, o: FormatOptions): string {
  const cell = (v: string | null) => v ?? o.nullText;
  if (!t.rows.length) return o.tuplesOnly ? '' : '(0 rows)\n\n';
  const names = t.columns.map((c) => c.name);
  if (o.format === 'unaligned') {
    return t.rows.map((r) => r.map((v, i) => `${names[i]}${o.fieldSep}${cell(v)}`).join('\n')).join('\n\n') + '\n';
  }
  const nameW = Math.max(...names.map(width));
  const valueW = Math.max(...t.rows.flatMap((r) => r.flatMap((v) => cell(v).split('\n').map(width))));
  let out = t.title && !o.tuplesOnly ? t.title + '\n' : '';
  t.rows.forEach((r, k) => {
    if (!o.tuplesOnly) {
      const head = `-[ RECORD ${k + 1} ]`;
      // the rule under it is as wide as the record; its "+" shows only where the heading leaves room
      const total = nameW + 3 + valueW;
      out += (head.length <= nameW + 1
        ? head + '-'.repeat(nameW + 1 - head.length) + '+' + '-'.repeat(valueW + 1)
        : head + '-'.repeat(Math.max(0, total - head.length))) + '\n';
    } else if (k > 0) out += '\n';
    r.forEach((v, i) => {
      const lines = cell(v).split('\n');
      lines.forEach((line, l) => { out += `${pad(l === 0 ? names[i] : '', nameW)} | ${line}\n`; });
    });
  });
  return out + '\n';
}
