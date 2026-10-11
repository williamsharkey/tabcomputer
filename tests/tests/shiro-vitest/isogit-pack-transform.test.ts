/**
 * vite-plugin-isogit.ts: isomorphic-git's pack indexing as the build ships it.
 * The transform is applied to isomorphic-git's CJS build and the result loaded
 * in node: fromPack indexes a real git pack (with deltas) to the same .idx git
 * writes, and with the worker hook (globalThis.__shiroPackIndexer) set it
 * builds the index from the .idx the hook returns, or indexes itself when the
 * hook fails.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { isogitPackOffMainThread } from '../../../vite-plugin-isogit';

const require = createRequire(import.meta.url);
const Module = require('module');

const root = path.resolve(__dirname, '../../..');
const entry = path.join(root, 'node_modules/isomorphic-git/index.cjs');

function transformed(): string {
  const plugin = isogitPackOffMainThread() as { transform: (this: unknown, code: string, id: string) => { code: string } };
  const ctx = { error: (msg: string) => { throw new Error(msg); } };
  return plugin.transform.call(ctx, readFileSync(entry, 'utf8'), entry).code;
}

/** The transformed module, loaded as if it were node_modules/isomorphic-git/index.cjs */
function load(code: string): any {
  const m = new Module(entry, null);
  m.filename = entry;
  m.paths = Module._nodeModulePaths(path.dirname(entry));
  m._compile(code, entry);
  return m.exports;
}

let GitPackIndex: any;
let pack: Buffer;
let gitIdx: Buffer;
let dir: string;

beforeAll(() => {
  GitPackIndex = load(transformed()).__shiroGitPackIndex;
  dir = mkdtempSync(path.join(os.tmpdir(), 'isogit-pack-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 't');
  // a big file (inflated natively when its end is known) changed a little each commit: deltas
  let big = '';
  for (let i = 0; i < 20000; i++) big += `line ${i} ${(i * 2654435761) % 1000003}\n`;
  for (let c = 0; c < 4; c++) {
    writeFileSync(path.join(dir, 'big.txt'), big + `commit ${c}\n`);
    writeFileSync(path.join(dir, `small${c}.txt`), `small ${c}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', `c${c}`);
  }
  git('repack', '-adq');
  const packDir = path.join(dir, '.git/objects/pack');
  const name = readdirSync(packDir).find((f) => f.endsWith('.pack'))!;
  pack = readFileSync(path.join(packDir, name));
  gitIdx = readFileSync(path.join(packDir, name.replace(/\.pack$/, '.idx')));
  return () => rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
  delete (globalThis as any).__shiroPackIndexer;
});

const noExternal = async () => { throw new Error('no external bases'); };

async function objects(p: any): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const oid of p.hashes) {
    const { type, object } = await p.read({ oid });
    out.set(oid, `${type}:${Buffer.from(object).toString('base64')}`);
  }
  return out;
}

describe('isomorphic-git pack indexing (vite-plugin-isogit)', () => {
  it('applies to the ESM build too', () => {
    const esm = path.join(root, 'node_modules/isomorphic-git/index.js');
    const plugin = isogitPackOffMainThread() as any;
    const out = plugin.transform.call({ error: (m: string) => { throw new Error(m); } }, readFileSync(esm, 'utf8'), esm);
    expect(out.code).toContain('export { GitPackIndex as __shiroGitPackIndex }');
    expect(out.code).toContain('__shiroPackIndexer');
  });

  it('fromPack on the page writes the .idx git writes', async () => {
    const p = await GitPackIndex.fromPack({ pack, getExternalRefDelta: noExternal });
    expect(p.hashes.length).toBe(16); // 4 commits, 4 trees, 8 blobs
    expect(Buffer.from(await p.toBuffer()).equals(gitIdx)).toBe(true);
  });

  it('builds the index from the .idx the worker hook returns', async () => {
    const inPage = await GitPackIndex.fromPack({ pack, getExternalRefDelta: noExternal });
    const calls: Uint8Array[] = [];
    (globalThis as any).__shiroPackIndexer = async (bytes: Uint8Array) => { calls.push(bytes); return new Uint8Array(gitIdx); };
    const p = await GitPackIndex.fromPack({ pack, getExternalRefDelta: noExternal });
    expect(calls.length).toBe(1);
    expect(calls[0].byteLength).toBe(pack.byteLength);
    expect(Buffer.from(await p.toBuffer()).equals(gitIdx)).toBe(true);
    expect(await objects(p)).toEqual(await objects(inPage));
  });

  it('indexes on the page when the hook returns null or throws', async () => {
    for (const hook of [async () => null, async () => { throw new Error('worker died'); }]) {
      (globalThis as any).__shiroPackIndexer = hook;
      const p = await GitPackIndex.fromPack({ pack, getExternalRefDelta: noExternal });
      expect(Buffer.from(await p.toBuffer()).equals(gitIdx)).toBe(true);
    }
  });
});
