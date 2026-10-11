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

export interface BunEnv extends SpawnEnv {
  /** Bun.version, Bun.main */
  version?: string;
  main?: string;
}

export function createBun(env: BunEnv): Record<string, unknown> {
  const toBuffer = (b: Uint8Array) => (env.Buffer ? env.Buffer.from(b.buffer, b.byteOffset, b.byteLength) : b);
  const hash: any = (data: unknown) => crc32(data); // (Bun's default is wyhash; nothing here calls it bare)
  hash.crc32 = crc32;
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
    gc() {},
    unsafe: { setJITPolicy() {} },
    generateHeapSnapshot: () => ({}),
    env: env.process.env,
  };
}
