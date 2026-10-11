/**
 * src/claude-vm/bun/cell-segmenter.ts: Bun.ant.CellSegmenter as Claude Code's
 * renderer (2.1.296) uses it: segment styled text into cells and runs, then
 * paint them into a screen row of [char id, word] pairs.
 */
import { describe, it, expect } from 'vitest';
import { CellSegmenter } from '@shiro/claude-vm/bun/cell-segmenter';

// The renderer's own constants (chunk-ayzspee4.js): word = style << 17 | link << 2 | width code
const fo = 17, kr = 2, Cn = 3;
const word = (style: number, link: number, w: number) => (style << fo) | (link << kr) | w;
const screen = { widthMask: Cn, narrow: 0, wide: 1, spacerTail: 2, spacerHead: 3, emptyCharIndex: 0, spacerCharIndex: 1, emptyWord: 0, tabWidth: 8 };
const BIDI: [number, number][] = [[1564, 1564], [8234, 8238], [8294, 8297]];

const seg = (s: CellSegmenter, text: string) => {
  const cells = new Int32Array(256), runs = new Int32Array(256);
  const n = s.segment(text, cells, runs, false);
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = cells[2 * i + 1], r = p >>> 10;
    out.push({ g: s.graphemes[cells[2 * i]], w: p & 255, tab: !!(p & 256), style: s.sgrKeys[runs[2 * r]], link: s.uris[runs[2 * r + 1]] });
  }
  return out;
};

describe('Bun.ant.CellSegmenter', () => {
  it('splits text into graphemes with widths, and styles into runs with their close codes', () => {
    const s = new CellSegmenter({ ambiguousIsNarrow: true, substitute: BIDI, screen });
    const c = seg(s, 'a\x1b[1;31mb漢\x1b[22mc\x1b[0md');
    expect(c.map((x) => x.g).join('|')).toBe('a|b|漢|c|d');
    expect(c.map((x) => x.w)).toEqual([1, 1, 2, 1, 1]);
    expect(c.map((x) => x.style)).toEqual(['', '\x1b[1m\0\x1b[31m', '\x1b[1m\0\x1b[31m', '\x1b[31m', '']);
    const i = s.sgrKeys.indexOf('\x1b[1m\0\x1b[31m');
    expect(s.sgrCloseKeys[i]).toBe('\x1b[22m\0\x1b[39m');
    expect(s.sgrKeys[0]).toBe('');
  });

  it('256-colour and truecolour SGR, OSC 8 links, and other escapes dropped', () => {
    const s = new CellSegmenter({ substitute: BIDI, screen });
    const c = seg(s, '\x1b[38;5;208mx\x1b[48;2;1;2;3my\x1b]8;;https://a.example\x07L\x1b]8;;\x07\x1b[2Kz');
    expect(c.map((x) => x.style)).toEqual(['\x1b[38;5;208m', '\x1b[38;5;208m\0\x1b[48;2;1;2;3m', '\x1b[38;5;208m\0\x1b[48;2;1;2;3m', '\x1b[38;5;208m\0\x1b[48;2;1;2;3m']);
    expect(c.map((x) => x.link)).toEqual(['', '', 'https://a.example', '']);
    expect(c.map((x) => x.g).join('')).toBe('xyLz');
  });

  it('drops control characters and the substituted code points; a tab is a tab cell', () => {
    const s = new CellSegmenter({ substitute: BIDI, screen });
    const c = seg(s, 'a‮b\x07c\td');
    expect(c.map((x) => x.g).join('')).toBe('abc d');
    expect(c[3].tab).toBe(true);
  });

  it('says how many cells it needs when the arrays are too small, and keeps its tables across calls', () => {
    const s = new CellSegmenter({ screen });
    expect(s.segment('hello', new Int32Array(4), new Int32Array(4), false)).toBe(-5);
    const cells = new Int32Array(10), runs = new Int32Array(10);
    expect(s.segment('hello', cells, runs, false)).toBe(5);
    const n = s.graphemes.length;
    s.segment('hole', cells, runs, false);
    expect(s.graphemes.length).toBe(n); // h, o, l, e already there
  });

  it('paints narrow and wide cells, tabs and runs into a screen row, and reports the columns', () => {
    const s = new CellSegmenter({ substitute: BIDI, screen });
    const cells = new Int32Array(64), runs = new Int32Array(64);
    const n = s.segment('a漢\tb', cells, runs, false);
    const charIds = Int32Array.from(s.graphemes.map((_, i) => 100 + i));
    const runWords = new Int32Array([word(5, 0, 0)]);
    const width = 20, scr = new Int32Array(width * 2 * 2);
    const r = s.paint(scr, width, 2, 1, cells, n, undefined, charIds, runWords);
    const row = (c: number) => [scr[((width + c) << 1)], scr[((width + c) << 1) + 1]];
    expect(row(2)).toEqual([charIds[s.graphemes.indexOf('a')], word(5, 0, 0)]);
    expect(row(3)).toEqual([charIds[s.graphemes.indexOf('漢')], word(5, 0, 1)]);
    expect(row(4)).toEqual([1, word(5, 0, 2)]); // the spacer after a wide character
    expect(row(5)).toEqual([0, word(5, 0, 0)]); // the tab: blanks to column 8
    expect(row(8)).toEqual([charIds[s.graphemes.indexOf('b')], word(5, 0, 0)]);
    expect(r % 2 ** 20).toBe(9); // the next column
    expect(Math.floor(r / 2 ** 20) % 65536).toBe(2); // first column painted
    expect(Math.floor(r / 2 ** 36)).toBe(9); // end of what was painted
  });

  it('clips at the right edge: a wide character that does not fit leaves a spacer head', () => {
    const s = new CellSegmenter({ screen });
    const cells = new Int32Array(64), runs = new Int32Array(64);
    const n = s.segment('ab漢', cells, runs, false);
    const width = 3, scr = new Int32Array(width * 2);
    const r = s.paint(scr, width, 0, 0, cells, n, undefined, Int32Array.from(s.graphemes.map((_, i) => 10 + i)), new Int32Array([0]));
    expect(scr[(2 << 1) + 1] & Cn).toBe(3);
    expect(r % 2 ** 20).toBe(4);
  });
});
