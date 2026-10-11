/**
 * tabcomputer#47: what hotswap's blob-evaluated bundles may do to the live page.
 * - import.meta.url in a swapped or tested module resolves through the page's
 *   registered URLs, not against the bundle's blob: (or, here, data:) URL
 * - a `hotswap test` run puts back the page globals and kernel hooks its module
 *   copies changed, and `hotswap status` can tell hooks added since boot
 * - getKernel() no longer publishes a kernel as the page's
 * - a lazy command the page never loaded can be swapped, then run
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as esbuild from 'esbuild';
import { buildSwap, rewriteImportMetaUrl, META_URL_HELPER, type HotswapFs } from '@shiro/hotswap/build';
import { HotswapManager } from '@shiro/hotswap/swap';
import { liveImport, liveLoaders, liveModules, registerLive } from '@shiro/hotswap/live';
import { snapshotPage, restorePage, markKernelBaseline, foreignKernelHooks, lastTestLeftovers } from '@shiro/hotswap/leftovers';
import { runTestBundle } from '@shiro/hotswap/test-runner';
import { getKernel } from '@shiro/kernel/kernel';
import { lazyCommand } from '@shiro/utils/lazy-command';
import { metaUrlLiterals, liveUrlRegistrations } from '../../../vite-plugin-hotswap';

const memFs = (files: Record<string, string>): HotswapFs => ({
  async readFile(p) { if (p in files) return files[p]; throw new Error(`ENOENT ${p}`); },
});

/** Evaluate a swap bundle as Node can: a data: URL (as a blob: one in the page, it is no base for relative URLs) */
async function evalBundle(code: string): Promise<Record<string, Record<string, unknown>>> {
  const first = /^\/\/ hotswap-needs: (.*)\n/.exec(code);
  if (first) for (const k of JSON.parse(first[1])) await liveImport(k);
  const mod = await import(/* @vite-ignore */ 'data:text/javascript;base64,' + Buffer.from(code).toString('base64'));
  const out: Record<string, Record<string, unknown>> = {};
  (mod.__keys as string[]).forEach((k, i) => { out[k] = mod[`m${i}`]; });
  return out;
}

const g = globalThis as any;
afterEach(() => { delete g.__tabcomputerLiveUrls; });

describe('import.meta.url in a bundle (#47)', () => {
  it('is rewritten to __tcUrl(key, lit) for new URL(lit, import.meta.url), and __tcUrl(key) alone', () => {
    const src = `const w = new Worker(new URL('./guest-entry.ts', import.meta.url), { type: 'module' });\nconst a = new URL("./a.wasm", import.meta.url);\nconst me = import.meta.url;\n`;
    const out = rewriteImportMetaUrl(src, 'src/node-worker/host.ts');
    expect(out).not.toContain('import.meta.url');
    expect(out).toContain(`new Worker(new URL(__tcUrl("src/node-worker/host.ts", "./guest-entry.ts")), { type: 'module' })`);
    expect(out).toContain(`new URL(__tcUrl("src/node-worker/host.ts", "./a.wasm"))`);
    expect(out).toContain(`const me = __tcUrl("src/node-worker/host.ts");`);
    expect(rewriteImportMetaUrl('const x = 1;', 'k')).toBe('const x = 1;');
  });

  it("the helper takes the page's registered URLs, else resolves against the live module's URL", () => {
    const __tcUrl = new Function(`${META_URL_HELPER}return __tcUrl;`)() as (k: string, lit?: string) => string;
    g.__tabcomputerLiveUrls = new Map([
      ['src/node-worker/host.ts', 'https://tab.test/assets/host-AbC.js'],
      ['src/node-worker/host.ts|./guest-entry.ts', 'https://tab.test/assets/guest-entry-XyZ.js'],
    ]);
    expect(__tcUrl('src/node-worker/host.ts', './guest-entry.ts')).toBe('https://tab.test/assets/guest-entry-XyZ.js');
    expect(__tcUrl('src/node-worker/host.ts')).toBe('https://tab.test/assets/host-AbC.js');
    expect(__tcUrl('src/node-worker/host.ts', './other.js')).toBe('https://tab.test/assets/other.js');
    delete g.__tabcomputerLiveUrls;
    expect(() => new URL(__tcUrl('src/x/y.ts', './w.ts'))).not.toThrow();
    expect(__tcUrl('src/x/y.ts', './w.ts')).toMatch(/\/src\/x\/w\.ts$/);
  });

  it('a built swap of a module using new URL(…, import.meta.url) evaluates from a data: URL without "Invalid URL"', async () => {
    const fs = memFs({ '/co/src/hs-url.ts': `export const workerUrl = () => new URL('./guest-entry.ts', import.meta.url).href;\nexport const self = () => import.meta.url;\n` });
    const out = await buildSwap(fs, { root: '/co', files: ['src/hs-url.ts'], build: esbuild.build as any });
    expect(out.code).not.toContain('import.meta.url');
    // (before: new URL('./guest-entry.ts', 'data:…') threw TypeError: Invalid URL, as a blob: base did in the page)
    const ns = (await evalBundle(out.code))['src/hs-url.ts'] as any;
    g.__tabcomputerLiveUrls = new Map([['src/hs-url.ts', 'https://tab.test/assets/hs-url-1.js'], ['src/hs-url.ts|./guest-entry.ts', 'https://tab.test/assets/guest-entry-2.js']]);
    expect(ns.workerUrl()).toBe('https://tab.test/assets/guest-entry-2.js');
    expect(ns.self()).toBe('https://tab.test/assets/hs-url-1.js');
  });
});

