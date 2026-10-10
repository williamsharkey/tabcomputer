import type { Command } from './index';
import { parseArgs } from './flags';
import { encodeText } from '../utils/byte-text';

/**
 * file: what a file is, as file(1) 5.x says it. The type of the inode first
 * (a FIFO is never opened, so `file` on one doesn't wait for a writer), then
 * magic numbers (ELF with its class, machine and linking; images, archives,
 * compressed data, WebAssembly, SQLite, ...), then what kind of text.
 * `pkg install file` has the real one, with the whole magic database.
 */
export const file: Command = {
  name: "file",
  description: "Determine file type",
  async exec(ctx) {
    const { positional, flags } = parseArgs(ctx.args);
    if (positional.length === 0) {
      ctx.stderr += "Usage: file [-bchiLN] [--mime-type] [--mime-encoding] file ...\n";
      return 1;
    }
    const brief = !!flags.b || !!flags.brief;
    const mimeType = !!flags["mime-type"];
    const mimeEncoding = !!flags["mime-encoding"];
    const mime = !!flags.i || !!flags.mime;
    const follow = !!flags.L || !!flags.dereference;
    const noPad = !!flags.N || !!flags["no-pad"];

    const width = Math.max(...positional.map((p) => p.length));
    for (const path of positional) {
      const t = await identify(ctx, ctx.fs.resolvePath(path, ctx.cwd), follow);
      const text = mimeType ? t.mime : mimeEncoding ? t.encoding : mime ? `${t.mime}; charset=${t.encoding}` : t.description;
      const name = brief ? '' : noPad ? `${path}: ` : `${path}:${' '.repeat(width - path.length)} `;
      ctx.stdout += name + text + '\n';
    }
    return 0;
  },
};

interface FileType {
  description: string;
  mime: string;
  encoding: string;
}

const kind = (description: string, mime: string, encoding = 'binary'): FileType => ({ description, mime, encoding });

async function identify(ctx: Parameters<Command['exec']>[0], path: string, follow: boolean): Promise<FileType> {
  let st: any;
  try {
    st = follow ? await ctx.fs.stat(path) : await ctx.fs.lstat(path);
  } catch {
    if (follow) {
      try {
        const target = await ctx.fs.readlink(path);
        return kind(`broken symbolic link to ${target}`, 'inode/symlink');
      } catch { /* not a link either */ }
    }
    return kind(`cannot open \`${path}' (No such file or directory)`, 'cannot open', '');
  }
  if (st.isSymbolicLink?.()) return kind(`symbolic link to ${await ctx.fs.readlink(path).catch(() => '?')}`, 'inode/symlink');
  if (st.isDirectory?.()) return kind('directory', 'inode/directory');
  if (st.isFIFO?.()) return kind('fifo (named pipe)', 'inode/fifo');
  if (st.isCharacterDevice?.()) return kind('character special', 'inode/chardevice');
  if (st.isBlockDevice?.()) return kind('block special', 'inode/blockdevice');
  if (st.isSocket?.()) return kind('socket', 'inode/socket');

  let data: string | Uint8Array | null;
  try {
    data = await ctx.fs.readFile(path);
  } catch (e: any) {
    return kind(`cannot open \`${path}' (${e?.message ?? e})`, 'cannot open', '');
  }
  const bytes = typeof data === 'string' ? encodeText(data) : data ?? new Uint8Array();
  return detect(bytes);
}

/** What `b` is: magic numbers first, then text */
export function detect(b: Uint8Array): FileType {
  if (b.length === 0) return kind('empty', 'inode/x-empty');
  return magic(b) ?? textType(b) ?? kind('data', 'application/octet-stream');
}

const ascii = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, Math.min(to, b.length)));
const starts = (b: Uint8Array, sig: number[], at = 0) => sig.every((x, i) => b[at + i] === x);
const startsStr = (b: Uint8Array, s: string, at = 0) => ascii(b, at, at + s.length) === s;
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32le = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

