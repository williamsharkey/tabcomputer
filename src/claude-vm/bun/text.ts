/**
 * Bun's terminal text helpers as Claude Code calls them: display width
 * (string-width semantics), and ANSI-aware strip, slice and wrap.
 */

// CSI (…m, …K, …), OSC (…BEL or ST), and two-byte escapes
const ANSI = /\x1b\[[0-9;:?<=>]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\x9b[0-9;?]*[@-~]/g;

export function stripANSI(s: string): string {
  return String(s).replace(ANSI, '');
}

const segmenter = typeof Intl !== 'undefined' && (Intl as any).Segmenter ? new (Intl as any).Segmenter(undefined, { granularity: 'grapheme' }) : null;
export function graphemes(s: string): string[] {
  return segmenter ? Array.from(segmenter.segment(s), (x: any) => x.segment as string) : Array.from(s);
}

const ZERO = /^(?:\p{Mn}|\p{Me}|\p{Cf}|\p{Cc})+$/u;
const EMOJI = /\p{Extended_Pictographic}/u;
const EMOJI_PRES = /️/;
/** East Asian Wide and Fullwidth ranges (the common ones) */
function isWide(cp: number): boolean {
  return (cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0x303e) || (cp >= 0x3041 && cp <= 0x33ff)
    || (cp >= 0x3400 && cp <= 0x4dbf) || (cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0xa000 && cp <= 0xa4cf)
    || (cp >= 0xa960 && cp <= 0xa97f) || (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff)
    || (cp >= 0xfe10 && cp <= 0xfe19) || (cp >= 0xfe30 && cp <= 0xfe6f) || (cp >= 0xff00 && cp <= 0xff60)
    || (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff)
    || (cp >= 0x1f680 && cp <= 0x1f6ff) || (cp >= 0x1fa70 && cp <= 0x1faff) || (cp >= 0x20000 && cp <= 0x3fffd);
}

/** Columns one grapheme takes: 0, 1 or 2 */
export function graphemeWidth(g: string): number {
  if (!g || ZERO.test(g)) return 0;
  const cp = g.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x7f) return 1;
  if (isWide(cp)) return 2;
  if (EMOJI.test(g) && (EMOJI_PRES.test(g) || g.length > 2 || cp >= 0x1f000)) return 2;
  return 1;
}

export function stringWidth(s: string, opts?: { countAnsiEscapeCodes?: boolean; ambiguousIsNarrow?: boolean }): number {
  const t = opts?.countAnsiEscapeCodes ? String(s) : stripANSI(String(s));
  let ascii = true;
  for (let i = 0; i < t.length; i++) { const c = t.charCodeAt(i); if (c < 0x20 || c >= 0x7f) { ascii = false; break; } }
  if (ascii) return t.length;
  let w = 0;
  for (const g of graphemes(t)) w += graphemeWidth(g);
  return w;
}

/** Text and escapes, in order */
function tokens(s: string): { esc: boolean; text: string }[] {
  const out: { esc: boolean; text: string }[] = [];
  let last = 0;
  for (const m of String(s).matchAll(ANSI)) {
    if (m.index! > last) out.push({ esc: false, text: s.slice(last, m.index) });
    out.push({ esc: true, text: m[0] });
    last = m.index! + m[0].length;
  }
  if (last < s.length) out.push({ esc: false, text: s.slice(last) });
  return out;
}

/** Columns [start, end) of `s`, keeping the escapes in effect (Bun.sliceAnsi) */
export function sliceAnsi(s: string, start = 0, end?: number): string {
  const total = end === undefined || end < 0 ? stringWidth(s) : end;
  if (start < 0) start = Math.max(0, stringWidth(s) + start);
  let col = 0, out = '', pending = '';
  for (const t of tokens(s)) {
    if (t.esc) { if (col >= start && col < total) out += t.text; else pending += t.text; continue; }
    for (const g of graphemes(t.text)) {
      const w = graphemeWidth(g);
      if (col >= start && col + w <= total) { if (pending) { out += pending; pending = ''; } out += g; }
      col += w;
      if (col >= total) break;
    }
  }
  // close what was opened (a trailing reset, as slice-ansi does when styles were open)
  return /\x1b\[[0-9;]*m/.test(out) && !/\x1b\[0?m$/.test(out) ? out + '\x1b[0m' : out;
}

/** Wrap to `cols` columns: at spaces, else hard (Bun.wrapAnsi, wrap-ansi's options) */
export function wrapAnsi(s: string, cols: number, opts?: { hard?: boolean; wordWrap?: boolean; trim?: boolean }): string {
  const hard = opts?.hard ?? false, wordWrap = opts?.wordWrap ?? true, trim = opts?.trim ?? true;
  if (!(cols > 0)) return String(s);
  return String(s).split('\n').map((line) => {
    if (stringWidth(line) <= cols) return trim ? line.replace(/^\s+|\s+$/g, (m) => (ANSI.test(m) ? m : '')) : line;
    const words = wordWrap ? line.split(/( +)/) : [line];
    const rows: string[] = [];
    let row = '', w = 0;
    const push = () => { rows.push(trim ? row.replace(/\s+$/, '') : row); row = ''; w = 0; };
    for (const word of words) {
      const ww = stringWidth(word);
      if (w + ww <= cols) { row += word; w += ww; continue; }
      if (/^ +$/.test(word)) { push(); continue; }
      if (w > 0) push();
      if (ww <= cols || !hard) { row = word; w = ww; continue; }
      for (let i = 0; i < ww; i += cols) { const piece = sliceAnsi(word, i, Math.min(ww, i + cols)); if (i + cols < ww) rows.push(piece); else { row = piece; w = stringWidth(piece); } }
    }
    if (row || !rows.length) push();
    return rows.join('\n');
  }).join('\n');
}
