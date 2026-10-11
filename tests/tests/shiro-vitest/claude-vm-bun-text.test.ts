/**
 * Bun's text helpers (stringWidth, stripANSI, sliceAnsi, wrapAnsi) for claude --vm (src/claude-vm/bun/): the expected values are what
 * Bun 1.4.2 returned for the same calls.
 */
import { describe, it, expect } from 'vitest';
import { stringWidth, stripANSI, sliceAnsi, wrapAnsi } from '@shiro/claude-vm/bun/text';

const S = [
  'hello', '', 'héllo', '日本語', 'á', '👍', '👨‍👩‍👧', '🇺🇸', '\x1b[31mred\x1b[0m', '\x1b]8;;http://x\x07link\x1b]8;;\x07',
  'tab\there', '​', '±§', 'Ω', '─│┌', '\x1b[1;32mbold green\x1b[39m plain\x1b[22m', 'mixed 日本 text', 'é̂', '\u0000ctl', 'A️',
  '☃', '⚡', '✓', '→', '…', 'ｱ', '한국어', '🏳️‍🌈',
];
const SL = ['\x1b[31mhello world\x1b[0m', 'abc日本語def', '\x1b[1mbold\x1b[22m and \x1b[4munder\x1b[24m', 'plain text', '👍a👍b', '\x1b[31mred\x1b[32mgreen\x1b[39m'];
const W = ['the quick brown fox jumps over the lazy dog', '\x1b[31mthe quick brown fox jumps over\x1b[0m the lazy dog', 'aaaaaaaaaaaaaaaaaaaaaaaa bb', '日本語の文章をここに書きます', 'line one\nline two is longer than ten', '  leading and trailing  ', 'a\x1b]8;;http://x\x07link text here\x1b]8;;\x07 b'];
const BUN = {"width": [5, 0, 5, 6, 1, 2, 2, 2, 3, 4, 7, 0, 2, 1, 3, 16, 15, 1, 3, 1, 1, 2, 1, 1, 1, 1, 6, 2], "widthAmb": [5, 0, 6, 6, 1, 2, 2, 2, 3, 4, 7, 0, 4, 2, 6, 16, 15, 1, 3, 1, 1, 2, 1, 2, 2, 1, 6, 2], "widthAnsi": [5, 0, 5, 6, 1, 2, 2, 2, 10, 20, 7, 0, 2, 1, 3, 30, 15, 1, 3, 1, 1, 2, 1, 1, 1, 1, 6, 2], "strip": ["hello", "", "h\u00e9llo", "\u65e5\u672c\u8a9e", "a\u0301", "\ud83d\udc4d", "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67", "\ud83c\uddfa\ud83c\uddf8", "red", "link", "tab\there", "\u200b", "\u00b1\u00a7", "\u03a9", "\u2500\u2502\u250c", "bold green plain", "mixed \u65e5\u672c text", "e\u0301\u0302", "\u0000ctl", "A\ufe0f", "\u2603", "\u26a1", "\u2713", "\u2192", "\u2026", "\uff71", "\ud55c\uad6d\uc5b4", "\ud83c\udff3\ufe0f\u200d\ud83c\udf08"], "slice": [["\u001b[31mhel\u001b[39m", "\u001b[31mllo \u001b[39m", "\u001b[31mo world\u001b[0m", "\u001b[31me\u001b[39m"], ["abc", "c\u65e5\u672c", "\u672c\u8a9edef", "b"], ["\u001b[1mbol\u001b[22m", "\u001b[1mld\u001b[22m a", " and \u001b[4munder\u001b[24m", "\u001b[1mo\u001b[22m"], ["pla", "ain ", "n text", "l"], ["\ud83d\udc4da", "a\ud83d\udc4db", "b", ""], ["\u001b[31mred\u001b[39m", "\u001b[31md\u001b[32mgre\u001b[39m", "\u001b[32mreen\u001b[39m", "\u001b[31me\u001b[39m"]], "wrap": [["the quick\nbrown fox\njumps over\nthe lazy\ndog", "the quick\nbrown fox\njumps over\nthe lazy\ndog", "the quick\nbrown fox\njumps over\nthe lazy d\nog", "the quick \nbrown fox \njumps over\n the lazy \ndog"], ["\u001b[31mthe quick\u001b[39m\n\u001b[31mbrown fox\u001b[39m\n\u001b[31mjumps over\u001b[0m\nthe lazy\ndog", "\u001b[31mthe quick\u001b[39m\n\u001b[31mbrown fox\u001b[39m\n\u001b[31mjumps over\u001b[0m\nthe lazy\ndog", "\u001b[31mthe quick\u001b[39m\n\u001b[31mbrown fox\u001b[39m\n\u001b[31mjumps over\u001b[0m\nthe lazy d\nog", "\u001b[31mthe quick \u001b[39m\n\u001b[31mbrown fox \u001b[39m\n\u001b[31mjumps over\u001b[0m\n the lazy \ndog"], ["aaaaaaaaaaaaaaaaaaaaaaaa\nbb", "aaaaaaaaaa\naaaaaaaaaa\naaaa bb", "aaaaaaaaaa\naaaaaaaaaa\naaaa bb", "aaaaaaaaaaaaaaaaaaaaaaaa\n bb"], ["\u65e5\u672c\u8a9e\u306e\u6587\u7ae0\u3092\u3053\u3053\u306b\u66f8\u304d\u307e\u3059", "\u65e5\u672c\u8a9e\u306e\u6587\n\u7ae0\u3092\u3053\u3053\u306b\n\u66f8\u304d\u307e\u3059", "\u65e5\u672c\u8a9e\u306e\u6587\n\u7ae0\u3092\u3053\u3053\u306b\n\u66f8\u304d\u307e\u3059", "\u65e5\u672c\u8a9e\u306e\u6587\u7ae0\u3092\u3053\u3053\u306b\u66f8\u304d\u307e\u3059"], ["line one\nline two\nis longer\nthan ten", "line one\nline two\nis longer\nthan ten", "line one\nline two i\ns longer t\nhan ten", "line one\nline two \nis longer \nthan ten"], ["leading\nand\ntrailing", "leading\nand\ntrailing", "leading an\nd trailing\n", "  leading \nand \ntrailing  "], ["a\u001b]8;;http://x\u0007link text\u001b]8;;\u0007\n\u001b]8;;http://x\u0007here\u001b]8;;\u0007 b", "a\u001b]8;;http://x\u0007link text\u001b]8;;\u0007\n\u001b]8;;http://x\u0007here\u001b]8;;\u0007 b", "a\u001b]8;;http://x\u0007link text\u001b]8;;\u0007\n\u001b]8;;http://x\u0007here\u001b]8;;\u0007 b", "a\u001b]8;;http://x\u0007link text\u001b]8;;\u0007\n\u001b]8;;http://x\u0007 here\u001b]8;;\u0007 b"]]};

