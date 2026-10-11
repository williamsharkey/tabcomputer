/**
 * src/claude-vm/extract.ts: native Claude Code's ES modules made runnable on
 * tabcomputer's node (docs/CLAUDE_VM.md): Bun's paths and import.meta, and
 * CommonJS with live imports (Bun's chunks assign exports in lazy
 * initializers and import each other in cycles).
 */
import { describe, it, expect } from 'vitest';
import { transform } from 'esbuild';
import { adaptModule, toCommonJS, launcherSource } from '@shiro/claude-vm/extract';

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
    expect(l.indexOf('globalThis.Bun = createBun(')).toBeLessThan(l.indexOf("import('./cli.js')"));
    // (spelled out: node-compat's transform drops a shorthand `Buffer` property)
    expect(l).toContain('Buffer: Buffer');
  });
});
