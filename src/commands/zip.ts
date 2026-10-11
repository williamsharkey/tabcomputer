/**
 * zip / unzip, as Info-ZIP's zip 3.0 and unzip 6.0 behave for the common
 * forms. zip: bundled flags (-qr, -rq, -r9), -r, -q, -j, -D, -0..-9, -x/-i
 * patterns, -d (delete members), -u/-f, -m, -T, -@; adds to (and updates in)
 * an existing archive, "adding: f (deflated N%)", directory entries, the
 * files' times and modes. unzip: -l, -v, -Z1, -t, -p, -o, -n, -q/-qq, -j,
 * -d DIR, member patterns and -x, restored times and modes.
 */
import { Command, CommandContext } from './index';
import { pipeBytes } from '../utils/stream-bytes';
import { outputString } from './compress/bytes';

// CRC-32 lookup table
const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[i] = c;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = crcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

async function deflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipeBytes(data, new CompressionStream('deflate-raw'));
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  return pipeBytes(data, new DecompressionStream('deflate-raw'));
}

/** One member: its header fields and its (compressed) bytes */
interface Member {
  name: string;
  method: number; // 0 stored, 8 deflated
  crc: number;
  csize: number;
  usize: number;
  dosTime: number;
  dosDate: number;
  mode: number; // unix mode (0: none recorded)
  data: Uint8Array; // as stored in the archive
}

