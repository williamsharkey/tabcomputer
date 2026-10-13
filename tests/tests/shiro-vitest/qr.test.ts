/**
 * The QR encoder (src/qr.ts) against ISO/IEC 18004: the standard's own
 * numbers, and a decoder written here from the standard's text, sharing no
 * code with the encoder (its own field arithmetic, its own table of blocks,
 * its own geometry). The browser's reader checks it once more in
 * tests/browser/link-is-computer.mjs.
 */
import { describe, it, expect } from 'vitest';
import { QR_MAX_BYTES, alignmentPositions, formatBits, qrCapacity, qrCode, qrCodewords, qrDataCodewords, qrSvg, qrVersionFor, reedSolomon, versionBits, type QrCode } from '@shiro/qr';

// ── the decoder ──

/** GF(256) multiplication by shifting and reducing by x^8 + x^4 + x^3 + x^2 + 1 */
function gmul(a: number, b: number): number {
  let r = 0;
  for (; b; b >>= 1) { if (b & 1) r ^= a; a <<= 1; if (a & 0x100) a ^= 0x11d; }
  return r;
}
const gpow = (a: number, n: number): number => { let r = 1; for (let i = 0; i < n; i++) r = gmul(r, a); return r; };

/**
 * Level L, from the standard's table 9: error correction codewords per block,
 * then blocks × data codewords of the first group and of the second.
 */
const L_BLOCKS: Record<number, [number, number, number, number, number]> = {
  1: [7, 1, 19, 0, 0], 2: [10, 1, 34, 0, 0], 3: [15, 1, 55, 0, 0], 4: [20, 1, 80, 0, 0], 5: [26, 1, 108, 0, 0], 6: [18, 2, 68, 0, 0], 7: [20, 2, 78, 0, 0],
  8: [24, 2, 97, 0, 0], 9: [30, 2, 116, 0, 0], 10: [18, 2, 68, 2, 69], 11: [20, 4, 81, 0, 0], 12: [24, 2, 92, 2, 93], 13: [26, 4, 107, 0, 0], 14: [30, 3, 115, 1, 116],
  15: [22, 5, 87, 1, 88], 16: [24, 5, 98, 1, 99], 17: [28, 1, 107, 5, 108], 18: [30, 5, 120, 1, 121], 19: [28, 3, 113, 4, 114], 20: [28, 3, 107, 5, 108],
  21: [28, 4, 116, 4, 117], 22: [28, 2, 111, 7, 112], 23: [30, 4, 121, 5, 122], 24: [30, 6, 117, 4, 118], 25: [26, 8, 106, 4, 107], 26: [28, 10, 114, 2, 115],
  27: [30, 8, 122, 4, 123], 28: [30, 3, 117, 10, 118], 29: [30, 7, 116, 7, 117], 30: [30, 5, 115, 10, 116], 31: [30, 13, 115, 3, 116], 32: [30, 17, 115, 0, 0],
  33: [30, 17, 115, 1, 116], 34: [30, 13, 115, 6, 116], 35: [30, 12, 121, 7, 122], 36: [30, 6, 121, 14, 122], 37: [30, 17, 122, 4, 123], 38: [30, 4, 122, 18, 123],
  39: [30, 20, 117, 4, 118], 40: [30, 19, 118, 6, 119],
};
/** Alignment pattern centers, from the standard's annex E */
const ALIGN: Record<number, number[]> = {
  1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50], 11: [6, 30, 54], 12: [6, 32, 58],
  13: [6, 34, 62], 14: [6, 26, 46, 66], 15: [6, 26, 48, 70], 16: [6, 26, 50, 74], 17: [6, 30, 54, 78], 18: [6, 30, 56, 82], 19: [6, 30, 58, 86], 20: [6, 34, 62, 90],
  21: [6, 28, 50, 72, 94], 22: [6, 26, 50, 74, 98], 23: [6, 30, 54, 78, 102], 24: [6, 28, 54, 80, 106], 25: [6, 32, 58, 84, 110], 26: [6, 30, 58, 86, 114],
  27: [6, 34, 62, 90, 118], 28: [6, 26, 50, 74, 98, 122], 29: [6, 30, 54, 78, 102, 126], 30: [6, 26, 52, 78, 104, 130], 31: [6, 30, 56, 82, 108, 134],
  32: [6, 34, 60, 86, 112, 138], 33: [6, 30, 58, 86, 114, 142], 34: [6, 34, 62, 90, 118, 146], 35: [6, 30, 54, 78, 102, 126, 150], 36: [6, 24, 50, 76, 102, 128, 154],
  37: [6, 28, 54, 80, 106, 132, 158], 38: [6, 32, 58, 84, 110, 136, 162], 39: [6, 26, 54, 82, 110, 138, 166], 40: [6, 30, 58, 86, 114, 142, 170],
};

