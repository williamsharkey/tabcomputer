/**
 * stat, as GNU coreutils: the default report, -c/--format (a newline after
 * each file), --printf (backslash escapes, no newline), -t, -L. Format
 * directives take printf's flags and width (`%-10n`, `%05a`).
 */
import type { Command } from './index';
import { statEntry, type StatEntry } from './flags';

const USAGE = "Try 'stat --help' for more information.\n";

/** %F: GNU stat's names */
function fileType(st: StatEntry): string {
  return st.type === 'dir' ? 'directory' : st.type === 'symlink' ? 'symbolic link' : st.fifo ? 'fifo'
    : st.size === 0 ? 'regular empty file' : 'regular file';
}

/** st_mode with its file-type bits */
function fullMode(st: StatEntry): number {
  const type = st.type === 'dir' ? 0o040000 : st.type === 'symlink' ? 0o120000 : st.fifo ? 0o010000 : 0o100000;
  return type | (st.mode & 0o7777);
}

/** %A: `drwxr-xr-x`, with setuid/setgid/sticky */
function modeString(st: StatEntry): string {
  const m = st.mode & 0o7777;
  const t = st.type === 'dir' ? 'd' : st.type === 'symlink' ? 'l' : st.fifo ? 'p' : '-';
  const x = (bit: number, special: number, on: string, off: string) =>
    m & special ? (m & bit ? on : off) : m & bit ? 'x' : '-';
  return t + (m & 0o400 ? 'r' : '-') + (m & 0o200 ? 'w' : '-') + x(0o100, 0o4000, 's', 'S')
    + (m & 0o040 ? 'r' : '-') + (m & 0o020 ? 'w' : '-') + x(0o010, 0o2000, 's', 'S')
    + (m & 0o004 ? 'r' : '-') + (m & 0o002 ? 'w' : '-') + x(0o001, 0o1000, 't', 'T');
}

