/**
 * A QR code for a text (ISO/IEC 18004), for the link `link` makes
 * (docs/RUN_LINKS.md "link"): a phone's camera reads the address off the
 * screen. Small on purpose, with no dependency: byte mode only (a link is
 * bytes), error correction level L only (a screen has no dirt on it, and L
 * leaves the most room), versions 1 to 40.
 *
 * `qrCode(text)` gives the modules, or null when the text is longer than
 * the largest code holds (2,953 bytes). No DOM here; `qrSvg` is markup for
 * whoever draws it.
 *
 * Checked in tests/tests/shiro-vitest/qr.test.ts against the standard's own
 * numbers (the error correction codewords of its worked example, the format
 * and version words) and by a decoder written from the standard, and in
 * tests/browser/link-is-computer.mjs by the browser's own reader.
 */

/** Error correction codewords in each block, and how many blocks, for level L, by version (index 0 is version 1) */
const EC_PER_BLOCK = [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30];
const BLOCKS = [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25];

export const QR_MAX_VERSION = 40;
/** The longest text a code holds, in bytes of UTF-8 */
export const QR_MAX_BYTES = 2953;

/** How many modules of a version carry codewords: all but the finder, timing, alignment, format and version patterns */
function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (ver >= 7) n -= 36;
  }
  return n;
}
/** Codewords of a version, all of them; and those that are data at level L */
export const qrCodewords = (ver: number): number => Math.floor(rawModules(ver) / 8);
export const qrDataCodewords = (ver: number): number => qrCodewords(ver) - EC_PER_BLOCK[ver - 1] * BLOCKS[ver - 1];
/** Bytes of text a version holds: its data codewords less the mode (4 bits) and the count (8 bits to version 9, then 16) */
export const qrCapacity = (ver: number): number => qrDataCodewords(ver) - (ver < 10 ? 2 : 3);

/** Where the centers of a version's alignment patterns are, along either axis */
export function alignmentPositions(ver: number): number[] {
  if (ver === 1) return [];
  const count = Math.floor(ver / 7) + 2;
  const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (count * 2 - 2)) * 2;
  const out = [6];
  for (let pos = ver * 4 + 10; out.length < count; pos -= step) out.splice(1, 0, pos);
  return out;
}

// ── Reed–Solomon over GF(256), the field of x^8 + x^4 + x^3 + x^2 + 1 ──
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = EXP[i + 255] = x; LOG[x] = i; x = (x << 1) ^ (x & 0x80 ? 0x11d : 0); }
const mul = (a: number, b: number): number => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** The `n` error correction codewords of `data`: the remainder of data·x^n by the generator (x − α^0)…(x − α^(n−1)) */
export function reedSolomon(data: ArrayLike<number>, n: number): Uint8Array {
  const gen = new Uint8Array(n);   // the generator's coefficients below its leading 1, highest power first
  gen[n - 1] = 1;
  for (let i = 0, root = 1; i < n; i++, root = mul(root, 2)) {
    for (let j = 0; j < n; j++) gen[j] = mul(gen[j], root) ^ (j + 1 < n ? gen[j + 1] : 0);
  }
  const rem = new Uint8Array(n);
  for (let i = 0; i < data.length; i++) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[n - 1] = 0;
    for (let j = 0; j < n; j++) rem[j] ^= mul(gen[j], factor);
  }
  return rem;
}

/** The 15 bits that say the level (L) and the mask, with their own error correction (BCH 15,5) */
export function formatBits(mask: number): number {
  const data = (1 << 3) | mask;   // level L is 01
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}
/** The 18 bits that say the version, from version 7 on (BCH 18,6) */
export function versionBits(ver: number): number {
  let rem = ver;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  return (ver << 12) | rem;
}

/** Is the module at column x, row y turned over by this mask? */
export function masked(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    default: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
  }
}

/** The codewords of a text, data then error correction, in the order they are placed (blocks interleaved) */
export function qrCodewordsOf(bytes: Uint8Array, ver: number): Uint8Array {
  const dataLen = qrDataCodewords(ver);
  const bits: number[] = [];
  const put = (value: number, length: number) => { for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1); };
  put(4, 4);   // byte mode
  put(bytes.length, ver < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, dataLen * 8 - bits.length));   // the terminator, as much of it as fits
  while (bits.length % 8) bits.push(0);
  const data = new Uint8Array(dataLen);
  for (let i = 0; i < bits.length; i++) data[i >>> 3] |= bits[i] << (7 - (i & 7));
  for (let i = bits.length / 8, pad = 0xec; i < dataLen; i++, pad ^= 0xec ^ 0x11) data[i] = pad;

  // Blocks: the first ones are one codeword shorter where the data does not divide evenly
  const blocks = BLOCKS[ver - 1], ec = EC_PER_BLOCK[ver - 1];
  const short = Math.floor(dataLen / blocks), longFrom = blocks - dataLen % blocks;
  const parts: { data: Uint8Array; ec: Uint8Array }[] = [];
  for (let b = 0, at = 0; b < blocks; b++) {
    const d = data.subarray(at, at += short + (b >= longFrom ? 1 : 0));
    parts.push({ data: d, ec: reedSolomon(d, ec) });
  }
  const out: number[] = [];
  for (let i = 0; i <= short; i++) for (const p of parts) if (i < p.data.length) out.push(p.data[i]);
  for (let i = 0; i < ec; i++) for (const p of parts) out.push(p.ec[i]);
  return Uint8Array.from(out);
}

