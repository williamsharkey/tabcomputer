import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as nodeFs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import { HotswapManager, swapModules, isClass } from '@shiro/hotswap/swap';
import { registerLive, liveModules, liveLoaders, liveImport, trackInstance, instancesOf } from '@shiro/hotswap/live';
import { buildSwap, type HotswapFs } from '@shiro/hotswap/build';
import { parseDuration } from '@shiro/commands/hotswap';
import { createTestShell, run } from './helpers';

const repo = path.resolve(__dirname, '../../..');

// A module "src/greeter.ts" as the page has it
function makeLive() {
  class Greeter {
    name: string;
    constructor(name: string) { this.name = name; trackInstance(this); }
    greet() { return `hello ${this.name}`; }
    get loud() { return this.greet().toUpperCase(); }
    static kind() { return 'v1'; }
  }
  const helper = () => 'h1';
  const ns = { Greeter, helper, VERSION: 1 };
  registerLive('src/greeter.ts', ns);
  return ns;
}

function makeNext(extra: Record<string, unknown> = {}) {
  class Greeter {
    name!: string;
    greet() { return `hi ${this.name}`; }
    get loud() { return `${this.greet()}!`; }
    wave() { return `${this.name} waves`; }
    static kind() { return 'v2'; }
  }
  return { Greeter, helper: () => 'h2', VERSION: 2, ...extra };
}

async function evalCode(code: string): Promise<Record<string, Record<string, unknown>>> {
  const first = /^\/\/ hotswap-needs: (.*)\n/.exec(code);
  if (first) for (const k of JSON.parse(first[1])) await liveImport(k);
  const mod = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const out: Record<string, Record<string, unknown>> = {};
  (mod.__keys as string[]).forEach((k, i) => { out[k] = mod[`m${i}`]; });
  return out;
}

