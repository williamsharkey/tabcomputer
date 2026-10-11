/**
 * src/claude-vm/extract.ts: native Claude Code's ES modules made runnable on
 * tabcomputer's node (docs/CLAUDE_VM.md): Bun's paths and import.meta, and
 * CommonJS with live imports (Bun's chunks assign exports in lazy
 * initializers and import each other in cycles).
 */
import { describe, it, expect, vi } from 'vitest';
import { transform } from 'esbuild';
import { adaptModule, toCommonJS, launcherSource, bundleHeader, bundleEntry, ensureClaudeVm } from '@shiro/claude-vm/extract';
import { BunLoader } from '@shiro/claude-vm/bun-graph';
import { fakeBunElf } from './fake-bun-elf.mjs';
import { MODULE_PARAMS, moduleSource, bundleUrl } from '@shiro/claude-vm/code-cache';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PRETRANSFORMED } from '@shiro/node-compat/require';
import { createTestShell, run } from './helpers';

// (native esbuild for extraction's own: esbuild-wasm wants the page's asset URL)
vi.mock('@shiro/commands/build', () => ({ withEsbuild: async (f: (e: unknown) => unknown) => f(esbuild) }));

const esbuild = { transform: (code: string, opts: object) => transform(code, opts as any) };

describe('claude --vm: the extracted modules', () => {
  it("rewrites Bun's paths, import.meta and require; reads Bun from the process", () => {
    const src = '// @bun @bytecode\nimport{a}from"/$bunfs/root/chunk-a.js";var r=import.meta.require,d=import.meta.dir,e=import.meta.dirname,u=import.meta.url;';
    const out = adaptModule(src, '/home/u/.cache/vm');
    expect(out.startsWith('var Bun = globalThis.Bun;\n// @bun @bytecode\n')).toBe(true);
    expect(out).toContain('from"/home/u/.cache/vm/chunk-a.js"');
    expect(out).toContain('r=Bun.__require(require)');
    expect(out).toContain('d=__dirname,e=__dirname');
    expect(out).toContain('u=require("url").pathToFileURL(__filename).href');
    expect(out).not.toContain('$bunfs');
    expect(out).not.toContain('import.meta');
  });

  it('as CommonJS, an import reads the exporter\'s current value (a lazy initializer, a cycle)', async () => {
    // b's export is assigned by an initializer a calls after importing it
    const a = await toCommonJS(esbuild, 'import{v,init}from"./b.js";init();export const seen=v;');
    const b = await toCommonJS(esbuild, 'export var v;export function init(){v=42}');
    const mods: Record<string, any> = {};
    const load = (name: string, code: string) => {
      const module = { exports: {} as any };
      mods[name] = module;
      new Function('module', 'exports', 'require', code)(module, module.exports, (p: string) => mods[p.replace('./', '')].exports);
      return module.exports;
    };
    load('b.js', b);
    expect(load('a.js', a).seen).toBe(42);
    expect(a.startsWith('"use strict";')).toBe(true);
  });

  it('the launcher sets the process\'s Bun before Claude Code\'s entry runs', () => {
    const l = launcherSource();
    expect(l.indexOf('globalThis.Bun = createBun(')).toBeLessThan(l.indexOf("require('./bundle.js')"));
    // (spelled out: node-compat's transform drops a shorthand `Buffer` property)
    expect(l).toContain('Buffer: Buffer');
  });

  it('a module transformed ahead (PRETRANSFORMED) loads as it is; others get node-compat\'s transforms', async () => {
    // (an await in a module that names AsyncLocalStorage is rewritten to carry its stores)
    const body = 'const { AsyncLocalStorage } = require("async_hooks"); async function f() { await 1 } module.exports = String(f);';
    const { fs, shell } = await createTestShell();
    await fs.mkdir('/tmp/pre', { recursive: true });
    await fs.writeFile('/tmp/pre/ahead.js', PRETRANSFORMED + body);
    await fs.writeFile('/tmp/pre/plain.js', body);
    const r = await run(shell, `node -e "console.log(JSON.stringify([require('/tmp/pre/ahead.js'), require('/tmp/pre/plain.js')]))"`);
    const [ahead, plain] = JSON.parse(r.output.trim().split('\n').pop()!);
    expect(ahead).toBe('async function f() { await 1 }');
    expect(plain).toContain('__shiroAls');
  });

  it('bundle.js: modules from one table, cycles as CommonJS, import() as exports, the rest from the process', async () => {
    const dir = '/vm';
    const src = bundleHeader(dir)
      + bundleEntry('/vm/a.js', 'const b = require("/vm/b.js"); exports.a = 1; exports.fromB = () => b.b; exports.os = require("os").name;')
      + bundleEntry('/vm/b.js', 'const a = require("/vm/a.js"); exports.b = 2; exports.seenA = () => a.a;')
      + bundleEntry('/vm/c.js', 'module.exports = __dynamic_import("./b.js").then((ns) => ns.b);')
      + 'module.exports = [__vmRequire("/vm")("/vm/a.js"), __vmRequire("/vm")("/vm/b.js"), __vmRequire("/vm")("/vm/c.js")];';
    const module = { exports: {} as any };
    const outer = Object.assign((id: string) => { if (id === 'os') return { name: 'fake-os' }; if (id === 'path') return require('path'); throw new Error('no ' + id); }, { resolve: (id: string) => id });
    new Function('module', 'exports', 'require', src)(module, module.exports, outer);
    const [a, b, c] = module.exports;
    expect([a.a, a.fromB(), b.seenA(), a.os]).toEqual([1, 2, 1, 'fake-os']);
    expect(await c).toBe(2);
  });

  it('a first launch says what each stage is doing; the next one says nothing', async () => {
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
    for (const re of [/reading the native build/, /extracting/, /2 modules, 1 assets/, /extracted \(\d+\.\d s\)/, /preparing/, /ready \(\d+\.\d s\)/]) expect(said).toMatch(re);
    lines.length = 0;
    const again = await ensureClaudeVm(fs as any, '/home/t/.local/bin/claude', '/home/t', (s) => lines.push(s));
    expect([again.extracted, again.dir, lines]).toEqual([false, first.dir, []]);
  });

  it("the code-cache module takes node-compat's module parameters, in require.ts's order", () => {
    const req = readFileSync(resolve(__dirname, '../../../src/node-compat/require.ts'), 'utf8');
    const inline = req.slice(req.indexOf('const fnParams = ['), req.indexOf('...(deps.scriptTimers'));
    const names = [...inline.matchAll(/'([\w$]+)'/g)].map((m) => m[1]);
    expect(MODULE_PARAMS.slice(0, names.length)).toEqual(names);
    expect(MODULE_PARAMS.slice(names.length)).toEqual(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'self', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope']);
    const fn = new Function(moduleSource('return [module.id, this.x, typeof require];').replace('export default function', 'return function'))();
    expect(fn.length).toBe(MODULE_PARAMS.length);
    expect(fn.call({ x: 1 }, { id: 'm' }, {}, () => 0)).toEqual(['m', 1, 'function']);
    expect(bundleUrl('/home/u/.cache/tabcomputer/claude-vm/abc/nc-123')).toBe('/__vm/abc/nc-123/bundle.mjs');
  });

  const runLauncher = async (compiled: ((...a: unknown[]) => unknown) | null, load = async () => compiled) => {
    const required: string[] = [];
    const require = (id: string): any => {
      required.push(id);
      if (id === 'tabcomputer:claude-vm') return { load: async () => ({ createBun: () => ({}) }), codeCache: async () => ({ loadCompiled: load }) };
      if (id === 'fs') return { readFileSync: () => '{}' };
      return {};
    };
    const globals = { console: { tag: 'console' }, process: { env: {}, tag: 'process' }, global: { tag: 'global' }, Buffer: { tag: 'Buffer' } };
    const AsyncFn = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFn('require', '__dirname', 'console', 'process', 'global', 'Buffer', '__dynamic_import', 'self', launcherSource())(
      require, '/vm', globals.console, globals.process, globals.global, Object.assign({}, globals.Buffer), 'dyn', undefined);
    return required;
  };

  it('the launcher runs the compiled bundle with the bundle\'s own module and the process\'s globals', async () => {
    let args: unknown[] = [];
    const required = await runLauncher(function (this: unknown, ...a: unknown[]) { args = a; });
    const at = (n: string) => args[MODULE_PARAMS.indexOf(n as any)];
    expect(args.length).toBe(MODULE_PARAMS.length);
    expect((at('module') as any).id).toBe('/vm/bundle.js');
    expect(at('__shiro_module')).toBe(at('module'));
    expect([at('__filename'), at('__dirname'), (at('console') as any).tag, (at('process') as any).tag, at('__dynamic_import'), at('self')]).toEqual(['/vm/bundle.js', '/vm', 'console', 'process', 'dyn', undefined]);
    expect((at('__import_meta') as any).url).toBe('file:///vm/bundle.js');
    expect(required).not.toContain('./bundle.js');
  });

  it('without the service worker, or when the import fails, the launcher requires bundle.js as before', async () => {
    expect(await runLauncher(null)).toContain('./bundle.js');
    expect(await runLauncher(null, async () => { throw new TypeError('Failed to fetch dynamically imported module'); })).toContain('./bundle.js');
  });
});
