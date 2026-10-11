/**
 * Bun's semver and deepEquals for claude --vm (src/claude-vm/bun/): the expected values are what
 * Bun 1.4.2 returned for the same calls.
 */
import { describe, it, expect } from 'vitest';
import { order, satisfies } from '@shiro/claude-vm/bun/semver';
import { deepEquals } from '@shiro/claude-vm/bun/deep-equals';

describe('Bun.semver', () => {
  it('order: -1, 0, 1 by semver precedence (pre-releases, build metadata, a v prefix)', () => {
    const V = [['1.0.0', '1.0.1'], ['2.0.0', '1.9.9'], ['1.0.0', '1.0.0'], ['1.0.0-alpha', '1.0.0'], ['1.0.0-alpha.1', '1.0.0-alpha.beta'], ['1.10.0', '1.9.0'], ['v1.2.3', '1.2.3'], ['1.2.3+build', '1.2.3']];
    expect(V.map(([a, b]) => order(a, b))).toEqual([-1, 1, 0, -1, -1, 1, 0, 0]);
  });
  it('satisfies: ^ ~ x * ranges, ||, hyphen ranges, comparators', () => {
    const R = [['1.2.3', '^1.0.0'], ['2.0.0', '^1.0.0'], ['1.2.3', '~1.2.0'], ['1.3.0', '~1.2.0'], ['1.2.3', '>=1.2.0 <2'], ['1.2.3', '1.x'], ['1.2.3', '*'], ['1.0.0-beta', '^1.0.0'], ['1.2.3', '1.2.3 || 2.x'], ['2.5.0', '1.2.3 || 2.x'], ['1.2.3', '1.0.0 - 1.5.0'], ['0.2.5', '^0.2.3'], ['0.3.0', '^0.2.3'], ['1.2.3', '>1.2.3'], ['1.2.3', '=1.2.3'], ['2.1.296', '>=2.1.0']];
    expect(R.map(([v, r]) => satisfies(v, r))).toEqual([true, false, true, false, true, true, true, false, true, true, true, true, false, false, true, true]);
  });
});

describe('Bun.deepEquals', () => {
  it('loose and strict, as toEqual and toStrictEqual compare', () => {
    // eslint-disable-next-line no-sparse-arrays
    const E: [unknown, unknown][] = [[{ a: 1 }, { a: 1 }], [{ a: 1, b: undefined }, { a: 1 }], [[1, 2], [1, 2]], [[1, , 3], [1, undefined, 3]], [NaN, NaN], [0, -0], [new Date(1), new Date(1)], [/a/g, /a/g], [new Map([[1, { x: 1 }]]), new Map([[1, { x: 1 }]])], [new Set([1, 2]), new Set([2, 1])], [{ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }], [{ a: 1 }, { a: '1' }], [new Uint8Array([1, 2]), new Uint8Array([1, 2])], [null, undefined], [{}, Object.create(null)], [[1], { 0: 1 }]];
    expect(E.map(([a, b]) => [deepEquals(a, b), deepEquals(a, b, true)])).toEqual([[true, true], [true, false], [true, true], [true, false], [true, true], [false, false], [true, true], [true, true], [true, true], [true, true], [true, true], [false, false], [true, true], [false, false], [true, true], [false, false]]);
  });
  it('cycles', () => {
    const a: any = { x: 1 }; a.self = a;
    const b: any = { x: 1 }; b.self = b;
    expect(deepEquals(a, b)).toBe(true);
  });
});
