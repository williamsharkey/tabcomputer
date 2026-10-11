/**
 * Bun.deepEquals(a, b, strict = false): structural equality, as Bun's test
 * matchers have it (toEqual without strict: an undefined property is the same
 * as a missing one, and prototypes aren't compared; toStrictEqual with it).
 */
export function deepEquals(a: unknown, b: unknown, strict = false): boolean {
  return eq(a, b, strict, new Map());
}

function eq(a: any, b: any, strict: boolean, seen: Map<any, any>): boolean {
  if (Object.is(a, b)) return true;
  // primitives: Object.is (NaN equals NaN, 0 and -0 differ), as toEqual compares them
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  // strict: the same kind of object (a plain object and a null-prototype one are the same kind)
  const plain = (p: unknown) => p === Object.prototype || p === null;
  const pa = Object.getPrototypeOf(a), pb = Object.getPrototypeOf(b);
  if (strict && pa !== pb && !(plain(pa) && plain(pb))) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
  if (a instanceof Map || b instanceof Map) {
    if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
    for (const [k, v] of a) if (!b.has(k) || !eq(v, b.get(k), strict, seen)) return false;
    return true;
  }
  if (a instanceof Set || b instanceof Set) {
    if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
    outer: for (const v of a) {
      if (b.has(v)) continue;
      for (const w of b) if (eq(v, w, strict, seen)) continue outer;
      return false;
    }
    return true;
  }
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.constructor !== b.constructor) return false;
    const x = a as any, y = b as any;
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i], y[i]) && x[i] !== y[i]) return false;
    return true;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      // (a hole and undefined differ only when strict)
      if (strict && (i in a) !== (i in b)) return false;
      if (!eq(a[i], b[i], strict, seen)) return false;
    }
    return true;
  }
  const keys = (o: any) => [...Object.keys(o), ...Object.getOwnPropertySymbols(o).filter((s) => Object.prototype.propertyIsEnumerable.call(o, s))];
  const ka = keys(a), kb = keys(b);
  if (strict) {
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!Object.prototype.hasOwnProperty.call(b, k) || !eq(a[k], b[k], strict, seen)) return false;
    return true;
  }
  // without strict, a property set to undefined counts as absent
  const defined = (o: any, ks: (string | symbol)[]) => ks.filter((k) => o[k] !== undefined);
  const da = defined(a, ka), db = defined(b, kb);
  if (da.length !== db.length) return false;
  for (const k of da) if (!eq(a[k], b[k], strict, seen)) return false;
  return true;
}