/** %y: `2024-01-02 03:04:05.678000000 +0000` (the machine's clock is UTC) */
function humanTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}.${p(d.getUTCMilliseconds(), 3)}000000 +0000`;
}

const blocks = (st: StatEntry) => (st.type === 'dir' ? 8 : Math.ceil(st.size / 4096) * 8);
const sizeOf = (st: StatEntry) => (st.type === 'dir' ? 4096 : st.type === 'symlink' ? (st.target?.length ?? st.size) : st.size);

function directive(c: string, name: string, st: StatEntry): string | null {
  const secs = String(Math.floor(st.mtime / 1000));
  switch (c) {
    case 'n': return name;
    case 'N': return st.type === 'symlink' && st.target !== undefined ? `'${name}' -> '${st.target}'` : `'${name}'`;
    case 's': return String(sizeOf(st));
    case 'b': return String(blocks(st));
    case 'B': return '512';
    case 'o': return '4096';
    case 'f': return fullMode(st).toString(16);
    case 'a': return (st.mode & 0o7777).toString(8);
    case 'A': return modeString(st);
    case 'F': return fileType(st);
    case 'u': case 'g': return '0';
    case 'U': case 'G': return 'root';
    case 'i': return String(st.ino ?? 0);
    case 'h': return String(st.nlink ?? (st.type === 'dir' ? 2 : 1));
    case 'd': return '0';
    case 'D': return '0';
    case 't': case 'T': return '0';
    case 'm': return '/';
    case 'w': case 'x': case 'y': case 'z': return humanTime(st.mtime);
    case 'W': case 'X': case 'Y': case 'Z': return secs;
    default: return null;
  }
}

/** One file through a format: directives, and with --printf backslash escapes */
function render(format: string, name: string, st: StatEntry, escapes: boolean): string {
  let out = '';
  for (let i = 0; i < format.length; i++) {
    const ch = format[i];
    if (ch === '\\' && escapes && i + 1 < format.length) {
      const e = format[++i];
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '"': '"', e: '\x1b' };
      if (e in simple) { out += simple[e]; continue; }
      const oct = /^[0-7]{1,3}/.exec(format.slice(i));
      if (oct) { out += String.fromCharCode(parseInt(oct[0], 8)); i += oct[0].length - 1; continue; }
      const hex = e === 'x' ? /^[0-9a-fA-F]{1,2}/.exec(format.slice(i + 1)) : null;
      if (hex) { out += String.fromCharCode(parseInt(hex[0], 16)); i += hex[0].length; continue; }
      out += '\\' + e;
      continue;
    }
    if (ch !== '%') { out += ch; continue; }
    const m = /^%([-#+ 0']*)(\d*)(?:\.(\d+))?([a-zA-Z%])/.exec(format.slice(i));
    if (!m) { out += ch; continue; }
    i += m[0].length - 1;
    if (m[4] === '%') { out += '%'; continue; }
    const v = directive(m[4], name, st);
    if (v === null) { out += '?'; continue; }
    const width = Number(m[2] || 0);
    const numeric = /^-?\d+$/.test(v) && m[4] !== 'n';
    if (v.length >= width) out += v;
    else if (m[1].includes('-')) out += v.padEnd(width);
    else if (m[1].includes('0') && numeric) out += v.padStart(width, '0');
    else out += v.padStart(width);
  }
  return out;
}

function report(name: string, st: StatEntry): string {
  const t = humanTime(st.mtime);
  const shown = st.type === 'symlink' && st.target !== undefined ? `${name} -> ${st.target}` : name;
  return `  File: ${shown}\n`
    + `  Size: ${String(sizeOf(st)).padEnd(10)}\tBlocks: ${String(blocks(st)).padEnd(10)} IO Block: 4096   ${fileType(st)}\n`
    + `Device: 0,0\tInode: ${String(st.ino ?? 0).padEnd(11)} Links: ${st.nlink ?? (st.type === 'dir' ? 2 : 1)}\n`
    + `Access: (${(st.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(st)})  Uid: (    0/    root)   Gid: (    0/    root)\n`
    + `Access: ${t}\nModify: ${t}\nChange: ${t}\n Birth: ${t}\n`;
}

export const stat: Command = {
  name: 'stat',
  description: 'Display file status',
  async exec(ctx) {
    const args = ctx.args;
    let format: string | null = null, escapes = false, terse = false, deref = false;
    const files: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { files.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--')) {
        const eq = a.indexOf('=');
        const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
        const val = () => (eq < 0 ? args[++i] : a.slice(eq + 1));
        if (name === 'format') { format = val() ?? ''; escapes = false; }
        else if (name === 'printf') { format = val() ?? ''; escapes = true; }
        else if (name === 'dereference') deref = true;
        else if (name === 'terse') terse = true;
        else if (name === 'file-system' || name === 'cached') { if (name === 'cached' && eq < 0) i++; }
        else { ctx.stderr += `stat: unrecognized option '${a}'\n${USAGE}`; return 1; }
        continue;
      }
      if (a.length < 2 || a[0] !== '-') { files.push(a); continue; }
      for (let j = 1; j < a.length; j++) {
        const c = a[j];
        if (c === 'L') deref = true;
        else if (c === 't') terse = true;
        else if (c === 'f') { /* file system status: the file's, as before */ }
        else if (c === 'c') { format = a.slice(j + 1) || args[++i]; escapes = false; if (format === undefined) { ctx.stderr += `stat: option requires an argument -- 'c'\n${USAGE}`; return 1; } break; }
        else { ctx.stderr += `stat: invalid option -- '${c}'\n${USAGE}`; return 1; }
      }
    }
    if (!files.length) { ctx.stderr += `stat: missing operand\n${USAGE}`; return 1; }

    let status = 0;
    for (const name of files) {
      let st: StatEntry;
      try {
        st = await statEntry(ctx.fs, ctx.fs.resolvePath(name, ctx.cwd), deref);
      } catch {
        ctx.stderr += `stat: cannot statx '${name}': No such file or directory\n`;
        status = 1;
        continue;
      }
      if (format !== null) ctx.stdout += render(format, name, st, escapes) + (escapes ? '' : '\n');
      else if (terse) {
        const s = Math.floor(st.mtime / 1000);
        ctx.stdout += `${name} ${sizeOf(st)} ${blocks(st)} ${fullMode(st).toString(16)} 0 0 0 ${st.ino ?? 0} ${st.nlink ?? 1} 0 0 ${s} ${s} ${s} ${s} 4096\n`;
      } else ctx.stdout += report(name, st);
    }
    return status;
  },
};
