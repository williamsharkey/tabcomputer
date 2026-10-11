/**
 * Bun.stringWidth, stripANSI, sliceAnsi and wrapAnsi: string-width,
 * strip-ansi, slice-ansi and wrap-ansi's semantics, which Bun's own follow.
 * Claude Code's renderer calls them on every frame, so plain printable ASCII
 * (most of its text) takes a path that touches no regular expression engine
 * beyond one test.
 */
import stringWidthLib from 'string-width';
import stripAnsiLib from 'strip-ansi';
import sliceAnsiLib from 'slice-ansi';
import wrapAnsiLib from 'wrap-ansi';

export interface StringWidthOptions { ambiguousIsNarrow?: boolean; countAnsiEscapeCodes?: boolean }
export interface WrapAnsiOptions { hard?: boolean; wordWrap?: boolean; trim?: boolean }

let segmenter: Intl.Segmenter | null = null;
const graphemes = () => (segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' }));

/** Printable ASCII only: one column a character */
const PLAIN = /^[\x20-\x7e]*$/;

export function stringWidth(s: unknown, opts: StringWidthOptions = {}): number {
  const str = typeof s === 'string' ? s : String(s ?? '');
  if (PLAIN.test(str)) return str.length;
  return stringWidthLib(str, { ambiguousIsNarrow: opts.ambiguousIsNarrow ?? true, countAnsiEscapeCodes: opts.countAnsiEscapeCodes ?? false });
}

export function stripANSI(s: unknown): string {
  const str = typeof s === 'string' ? s : String(s ?? '');
  // (no ESC and no CSI introducer: nothing to strip)
  if (str.indexOf('\x1b') < 0 && str.indexOf('\x9b') < 0) return str;
  return stripAnsiLib(str);
}

/** The columns [start, end) of `s`, its SGR styles kept open and closed as they were */
export function sliceAnsi(s: unknown, start?: number, end?: number): string {
  const str = typeof s === 'string' ? s : String(s ?? '');
  if (PLAIN.test(str)) return str.slice(start ?? 0, end);
  const from = start ?? 0;
  if (end === undefined) return sliceAnsiLib(str, from);
  // Bun keeps a wide character that starts before `end` and runs past it (slice-ansi drops
  // it): the cut moves to that character's end
  let col = 0, cut = end;
  for (const { segment } of graphemes().segment(stripANSI(str))) {
    if (col >= end) break;
    const w = stringWidth(segment);
    if (col + w > end) { cut = col + w; break; }
    col += w;
  }
  return sliceAnsiLib(str, from, cut);
}

export function wrapAnsi(s: unknown, columns: number, opts: WrapAnsiOptions = {}): string {
  const str = typeof s === 'string' ? s : String(s ?? '');
  return wrapAnsiLib(str, columns, opts);
}
