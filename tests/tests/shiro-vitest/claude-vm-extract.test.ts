/**
 * src/claude-vm/extract.ts and module-store.ts: native Claude Code's ES modules
 * made runnable on tabcomputer's node (docs/CLAUDE_VM.md): Bun's paths and
 * import.meta, live imports (Bun's chunks assign exports in lazy initializers
 * and import each other in cycles), and a loader that compiles a module when
 * it is first required.
 */
import { describe, it, expect } from 'vitest';
import { adaptModule, launcherSource, ensureClaudeVm, vmModuleTransform } from '@shiro/claude-vm/extract';
import { createModuleLoader, loadModules, putModules, storeKey, MODULE_CACHE, type ModuleIndex } from '@shiro/claude-vm/module-store';
import { BunLoader } from '@shiro/claude-vm/bun-graph';
import { fakeBunElf } from './fake-bun-elf.mjs';
import { liveExports } from '@shiro/node-compat/require';
import { createTestShell } from './helpers';

/** Modules (Bun's names, ES module source) laid out as extract.ts does, and a loader over them */
async function layout(mods: Record<string, string>, dir = '/vm', outer: (id: string) => any = (id) => { throw new Error('no ' + id); }) {
  const toRun = await vmModuleTransform();
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const index: ModuleIndex = {};
  let size = 0;
  for (const [name, src] of Object.entries(mods)) {
    const b = enc.encode(toRun(src, dir));
    index[`${dir}/${name}`] = [size, b.length];
    parts.push(b);
    size += b.length;
  }
  const bytes = new Uint8Array(size);
  parts.reduce((at, p) => (bytes.set(p, at), at + p.length), 0);
  const loader = createModuleLoader({
    dir, bytes, index, outer, live: liveExports, settle: () => {},
    globals: { console, process, global: globalThis, Buffer, globalThis, Function, setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate, self: undefined },
  });
  // (Bun's import.meta.require: the shim's bunRequire hands a namespace-aware require on)
  (globalThis as any).Bun = { __require: (r: any) => (id: string) => r.namespace(id) };
  return { loader, req: loader.require(dir), code: (name: string) => new TextDecoder().decode(bytes.subarray(...(([a, l]) => [a, a + l])(index[`${dir}/${name}`]))) };
}

