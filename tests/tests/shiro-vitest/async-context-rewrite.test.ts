import { describe, it, expect } from 'vitest';
import { carryAsyncContext } from '@shiro/node-compat/async-context';

// The rewrite that carries AsyncLocalStorage's store across await (async-context.ts)
describe('carryAsyncContext', () => {
  it('rewrites awaits and direct evals, not methods, accessors or functions named await or eval', () => {
    const src = 'class A { get await() { return 1 } eval(x) { return x } static await(y) {} async eval() {} }\n'
      + 'const o = { await: 1, eval(c) { return c } };\n'
      + 'async function f() { await (x); await g(); eval(y); obj.eval(z); (0, eval)(w); }';
    const out = carryAsyncContext(src);
    expect(out).toBe('class A { get await() { return 1 } eval(x) { return x } static await(y) {} async eval() {} }\n'
      + 'const o = { await: 1, eval(c) { return c } };\n'
      + 'async function f() { __shiroAls.r(__shiroAls.c(), await (x)); __shiroAls.r(__shiroAls.c(), await g()); eval(__shiroAls.e(y)); obj.eval(z); (0, eval)(w); }');
    // (rollup 4's dist/shared/rollup.js has `get await()`: the rewrite was a syntax error, and astro build failed)
    expect(() => new Function(out)).not.toThrow();
  });

  it('leaves `await using` declarations alone; `await using(…)` is still an await', () => {
    // (native Claude Code's bundle: `async function oA(e,n){await using r=…`; the rewrite
    // made it `__shiroAls.r(__shiroAls.c(), await using) r=…`, a syntax error)
    const src = 'async function f(e) { await using r = open(e); for (await using x of xs) {} await using(e); await using.y; await using\n  in o; }';
    expect(carryAsyncContext(src)).toBe('async function f(e) { await using r = open(e); for (await using x of xs) {} '
      + '__shiroAls.r(__shiroAls.c(), await using(e)); __shiroAls.r(__shiroAls.c(), await using.y); __shiroAls.r(__shiroAls.c(), await using)\n  in o; }');
  });
});
