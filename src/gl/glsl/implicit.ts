/**
 * Desktop GLSL's implicit conversions, made explicit for GLSL ES 3.00.
 *
 * Desktop GLSL (1.20 and later) converts int and uint to float, and ivecN
 * and uvecN to vecN, wherever a float type is wanted: `float x = 1;`,
 * `v * 2`, `pow(x, 2)`, `textureLod(s, uv, 0)`, `return 0;` in a float
 * function. ES has no implicit conversions, so these are compile errors in
 * WebGL2. This pass parses the (already translated) shader, types every
 * expression against the declarations and the built-in function set, and
 * wraps each int-typed operand that needs it in a constructor: `float(2)`,
 * `vec3(iv)`.
 *
 * It only inserts text, so the rest of the source (and its line numbers)
 * stays as it was. A conversion inside a macro's expansion inlines that one
 * use of the macro. Anything it can't parse leaves the source unchanged: the
 * WebGL compiler then reports what it reports without this pass.
 */

type Tok = { k: 'id' | 'num' | 'op'; v: string; s: number; e: number; inv: number };
/** inv: 0 for a token of the source text; otherwise the outermost macro use it was expanded from */
interface Invocation { s: number; e: number; first: number; last: number }

class Fail extends Error {}
const fail = (m: string): never => { throw new Fail(m); };

// ── lexer ──

const PUNCT = ['<<=', '>>=', '++', '--', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||', '^^', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '##'];

/** Tokens and directive lines; directives are [start, end, text] with continuations joined. */
function lex(src: string): { toks: Tok[]; dirs: Map<number, { text: string; end: number }> } {
  const toks: Tok[] = [];
  const dirs = new Map<number, { text: string; end: number }>();
  let i = 0, lineStart = true;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\n') { lineStart = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; continue; }
    if (c === '#' && lineStart) {
      const s = i;
      let text = '';
      while (i < n && src[i] !== '\n') {
        if (src[i] === '\\' && src[i + 1] === '\n') { text += ' '; i += 2; continue; }
        if (src[i] === '/' && src[i + 1] === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? n : j + 2; text += ' '; continue; }
        if (src[i] === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; break; }
        text += src[i++];
      }
      dirs.set(toks.length, { text, end: i });
      // a marker token keeps the directive's place in the stream
      toks.push({ k: 'op', v: '#dir', s, e: i, inv: 0 });
      continue;
    }
    lineStart = false;
    const s = i;
    if (/[A-Za-z_]/.test(c)) {
      while (i < n && /\w/.test(src[i])) i++;
      toks.push({ k: 'id', v: src.slice(s, i), s, e: i, inv: 0 });
      continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^(0[xX][0-9a-fA-F]+[uU]?|(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?(lf|LF|[fFuU])?)/.exec(src.slice(i, i + 64));
      if (!m) fail('bad number');
      i += m![0].length;
      toks.push({ k: 'num', v: m![0], s, e: i, inv: 0 });
      continue;
    }
    const p = PUNCT.find((q) => src.startsWith(q, i));
    const v = p ?? c;
    i += v.length;
    toks.push({ k: 'op', v, s, e: i, inv: 0 });
  }
  return { toks, dirs };
}

// ── preprocessor (what WebGL's compiler sees: __VERSION__ 300, GL_ES) ──

interface Macro { params: string[] | null; body: Tok[] }

function preprocess(src: string): { toks: Tok[]; invs: Invocation[] } {
  const { toks, dirs } = lex(src);
  const macros = new Map<string, Macro>([['__VERSION__', { params: null, body: [num('300')] }], ['GL_ES', { params: null, body: [num('1')] }]]);
  const out: Tok[] = [];
  const invs: Invocation[] = [{ s: 0, e: 0, first: 0, last: 0 }];
  const cond: { active: boolean; taken: boolean; parent: boolean }[] = [];
  const active = () => cond.length === 0 || cond[cond.length - 1].active;

  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.v === '#dir') {
      const d = dirs.get(i)!;
      const dt = lex(d.text.replace(/^\s*#/, '')).toks;
      const name = dt[0]?.v ?? '';
      const rest = dt.slice(1);
      if (name === 'if' || name === 'ifdef' || name === 'ifndef') {
        const parent = active();
        const on = parent && (name === 'if' ? evalIf(rest, macros) : (macros.has(rest[0]?.v ?? '') === (name === 'ifdef')));
        cond.push({ active: on, taken: on, parent });
      } else if (name === 'elif') {
        const c = cond[cond.length - 1] ?? fail('#elif');
        const on = c.parent && !c.taken && evalIf(rest, macros);
        c.active = on; c.taken ||= on;
      } else if (name === 'else') {
        const c = cond[cond.length - 1] ?? fail('#else');
        c.active = c.parent && !c.taken; c.taken = true;
      } else if (name === 'endif') {
        if (!cond.pop()) fail('#endif');
      } else if (!active()) {
        /* skipped */
      } else if (name === 'define') {
        const m = rest[0] ?? fail('#define');
        let body = rest.slice(1);
        let params: string[] | null = null;
        // function-like only when ( follows the name directly
        if (body[0]?.v === '(' && body[0].s === m.e) {
          params = [];
          let j = 1;
          for (; j < body.length && body[j].v !== ')'; j++) if (body[j].v !== ',') params.push(body[j].v);
          body = body.slice(j + 1);
        }
        macros.set(m.v, { params, body: body.map((b) => ({ ...b, s: 0, e: 0 })) });
      } else if (name === 'undef') macros.delete(rest[0]?.v ?? '');
      continue;
    }
    if (!active()) continue;
    if (t.k === 'id' && macros.has(t.v)) {
      const m = macros.get(t.v)!;
      let end = i;
      let args: Tok[][] = [];
      if (m.params) {
        if (toks[i + 1]?.v !== '(') { out.push(t); continue; }
        [args, end] = collectArgs(toks, i + 1);
      }
      const expanded = expand(m, args, macros, new Set([t.v]));
      const id = invs.length;
      invs.push({ s: t.s, e: toks[end].e, first: out.length, last: out.length + expanded.length - 1 });
      for (const x of expanded) out.push({ ...x, s: t.s, e: toks[end].e, inv: id });
      i = end;
      continue;
    }
    out.push(t);
  }
  return { toks: out, invs };
}

const num = (v: string): Tok => ({ k: 'num', v, s: 0, e: 0, inv: 0 });

/** Arguments of a macro call starting at the '(' at index `open`: [args, index of ')']. */
function collectArgs(toks: Tok[], open: number): [Tok[][], number] {
  const args: Tok[][] = [[]];
  let depth = 0;
  for (let j = open + 1; j < toks.length; j++) {
    const v = toks[j].v;
    if (v === '#dir') fail('directive in macro arguments');
    if (v === '(') depth++;
    else if (v === ')') { if (depth === 0) return [args.length === 1 && !args[0].length ? [] : args, j]; depth--; }
    else if (v === ',' && depth === 0) { args.push([]); continue; }
    args[args.length - 1].push(toks[j]);
  }
  return fail('unterminated macro call');
}

function expand(m: Macro, args: Tok[][], macros: Map<string, Macro>, hide: Set<string>): Tok[] {
  if (m.body.some((t) => t.v === '##' || t.v === '#')) fail('token pasting');
  const body: Tok[] = [];
  for (const t of m.body) {
    const pi = m.params ? m.params.indexOf(t.v) : -1;
    if (t.k === 'id' && pi >= 0) body.push(...rescan(args[pi] ?? [], macros, hide));
    else body.push(t);
  }
  return rescan(body, macros, hide);
}

function rescan(toks: Tok[], macros: Map<string, Macro>, hide: Set<string>): Tok[] {
  const out: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const m = t.k === 'id' && !hide.has(t.v) ? macros.get(t.v) : undefined;
    if (!m) { out.push(t); continue; }
    let args: Tok[][] = [];
    if (m.params) {
      if (toks[i + 1]?.v !== '(') { out.push(t); continue; }
      let end;
      [args, end] = collectArgs(toks, i + 1);
      i = end;
    }
    out.push(...expand(m, args, macros, new Set([...hide, t.v])));
  }
  return out;
}

