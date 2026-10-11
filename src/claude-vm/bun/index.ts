/**
 * The `Bun` object `claude --vm` gives Claude Code's bundle: the APIs it uses
 * (docs/CLAUDE_VM.md has the list and what each is for), on tabcomputer's
 * node. Not all of Bun: what isn't here is undefined, as the bundle's
 * `typeof`/`?.` checks expect, or throws saying so.
 *
 * Loaded through the `tabcomputer:claude-vm` builtin (node-compat), one
 * object per process (process-global.ts keeps `Bun` process-local).
 */
import { zstdDecodeAll } from '../../commands/compress/zstd-codec';
import { stringWidth, stripANSI, sliceAnsi, wrapAnsi } from './text';
import { CellSegmenter } from './cell-segmenter';

/** The Bun version Claude Code 2.1.296 was built with is 1.3.x */
export const BUN_VERSION = '1.3.0';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const bytesOf = (d: unknown): Uint8Array => typeof d === 'string' ? new TextEncoder().encode(d)
  : d instanceof Uint8Array ? d : ArrayBuffer.isView(d) ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
  : d instanceof ArrayBuffer ? new Uint8Array(d) : new TextEncoder().encode(String(d));

export function crc32(data: unknown, seed = 0): number {
  const b = bytesOf(data);
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ── semver (what Claude Code asks: order, satisfies) ──
type SV = { n: number[]; pre: (string | number)[] };
function parseSv(v: string): SV | null {
  const m = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(v));
  if (!m) return null;
  return { n: [+m[1], +(m[2] ?? 0), +(m[3] ?? 0)], pre: m[4] ? m[4].split('.').map((p) => /^\d+$/.test(p) ? +p : p) : [] };
}
export function semverOrder(a: string, b: string): -1 | 0 | 1 {
  const x = parseSv(a), y = parseSv(b);
  if (!x || !y) throw new TypeError(`Invalid SemVer: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    if (typeof p === 'number' && typeof q === 'number') return p < q ? -1 : 1;
    if (typeof p === 'number') return -1;
    if (typeof q === 'number') return 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
function satisfiesOne(v: string, c: string): boolean {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*v?([\dx*]+(?:\.[\dx*]+){0,2}(?:-[0-9A-Za-z.-]+)?)$/.exec(c.trim());
  if (!m) return false;
  const [, op = '', ver] = m;
  const parts = ver.split('-')[0].split('.');
  const wild = parts.findIndex((p) => p === 'x' || p === '*');
  if (wild === 0 || ver === '*') return true;
  const fixed = (wild < 0 ? parts : parts.slice(0, wild)).map(Number);
  const base = [...fixed, 0, 0, 0].slice(0, 3).join('.') + (ver.includes('-') && wild < 0 ? '-' + ver.split('-').slice(1).join('-') : '');
  const cmp = semverOrder(v, base);
  const upper = (i: number) => { const u = [...fixed, 0, 0, 0].slice(0, 3); u[i]++; for (let k = i + 1; k < 3; k++) u[k] = 0; return u.join('.') + '-0'; };
  if (wild > 0) return cmp >= 0 && semverOrder(v, upper(wild - 1)) < 0;
  switch (op) {
    case '^': { const i = fixed[0] ? 0 : fixed[1] ? 1 : 2; return cmp >= 0 && semverOrder(v, upper(i)) < 0; }
    case '~': return cmp >= 0 && semverOrder(v, upper(fixed.length > 1 ? 1 : 0)) < 0;
    case '>=': return cmp >= 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '<': return cmp < 0;
    default: return cmp === 0;
  }
}
export function semverSatisfies(v: string, range: string): boolean {
  if (!parseSv(v)) return false;
  return String(range).split('||').some((alt) => {
    const hy = /^\s*(\S+)\s+-\s+(\S+)\s*$/.exec(alt);
    if (hy) return satisfiesOne(v, '>=' + hy[1]) && satisfiesOne(v, '<=' + hy[2]);
    const parts = alt.trim().split(/\s+/).filter(Boolean);
    return parts.length === 0 || parts.every((c) => satisfiesOne(v, c));
  });
}

export function deepEquals(a: unknown, b: unknown, strict = false, seen = new Map<object, object>()): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return !strict && a == b && typeof a === typeof b;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return String(a) === String(b);
  if (ArrayBuffer.isView(a)) { const x = bytesOf(a), y = bytesOf(b); return x.length === y.length && x.every((v, i) => v === y[i]); }
  if (a instanceof Map) return a.size === (b as Map<unknown, unknown>).size && [...a].every(([k, v]) => (b as Map<unknown, unknown>).has(k) && deepEquals(v, (b as Map<unknown, unknown>).get(k), strict, seen));
  if (a instanceof Set) return a.size === (b as Set<unknown>).size && [...a].every((v) => (b as Set<unknown>).has(v));
  const ka = Object.keys(a).filter((k) => !strict || (a as any)[k] !== undefined || true);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEquals((a as any)[k], (b as any)[k], strict, seen));
}

/** The process's own node objects (the launcher passes them: page code has no Buffer or require) */
export interface BunHost {
  process: any; require: (id: string) => any; Buffer: any;
  /** Embedded assets by path: Bun's loader number (bun-graph.ts BunLoader) */
  assets?: Record<string, number>;
  /** The extracted bundle's directory */
  root?: string;
}

export function createBun({ process: proc, require: req, Buffer, assets = {} }: BunHost): any {
  const env = proc?.env ?? {};
  const fs = (() => { try { return req('fs'); } catch { return null; } })();
  const which = (cmd: string, opts?: { PATH?: string; cwd?: string }): string | null => {
    if (!cmd) return null;
    const isFile = (p: string) => { try { return !!fs?.statSync(p)?.isFile(); } catch { return false; } };
    if (cmd.includes('/')) return isFile(cmd) ? cmd : null;
    for (const d of String(opts?.PATH ?? env.PATH ?? '/usr/local/bin:/usr/bin:/bin').split(':')) {
      if (d && isFile(`${d}/${cmd}`)) return `${d}/${cmd}`;
    }
    return null;
  };
  const notHere = (what: string) => () => { throw new Error(`Bun.${what} is not available in claude --vm yet`); };
  /** A module's require as Bun's: an embedded text asset is its text, a file asset its path, an addon can't load */
  const requires = new WeakMap<object, (id: string) => any>();
  const bunRequire = (r: any) => {
    let f = requires.get(r);
    if (!f) {
      f = Object.assign((id: string) => {
        const loader = assets[id];
        if (loader === 13) return fs.readFileSync(id, 'utf8');
        if (loader === 5) return id;
        if (loader === 10) throw Object.assign(new Error(`Cannot load native addon ${id} in claude --vm`), { code: 'ERR_DLOPEN_FAILED' });
        return r(id);
      }, { resolve: r.resolve, cache: r.cache, main: r.main });
      requires.set(r, f);
    }
    return f;
  };
  return {
    version: BUN_VERSION,
    revision: '',
    main: proc?.argv?.[1] ?? '',
    isStandaloneExecutable: true,
    env,
    argv: proc?.argv ?? [],
    hash: Object.assign((d: unknown) => crc32(d), { crc32 }),
    semver: { order: semverOrder, satisfies: semverSatisfies },
    deepEquals,
    stringWidth, stripANSI, sliceAnsi, wrapAnsi,
    zstdDecompressSync: (d: unknown) => Buffer.from(zstdDecodeAll(bytesOf(d))),
    zstdDecompress: async (d: unknown) => Buffer.from(zstdDecodeAll(bytesOf(d))),
    which,
    sleepSync: (ms: number) => { const end = performance.now() + Number(ms); while (performance.now() < end) { /* busy: it is only ever a few ms */ } },
    sleep: (ms: number) => new Promise((r) => setTimeout(r, Number(ms))),
    stdin: { stream: () => proc.stdin?.constructor?.toWeb ? proc.stdin.constructor.toWeb(proc.stdin) : streamOf(proc.stdin) },
    gc() {},
    generateHeapSnapshot: notHere('generateHeapSnapshot'),
    unsafe: { setJITPolicy() {} },
    spawn: notHere('spawn'),
    serve: notHere('serve'),
    listen: notHere('listen'),
    connect: notHere('connect'),
    file: notHere('file'),
    ant: { CellSegmenter, memoryPressureLevel: () => 0, setDumpable() {} },
    /** (not Bun's: what the extracted bundle's `import.meta.require` became, extract.ts) */
    __require: bunRequire,
    YAML: undefined, TOML: undefined,
  };
}

/** A node Readable as a web ReadableStream */
function streamOf(r: any): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      if (!r) { c.close(); return; }
      r.on('data', (d: any) => c.enqueue(bytesOf(d)));
      r.on('end', () => c.close());
      r.on('error', (e: any) => c.error(e));
    },
  });
}
