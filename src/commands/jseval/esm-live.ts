/**
 * Live ES module bindings for esbuild code-split chunks.
 *
 * transformESModules turns `import { a } from './x.js'` into a destructuring
 * of require()'s result, which copies `a` once. esbuild's split chunks rely on
 * ESM bindings being live: a chunk exports `var ValueType;` that only its
 * lazily run `__esm` initializer assigns, and other chunks read it at top
 * level after calling that initializer (Gemini CLI's
 * `valueType: ValueType.INT`). Copies made at import time are undefined.
 *
 * For a chunk (it imports esbuild's runtime helpers from a sibling), this
 * pass:
 * - exports `export { a, b as c }` as getters on module.exports, hoisted to
 *   the top of the module, instead of copying the values at its end;
 * - reads named imports through the imported module's exports object
 *   (`a` → `__shiro_liveN.a`, calls as `(0, __shiro_liveN.a)(…)`).
 * esbuild gives every top-level symbol a chunk-unique name and renames
 * nested bindings that would shadow one (`exports2`, `ValueType2`), so an
 * identifier with an imported name is the import. Positions this pass can't
 * classify keep the old copied binding, which the import transform still
 * declares.
 */
import { codeMask } from './module-transform';

const HELPER_IMPORT = /\bimport\s*\{[^}]*\b(?:__esm|__export|__commonJS|__toESM|__toCommonJS)\b[^}]*\}\s*from\s*['"]\.\.?\//;
const NAMED_IMPORT = /\bimport\s*\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g;
const LOCAL_EXPORT = /\bexport\s*\{([^}]*)\}\s*;?/g;
const OBJECT_AFTER_WORD = new Set(['const', 'let', 'var', 'return', 'typeof', 'in', 'of', 'yield', 'await', 'new', 'delete', 'void', 'throw', 'case']);
const MEMBER_PREFIX = new Set(['get', 'set', 'static', 'async']);

export function isEsbuildChunk(src: string): boolean {
  return HELPER_IMPORT.test(src);
}

const isIdentStart = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36 || c > 127;
const isIdent = (c: number) => isIdentStart(c) || (c >= 48 && c <= 57);