/** #if expression: integers, defined(), unknown names are 0. */
function evalIf(toks: Tok[], macros: Map<string, Macro>): boolean {
  const ex: Tok[] = [];
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].v === 'defined') {
      const paren = toks[i + 1]?.v === '(';
      const name = toks[i + (paren ? 2 : 1)]?.v ?? '';
      ex.push(num(macros.has(name) ? '1' : '0'));
      i += paren ? 3 : 1;
    } else ex.push(toks[i]);
  }
  const vals = rescan(ex, macros, new Set()).map((t) => (t.k === 'id' ? num('0') : t));
  let p = 0;
  const peek = () => vals[p]?.v;
  const LEVELS = [['||'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];
  const unary = (): number => {
    const v = peek();
    if (v === '!') { p++; return unary() ? 0 : 1; }
    if (v === '-') { p++; return -unary(); }
    if (v === '+') { p++; return unary(); }
    if (v === '~') { p++; return ~unary(); }
    if (v === '(') { p++; const r = level(0); if (peek() !== ')') fail('#if )'); p++; return r; }
    const t = vals[p++] ?? fail('#if');
    if (t.k !== 'num') fail('#if operand');
    return parseInt(t.v, /^0[xX]/.test(t.v) ? 16 : 10) | 0;
  };
  const level = (l: number): number => {
    if (l === LEVELS.length) return unary();
    let a = level(l + 1);
    while (LEVELS[l].includes(peek() ?? '')) {
      const op = vals[p++].v;
      const b = level(l + 1);
      switch (op) {
        case '||': a = a || b ? 1 : 0; break; case '&&': a = a && b ? 1 : 0; break;
        case '|': a |= b; break; case '^': a ^= b; break; case '&': a &= b; break;
        case '==': a = a === b ? 1 : 0; break; case '!=': a = a !== b ? 1 : 0; break;
        case '<': a = a < b ? 1 : 0; break; case '>': a = a > b ? 1 : 0; break;
        case '<=': a = a <= b ? 1 : 0; break; case '>=': a = a >= b ? 1 : 0; break;
        case '<<': a <<= b; break; case '>>': a >>= b; break;
        case '+': a += b; break; case '-': a -= b; break; case '*': a *= b; break;
        case '/': a = b ? (a / b) | 0 : 0; break; case '%': a = b ? a % b : 0; break;
      }
    }
    return a;
  };
  const r = level(0);
  if (peek() === '?') fail('#if ?:');
  return r !== 0;
}

