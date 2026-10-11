/**
 * Bun.ant.CellSegmenter: what Claude Code's renderer (2.1.296) splits styled
 * text into terminal cells with. Anthropic's own Bun build has it natively;
 * this is its contract as the renderer uses it (docs/CLAUDE_VM.md):
 *
 *   new CellSegmenter({ ambiguousIsNarrow, substitute, screen })
 *     substitute: [lo, hi] code point ranges to drop (bidi controls)
 *     screen: { widthMask, narrow, wide, spacerTail, spacerHead,
 *               emptyCharIndex, spacerCharIndex, emptyWord, tabWidth }
 *   .graphemes / .sgrKeys / .sgrCloseKeys / .uris   tables that only grow
 *     (index 0 of the last three: no style, no link). A style key is its SGR
 *     escapes joined by "\0", its close key the matching resets.
 *   .segment(text, cells, runs, reordered) → cell count, or -count when the
 *     arrays are too small. cells[2i] = grapheme index, cells[2i+1] = width
 *     (bits 0-7) | 256 for a tab | run index << 10; runs[2r] = style key
 *     index, runs[2r+1] = link index. Escapes other than SGR and OSC 8 are
 *     dropped, as are control characters. (`reordered`, bidi display order,
 *     is not done: cells stay in logical order.)
 *   .paint(screenCells, screenWidth, x, y, cells, count, _, charIds, runWords)
 *     writes the cells into a screen row (two ints per cell: char id, then
 *     runWord | width code) and returns endX + firstCol·2^20 + endCol·2^36.
 */
import { stringWidth } from './text';

let segmenter: Intl.Segmenter | null = null;
const splitGraphemes = (s: string) => Array.from((segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })).segment(s), (x) => x.segment);

interface ScreenOpts {
  widthMask: number; narrow: number; wide: number; spacerTail: number; spacerHead: number;
  emptyCharIndex: number; spacerCharIndex: number; emptyWord: number; tabWidth: number;
}

const TAB = 256;
const RUN_SHIFT = 10;

/** SGR attribute slots: the code that sets each, and the code that ends it */
const CLOSE: Record<string, string> = {
  bold: '22', dim: '22', italic: '23', underline: '24', blink: '25', inverse: '27',
  hidden: '28', strike: '29', overline: '55', fg: '39', bg: '49', ulColor: '59',
};
const SIMPLE: Record<number, string> = {
  1: 'bold', 2: 'dim', 3: 'italic', 4: 'underline', 21: 'underline', 5: 'blink', 6: 'blink',
  7: 'inverse', 8: 'hidden', 9: 'strike', 53: 'overline',
};
const ENDS: Record<number, string[]> = {
  22: ['bold', 'dim'], 23: ['italic'], 24: ['underline'], 25: ['blink'], 27: ['inverse'],
  28: ['hidden'], 29: ['strike'], 55: ['overline'], 39: ['fg'], 49: ['bg'], 59: ['ulColor'],
};

