/**
 * The page's kept Blink modules (src/x86-engine/blink.ts): when a program's
 * modules outgrow the budget, rerunning it keeps part of them rather than
 * evicting each just before it is needed, and a new program's modules still
 * get in for its next run. Under Node the budget is 4 MiB.
 */
import { describe, it, expect } from 'vitest';
import { keepCompiledModuleForTest as keep, keptCompiledModules as kept } from '@shiro/x86-engine/blink';

const SIZE = 64 * 1024;  // 64 of them fill 4 MiB
const run = (prog: string, n: number) => { for (let i = 0; i < n; i++) keep(`${prog}${i}`, SIZE); };
const hits = (prog: string, n: number) => Array.from({ length: n }, (_, i) => kept(`${prog}${i}`).has).filter(Boolean).length;

describe('Blink: the page keeps compiled modules', () => {
  it('a program twice the budget keeps part of its modules across runs; a new program still gets in', () => {
    run('big', 128);
    expect(kept().bytes).toBeLessThanOrEqual(4 << 20);
    run('big', 128);
    // most recent first would leave the second half, which the next run evicts before using
    const first = hits('big', 64);
    expect(first).toBeGreaterThan(32);
    run('big', 128);
    expect(hits('big', 64)).toBe(first);  // the same ones stay
    expect(kept().bytes).toBeLessThanOrEqual(4 << 20);
    // a program never run before gets in on its first run
    run('small', 16);
    expect(hits('small', 16)).toBe(16);
    expect(kept().bytes).toBeLessThanOrEqual(4 << 20);
  });

  it('memory pressure shrinks them to 2 MiB', () => {
    run('more', 64);
    expect(kept().bytes).toBeGreaterThan(2 << 20);
    keep('pressed', SIZE, true);
    expect(kept().bytes).toBeLessThanOrEqual(2 << 20);
    expect(kept('pressed').has).toBe(true);
    keep('relieved', SIZE, false);
  });
});
