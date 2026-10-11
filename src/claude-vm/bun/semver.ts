/** Bun.semver: order (-1, 0, 1) and satisfies, node-semver's rules */
import semverCompare from 'semver/functions/compare.js';
import semverSatisfies from 'semver/functions/satisfies.js';
import semverValid from 'semver/functions/valid.js';

const text = (v: unknown) => (typeof v === 'string' ? v : ArrayBuffer.isView(v) ? new TextDecoder().decode(v as Uint8Array) : String(v));

export function order(a: unknown, b: unknown): -1 | 0 | 1 {
  const x = text(a).trim(), y = text(b).trim();
  // (strings that aren't versions compare as text, as Bun does rather than throwing)
  if (!semverValid(x, { loose: true }) || !semverValid(y, { loose: true })) return x < y ? -1 : x > y ? 1 : 0;
  return semverCompare(x, y, true) as -1 | 0 | 1;
}

export function satisfies(version: unknown, range: unknown): boolean {
  try { return semverSatisfies(text(version).trim(), text(range).trim(), { loose: true }); } catch { return false; }
}