// ── types ──

/** A type name ('float', 'vec3', 'mat4', 'sampler2D', a struct's name), '[]' per array level; '?' unknown. */
type Ty = string;
const UNKNOWN = '?';

const SCALARS = new Set(['float', 'int', 'uint', 'bool']);
const isArray = (t: Ty) => t.endsWith('[]');
function vecInfo(t: Ty): { base: 'float' | 'int' | 'uint' | 'bool'; n: number } | null {
  if (SCALARS.has(t)) return { base: t as 'float', n: 1 };
  const m = /^([iub]?)vec([234])$/.exec(t);
  if (m) return { base: ({ '': 'float', i: 'int', u: 'uint', b: 'bool' } as const)[m[1] as ''], n: +m[2] };
  return null;
}
const matInfo = (t: Ty): { c: number; r: number } | null => {
  const m = /^mat([234])(?:x([234]))?$/.exec(t);
  return m ? { c: +m[1], r: +(m[2] ?? m[1]) } : null;
};
const vecOf = (base: string, n: number): Ty => (n === 1 ? base : `${{ float: '', int: 'i', uint: 'u', bool: 'b' }[base]}vec${n}`);
/** float-based: float, vecN, matrices */
const isFloaty = (t: Ty) => vecInfo(t)?.base === 'float' || !!matInfo(t);
/** what an int or uint (vector) converts to; null if it doesn't */
function toFloat(t: Ty): Ty | null {
  const v = vecInfo(t);
  return v && (v.base === 'int' || v.base === 'uint') ? vecOf('float', v.n) : null;
}
const isType = (s: string, structs: Map<string, Map<string, Ty>>) =>
  SCALARS.has(s) || s === 'void' || !!vecInfo(s) || !!matInfo(s) || /^[iu]?sampler\w+$/.test(s) || structs.has(s);

const QUALIFIERS = new Set(['const', 'in', 'out', 'inout', 'uniform', 'attribute', 'varying', 'flat', 'smooth', 'noperspective', 'centroid',
  'invariant', 'highp', 'mediump', 'lowp', 'precise', 'sample', 'patch', 'buffer', 'shared', 'coherent', 'volatile', 'restrict', 'readonly', 'writeonly']);

// ── built-in functions ──

/** genType functions where float arguments make int ones convert; result: the widest argument */
const GEN = new Set(['radians', 'degrees', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'asinh', 'acosh', 'atanh',
  'pow', 'exp', 'log', 'exp2', 'log2', 'sqrt', 'inversesqrt', 'abs', 'sign', 'floor', 'trunc', 'round', 'roundEven', 'ceil', 'fract', 'mod',
  'min', 'max', 'clamp', 'mix', 'step', 'smoothstep', 'normalize', 'faceforward', 'reflect', 'refract', 'dFdx', 'dFdy', 'fwidth', 'matrixCompMult',
  'transpose', 'inverse']);
/** functions on float vectors whose result is float */
const TO_FLOAT = new Set(['length', 'distance', 'dot', 'determinant']);
const COMPARE = new Set(['lessThan', 'lessThanEqual', 'greaterThan', 'greaterThanEqual', 'equal', 'notEqual']);
/** texture lookups: where the integer offset argument is (no conversion there) */
const TEXTURE: Record<string, number> = {
  texture: -1, textureProj: -1, textureLod: -1, textureGrad: -1, textureProjLod: -1, textureProjGrad: -1,
  textureOffset: 2, textureProjOffset: 2, textureLodOffset: 3, textureProjLodOffset: 3, textureGradOffset: 4, textureProjGradOffset: 4,
};
const INT_RESULT: Record<string, Ty> = { floatBitsToInt: 'int', floatBitsToUint: 'uint', packUnorm2x16: 'uint', packSnorm2x16: 'uint', packHalf2x16: 'uint' };

