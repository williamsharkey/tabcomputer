import { describe, it, expect, afterEach } from 'vitest';
import { createProcessGlobal, WORKER_ONLY_GLOBALS } from '@shiro/node-compat/process-global';

// node as a kernel guest runs in a Web Worker: the worker's own globals aren't node's
// (Prism, in Astro, took the guest for a Web Worker and listened to its messages)
describe('a guest process global hides the Worker globals', () => {
  const g = globalThis as any;
  afterEach(() => { delete g.self; delete g.WorkerGlobalScope; delete g.addEventListener; });
  it('self and WorkerGlobalScope as absent, while the rest reads through, and a script may still set them', () => {
    g.self = g; g.WorkerGlobalScope = function WorkerGlobalScope() {}; g.addEventListener = () => {};
    const pg = createProcessGlobal({ process: { pid: 1 } }, WORKER_ONLY_GLOBALS);
    expect([typeof pg.self, typeof pg.WorkerGlobalScope, typeof pg.addEventListener, 'self' in pg, Object.keys(pg).includes('self')]).toEqual(['undefined', 'undefined', 'function', false, false]);
    expect(pg.process.pid).toBe(1);
    expect(typeof pg.setTimeout).toBe('function');
    pg.self = 5;
    expect(pg.self).toBe(5);
    // (without the list, as in the page, they read through; addEventListener and
    // postMessage always do: a script may set its own, emnapi's thread workers)
    expect(typeof createProcessGlobal({}).self).toBe('object');
  });
});
