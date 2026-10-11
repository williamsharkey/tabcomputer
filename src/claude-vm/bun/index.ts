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
import { spawn, BunFile, stdinOf, terminalOf, type SpawnEnv, type SpawnOptions } from './spawn';
import { CellSegmenter } from './cell-segmenter';
import { serve } from './serve';
import { listen, connect } from './sockets';
import { ensureSelfExec } from './self-exec';
import { imageClass } from './image';
import { transpilerClass, type SyncTransform } from './transpiler';

export interface BunEnv extends SpawnEnv {
  /** Bun.version, Bun.main */
  version?: string;
  main?: string;
  /** The process's net and http, for Bun.listen/connect and Bun.serve */
  net?: any;
  http?: any;
  /** TypeScript/JSX compiled synchronously by the page (node as a kernel guest), for Bun.Transpiler */
  transform?: SyncTransform;
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
  // Claude Code runs itself again through process.execPath: this launcher, not node (self-exec.ts)
  const self = env.main ? ensureSelfExec(env.fs, env.main) : null;
  if (self) { try { env.process.execPath = self; } catch { /* read-only: left as node's */ } }
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
    Terminal: terminalOf(env),
    file: (target: string | number | URL, o?: { type?: string }) => new BunFile(env, target, o?.type),
    get stdin() { return stdinOf(env); },
    serve: (opts: any) => serve(env, opts),
    listen: (opts: any) => listen(env, opts),
    connect: (opts: any) => connect(env, opts),
    gc() {},
    unsafe: { setJITPolicy() {} },
    generateHeapSnapshot: () => ({}),
    env: env.process.env,
    Image: imageClass(toBuffer),
    Transpiler: transpilerClass(env.transform),
    // `claude gateway`'s Postgres: not here (Bun's own client, wire protocol and all); a clear refusal
    SQL: class SQL {
      constructor() {
        throw Object.assign(new Error('claude gateway needs a Postgres client (Bun.SQL), which claude --vm does not have; run it with claude --x86 gateway'), { code: 'ERR_POSTGRES_UNAVAILABLE' });
      }
    },
    // Left out, so Claude Code takes its own path: JSONL.parseChunk (it splits lines itself),
    // FetchSession (mTLS through agents), WebView (`'WebView' in Bun`), and ant.getPeerPid/
    // getPeerUid (sockets here have no fd to ask; without getPeerPid it doesn't offer
    // replies across socket directories, which need the peer's pid)
    // Anthropic's Bun build: the renderer's cell segmenter; memory pressure (read on macOS
    // only: 'normal'), and prctl(PR_SET_DUMPABLE, 0), which succeeds (nothing here dumps core)
    ant: { CellSegmenter, memoryPressureLevel: () => 'normal', setDumpable: () => true },
    __require: bunRequire(env),
  };
}