const BUILTIN_VARS: Record<string, Ty> = {
  gl_Position: 'vec4', gl_PointSize: 'float', gl_FragCoord: 'vec4', gl_FrontFacing: 'bool', gl_FragDepth: 'float', gl_PointCoord: 'vec2',
  gl_VertexID: 'int', gl_InstanceID: 'int', gl_MaxDrawBuffers: 'int', gl_MaxTextureImageUnits: 'int', gl_MaxVertexAttribs: 'int',
};

// ── parser and checker ──

interface Expr { t: Ty; a: number; b: number }
/** a: index of the first token, b: of the last */

interface Fn { params: Ty[]; ret: Ty }

class Checker {
  p = 0;
  scopes: Map<string, Ty>[] = [new Map(Object.entries(BUILTIN_VARS))];
  structs = new Map<string, Map<string, Ty>>();
  fns = new Map<string, Fn[]>();
  ret: Ty = 'void';
  /** wraps: [first token, last token, type name] */
  wraps: [number, number, Ty][] = [];

  constructor(readonly toks: Tok[]) {}

  peek(o = 0) { return this.toks[this.p + o]?.v; }
  next(): Tok { return this.toks[this.p++] ?? fail('unexpected end'); }
  eat(v: string): boolean { if (this.peek() === v) { this.p++; return true; } return false; }
  want(v: string) { if (!this.eat(v)) fail(`expected ${v} at ${this.toks[this.p]?.s}, got ${this.peek()}`); }