/** Names in `locals` the module also declares: a catch, function or arrow parameter, let/const/var/function/class */
function redeclared(src: string, inCode: (i: number) => boolean, locals: Map<string, unknown>): Set<string> {
  const found = new Set<string>();
  const add = (list: string, at: number) => {
    if (!inCode(at)) return;
    // (simple names, defaults and rest elements; a destructured parameter's names too)
    // (`{ key: name }`: the name after the colon)
    for (const m of list.matchAll(/(?:^|[,{[(:]|\.\.\.)\s*([A-Za-z_$][\w$]*)\s*(?=[,}\])=]|$)/g)) if (locals.has(m[1])) found.add(m[1]);
  };
  for (const m of src.matchAll(/\bcatch\s*\(([^()]*)\)/g)) add(m[1], m.index!);
  for (const m of src.matchAll(/\bfunction\b\s*\*?\s*[\w$]*\s*\(([^()]*)\)/g)) add(m[1], m.index!);
  // (a method's parameters: `getFullName(test, separator) {` beside an imported `separator`;
  // an `if (…) {` condition's names come along, which only keeps them copies)
  // (found from the `(`, then the word character before it: a regex starting at every word
  // character was a quarter of this pass's time)
  for (const m of src.matchAll(/\(([^()]*)\)\s*\{/g)) {
    let k = m.index! - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    if (k >= 0 && isIdent(src.charCodeAt(k)) && src.charCodeAt(k) <= 127) add(m[1], k);
  }
  for (const m of src.matchAll(/\(([^()]*)\)\s*=>/g)) add(m[1], m.index!);
  // (`x =>`: from each `=>`, the word before it)
  for (const m of src.matchAll(/=>/g)) {
    let k = m.index! - 1;
    while (k >= 0 && /\s/.test(src[k])) k--;
    const end = k + 1;
    while (k >= 0 && isIdent(src.charCodeAt(k))) k--;
    const start = k + 1;
    if (start === end || !isIdentStart(src.charCodeAt(start))) continue;
    if (k >= 0 && (isIdent(src.charCodeAt(k)) || src[k] === '.' || src[k] === '$')) continue;
    const name = src.slice(start, end);
    if (inCode(start) && locals.has(name)) found.add(name);
  }
  for (const m of src.matchAll(/\b(?:let|const|var|function\s*\*?|class)\s+([A-Za-z_$][\w$]*)/g)) if (inCode(m.index!) && locals.has(m[1])) found.add(m[1]);
  for (const m of src.matchAll(/\b(?:let|const|var)\s*([{[][^=;]*)=/g)) add(m[1], m.index!);
  // (`for (const { x } of list)`: destructured with no `=`)
  for (const m of src.matchAll(/\b(?:let|const|var)\s*([{[][^;=]*?)\s+(?:of|in)\b/g)) add(m[1], m.index!);
  return found;
}

/**
 * The statement that ends a module (general mode): its exports whose values can't change
 * any more become plain properties, so an importer's reads (`__shiro_live0.f`, every call
 * of an imported function) stop going through a getter. Getters made astro dev ~0.5 s
 * slower to start. Only a top-level const, function or class nothing assigns to settles;
 * a let or var, and a re-export (its module may still be loading), stay getters. A value
 * that can't be read yet (a throw) leaves all of them getters.
 */
function settled(src: string, inCode: (i: number) => boolean, settle: [string, string][], imports: Map<string, unknown>): string {
  if (!settle.length) return '';
  const space = (k: number) => src[k] === ' ' || src[k] === '\t' || src[k] === '\n' || src[k] === '\r';
  /** The identifier ending just before `end` (spaces skipped), unless it is a member (`.x`) */
  const wordBefore = (end: number): { word: string; start: number } | null => {
    let k = end - 1;
    while (k >= 0 && space(k)) k--;
    const to = k + 1;
    while (k >= 0 && isIdent(src.charCodeAt(k))) k--;
    if (to === k + 1 || !isIdentStart(src.charCodeAt(k + 1)) || src[k] === '.') return null;
    return { word: src.slice(k + 1, to), start: k + 1 };
  };
  const constLike = new Set<string>(), changing = new Set<string>();
  // declarations (a list's names after the first aren't seen: those stay getters)
  for (const m of src.matchAll(/(?<![\w$.])(let|var|const|class|function)(?![\w$])\s*\*?\s*([A-Za-z_$][\w$]*)/g)) {
    if (!inCode(m.index!)) continue;
    (m[1] === 'let' || m[1] === 'var' ? changing : constLike).add(m[2]);
  }
  // assignments, from each `=` (`f = …`, `f += …`; not `==`, `=>`, `<=`, `x.f =`) and `++`/`--`
  // (a destructuring assignment, `[f] = …`, isn't seen: rare for an export)
  for (const m of src.matchAll(/(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?![=>])/g)) {
    if (!inCode(m.index!) || src[m.index! - 1] === '=' || src[m.index! - 1] === '!') continue;
    const w = wordBefore(m.index!);
    // (`const f = …` declares it)
    if (w && !/^(?:const|let|var)$/.test(wordBefore(w.start)?.word ?? '')) changing.add(w.word);
  }
  for (const m of src.matchAll(/\+\+|--/g)) {
    if (!inCode(m.index!)) continue;
    const w = wordBefore(m.index!);
    if (w) changing.add(w.word);
    const after = /^\s*([A-Za-z_$][\w$]*)/.exec(src.slice(m.index! + 2, m.index! + 66));
    if (after) changing.add(after[1]);
  }
  const ok = settle.filter(([, local]) => !imports.has(local) && constLike.has(local) && !changing.has(local));
  if (!ok.length) return '';
  return `\n;try { __shiro_require.settle(__shiro_module.exports, {${ok.map(([name, local]) => `${JSON.stringify(name)}: ${local}`).join(', ')}}); } catch {}\n`;
}

export function liveEsbuildChunk(src: string): string {
  if (!isEsbuildChunk(src)) return src;
  return liveBindings(src, false);
}

/**
 * The same for any ES module (tabcomputer#35: a module that reads an import while the
 * module it comes from is still loading read a copy made too early, "later undefined";
 * vitest's chunks). Every static import's module loads first, in the source's order, as
 * ES modules evaluate their imports before their body; one that replaces its
 * module.exports while this one loads (a cycle) is re-read. Declared exports
 * (`export let n`) and re-exports are getters too.
 */
export function liveModule(src: string): string {
  // (a byte order mark isn't a word's start: three's WebGLBindingStates.js begins with one)
  return liveBindings(src.charCodeAt(0) === 0xfeff ? src.slice(1) : src, true);
}

// (`import` the keyword: not the start of Astro's `importsRaw += \`import … from '${…}'\``)
const STATIC_IMPORT = /(?<![\w$.])import(?![\w$])\s*(?:[\w$*{][^;'"()]*?\bfrom\s*)?(['"])([^'"\n]+)\1/g;

function liveBindings(src: string, general: boolean): string {
  const mask = codeMask(src);
  const inCode = (i: number) => mask[i] === 1;

  // Named imports: local name -> [module index, imported name]; their text ranges are left alone
  const modules: string[] = [];
  const locals = new Map<string, [number, string]>();
  const skip: [number, number][] = [];
  // (general: each import statement's items, to write it again without the live names)
  const imports: { items: [string, string][]; raw: string[]; quote: string; spec: string; untouched?: boolean }[] = [];
  for (const m of src.matchAll(NAMED_IMPORT)) {
    if (!inCode(m.index!)) continue;
    // (a node builtin's exports don't change under it: its imports stay copies, the statement untouched)
    if (general && m[3].startsWith('node:')) {
      imports.push({ items: [], raw: [], quote: m[2], spec: m[3], untouched: true });
      skip.push([m.index!, m.index! + m[0].length]);
      continue;
    }
    const idx = modules.push(m[3]) - 1;
    const rec = { items: [] as [string, string][], raw: [] as string[], quote: m[2], spec: m[3] };
    for (const item of m[1].split(',')) {
      const t = item.trim();
      if (!t) continue;
      rec.raw.push(t);
      const as = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(t);
      // (general) `{ default as x }` is the default import, the module's exports themselves here: a copy
      if (as && general && as[1] === 'default') continue;
      if (as) { locals.set(as[2], [idx, as[1]]); rec.items.push([as[2], t]); }
      else if (/^[\w$]+$/.test(t)) { locals.set(t, [idx, t]); rec.items.push([t, t]); }
    }
    imports.push(rec);
    skip.push([m.index!, m.index! + m[0].length]);
  }
  /** An export's getter: in general mode an uninitialized one reads undefined, and setting the same value keeps it live */
  const getter = (name: string, value: string) => general
    // (require.ts's live(): a thunk per export, not a descriptor each, which were ~250 bytes
    // an export that the transform and the parser then went through again)
    ? `${JSON.stringify(name)}: () => ${value}`
    : `${JSON.stringify(name)}: { get: () => ${value}, set(v) { Object.defineProperty(this, ${JSON.stringify(name)}, { value: v, writable: true, enumerable: true, configurable: true }); }, enumerable: true, configurable: true }`;

  // Local export lists become getters; the statements are removed
  const getters: string[] = [];
  /** (general) exports [name, local] that become plain values once the module has run (settled) */
  const settle: [string, string][] = [];
  const removals: [number, number][] = [];
  // (export statements left to the transform as they are: names in them aren't rewritten)
  const keep: [number, number][] = [];
  for (const m of src.matchAll(LOCAL_EXPORT)) {
    if (!inCode(m.index!)) continue;
    // `export { x } from 'y'` is a re-export, handled by the regular transform (in general
    // mode also a getter that reads it through: a module still loading has it later)
    const from = /^\s*from\s*(['"])([^'"\n]+)\1/.exec(src.slice(m.index! + m[0].length));
    if (from) {
      if (general) {
        // (the statement is the transform's, its names untouched: micromark-util-subtokenize
        // both imports SpliceBuffer and re-exports it)
        keep.push([m.index!, m.index! + m[0].length + from[0].length]);
        const idx = modules.push(from[2]) - 1;
        for (const item of m[1].split(',')) {
          const as = /^\s*([\w$]+)(?:\s+as\s+([\w$]+))?\s*$/.exec(item);
          if (as && as[1] !== 'default' && (as[2] ?? as[1]) !== 'default') getters.push(getter(as[2] ?? as[1], `__shiro_live${idx}.${as[1]}`));
        }
      }
      continue;
    }
    if (/^\s*from\b/.test(src.slice(m.index! + m[0].length))) continue;
    if (/\bfrom\s*['"]$/.test(m[0])) continue;
    // (general) a list with the default export is the transform's: its default is the exports
    // object itself (tinyrainbow's `export { b as default, … }`, which vitest imports as `c`)
    // (and one with an item that isn't `name` or `name as name`: `e as "module.exports"`)
    if (general && (/(?:^|[\s,])(?:default|[\w$]+\s+as\s+default)\s*(?:,|$)/.test(m[1])
      || m[1].split(',').some((t) => t.trim() && !/^[\w$]+(?:\s+as\s+[\w$]+)?$/.test(t.trim())))) {
      keep.push([m.index!, m.index! + m[0].length]);
      // (the transform exports these locals by name: an import among them stays a copy)
      for (const item of m[1].split(',')) { const n = /^\s*([\w$]+)/.exec(item)?.[1]; if (n) locals.delete(n); }
      continue;
    }
    for (const item of m[1].split(',')) {
      const t = item.trim();
      if (!t) continue;
      const as = /^([\w$]+)\s+as\s+([\w$]+)$/.exec(t);
      const [local, name] = as ? [as[1], as[2]] : [t, t];
      if (!/^[\w$]+$/.test(local)) continue;
      // re-exporting an import stays live too
      const imp = locals.get(local);
      const value = imp ? `__shiro_live${imp[0]}.${imp[1]}` : local;
      getters.push(getter(name, value));
      if (general && !imp) settle.push([name, local]);
    }
    removals.push([m.index!, m.index! + m[0].length]);
  }
  // (general) `export let n = 1`, `export function f`: getters too; the transform still copies
  // the value at the end, which the getter's setter takes as the same value
  if (general) {
    for (const m of src.matchAll(/(?<![\w$.])export\s+(?:async\s+)?(?:function\s*\*?|class|let|const|var)\s+([\w$]+)/g)) {
      if (inCode(m.index!)) { getters.push(getter(m[1], m[1])); settle.push([m[1], m[1]]); }
    }
  }
  // An imported name the module declares again (rolldown's chunks reuse names in nested
  // scopes, `catch (error)` beside an imported `error`; esbuild renames those) keeps the copy
  if (locals.size) for (const name of redeclared(src, inCode, locals)) locals.delete(name);
  if (!locals.size && !getters.length) return src;

  const out: string[] = [];
  let last = 0;
  const emit = (from: number, to: number, text: string) => { out.push(src.slice(last, from), text); last = to; };
  // At the top of the module: the getters first (a dependency loaded below
  // may call back into this module), then each imported module's exports
  // object, which is its live namespace even while its body is still
  // running. `(__shiro_require)(…)` is not rewritten to wait for that body
  // (compileAsyncModule); the import statements themselves still wait.
  let header = !getters.length ? ''
    : general ? `__shiro_require.live(__shiro_module.exports, {${getters.join(', ')}}); `
    : `Object.defineProperties(__shiro_module.exports, {${getters.join(', ')}}); `;
  if (!general) {
    header += modules.length ? 'var ' + modules.map((m, k) => `__shiro_live${k} = (__shiro_require)(${JSON.stringify(m)})`).join(', ') + ';' : '';
  } else {
    // every static import, in the source's order (side-effect ones too); a named one's exports object kept
    const vars = new Map<string, number[]>();
    modules.forEach((m, k) => vars.set(m, [...(vars.get(m) ?? []), k]));
    const steps: string[] = [];
    const seen = new Set<string>();
    const assign = (spec: string, ks: number[] | undefined) => {
      // (a plain call, which a module whose import is still evaluating waits for: require.ts)
      const load = `__shiro_require(${JSON.stringify(spec)})`;
      steps.push(ks ? `${ks.map((k) => `__shiro_live${k} = `).join('')}${load};` : `${load};`);
      if (ks) steps.push(`__shiro_require.relink?.(${JSON.stringify(spec)}, (__e) => { ${ks.map((k) => `__shiro_live${k} = `).join('')}__e; });`);
    };
    for (const m of src.matchAll(STATIC_IMPORT)) {
      if (!inCode(m.index!) || seen.has(m[2])) continue;
      seen.add(m[2]);
      assign(m[2], vars.get(m[2]));
    }
    for (const [m, ks] of vars) if (!seen.has(m)) assign(m, ks);
    header += (modules.length ? 'var ' + modules.map((_, k) => `__shiro_live${k}`).join(', ') + '; ' : '') + steps.join(' ');
  }
  // (after a directive prologue: "use strict" stays one)
  const directives = /^(?:\s*(?:(['"])use [\w ]+\1\s*;?))*/.exec(src)![0];
  if (directives) { out.push(directives); last = directives.length; }
  out.push(header);
  const tail = general ? settled(src, inCode, settle, locals) : '';
  // (no imported name to rewrite: only the export lists go, no need to read the code)
  if (!locals.size) {
    for (const [from, to] of removals) emit(from, to, '');
    out.push(src.slice(last), tail);
    return out.join('');
  }

  // Bracket stack: '(' '[' or '{' tagged object (o), block (b) or class body (c)
  const stack: string[] = [];
  let prev = '';        // last significant code character ('w' after a word, 'a' after a literal)
  let prevWord = '';
  let classDepth = -1;  // stack depth where a `class` keyword's body `{` will open
  let skipI = 0, remI = 0, keepI = 0;
  const len = src.length;
  let i = 0;
  while (i < len) {
    if (skipI < skip.length && i === skip[skipI][0]) {
      // (the statement stays: a position the pass can't classify reads its copy, which the
      // exporter's getters let it take while that module still loads)
      i = skip[skipI++][1]; prev = ';'; prevWord = '';
      continue;
    }
    if (remI < removals.length && i === removals[remI][0]) { emit(i, removals[remI][1], ''); i = removals[remI][1]; remI++; prev = ';'; continue; }
    if (keepI < keep.length && i === keep[keepI][0]) { i = keep[keepI++][1]; prev = ';'; prevWord = ''; continue; }
    if (!inCode(i)) {
      // a comment keeps `prev`; a string, template or regex literal is a value
      const c0 = src[i];
      const comment = c0 === '/' && (src[i + 1] === '/' || src[i + 1] === '*');
      while (i < len && !inCode(i)) i++;
      if (!comment) { prev = 'a'; prevWord = ''; }
      continue;
    }
    const c = src.charCodeAt(i);
    const ch = src[i];
    if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r') { i++; continue; }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < len && isIdent(src.charCodeAt(j))) j++;
      const word = src.slice(i, j);
      const hit = locals.get(word);
      if (hit && src[i - 1] !== '#' && (prev !== '.' || src.slice(i - 3, i) === '...')) {
        const rep = replacement(word, hit, i, j);
        if (rep !== null) emit(i, j, rep);
      }
      if (word === 'class') classDepth = stack.length;
      prev = 'w';
      prevWord = word;
      i = j;
      continue;
    }
    if (c >= 48 && c <= 57) {
      // number literal (keeps `1e5`, `0x1f` together)
      let j = i + 1;
      while (j < len && (isIdent(src.charCodeAt(j)) || src[j] === '.')) j++;
      prev = 'a'; prevWord = ''; i = j;
      continue;
    }
    if (ch === '(' || ch === '[') stack.push(ch);
    else if (ch === '{') {
      if (classDepth === stack.length) { stack.push('c'); classDepth = -1; }
      else stack.push(isObjectBrace() ? 'o' : 'b');
    } else if (ch === ')' || ch === ']' || ch === '}') stack.pop();
    prev = ch === '>' && src[i - 1] === '=' ? '=>' : ch;
    prevWord = '';
    i++;
  }
  out.push(src.slice(last), tail);

  function isObjectBrace(): boolean {
    if (prev === 'w') return OBJECT_AFTER_WORD.has(prevWord);
    if (prev === '=>') return false;
    return '([,=:?!&|+-*%<>~^'.includes(prev) && prev !== '';
  }

  function nextChar(j: number): string {
    while (j < len && (src[j] === ' ' || src[j] === '\n' || src[j] === '\t' || src[j] === '\r')) j++;
    return src[j] ?? '';
  }

  /** The text for an imported identifier at [i, j), or null to keep the copied binding. */
  function replacement(word: string, [idx, name]: [number, string], _i: number, j: number): string | null {
    const ref = `__shiro_live${idx}.${name}`;
    const next = nextChar(j);
    const top = stack[stack.length - 1];
    const memberPos = prev === '{' || prev === ',' || prev === ';' || prev === '}';
    // `get name() {}`, `static x`, `async *gen()`: the keyword, when an import is named like it
    if (MEMBER_PREFIX.has(word) && ((top === 'o' && (prev === '{' || prev === ',')) || (top === 'c' && memberPos))
      && (/[A-Za-z_$\[*'"#]/.test(next) || next.charCodeAt(0) > 127)) return null;
    if (top === 'o' && (prev === '{' || prev === ',')) {
      if (next === ':' || next === '(') return null;      // key or method
      if (next === ',' || next === '}') return `${word}: ${ref}`; // shorthand property
    }
    if (top === 'o' && prev === 'w' && MEMBER_PREFIX.has(prevWord)) return null;
    if (top === 'c' && (memberPos || (prev === 'w' && MEMBER_PREFIX.has(prevWord)) || prev === '*')) return null;
    if (prev === 'w' && /^(?:function|class|var|let|const|import|export)$/.test(prevWord)) return null;
    if (next === ':' && (prev === '{' || prev === ';' || prev === '}' || prev === '')) return null; // label
    // (after `await`: `await (0, x.f)()` would call a function named await where top-level
    // await isn't allowed, not be the syntax error that compiles the module async: SvelteKit's
    // `await import_peer(…)`)
    if (next === '(' || next === '`') return prev === 'w' && (prevWord === 'await' || prevWord === 'yield') ? ref : `(0, ${ref})`;
    return ref;
  }

  return out.join('');
}