export interface QrCode {
  version: number;
  /** Modules a side: 17 + 4 × version */
  size: number;
  mask: number;
  /** modules[y][x]: true is dark */
  modules: boolean[][];
}

/** The function patterns of a version: which modules they take, and which of those are dark */
function functionPatterns(ver: number): { dark: boolean[][]; taken: boolean[][] } {
  const size = ver * 4 + 17;
  const dark = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const taken = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, on: boolean) => { if (x >= 0 && y >= 0 && x < size && y < size) { dark[y][x] = on; taken[y][x] = true; } };
  // Timing: every other module along row 6 and column 6
  for (let i = 0; i < size; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // Finders, with the light ring around them: three corners
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(cx + dx, cy + dy, d !== 2 && d !== 4); }
  }
  // Alignment patterns, except where a finder is
  const at = alignmentPositions(ver);
  for (let i = 0; i < at.length; i++) for (let j = 0; j < at.length; j++) {
    if ((i === 0 && j === 0) || (i === 0 && j === at.length - 1) || (i === at.length - 1 && j === 0)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(at[i] + dx, at[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // Where the format bits go (written with the mask), and the module that is always dark.
  // (module 6 of that row and column is the timing pattern's, and stays)
  for (let i = 0; i < 9; i++) if (i !== 6) { set(8, i, false); set(i, 8, false); }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, false); set(8, size - 1 - i, false); }
  set(8, size - 8, true);
  // The version, twice, from version 7 on
  if (ver >= 7) {
    const bits = versionBits(ver);
    for (let i = 0; i < 18; i++) { const on = ((bits >>> i) & 1) === 1, a = size - 11 + i % 3, b = Math.floor(i / 3); set(a, b, on); set(b, a, on); }
  }
  return { dark, taken };
}

function drawFormat(m: boolean[][], mask: number): void {
  const size = m.length, bits = formatBits(mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6);
  m[8][8] = bit(7);
  m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
}

/** How hard a pattern is to read, by the standard's four rules: the mask with the lowest score is used */
function penalty(m: boolean[][]): number {
  const size = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1, text = '';
    for (let i = 0; i < size; i++) {
      text += get(i) ? '1' : '0';
      if (i && get(i) === get(i - 1)) run++; else { if (run >= 5) score += run - 2; run = 1; }
    }
    if (run >= 5) score += run - 2;
    // a finder's own proportions, 1:1:3:1:1, beside four light modules
    for (const p of ['10111010000', '00001011101']) for (let at = text.indexOf(p); at >= 0; at = text.indexOf(p, at + 1)) score += 40;
  };
  for (let y = 0; y < size; y++) line((x) => m[y][x]);
  for (let x = 0; x < size; x++) line((y) => m[y][x]);
  let dark = 0;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (m[y][x]) dark++;
    if (x + 1 < size && y + 1 < size && m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
  }
  return score + Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
}

/** The smallest version that holds `length` bytes, or 0 when none does */
export function qrVersionFor(length: number): number {
  for (let ver = 1; ver <= QR_MAX_VERSION; ver++) if (length <= qrCapacity(ver)) return ver;
  return 0;
}

/** The QR code of `text`: the smallest version that holds it, and the mask that reads best. Null: it is too long for any. `mask` forces one (tests). */
export function qrCode(text: string, mask?: number): QrCode | null {
  const bytes = new TextEncoder().encode(text);
  const version = qrVersionFor(bytes.length);
  if (!version) return null;
  const size = version * 4 + 17;
  const { dark, taken } = functionPatterns(version);
  const words = qrCodewordsOf(bytes, version);
  // The codewords, bit by bit: up and down in columns two wide, from the right, past the timing column
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - v : v;
      if (taken[y][x]) continue;
      dark[y][x] = i < words.length * 8 && ((words[i >>> 3] >>> (7 - (i & 7))) & 1) === 1;
      i++;
    }
  }
  let best: QrCode | null = null, least = Infinity;
  for (const k of mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [mask]) {
    const m = dark.map((row, y) => row.map((on, x) => (taken[y][x] ? on : on !== masked(k, x, y))));
    drawFormat(m, k);
    const p = penalty(m);
    if (p < least) { least = p; best = { version, size, mask: k, modules: m }; }
  }
  return best;
}

/** The code as SVG markup: dark modules on white, with the light margin four modules wide that a reader needs */
export function qrSvg(code: QrCode, pixels = 4): string {
  const quiet = 4, side = code.size + quiet * 2;
  let path = '';
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) {
      if (!code.modules[y][x]) continue;
      let run = 1;
      while (x + run < code.size && code.modules[y][x + run]) run++;
      path += `M${x + quiet} ${y + quiet}h${run}v1h-${run}z`;
      x += run - 1;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${side} ${side}" width="${side * pixels}" height="${side * pixels}" shape-rendering="crispEdges" role="img"><rect width="${side}" height="${side}" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
}
