/**
 * tabcomputer#106: `hotswap test` takes vitest's options object for describe
 * and it: `describe(name, { timeout }, fn)` (six fs suites failed to load
 * with "f is not a function"), `it(name, { timeout }, fn)`, and the older
 * `it(name, fn, { timeout })` and `it(name, fn, timeout)`.
 */
import { describe, it, expect } from 'vitest';
import { runTestBundle } from '@shiro/hotswap/test-runner';

const API = `const { describe, it, test, expect } = globalThis.__tcTestApi;\nconst sleep = (ms) => new Promise((r) => setTimeout(r, ms));\n`;
const run = async (body: string) => {
  const sum = await runTestBundle(API + body);
  return { lines: sum.results.map((r) => `${r.status} ${r.name}${r.error ? ': ' + r.error.split('\n')[0] : ''}`), errors: sum.errors };
};

describe('hotswap test: options objects (#106)', () => {
  it('describe(name, { timeout }, fn) loads, and its tests get the timeout', async () => {
    const r = await run(`
describe('slow fs', { timeout: 40 }, () => {
  it('quick', () => { expect(1).toBe(1); });
  it('too slow for the suite', async () => { await sleep(300); });
  it('its own timeout wins', { timeout: 2000 }, async () => { await sleep(120); });
  describe('nested', () => { it('inherits', async () => { await sleep(300); }); });
});
`);
    expect(r.errors).toEqual([]);
    expect(r.lines[0]).toBe('pass slow fs > quick');
    expect(r.lines[1]).toMatch(/^fail slow fs > too slow for the suite: .*40 ?ms/);
    expect(r.lines[2]).toBe('pass slow fs > its own timeout wins');
    expect(r.lines[3]).toMatch(/^fail slow fs > nested > inherits: /);
  });

  it('it(name, options, fn), it(name, fn, options) and it(name, fn, timeout)', async () => {
    const r = await run(`
it('options first', { timeout: 40 }, async () => { await sleep(300); });
it('options last', async () => { await sleep(300); }, { timeout: 40 });
it('a number', async () => { await sleep(300); }, 40);
test.each([1, 2])('each %d', { timeout: 40 }, async (n) => { await sleep(n === 1 ? 1 : 300); });
`);
    expect(r.errors).toEqual([]);
    expect(r.lines.map((l) => l.replace(/: .*/, ''))).toEqual(['fail options first', 'fail options last', 'fail a number', 'pass each 1', 'fail each 2']);
  });

  it('skip, todo and fails as options', async () => {
    const r = await run(`
describe('off', { skip: true }, () => { it('never runs', () => { throw new Error('ran'); }); });
it('skipped', { skip: true }, () => { throw new Error('ran'); });
it('later', { todo: true }, () => { throw new Error('ran'); });
it('known bad', { fails: true }, () => { throw new Error('as expected'); });
it('runs', { skip: false }, () => {});
`);
    expect(r.errors).toEqual([]);
    expect(r.lines).toEqual(['skip off > never runs', 'skip skipped', 'todo later', 'pass known bad', 'pass runs']);
  });
});