// CSI … final byte; OSC … BEL or ST; other two-byte escapes
const ESCAPE = /\x1b\[([0-9;:?<=>]*)[ -/]*([@-~])|\x1b\]([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|[\x9b][0-9;]*[@-~]/g;

export class CellSegmenter {
  graphemes: string[] = [];
  sgrKeys: string[] = [''];
  sgrCloseKeys: string[] = [''];
  uris: string[] = [''];
  private graphemeIds = new Map<string, number>();
  private sgrIds = new Map<string, number>([['', 0]]);
  private uriIds = new Map<string, number>([['', 0]]);
  private ambiguousIsNarrow: boolean;
  private substitute: [number, number][];
  private screen: ScreenOpts | undefined;
  // segment's output before it is copied (grown as needed)
  private tmpCells: number[] = [];
  private tmpRuns: number[] = [];

  constructor(opts: { ambiguousIsNarrow?: boolean; substitute?: [number, number][]; screen?: ScreenOpts } = {}) {
    this.ambiguousIsNarrow = opts.ambiguousIsNarrow !== false;
    this.substitute = (opts.substitute ?? []).map(([a, b]) => [a, b]);
    this.screen = opts.screen;
  }

  private dropped(cp: number): boolean {
    if (cp < 0x20 || cp === 0x7f || (cp >= 0x80 && cp < 0xa0)) return true;
    for (const [a, b] of this.substitute) if (cp >= a && cp <= b) return true;
    return false;
  }

  private graphemeId(g: string): number {
    let id = this.graphemeIds.get(g);
    if (id === undefined) { id = this.graphemes.length; this.graphemes.push(g); this.graphemeIds.set(g, id); }
    return id;
  }

  private styleId(attrs: Map<string, string>): number {
    if (attrs.size === 0) return 0;
    const codes = [...attrs.values()].map((p) => `\x1b[${p}m`);
    const key = codes.join('\0');
    let id = this.sgrIds.get(key);
    if (id === undefined) {
      id = this.sgrKeys.length;
      this.sgrKeys.push(key);
      this.sgrCloseKeys.push([...attrs.keys()].map((slot) => `\x1b[${CLOSE[slot]}m`).join('\0'));
      this.sgrIds.set(key, id);
    }
    return id;
  }

  private uriId(uri: string): number {
    let id = this.uriIds.get(uri);
    if (id === undefined) { id = this.uris.length; this.uris.push(uri); this.uriIds.set(uri, id); }
    return id;
  }

  /** Apply one SGR sequence's parameters to the attribute slots */
  private static applySgr(attrs: Map<string, string>, params: string): void {
    const ps = params === '' ? ['0'] : params.split(';');
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      if (p.includes(':')) { // 4:3 (curly underline) and other sub-parameter forms
        const head = Number(p.split(':')[0]);
        if (head === 4) { if (p === '4:0') attrs.delete('underline'); else attrs.set('underline', p); }
        else if (head === 38 || head === 48 || head === 58) attrs.set(head === 38 ? 'fg' : head === 48 ? 'bg' : 'ulColor', p);
        continue;
      }
      const n = Number(p || '0');
      if (n === 0) { attrs.clear(); continue; }
      if (SIMPLE[n]) { attrs.delete(SIMPLE[n]); attrs.set(SIMPLE[n], String(n)); continue; }
      if (ENDS[n]) { for (const s of ENDS[n]) attrs.delete(s); continue; }
      if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) { attrs.delete('fg'); attrs.set('fg', String(n)); continue; }
      if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) { attrs.delete('bg'); attrs.set('bg', String(n)); continue; }
      if (n === 38 || n === 48 || n === 58) {
        const slot = n === 38 ? 'fg' : n === 48 ? 'bg' : 'ulColor';
        const mode = ps[i + 1];
        if (mode === '5' && ps[i + 2] !== undefined) { attrs.delete(slot); attrs.set(slot, `${n};5;${ps[i + 2]}`); i += 2; }
        else if (mode === '2' && ps[i + 4] !== undefined) { attrs.delete(slot); attrs.set(slot, `${n};2;${ps[i + 2]};${ps[i + 3]};${ps[i + 4]}`); i += 4; }
        continue;
      }
    }
  }

  segment(text: string, cells: Int32Array, runs: Int32Array, _reordered?: boolean): number {
    const out = this.tmpCells, outRuns = this.tmpRuns;
    let count = 0, runCount = 0;
    const attrs = new Map<string, string>();
    let style = 0, link = 0, curStyle = -1, curLink = -1;
    const emitText = (t: string) => {
      for (let g of splitGraphemes(t)) {
        if (g === '\t') {
          if (style !== curStyle || link !== curLink) { outRuns[2 * runCount] = style; outRuns[2 * runCount + 1] = link; runCount++; curStyle = style; curLink = link; }
          out[2 * count] = this.graphemeId(' ');
          out[2 * count + 1] = TAB | ((runCount - 1) << RUN_SHIFT);
          count++;
          continue;
        }
        // drop control characters and substituted code points (bidi controls)
        let keep = '';
        for (const ch of g) if (!this.dropped(ch.codePointAt(0)!)) keep += ch;
        if (!keep) continue;
        g = keep;
        const w = Math.min(2, stringWidth(g, { ambiguousIsNarrow: this.ambiguousIsNarrow }));
        if (w === 0) continue;
        if (style !== curStyle || link !== curLink) { outRuns[2 * runCount] = style; outRuns[2 * runCount + 1] = link; runCount++; curStyle = style; curLink = link; }
        out[2 * count] = this.graphemeId(g);
        out[2 * count + 1] = w | ((runCount - 1) << RUN_SHIFT);
        count++;
      }
    };
    let last = 0;
    ESCAPE.lastIndex = 0;
    for (let m = ESCAPE.exec(text); m; m = ESCAPE.exec(text)) {
      if (m.index > last) emitText(text.slice(last, m.index));
      last = m.index + m[0].length;
      if (m[2] === 'm' && m[1] !== undefined && !/[?<=>]/.test(m[1])) {
        CellSegmenter.applySgr(attrs, m[1]);
        style = this.styleId(attrs);
      } else if (m[3] !== undefined && m[3].startsWith('8;')) {
        const uri = m[3].slice(m[3].indexOf(';', 2) + 1);
        link = uri ? this.uriId(uri) : 0;
      }
    }
    if (last < text.length) emitText(text.slice(last));
    if (cells.length < 2 * count || runs.length < 2 * runCount) return -Math.max(count, runCount, 1);
    for (let i = 0; i < 2 * count; i++) cells[i] = out[i];
    for (let i = 0; i < 2 * runCount; i++) runs[i] = outRuns[i];
    return count;
  }

  paint(screenCells: Int32Array, width: number, x: number, y: number, cells: Int32Array, count: number,
    _unused: unknown, charIds: Int32Array, runWords: Int32Array): number {
    const s = this.screen;
    if (!s) throw new Error('CellSegmenter.paint: made without screen options');
    const row = y * width;
    let col = x, first = -1, end = -1;
    const put = (c: number, ch: number, word: number) => {
      const k = (row + c) << 1;
      screenCells[k] = ch; screenCells[k + 1] = word;
      if (first < 0) first = c;
      end = c + 1;
    };
    // a wide character cut in two at the left edge: its head goes blank
    if (x > 0 && x < width && (screenCells[((row + x) << 1) + 1] & s.widthMask) === s.spacerTail) {
      const k = (row + x - 1) << 1;
      screenCells[k] = s.emptyCharIndex; screenCells[k + 1] = s.emptyWord;
      first = x - 1;
    }
    for (let i = 0; i < count; i++) {
      const packed = cells[2 * i + 1];
      const word = runWords[packed >>> RUN_SHIFT] & ~s.widthMask;
      if (packed & TAB) {
        const n = s.tabWidth - (col % s.tabWidth);
        for (let k = 0; k < n; k++, col++) if (col < width) put(col, s.emptyCharIndex, word | s.narrow);
        continue;
      }
      const w = packed & 255;
      if (col >= width) { col += w; continue; }
      const ch = charIds[cells[2 * i]];
      if (w >= 2) {
        if (col + 1 >= width) { put(col, s.spacerCharIndex, word | s.spacerHead); col += w; continue; }
        put(col, ch, word | s.wide);
        put(col + 1, s.spacerCharIndex, word | s.spacerTail);
        col += 2;
      } else {
        put(col, ch, word | s.narrow);
        col += 1;
      }
    }
    // and one cut at the right edge: its tail goes blank
    if (end > 0 && end < width && (screenCells[((row + end) << 1) + 1] & s.widthMask) === s.spacerTail) {
      const k = (row + end) << 1;
      screenCells[k] = s.emptyCharIndex; screenCells[k + 1] = s.emptyWord;
      end++;
    }
    if (first < 0) first = end = 0;
    return col + first * 2 ** 20 + end * 2 ** 36;
  }
}
