/**
 * Module state across a swap (docs/HOTSWAP.md). A swapped module's bundle
 * has its own copy of the module's top-level bindings; for the ones that
 * hold state, the new copy is made to use the page's:
 *
 * - vite-plugin-hotswap.ts registers, per src module, an object of getters
 *   (and setters for `let`/`var`) for its state in
 *   `globalThis.__tabcomputerLiveState` (key 'src/shell.ts').
 * - build.ts rewrites a swapped module so that, after its top-level code has
 *   run, its state bindings are set from that object: Maps, Sets, arrays and
 *   objects become the live ones (shared both ways), `let` values are carried
 *   in. The module also exports `__hotswapState` (what it took, and getters
 *   for its own copy), and a revert writes the `let` values back (swap.ts).
 *
 * State is found by declaration only: column-0 `let`/`var` (mutable), and
 * consts initialized with an empty container: `new Map()` (Set, WeakMap,
 * WeakSet), `[]` or `{}`. A const declared with its contents is a table:
 * the swap uses its own, so edits to it take effect.
 */

export interface StateBinding { name: string; mutable: boolean }

export function moduleState(code: string): StateBinding[] {
  const out = new Map<string, boolean>();
  for (const m of code.matchAll(/^(?:export\s+)?(let|var)\s+([A-Za-z_$][\w$]*)/gm)) out.set(m[2], true);
  // (empty containers only: a const filled in where it's declared is a table, code like any other)
  for (const m of code.matchAll(/^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:\/\*\s*@__PURE__\s*\*\/\s*)?(?:new\s+(?:Map|Set|WeakMap|WeakSet)\s*(?:<[^\n]*?>)?\s*\(\s*\)|\[\s*\]|\{\s*\})/gm)) {
    if (!out.has(m[1])) out.set(m[1], false);
  }
  return [...out].map(([name, mutable]) => ({ name, mutable }));
}

/**
 * Rewrite a swapped module's source (TS or JS) to take the live module's
 * state: container consts become lets (so they can be re-pointed), and code
 * appended at the end re-points every state binding the live module exposes.
 */
export function carryState(source: string, key: string): { code: string; names: string[] } {
  const state = moduleState(source);
  if (!state.length) return { code: source, names: [] };
  const containers = new Set(state.filter((s) => !s.mutable).map((s) => s.name));
  const code = source.replace(/^((?:export\s+)?)const(\s+)([A-Za-z_$][\w$]*)/gm, (m, ex, sp, name) => (containers.has(name) ? `${ex}let${sp}${name}` : m));
  const k = JSON.stringify(key);
  // (plain JS, valid in a .ts file too: esbuild doesn't type-check)
  const take = state.map(({ name }) => `  if (${JSON.stringify(name)} in __tcLive) try { ${name} = __tcLive.${name}; __tcTook.push(${JSON.stringify(name)}); } catch { /* not a binding */ }`).join('\n');
  const own = state.map(({ name }) => `get ${name}() { return ${name}; }`).join(', ');
  return {
    code: `${code}\nconst __tcLive = globalThis.__tabcomputerLiveState?.get(${k}) ?? {};\nconst __tcTook = [];\n{\n${take}\n}\n` +
      `export const __hotswapState = { took: __tcTook, mutable: ${JSON.stringify(state.filter((x) => x.mutable).map((x) => x.name))}, state: { ${own} } };\n`,
    names: state.map((s) => s.name),
  };
}