describe('hotswap: swapping classes', () => {
  let mgr: HotswapManager;
  beforeEach(() => { mgr = new HotswapManager(); });
  afterEach(() => { mgr.revert(true); liveModules().delete('src/greeter.ts'); vi.useRealTimers(); });

  it('moves methods, accessors and statics onto the live class, and reverts exactly', () => {
    const live = makeLive();
    const g = new live.Greeter('ada');
    const rec = mgr.apply({ 'src/greeter.ts': makeNext() });
    expect(g.greet()).toBe('hi ada');
    expect(g.loud).toBe('hi ada!');
    expect((g as any).wave()).toBe('ada waves');
    expect(live.Greeter.kind()).toBe('v2');
    const cls = rec.report[0].classes[0];
    expect(cls.name).toBe('Greeter');
    // (the live class's code wasn't installed by a swap: nothing to compare against)
    expect(cls.changed).toEqual([]);
    expect(cls.swapped).toBe(3);
    expect(cls.added).toEqual(['wave']);
    // free exports keep their old bindings, and are reported
    expect(rec.report[0].fixed.sort()).toEqual(['VERSION', 'helper']);

    mgr.revert();
    expect(g.greet()).toBe('hello ada');
    expect(g.loud).toBe('HELLO ADA');
    expect((g as any).wave).toBeUndefined();
    expect(live.Greeter.kind()).toBe('v1');
    expect(mgr.stack).toHaveLength(0);
  });

  it('treats the live and new class as one for instanceof, and new instances revert too', () => {
    const live = makeLive();
    const next = makeNext();
    const old = new live.Greeter('a');
    mgr.apply({ 'src/greeter.ts': next });
    const made = new next.Greeter();
    made.name = 'b';
    expect(old instanceof next.Greeter).toBe(true);
    expect(made instanceof live.Greeter).toBe(true);
    class Sub extends live.Greeter {}
    expect(old instanceof Sub).toBe(false);
    expect(new Sub('c') instanceof live.Greeter).toBe(true);
    mgr.revert();
    expect(made.greet()).toBe('hello b');
    expect(made instanceof live.Greeter).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(live.Greeter, Symbol.hasInstance)).toBe(false);
  });

  it('runs migrateFrom on tracked instances with the old methods', () => {
    const live = makeLive();
    const a = new live.Greeter('a');
    const b = new live.Greeter('b');
    const seen: string[] = [];
    class Greeter {
      name!: string;
      greet() { return `yo ${this.name}`; }
      migrateFrom(this: any, old: any) { seen.push(old.greet.call(this)); this.migrated = true; }
    }
    const rec = mgr.apply({ 'src/greeter.ts': { Greeter } });
    expect(seen.sort()).toEqual(['hello a', 'hello b']);
    expect((a as any).migrated && (b as any).migrated).toBe(true);
    expect(rec.report[0].classes[0].migrated).toBe(2);
    expect('migrateFrom' in a).toBe(false);
    expect(instancesOf(live.Greeter).length).toBeGreaterThanOrEqual(2);
  });

  it('runs a module __hotswap hook and its revert', () => {
    const live = makeLive();
    const log: string[] = [];
    const next = makeNext({
      __hotswap(ctx: any) {
        log.push(`apply ${ctx.key} old v${ctx.old.VERSION}`);
        ctx.onRevert(() => log.push('onRevert'));
        return () => log.push('returned');
      },
    });
    mgr.apply({ 'src/greeter.ts': next });
    expect(log).toEqual(['apply src/greeter.ts old v1']);
    mgr.revert();
    expect(log).toEqual(['apply src/greeter.ts old v1', 'returned', 'onRevert']);
    expect(new live.Greeter('x').greet()).toBe('hello x');
  });

  it('is all or nothing: a throwing hook leaves the page as it was', () => {
    const live = makeLive();
    const g = new live.Greeter('z');
    const next = makeNext({ __hotswap() { throw new Error('boom'); } });
    expect(() => mgr.apply({ 'src/greeter.ts': next })).toThrow('boom');
    expect(g.greet()).toBe('hello z');
    expect(live.Greeter.kind()).toBe('v1');
    expect(mgr.stack).toHaveLength(0);
  });

  it('skips modules that are not live', () => {
    const undo: (() => void)[] = [];
    const rep = swapModules({ 'src/nowhere.ts': makeNext() }, undo);
    expect(rep[0].live).toBe(false);
    expect(undo).toHaveLength(0);
  });

  it('auto-reverts when the TTL runs out unconfirmed, and confirm stops it', () => {
    vi.useFakeTimers();
    const live = makeLive();
    const g = new live.Greeter('t');
    const reverted: number[] = [];
    mgr.onAutoRevert = (recs, reason) => { expect(reason).toBe('ttl'); reverted.push(...recs.map((r) => r.id)); };
    const r1 = mgr.apply({ 'src/greeter.ts': makeNext() }, { ttlMs: 90_000 });
    expect(r1.deadline).toBeGreaterThan(Date.now());
    vi.advanceTimersByTime(89_000);
    expect(g.greet()).toBe('hi t');
    vi.advanceTimersByTime(2_000);
    expect(g.greet()).toBe('hello t');
    expect(reverted).toEqual([r1.id]);

    const r2 = mgr.apply({ 'src/greeter.ts': makeNext() }, { ttlMs: 1000 });
    expect(mgr.confirm().map((r) => r.id)).toEqual([r2.id]);
    vi.advanceTimersByTime(5000);
    expect(g.greet()).toBe('hi t');
    expect(r2.confirmed && r2.deadline === null).toBe(true);
  });

  it('a TTL reverting an older swap reverts the swaps stacked on it', () => {
    vi.useFakeTimers();
    const live = makeLive();
    const g = new live.Greeter('s');
    mgr.apply({ 'src/greeter.ts': makeNext() }, { ttlMs: 1000 });
    class Greeter { name!: string; greet() { return `third ${this.name}`; } }
    const r2 = mgr.apply({ 'src/greeter.ts': { Greeter } }, { confirmed: true });
    expect(r2.report[0].classes[0].changed).toEqual(['greet']);
    expect(g.greet()).toBe('third s');
    vi.advanceTimersByTime(1500);
    expect(g.greet()).toBe('hello s');
    expect(mgr.stack).toHaveLength(0);
  });

  it('parses TTLs', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('90')).toBe(90_000);
    expect(parseDuration('2m')).toBe(120_000);
    expect(parseDuration('500ms')).toBe(500);
    expect(parseDuration('soon')).toBeNull();
    expect(isClass(class {})).toBe(true);
    expect(isClass(() => 1)).toBe(false);
  });
});

