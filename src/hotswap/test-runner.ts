/**
 * Run vitest suites in the tab (`hotswap test`, docs/HOTSWAP.md).
 *
 * build.ts buildTest bundles a suite from the checkout; this module gives it
 * the part of vitest's API the suites use (describe/it/test with skip, only,
 * each, skipIf/runIf; hooks; expect with the common matchers, .not,
 * .resolves/.rejects and asymmetric matchers; vi.fn/spyOn/waitFor), and
 * isolated storage: IndexedDB database names get a per-run prefix, and
 * localStorage/sessionStorage live in memory. Tests run one at a time.
 */
import { importCode, quietDuring } from './swap';
import { makeTestNode, type Snapshot } from './test-fs';
import { snapshotPage, restorePage, recordTestLeftovers } from './leftovers';

type Fn = () => unknown;
type Mode = 'run' | 'skip' | 'only' | 'todo';

interface TestCase { kind: 'test'; name: string; fn: Fn | null; mode: Mode; timeout: number; parent: Suite; fails?: boolean }
interface Suite {
  kind: 'suite'; name: string; mode: Mode; parent: Suite | null;
  children: (Suite | TestCase)[];
  beforeAll: Fn[]; afterAll: Fn[]; beforeEach: Fn[]; afterEach: Fn[];
}

export interface TestResult { name: string; status: 'pass' | 'fail' | 'skip' | 'todo'; ms: number; error?: string }
export interface RunSummary {
  results: TestResult[]; passed: number; failed: number; skipped: number; ms: number; errors: string[];
  /** What the suite's module copies had changed in the live page, put back after the run (leftovers.ts, #47) */
  restored?: string[];
}

const DEFAULT_TIMEOUT = 5000;

// ---- formatting and equality -------------------------------------------------

export function fmt(v: unknown, depth = 0): string {
  if (typeof v === 'string') return depth ? JSON.stringify(v) : `'${v.length > 400 ? v.slice(0, 400) + '…' : v}'`;
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
  if (typeof v === 'bigint') return `${v}n`;
  if (typeof v === 'symbol') return v.toString();
  if (v === null || typeof v !== 'object') return String(v);
  if (isAsym(v)) return v.toString();
  if (depth > 3) return Array.isArray(v) ? '[Array]' : '[Object]';
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (v instanceof RegExp || v instanceof Date) return String(v);
  if (Array.isArray(v)) return `[${v.slice(0, 50).map((x) => fmt(x, depth + 1)).join(', ')}${v.length > 50 ? ', …' : ''}]`;
  if (v instanceof Map) return `Map {${[...v].slice(0, 30).map(([k, x]) => `${fmt(k, depth + 1)} => ${fmt(x, depth + 1)}`).join(', ')}}`;
  if (v instanceof Set) return `Set {${[...v].slice(0, 30).map((x) => fmt(x, depth + 1)).join(', ')}}`;
  if (ArrayBuffer.isView(v)) return `${v.constructor.name} [${Array.from(v as any as ArrayLike<number>).slice(0, 50).join(', ')}]`;
  const keys = Object.keys(v);
  return `{${keys.slice(0, 30).map((k) => `${k}: ${fmt((v as any)[k], depth + 1)}`).join(', ')}${keys.length > 30 ? ', …' : ''}}`;
}

interface Asym { asymmetricMatch(other: unknown): boolean; toString(): string; __asym: true }
function isAsym(v: unknown): v is Asym { return !!v && typeof v === 'object' && (v as any).__asym === true; }
function asym(name: string, match: (o: unknown) => boolean): Asym {
  return { __asym: true, asymmetricMatch: match, toString: () => name };
}