  lookup(name: string): Ty | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) { const t = this.scopes[i].get(name); if (t !== undefined) return t; }
    return undefined;
  }
  declare(name: string, t: Ty) { this.scopes[this.scopes.length - 1].set(name, t); }

  /** Make `e` a `want` if it's the int form of it. */
  coerce(e: Expr, want: Ty): Expr {
    if (e.t === want || want === UNKNOWN || e.t === UNKNOWN) return e;
    const f = toFloat(e.t);
    if (!f) return e;
    // scalar to scalar or same-size vector; matrices and scalar→vector aren't implicit conversions
    if (f === want) { this.wraps.push([e.a, e.b, f]); return { ...e, t: f }; }
    return e;
  }
  /** int (vector) to its float form, in an expression that mixes it with floats */
  promote(e: Expr): Expr {
    const f = toFloat(e.t);
    if (!f) return e;
    this.wraps.push([e.a, e.b, f]);
    return { ...e, t: f };
  }

  // ── declarations ──

  program() {
    while (this.p < this.toks.length) this.external();
  }

  skipLayout() {
    if (this.peek() !== 'layout') return;
    this.p++; this.want('(');
    let d = 1;
    while (d) { const v = this.next().v; if (v === '(') d++; else if (v === ')') d--; }
  }

  qualifiers(): string[] {
    const q: string[] = [];
    for (;;) {
      this.skipLayout();
      const v = this.peek();
      if (v && QUALIFIERS.has(v)) { q.push(v); this.p++; } else return q;
    }
  }

  /** A type: a name, or a struct definition; array suffix `[n]` after the type name. */
  type(): Ty {
    if (this.peek() === 'struct') return this.struct();
    const t = this.next();
    if (t.k !== 'id' || !isType(t.v, this.structs)) fail(`not a type: ${t.v}`);
    let ty: Ty = t.v;
    while (this.peek() === '[') { this.arraySize(); ty += '[]'; }
    return ty;
  }

  arraySize() {
    this.want('[');
    if (this.peek() !== ']') this.expr();
    this.want(']');
  }

  struct(): Ty {
    this.want('struct');
    const name = this.peek() !== '{' ? this.next().v : `_anon${this.p}`;
    this.want('{');
    const fields = new Map<string, Ty>();
    while (!this.eat('}')) {
      this.qualifiers();
      const ft = this.type();
      do {
        const n = this.next().v;
        let t = ft;
        while (this.peek() === '[') { this.arraySize(); t += '[]'; }
        fields.set(n, t);
      } while (this.eat(','));
      this.want(';');
    }
    this.structs.set(name, fields);
    return name;
  }

  external() {
    if (this.eat(';')) return;
    if (this.peek() === 'precision') { while (!this.eat(';')) this.p++; return; }
    const q = this.qualifiers();
    if (this.eat(';')) return; // `layout(...) in;`, `invariant gl_Position;` handled below
    // interface block: `uniform Name { ... } inst;`
    if (q.length && this.toks[this.p]?.k === 'id' && this.peek(1) === '{' && !isType(this.peek()!, this.structs)) {
      this.p++;
      this.want('{');
      const fields = new Map<string, Ty>();
      while (!this.eat('}')) {
        this.qualifiers();
        const ft = this.type();
        do { const n = this.next().v; let t = ft; while (this.peek() === '[') { this.arraySize(); t += '[]'; } fields.set(n, t); } while (this.eat(','));
        this.want(';');
      }
      if (this.peek() !== ';') {
        const inst = this.next().v;
        const sname = `_block${this.p}`;
        this.structs.set(sname, fields);
        let t: Ty = sname;
        while (this.peek() === '[') { this.arraySize(); t += '[]'; }
        this.declare(inst, t);
      } else for (const [n, t] of fields) this.declare(n, t);
      this.want(';');
      return;
    }
    // `invariant gl_Position;`
    if (q.includes('invariant') && this.toks[this.p]?.k === 'id' && !isType(this.peek()!, this.structs)) { while (!this.eat(';')) this.p++; return; }
    const ty = this.type();
    if (this.eat(';')) return; // struct definition alone
    const name = this.next();
    if (name.k !== 'id') fail('declarator');
    if (this.peek() === '(') { this.func(ty, name.v); return; }
    this.declarators(ty, name.v);
  }

  /** after the type and the first name */
  declarators(ty: Ty, first: string) {
    let name = first;
    for (;;) {
      let t = ty;
      while (this.peek() === '[') { this.arraySize(); t += '[]'; }
      if (this.eat('=')) this.initializer(t);
      this.declare(name, t);
      if (!this.eat(',')) break;
      name = this.next().v;
    }
    this.want(';');
  }

  initializer(t: Ty) {
    if (this.peek() === '{') { // GLSL 4.20 initializer lists: not in ES anyway
      fail('initializer list');
    }
    this.coerce(this.assign(), t);
  }

  func(ret: Ty, name: string) {
    this.want('(');
    const params: Ty[] = [];
    const names: [string, Ty][] = [];
    if (!(this.peek() === 'void' && this.peek(1) === ')')) {
      while (this.peek() !== ')') {
        this.qualifiers();
        let t = this.type();
        if (this.toks[this.p]?.k === 'id' && this.peek() !== ',' ) {
          const n = this.next().v;
          while (this.peek() === '[') { this.arraySize(); t += '[]'; }
          names.push([n, t]);
        }
        params.push(t);
        if (!this.eat(',')) break;
      }
    } else this.p++;
    this.want(')');
    const list = this.fns.get(name) ?? [];
    if (!list.some((f) => f.params.join() === params.join())) list.push({ params, ret });
    this.fns.set(name, list);
    if (this.eat(';')) return;
    this.scopes.push(new Map(names));
    this.ret = ret;
    this.block(false);
    this.scopes.pop();
  }

  // ── statements ──

  block(scope = true) {
    this.want('{');
    if (scope) this.scopes.push(new Map());
    while (!this.eat('}')) this.statement();
    if (scope) this.scopes.pop();
  }

  /** A declaration starts with a qualifier, a type, or a struct. */
  isDecl(): boolean {
    const v = this.peek();
    if (!v || this.toks[this.p].k !== 'id') return false;
    if (QUALIFIERS.has(v) || v === 'struct' || v === 'layout') return true;
    if (!isType(v, this.structs)) return false;
    // `vec3(...)` is a constructor; `vec3 x`, `vec3[2] x`, `float[](...)`
    if (this.peek(1) === '(') return false;
    if (this.peek(1) === '[') {
      let j = this.p + 1, d = 0;
      for (; j < this.toks.length; j++) { const w = this.toks[j].v; if (w === '[') d++; else if (w === ']' && --d === 0) break; }
      return this.toks[j + 1]?.v !== '(';
    }
    return true;
  }

  statement() {
    const v = this.peek();
    switch (v) {
      case '{': this.block(); return;
      case ';': this.p++; return;
      case 'if': {
        this.p++; this.want('('); this.expr(); this.want(')');
        this.scoped();
        if (this.eat('else')) this.scoped();
        return;
      }
      case 'for': {
        this.p++; this.want('(');
        this.scopes.push(new Map());
        if (!this.eat(';')) { if (this.isDecl()) this.localDecl(); else { this.expr(); this.want(';'); } }
        if (this.peek() !== ';') this.condition();
        this.want(';');
        if (this.peek() !== ')') this.expr();
        this.want(')');
        this.scoped();
        this.scopes.pop();
        return;
      }
      case 'while': {
        this.p++; this.want('(');
        this.scopes.push(new Map());
        this.condition();
        this.want(')');
        this.scoped();
        this.scopes.pop();
        return;
      }
      case 'do': this.p++; this.scoped(); this.want('while'); this.want('('); this.expr(); this.want(')'); this.want(';'); return;
      case 'switch': this.p++; this.want('('); this.expr(); this.want(')'); this.block(); return;
      case 'case': this.p++; this.expr(); this.want(':'); return;
      case 'default': this.p++; this.want(':'); return;
      case 'break': case 'continue': case 'discard': this.p++; this.want(';'); return;
      case 'precision': while (!this.eat(';')) this.p++; return;
      case 'return':
        this.p++;
        if (!this.eat(';')) { this.coerce(this.expr(), this.ret); this.want(';'); }
        return;
    }
    if (this.isDecl()) { this.localDecl(); return; }
    this.expr();
    this.want(';');
  }

  /** a statement with its own scope (if/for bodies) */
  scoped() { this.scopes.push(new Map()); this.statement(); this.scopes.pop(); }

  /** `while (bool b = ...)` and plain conditions */
  condition() {
    if (this.isDecl()) { this.qualifiers(); const t = this.type(); const n = this.next().v; this.want('='); this.initializer(t); this.declare(n, t); return; }
    this.expr();
  }

  localDecl() {
    this.qualifiers();
    const ty = this.type();
    if (this.eat(';')) return;
    this.declarators(ty, this.next().v);
  }

  // ── expressions ──

  expr(): Expr {
    let e = this.assign();
    while (this.peek() === ',') { this.p++; const r = this.assign(); e = { t: r.t, a: e.a, b: r.b }; }
    return e;
  }

  assign(): Expr {
    const l = this.ternary();
    const op = this.peek();
    if (op === '=' || (op && op.length >= 2 && op.endsWith('=') && !['==', '!=', '<=', '>='].includes(op))) {
      this.p++;
      let r = this.assign();
      if (op === '=' || op === '+=' || op === '-=') r = this.coerce(r, l.t);
      else if (op === '*=' || op === '/=') {
        // v *= 2, m *= 2: a scalar int with a float lvalue
        if (isFloaty(l.t) && toFloat(r.t)) r = this.coerce(r, toFloat(r.t) === 'float' ? 'float' : l.t);
      }
      return { t: l.t, a: l.a, b: r.b };
    }
    return l;
  }

  ternary(): Expr {
    const c = this.binary(0);
    if (!this.eat('?')) return c;
    let x = this.assign();
    this.want(':');
    let y = this.assign();
    if (isFloaty(x.t) && toFloat(y.t)) y = this.coerce(y, x.t);
    else if (isFloaty(y.t) && toFloat(x.t)) x = this.coerce(x, y.t);
    return { t: x.t === UNKNOWN ? y.t : x.t, a: c.a, b: y.b };
  }

  static LEVELS = [['||'], ['^^'], ['&&'], ['|'], ['^'], ['&'], ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'], ['+', '-'], ['*', '/', '%']];

  binary(l: number): Expr {
    if (l === Checker.LEVELS.length) return this.unary();
    let a = this.binary(l + 1);
    while (Checker.LEVELS[l].includes(this.peek() ?? '')) {
      const op = this.next().v;
      let b = this.binary(l + 1);
      // mixed int and float operands: the int side converts
      if (!['||', '^^', '&&', '|', '^', '&', '<<', '>>', '%'].includes(op)) {
        if (isFloaty(a.t) && toFloat(b.t)) b = this.promote(b);
        else if (isFloaty(b.t) && toFloat(a.t)) a = this.promote(a);
      }
      a = { t: binaryType(op, a.t, b.t), a: a.a, b: b.b };
    }
    return a;
  }

  unary(): Expr {
    const v = this.peek();
    if (v === '+' || v === '-' || v === '~' || v === '++' || v === '--') {
      const a = this.p++;
      const e = this.unary();
      return { t: e.t, a, b: e.b };
    }
    if (v === '!') { const a = this.p++; const e = this.unary(); return { t: 'bool', a, b: e.b }; }
    return this.postfix(this.primary());
  }

  postfix(e: Expr): Expr {
    for (;;) {
      const v = this.peek();
      if (v === '[') {
        this.p++; this.expr(); const b = this.p; this.want(']');
        e = { t: indexType(e.t), a: e.a, b };
      } else if (v === '.') {
        this.p++;
        const f = this.next();
        if (f.v === 'length' && this.peek() === '(') { this.p++; const b = this.p; this.want(')'); e = { t: 'int', a: e.a, b }; continue; }
        e = { t: this.fieldType(e.t, f.v), a: e.a, b: this.p - 1 };
      } else if (v === '++' || v === '--') { e = { ...e, b: this.p++ }; } else return e;
    }
  }

  fieldType(t: Ty, f: string): Ty {
    const s = this.structs.get(t);
    if (s) return s.get(f) ?? UNKNOWN;
    const vi = vecInfo(t);
    if (vi && /^([xyzw]{1,4}|[rgba]{1,4}|[stpq]{1,4})$/.test(f)) return vecOf(vi.base, f.length);
    return UNKNOWN;
  }

  primary(): Expr {
    const t = this.next();
    const a = this.p - 1;
    if (t.k === 'num') return { t: literalType(t.v), a, b: a };
    if (t.v === '(') { const e = this.expr(); const b = this.p; this.want(')'); return { t: e.t, a, b }; }
    if (t.k !== 'id') fail(`unexpected ${t.v}`);
    if (t.v === 'true' || t.v === 'false') return { t: 'bool', a, b: a };
    // constructors: T(...), T[n](...)
    if (isType(t.v, this.structs)) {
      let ty: Ty = t.v;
      while (this.peek() === '[') { this.arraySize(); ty += '[]'; }
      const args = this.args();
      const b = this.p - 1;
      if (isArray(ty)) { const el = ty.slice(0, -2); for (const x of args) this.coerce(x, el); }
      else { const s = this.structs.get(ty); if (s) [...s.values()].forEach((ft, i) => args[i] && this.coerce(args[i], ft)); }
      return { t: ty, a, b };
    }
    if (this.peek() === '(') {
      const args = this.args();
      return { t: this.call(t.v, args), a, b: this.p - 1 };
    }
    return { t: this.lookup(t.v) ?? UNKNOWN, a, b: a };
  }

  args(): Expr[] {
    this.want('(');
    const out: Expr[] = [];
    if (this.peek() === 'void' && this.peek(1) === ')') this.p++;
    while (!this.eat(')')) {
      out.push(this.assign());
      if (!this.eat(',') && this.peek() !== ')') fail('argument list');
    }
    return out;
  }

  call(name: string, args: Expr[]): Ty {
    const user = this.fns.get(name);
    if (user) {
      const same = user.filter((f) => f.params.length === args.length);
      const exact = same.find((f) => f.params.every((p, i) => p === args[i].t || args[i].t === UNKNOWN));
      if (exact) return exact.ret;
      const conv = same.find((f) => f.params.every((p, i) => p === args[i].t || args[i].t === UNKNOWN || toFloat(args[i].t) === p));
      if (conv) { conv.params.forEach((p, i) => this.coerce(args[i], p)); return conv.ret; }
      return same.length === 1 ? same[0].ret : UNKNOWN;
    }
    const types = args.map((x) => x.t);
    if (GEN.has(name)) {
      // mix's bool selector and nothing else stays as it is
      const anyFloat = types.some(isFloaty);
      if (anyFloat) args.forEach((x, i) => { if (!(name === 'mix' && i === 2 && vecInfo(x.t)?.base === 'bool')) args[i] = this.promote(x); });
      return widest(args.map((x) => x.t));
    }
    if (TO_FLOAT.has(name)) { args.forEach((x, i) => { args[i] = this.promote(x); }); return 'float'; }
    if (name === 'cross') { args.forEach((x, i) => { args[i] = this.promote(x); }); return 'vec3'; }
    if (name === 'outerProduct') { args.forEach((x, i) => { args[i] = this.promote(x); }); const [c, r] = [vecInfo(args[1]?.t ?? '')?.n, vecInfo(args[0]?.t ?? '')?.n]; return c && r ? (c === r ? `mat${c}` : `mat${c}x${r}`) : UNKNOWN; }
    if (COMPARE.has(name)) {
      if (types.some(isFloaty)) args.forEach((x, i) => { args[i] = this.promote(x); });
      const n = vecInfo(args[0]?.t ?? '')?.n;
      return n ? vecOf('bool', n) : UNKNOWN;
    }
    if (name === 'any' || name === 'all') return 'bool';
    if (name === 'not') return types[0] ?? UNKNOWN;
    if (name in TEXTURE) {
      const off = TEXTURE[name];
      args.forEach((x, i) => { if (i > 0 && i !== off) args[i] = this.promote(x); });
      return samplerResult(types[0] ?? UNKNOWN);
    }
    if (name === 'texelFetch' || name === 'texelFetchOffset') return samplerResult(types[0] ?? UNKNOWN);
    if (name === 'textureSize') { const s = types[0] ?? ''; return /Cube|2D(?!Array)|Rect/.test(s) && !/3D|Array/.test(s) ? 'ivec2' : /1D(?!Array)/.test(s) ? 'int' : 'ivec3'; }
    if (name in INT_RESULT) return INT_RESULT[name];
    if (name === 'intBitsToFloat' || name === 'uintBitsToFloat') { const n = vecInfo(types[0] ?? '')?.n; return n ? vecOf('float', n) : UNKNOWN; }
    if (name === 'unpackUnorm2x16' || name === 'unpackSnorm2x16' || name === 'unpackHalf2x16') return 'vec2';
    return UNKNOWN;
  }
}

