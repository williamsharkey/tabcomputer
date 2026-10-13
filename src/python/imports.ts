/**
 * A cheap static scan of a Python source for the top-level modules it
 * imports: lines, not a parser. It reads `import a.b, c as d`, `from a.b
 * import c` (also after `try:` / `if x:` / `;` on the same line),
 * `__import__("a")` and `importlib.import_module("a")`, and skips comments
 * and triple-quoted text. Relative imports name no top-level module.
 *
 * It decides which Python runs a program (route.ts), so a miss costs a
 * ModuleNotFoundError that says what to do, and a false hit costs a slower
 * start: neither is a wrong result.
 */

const IMPORT = /(?:^|[:;])\s*import\s+([^#;]+)/g;
const FROM = /(?:^|[:;])\s*from\s+([A-Za-z_][\w.]*)\s+import\b/g;
const DYNAMIC = /(?:__import__|import_module)\(\s*['"]([A-Za-z_][\w.]*)['"]/g;

export function scanImports(source: string): string[] {
  const out = new Set<string>();
  let inString: string | null = null; // the triple quote we are inside
  for (const raw of source.split('\n')) {
    let line = raw;
    // Triple-quoted text: keep only what is outside it on this line
    let code = '';
    for (let i = 0; i < line.length;) {
      if (inString) {
        const end = line.indexOf(inString, i);
        if (end < 0) { i = line.length; break; }
        i = end + 3;
        inString = null;
        continue;
      }
      const a = line.indexOf('"""', i), b = line.indexOf("'''", i);
      const start = a < 0 ? b : b < 0 ? a : Math.min(a, b);
      if (start < 0) { code += line.slice(i); break; }
      code += line.slice(i, start) + ' ';
      inString = line.substr(start, 3);
      i = start + 3;
    }
    line = code;
    if (!line.trim() || /^\s*#/.test(line)) continue;
    if (!/import/.test(line)) continue;
    for (const m of line.matchAll(FROM)) out.add(m[1].split('.')[0]);
    for (const m of line.matchAll(IMPORT)) {
      for (const part of m[1].split(',')) {
        const n = /^\s*\(?\s*([A-Za-z_][\w.]*)/.exec(part);
        if (n) out.add(n[1].split('.')[0]);
      }
    }
    for (const m of line.matchAll(DYNAMIC)) out.add(m[1].split('.')[0]);
  }
  return [...out];
}
