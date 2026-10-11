/**
 * claude --vm's code cache (src/claude-vm/code-cache.ts, sw-host.ts,
 * public/vm-sw.js): the service worker answers /__vm/ and nothing else (with
 * the browser's static routes or without), its off switch, and every way a
 * launch falls back to requiring bundle.js. In the browser:
 * tests/browser/claude-vm-codecache.mjs.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadCompiled, moduleSource } from '@shiro/claude-vm/code-cache';
import { ensureVmServiceWorker, type SwDeps } from '@shiro/claude-vm/sw-host';

const SW_SOURCE = readFileSync(resolve(__dirname, '../../../public/vm-sw.js'), 'utf8');
const ORIGIN = 'https://tabcomputer.example';

/** A CacheStorage with one Map per cache */
function fakeCaches() {
  const stores = new Map<string, Map<string, Response>>();
  const open = async (name: string) => {
    const m = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, m);
    const key = (r: RequestInfo | URL) => typeof r === 'string' ? r : r instanceof URL ? r.href : r.url;
    return {
      match: async (r: RequestInfo | URL) => m.get(key(r))?.clone(),
      put: async (r: RequestInfo | URL, res: Response) => { m.set(key(r), res); },
      delete: async (r: RequestInfo | URL) => m.delete(key(r)),
      keys: async () => [...m.keys()].map((url) => ({ url })),
    };
  };
  return { stores, api: { open, delete: async (n: string) => stores.delete(n), has: async (n: string) => stores.has(n), keys: async () => [...stores.keys()] } as any };
}

/** public/vm-sw.js in a stand-in service worker scope: its handlers, and what they did */
function loadSw(source = SW_SOURCE, { routes = true, urlPattern = true } = {}) {
  const handlers: Record<string, (e: any) => void> = {};
  const c = fakeCaches();
  const self = {
    location: { origin: ORIGIN },
    addEventListener: (t: string, f: (e: any) => void) => { handlers[t] = f; },
    skipWaiting: vi.fn(),
    clients: { claim: vi.fn(async () => {}) },
    registration: { unregister: vi.fn(async () => true) },
  };
  const g: any = { self, caches: c.api, Response, URL };
  if (urlPattern) g.URLPattern = class { constructor(public init: unknown) {} };
  new Function(...Object.keys(g), source)(...Object.values(g));
  const fetchEvent = (path: string, mode = 'cors') => {
    const e = { request: { url: new URL(path, ORIGIN).href, mode }, respondWith: vi.fn() };
    handlers.fetch(e);
    return e;
  };
  const install = () => {
    const e: any = { waitUntil: vi.fn() };
    if (routes) e.addRoutes = vi.fn();
    handlers.install(e);
    return e;
  };
  const activate = async () => { let p: Promise<unknown> = Promise.resolve(); handlers.activate({ waitUntil: (x: Promise<unknown>) => { p = x; } }); await p; };
  return { self, caches: c, fetchEvent, install, activate };
}