describe("the page's registrations of its modules' URLs (vite-plugin-hotswap.ts)", () => {
  it("pairs each source literal with Vite's rewritten expression, in order", () => {
    const source = `const w = new Worker(new URL('./guest-entry.ts', import.meta.url), { type: 'module' });\nconst a = new URL("./icon.svg", import.meta.url);`;
    expect(metaUrlLiterals(source)).toEqual(['./guest-entry.ts', './icon.svg']);
    const built = `const w = new Worker(new URL(/* @vite-ignore */ "/assets/guest-entry-AbC.js", import.meta.url), { type: 'module' });\nconst a = new URL("" + new URL("assets/icon-9f.svg", import.meta.url).href, import.meta.url);`;
    const reg = liveUrlRegistrations('src/node-worker/host.ts', metaUrlLiterals(source), built);
    expect(reg).toContain(`set("src/node-worker/host.ts|./guest-entry.ts", new URL(/* @vite-ignore */ "/assets/guest-entry-AbC.js", import.meta.url).href)`);
    expect(reg).toContain('"src/node-worker/host.ts|./icon.svg"');
    // counts that don't line up register nothing (the bundle's fallback applies)
    expect(liveUrlRegistrations('k', ['./a.ts', './b.ts'], `new URL("x", import.meta.url)`)).toBe('');
    expect(liveUrlRegistrations('k', [], `new URL("x", import.meta.url)`)).toBe('');
  });
});

