/**
 * The rest of Bun's surface Claude Code touches under claude --vm
 * (src/claude-vm/bun/index.ts): Bun.Transpiler for a mod's TypeScript/JSX
 * hooks module, Bun.SQL's refusal (claude gateway), Bun.ant's optional
 * calls, and what is left out so Claude Code takes its own path.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { transform } from 'esbuild';
import { createBun } from '@shiro/claude-vm/bun/index';
import { selfExecSource, NPM_STUB_LIMIT } from '@shiro/claude-vm/bun/self-exec';
import { createTestShell } from './helpers';
import { installNodeWorker } from './node-worker-setup';

// (native esbuild for the page's: esbuild-wasm wants the page's asset URL)
vi.mock('@shiro/commands/build', () => ({ withEsbuild: async (f: (e: unknown) => unknown) => f({ transform: (code: string, opts: object) => transform(code, opts as any) }) }));

let cleanup: () => void;
beforeAll(async () => { cleanup = await installNodeWorker(); }, 120_000);
afterAll(() => cleanup?.());

const Bun: any = createBun({ fs: {}, process: { env: {}, cwd: () => '/' }, childProcess: {}, Buffer });
const JSX_PRAGMAS = '/** @jsxRuntime classic */ /** @jsx h */ /** @jsxFrag Fragment */ ';
const TSX = `${JSX_PRAGMAS}import { h, Fragment } from './ui.js';\nimport type { T } from './t';\ninterface P { a: number }\nexport const v = (n: number, o?: P): T => <><b id="x">{n}</b></>;\n`;

describe('Bun.Transpiler (mods: hooks modules in TypeScript or JSX)', () => {
  it('as a kernel guest: the page compiles it with esbuild while the guest waits', async () => {
    const { shell, fs } = await createTestShell();
    await fs.mkdir('/tmp/tp', { recursive: true });
    await fs.writeFile('/tmp/tp/src.tsx', TSX);
    await fs.writeFile('/tmp/tp/t.js', `const vm = require('tabcomputer:claude-vm');
const { createBun } = await vm.load();
const Bun = createBun({ fs: require('fs'), process: process, childProcess: require('child_process'), Buffer: Buffer, transform: vm.transformSync });
const src = require('fs').readFileSync('/tmp/tp/src.tsx', 'utf8');
const out = new Bun.Transpiler({ loader: 'tsx', macro: false }).transformSync(src);
let err;
try { new Bun.Transpiler({ loader: 'ts' }).transformSync('let a: = ;'); } catch (e) { err = { message: e.message, line: e.errors[0].position.line }; }
console.log(JSON.stringify({ out, err }));
`);
    let text = '';
    await shell.execute('export TABCOMPUTER_NODE_WORKER=1; node /tmp/tp/t.js < /dev/null', (s) => { text += s; }, (s) => { text += s; });
    const r = JSON.parse(text.trim().split('\n').pop()!);
    expect(r.out).toContain('import { h, Fragment } from "./ui.js"');
    expect(r.out).toContain('h(Fragment, null, /* @__PURE__ */ h("b", { id: "x" }, n))');
    expect(r.out).not.toMatch(/interface|import type|: number|o\?/);
    // (as Bun's: errors with a position, which Claude Code reports)
    expect(r.err).toMatchObject({ line: 1 });
    expect(r.err.message).toMatch(/Unexpected/);
  }, 60_000);

  it('node in the page: node-compat\'s own type stripping and JSX, with the pragmas\' factory', () => {
    const out = new Bun.Transpiler({ loader: 'tsx' }).transformSync(
      `${JSX_PRAGMAS}import { h, Fragment } from './ui.js';\nexport function v(n: number): any { return <><b id="x">{n}</b></>; }\n`);
    expect(out).not.toContain('require("react")');
    expect(out).toContain("import { h, Fragment } from './ui.js'");
    const body = out.replace("import { h, Fragment } from './ui.js';", '').replace('export function v', 'return function v');
    const h = (t: unknown, p: unknown, ...c: unknown[]) => ({ t, p, c });
    const v = new Function('h', 'Fragment', body)(h, 'F');
    expect(v(2)).toEqual({ t: 'F', p: null, c: [{ t: 'b', p: { id: 'x' }, c: [2] }] });
  });

  it('js is left alone; transform() is the same, as a promise', async () => {
    expect(new Bun.Transpiler({ loader: 'js' }).transformSync('const a = 1;')).toBe('const a = 1;');
    expect(await new Bun.Transpiler({ loader: 'ts' }).transform('let a: number = 1;')).toContain('let a = 1;');
  });
});

describe('Bun.SQL, Bun.ant, and what is left out', () => {
  it('SQL refuses with what to do instead', () => {
    expect(() => new Bun.SQL('postgres://localhost/x', {})).toThrow(/claude --x86 gateway/);
  });
  it("ant: setDumpable succeeds, memory pressure is 'normal'", () => {
    expect(Bun.ant.setDumpable(false)).toBe(true);
    expect(Bun.ant.memoryPressureLevel()).toBe('normal');
  });
  it('optional APIs stay absent, so the bundle falls back as it checks for them', () => {
    expect(Bun.JSONL?.parseChunk).toBe(undefined);
    expect(typeof Bun.FetchSession).toBe('undefined');
    expect('WebView' in Bun).toBe(false);
    expect(typeof Bun.ant?.getPeerPid).toBe('undefined');
    expect(typeof Bun.ant?.getPeerUid).toBe('undefined');
  });
});

describe('the self-exec launcher (process.execPath)', () => {
  it('is over the npm-stub size, a node script that imports vm-main.mjs first thing', () => {
    const src = selfExecSource();
    expect(src.length).toBeGreaterThan(NPM_STUB_LIMIT);
    expect(src.split('\n').slice(0, 2)).toEqual(['#!/usr/bin/env node', "import(__dirname + '/vm-main.mjs');"]);
  });
});