function literalType(v: string): Ty {
  if (/^0[xX]/.test(v)) return /[uU]$/.test(v) ? 'uint' : 'int';
  if (/[.eE]|[fF]$|lf$|LF$/.test(v)) return 'float';
  return /[uU]$/.test(v) ? 'uint' : 'int';
}

function indexType(t: Ty): Ty {
  if (isArray(t)) return t.slice(0, -2);
  const v = vecInfo(t);
  if (v && v.n > 1) return v.base;
  const m = matInfo(t);
  if (m) return `vec${m.r}`;
  return UNKNOWN;
}

/** The widest of genType arguments (a vector over a scalar). */
function widest(ts: Ty[]): Ty {
  let best: Ty = UNKNOWN;
  let n = 0;
  for (const t of ts) {
    const v = vecInfo(t);
    const size = v ? v.n : matInfo(t) ? 16 : 0;
    if (t !== UNKNOWN && size > n) { best = t; n = size; }
  }
  return ts.includes(UNKNOWN) && n <= 1 ? UNKNOWN : best;
}

function samplerResult(s: Ty): Ty {
  if (/Shadow$/.test(s)) return 'float';
  if (/^isampler/.test(s)) return 'ivec4';
  if (/^usampler/.test(s)) return 'uvec4';
  if (/^sampler/.test(s)) return 'vec4';
  return UNKNOWN;
}