describe('what a test run leaves in the page (#47)', () => {
  const stubKernel = (loaders: unknown[] = ['pageLoader'], execDirect: unknown[] = ['pageExec']) => ({ loaders, execDirect });

  it('snapshot and restore: globals, live map entries and kernel hooks', () => {
    const page: any = {
      __tabcomputerKernel: stubKernel(),
      __tabcomputerFlag: 1,
      __tabcomputerLive: new Map([['src/a.ts', { a: 1 }]]),
      __tabcomputerKlog: { log: true },
      unrelated: 'x',
    };
    const k = page.__tabcomputerKernel;
    const snap = snapshotPage(page);
    // what a suite's module copies did
    k.loaders.unshift('suiteLoader');
    k.execDirect.push('suiteExec');
    page.__tabcomputerFlag = 2;
    page.__tabcomputerNew = {};
    page.__tabcomputerLive.set('src/b.ts', { b: 1 });
    page.__tabcomputerLive.set('src/a.ts', { a: 'copy' });
    page.__tabcomputerKlog = { log: 'shared' }; // (the log is shared: left alone)
    const changed = restorePage(snap, page);
    expect(k.loaders).toEqual(['pageLoader']);
    expect(k.execDirect).toEqual(['pageExec']);
    expect(page.__tabcomputerFlag).toBe(1);
    expect('__tabcomputerNew' in page).toBe(false);
    expect([...page.__tabcomputerLive.keys()]).toEqual(['src/a.ts']);
    expect(page.__tabcomputerLive.get('src/a.ts')).toEqual({ a: 1 });
    expect(page.__tabcomputerKlog).toEqual({ log: 'shared' });
    expect(changed).toEqual(expect.arrayContaining([
      'global __tabcomputerNew added', 'global __tabcomputerFlag replaced',
      '__tabcomputerLive src/b.ts added', '__tabcomputerLive src/a.ts replaced',
      'kernel loaders: 1 added by the run, removed', 'kernel execDirect: 1 added by the run, removed',
    ]));
  });

  it('a kernel copy a suite published as the page\'s is put back', () => {
    const pageKernel = stubKernel();
    const page: any = { __tabcomputerKernel: pageKernel };
    const snap = snapshotPage(page);
    page.__tabcomputerKernel = stubKernel(['copy']);
    expect(restorePage(snap, page)).toContain('global __tabcomputerKernel replaced');
    expect(page.__tabcomputerKernel).toBe(pageKernel);
  });

  it('status: hooks added to the page kernel since boot', () => {
    const k = stubKernel();
    const page: any = { __tabcomputerKernel: k };
    markKernelBaseline(k);
    expect(foreignKernelHooks(page)).toEqual([]);
    k.loaders.unshift('later');
    expect(foreignKernelHooks(page)).toEqual(['1 kernel program loader added since boot']);
  });

  it('runTestBundle restores what its suite changed and records it', async () => {
    const k = stubKernel();
    const savedKernel = g.__tabcomputerKernel;
    g.__tabcomputerKernel = k;
    try {
      const suite = `const { it, expect } = globalThis.__tcTestApi;\n` +
        `it('tampers with the page', () => { globalThis.__tabcomputerKernel.loaders.unshift(function suiteLoader() {}); globalThis.__tabcomputerSuiteThing = 1; expect(1).toBe(1); });\n`;
      const sum = await runTestBundle(suite);
      expect(sum.passed).toBe(1);
      expect(k.loaders).toEqual(['pageLoader']);
      expect('__tabcomputerSuiteThing' in g).toBe(false);
      expect(sum.restored).toEqual(expect.arrayContaining(['global __tabcomputerSuiteThing added', 'kernel loaders: 1 added by the run, removed']));
      expect(lastTestLeftovers()?.changed).toEqual(sum.restored);
    } finally {
      if (savedKernel === undefined) delete g.__tabcomputerKernel; else g.__tabcomputerKernel = savedKernel;
      delete g.__tabcomputerTestLeftovers;
    }
  });
});

describe('getKernel and the page global (#47)', () => {
  it("returns the page's published kernel, and never publishes its own", () => {
    const hadWindow = 'window' in g;
    const w = hadWindow ? g.window : (g.window = {});
    const saved = w.__tabcomputerKernel;
    delete w.__tabcomputerKernel;
    try {
      const own = getKernel();
      expect(own).toBeTruthy();
      expect(w.__tabcomputerKernel).toBeUndefined(); // (it used to set it: a suite's copy became the page's)
      const page = { page: true };
      w.__tabcomputerKernel = page;
      expect(getKernel()).toBe(page);
    } finally {
      if (saved === undefined) delete w.__tabcomputerKernel; else w.__tabcomputerKernel = saved;
      if (!hadWindow) delete g.window;
    }
  });
});

describe('swapping a lazy command the page never loaded (#47)', () => {
  it('loads it the page way, patches the cached command, and reverts', async () => {
    const key = 'src/commands/hs-lazy-never.ts';
    liveLoaders().set(key, async () => { const ns = { neverCmd: { name: 'hn', description: 'v1', async exec() { return 1; } } }; registerLive(key, ns); return ns; });
    const lazy = lazyCommand('hn', 'lazy', async () => (await liveImport(key)).neverCmd as any);
    const mgr = new HotswapManager();
    try {
      expect(liveModules().has(key)).toBe(false); // never run, never loaded
      const fs = memFs({ [`/co/${key}`]: `export const neverCmd = { name: 'hn', description: 'v2', async exec() { return 2; } };\n` });
      const out = await buildSwap(fs, { root: '/co', files: [key], build: esbuild.build as any });
      mgr.apply(await evalBundle(out.code));
      expect(await lazy.exec({} as any)).toBe(2); // its first run gets the swapped command
      mgr.revert(true);
      expect(await lazy.exec({} as any)).toBe(1);
    } finally {
      mgr.revert(true);
      liveLoaders().delete(key);
      liveModules().delete(key);
    }
  });
});
