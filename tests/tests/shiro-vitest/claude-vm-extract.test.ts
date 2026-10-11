/**
 * src/claude-vm/extract.ts: native Claude Code's ES modules made runnable on
 * tabcomputer's node (docs/CLAUDE_VM.md): Bun's paths and import.meta, and
 * CommonJS with live imports (Bun's chunks assign exports in lazy
 * initializers and import each other in cycles).
 */
import { describe, it, expect } from 'vitest';
import { transform } from 'esbuild';
import { adaptModule, toCommonJS, launcherSource, bundleHeader, bundleEntry } from '@shiro/claude-vm/extract';
import { PRETRANSFORMED } from '@shiro/node-compat/require';
import { createTestShell, run } from './helpers';

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
});