function toDos(ms: number): { dosTime: number; dosDate: number } {
  const d = new Date(ms);
  const year = Math.max(1980, d.getFullYear());
  return {
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    dosDate: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDos(m: Member): Date {
  return new Date(((m.dosDate >> 9) & 0x7f) + 1980, ((m.dosDate >> 5) & 0xf) - 1, m.dosDate & 0x1f,
    (m.dosTime >> 11) & 0x1f, (m.dosTime >> 5) & 0x3f, (m.dosTime & 0x1f) * 2);
}

const pad2 = (n: number) => String(n).padStart(2, '0');
function dosStamp(m: Member): string {
  const d = fromDos(m);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Info-ZIP's percent(): the space saved, rounded half up */
function percent(n: number, m: number): number {
  if (n > 0xffffff) { n = (n + 0x80) >>> 8; m = (m + 0x80) >>> 8; }
  return n > m ? Math.trunc(1 + Math.trunc((Math.trunc((200 * (n - m)) / n) - 1) / 2)) : 0;
}

/** A zip wildcard: * and ? match across '/', [..] a class */
function wildRe(p: string): RegExp {
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*') re += '.*';
    else if (ch === '?') re += '.';
    else if (ch === '[') { const j = p.indexOf(']', i + 1); if (j < 0) re += '\\['; else { re += '[' + p.slice(i + 1, j).replace(/^!/, '^') + ']'; i = j; } }
    else if (ch === '\\' && i + 1 < p.length) re += '\\' + p[++i];
    else re += ch.replace(/[.+^$(){}|\\/]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

export function readZip(data: Uint8Array): Member[] | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocd = -1;
  for (let j = data.length - 22; j >= Math.max(0, data.length - 22 - 0xffff); j--) {
    if (view.getUint32(j, true) === 0x06054b50) { eocd = j; break; }
  }
  if (eocd < 0) return null;
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const out: Member[] = [];
  const dec = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > data.length || view.getUint32(p, true) !== 0x02014b50) break;
    const madeBy = view.getUint16(p + 4, true) >> 8;
    const nameLen = view.getUint16(p + 28, true), extraLen = view.getUint16(p + 30, true), commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const csize = view.getUint32(p + 20, true);
    const ext = view.getUint32(p + 38, true);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    out.push({
      name: dec.decode(data.subarray(p + 46, p + 46 + nameLen)),
      method: view.getUint16(p + 10, true),
      dosTime: view.getUint16(p + 12, true),
      dosDate: view.getUint16(p + 14, true),
      crc: view.getUint32(p + 16, true),
      csize,
      usize: view.getUint32(p + 24, true),
      mode: madeBy === 3 ? ext >>> 16 : 0,
      data: data.subarray(start, start + csize),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

function writeZip(members: Member[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const m of members) {
    const name = enc.encode(m.name);
    const utf8 = /[^\x00-\x7f]/.test(m.name) ? 0x800 : 0;
    const lh = new DataView(new ArrayBuffer(30 + name.length));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, m.method === 8 ? 20 : 10, true);
    lh.setUint16(6, utf8, true);
    lh.setUint16(8, m.method, true);
    lh.setUint16(10, m.dosTime, true);
    lh.setUint16(12, m.dosDate, true);
    lh.setUint32(14, m.crc, true);
    lh.setUint32(18, m.csize, true);
    lh.setUint32(22, m.usize, true);
    lh.setUint16(26, name.length, true);
    new Uint8Array(lh.buffer).set(name, 30);
    parts.push(new Uint8Array(lh.buffer), m.data);

    const ch = new DataView(new ArrayBuffer(46 + name.length));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, m.mode ? 0x031e : 20, true); // made by: unix, zip 3.0
    ch.setUint16(6, m.method === 8 ? 20 : 10, true);
    ch.setUint16(8, utf8, true);
    ch.setUint16(10, m.method, true);
    ch.setUint16(12, m.dosTime, true);
    ch.setUint16(14, m.dosDate, true);
    ch.setUint32(16, m.crc, true);
    ch.setUint32(20, m.csize, true);
    ch.setUint32(24, m.usize, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(38, ((m.mode & 0xffff) << 16 | (m.name.endsWith('/') ? 0x10 : 0)) >>> 0, true);
    ch.setUint32(42, offset, true);
    new Uint8Array(ch.buffer).set(name, 46);
    central.push(new Uint8Array(ch.buffer));
    offset += 30 + name.length + m.data.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, members.length, true);
  eocd.setUint16(10, members.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let pos = 0;
  for (const part of [...parts, ...central, new Uint8Array(eocd.buffer)]) { out.set(part, pos); pos += part.length; }
  return out;
}

async function fileBytes(ctx: CommandContext, path: string): Promise<Uint8Array> {
  const data = await ctx.fs.readFile(path);
  return data instanceof Uint8Array ? data : new TextEncoder().encode(data as unknown as string);
}

/** The member's contents, or null when its data doesn't check out */
async function memberBytes(m: Member): Promise<Uint8Array | null> {
  try {
    const bytes = m.method === 0 ? m.data : m.method === 8 ? await inflateRaw(m.data) : null;
    return bytes && bytes.length === m.usize && crc32(bytes) === m.crc ? bytes : null;
  } catch { return null; }
}

const ZIP_USAGE = `Copyright (c) 1990-2008 Info-ZIP - Type 'zip "-L"' for software license.
Zip 3.0 (July 5th 2008). Usage:
zip [-options] [-b path] [-t mmddyyyy] [-n suffixes] [zipfile list] [-xi list]
  The default action is to add or replace zipfile entries from list.
  -f   freshen: only changed files  -u   update: only changed or new files
  -d   delete entries in zipfile    -m   move into zipfile (delete OS files)
  -r   recurse into directories     -j   junk (don't record) directory names
  -0   store only                   -D   do not add directory entries
  -q   quiet operation              -T   test zipfile integrity
  -x   exclude the following names  -i   include only the following names
  -@   read names from stdin
`;

export const zipCmd: Command = {
  name: 'zip',
  description: 'Create ZIP archives',
  async exec(ctx) {
    let recursive = false, quiet = false, junk = false, noDirs = false, store = false;
    let del = false, update = false, freshen = false, move = false, test = false, namesStdin = false;
    let archive = '';
    const names: string[] = [];
    const exclude: RegExp[] = [], include: RegExp[] = [];
    let listFor: RegExp[] | null = null; // -x / -i: the patterns that follow

    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--') { names.push(...args.slice(i + 1)); break; }
      if (a.startsWith('--') && a.length > 2) {
        listFor = null;
        const long: Record<string, () => void> = {
          'recurse-paths': () => { recursive = true; }, quiet: () => { quiet = true; }, 'junk-paths': () => { junk = true; },
          'no-dir-entries': () => { noDirs = true; }, delete: () => { del = true; }, update: () => { update = true; },
          freshen: () => { freshen = true; }, move: () => { move = true; }, test: () => { test = true; },
          'names-stdin': () => { namesStdin = true; }, exclude: () => { listFor = exclude; }, include: () => { listFor = include; },
        };
        const f = long[a.slice(2)];
        if (f) f();
        else if (a === '--help') { ctx.stdout = ZIP_USAGE; return 0; }
        continue;
      }
      if (a.startsWith('-') && a.length > 1) {
        listFor = null;
        for (const ch of a.slice(1)) {
          switch (ch) {
            case 'r': case 'R': recursive = true; break;
            case 'q': quiet = true; break;
            case 'j': junk = true; break;
            case 'D': noDirs = true; break;
            case '0': store = true; break;
            case 'd': del = true; break;
            case 'u': update = true; break;
            case 'f': freshen = true; break;
            case 'm': move = true; break;
            case 'T': test = true; break;
            case '@': namesStdin = true; break;
            case 'x': listFor = exclude; break;
            case 'i': listFor = include; break;
            default: break; // -1..-9, -y, -X, -v, -o, ...: accepted
          }
        }
        continue;
      }
      if (listFor) listFor.push(wildRe(a));
      else if (!archive) archive = a;
      else names.push(a);
    }
    if (namesStdin) names.push(...(ctx.readStdin ? await ctx.readStdin() : ctx.stdin).split('\n').filter(Boolean));

    if (!archive) {
      ctx.stdout = ZIP_USAGE;
      return 0;
    }
    if (!/\.[^/]*$/.test(archive.replace(/^.*\//, ''))) archive += '.zip';
    const archivePath = ctx.fs.resolvePath(archive, ctx.cwd);
    let members: Member[] = [];
    let existed = false;
    try {
      const old = readZip(await fileBytes(ctx, archivePath));
      if (!old) { ctx.stdout = `\nzip error: Zip file structure invalid (${archive})\n`; return 3; }
      members = old;
      existed = true;
    } catch { /* a new archive */ }
    const say = (s: string) => { if (!quiet) ctx.stdout += s; };
    const warn = (s: string) => { ctx.stdout += `\tzip warning: ${s}\n`; };
    const nothing = () => { ctx.stdout += `\nzip error: Nothing to do! (${archive})\n`; return 12; };

    if (del) {
      let n = 0;
      for (const pat of names) {
        const re = wildRe(pat);
        const hit = members.filter((m) => re.test(m.name));
        if (!hit.length) warn(`name not matched: ${pat}`);
        for (const m of hit) { say(`deleting: ${m.name}\n`); n++; }
        members = members.filter((m) => !re.test(m.name));
      }
      if (!n) return nothing();
      await ctx.fs.writeFile(archivePath, writeZip(members));
      return 0;
    }

    // the files to add: [path on disk, member name]
    const found: { path: string; name: string; dir: boolean; mtime: number; mode: number }[] = [];
    const selected = (name: string) => !exclude.some((re) => re.test(name)) && (!include.length || include.some((re) => re.test(name)));
    const visit = async (path: string, name: string) => {
      const st = await ctx.fs.stat(path);
      if (st.isDirectory()) {
        const dname = name.replace(/\/*$/, '/');
        if (!junk && !noDirs && dname !== '/' && dname !== './' && selected(dname))
          found.push({ path, name: dname, dir: true, mtime: st.mtime?.getTime?.() ?? Date.now(), mode: (st as any).mode ?? 0o40755 });
        if (!recursive) return;
        for (const child of await ctx.fs.readdir(path)) {
          await visit(path === '/' ? '/' + child : path + '/' + child, (dname === './' ? '' : dname) + child);
        }
      } else if (st.isFIFO?.()) {
        warn(`ignoring FIFO (Named Pipe) - use -FI to read: ${name}`);
      } else if (selected(name)) {
        found.push({ path, name: junk ? name.replace(/^.*\//, '') : name, dir: false, mtime: st.mtime?.getTime?.() ?? Date.now(), mode: (st as any).mode ?? 0o100644 });
      }
    };
    for (const n of names) {
      const path = ctx.fs.resolvePath(n, ctx.cwd);
      if (path === archivePath) continue;
      let ok = true;
      try { await ctx.fs.stat(path); } catch { ok = false; }
      if (!ok) { warn(`name not matched: ${n}`); continue; }
      // member names are relative: no leading / or ./
      await visit(path, n.replace(/^(\.\/)+/, '').replace(/^\/+/, '') || '.');
    }

    let changed = 0;
    for (const f of found) {
      const at = members.findIndex((m) => m.name === f.name);
      const { dosTime, dosDate } = toDos(f.mtime);
      if (at >= 0 && (update || freshen)) {
        const old = members[at];
        if (old.dosDate > dosDate || (old.dosDate === dosDate && old.dosTime >= dosTime)) continue;
      }
      if (at < 0 && freshen) continue;
      let data: Uint8Array = new Uint8Array(0), method = 0, crc = 0, usize = 0;
      if (!f.dir) {
        const raw = await fileBytes(ctx, f.path);
        crc = crc32(raw);
        usize = raw.length;
        data = raw;
        if (!store && raw.length) {
          const z = await deflateRaw(raw);
          if (z.length < raw.length) { data = z; method = 8; }
        }
      }
      const m: Member = { name: f.name, method, crc, csize: data.length, usize, dosTime, dosDate, mode: f.mode, data };
      say(`${at >= 0 ? 'updating' : '  adding'}: ${f.name} (${method === 8 ? `deflated ${percent(usize, data.length)}%` : 'stored 0%'})\n`);
      if (at >= 0) members[at] = m; else members.push(m);
      changed++;
    }
    if (!changed && !(existed && test)) {
      if (update || freshen) return 12; // (nothing newer: no message)
      return nothing();
    }
    if (changed) await ctx.fs.writeFile(archivePath, writeZip(members));

    if (move) {
      for (const f of found.filter((x) => !x.dir)) await ctx.fs.unlink(f.path).catch(() => {});
      for (const f of found.filter((x) => x.dir).reverse()) await ctx.fs.rmdir(f.path).catch(() => {});
    }
    if (test) {
      for (const m of members) {
        if (!m.name.endsWith('/') && !(await memberBytes(m))) { ctx.stdout += `test of ${archive} FAILED\n\nzip error: Zip file invalid, could not spawn unzip, or wrong unzip (original files unmodified)\n`; return 8; }
      }
      say(`test of ${archive} OK\n`);
    }
    return 0;
  },
};

export const unzipCmd: Command = {
  name: 'unzip',
  description: 'Extract ZIP archives',
  async exec(ctx) {
    let list = false, verbose = false, names1 = false, test = false, pipe = false, junk = false;
    let overwrite: 'ask' | 'always' | 'never' = 'ask';
    let quiet = 0;
    let outputDir = '';
    let zipFile = '';
    const members: string[] = [];
    const exclude: string[] = [];
    let inExclude = false;

    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '-Z1' || (a === '-Z' && args[i + 1] === '-1')) { names1 = true; if (a === '-Z') i++; continue; }
      if (a.startsWith('-') && a.length > 1) {
        inExclude = false;
        for (let k = 1; k < a.length; k++) {
          const ch = a[k];
          if (ch === 'l') list = true;
          else if (ch === 'v') verbose = true;
          else if (ch === 't') test = true;
          else if (ch === 'p' || ch === 'c') pipe = true;
          else if (ch === 'o') overwrite = 'always';
          else if (ch === 'n') overwrite = 'never';
          else if (ch === 'q') quiet++;
          else if (ch === 'j') junk = true;
          else if (ch === 'x') inExclude = true;
          else if (ch === 'd') {
            outputDir = k + 1 < a.length ? a.slice(k + 1) : args[++i] ?? '';
            break;
          }
        }
        continue;
      }
      if (inExclude) exclude.push(a);
      else if (!zipFile) zipFile = a;
      else members.push(a);
    }
    if (!zipFile) {
      ctx.stdout = 'UnZip 6.00 of 20 April 2009, by Debian. Original by Info-ZIP.\n\nUsage: unzip [-Z] [-opts[modifiers]] file[.zip] [list] [-x xlist] [-d exdir]\n';
      return 0;
    }

    let data: Uint8Array | null = null;
    for (const cand of [zipFile, zipFile + '.zip', zipFile + '.ZIP']) {
      try { data = await fileBytes(ctx, ctx.fs.resolvePath(cand, ctx.cwd)); zipFile = cand; break; } catch { /* next */ }
    }
    if (!data) {
      ctx.stderr = `unzip:  cannot find or open ${zipFile}, ${zipFile}.zip or ${zipFile}.ZIP.\n`;
      return 9;
    }
    const all = readZip(data);
    if (!all) {
      ctx.stderr = `  End-of-central-directory signature not found.  Either this file is not\n  a zipfile, or it constitutes one disk of a multi-part archive.  In the\n  latter case the central directory and zipfile comment will be found on\n  the last disk(s) of this archive.\nunzip:  cannot find zipfile directory in ${zipFile}.\n`;
      return 9;
    }
    const inc = members.map(wildRe), exc = exclude.map(wildRe);
    const chosen = all.filter((m) => (!inc.length || inc.some((re) => re.test(m.name))) && !exc.some((re) => re.test(m.name)));
    let status = 0;
    const unmatched = members.filter((p) => !all.some((m) => wildRe(p).test(m.name)));

    if (names1) {
      for (const m of chosen) ctx.stdout += m.name + '\n';
      return 0;
    }
    if (pipe) {
      const out: Uint8Array[] = [];
      for (const m of chosen) {
        if (m.name.endsWith('/')) continue;
        const b = await memberBytes(m);
        if (b) out.push(b);
      }
      const total = new Uint8Array(out.reduce((n, b) => n + b.length, 0));
      let at = 0;
      for (const b of out) { total.set(b, at); at += b.length; }
      if (ctx.stdoutBytes) ctx.stdoutBytes(total);
      else ctx.stdout += outputString(total);
      return 0;
    }

    const header = () => { if (quiet < 1 || (list && quiet < 2)) ctx.stdout += `Archive:  ${zipFile}\n`; };
    if (verbose) {
      header();
      ctx.stdout += ' Length   Method    Size  Cmpr    Date    Time   CRC-32   Name\n--------  ------  ------- ---- ---------- ----- --------  ----\n';
      let u = 0, c = 0;
      for (const m of chosen) {
        ctx.stdout += `${String(m.usize).padStart(8)}  ${(m.method === 8 ? 'Defl:N' : 'Stored').padEnd(6)} ${String(m.csize).padStart(7)} ${String(percent(m.usize, m.csize)).padStart(3)}% ${dosStamp(m)} ${m.crc.toString(16).padStart(8, '0')}  ${m.name}\n`;
        u += m.usize; c += m.csize;
      }
      ctx.stdout += `--------          -------  ---                            -------\n${String(u).padStart(8)}         ${String(c).padStart(8)} ${String(percent(u, c)).padStart(3)}%                            ${chosen.length} file${chosen.length === 1 ? '' : 's'}\n`;
      return 0;
    }
    if (list) {
      header();
      if (quiet < 2) ctx.stdout += '  Length      Date    Time    Name\n---------  ---------- -----   ----\n';
      let u = 0;
      for (const m of chosen) { ctx.stdout += `${String(m.usize).padStart(9)}  ${dosStamp(m)}   ${m.name}\n`; u += m.usize; }
      if (quiet < 2) ctx.stdout += `---------                     -------\n${String(u).padStart(9)}                     ${chosen.length} file${chosen.length === 1 ? '' : 's'}\n`;
      return 0;
    }
    if (test) {
      header();
      let bad = 0;
      for (const m of chosen) {
        const ok = m.name.endsWith('/') || !!(await memberBytes(m));
        if (!ok) bad++;
        if (quiet < 1) ctx.stdout += `    testing: ${m.name.padEnd(24)} ${ok ? 'OK' : 'bad CRC'}\n`;
      }
      if (bad) { ctx.stdout += `At least one error was detected in ${zipFile}.\n`; return 2; }
      if (quiet < 2) ctx.stdout += `No errors detected in compressed data of ${zipFile}.\n`;
      return 0;
    }

    header();
    const base = outputDir ? ctx.fs.resolvePath(outputDir, ctx.cwd) : ctx.cwd;
    const shown = (n: string) => (outputDir ? outputDir.replace(/\/*$/, '/') : '') + n;
    let declined = false;
    const times: [string, Date, number][] = [];
    for (const m of chosen) {
      let name = m.name.replace(/^\/+/, '');
      if (name.split('/').includes('..')) { ctx.stderr += `warning:  skipped "../" path component(s) in ${m.name}\n`; name = name.split('/').filter((s) => s !== '..').join('/'); }
      if (junk) { if (name.endsWith('/')) continue; name = name.replace(/^.*\//, ''); }
      const full = base === '/' ? '/' + name : base + '/' + name;
      if (name.endsWith('/')) {
        await ctx.fs.mkdir(full.replace(/\/$/, ''), { recursive: true });
        if (quiet < 1) ctx.stdout += `   creating: ${shown(name)}\n`;
        times.push([full.replace(/\/$/, ''), fromDos(m), m.mode]);
        continue;
      }
      let exists = true;
      try { await ctx.fs.stat(full); } catch { exists = false; }
      if (exists && overwrite !== 'always') {
        if (overwrite === 'ask' && !declined) {
          // no terminal to ask on: unzip reads EOF and takes it as [N]one
          ctx.stderr += `replace ${shown(name)}? [y]es, [n]o, [A]ll, [N]one, [r]ename:  NULL\n(EOF or read error, treating as "[N]one" ...)\n`;
          declined = true;
          status = 1;
        }
        continue;
      }
      const bytes = await memberBytes(m);
      if (!bytes) { ctx.stderr += `  error:  invalid compressed data to inflate ${shown(name)}\n`; status = 2; continue; }
      const dir = full.slice(0, full.lastIndexOf('/'));
      if (dir) await ctx.fs.mkdir(dir, { recursive: true });
      await ctx.fs.writeFile(full, bytes);
      if (quiet < 1) ctx.stdout += `${m.method === 8 ? '  inflating' : ' extracting'}: ${shown(name).padEnd(22)}  \n`;
      times.push([full, fromDos(m), m.mode]);
    }
    // the members' times and permissions (directories last, as their files change them)
    for (const [path, when, mode] of times.reverse()) {
      if (mode & 0o777) await ctx.fs.chmod(path, mode & 0o7777).catch(() => {});
      await (ctx.fs as any).utimes?.(path, when.getTime(), when.getTime()).catch?.(() => {});
    }
    if (unmatched.length) {
      for (const p of unmatched) ctx.stderr += `caution: filename not matched:  ${p}\n`;
      return 11;
    }
    return status;
  },
};