describe('public/vm-sw.js', () => {
  it('routes everything but /__vm/* past itself where the browser has static routes', () => {
    const sw = loadSw();
    const e = sw.install();
    const [route] = e.addRoutes.mock.calls[0][0];
    expect(route.source).toBe('network');
    expect(route.condition.not.urlPattern.init).toEqual({ pathname: '/__vm/*' });
  });

  for (const env of [{ routes: true, urlPattern: true }, { routes: false, urlPattern: true }, { routes: false, urlPattern: false }]) {
    it(`answers no request outside /__vm/ (static routes ${env.routes ? 'on' : 'off'}, URLPattern ${env.urlPattern ? 'on' : 'off'})`, () => {
      const sw = loadSw(SW_SOURCE, env);
      expect(() => sw.install()).not.toThrow();
      for (const [p, mode] of [['/', 'navigate'], ['/?ui=terminal', 'navigate'], ['/assets/index-abc.js', 'cors'], ['/vm-sw.js', 'cors'], ['/api/anthropic/v1/messages', 'cors'], ['/__preview/p/3000/', 'navigate'], ['/__vmx/a', 'cors'], ['https://other.example/__vm/probe.mjs', 'cors']]) {
        expect(sw.fetchEvent(p, mode).respondWith, p).not.toHaveBeenCalled();
      }
    });
  }

  it('answers the probe, and a layout from its cache or with a 404', async () => {
    const sw = loadSw();
    const probe = sw.fetchEvent('/__vm/probe.mjs');
    expect(await (await probe.respondWith.mock.calls[0][0]).text()).toContain("export default 'tabcomputer-vm'");
    await (await sw.caches.api.open('tabcomputer-vm')).put(`${ORIGIN}/__vm/abc/nc-1/bundle.mjs`, new Response('export default 1'));
    const hit = await sw.fetchEvent('/__vm/abc/nc-1/bundle.mjs').respondWith.mock.calls[0][0];
    expect(await hit.text()).toBe('export default 1');
    const miss = await sw.fetchEvent('/__vm/abc/nc-2/bundle.mjs').respondWith.mock.calls[0][0];
    expect(miss.status).toBe(404);
  });

  it('ENABLED = false: answers nothing, and retires itself and its cache when it activates', async () => {
    const sw = loadSw(SW_SOURCE.replace('const ENABLED = true;', 'const ENABLED = false;'));
    await (await sw.caches.api.open('tabcomputer-vm')).put('x', new Response(''));
    expect(sw.install().addRoutes).not.toHaveBeenCalled();
    expect(sw.fetchEvent('/__vm/probe.mjs').respondWith).not.toHaveBeenCalled();
    await sw.activate();
    expect(sw.self.registration.unregister).toHaveBeenCalled();
    expect(sw.caches.stores.has('tabcomputer-vm')).toBe(false);
    expect(sw.self.clients.claim).not.toHaveBeenCalled();
  });
});

/** sw-host's world: a service worker container, /vm-sw.js as the server has it */
function host({ script = SW_SOURCE as string | null, controlled = false, claims = true, registerFails = false } = {}) {
  const listeners = new Set<() => void>();
  const regs = [
    { active: { scriptURL: `${ORIGIN}/preview-sw.js` }, unregister: vi.fn(async () => true) },
    { active: { scriptURL: `${ORIGIN}/vm-sw.js` }, unregister: vi.fn(async () => true) },
  ];
  const c = fakeCaches();
  const sw: any = {
    controller: controlled ? {} : null,
    register: vi.fn(async () => {
      if (registerFails) throw new Error('SecurityError');
      if (claims) setTimeout(() => { sw.controller = {}; listeners.forEach((f) => f()); }, 5);
      return {};
    }),
    getRegistrations: async () => regs,
    addEventListener: (_: string, f: () => void) => listeners.add(f),
    removeEventListener: (_: string, f: () => void) => listeners.delete(f),
  };
  const deps: SwDeps = {
    fetch: vi.fn(async () => script === null ? new Response('', { status: 404 }) : new Response(script)) as any,
    serviceWorker: sw, caches: c.api,
  };
  return { deps, sw, regs, caches: c };
}

describe('sw-host: ensureVmServiceWorker', () => {
  it('registers vm-sw.js at / and waits for it to claim the page', async () => {
    const h = host();
    expect(await ensureVmServiceWorker(h.deps, 1000)).toBe(true);
    expect(h.sw.register).toHaveBeenCalledWith('/vm-sw.js', { scope: '/' });
  });

  it('a page it already controls: registered again (the browser checks for an update), no wait', async () => {
    const h = host({ controlled: true, claims: false });
    expect(await ensureVmServiceWorker(h.deps, 1000)).toBe(true);
    expect(h.sw.register).toHaveBeenCalledTimes(1);
  });

  it('falls back when registration fails, or the worker never claims the page in time', async () => {
    expect(await ensureVmServiceWorker(host({ registerFails: true }).deps, 1000)).toBe(false);
    const late = host({ claims: false });
    expect(await ensureVmServiceWorker(late.deps, 20)).toBe(false);
    expect(await ensureVmServiceWorker({ ...host().deps, serviceWorker: undefined }, 20)).toBe(false);
  });

  it('a worker that claims the page after a launch stopped waiting: the next launch uses it', async () => {
    const late = host({ claims: false });
    expect(await ensureVmServiceWorker(late.deps, 10)).toBe(false);
    late.sw.controller = {};
    expect(await ensureVmServiceWorker(late.deps, 10)).toBe(true);
  });

  for (const [what, script] of [['deployed with ENABLED = false', SW_SOURCE.replace('const ENABLED = true;', 'const ENABLED = false;')], ['gone from the server (404)', null], ['answered with the app\'s page instead', '<!doctype html><title>tabcomputer</title>']] as const) {
    it(`the off switch: vm-sw.js ${what} unregisters it and empties its cache, nothing else`, async () => {
      const h = host({ script, controlled: true });
      await (await h.caches.api.open('tabcomputer-vm')).put('x', new Response(''));
      await (await h.caches.api.open('other')).put('y', new Response(''));
      expect(await ensureVmServiceWorker(h.deps, 20)).toBe(false);
      expect(h.sw.register).not.toHaveBeenCalled();
      expect(h.regs[1].unregister).toHaveBeenCalled();
      expect(h.regs[0].unregister).not.toHaveBeenCalled();
      expect([...h.caches.stores.keys()]).toEqual(['other']);
    });
  }
});