export function equals(a: unknown, b: unknown, strict = false, seen = new Map<object, object>()): boolean {
  if (isAsym(b)) return b.asymmetricMatch(a);
  if (isAsym(a)) return a.asymmetricMatch(b);
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || !a || !b) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (strict && Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof RegExp || b instanceof RegExp) return String(a) === String(b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !equals(v, b.get(k), strict, seen)) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    outer: for (const x of a) {
      if (b.has(x)) continue;
      for (const y of b) if (equals(x, y, strict, seen)) continue outer;
      return false;
    }
    return true;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b)) return false;
    const x = a as any as ArrayLike<number>, y = b as any as ArrayLike<number>;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }
  const own = (o: object) => Object.keys(o).filter((k) => strict || (o as any)[k] !== undefined);
  const ka = own(a), kb = own(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !equals((a as any)[k], (b as any)[k], strict, seen)) return false;
  return true;
}

function matchesObject(actual: unknown, expected: unknown): boolean {
  if (isAsym(expected)) return expected.asymmetricMatch(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && actual.length === expected.length && expected.every((e, i) => matchesObject(actual[i], e));
  if (expected && typeof expected === 'object' && !(expected instanceof Date) && !(expected instanceof RegExp)) {
    if (!actual || typeof actual !== 'object') return false;
    return Object.keys(expected).every((k) => k in (actual as object) && matchesObject((actual as any)[k], (expected as any)[k]));
  }
  return equals(actual, expected);
}

export class AssertionError extends Error {
  constructor(message: string) { super(message); this.name = 'AssertionError'; }
}

// ---- expect ----------------------------------------------------------------------

function typeOf(v: unknown): string { return v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v; }

function makeMatchers(actual: unknown, negate: boolean, wrap: 'none' | 'resolves' | 'rejects'): any {
  const check = (pass: boolean, msg: string, notMsg: string) => {
    if (pass === negate) throw new AssertionError(negate ? notMsg : msg);
  };
  const thrown = (fn: unknown): { threw: boolean; error: unknown } => {
    if (wrap === 'rejects') return { threw: true, error: fn };
    if (typeof fn !== 'function') throw new AssertionError(`expected a function, got ${fmt(fn)}`);
    try { (fn as Fn)(); return { threw: false, error: undefined }; } catch (e) { return { threw: true, error: e }; }
  };
  const errMatches = (error: unknown, expected: unknown): boolean => {
    if (expected === undefined) return true;
    const msg = error instanceof Error ? error.message : String(error);
    if (typeof expected === 'string') return msg.includes(expected);
    if (expected instanceof RegExp) return expected.test(msg);
    if (typeof expected === 'function') return error instanceof (expected as any);
    if (expected instanceof Error) return msg === expected.message;
    return matchesObject(error, expected);
  };
  const A = fmt(actual);
  const m: Record<string, (...a: any[]) => void> = {
    toBe: (e) => check(Object.is(actual, e), `expected ${A} to be ${fmt(e)}`, `expected ${A} not to be ${fmt(e)}`),
    toEqual: (e) => check(equals(actual, e), `expected ${A} to deeply equal ${fmt(e)}`, `expected ${A} not to deeply equal ${fmt(e)}`),
    toStrictEqual: (e) => check(equals(actual, e, true), `expected ${A} to strictly equal ${fmt(e)}`, `expected ${A} not to strictly equal ${fmt(e)}`),
    toContain: (e) => check(
      typeof actual === 'string' ? actual.includes(String(e)) : !!actual && typeof (actual as any)[Symbol.iterator] === 'function' && [...(actual as any)].includes(e),
      `expected ${A} to contain ${fmt(e)}`, `expected ${A} not to contain ${fmt(e)}`),
    toContainEqual: (e) => check(Array.from(actual as any).some((x) => equals(x, e)), `expected ${A} to contain an item equal to ${fmt(e)}`, `expected ${A} not to contain an item equal to ${fmt(e)}`),
    toMatch: (e) => check(typeof actual === 'string' && (typeof e === 'string' ? actual.includes(e) : (e as RegExp).test(actual)), `expected ${A} to match ${fmt(e)}`, `expected ${A} not to match ${fmt(e)}`),
    toMatchObject: (e) => check(matchesObject(actual, e), `expected ${A} to match object ${fmt(e)}`, `expected ${A} not to match object ${fmt(e)}`),
    toBeGreaterThan: (e) => check((actual as any) > e, `expected ${A} to be greater than ${fmt(e)}`, `expected ${A} not to be greater than ${fmt(e)}`),
    toBeGreaterThanOrEqual: (e) => check((actual as any) >= e, `expected ${A} to be >= ${fmt(e)}`, `expected ${A} not to be >= ${fmt(e)}`),
    toBeLessThan: (e) => check((actual as any) < e, `expected ${A} to be less than ${fmt(e)}`, `expected ${A} not to be less than ${fmt(e)}`),
    toBeLessThanOrEqual: (e) => check((actual as any) <= e, `expected ${A} to be <= ${fmt(e)}`, `expected ${A} not to be <= ${fmt(e)}`),
    toBeCloseTo: (e, digits = 2) => check(Math.abs((actual as number) - e) < 10 ** -digits / 2, `expected ${A} to be close to ${e}`, `expected ${A} not to be close to ${e}`),
    toBeDefined: () => check(actual !== undefined, `expected ${A} to be defined`, `expected ${A} to be undefined`),
    toBeUndefined: () => check(actual === undefined, `expected ${A} to be undefined`, `expected ${A} to be defined`),
    toBeNull: () => check(actual === null, `expected ${A} to be null`, `expected ${A} not to be null`),
    toBeNaN: () => check(Number.isNaN(actual), `expected ${A} to be NaN`, `expected ${A} not to be NaN`),
    toBeTruthy: () => check(!!actual, `expected ${A} to be truthy`, `expected ${A} not to be truthy`),
    toBeFalsy: () => check(!actual, `expected ${A} to be falsy`, `expected ${A} not to be falsy`),
    toBeTypeOf: (t) => check(typeof actual === t, `expected ${A} to be of type ${t}`, `expected ${A} not to be of type ${t}`),
    toBeInstanceOf: (c) => check(actual instanceof c, `expected ${A} to be an instance of ${c?.name}`, `expected ${A} not to be an instance of ${c?.name}`),
    toHaveLength: (n) => check((actual as any)?.length === n, `expected ${A} to have length ${n} (got ${(actual as any)?.length})`, `expected ${A} not to have length ${n}`),
    toHaveProperty: (p, ...v) => {
      const parts = Array.isArray(p) ? p : String(p).split('.');
      let o: any = actual, has = true;
      for (const k of parts) { if (o != null && k in Object(o)) o = o[k]; else { has = false; break; } }
      const pass = has && (v.length === 0 || equals(o, v[0]));
      check(pass, `expected ${A} to have property ${String(p)}${v.length ? ` = ${fmt(v[0])}` : ''}`, `expected ${A} not to have property ${String(p)}`);
    },
    toThrow: (e?) => {
      const t = thrown(actual);
      check(t.threw && errMatches(t.error, e), `expected to throw${e !== undefined ? ` ${fmt(e)}` : ''}${t.threw ? `, threw ${fmt(t.error)}` : ''}`, `expected not to throw${t.threw ? `, threw ${fmt(t.error)}` : ''}`);
    },
    toHaveBeenCalled: () => check(calls(actual).length > 0, 'expected the spy to have been called', `expected the spy not to have been called (${calls(actual).length} calls)`),
    toHaveBeenCalledTimes: (n) => check(calls(actual).length === n, `expected ${n} calls, got ${calls(actual).length}`, `expected not ${n} calls`),
    toHaveBeenCalledWith: (...args) => check(calls(actual).some((c) => equals(c, args)), `expected a call with ${fmt(args)}; calls: ${fmt(calls(actual))}`, `expected no call with ${fmt(args)}`),
    toHaveBeenLastCalledWith: (...args) => check(equals(calls(actual).at(-1), args), `expected the last call to be ${fmt(args)}; got ${fmt(calls(actual).at(-1))}`, `expected the last call not to be ${fmt(args)}`),
    toHaveReturnedWith: (v) => check((actual as any)?.mock?.results?.some((r: any) => equals(r.value, v)), `expected a return of ${fmt(v)}`, `expected no return of ${fmt(v)}`),
    toSatisfy: (pred) => check(!!pred(actual), `expected ${A} to satisfy the predicate`, `expected ${A} not to satisfy the predicate`),
    toBeOneOf: (list) => check(list.some((x: unknown) => equals(actual, x)), `expected ${A} to be one of ${fmt(list)}`, `expected ${A} not to be one of ${fmt(list)}`),
  };
  m.toThrowError = m.toThrow;
  m.toBeCalled = m.toHaveBeenCalled;
  m.toBeCalledTimes = m.toHaveBeenCalledTimes;
  m.toBeCalledWith = m.toHaveBeenCalledWith;
  return m;
}

function calls(spy: unknown): unknown[][] {
  const c = (spy as any)?.mock?.calls;
  if (!Array.isArray(c)) throw new AssertionError(`${fmt(spy)} is not a spy (vi.fn / vi.spyOn)`);
  return c;
}

function makeExpect() {
  const expect: any = (actual: unknown, _message?: string) => {
    const base = makeMatchers(actual, false, 'none');
    base.not = makeMatchers(actual, true, 'none');
    const settle = (kind: 'resolves' | 'rejects') => {
      const wrapAll = (negate: boolean) => new Proxy({}, {
        get: (_t, name: string) => async (...args: unknown[]) => {
          let value: unknown, rejected = false;
          try { value = await actual; } catch (e) { value = e; rejected = true; }
          if (kind === 'resolves' && rejected) throw new AssertionError(`expected the promise to resolve, it rejected with ${fmt(value)}`);
          if (kind === 'rejects' && !rejected) throw new AssertionError(`expected the promise to reject, it resolved with ${fmt(value)}`);
          return makeMatchers(value, negate, kind)[name](...args);
        },
      });
      const p: any = wrapAll(false);
      return new Proxy(p, { get: (t, k) => (k === 'not' ? wrapAll(true) : t[k]) });
    };
    Object.defineProperty(base, 'resolves', { get: () => settle('resolves') });
    Object.defineProperty(base, 'rejects', { get: () => settle('rejects') });
    return base;
  };
  expect.any = (c: any) => asym(`Any<${c?.name}>`, (o) => (c === String ? typeof o === 'string' : c === Number ? typeof o === 'number' : c === Boolean ? typeof o === 'boolean' : c === Function ? typeof o === 'function' : c === Object ? o !== null && typeof o === 'object' : o instanceof c));
  expect.anything = () => asym('Anything', (o) => o != null);
  expect.stringContaining = (s: string) => asym(`StringContaining ${fmt(s)}`, (o) => typeof o === 'string' && o.includes(s));
  expect.stringMatching = (r: RegExp | string) => asym(`StringMatching ${fmt(r)}`, (o) => typeof o === 'string' && (typeof r === 'string' ? o.includes(r) : r.test(o)));
  expect.objectContaining = (e: object) => asym(`ObjectContaining ${fmt(e)}`, (o) => matchesObject(o, e));
  expect.arrayContaining = (e: unknown[]) => asym(`ArrayContaining ${fmt(e)}`, (o) => Array.isArray(o) && e.every((x) => o.some((y) => equals(y, x))));
  expect.assertions = () => {};
  expect.hasAssertions = () => {};
  return expect;
}

// ---- vi --------------------------------------------------------------------------

function makeVi(restorers: (() => void)[]) {
  const fn = (impl?: (...a: any[]) => any): any => {
    let current = impl;
    const once: ((...a: any[]) => any)[] = [];
    const mock = { calls: [] as unknown[][], results: [] as { type: string; value: unknown }[], instances: [] as unknown[] };
    const spy: any = function (this: unknown, ...args: unknown[]) {
      mock.calls.push(args);
      mock.instances.push(this);
      const f = once.shift() ?? current;
      try {
        const value = f ? f.apply(this, args) : undefined;
        mock.results.push({ type: 'return', value });
        return value;
      } catch (e) { mock.results.push({ type: 'throw', value: e }); throw e; }
    };
    spy.mock = mock;
    spy._isMockFunction = true;
    spy.mockImplementation = (f: any) => { current = f; return spy; };
    spy.mockImplementationOnce = (f: any) => { once.push(f); return spy; };
    spy.mockReturnValue = (v: unknown) => spy.mockImplementation(() => v);
    spy.mockReturnValueOnce = (v: unknown) => spy.mockImplementationOnce(() => v);
    spy.mockResolvedValue = (v: unknown) => spy.mockImplementation(() => Promise.resolve(v));
    spy.mockRejectedValue = (v: unknown) => spy.mockImplementation(() => Promise.reject(v));
    spy.mockClear = () => { mock.calls.length = 0; mock.results.length = 0; mock.instances.length = 0; return spy; };
    spy.mockReset = () => { spy.mockClear(); current = undefined; once.length = 0; return spy; };
    spy.mockRestore = () => spy.mockReset();
    spy.getMockName = () => 'vi.fn()';
    return spy;
  };
  const unsupported = (name: string) => () => { throw new Error(`vi.${name} isn't supported by the tab's test runner`); };
  return {
    fn,
    spyOn(obj: any, key: string, access?: 'get' | 'set') {
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      const orig = access ? (desc as any)?.[access] : obj[key];
      const spy = fn(typeof orig === 'function' ? function (this: unknown, ...a: unknown[]) { return orig.apply(this, a); } : undefined);
      if (access) Object.defineProperty(obj, key, { ...desc, configurable: true, [access]: spy });
      else obj[key] = spy;
      const restore = () => { if (desc) Object.defineProperty(obj, key, desc); else delete obj[key]; };
      spy.mockRestore = () => { restore(); return spy; };
      restorers.push(restore);
      return spy;
    },
    isMockFunction: (f: any) => !!f?._isMockFunction,
    restoreAllMocks() { while (restorers.length) restorers.pop()!(); },
    clearAllMocks() {},
    resetAllMocks() {},
    async waitFor<T>(cb: () => T | Promise<T>, opts: number | { timeout?: number; interval?: number } = {}) {
      const { timeout = 1000, interval = 50 } = typeof opts === 'number' ? { timeout: opts } : opts;
      const end = Date.now() + timeout;
      for (;;) {
        try { return await cb(); } catch (e) { if (Date.now() > end) throw e; }
        await new Promise((r) => setTimeout(r, interval));
      }
    },
    useFakeTimers: unsupported('useFakeTimers'),
    useRealTimers() {},
    mock: unsupported('mock'),
    stubGlobal(name: string, value: unknown) {
      const had = Object.prototype.hasOwnProperty.call(globalThis, name), old = (globalThis as any)[name];
      (globalThis as any)[name] = value;
      restorers.push(() => { if (had) (globalThis as any)[name] = old; else delete (globalThis as any)[name]; });
    },
    unstubAllGlobals() {},
  };
}

// ---- node:path and node:os for suites ----------------------------------------------

function normalizePath(p: string): string {
  const abs = p.startsWith('/');
  const out: string[] = [];
  for (const part of p.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else if (!abs) out.push('..'); } else out.push(part);
  }
  const s = (abs ? '/' : '') + out.join('/');
  return s || (abs ? '/' : '.');
}