describe('Bun text helpers', () => {
  it('stringWidth: graphemes, wide and ambiguous characters, emoji, escapes', () => {
    expect(S.map((s) => stringWidth(s))).toEqual(BUN.width);
    expect(S.map((s) => stringWidth(s, { ambiguousIsNarrow: false }))).toEqual(BUN.widthAmb);
    expect(S.map((s) => stringWidth(s, { countAnsiEscapeCodes: true }))).toEqual(BUN.widthAnsi);
  });
  it('stripANSI: SGR and OSC 8', () => {
    expect(S.map((s) => stripANSI(s))).toEqual(BUN.strip);
  });
  it('sliceAnsi: by columns, styles kept; a wide character that starts before the end stays', () => {
    expect(SL.map((s) => [sliceAnsi(s, 0, 3), sliceAnsi(s, 2, 6), sliceAnsi(s, 4), sliceAnsi(s, 1, 2)])).toEqual(BUN.slice);
  });
  it('wrapAnsi: hard, wordWrap, trim', () => {
    expect(W.map((s) => [wrapAnsi(s, 10), wrapAnsi(s, 10, { hard: true }), wrapAnsi(s, 10, { wordWrap: false }), wrapAnsi(s, 10, { trim: false })])).toEqual(BUN.wrap);
  });
  it('plain ASCII takes the fast path and agrees', () => {
    const line = 'x'.repeat(200);
    expect(stringWidth(line)).toBe(200);
    expect(sliceAnsi(line, 10, 20)).toBe('x'.repeat(10));
    expect(stripANSI(line)).toBe(line);
  });
});