describe('code-cache: loadCompiled', () => {
  const DIR = '/home/u/.cache/tabcomputer/claude-vm/abc/nc-1';
  const BASE = `${ORIGIN}/assets/guest-entry.js`;
  const world = (probe: boolean, cachedModules: Record<string, unknown> = {}) => {
    const c = fakeCaches();
    const imported: string[] = [];
    const importUrl = vi.fn(async (href: string) => {
      imported.push(new URL(href).pathname);
      if (href.includes('/__vm/probe.mjs?')) { if (probe) return { default: 'tabcomputer-vm' }; throw new TypeError('Failed to fetch dynamically imported module'); }
      const hit = await (await c.api.open('tabcomputer-vm')).match(href);
      if (!hit) throw new TypeError('Failed to fetch dynamically imported module');
      return cachedModules[href] ?? { default: () => 'ran' };
    });
    return { c, imported, deps: { caches: c.api, importUrl, base: BASE } };
  };

  it('no worker serving /__vm/ to this one (none, or not yet): null, and nothing stored or read', async () => {
    const w = world(false);
    const read = vi.fn(() => 'src');
    expect(await loadCompiled(DIR, read, w.deps)).toBeNull();
    expect(read).not.toHaveBeenCalled();
    expect(w.c.stores.size).toBe(0);
    expect(await loadCompiled(DIR, read, { ...w.deps, caches: undefined })).toBeNull();
  });

  it('probes at a new URL each time (a worker keeps a failed import\'s answer; it may have been taken since)', async () => {
    const w = world(false);
    await loadCompiled(DIR, () => '', w.deps);
    await loadCompiled(DIR, () => '', w.deps);
    const probes = w.deps.importUrl.mock.calls.map((c) => c[0]);
    expect(probes).toHaveLength(2);
    expect(probes[0]).not.toBe(probes[1]);
  });

  it('stores the bundle once, as the module, under its layout (an earlier layout goes), and imports it', async () => {
    const w = world(true);
    await (await w.c.api.open('tabcomputer-vm')).put(`${ORIGIN}/__vm/old/nc-0/bundle.mjs`, new Response(''));
    const read = vi.fn(() => 'module.exports = 1;');
    const fn = await loadCompiled(DIR, read, w.deps);
    expect(fn?.()).toBe('ran');
    const store = w.c.stores.get('tabcomputer-vm')!;
    expect([...store.keys()]).toEqual([`${ORIGIN}/__vm/abc/nc-1/bundle.mjs`]);
    expect(await store.get(`${ORIGIN}/__vm/abc/nc-1/bundle.mjs`)!.clone().text()).toBe(moduleSource('module.exports = 1;'));
    await loadCompiled(DIR, read, w.deps);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('throws when the bundle can\'t be imported (its entry gone): the launcher requires bundle.js', async () => {
    const w = world(true);
    const importUrl = w.deps.importUrl;
    w.deps.importUrl = vi.fn(async (href: string) => {
      if (href.endsWith('bundle.mjs')) await w.c.api.delete('tabcomputer-vm');
      return importUrl(href);
    });
    await expect(loadCompiled(DIR, () => 'x', w.deps)).rejects.toThrow(/Failed to fetch/);
  });
});
