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