/** A file tree in memory over the real repo (edits shadow files) */
function overlayFs(edits: Record<string, string>): HotswapFs {
  return {
    async readFile(p: string) {
      if (p in edits) return edits[p];
      return nodeFs.readFileSync(p, 'utf8');
    },
  };
}

describe('hotswap: building a swap bundle', () => {
  afterEach(() => { for (const k of [...liveModules().keys()]) if (k.startsWith('src/hs-fixture')) liveModules().delete(k); });

  it('resolves imports outside the swap set to live modules and copies the rest', async () => {
    const files: Record<string, string> = {
      '/co/src/hs-fixture/a.ts': `import { counter, bump } from './b';\nimport { other } from './c';\nexport class A { get n(): number { return counter.value; } inc() { bump(); return other(); } }\n`,
      '/co/src/hs-fixture/b.ts': 'never read: live',
      '/co/src/hs-fixture/c.ts': `export const other = (): string => 'copied';\n`,
    };
    const fs: HotswapFs = { async readFile(p) { if (p in files) return files[p]; throw new Error('ENOENT ' + p); } };
    const counter = { value: 41 };
    registerLive('src/hs-fixture/b.ts', { counter, bump: () => { counter.value++; } });
    const out = await buildSwap(fs, { root: '/co', files: ['src/hs-fixture/a.ts'], build: esbuild.build as any });
    expect(out.keys).toEqual(['src/hs-fixture/a.ts']);
    expect(out.copied).toEqual(['src/hs-fixture/c.ts']);
    expect(out.warnings.join('\n')).toMatch(/c\.ts isn't loaded/);
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
    const mods = await evalCode(out.code);
    const A = mods['src/hs-fixture/a.ts'].A as any;
    const a = new A();
    expect(a.n).toBe(41);
    expect(a.inc()).toBe('copied');
    expect(counter.value).toBe(42);
    expect(a.n).toBe(42);
  });

  it('loads lazy modules the page way: import() at run time, static imports before the bundle runs', async () => {
    const files: Record<string, string> = {
      '/co/src/hs-fixture/l.ts': `import { early } from './e';\nexport class L { early() { return early; } async later() { return (await import('./d')).d; } }\n`,
      '/co/src/hs-fixture/e.ts': '', '/co/src/hs-fixture/d.ts': '',
    };
    const fs: HotswapFs = { async readFile(p) { if (p in files) return files[p]; throw new Error('ENOENT ' + p); } };
    let loads = 0;
    liveLoaders().set('src/hs-fixture/e.ts', async () => { loads++; return { early: 'E' }; });
    liveLoaders().set('src/hs-fixture/d.ts', async () => { loads++; return { d: 'D' }; });
    try {
      const out = await buildSwap(fs, { root: '/co', files: ['src/hs-fixture/l.ts'], build: esbuild.build as any });
      expect(out.needs).toEqual(['src/hs-fixture/e.ts']);
      expect(out.copied).toEqual([]);
      expect(out.code).toContain('globalThis.__tabcomputerLiveImport("src/hs-fixture/d.ts")');
      const L = (await evalCode(out.code))['src/hs-fixture/l.ts'].L as any;
      expect(loads).toBe(1);
      expect(new L().early()).toBe('E');
      expect(await new L().later()).toBe('D');
      expect(loads).toBe(2);
    } finally {
      liveLoaders().delete('src/hs-fixture/e.ts');
      liveLoaders().delete('src/hs-fixture/d.ts');
    }
  });

  it("shares the live module's state: containers aliased, lets carried in and written back on revert", async () => {
    const src = `let counter = 0;\nconst reg = new Map<string, number>();\nconst TABLE = new Set(['a']);\nexport class C { inc(): number { reg.set('n', ++counter); return counter; } get reg() { return reg; } get table() { return TABLE; } }\n`;
    const files: Record<string, string> = { '/co/src/hs-fixture/c.ts': src };
    const fs: HotswapFs = { async readFile(p) { if (p in files) return files[p]; throw new Error('ENOENT ' + p); } };
    // the live module, as the Vite plugin exposes it
    let liveCounter = 41;
    const liveReg = new Map<string, number>();
    class C { inc() { return ++liveCounter; } }
    registerLive('src/hs-fixture/c.ts', { C });
    const g = globalThis as any;
    (g.__tabcomputerLiveState ??= new Map()).set('src/hs-fixture/c.ts', {
      get counter() { return liveCounter; }, set counter(v: number) { liveCounter = v; },
      get reg() { return liveReg; },
    });
    try {
      const out = await buildSwap(fs, { root: '/co', files: ['src/hs-fixture/c.ts'], build: esbuild.build as any });
      const mgr = new HotswapManager();
      const rec = mgr.apply(await evalCode(out.code));
      expect(rec.report[0].state.sort()).toEqual(['counter', 'reg']);
      const { moduleState } = await import('@shiro/hotswap/state');
      expect(moduleState(src).map((x) => x.name)).toEqual(['counter', 'reg']);
      expect(moduleState('const a = /* @__PURE__ */ new Map();\nconst b = new WeakMap<number, WeakRef<C>>();\nconst t = { x: 1 };\nconst l = [];\nexport let e = 1;\n  let inner = 2;\n'))
        .toEqual([{ name: 'e', mutable: true }, { name: 'a', mutable: false }, { name: 'b', mutable: false }, { name: 'l', mutable: false }]);
      expect(rec.report[0].fixed).toEqual([]);
      const c = new C() as any;
      expect(c.inc()).toBe(42);
      expect(c.inc()).toBe(43);
      expect(c.reg).toBe(liveReg);
      expect(liveReg.get('n')).toBe(43);
      expect(c.table.has('a')).toBe(true);
      mgr.revert();
      expect(liveCounter).toBe(43);
      expect(c.inc()).toBe(44);

      // --fresh-state: the swap keeps its own
      const fresh = await buildSwap(fs, { root: '/co', files: ['src/hs-fixture/c.ts'], build: esbuild.build as any, freshState: true });
      const rec2 = mgr.apply(await evalCode(fresh.code));
      expect(rec2.report[0].state).toEqual([]);
      expect((new C() as any).inc()).toBe(1);
      mgr.revert();
    } finally {
      g.__tabcomputerLiveState.delete('src/hs-fixture/c.ts');
    }
  });

  it('refuses bare imports that are not live', async () => {
    const fs: HotswapFs = { async readFile(p) { if (p === '/co/src/hs-fixture/x.ts') return `import 'left-pad';\nexport const x = 1;\n`; throw new Error('ENOENT'); } };
    await expect(buildSwap(fs, { root: '/co', files: ['src/hs-fixture/x.ts'], build: esbuild.build as any }))
      .rejects.toThrow(/left-pad.*isn't a live module/s);
  });
});

describe('hotswap: the real Shell', () => {
  it('builds an edited src/shell.ts, swaps it into a live shell, and reverts', async () => {
    const { shell } = await createTestShell();
    // The live map as the Vite plugin makes it: every module shell.ts imports
    const shellPath = path.join(repo, 'src/shell.ts');
    const source = nodeFs.readFileSync(shellPath, 'utf8');
    const specs = new Set<string>();
    for (const m of source.matchAll(/(?:from\s+|import\()\s*'(\.[^']+)'/g)) specs.add(m[1]);
    for (const spec of specs) {
      const base = path.resolve(path.dirname(shellPath), spec);
      const file = ['.ts', '/index.ts', ''].map((e) => base + e).find((f) => nodeFs.existsSync(f) && nodeFs.statSync(f).isFile());
      if (!file) continue;
      const key = path.relative(repo, file).split(path.sep).join('/');
      registerLive(key, await import(/* @vite-ignore */ file));
    }
    registerLive('src/shell.ts', await import('@shiro/shell'));

    const edited = source.replace("if (varName === 'BASH_VERSION') { result += '5.0.0';", "if (varName === 'BASH_VERSION') { result += '9.9.9-hotswap';");
    expect(edited).not.toBe(source);
    const out = await buildSwap(overlayFs({ [shellPath]: edited }), { root: repo, files: ['src/shell.ts'], build: esbuild.build as any });
    expect(out.copied).toEqual([]);

    expect((await run(shell, 'echo $BASH_VERSION')).output.trim()).toBe('5.0.0');
    const mgr = new HotswapManager();
    const rec = mgr.apply(await evalCode(out.code), { ttlMs: 60_000 });
    const shellReport = rec.report[0].classes.find((c) => c.name === 'Shell')!;
    expect(shellReport.swapped).toBeGreaterThan(100);
    expect((await run(shell, 'echo $BASH_VERSION')).output.trim()).toBe('9.9.9-hotswap');
    // a subshell is a new Shell made by the new code
    expect((await run(shell, '(echo $BASH_VERSION; echo ok)')).output).toContain('9.9.9-hotswap');
    mgr.revert();
    expect((await run(shell, 'echo $BASH_VERSION')).output.trim()).toBe('5.0.0');
    expect((await run(shell, 'echo hi | cat')).output.trim()).toBe('hi');
  }, 60_000);
});

describe('hotswap: persistence', () => {
  const store = new Map<string, string>();
  beforeEach(() => {
    store.clear();
    (globalThis as any).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    };
  });
  afterEach(() => { liveModules().delete('src/greeter.ts'); });

  it('re-applies a confirmed swap on the same build and discards it on another', async () => {
    const { hotswap } = await import('@shiro/hotswap/swap');
    const persist = await import('@shiro/hotswap/persist');
    const live = makeLive();
    const g = new live.Greeter('p');
    const files: Record<string, string> = {
      '/co/src/greeter.ts': `export class Greeter { name!: string; greet() { return 'persisted ' + this.name; } }\n`,
    };
    const fs: HotswapFs = { async readFile(p) { if (p in files) return files[p]; throw new Error('ENOENT ' + p); } };
    const out = await buildSwap(fs, { root: '/co', files: ['src/greeter.ts'], build: esbuild.build as any });
    const rec = hotswap.apply(await evalCode(out.code), { files: out.keys, code: out.code, hash: out.hash, ttlMs: 1000 });
    // unconfirmed swaps are never persisted
    expect(await persist.persistSwaps(hotswap.stack)).toHaveLength(0);
    hotswap.confirm(rec.id);
    expect(await persist.persistSwaps(hotswap.stack)).toHaveLength(1);
    expect(store.get(persist.FLAG)).toBe('1');
    hotswap.revert(true);
    expect(g.greet()).toBe('hello p');

    // "boot": the same build re-applies it
    const lines = await persist.restorePersisted();
    expect(lines.join('\n')).toMatch(/re-applied #\d+ src\/greeter\.ts/);
    expect(g.greet()).toBe('persisted p');
    expect(hotswap.stack[0].confirmed && hotswap.stack[0].persisted).toBe(true);
    hotswap.revert(true);

    // a tampered bundle is skipped
    await persist.persistSwaps([{ ...rec, confirmed: true, code: out.code + '\n// edited' }]);
    expect((await persist.restorePersisted()).join('\n')).toMatch(/doesn't match its hash/);
    expect(g.greet()).toBe('hello p');
    expect(hotswap.stack).toHaveLength(0);

    // made for another build (a new deploy): discarded, and the flag cleared
    await persist.persistSwaps([{ ...rec, confirmed: true }], 'oldsha#1');
    expect((await persist.restorePersisted('newsha#2')).join('\n')).toMatch(/discarded 1 persisted swap/);
    expect(await persist.loadPersisted()).toHaveLength(0);
    expect(store.has(persist.FLAG)).toBe(false);
    expect(g.greet()).toBe('hello p');
  });
});

describe('hotswap: the in-tab test runner', () => {
  const suite = `
import { describe, it, test, expect, beforeEach, afterAll, vi } from 'vitest';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { helper } from '@shiro/hs-fixture/util';
const log = [];
describe('outer', () => {
  let n = 0;
  beforeEach(() => { n++; });
  it('passes', () => { expect(helper()).toBe('util'); expect(n).toBe(1); });
  it('fails', () => { expect({ a: [1, 2] }).toEqual({ a: [1, 3] }); });
  it.each([[1, 2, 3], [2, 2, 4]])('adds %i + %i', (a, b, c) => { expect(a + b).toBe(c); });
  it.skip('skipped', () => { throw new Error('ran'); });
  test.todo('later');
  it('matchers', async () => {
    expect('hello world').toContain('world');
    expect([1, { x: 2 }]).toContainEqual({ x: 2 });
    expect({ a: 1, b: { c: 2 } }).toMatchObject({ b: { c: expect.any(Number) } });
    expect(() => { throw new TypeError('bad'); }).toThrow(/ba/);
    expect(5).not.toBeGreaterThan(5);
    await expect(Promise.resolve(3)).resolves.toBe(3);
    await expect(Promise.reject(new Error('no'))).rejects.toThrow('no');
    const f = vi.fn((x) => x * 2);
    expect(f(4)).toBe(8);
    expect(f).toHaveBeenCalledWith(4);
    expect(join('/a', 'b', '../c')).toBe('/a/c');
  });
  it('isolated storage', async () => {
    localStorage.setItem('k', 'v');
    expect(localStorage.getItem('k')).toBe('v');
    expect(globalThis.__tcTestEnv.localStorage.getItem('k')).toBe('v');
  });
  it('node:fs throws when used', () => { expect(() => readFileSync('/x')).toThrow(/node:fs isn't available/); });
  it('times out', async () => { await new Promise((r) => setTimeout(r, 200)); }, 20);
  afterAll(() => { log.push('afterAll'); });
});
`;
  it('runs a vitest suite built from a checkout, with isolated storage', async () => {
    const files: Record<string, string> = {
      '/co/tests/x.test.ts': suite,
      '/co/src/hs-fixture/util.ts': `export const helper = (): string => 'util';\n`,
    };
    const fs: HotswapFs = { async readFile(p) { if (p in files) return files[p]; throw new Error('ENOENT ' + p); } };
    const { buildTest } = await import('@shiro/hotswap/build');
    const { runTestBundle } = await import('@shiro/hotswap/test-runner');
    const before = (globalThis as any).localStorage;
    const out = await buildTest(fs, { root: '/co', file: 'tests/x.test.ts', build: esbuild.build as any });
    expect(out.code).toContain('globalThis.__tcTestEnv.localStorage');
    const seen: string[] = [];
    const sum = await runTestBundle(out.code, { onResult: (r) => seen.push(`${r.status} ${r.name}`) });
    expect(sum.errors).toEqual([]);
    expect(seen).toEqual([
      'pass outer > passes',
      'fail outer > fails',
      'pass outer > adds 1 + 2',
      'pass outer > adds 2 + 2',
      'skip outer > skipped',
      'todo outer > later',
      'pass outer > matchers',
      'pass outer > isolated storage',
      'pass outer > node:fs throws when used',
      'fail outer > times out',
    ]);
    expect(sum.results.find((r) => r.name === 'outer > fails')!.error).toMatch(/expected \{a: \[1, 2\]\} to deeply equal \{a: \[1, 3\]\}/);
    expect(sum.results.find((r) => r.name === 'outer > times out')!.error).toMatch(/timed out in 20ms/);
    expect([sum.passed, sum.failed, sum.skipped]).toEqual([6, 2, 2]);
    // the page's storage was never touched
    expect((globalThis as any).localStorage).toBe(before);

    // -t filters by full name
    const only = await runTestBundle(out.code, { filter: /adds/ });
    expect(only.results.map((r) => r.name)).toEqual(['outer > adds 1 + 2', 'outer > adds 2 + 2']);
  });
});

describe('hotswap: checkout, diff and push of the build source', () => {
  // A filesystem in memory with the calls source.ts uses
  function memFs() {
    const files = new Map<string, Uint8Array>();
    const dirs = new Set<string>(['/']);
    const enc = new TextEncoder();
    const parent = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/';
    return {
      files,
      async readFile(p: string, e?: 'utf8') {
        const d = files.get(p);
        if (!d) throw new Error('ENOENT ' + p);
        return e ? new TextDecoder().decode(d) : d;
      },
      async writeFile(p: string, d: Uint8Array | string) {
        if (!dirs.has(parent(p))) throw new Error('ENOENT dir ' + parent(p));
        files.set(p, typeof d === 'string' ? enc.encode(d) : d);
      },
      async mkdir(p: string) { for (let d = p; d !== '/'; d = parent(d)) dirs.add(d); },
      async readdir(p: string) {
        const names = new Set<string>();
        for (const k of [...files.keys(), ...dirs]) if (k !== p && parent(k) === p) names.add(k.slice(p.length + 1));
        if (!dirs.has(p)) throw new Error('ENOENT ' + p);
        return [...names];
      },
      async stat(p: string) {
        const isDir = dirs.has(p), isFile = files.has(p);
        if (!isDir && !isFile) throw new Error('ENOENT ' + p);
        return { isDirectory: () => isDir, isFile: () => isFile };
      },
      async unlink(p: string) { files.delete(p); },
    };
  }

  async function tarball() {
    const { tar } = await import('../../../vite-plugin-hotswap');
    const zlib = await import('node:zlib');
    const crypto = await import('node:crypto');
    const sha1 = (b: Buffer) => crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
    const src: [string, Buffer][] = [
      ['src/shell.ts', Buffer.from('export class Shell {}\n')],
      ['src/old.ts', Buffer.from('export const old = 1;\n')],
      ['tests/tests/shiro-vitest/' + 'deep/'.repeat(25) + 'long.test.ts', Buffer.from('// a path over 100 bytes\n')],
    ];
    const manifest = { sha: 'b'.repeat(40), build: '961', files: Object.fromEntries(src.map(([p, d]) => [p, sha1(d)])) };
    return new Uint8Array(zlib.gzipSync(tar([['.hotswap-source.json', Buffer.from(JSON.stringify(manifest))], ...src])));
  }

  it('unpacks the tarball, finds changes, and pushes them on the build commit', async () => {
    const src = await import('@shiro/hotswap/source');
    const fs = memFs();
    const gz = await tarball();
    const m = await src.checkoutSource(fs as any, '/home/user/shiro', { fetch: (async () => new Response(gz)) as any, url: 'http://x/' });
    expect(m.build).toBe('961');
    expect(fs.files.has('/home/user/shiro/tests/tests/shiro-vitest/' + 'deep/'.repeat(25) + 'long.test.ts')).toBe(true);
    expect(await src.sourceChanges(fs as any, '/home/user/shiro')).toEqual([]);
    await expect(src.checkoutSource(fs as any, '/home/user/shiro', { fetch: (async () => new Response(gz)) as any, url: 'http://x/' })).rejects.toThrow(/not empty/);

    await fs.writeFile('/home/user/shiro/src/shell.ts', 'export class Shell { hi() { return 1; } }\n');
    await fs.writeFile('/home/user/shiro/src/new.ts', 'export const n = 2;\n');
    await fs.unlink('/home/user/shiro/src/old.ts');
    expect(await src.sourceChanges(fs as any, '/home/user/shiro')).toEqual([
      { path: 'src/new.ts', status: 'A' }, { path: 'src/old.ts', status: 'D' }, { path: 'src/shell.ts', status: 'M' },
    ]);
    expect(await src.baseText(fs as any, '/home/user/shiro', 'src/shell.ts')).toBe('export class Shell {}\n');

    // GitHub, faked
    const calls: [string, string, any][] = [];
    let branchHead: string | null = null;
    let n = 0;
    const api = async (method: string, path: string, body?: any) => {
      calls.push([method, path, body]);
      if (method === 'GET' && path.endsWith(`/git/commits/${'b'.repeat(40)}`)) return { status: 200, data: { tree: { sha: 'basetree' } } };
      if (method === 'GET' && path.includes('/git/ref/heads/')) return branchHead ? { status: 200, data: { object: { sha: branchHead } } } : { status: 404, data: {} };
      if (method === 'POST' && path.endsWith('/git/blobs')) return { status: 201, data: { sha: `blob${++n}` } };
      if (method === 'POST' && path.endsWith('/git/trees')) return { status: 201, data: { sha: `tree${++n}` } };
      if (method === 'POST' && path.endsWith('/git/commits')) return { status: 201, data: { sha: `commit${++n}` } };
      if (method === 'POST' && path.endsWith('/git/refs')) { branchHead = body.sha; return { status: 201, data: {} }; }
      if (method === 'PATCH') { branchHead = body.sha; return { status: 200, data: {} }; }
      return { status: 500, data: { message: 'unexpected ' + method + ' ' + path } };
    };
    const r1 = await src.pushSource(fs as any, '/home/user/shiro', api, { repo: 'o/r', branch: 'fix/x', message: 'shell: hi' });
    expect(r1).toMatchObject({ created: true, files: 3, branch: 'fix/x' });
    const tree = calls.find((c) => c[1].endsWith('/git/trees'))![2];
    expect(tree.base_tree).toBe('basetree');
    expect(tree.tree).toEqual([
      { path: 'src/new.ts', mode: '100644', type: 'blob', sha: 'blob1' },
      { path: 'src/old.ts', mode: '100644', type: 'blob', sha: null },
      { path: 'src/shell.ts', mode: '100644', type: 'blob', sha: 'blob2' },
    ]);
    const commit = calls.find((c) => c[1].endsWith('/git/commits') && c[0] === 'POST')![2];
    expect(commit.parents).toEqual(['b'.repeat(40)]);
    expect(atob(calls.find((c) => c[1].endsWith('/git/blobs'))![2].content)).toBe('export const n = 2;\n');

    // a second push from this checkout goes on top of the first
    calls.length = 0;
    const r2 = await src.pushSource(fs as any, '/home/user/shiro', api, { repo: 'o/r', branch: 'fix/x', message: 'more' });
    expect(r2.created).toBe(false);
    expect(calls.find((c) => c[1].endsWith('/git/commits') && c[0] === 'POST')![2].parents).toEqual([r1.commit]);
    // a branch someone else moved is refused without --force
    branchHead = 'someoneelse';
    await expect(src.pushSource(fs as any, '/home/user/shiro', api, { repo: 'o/r', branch: 'fix/x', message: 'm' })).rejects.toThrow(/wasn't pushed from this checkout/);
  });

  it('names the source tarball after the build commit', async () => {
    const { sourceTarName } = await import('../../../vite-plugin-hotswap');
    const { sourceUrl } = await import('@shiro/hotswap/source');
    const sha = 'abcdef0123456789'.repeat(2) + 'abcdef01';
    expect(sourceUrl(sha, 'https://tabcomputer.com/')).toBe(`https://tabcomputer.com/${sourceTarName(sha)}`);
  });
});