/** Read a symbol back: its level, mask and text. Throws when anything is not as the standard says. */
function decode(code: QrCode): { level: number; mask: number; version: number; text: string } {
  const n = code.size, version = (n - 17) / 4;
  const at = (row: number, col: number) => code.modules[row][col];
  // The format information, both copies (bit 14 first), with its mask taken off
  const first: [number, number][] = [[8, 0], [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 7], [8, 8], [7, 8], [5, 8], [4, 8], [3, 8], [2, 8], [1, 8], [0, 8]];
  const second: [number, number][] = [[n - 1, 8], [n - 2, 8], [n - 3, 8], [n - 4, 8], [n - 5, 8], [n - 6, 8], [n - 7, 8], [8, n - 8], [8, n - 7], [8, n - 6], [8, n - 5], [8, n - 4], [8, n - 3], [8, n - 2], [8, n - 1]];
  const word = (cells: [number, number][]) => cells.reduce((w, [row, col]) => (w << 1) | (at(row, col) ? 1 : 0), 0) ^ 0b101010000010010;
  const format = word(first);
  if (word(second) !== format) throw new Error('the two copies of the format information differ');
  // (its ten check bits: the remainder of the five data bits by x^10 + x^8 + x^5 + x^4 + x^2 + x + 1)
  let rem = (format >> 10) << 10;
  for (let bit = 14; bit >= 10; bit--) if (rem & (1 << bit)) rem ^= 0b10100110111 << (bit - 10);
  if (rem !== (format & 0x3ff)) throw new Error('the format information does not check out');
  const level = format >> 13, mask = (format >> 10) & 7;
  if (!at(n - 8, 8)) throw new Error('the dark module is light');

  // Which modules are function patterns
  const fn = Array.from({ length: n }, () => new Array<boolean>(n).fill(false));
  const box = (r0: number, c0: number, r1: number, c1: number) => { for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) fn[r][c] = true; };
  box(0, 0, 8, 8); box(0, n - 8, 8, n - 1); box(n - 8, 0, n - 1, 8);
  box(6, 0, 6, n - 1); box(0, 6, n - 1, 6);
  const centers = ALIGN[version];
  for (const r of centers) for (const c of centers) {
    if ((r === 6 && c === 6) || (r === 6 && c === n - 7) || (r === n - 7 && c === 6)) continue;
    box(r - 2, c - 2, r + 2, c + 2);
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const ring = Math.max(Math.abs(dr), Math.abs(dc));
      if (at(r + dr, c + dc) !== (ring !== 1)) throw new Error(`the alignment pattern at ${r},${c} is wrong`);
    }
  }
  if (version >= 7) { box(0, n - 11, 5, n - 9); box(n - 11, 0, n - 9, 5); }
  // The patterns themselves: finders, their light borders, the timing lines
  for (const [r0, c0] of [[0, 0], [0, n - 7], [n - 7, 0]]) for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
    const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
    if (at(r0 + r, c0 + c) !== (ring !== 2)) throw new Error('a finder pattern is wrong');
  }
  for (let i = 0; i < 8; i++) for (const [r, c] of [[7, i], [i, 7], [7, n - 1 - i], [i, n - 8], [n - 8, i], [n - 1 - i, 7]]) if (at(r, c)) throw new Error('a finder has no light border');
  for (let i = 8; i < n - 8; i++) if (at(6, i) !== (i % 2 === 0) || at(i, 6) !== (i % 2 === 0)) throw new Error('a timing pattern is wrong');
  if (version >= 7) {
    // The version, six bits and twelve check bits, in a 6 × 3 block (least significant bit at its top left)
    let v = 0;
    for (let i = 17; i >= 0; i--) v = (v << 1) | (at(Math.floor(i / 3), n - 11 + i % 3) ? 1 : 0);
    let w = 0;
    for (let i = 17; i >= 0; i--) w = (w << 1) | (at(n - 11 + i % 3, Math.floor(i / 3)) ? 1 : 0);
    if (v !== w || v >> 12 !== version) throw new Error('the version information is wrong');
  }

  // The data, with the mask taken off: i is the row, j the column
  const conds: ((i: number, j: number) => boolean)[] = [
    (i, j) => (i + j) % 2 === 0, (i) => i % 2 === 0, (_i, j) => j % 3 === 0, (i, j) => (i + j) % 3 === 0,
    (i, j) => (Math.floor(i / 2) + Math.floor(j / 3)) % 2 === 0, (i, j) => (i * j) % 2 + (i * j) % 3 === 0,
    (i, j) => ((i * j) % 2 + (i * j) % 3) % 2 === 0, (i, j) => ((i + j) % 2 + (i * j) % 3) % 2 === 0,
  ];
  const bits: number[] = [];
  let up = true;
  for (let col = n - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let k = 0; k < n; k++) {
      const row = up ? n - 1 - k : k;
      for (const c of [col, col - 1]) if (!fn[row][c]) bits.push((at(row, c) !== conds[mask](row, c)) ? 1 : 0);
    }
    up = !up;
  }
  const [ec, g1, d1, g2, d2] = L_BLOCKS[version];
  const total = g1 * (d1 + ec) + g2 * (d2 + ec);
  if (Math.floor(bits.length / 8) !== total) throw new Error(`version ${version} has ${Math.floor(bits.length / 8)} codewords where the standard has ${total}`);
  const words = Array.from({ length: total }, (_, i) => bits.slice(i * 8, i * 8 + 8).reduce((b, x) => (b << 1) | x, 0));
  // Take the blocks apart again, and check each against its error correction codewords
  const lens = [...new Array<number>(g1).fill(d1), ...new Array<number>(g2).fill(d2)];
  const blocks = lens.map(() => [] as number[]);
  let w = 0;
  for (let i = 0; i < Math.max(d1, d2); i++) lens.forEach((len, b) => { if (i < len) blocks[b].push(words[w++]); });
  for (let i = 0; i < ec; i++) blocks.forEach((b) => b.push(words[w++]));
  for (const block of blocks) {
    for (let k = 0; k < ec; k++) {
      // (a codeword polynomial has the generator's roots α^0 … α^(ec−1) as its own)
      let s = 0;
      for (const c of block) s = gmul(s, gpow(2, k)) ^ c;
      if (s !== 0) throw new Error('a block does not check out against its error correction codewords');
    }
  }
  const data = blocks.flatMap((b, i) => b.slice(0, lens[i]));
  const stream = data.flatMap((b) => [7, 6, 5, 4, 3, 2, 1, 0].map((s) => (b >> s) & 1));
  const take = (count: number) => stream.splice(0, count).reduce((v, x) => (v << 1) | x, 0);
  if (take(4) !== 0b0100) throw new Error('not byte mode');
  const count = take(version < 10 ? 8 : 16);
  const bytes = Uint8Array.from({ length: count }, () => take(8));
  return { level, mask, version, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
}