function asctime(t: number): string {
  const d = new Date(t * 1000);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p2 = (x: number) => String(x).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${months[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

function magic(b: Uint8Array): FileType | null {
  if (starts(b, [0x7f, 0x45, 0x4c, 0x46])) return elf(b);
  if (starts(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    if (!startsStr(b, 'IHDR', 12) || b.length < 29) return kind('PNG image data', 'image/png');
    const color: Record<number, string> = { 0: 'grayscale', 2: '/color RGB', 3: ' colormap', 4: ' gray+alpha', 6: '/color RGBA' };
    return kind(`PNG image data, ${u32be(b, 16)} x ${u32be(b, 20)}, ${b[24]}-bit${color[b[25]] ?? ''}, ${b[28] ? 'interlaced' : 'non-interlaced'}`, 'image/png');
  }
  if (starts(b, [0xff, 0xd8, 0xff])) {
    const jfif = startsStr(b, 'JFIF\0', 6) ? `, JFIF standard ${b[11]}.${String(b[12]).padStart(2, '0')}` : '';
    return kind(`JPEG image data${jfif}`, 'image/jpeg');
  }
  if (startsStr(b, 'GIF87a') || startsStr(b, 'GIF89a')) return kind(`GIF image data, version ${ascii(b, 3, 6)}, ${u16le(b, 6)} x ${u16le(b, 8)}`, 'image/gif');
  if (startsStr(b, 'RIFF') && startsStr(b, 'WEBP', 8)) return kind('RIFF (little-endian) data, Web/P image', 'image/webp');
  if (startsStr(b, 'RIFF') && startsStr(b, 'WAVE', 8)) return kind('RIFF (little-endian) data, WAVE audio', 'audio/x-wav');
  if (startsStr(b, 'BM') && b.length > 26 && u32le(b, 2) === b.length) return kind(`PC bitmap, Windows 3.x format, ${u32le(b, 18)} x ${u32le(b, 22)}`, 'image/bmp');
  if (startsStr(b, '%PDF-')) return kind(`PDF document, version ${ascii(b, 5, 8)}`, 'application/pdf');
  if (starts(b, [0x1f, 0x8b])) {
    let d = 'gzip compressed data';
    if (b[3] & 8) {
      let end = 10 + (b[3] & 4 ? 2 + u16le(b, 10) : 0);
      const from = end;
      while (end < b.length && b[end] !== 0) end++;
      d += `, was "${new TextDecoder().decode(b.subarray(from, end))}"`;
    }
    const mtime = u32le(b, 4);
    if (mtime) d += `, last modified: ${asctime(mtime)}`;
    if (b[8] === 2) d += ', max compression';
    else if (b[8] === 4) d += ', max speed';
    if (b[9] === 3) d += ', from Unix';
    if (b.length >= 18) d += `, original size modulo 2^32 ${u32le(b, b.length - 4)}`;
    return kind(d, 'application/gzip');
  }
  if (startsStr(b, 'BZh') && b[3] >= 0x31 && b[3] <= 0x39) return kind(`bzip2 compressed data, block size = ${b[3] - 0x30}00k`, 'application/x-bzip2');
  if (starts(b, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00])) return kind(`XZ compressed data, checksum ${({ 0: 'NONE', 1: 'CRC32', 4: 'CRC64', 10: 'SHA-256' } as Record<number, string>)[b[7] & 15] ?? 'unknown'}`, 'application/x-xz');
  if (starts(b, [0x28, 0xb5, 0x2f, 0xfd])) return kind('Zstandard compressed data (v0.8+), Dictionary ID: None', 'application/zstd');
  if (starts(b, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c])) return kind(`7-zip archive data, version ${b[6]}.${b[7]}`, 'application/x-7z-compressed');
  if (startsStr(b, 'Rar!\x1a\x07')) return kind('RAR archive data', 'application/vnd.rar');
  if (startsStr(b, 'PK\x03\x04')) {
    const v = u16le(b, 4), nameLen = u16le(b, 26), extraLen = u16le(b, 28);
    for (let e = 30 + nameLen; e + 4 <= 30 + nameLen + extraLen; e += 4 + u16le(b, e + 2)) {
      if (u16le(b, e) === 0xcafe) return kind('Java archive data (JAR)', 'application/java-archive');
    }
    const method = ({ 0: 'store', 8: 'deflate', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 95: 'xz' } as Record<number, string>)[u16le(b, 8)];
    return kind(`Zip archive data, at least v${Math.floor(v / 10)}.${v % 10} to extract${method ? `, compression method=${method}` : ''}`, 'application/zip');
  }
  if (startsStr(b, 'PK\x05\x06')) return kind('Zip archive data (empty)', 'application/zip');
  if (startsStr(b, '!<arch>\n')) {
    if (!startsStr(b, 'debian-binary', 8)) return kind('current ar archive', 'application/x-archive');
    // the members after debian-binary: control.tar.*, data.tar.*
    let d = `Debian binary package (format ${ascii(b, 68, 71)})`;
    for (let o = 8, i = 0; o + 60 <= b.length && i < 3; i++) {
      const name = ascii(b, o, o + 16).trim().replace(/\/$/, '');
      const size = parseInt(ascii(b, o + 48, o + 58).trim(), 10) || 0;
      if (name.startsWith('control.tar')) d += `, with ${name}`;
      if (name.startsWith('data.tar')) d += ` , data compression ${name.slice(9) || 'none'}`;
      o += 60 + size + (size & 1);
    }
    return kind(d, 'application/vnd.debian.binary-package');
  }
  if (b.length >= 262 && startsStr(b, 'ustar', 257)) return kind(startsStr(b, 'ustar  \0', 257) ? 'POSIX tar archive (GNU)' : 'POSIX tar archive', 'application/x-tar');
  if (starts(b, [0x00, 0x61, 0x73, 0x6d])) return kind(`WebAssembly (wasm) binary module version 0x${u32le(b, 4).toString(16)}${u32le(b, 4) === 1 ? ' (MVP)' : ''}`, 'application/wasm');
  if (startsStr(b, 'SQLite format 3\0')) return kind(sqlite(b), 'application/vnd.sqlite3');
  if (starts(b, [0, 0, 1, 0]) && b.length >= 22 && u16le(b, 4) > 0 && u16le(b, 4) < 64 && b[9] === 0) {
    const n = u16le(b, 4), w = b[6] || 256, h = b[7] || 256;
    const colors = b[8] ? `, ${b[8]} colors` : u16le(b, 12) ? `, ${u16le(b, 12)} bits/pixel` : '';
    return kind(`MS Windows icon resource - ${n} icon${n > 1 ? 's' : ''}, ${w}x${h}${colors}`, 'image/vnd.microsoft.icon');
  }
  if (startsStr(b, 'OggS')) return kind('Ogg data', 'audio/ogg');
  if (startsStr(b, 'fLaC')) return kind('FLAC audio bitstream data', 'audio/flac');
  if (startsStr(b, 'ID3')) return kind(`Audio file with ID3 version 2.${b[3]}.${b[4]}`, 'audio/mpeg');
  if (startsStr(b, 'ftyp', 4)) return kind('ISO Media', 'video/mp4');
  if (starts(b, [0xcf, 0xfa, 0xed, 0xfe])) return kind('Mach-O 64-bit executable', 'application/x-mach-binary');
  if (starts(b, [0xce, 0xfa, 0xed, 0xfe])) return kind('Mach-O executable', 'application/x-mach-binary');
  if (starts(b, [0xca, 0xfe, 0xba, 0xbe])) {
    return u32be(b, 4) > 30
      ? kind(`compiled Java class data, version ${u16be(b, 6)}.${u16be(b, 4)}`, 'application/x-java-applet')
      : kind('Mach-O universal binary', 'application/x-mach-binary');
  }
  if (startsStr(b, 'MZ')) {
    const pe = b.length > 0x40 ? u32le(b, 0x3c) : 0;
    if (pe && startsStr(b, 'PE\0\0', pe)) {
      const plus = u16le(b, pe + 24) === 0x20b;
      const machine = ({ 0x14c: 'Intel 80386', 0x8664: 'x86-64', 0xaa64: 'Aarch64' } as Record<number, string>)[u16le(b, pe + 4)] ?? 'unknown processor';
      const dll = u16le(b, pe + 22) & 0x2000 ? ' (DLL)' : '';
      return kind(`PE32${plus ? '+' : ''} executable${dll} ${machine}, for MS Windows`, 'application/vnd.microsoft.portable-executable');
    }
    return kind('MS-DOS executable', 'application/x-dosexec');
  }
  return null;
}

function sqlite(b: Uint8Array): string {
  if (b.length < 100) return 'SQLite 3.x database';
  let d = 'SQLite 3.x database';
  if (u32be(b, 60)) d += `, user version ${u32be(b, 60)}`;
  d += `, last written using SQLite version ${u32be(b, 96)}`;
  if (b[18] !== 1 || b[19] !== 1) d += `, writer version ${b[18]}, read version ${b[19]}`;
  d += `, file counter ${u32be(b, 24)}, database pages ${u32be(b, 28)}, cookie 0x${u32be(b, 40).toString(16)}, schema ${u32be(b, 44)}`;
  if (u32be(b, 52)) d += `, largest root page ${u32be(b, 52)}`;
  d += ({ 1: ', UTF-8', 2: ', UTF-16 little endian', 3: ', UTF-16 big endian' } as Record<number, string>)[u32be(b, 56)] ?? '';
  return d + `, version-valid-for ${u32be(b, 92)}`;
}

const MACHINES: Record<number, string> = {
  0x03: 'Intel 80386', 0x08: 'MIPS, MIPS-I', 0x14: 'PowerPC or cisco 4500', 0x15: '64-bit PowerPC or cisco 7500', 0x16: 'IBM S/390',
  0x28: 'ARM', 0x2a: 'Renesas SH', 0x32: 'IA-64', 0x3e: 'x86-64', 0xb7: 'ARM aarch64', 0xf3: 'UCB RISC-V', 0xf7: 'eBPF', 0x102: 'LoongArch',
};
const OSABI: Record<number, string> = { 0: 'SYSV', 3: 'GNU/Linux', 6: 'Solaris', 9: 'FreeBSD', 12: 'OpenBSD' };

function elf(b: Uint8Array): FileType {
  const is64 = b[4] === 2, le = b[5] !== 2;
  if (b.length < (is64 ? 64 : 52)) return kind(`ELF ${is64 ? 64 : 32}-bit ${le ? 'LSB' : 'MSB'} (truncated)`, 'application/octet-stream');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const in_ = (o: number, n: number) => o >= 0 && o + n <= b.length;
  const u16 = (o: number) => (in_(o, 2) ? dv.getUint16(o, le) : 0);
  const u32 = (o: number) => (in_(o, 4) ? dv.getUint32(o, le) : 0);
  const word = (o: number) => (is64 ? (in_(o, 8) ? Number(dv.getBigUint64(o, le)) : 0) : u32(o));
  const type = u16(16), machine = u16(18);
  const phoff = word(is64 ? 32 : 28), shoff = word(is64 ? 40 : 32);
  const phentsize = u16(is64 ? 54 : 42), phnum = u16(is64 ? 56 : 44);
  const shentsize = u16(is64 ? 58 : 46), shnum = u16(is64 ? 60 : 48);

  let interp: string | null = null, dynamic = false, pie = false, needed = false;
  let noteText = '';
  const seen = new Set<number>();
  const notes = (off: number, size: number) => {
    // the GNU build id, and the ABI tag's minimum kernel
    for (let n = off; n + 12 <= off + size;) {
      const namesz = u32(n), descsz = u32(n + 4), ntype = u32(n + 8);
      const name = ascii(b, n + 12, n + 12 + namesz).replace(/\0+$/, '');
      const desc = n + 12 + ((namesz + 3) & ~3);
      if (name === 'GNU' && ntype === 3 && in_(desc, descsz) && !seen.has(3)) {
        const hex = Array.from(b.subarray(desc, desc + descsz), (x) => x.toString(16).padStart(2, '0')).join('');
        noteText += `, BuildID[${descsz === 20 ? 'sha1' : descsz === 16 ? 'md5/uuid' : 'xxHash'}]=${hex}`;
        seen.add(3);
      }
      if (name === 'GNU' && ntype === 1 && descsz >= 16 && u32(desc) === 0 && !seen.has(1)) {
        noteText += `, for GNU/Linux ${u32(desc + 4)}.${u32(desc + 8)}.${u32(desc + 12)}`;
        seen.add(1);
      }
      n = desc + ((descsz + 3) & ~3);
    }
  };
  const segment = (o: number) => ({ off: word(is64 ? o + 8 : o + 4), size: word(is64 ? o + 32 : o + 16) });
  for (let i = 0; i < phnum && phentsize; i++) {
    const o = phoff + i * phentsize;
    if (!in_(o, phentsize)) break;
    const pt = u32(o);
    const { off, size } = segment(o);
    if (!in_(off, size)) continue;
    if (pt === 3) interp = new TextDecoder().decode(b.subarray(off, off + size)).replace(/\0+$/, '');
    if (pt === 2) {
      dynamic = true;
      // DT_FLAGS_1 with DF_1_PIE: an executable, not a library (what file(1) goes by)
      const ent = is64 ? 16 : 8;
      for (let e = off; e + ent <= off + size; e += ent) {
        const tag = word(e);
        if (tag === 0) break;
        if (tag === 1) needed = true;
        if (tag === 0x6ffffffb && word(e + ent / 2) & 0x08000000) pie = true;
      }
    }
    if (pt === 4) notes(off, size);
  }
  let symtab = false, debugInfo = false;
  const shstrndx = u16(is64 ? 62 : 50);
  const strtab = shstrndx < shnum ? word(shoff + shstrndx * shentsize + (is64 ? 24 : 16)) : -1;
  for (let i = 0; i < shnum && shentsize; i++) {
    const o = shoff + i * shentsize;
    if (!in_(o, shentsize)) break;
    if (u32(o + 4) === 2) symtab = true;
    if (u32(o + 4) === 7 && !phnum) notes(word(o + (is64 ? 24 : 16)), word(o + (is64 ? 32 : 20)));
    if (strtab >= 0) {
      const at = strtab + u32(o);
      if (ascii(b, at, at + 12) === '.debug_info\0') debugInfo = true;
    }
  }

  const [typeName, mime] =
    type === 1 ? ['relocatable', 'application/x-object']
    : type === 2 ? ['executable', 'application/x-executable']
    : type === 3 ? (pie ? ['pie executable', 'application/x-pie-executable'] : ['shared object', 'application/x-sharedlib'])
    : type === 4 ? ['core file', 'application/x-coredump']
    : ['unknown type', 'application/octet-stream'];
  let d = `ELF ${is64 ? 64 : 32}-bit ${le ? 'LSB' : 'MSB'} ${typeName}, ${MACHINES[machine] ?? `unknown arch 0x${machine.toString(16)}`}, version ${b[6]} (${OSABI[b[7]] ?? 'unknown'})`;
  if (type === 2 || type === 3) {
    d += interp ? `, dynamically linked, interpreter ${interp}` : dynamic && (pie || !needed) ? ', static-pie linked' : dynamic ? ', dynamically linked' : ', statically linked';
  }
  d += noteText;
  if (debugInfo) d += ', with debug_info';
  if (type !== 4) d += shnum ? (symtab ? ', not stripped' : ', stripped') : ', no section header';
  return kind(d, mime);
}

function validUtf8(b: Uint8Array): boolean {
  try { new TextDecoder('utf-8', { fatal: true }).decode(b); return true; } catch { return false; }
}

const SHEBANGS: [RegExp, string][] = [
  [/^(?:\/usr)?\/bin\/(?:env\s+)?sh\b|^\/usr\/bin\/env\s+sh\b/, 'POSIX shell script'],
  [/\bbash\b/, 'Bourne-Again shell script'],
  [/\bzsh\b/, 'Paul Falstad\'s zsh script'],
  [/\bnode\b/, 'Node.js script'],
  [/\bpython[0-9.]*\b/, 'Python script'],
  [/\bperl\b/, 'Perl script'],
  [/\bruby\b/, 'Ruby script'],
  [/\b(?:awk|gawk)\b/, 'awk or perl script'],
];

function textType(b: Uint8Array): FileType | null {
  let isAscii = true;
  for (let i = 0; i < b.length; i++) {
    const x = b[i];
    if (x === 0) return null;
    if (x >= 0x80) isAscii = false;
    else if (x < 0x20 && x !== 7 && x !== 8 && x !== 9 && x !== 10 && x !== 11 && x !== 12 && x !== 13 && x !== 27) return null;
  }
  const bom = starts(b, [0xef, 0xbb, 0xbf]);
  let textDesc: string, encoding: string;
  if (isAscii) { textDesc = 'ASCII text'; encoding = 'us-ascii'; }
  else if (validUtf8(b)) { textDesc = bom ? 'Unicode text, UTF-8 (with BOM) text' : 'Unicode text, UTF-8 text'; encoding = 'utf-8'; }
  else if (b.every((x) => x < 0x80 || x >= 0xa0)) { textDesc = 'ISO-8859 text'; encoding = 'iso-8859-1'; }
  else { textDesc = 'Non-ISO extended-ASCII text'; encoding = 'unknown-8bit'; }

  const text = new TextDecoder().decode(b);
  const head = text.slice(bom ? 1 : 0, 4096);
  let what: string | null = null, mime = 'text/plain', executable = false;
  const shebang = /^#!\s*(\S+(?:\s+\S+)?)/.exec(head);
  if (shebang) {
    executable = true;
    const interp = shebang[1];
    const known = SHEBANGS.find(([re]) => re.test(interp));
    what = known ? known[1] : `a ${interp} script`;
    mime = known?.[1].startsWith('Python') ? 'text/x-script.python' : known?.[1].startsWith('Node') ? 'application/javascript' : 'text/x-shellscript';
  } else if (/^\s*[[{]/.test(head) && isJson(text)) {
    return kind('JSON text data', 'application/json', encoding);
  } else if (/^\s*<!doctype html|^\s*<html[\s>]/i.test(head)) {
    what = 'HTML document'; mime = 'text/html';
  } else if (/^\s*<\?xml\s/i.test(head)) {
    what = /<svg[\s>]/i.test(head) ? 'SVG Scalable Vector Graphics image' : 'XML 1.0 document';
    mime = what.startsWith('SVG') ? 'image/svg+xml' : 'text/xml';
    if (what.startsWith('SVG')) return kind(what, mime, encoding);
  } else if (/^\s*<svg[\s>]/i.test(head)) {
    return kind('SVG Scalable Vector Graphics image', 'image/svg+xml', encoding);
  } else if (/^-----BEGIN CERTIFICATE-----/.test(head)) {
    return kind('PEM certificate', 'text/plain', encoding);
  } else if (/^-----BEGIN OPENSSH PRIVATE KEY-----/.test(head)) {
    return kind('OpenSSH private key', 'text/plain', encoding);
  } else if (/^-----BEGIN (RSA |EC |)PRIVATE KEY-----/.test(head)) {
    const m = /^-----BEGIN (RSA |EC |)PRIVATE KEY-----/.exec(head)!;
    return kind(`PEM ${m[1] ? m[1] : ''}private key`, 'text/plain', encoding);
  } else if (/^-----BEGIN PGP (PUBLIC KEY BLOCK|SIGNATURE|MESSAGE)-----/.test(head)) {
    return kind(`PGP ${/PUBLIC/.test(head) ? 'public key block' : /SIGNATURE/.test(head) ? 'signature' : 'message'}`, 'application/pgp-keys', encoding);
  } else if (/^ssh-(ed25519|rsa|dss) /.test(head)) {
    return kind(`OpenSSH ${head.startsWith('ssh-ed25519') ? 'ED25519' : head.startsWith('ssh-rsa') ? 'RSA' : 'DSA'} public key`, 'text/plain', encoding);
  } else if (/^(diff --git |--- \S.*\n\+\+\+ \S)/.test(head)) {
    what = 'unified diff output'; mime = 'text/x-diff';
  } else if (/^#include\s*[<"]/m.test(head) && /\b(int|void|char)\b/.test(head)) {
    what = 'C source'; mime = 'text/x-c';
  }

  let desc = !what ? textDesc
    : what === 'Perl script' ? `Perl script text${executable ? ' executable' : ''}`
    : what === 'Node.js script' ? `Node.js script executable, ${textDesc}`
    : `${what}, ${textDesc}${executable ? ' executable' : ''}`;
  let longest = 0;
  for (let i = 0, start = 0; i <= text.length; i++) {
    if (i === text.length || text.charCodeAt(i) === 10) { longest = Math.max(longest, i - start); start = i + 1; }
  }
  if (longest > 300) desc += `, with very long lines (${longest})`;
  if (text.includes('\r\n')) desc += ', with CRLF line terminators';
  else if (text.includes('\r')) desc += ', with CR line terminators';
  else if (!text.includes('\n')) desc += ', with no line terminators';
  return kind(desc, mime, encoding);
}

function isJson(text: string): boolean {
  try { JSON.parse(text); return true; } catch { return false; }
}