describe('claude --vm: the extracted modules', () => {
  it("rewrites Bun's paths and import.meta; an import's specifier keeps Bun's root; reads Bun from the process", () => {
    const src = '// @bun @bytecode\nimport{a}from"/$bunfs/root/chunk-a.js";var p="/$bunfs/root/SKILL.md",x=import("/$bunfs/root/chunk-b.js"),r=import.meta.require,d=import.meta.dir,e=import.meta.dirname,u=import.meta.url;';
    const out = adaptModule(src, '/home/u/.cache/vm');
    expect(out.startsWith('var Bun = globalThis.Bun;\n// @bun @bytecode\n')).toBe(true);
    expect(out).toContain('from"/$bunfs/root/chunk-a.js"');
    expect(out).toContain('import("/$bunfs/root/chunk-b.js")');
    expect(out).toContain('p="/home/u/.cache/vm/SKILL.md"');
    expect(out).toContain('r=Bun.__require(require)');
    expect(out).toContain('d=__dirname,e=__dirname');
    expect(out).toContain('u=require("url").pathToFileURL(__filename).href');
    expect(out).not.toContain('import.meta');
  });

  it('an import reads the exporter\'s current value: a lazy initializer, a cycle', async () => {
    const { req } = await layout({
      'cli.js': 'import{v,init,getA}from"/$bunfs/root/b.js";init();export const seen=v;export const back=getA();',
      'b.js': 'import{a}from"/$bunfs/root/cli.js";export var v;export function init(){v=42}export function getA(){return a}',
      // (a is the entry's, which b imports while the entry is still loading)
    });
    const cli = req('./cli.js');
    expect([cli.seen, cli.back]).toEqual([42, undefined]);
    expect(req('./b.js').getA()).toBe(undefined);
  });

  it("Bun's import.meta.require of a chunk is its namespace: `.default` is the default export", async () => {
    const { req } = await layout({
      'cli.js': 'var t=import.meta.require("/$bunfs/root/cmd.js").default,n=import.meta.require("/$bunfs/root/cmd.js").other;export{t,n};',
      'cmd.js': 'var o={name:"workflows"},q=1;export{o as default,q as other};',
    });
    expect([req('./cli.js').t?.name, req('./cli.js').n]).toEqual(['workflows', 1]);
  });

  it('import() of a chunk is its namespace, live', async () => {
    const { req } = await layout({
      'cli.js': 'export const p=import("/$bunfs/root/late.js");',
      'late.js': 'export let n=1;export function bump(){n++}export default {d:1};',
    });
    const ns = await req('./cli.js').p;
    expect([ns.default.d, ns.n]).toEqual([1, 1]);
    ns.bump();
    expect(ns.n).toBe(2);
    // (node-compat's default is the exports object, so its own keys come along: `d`)
    expect(Object.keys(ns)).toEqual(expect.arrayContaining(['bump', 'default', 'n']));
  });

  it('what a minifier makes of names: an arrow parameter shadows an import; labels, `of`, unicode escapes are left alone', async () => {
    const { req, code } = await layout({
      'cli.js': 'import{m,t,of,u}from"/$bunfs/root/lib.js";'
        + 'export const viaArrow=Promise.resolve({default:7}).then((m)=>m.default);'
        + 'export const outer=m;'
        + 'export function loop(){let n=0;t:for(const[a,b]of of){n+=a+b;if(n>2)break t;continue t}return n}'
        + 'export const esc={\\u{430}:"a",u};',
      // (as Bun writes them: declarations, then one export list)
      'lib.js': 'var m="import m",t=0,of=[[1,1],[2,2]],u="U";export{m,t,of,u};',
    });
    const cli = req('./cli.js');
    expect([await cli.viaArrow, cli.outer, cli.loop(), cli.esc['а'], cli.esc.u]).toEqual([7, 'import m', 6, 'a', 'U']);
    // (names left alone here, a parameter and a label, keep the statement's copies too)
    expect(code('cli.js')).toMatch(/let \{m, t, of, u\} = /);
  });

  it('a module is compiled when first required, never before; node\'s builtins come from the process', async () => {
    const { loader, req, code } = await layout({
      'cli.js': 'import{a}from"/$bunfs/root/a.js";import{EOL}from"os";export const x=a+EOL;',
      'a.js': 'export const a="A";',
      'unused.js': 'export const never=1;',
    }, '/vm', (id) => (id === 'os' ? { EOL: '\n' } : (() => { throw new Error('no ' + id); })()));
    expect(req('./cli.js').x).toBe('A\n');
    expect(loader.stats()).toMatchObject({ compiled: 2, modules: 3 });
    // (every reference to `a` reads the live binding: no copy of it is made)
    expect(code('cli.js')).not.toMatch(/let \{a\}/);
    expect(code('cli.js')).toContain('__shiro_live0.a');
  });

  it('modules.js: in CacheStorage for the next launch, one layout at a time; read from the files once if it is not', async () => {
    const store = new Map<string, Uint8Array>();
    const cache = {
      keys: async () => [...store.keys()].map((url) => ({ url })),
      delete: async (r: { url: string }) => store.delete(r.url),
      put: async (url: string, res: Response) => { store.set(url, new Uint8Array(await res.arrayBuffer())); },
      match: async (url: string) => (store.has(url) ? new Response(store.get(url) as BodyInit) : undefined),
    };
    const deps = { caches: { open: async (n: string) => (expect(n).toBe(MODULE_CACHE), cache) } as any, origin: 'https://tc.example' };
    await putModules('/c/aaa/nc-1', new Uint8Array([1]), deps);
    await putModules('/c/bbb/nc-2', new Uint8Array([2, 3]), deps);
    expect([...store.keys()]).toEqual([storeKey('https://tc.example', '/c/bbb/nc-2')]);
    expect(storeKey('https://tc.example/', '/h/.cache/tabcomputer/claude-vm/bbb/nc-2')).toBe('https://tc.example/__claude-vm/bbb/nc-2/modules.js');
    let read = 0;
    expect([...await loadModules('/c/ccc/nc-3', () => (read++, new Uint8Array([9])), deps)]).toEqual([9]);
    await new Promise((r) => setTimeout(r, 0));
    expect([read, [...store.keys()]]).toEqual([1, [storeKey('https://tc.example', '/c/ccc/nc-3')]]);
    // (the same worker's next launch: what it has, not even the cache)
    expect([...await loadModules('/c/ccc/nc-3', () => (read++, new Uint8Array()), { caches: undefined, origin: undefined })]).toEqual([9]);
    expect(read).toBe(1);
  });

  it('the launcher sets the process\'s Bun before Claude Code\'s entry runs, and loads modules through the store', () => {
    const l = launcherSource();
    expect(l.indexOf('globalThis.Bun = createBun(')).toBeLessThan(l.indexOf("loader.require(__dirname)('./cli.js')"));
    expect(l).toContain('store.loadModules(__dirname');
    expect(l).toContain('createModuleLoader({ dir: __dirname');
    // (spelled out: node-compat's transform drops a shorthand `Buffer` property)
    expect(l).toContain('Buffer: Buffer');
    // (it parses: an async module body, as node-compat runs it)
    const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
    expect(() => new AsyncFn('require', '__dirname', 'process', l)).not.toThrow();
  });

  it('a first launch says what it is doing, lays out modules.js and drops an earlier layout\'s; the next one says nothing', async () => {
    const { fs } = await createTestShell();
    const bin = fakeBunElf([
      { name: '/$bunfs/root/chunk-a.js', contents: '// @bun\nexport const a = 1;\n', loader: BunLoader.js },
      { name: '/$bunfs/root/cli', contents: '// @bun\nimport{a}from"/$bunfs/root/chunk-a.js";console.log(a);\n', loader: BunLoader.js },
      { name: '/$bunfs/root/SKILL.md', contents: '# a skill\n', loader: BunLoader.text },
    ], 1);
    await fs.mkdir('/home/t/.local/bin', { recursive: true });
    await fs.writeFile('/home/t/.local/bin/claude', bin);
    const lines: string[] = [];
    const first = await ensureClaudeVm(fs as any, '/home/t/.local/bin/claude', '/home/t', (s) => lines.push(s));
    const said = lines.join('');
    expect(first.extracted).toBe(true);
    for (const re of [/reading the native build/, /preparing/, /ready \(\d+\.\d s\)/]) expect(said).toMatch(re);
    const index = JSON.parse(await fs.readFile(`${first.dir}/modules.json`, 'utf8') as string);
    expect(Object.keys(index).sort()).toEqual([`${first.dir}/chunk-a.js`, `${first.dir}/cli.js`]);
    expect(await fs.readFile(`${first.dir}/SKILL.md`, 'utf8')).toBe('# a skill\n');
    expect(JSON.parse(await fs.readFile(`${first.dir}/bun-assets.json`, 'utf8') as string)).toEqual({ [`${first.dir}/SKILL.md`]: BunLoader.text });
    lines.length = 0;
    const again = await ensureClaudeVm(fs as any, '/home/t/.local/bin/claude', '/home/t', (s) => lines.push(s));
    expect([again.extracted, again.dir, lines]).toEqual([false, first.dir, []]);
  });

  it('the preinstalled build: byte ranges of the site\'s copy, laid out once under the release\'s sha256; then nothing is fetched', async () => {
    const { ensurePreinstalledClaudeVm, preinstallClaudeVmInBackground, PREINSTALL_RECORD } = await import('@shiro/claude-vm/preinstall');
    const { fs } = await createTestShell();
    const bin = fakeBunElf([
      { name: '/$bunfs/root/chunk-a.js', contents: '// @bun\nexport const a = 1;\n', loader: BunLoader.js },
      { name: '/$bunfs/root/cli', contents: '// @bun\nimport{a}from"/$bunfs/root/chunk-a.js";console.log(a);\n', loader: BunLoader.js },
    ], 1);
    const release = { version: '9.9.9', platform: 'linux-x64-musl', sha256: 'ab'.repeat(32), size: bin.length };
    const asked: string[] = [];
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const range = (init?.headers as any)?.Range as string;
      asked.push(`${url} ${range}`);
      const [, s, e] = /bytes=(\d+)-(\d+)/.exec(range)!.map(Number);
      return new Response(bin.slice(s, e + 1), { status: 206, headers: { 'content-range': `bytes ${s}-${e}/${bin.length}` } });
    }) as typeof fetch;
    const lines: string[] = [];
    const opts = { origin: 'https://tc.example/', fetch: fetchFn, release, say: (l: string) => lines.push(l) };
    // an earlier layout's trees, which this one replaces
    const base = `/home/p/.cache/tabcomputer/claude-vm/${release.sha256}`;
    await fs.mkdir(`${base}/cjs`, { recursive: true });
    await fs.mkdir(`${base}/nc-00000000`, { recursive: true });
    // the boot's and a typed `claude`'s at once: one download, one layout
    const [a, b] = await Promise.all([ensurePreinstalledClaudeVm(fs as any, '/home/p', opts), ensurePreinstalledClaudeVm(fs as any, '/home/p', opts)]);
    expect(a.dir).toBe(b.dir);
    expect(a.dir).toContain(`${base}/nc-`);
    expect(a.version).toBe('9.9.9');
    expect(asked.length).toBe(1); // (the whole small file is the first suffix)
    expect(asked[0]).toBe(`https://tc.example/claude-releases/9.9.9/linux-x64-musl/claude bytes=0-${bin.length - 1}`);
    expect(lines.join('')).toMatch(/Downloading Claude Code 9\.9\.9/);
    expect(await fs.readFile(a.launcher, 'utf8')).toContain('claude --vm');
    expect((await fs.readdir(base)).sort()).toEqual([a.dir.slice(base.length + 1)]);
    expect(JSON.parse(await fs.readFile(PREINSTALL_RECORD, 'utf8') as string)).toMatchObject({ version: '9.9.9', sha256: release.sha256 });
    const again = await ensurePreinstalledClaudeVm(fs as any, '/home/p', opts);
    expect([again.extracted, again.dir, asked.length]).toEqual([false, a.dir, 1]);
    // the boot leaves it alone where the user has a binary of their own
    await fs.mkdir('/home/q/.local/bin', { recursive: true });
    await fs.writeFile('/home/q/.local/bin/claude', new Uint8Array(1_100_000));
    expect(await preinstallClaudeVmInBackground(fs as any, '/home/q', '/home/q/.local/bin/claude', opts)).toBe('skipped');
    expect(asked.length).toBe(1);
  });
});
