/**
 * A prepared Claude Code layout as one file (extract.ts renderVmLayout), built
 * offline and served at /claude-vm-layout/<sha256>/<VM_LAYOUT>/pack. The page
 * downloads it instead of transforming the modules itself. Paths in the file
 * use `placeholder`; the page swaps in its own layout directory.
 */
export const VM_DIR_PLACEHOLDER = '@@TCVMDIR@@';

const MAGIC = 'TCVMPACK1\n';

export interface PackedFile { rel: string; bytes: Uint8Array }

export interface DecodedLayoutPack {
  vmLayout: number;
  placeholder: string;
  sha256: string;
  version: string;
  files: PackedFile[];
}

export function encodeLayoutPack(meta: { vmLayout: number; placeholder: string; sha256: string; version: string; files: PackedFile[] }): Uint8Array {
  let blob = 0;
  const files = meta.files.map((f) => {
    const offset = blob;
    blob += f.bytes.length;
    return { rel: f.rel, offset, length: f.bytes.length };
  });
  const header = new TextEncoder().encode(JSON.stringify({
    vmLayout: meta.vmLayout, placeholder: meta.placeholder, sha256: meta.sha256, version: meta.version, files,
  }));
  const magic = new TextEncoder().encode(MAGIC);
  const out = new Uint8Array(magic.length + 4 + header.length + blob);
  const view = new DataView(out.buffer);
  out.set(magic, 0);
  view.setUint32(magic.length, header.length, true);
  out.set(header, magic.length + 4);
  let at = magic.length + 4 + header.length;
  for (const f of meta.files) { out.set(f.bytes, at); at += f.bytes.length; }
  return out;
}

export function decodeLayoutPack(bytes: Uint8Array): DecodedLayoutPack {
  const magic = new TextEncoder().encode(MAGIC);
  if (bytes.length < magic.length + 4 || !magic.every((b, i) => bytes[i] === b)) throw new Error('not a Claude Code layout pack');
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(magic.length, true);
  const headerAt = magic.length + 4;
  if (headerLen <= 0 || headerAt + headerLen > bytes.length) throw new Error('Claude Code layout pack header is truncated');
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(headerAt, headerAt + headerLen))) as {
    vmLayout: number; placeholder: string; sha256: string; version: string;
    files: { rel: string; offset: number; length: number }[];
  };
  if (!header || !Array.isArray(header.files) || typeof header.placeholder !== 'string') throw new Error('Claude Code layout pack header is not a layout');
  const blobAt = headerAt + headerLen;
  const files: PackedFile[] = [];
  for (const f of header.files) {
    if (typeof f?.rel !== 'string' || f.rel.startsWith('/') || f.rel.split('/').includes('..')) throw new Error('Claude Code layout pack has a bad path');
    if (!Number.isInteger(f.offset) || !Number.isInteger(f.length) || f.offset < 0 || f.length < 0 || blobAt + f.offset + f.length > bytes.length) {
      throw new Error('Claude Code layout pack is truncated');
    }
    files.push({ rel: f.rel, bytes: bytes.subarray(blobAt + f.offset, blobAt + f.offset + f.length) });
  }
  return { vmLayout: header.vmLayout, placeholder: header.placeholder, sha256: header.sha256, version: header.version, files };
}

/**
 * Files to write into `dir`. `modules.js` is substituted one module at a time and
 * `modules.json` is rebuilt: a whole-file replace would move every later module,
 * and the index offsets would land in the middle of the code.
 */
export function materializeLayout(files: PackedFile[], placeholder: string, dir: string): PackedFile[] {
  const modules = files.find((f) => f.rel === 'modules.js');
  const indexFile = files.find((f) => f.rel === 'modules.json');
  let modulesOut: Uint8Array | null = null;
  let indexOut: Uint8Array | null = null;
  if (modules && indexFile) {
    const index = JSON.parse(new TextDecoder().decode(indexFile.bytes)) as Record<string, [number, number]>;
    const pieces: Uint8Array[] = [];
    const rebuilt: Record<string, [number, number]> = {};
    let at = 0;
    for (const [key, [off, len]] of Object.entries(index)) {
      const slice = substituteDir(modules.bytes.subarray(off, off + len), placeholder, dir);
      pieces.push(slice);
      rebuilt[key.split(placeholder).join(dir)] = [at, slice.length];
      at += slice.length;
    }
    modulesOut = new Uint8Array(at);
    let w = 0;
    for (const p of pieces) { modulesOut.set(p, w); w += p.length; }
    indexOut = new TextEncoder().encode(JSON.stringify(rebuilt));
  }
  return files.map((f) => {
    if (f.rel === 'modules.js' && modulesOut) return { rel: f.rel, bytes: modulesOut };
    if (f.rel === 'modules.json' && indexOut) return { rel: f.rel, bytes: indexOut };
    return { rel: f.rel, bytes: substituteDir(f.bytes, placeholder, dir) };
  });
}

/** `placeholder` in `bytes` becomes `dir`. No match returns the same array. */
export function substituteDir(bytes: Uint8Array, placeholder: string, dir: string): Uint8Array {
  if (!placeholder || placeholder === dir) return bytes;
  const from = new TextEncoder().encode(placeholder);
  const to = new TextEncoder().encode(dir);
  const hits: number[] = [];
  for (let i = 0; i + from.length <= bytes.length; i++) {
    let ok = true;
    for (let j = 0; j < from.length; j++) if (bytes[i + j] !== from[j]) { ok = false; break; }
    if (!ok) continue;
    hits.push(i);
    i += from.length - 1;
  }
  if (!hits.length) return bytes;
  const out = new Uint8Array(bytes.length + hits.length * (to.length - from.length));
  let read = 0;
  let write = 0;
  for (const hit of hits) {
    out.set(bytes.subarray(read, hit), write);
    write += hit - read;
    out.set(to, write);
    write += to.length;
    read = hit + from.length;
  }
  out.set(bytes.subarray(read), write);
  return out;
}
