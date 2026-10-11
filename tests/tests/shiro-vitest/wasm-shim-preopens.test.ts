/**
 * A wasi-libc program started by path (the kernel's WASM loader: a shell
 * running /usr/lib/pkg/python3/bin/python3.wasm, an exec from another
 * program) gets "/usr", "/home", ... preopened by name, because its libc never
 * matches the "/" preopen against "/usr/...". pkg's python3 links Shiro's
 * process and socket shims (scripts/pkgbuild/compat/wasi-proc.c, wasi-sock.c),
 * whose wasix_32v1 imports made it count as WASIX libc: it got only "/" and
 * ".", and failed with "Failed to import encodings" (tabcomputer#70).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { childPreopens, SHIM_WASIX } from '@shiro/wasi/host';
import type { Kernel } from '@shiro/kernel/kernel';

const COMPAT = path.resolve(__dirname, '../../../scripts/pkgbuild/compat');

/** LEB128 */
function uleb(n: number): number[] {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
}
const str = (s: string) => [...uleb(s.length), ...new TextEncoder().encode(s)];
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];

/** A module that only imports these functions (all `() -> ()`) */
function moduleImporting(imports: [string, string][]): WebAssembly.Module {
  const types = section(1, [1, 0x60, 0, 0]);
  const imps = section(2, [...uleb(imports.length), ...imports.flatMap(([m, n]) => [...str(m), ...str(n), 0, 0])]);
  return new WebAssembly.Module(new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0, ...types, ...imps]));
}

/** A root with three directories and a file */
const kernel = {
  fs: {
    readdir: async (p: string) => (p === '/' ? ['usr', 'home', 'tmp', 'notes.txt'] : []),
    stat: async (p: string) => ({ type: p === '/notes.txt' ? 'file' : 'dir' }),
  },
} as unknown as Kernel;
const BY_NAME = ['/usr', '/home', '/tmp'];

const preview1 = (...names: string[]) => names.map((n): [string, string] => ['wasi_snapshot_preview1', n]);
const wasix = (...names: string[]) => names.map((n): [string, string] => ['wasix_32v1', n]);

/** pkg python3 3.13.7-1's wasix_32v1 imports, as its python3.wasm lists them */
const PYTHON3_WASIX = [
  'sock_open', 'sock_connect', 'sock_bind', 'sock_listen', 'sock_accept_v2', 'sock_addr_local', 'sock_addr_peer',
  'sock_send_to', 'sock_recv_from', 'sock_set_opt_flag', 'sock_set_opt_size', 'sock_set_opt_time', 'sock_get_opt_size',
  'sock_get_opt_flag', 'resolve', 'getcwd', 'fd_pipe', 'fd_dup', 'proc_spawn3', 'proc_join', 'proc_signal',
];

describe('preopens for a WASM program started by path (#70)', () => {
  it('a plain wasi-libc program gets the top-level directories by name', async () => {
    expect(await childPreopens(kernel, moduleImporting(preview1('fd_write', 'path_open')))).toEqual(BY_NAME);
  });

  it("pkg python3 (wasi-libc with the process and socket shims) gets them too", async () => {
    const mod = moduleImporting([...preview1('fd_write', 'path_open'), ...wasix(...PYTHON3_WASIX)]);
    expect(await childPreopens(kernel, mod)).toEqual(BY_NAME);
  });

  it("every call the compat shims import counts as a shim's, not as WASIX libc", () => {
    const names = new Set<string>();
    for (const f of readdirSync(COMPAT).filter((f) => f.endsWith('.c'))) {
      for (const m of readFileSync(path.join(COMPAT, f), 'utf8').matchAll(/\bWASIX\((\w+)\)/g)) if (m[1] !== 'name') names.add(m[1]);
    }
    expect(names.size).toBeGreaterThan(0);
    expect([...names].filter((n) => !SHIM_WASIX.has(n))).toEqual([]);
  });

  it('a WASIX-libc program still gets only "/" (its libc matches it)', async () => {
    const mod = moduleImporting([...preview1('fd_write'), ...wasix('proc_fork', 'thread_spawn_v2', 'sock_open')]);
    expect(await childPreopens(kernel, mod)).toEqual([]);
  });
});