export const testPath: any = {
  sep: '/', delimiter: ':',
  normalize: normalizePath,
  isAbsolute: (p: string) => p.startsWith('/'),
  join: (...parts: string[]) => normalizePath(parts.filter(Boolean).join('/') || '.'),
  resolve: (...parts: string[]) => {
    let r = '';
    for (let i = parts.length - 1; i >= 0 && !r.startsWith('/'); i--) if (parts[i]) r = parts[i] + (r ? '/' + r : '');
    return normalizePath(r.startsWith('/') ? r : `/home/user/${r}`);
  },
  dirname: (p: string) => { const n = normalizePath(p); const i = n.lastIndexOf('/'); return i < 0 ? '.' : i === 0 ? '/' : n.slice(0, i); },
  basename: (p: string, ext?: string) => { const b = normalizePath(p).split('/').pop() ?? ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
  extname: (p: string) => { const b = testPath.basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; },
  relative: (from: string, to: string) => {
    const a = testPath.resolve(from).split('/').filter(Boolean), b = testPath.resolve(to).split('/').filter(Boolean);
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/');
  },
};
testPath.posix = testPath;
testPath.default = testPath;

export const testOs: any = {
  tmpdir: () => '/tmp', homedir: () => '/home/user', platform: () => 'linux', type: () => 'Linux',
  arch: () => 'x64', EOL: '\n', hostname: () => 'tabcomputer', cpus: () => [{ model: 'tabcomputer' }],
};
testOs.default = testOs;

// ---- isolated storage ------------------------------------------------------------

export const TEST_DB_PREFIX = 'tabcomputer-test-';

class MemoryStorage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(String(k), String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

function isolatedEnv(runId: string) {
  const real: IDBFactory | undefined = (globalThis as any).indexedDB;
  const prefix = `${TEST_DB_PREFIX}${runId}:`;
  const indexedDB = real && {
    open: (name: string, version?: number) => (version === undefined ? real.open(prefix + name) : real.open(prefix + name, version)),
    deleteDatabase: (name: string) => real.deleteDatabase(prefix + name),
    cmp: (a: unknown, b: unknown) => real.cmp(a, b),
    databases: async () => ((await real.databases?.()) ?? [])
      .filter((d) => d.name?.startsWith(prefix)).map((d) => ({ ...d, name: d.name!.slice(prefix.length) })),
  };
  return { indexedDB, localStorage: new MemoryStorage(), sessionStorage: new MemoryStorage() };
}

/** Delete test databases (this run's, and any a crashed run left) without waiting on open connections */
async function dropTestDatabases(): Promise<void> {
  const real: IDBFactory | undefined = (globalThis as any).indexedDB;
  if (!real?.databases) return;
  const dbs = await real.databases().catch(() => []);
  for (const d of dbs) if (d.name?.startsWith(TEST_DB_PREFIX)) real.deleteDatabase(d.name);
}

// ---- collecting and running -------------------------------------------------------

function makeApi(rootSuite: Suite, restorers: (() => void)[]) {
  let current = rootSuite;
  const addSuite = (name: string, fn: Fn | undefined, mode: Mode) => {
    const s: Suite = { kind: 'suite', name: String(name), mode, parent: current, children: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
    current.children.push(s);
    const prev = current;
    current = s;
    try {
      const r = fn?.();
      if (r && typeof (r as any).then === 'function') throw new Error(`describe('${name}') callback must not be async`);
    } finally { current = prev; }
  };
  const addTest = (name: string, fn: Fn | undefined, mode: Mode, opts?: number | { timeout?: number }) => {
    const timeout = typeof opts === 'number' ? opts : opts?.timeout ?? DEFAULT_TIMEOUT;
    current.children.push({ kind: 'test', name: String(name), fn: fn ?? null, mode: fn ? mode : 'todo', timeout, parent: current });
  };
  const title = (template: string, args: unknown[], i: number): string => {
    let k = 0;
    let out = String(template).replace(/%[sdifjo#%]/g, (m) => {
      if (m === '%%') return '%';
      if (m === '%#') return String(i);
      const v = args[k++];
      return m === '%s' ? (typeof v === 'string' ? v : fmt(v)) : m === '%d' || m === '%i' ? String(m === '%i' ? Math.trunc(Number(v)) : Number(v)) : m === '%f' ? String(Number(v)) : fmt(v);
    });
    if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Array.isArray(args[0])) {
      out = out.replace(/\$([\w.]+)/g, (m, path: string) => {
        let v: any = args[0];
        for (const p of path.split('.')) v = v?.[p];
        return v === undefined ? m : typeof v === 'string' ? v : fmt(v);
      });
    }
    return out;
  };
  const withEach = (add: (name: string, fn: any, mode: Mode, opts?: any) => void, mode: Mode) =>
    (table: unknown[]) => (name: string, fn: (...a: any[]) => unknown, opts?: any) => {
      table.forEach((row, i) => {
        const args = Array.isArray(row) ? row : [row];
        add(title(name, args, i), () => fn(...args), mode, opts);
      });
    };
  const variants = (add: (name: string, fn: any, mode: Mode, opts?: any) => void) => {
    const f: any = (name: string, fn: any, opts?: any) => add(name, fn, 'run', opts);
    f.skip = (name: string, fn: any, opts?: any) => add(name, fn, 'skip', opts);
    f.only = (name: string, fn: any, opts?: any) => add(name, fn, 'only', opts);
    f.todo = (name: string) => add(name, undefined, 'todo');
    f.skipIf = (cond: unknown) => (cond ? f.skip : f);
    f.runIf = (cond: unknown) => (cond ? f : f.skip);
    f.each = withEach(add, 'run');
    f.skip.each = withEach(add, 'skip');
    f.only.each = withEach(add, 'only');
    f.concurrent = f; f.sequential = f;
    f.fails = (name: string, fn: any, opts?: any) => {
      add(name, fn, 'run', opts);
      const t = current.children.at(-1) as TestCase;
      if (t?.kind === 'test') t.fails = true;
    };
    return f;
  };
  const test = variants(addTest);
  const describe = variants((name, fn, mode) => addSuite(name, fn, mode));
  const hook = (key: 'beforeAll' | 'afterAll' | 'beforeEach' | 'afterEach') => (fn: Fn) => { current[key].push(fn); };
  return {
    describe, suite: describe, it: test, test,
    beforeAll: hook('beforeAll'), afterAll: hook('afterAll'), beforeEach: hook('beforeEach'), afterEach: hook('afterEach'),
    onTestFinished: (fn: Fn) => { current.afterEach.push(fn); },
    expect: makeExpect(),
    vi: makeVi(restorers),
    assert: (v: unknown, msg?: string) => { if (!v) throw new AssertionError(msg ?? 'assertion failed'); },
  };
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return p;
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p.finally(() => clearTimeout(timer)),
    new Promise<T>((_r, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out in ${ms}ms`)), ms); }),
  ]);
}

function errText(e: unknown): string {
  if (e instanceof Error) {
    const frames = (e.stack ?? '').split('\n').filter((l) => /^\s+at /.test(l)).slice(0, 4).join('\n');
    return `${e.name}: ${e.message}${frames ? '\n' + frames : ''}`;
  }
  return String(e);
}

export interface RunOptions {
  /** Only tests whose full name matches */
  filter?: RegExp;
  /** Called with each finished test */
  onResult?: (r: TestResult) => void;
  /** The files the suite's node:fs starts with (test-fs.ts snapshotTree); its writes stay in memory */
  files?: Snapshot;
  /** The suite's process.cwd() for relative fs paths */
  cwd?: string;
}

let running: Promise<unknown> = Promise.resolve();

/** Evaluate a bundle from buildTest and run its tests (one run at a time per page) */
export function runTestBundle(code: string, opts: RunOptions = {}): Promise<RunSummary> {
  const run = running.then(() => quietDuring(() => runNow(code, opts)));
  running = run.catch(() => {});
  return run;
}

async function runNow(code: string, opts: RunOptions): Promise<RunSummary> {
  const started = performance.now();
  const g = globalThis as any;
  const root: Suite = { kind: 'suite', name: '', mode: 'run', parent: null, children: [], beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] };
  const restorers: (() => void)[] = [];
  const summary: RunSummary = { results: [], passed: 0, failed: 0, skipped: 0, ms: 0, errors: [] };
  await dropTestDatabases();
  // The page as it is before the suite's copies run: put back after (#47)
  const pageBefore = snapshotPage();
  const runId = Math.random().toString(36).slice(2, 8);
  g.__tcTestEnv = isolatedEnv(runId);
  g.__tcTestApi = makeApi(root, restorers);
  g.__tcTestNode = { path: testPath, os: testOs, ...makeTestNode(opts.files ?? new Map(), opts.cwd) };
  try {
    try {
      await importCode(code);
    } catch (e) {
      summary.errors.push(`loading the suite: ${errText(e)}`);
      summary.failed++;
      return summary;
    }
    const hasOnly = (s: Suite): boolean => s.children.some((c) => c.mode === 'only' || (c.kind === 'suite' && hasOnly(c)));
    const onlyMode = hasOnly(root);
    const fullName = (t: TestCase | Suite): string => {
      const parts: string[] = [];
      for (let n: Suite | TestCase | null = t; n && n.name; n = n.parent) parts.unshift(n.name);
      return parts.join(' > ');
    };
    const chain = (s: Suite | null): Suite[] => { const out: Suite[] = []; for (; s; s = s.parent) out.unshift(s); return out; };
    const record = (r: TestResult) => {
      summary.results.push(r);
      if (r.status === 'pass') summary.passed++; else if (r.status === 'fail') summary.failed++; else summary.skipped++;
      opts.onResult?.(r);
    };
    const runHooks = async (fns: Fn[], what: string) => { for (const f of fns) await withTimeout(Promise.resolve().then(f), 10_000, what); };

    const runSuite = async (s: Suite, skipped: boolean, onlyAbove: boolean) => {
      const selected = (c: Suite | TestCase): boolean => {
        if (c.kind === 'test') return !onlyMode || onlyAbove || c.mode === 'only';
        return !onlyMode || onlyAbove || c.mode === 'only' || hasOnly(c);
      };
      const skipHere = skipped || s.mode === 'skip' || s.mode === 'todo';
      const hasRunnable = (x: Suite): boolean => x.children.some((c) => c.kind === 'test' ? c.mode !== 'skip' && c.mode !== 'todo' : hasRunnable(c));
      const live = !skipHere && hasRunnable(s);
      if (live) {
        try { await runHooks(s.beforeAll, `beforeAll in ${s.name || 'file'}`); } catch (e) {
          summary.errors.push(`${s.name || 'file'}: beforeAll: ${errText(e)}`);
          summary.failed++;
          return;
        }
      }
      for (const c of s.children) {
        const only = onlyAbove || c.mode === 'only';
        if (c.kind === 'suite') { if (selected(c)) await runSuite(c, skipHere, only); continue; }
        if (!selected(c)) continue;
        const name = fullName(c);
        if (opts.filter && !opts.filter.test(name)) continue;
        if (skipHere || c.mode === 'skip' || c.mode === 'todo' || !c.fn) { record({ name, status: c.mode === 'todo' ? 'todo' : 'skip', ms: 0 }); continue; }
        const t0 = performance.now();
        let error: unknown = null;
        const suites = chain(s);
        try {
          for (const x of suites) await runHooks(x.beforeEach, 'beforeEach');
          await withTimeout(Promise.resolve().then(c.fn), c.timeout, `test`);
        } catch (e) { error = e; }
        for (const x of [...suites].reverse()) {
          try { await runHooks(x.afterEach, 'afterEach'); } catch (e) { error ??= e; }
        }
        const ms = Math.round(performance.now() - t0);
        if (c.fails) record(error ? { name, status: 'pass', ms } : { name, status: 'fail', ms, error: 'expected the test to fail' });
        else record(error ? { name, status: 'fail', ms, error: errText(error) } : { name, status: 'pass', ms });
      }
      if (live) {
        try { await runHooks(s.afterAll, `afterAll in ${s.name || 'file'}`); } catch (e) { summary.errors.push(`${s.name || 'file'}: afterAll: ${errText(e)}`); }
      }
    };
    await runSuite(root, false, false);
    return summary;
  } finally {
    while (restorers.length) restorers.pop()!();
    summary.restored = restorePage(pageBefore);
    recordTestLeftovers(summary.restored);
    delete g.__tcTestApi;
    summary.ms = Math.round(performance.now() - started);
    // (the env stays: timers the suite left may still use it; the next run replaces it)
    void dropTestDatabases();
  }
}
