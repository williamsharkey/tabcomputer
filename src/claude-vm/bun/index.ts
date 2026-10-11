/**
 * The `Bun` object for `claude --vm`: Claude Code's bundle, extracted from the
 * native build, run on tabcomputer's Node runtime (docs/CLAUDE_VM.md). Made per
 * process from that process's fs, process and child_process, and given to the
 * bundle's module scope only, never as a page global (npm packages test `typeof Bun`).
 */
import { stringWidth, stripANSI, sliceAnsi, wrapAnsi } from './text';
import { crc32 } from './hash';
import { order, satisfies } from './semver';
import { deepEquals } from './deep-equals';
import { YAML, TOML } from './formats';
import { zstdDecompressSync, zstdDecompress } from './zstd';
import { which } from './which';
import { sleepSync } from './sleep';
import { spawn, BunFile, stdinOf, type SpawnEnv, type SpawnOptions } from './spawn';
import { CellSegmenter } from './cell-segmenter';
import { serve } from './serve';
import { listen, connect } from './sockets';
import { createImageClass } from './image';

export interface BunEnv extends SpawnEnv {
  /** Bun.version, Bun.main */
  version?: string;
  main?: string;
  /** The process's net and http, for Bun.listen/connect and Bun.serve */
  net?: any;
  http?: any;
  /** The extracted bundle's embedded assets by path: Bun's loader number (bun-graph.ts BunLoader) */
  assets?: Record<string, number>;
}

/**
 * What the extracted bundle's `import.meta.require` became (extract.ts): a
 * module's require as Bun's, where an embedded text asset is its text, a file
 * asset its path, and a native addon can't load.
 */
function bunRequire(env: BunEnv) {
  const made = new WeakMap<object, (id: string) => unknown>();
  return (r: any) => {
    let f = made.get(r);
    if (!f) {
      f = Object.assign((id: string) => {
        const loader = env.assets?.[id];
        if (loader === 13) return env.fs.readFileSync(id, 'utf8');
        if (loader === 5) return id;
        if (loader === 10) throw Object.assign(new Error(`Cannot load native addon ${id} in claude --vm`), { code: 'ERR_DLOPEN_FAILED' });
        return r(id);
      }, { resolve: r.resolve, cache: r.cache, main: r.main });
      made.set(r, f);
    }
    return f;
  };
}

export function createBun(env: BunEnv): Record<string, unknown> {
  const toBuffer = (b: Uint8Array) => (env.Buffer ? env.Buffer.from(b.buffer, b.byteOffset, b.byteLength) : b);
  const hash: any = (data: unknown) => crc32(data); // (Bun's default is wyhash; nothing here calls it bare)
  hash.crc32 = crc32;
  let Image: unknown;
  return {
    version: env.version ?? '1.3.0',
    main: env.main ?? '',
    isStandaloneExecutable: true,
    stringWidth, stripANSI, sliceAnsi, wrapAnsi,
    hash,
    semver: { order, satisfies },
    deepEquals,
    YAML, TOML,
    zstdDecompressSync: (data: unknown) => zstdDecompressSync(data, toBuffer),
    zstdDecompress: (data: unknown) => zstdDecompress(data, toBuffer),
    which: (cmd: string, opts?: { PATH?: string; cwd?: string }) => which(env.fs, cmd, opts, { PATH: env.process.env?.PATH, cwd: env.process.cwd() }),
    sleepSync,
    sleep: (ms: number | Date) => new Promise((r) => setTimeout(r, ms instanceof Date ? ms.getTime() - Date.now() : ms)),
    spawn: (cmd: string[] | SpawnOptions, opts?: SpawnOptions) => spawn(env, cmd, opts),
    file: (target: string | number | URL, o?: { type?: string }) => new BunFile(env, target, o?.type),
    get stdin() { return stdinOf(env); },
    serve: (opts: any) => serve(env, opts),
    listen: (opts: any) => listen(env, opts),
    connect: (opts: any) => connect(env, opts),
    get Image() { return Image ??= createImageClass(toBuffer); },
    gc() {},
    unsafe: { setJITPolicy() {} },
    generateHeapSnapshot: () => ({}),
    env: env.process.env,
    // Anthropic's Bun build: the renderer's cell segmenter; the rest are optional there
    ant: { CellSegmenter, memoryPressureLevel: () => 0, setDumpable() {} },
    __require: bunRequire(env),
  };
}