const LINK = 'https://tabcomputer.com/#pip%20install%20flask%20%26%26%20python3%20app.py';

describe('the QR encoder, against ISO/IEC 18004', () => {
  it('error correction codewords: the standard\'s worked example, and a second known one', () => {
    // Annex I, "01234567" in a 1-M symbol: sixteen data codewords, ten error correction codewords
    expect([...reedSolomon([0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11], 10)])
      .toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55]);
    // "HELLO WORLD" in a 1-M symbol
    expect([...reedSolomon([32, 91, 11, 120, 209, 114, 220, 77, 67, 64, 236, 17, 236, 17, 236, 17], 10)]).toEqual([196, 35, 39, 119, 235, 215, 231, 226, 93, 23]);
  });

  it('the format and version words are the standard\'s', () => {
    // Table C.1, level L, masks 0 to 7
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((m) => formatBits(m).toString(2).padStart(15, '0'))).toEqual([
      '111011111000100', '111001011110011', '111110110101010', '111100010011101', '110011000101111', '110001100011000', '110110001000001', '110100101110110',
    ]);
    // Table D.1
    expect([7, 8, 9, 10, 40].map((v) => versionBits(v).toString(16).padStart(5, '0'))).toEqual(['07c94', '085bc', '09a99', '0a4d3', '28c69']);
  });

  it('every version has the standard\'s codewords, blocks, alignment patterns and room', () => {
    for (let v = 1; v <= 40; v++) {
      const [ec, g1, d1, g2, d2] = L_BLOCKS[v];
      expect(qrCodewords(v), `codewords of version ${v}`).toBe(g1 * (d1 + ec) + g2 * (d2 + ec));
      expect(qrDataCodewords(v), `data codewords of version ${v}`).toBe(g1 * d1 + g2 * d2);
      expect(alignmentPositions(v), `alignment patterns of version ${v}`).toEqual(ALIGN[v]);
    }
    // Table 7, bytes at level L
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 30, 40].map(qrCapacity)).toEqual([17, 32, 53, 78, 106, 134, 154, 192, 230, 271, 858, 1732, 2953]);
    expect(qrVersionFor(17)).toBe(1);
    expect(qrVersionFor(18)).toBe(2);
    expect(qrVersionFor(QR_MAX_BYTES)).toBe(40);
    expect(qrVersionFor(QR_MAX_BYTES + 1)).toBe(0);
  });

  it('a link reads back, in every mask', () => {
    const code = qrCode(LINK)!;
    expect(code).toMatchObject({ version: 4, size: 33 });
    expect(decode(code)).toMatchObject({ level: 1, version: 4, text: LINK, mask: code.mask });
    for (let mask = 0; mask < 8; mask++) expect(decode(qrCode(LINK, mask)!), `mask ${mask}`).toMatchObject({ mask, text: LINK });
  });

  it('texts of every version read back: full to the last byte, one byte into the next, and not ASCII', () => {
    const text = (n: number) => Array.from({ length: n }, (_, i) => 'abcdefghijklmnopqrstuvwxyz0123456789-._~:/?#[]@!$&()*+,;=%'[(i * 7 + n) % 57]).join('');
    for (let v = 1; v <= 40; v++) {
      const full = text(qrCapacity(v));
      const code = qrCode(full)!;
      expect(code.version, `the version for ${full.length} bytes`).toBe(v);
      expect(decode(code).text, `version ${v}, full`).toBe(full);
      if (v > 1) expect(decode(qrCode(text(qrCapacity(v - 1) + 1))!), `version ${v}, its first byte`).toMatchObject({ version: v });
    }
    for (const s of ['', 'a', 'naïve café: 日本語 ✓', 'https://tabcomputer.com/#name=Expenses&table=expenses.csv&columns=Date:date,What,Amount:number']) expect(decode(qrCode(s)!).text).toBe(s);
    expect(qrCode('x'.repeat(QR_MAX_BYTES + 1))).toBeNull();
    // (a character of several bytes counts as its bytes)
    expect(qrCode('é'.repeat(1477))).toBeNull();
    expect(qrCode('é'.repeat(1476))!.version).toBe(40);
  });

  it('the decoder here refuses a symbol that is not right', () => {
    const code = qrCode(LINK)!;
    const flipped = (row: number, col: number): QrCode => ({ ...code, modules: code.modules.map((r, y) => r.map((on, x) => (y === row && x === col ? !on : on))) });
    expect(() => decode(flipped(20, 20))).toThrow(/does not check out against its error correction codewords/);
    expect(() => decode(flipped(8, 0))).toThrow(/format information/);
    expect(() => decode(flipped(3, 3))).toThrow(/finder pattern/);
    expect(() => decode(flipped(6, 10))).toThrow(/timing pattern/);
  });

  it('is drawn dark on white with the light margin a reader needs', () => {
    const code = qrCode('tab')!;
    const svg = qrSvg(code, 5);
    expect(svg).toContain(`viewBox="0 0 ${code.size + 8} ${code.size + 8}"`);
    expect(svg).toContain(`width="${(code.size + 8) * 5}"`);
    expect(svg).toContain('<rect width="29" height="29" fill="#fff"/>');
    // every dark module is in the path, and nothing else: the runs' lengths add up to the dark modules
    const runs = [...svg.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)].map((m) => ({ x: +m[1] - 4, y: +m[2] - 4, n: +m[3] }));
    const drawn = code.modules.map((r) => r.map(() => false));
    for (const r of runs) for (let i = 0; i < r.n; i++) drawn[r.y][r.x + i] = true;
    expect(drawn).toEqual(code.modules);
  });
});
