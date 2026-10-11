/**
 * What jest needs from node-compat (audit 5: jest 29 failed every test file with
 * `process is not defined`, and every run after the first with "object is not
 * iterable"; jest 30 asked for ts-node to read jest.config.ts):
 * - vm.runInContext keeps working when the context has an `eval` of its own
 *   (jest copies the host's globals onto its context; node-compat's
 *   globalThis.eval isn't the intrinsic, so the with-scope's eval was indirect);
 * - v8.serialize/deserialize keep Map, Set and the rest (jest's haste-map cache);
 * - process.features.typescript is 'strip', as node 22.18+/23.6+.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { createTestShell, run } from './helpers';
import type { Shell } from '@shiro/shell';

let shell: Shell;
beforeAll(async () => { ({ shell } = await createTestShell()); });
const node = async (code: string) => (await run(shell, `node -e '${code}' < /dev/null`)).output.replace(/\r\n/g, '\n').trim();

describe('vm contexts with the host globals copied in (jest-environment-node)', () => {
  it('code still sees the context when the context has its own eval', async () => {
    expect(await node(`const vm = require("vm"); const c = vm.createContext({ p: 1 }); Object.defineProperty(c, "eval", { get: () => globalThis.eval, enumerable: true, configurable: true }); console.log(vm.runInContext("typeof p", c), vm.runInContext("p + 1", c));`)).toBe('number 2');
  });

  it("a module wrapper compiled in the context sees the context's globals, and eval inside it too", async () => {
    expect(await node(`const vm = require("vm"); const c = vm.createContext(); const g = vm.runInContext("this", c); g.process = { env: { A: "x" } }; g.eval = globalThis.eval; const w = new vm.Script("({f: function () { return [process.env.A, eval(\\"typeof process\\"), globalThis === this] }})").runInContext(c); console.log(JSON.stringify(w.f.call(g)));`))
      .toBe('["x","object",true]');
  });
});

describe('v8.serialize / deserialize', () => {
  it('keep Map, Set, Date, BigInt, typed arrays and cycles', async () => {
    expect(await node(`const v8 = require("v8"); const o = { m: new Map([["a", new Set([1, 2])]]), d: new Date(5), b: 7n, u: new Uint8Array([1, 2]), n: undefined }; o.self = o; const r = v8.deserialize(v8.serialize(o)); console.log(r.m instanceof Map, r.m.get("a") instanceof Set, r.m.get("a").has(2), r.d instanceof Date && r.d.getTime(), typeof r.b, r.u instanceof Uint8Array && r.u[1], "n" in r, r.self === r);`))
      .toBe('true true true 5 bigint 2 true true');
  });

  it('a function throws DataCloneError, as node', async () => {
    expect(await node(`try { require("v8").serialize({ f() {} }); console.log("no error"); } catch (e) { console.log(e.name); }`)).toBe('DataCloneError');
  });
});

describe('process.features.typescript', () => {
  it("is 'strip', as node 22.18+/23.6+", async () => {
    expect(await node(`console.log(process.features.typescript)`)).toBe('strip');
  });
});