function binaryType(op: string, a: Ty, b: Ty): Ty {
  if (['||', '^^', '&&', '==', '!=', '<', '>', '<=', '>='].includes(op)) return 'bool';
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if (op === '<<' || op === '>>') return a;
  const ma = matInfo(a), mb = matInfo(b), va = vecInfo(a), vb = vecInfo(b);
  if (op === '*' && ma && mb) return ma.c === mb.r ? (mb.c === ma.r ? `mat${mb.c}` : `mat${mb.c}x${ma.r}`) : UNKNOWN;
  if (op === '*' && ma && vb && vb.n > 1) return vecOf('float', ma.r);
  if (op === '*' && va && va.n > 1 && mb) return vecOf('float', mb.c);
  if (ma) return a;
  if (mb) return b;
  if (va && vb) return va.n >= vb.n ? a : b;
  return UNKNOWN;
}

/**
 * Makes desktop GLSL's implicit int→float conversions explicit. Returns the
 * source with constructors inserted, or the source unchanged (with the
 * reason) when it can't parse it.
 */
export function explicitConversions(src: string): { source: string; changed: number; error?: string } {
  let toks: Tok[], invs: Invocation[];
  const c = (() => {
    try {
      ({ toks, invs } = preprocess(src));
      const ch = new Checker(toks);
      ch.program();
      return ch;
    } catch (e) {
      if (e instanceof Fail) return e.message;
      throw e;
    }
  })();
  if (typeof c === 'string') return { source: src, changed: 0, error: c };
  if (!c.wraps.length) return { source: src, changed: 0 };
  toks = toks!; invs = invs!;

  // the same span wrapped twice (a coerce after a promote) needs one constructor
  const seen = new Set<string>();
  const wraps = c.wraps.filter(([a, b]) => { const k = `${a},${b}`; if (seen.has(k)) return false; seen.add(k); return true; });

  // insertions before/after tokens; a token inside a macro use (other than its first or last) inlines that use
  const before = new Map<number, string[]>(), after = new Map<number, string[]>();
  const inline = new Set<number>();
  for (const [a, b, ty] of wraps) {
    (before.get(a) ?? before.set(a, []).get(a)!).push(`${ty}(`);
    (after.get(b) ?? after.set(b, []).get(b)!).push(')');
    const ta = toks[a], tb = toks[b];
    if (ta.inv && invs[ta.inv].first !== a) inline.add(ta.inv);
    if (tb.inv && invs[tb.inv].last !== b) inline.add(tb.inv);
    if (ta.inv && tb.inv && ta.inv === tb.inv && (invs[ta.inv].first !== a || invs[ta.inv].last !== b)) inline.add(ta.inv);
  }
  // outer wraps open first: each token's openers by span length, longest first (closers are all ')')
  for (const i of before.keys()) {
    before.set(i, wraps.filter(([a]) => a === i).sort((x, y) => (y[1] - y[0]) - (x[1] - x[0])).map(([, , ty]) => `${ty}(`));
  }

  const text = (i: number) => `${(before.get(i) ?? []).join('')}${toks[i].v}${(after.get(i) ?? []).join('')}`;
  let out = '';
  let pos = 0;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.inv) {
      const inv = invs[t.inv];
      if (i !== inv.first) continue;
      out += src.slice(pos, inv.s);
      if (inline.has(t.inv)) {
        const parts: string[] = [];
        for (let j = inv.first; j <= inv.last; j++) parts.push(text(j));
        out += parts.join(' '); // as the parser saw it
      } else {
        out += (before.get(inv.first) ?? []).join('') + src.slice(inv.s, inv.e) + (after.get(inv.last) ?? []).join('');
      }
      pos = inv.e;
      continue;
    }
    if (!before.has(i) && !after.has(i)) continue;
    out += src.slice(pos, t.s) + text(i);
    pos = t.e;
  }
  out += src.slice(pos);
  return { source: out, changed: wraps.length };
}
