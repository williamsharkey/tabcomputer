/**
 * Vim's ex commands over a buffer, for vi/vim/ex run without a terminal
 * (`vim -c '%s/a/b/g' -c wq f`, `vim -es`, `ex -s f <<EOF`) and for the
 * editor's own : line. Ranges (N, ., $, %, /pat/, ?pat?, 'x, +-N, `,` and
 * `;`), | between commands; s (Vim regexes: magic, \v, \V, \c, \zs/\ze,
 * \< \>, \{n,m}; & \1 \r \u \U \l \L \e in the replacement; flags g i I e n
 * and a count), &, g/v, d, y, pu, m, t/co, j, > <, norm (A I a i o O x dd D
 * J 0 ^ $), sor (! i n u r /pat/), w (file, >>, a range), wq, x, up, q, qa,
 * cq, e!, r (file or !cmd), {range}!cmd, p, nu, #, l, =, a/i/c (script
 * text up to "."), k/ma, set (ff=, ignorecase), sil, exe "...".
 */

/** A buffer line: an object, so :g can follow its lines through edits */
export interface Line { t: string }

export interface ExBuffer {
  lines: Line[];
  /** The current line, 0-based */
  cur: number;
  modified: boolean;
  /** The buffer's file: as given, and its absolute path ('' for none) */
  name: string;
  path: string;
  crlf: boolean;
  /** A new, empty buffer still is one: it writes no newline */
  empty: boolean;
  marks: Map<string, Line>;
  register: string[];
  lastPattern: string | null;
  lastSub: { pat: string; rep: string; flags: string } | null;
  ignorecase: boolean;
}

export interface ExHost {
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, text: string, append: boolean): Promise<void>;
  resolve(path: string): string;
  /** Output of :p, :nu, :l */
  print(s: string): void;
  /** Messages (:=, :s///n's count): none in silent mode */
  message(s: string): void;
  /** Run a shell command with this input, its output back (:r !cmd, :{range}!cmd) */
  run?(cmd: string, input: string): Promise<string>;
  /** More script lines, for a/i/c in a script (null at the end) */
  nextLine?(): string | null;
}

export class ExError extends Error {}

export type ExResult = { quit: false } | { quit: true; code: number };

export function newBuffer(name: string, path: string, text: string | null): ExBuffer {
  const crlf = !!text && /\r\n/.test(text) && text.split('\n').slice(0, -1).every((l) => l.endsWith('\r'));
  let body = text ?? '';
  if (crlf) body = body.replace(/\r\n/g, '\n');
  const parts = body === '' ? [''] : body.replace(/\n$/, '').split('\n');
  return {
    lines: parts.map((t) => ({ t })), cur: 0, modified: false, name, path, crlf, empty: body === '',
    marks: new Map(), register: [], lastPattern: null, lastSub: null, ignorecase: false,
  };
}

export function bufferText(buf: ExBuffer): string {
  if (buf.empty && buf.lines.length === 1 && buf.lines[0].t === '') return '';
  const nl = buf.crlf ? '\r\n' : '\n';
  return buf.lines.map((l) => l.t).join(nl) + nl;
}

const POSIX: Record<string, string> = {
  alnum: 'a-zA-Z0-9', alpha: 'a-zA-Z', blank: ' \\t', cntrl: '\\x00-\\x1f\\x7f', digit: '0-9', graph: '!-~',
  lower: 'a-z', print: ' -~', punct: '!-\\/:-@\\[-`{-~', space: ' \\t\\n\\r\\f\\v', upper: 'A-Z', xdigit: '0-9A-Fa-f',
};
const CLASS: Record<string, string> = {
  s: '[ \\t]', S: '[^ \\t]', d: '\\d', D: '\\D', w: '[0-9A-Za-z_]', W: '[^0-9A-Za-z_]', a: '[A-Za-z]', A: '[^A-Za-z]',
  l: '[a-z]', L: '[^a-z]', u: '[A-Z]', U: '[^A-Z]', x: '[0-9A-Fa-f]', X: '[^0-9A-Fa-f]', h: '[A-Za-z_]', H: '[^A-Za-z_]',
  o: '[0-7]', O: '[^0-7]', k: '[A-Za-z0-9_]', i: '[A-Za-z0-9_]', f: '[\\w.\\/~-]', p: '[ -~]',
};

/** A Vim pattern as a JavaScript regex source, and whether \c / \C set the case */
export function vimRegex(pat: string): { src: string; ci: boolean | null; multiline: boolean; full: string; prefix: string | null } {
  let mode: 'magic' | 'very' | 'nomagic' = 'magic';
  let ci: boolean | null = null;
  let out = '';
  let zs = -1, ze = -1;
  let multiline = false;
  const esc = (c: string) => c.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\' && i + 1 < pat.length) {
      const n = pat[++i];
      if (n === 'v') { mode = 'very'; continue; }
      if (n === 'm') { mode = 'magic'; continue; }
      if (n === 'V' || n === 'M') { mode = 'nomagic'; continue; }
      if (n === 'c') { ci = true; continue; }
      if (n === 'C') { ci = false; continue; }
      if (n === 'z' && (pat[i + 1] === 's' || pat[i + 1] === 'e')) { if (pat[++i] === 's') zs = out.length; else ze = out.length; continue; }
      if (n === 'n') { out += '\\n'; multiline = true; continue; }
      if (n === 't') { out += '\\t'; continue; }
      if (n === 'e') { out += '\\x1b'; continue; }
      if (n === 'r') { out += '\\r'; continue; }
      if (n === '_' && pat[i + 1]) {
        const k = pat[++i];
        multiline = true;
        out += k === '.' ? '[\\s\\S]' : k === 's' ? '\\s' : CLASS[k] ? CLASS[k].replace(/^\[(\^?)/, '[$1\\n') : esc(k);
        continue;
      }
      if (CLASS[n]) { out += CLASS[n]; continue; }
      if (n === '%' && pat[i + 1] === '(') { i++; out += '(?:'; continue; }
      if (n === '%' && pat[i + 1] === '[') { i++; out += '(?:'; continue; } // (an optional sequence: approximate)
      const magicOps = mode !== 'very';
      if (magicOps && n === '(') { out += '('; continue; }
      if (magicOps && n === ')') { out += ')'; continue; }
      if (magicOps && n === '|') { out += '|'; continue; }
      if (magicOps && n === '+') { out += '+'; continue; }
      if (magicOps && (n === '=' || n === '?')) { out += '?'; continue; }
      if (magicOps && (n === '<' || n === '>')) { out += '\\b'; continue; }
      if (magicOps && n === '{') { const r = braces(pat, i); out += r.q; i = r.end; continue; }
      if (mode === 'nomagic' && (n === '.' || n === '*' || n === '[' || n === '~')) {
        if (n === '.') out += '.'; else if (n === '*') out += '*'; else if (n === '[') { const r = bracket(pat, i); out += r.cls; i = r.end; } else out += '~';
        continue;
      }
      if (/\d/.test(n)) { out += '\\' + n; continue; }
      out += esc(n);
      continue;
    }
    if (mode === 'very') {
      if (c === '(' && pat[i + 1] !== '?') { out += '('; continue; }
      if (c === '%' && pat[i + 1] === '(') { i++; out += '(?:'; continue; }
      if (c === ')' || c === '|' || c === '+' || c === '?') { out += c; continue; }
      if (c === '=') { out += '?'; continue; }
      if (c === '<' || c === '>') { out += '\\b'; continue; }
      if (c === '{') { const r = braces(pat, i - 1, true); out += r.q; i = r.end; continue; }
    }
    if (mode === 'nomagic') {
      if (c === '^' && i === 0) { out += '^'; continue; }
      if (c === '$' && i === pat.length - 1) { out += '$'; continue; }
      out += esc(c);
      continue;
    }
    if (c === '[') { const r = bracket(pat, i); out += r.cls; i = r.end; continue; }
    if (c === '~') { out += '~'; continue; }
    if (c === '.' || c === '*' || c === '^' || c === '$') { out += c; continue; }
    out += esc(c);
  }
  if (ze >= 0) out = out.slice(0, ze) + '(?=' + out.slice(ze) + ')';
  // \zs: a lookbehind for searches; :s matches the prefix too and replaces after it
  const prefix = zs >= 0 ? out.slice(0, zs) : null;
  const full = out;
  if (zs >= 0) out = '(?<=' + out.slice(0, zs) + ')' + out.slice(zs);
  return { src: out, ci, multiline, full, prefix };
}

/** \{n,m} / \{-n,m} (at i: the '{'; very magic: no backslash) → a JS quantifier */
function braces(pat: string, i: number, very = false): { q: string; end: number } {
  const start = very ? i + 2 : i + 1;
  const close = pat.indexOf('}', start);
  if (close < 0) return { q: '\\{', end: i };
  let body = pat.slice(start, close).replace(/\\$/, '');
  const lazy = body.startsWith('-');
  if (lazy) body = body.slice(1);
  const q = body === '' ? '*' : /^\d+$/.test(body) ? `{${body}}` : /^,\d*$/.test(body) ? `{0${body}}` : `{${body}}`;
  return { q: q + (lazy ? '?' : ''), end: close };
}

/** [...] from i: POSIX classes and \e \t \n \\ \] inside */
function bracket(pat: string, i: number): { cls: string; end: number } {
  let j = i + 1;
  let cls = '[';
  if (pat[j] === '^') { cls += '^'; j++; }
  if (pat[j] === ']') { cls += '\\]'; j++; }
  for (; j < pat.length && pat[j] !== ']'; j++) {
    const c = pat[j];
    if (c === '[' && pat[j + 1] === ':') {
      const close = pat.indexOf(':]', j + 2);
      if (close > 0) { cls += POSIX[pat.slice(j + 2, close)] ?? ''; j = close + 1; continue; }
    }
    if (c === '\\' && j + 1 < pat.length) {
      const n = pat[++j];
      cls += n === 'e' ? '\\x1b' : n === 't' ? '\\t' : n === 'n' ? '\\n' : n === 'r' ? '\\r' : n === 'd' ? '0-9' : '\\' + n;
      continue;
    }
    cls += c === '[' || c === '/' ? '\\' + c : c;
  }
  if (j >= pat.length) return { cls: '\\[', end: i };
  return { cls: cls + ']', end: j };
}

/** The replacement for one match: & \0-\9 ~ \r (a line break) \n (a NUL) \t \u \U \l \L \e \E */
function expandRep(rep: string, m: RegExpExecArray, prev: string): string {
  let out = '';
  let one: 'u' | 'l' | null = null;
  let all: 'U' | 'L' | null = null;
  const add = (s: string) => {
    for (const ch of s) {
      let c = all === 'U' ? ch.toUpperCase() : all === 'L' ? ch.toLowerCase() : ch;
      if (one) { c = one === 'u' ? c.toUpperCase() : c.toLowerCase(); one = null; }
      out += c;
    }
  };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '&') { add(m[0]); continue; }
    if (c === '~') { add(prev); continue; }
    if (c !== '\\' || i + 1 >= rep.length) { add(c); continue; }
    const n = rep[++i];
    if (/\d/.test(n)) add(m[Number(n)] ?? '');
    else if (n === 'r') out += '\n';
    else if (n === 'n') out += '\0';
    else if (n === 't') out += '\t';
    else if (n === 'u' || n === 'l') one = n;
    else if (n === 'U' || n === 'L') all = n;
    else if (n === 'e' || n === 'E') { all = null; one = null; }
    else add(n);
  }
  return out;
}

/** The text up to an unescaped delimiter (or the end), and what follows it */
function until(s: string, i: number, delim: string): { text: string; end: number; closed: boolean } {
  let text = '';
  for (; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      if (s[i + 1] === delim && delim !== '\\') { text += delim === '/' || delim === '?' ? '\\' + delim : delim; i++; continue; }
      text += s[i] + s[i + 1]; i++; continue;
    }
    if (s[i] === delim) return { text, end: i + 1, closed: true };
    text += s[i];
  }
  return { text, end: i, closed: false };
}

// command names: the full name and the shortest abbreviation, earlier ones first
const NAMES: [string, number][] = [
  ['substitute', 1], ['global', 1], ['vglobal', 1], ['delete', 1], ['print', 1], ['change', 1], ['join', 1],
  ['move', 1], ['read', 1], ['xit', 1], ['quit', 1], ['edit', 1], ['undo', 1], ['insert', 1], ['append', 1],
  ['list', 1], ['t', 1], ['k', 1], ['yank', 1], ['write', 1], ['wq', 2], ['wall', 2], ['wqall', 3], ['xall', 2],
  ['exit', 3], ['qall', 2], ['quitall', 5], ['cquit', 2], ['copy', 2], ['number', 2], ['put', 2], ['mark', 2],
  ['update', 2], ['set', 2], ['nohlsearch', 3], ['normal', 4], ['sort', 3], ['silent', 3], ['execute', 3],
  ['echo', 2], ['redo', 3], ['retab', 3], ['left', 2], ['right', 2], ['center', 2], ['keepjumps', 5],
  ['keeppatterns', 5], ['noautocmd', 3], ['file', 1], ['buffers', 7], ['let', 3], ['syntax', 2], ['filetype', 5],
];
const ABBREV = new Map<string, string>();
for (const [full, min] of NAMES) for (let n = min; n <= full.length; n++) if (!ABBREV.has(full.slice(0, n))) ABBREV.set(full.slice(0, n), full);

export class ExSession {
  constructor(public buf: ExBuffer, public host: ExHost) {}

  private get last() { return this.buf.lines.length - 1; }

  private search(pat: string, from: number, backward: boolean): number {
    const re = this.regex(pat, '');
    const n = this.buf.lines.length;
    for (let k = 1; k <= n; k++) {
      const i = backward ? (from - k + n * 2) % n : (from + k) % n;
      re.lastIndex = 0;
      if (re.test(this.buf.lines[i].t)) return i;
    }
    throw new ExError(`E486: Pattern not found: ${pat}`);
  }

  regex(pat: string, flags: string): RegExp {
    if (pat === '') {
      if (this.buf.lastPattern === null) throw new ExError('E35: No previous regular expression');
      pat = this.buf.lastPattern;
    }
    this.buf.lastPattern = pat;
    const r = vimRegex(pat);
    const ci = flags.includes('I') ? false : flags.includes('i') ? true : r.ci ?? this.buf.ignorecase;
    try { return new RegExp(r.src, 'g' + (ci ? 'i' : '')); }
    catch { throw new ExError(`E486: Pattern not found: ${pat}`); }
  }

  /** One address at s[i]: its line (0-based, -1 for line 0) and where it ends */
  private address(s: string, i: number, base: number): { line: number; end: number } | null {
    let line: number | null = null;
    const c = s[i];
    if (c === '.') { line = base; i++; }
    else if (c === '$') { line = this.last; i++; }
    else if (c !== undefined && /\d/.test(c)) { const m = /^\d+/.exec(s.slice(i))!; line = Number(m[0]) - 1; i += m[0].length; }
    else if (c === "'" && s[i + 1]) {
      const mk = s[i + 1];
      i += 2;
      if (mk === '<' || mk === '>') line = mk === '<' ? 0 : this.last;
      else {
        const l = this.buf.marks.get(mk);
        const at = l ? this.buf.lines.indexOf(l) : -1;
        if (at < 0) throw new ExError('E20: Mark not set');
        line = at;
      }
    } else if (c === '/' || c === '?') {
      const r = until(s, i + 1, c);
      line = this.search(r.text, base, c === '?');
      i = r.end;
    } else if (c === '\\' && (s[i + 1] === '/' || s[i + 1] === '?')) {
      line = this.search('', base, s[i + 1] === '?');
      i += 2;
    }
    // offsets: +N -N, + alone is 1
    while (s[i] === '+' || s[i] === '-') {
      const sign = s[i] === '+' ? 1 : -1;
      const m = /^\d+/.exec(s.slice(i + 1));
      const n = m ? Number(m[0]) : 1;
      line = (line ?? base) + sign * n;
      i += 1 + (m ? m[0].length : 0);
    }
    return line === null ? null : { line, end: i };
  }

  /** Run one command line (commands split at |); a quit ends it */
  async run(cmdline: string): Promise<ExResult> {
    const s = cmdline;
    let i = 0;
    while (true) {
      while (s[i] === ':' || s[i] === ' ' || s[i] === '\t') i++;
      if (i >= s.length) return { quit: false };
      if (s[i] === '"') return { quit: false }; // a comment
      const r = await this.one(s, i);
      if (r.result.quit) return r.result;
      if (r.end >= s.length) return { quit: false };
      i = r.end;
    }
  }

  private checkLine(n: number) {
    if (n < 0 || n > this.last) throw new ExError('E16: Invalid range');
  }

  /** One command at s[i]; returns where the next one (after a |) starts */
  private async one(s: string, i: number): Promise<{ result: ExResult; end: number }> {
    const buf = this.buf;
    // the range
    let from: number | null = null, to: number | null = null;
    let given = 0;
    if (s[i] === '%') { from = 0; to = this.last; given = 2; i++; }
    else {
      let base = buf.cur;
      while (true) {
        const a = this.address(s, i, base);
        if (!a) {
          if (s[i] === ',' || s[i] === ';') { // an empty address is the current line
            if (given === 0) { from = buf.cur; given = 1; }
          } else break;
        } else {
          i = a.end;
          if (given === 0) { from = a.line; given = 1; } else { from = to ?? from; to = a.line; given = 2; }
        }
        if (s[i] === ',' || s[i] === ';') {
          if (s[i] === ';' && from !== null) { base = to ?? from; buf.cur = Math.max(0, Math.min(base, this.last)); }
          i++;
          const b = this.address(s, i, base);
          if (b) { i = b.end; if (to === null) { to = b.line; } else { from = to; to = b.line; } given = 2; }
          else { to = buf.cur; given = 2; }
          if (s[i] === ',' || s[i] === ';') continue;
        }
        break;
      }
      if (given === 1) to = from;
    }
    // the command name
    while (s[i] === ' ') i++;
    let name = '';
    const m = /^[a-zA-Z]+/.exec(s.slice(i));
    if (m) {
      name = m[0];
      // a mark after k needs no space (:ka); :s, :g and :v run into their delimiter anyway
      if (!ABBREV.has(name) && name[0] === 'k' && name.length === 2) name = 'k';
      i += name.length;
    } else if (s[i] && '&<>=!#~@*'.includes(s[i])) {
      name = s[i];
      i++;
      if ((name === '<' || name === '>' || name === '&') && s[i] === name) { while (s[i] === name) { name += s[i]; i++; } }
    }
    const cmd = name === '' ? '' : (ABBREV.get(name) ?? (/^[&<>=!#~@*]+$/.test(name) ? name : null));
    if (cmd === null) throw new ExError(`E492: Not an editor command: ${s.slice(i - name.length).replace(/\|.*$/, '')}`);
    let bang = false;
    if (s[i] === '!' && cmd !== '!' && cmd !== 'substitute' && cmd !== '') { bang = true; i++; }
    // the argument: to an unescaped | (all of it for :g, :normal, :!, :execute)
    const whole = ['global', 'vglobal', 'normal', '!', 'execute', 'silent', 'keepjumps', 'keeppatterns', 'noautocmd'].includes(cmd);
    let arg: string, end: number;
    if (whole || (cmd === 'read' && /^\s*!/.test(s.slice(i)))) { arg = s.slice(i); end = s.length; }
    else {
      let k = i;
      // :s/pat/rep/: a | inside the pattern or the replacement is theirs
      if (cmd === 'substitute' && s[k] && !/[\s\w"|&]/.test(s[k])) {
        const p = until(s, k + 1, s[k]);
        k = p.closed ? until(s, p.end, s[k]).end : p.end;
      }
      let a = s.slice(i, k);
      for (; k < s.length; k++) {
        if (s[k] === '\\' && s[k + 1] === '|') { a += '|'; k++; continue; }
        if (s[k] === '|') break;
        a += s[k];
      }
      arg = a; end = k < s.length ? k + 1 : k;
    }
    const lo = from ?? buf.cur, hi = to ?? lo;
    const result = await this.exec(cmd, bang, arg, given, Math.min(lo, hi), Math.max(lo, hi));
    return { result, end };
  }

  private setLines(at: number, count: number, texts: string[]): void {
    this.buf.lines.splice(at, count, ...texts.map((t) => ({ t })));
    if (!this.buf.lines.length) this.buf.lines.push({ t: '' });
    this.buf.modified = true;
    this.buf.empty = false;
  }

  private async write(path: string, text: string, append: boolean) {
    await this.host.writeFile(path, text, append);
  }

  private async exec(cmd: string, bang: boolean, arg: string, given: number, from: number, to: number): Promise<ExResult> {
    const buf = this.buf;
    const a = arg.trim();
    const range = () => { this.checkLine(from); this.checkLine(to); };
    switch (cmd) {
      case '': {
        // a bare address: go there
        if (given) { const n = Math.max(0, Math.min(to, this.last)); buf.cur = n; }
        return { quit: false };
      }
      case 'substitute': case '&': case '&&': case '~': {
        let pat: string, rep: string, flags: string;
        let rest = arg;
        if (cmd === 'substitute' && rest.length && !/^[\s\w"|&]/.test(rest[0])) {
          const delim = rest[0];
          const p = until(rest, 1, delim);
          const r = until(rest, p.end, delim);
          pat = p.text; rep = r.text;
          rest = r.closed ? rest.slice(r.end) : '';
          if (rep === '~' && buf.lastSub) rep = buf.lastSub.rep;
          const fm = /^\s*([&cegiInp#lr]*)\s*(\d*)\s*$/.exec(rest);
          if (!fm) throw new ExError('E488: Trailing characters');
          flags = fm[1];
          if (flags.startsWith('&') && buf.lastSub) flags = buf.lastSub.flags + flags.slice(1);
          if (fm[2]) { from = to; to = Math.min(this.last, from + Number(fm[2]) - 1); }
        } else {
          if (!buf.lastSub) throw new ExError('E35: No previous regular expression');
          pat = buf.lastSub.pat; rep = buf.lastSub.rep;
          const fm = /^\s*([&cegiInp#lr]*)\s*(\d*)\s*$/.exec(rest) ?? ['', '', ''];
          flags = fm[1].startsWith('&') || cmd === '&&' ? buf.lastSub.flags + fm[1].replace(/^&/, '') : fm[1];
        }
        range();
        const prevRep = buf.lastSub?.rep ?? '';
        buf.lastSub = { pat: pat === '' ? (buf.lastPattern ?? '') : pat, rep, flags };
        const re = this.regex(pat, flags);
        const global = flags.includes('g');
        const countOnly = flags.includes('n');
        let matches = 0, lastLine = -1;
        const countLines = new Set<number>();
        const multiline = vimRegex(pat === '' ? buf.lastPattern ?? '' : pat).multiline;
        if (multiline) {
          // a pattern with \n: over the range's text, joined
          const texts = buf.lines.slice(from, to + 1).map((l) => l.t);
          const text = texts.join('\n') + '\n';
          const starts: number[] = [];
          for (let k = 0, off = 0; k < texts.length; k++) { starts.push(off); off += texts[k].length + 1; }
          let out = '', at = 0;
          const doneLines = new Set<number>();
          re.lastIndex = 0;
          let mm: RegExpExecArray | null;
          while ((mm = re.exec(text)) !== null) {
            if (mm[0] === '' && mm.index >= text.length) break;
            let ln = 0;
            while (ln + 1 < starts.length && starts[ln + 1] <= mm.index) ln++;
            if (!global && doneLines.has(ln)) { if (mm[0] === '') re.lastIndex++; continue; }
            doneLines.add(ln);
            matches++;
            lastLine = from + ln;
            out += text.slice(at, mm.index) + expandRep(rep, mm, prevRep);
            at = mm.index + mm[0].length;
            if (mm[0] === '') re.lastIndex++;
          }
          if (!matches) { if (flags.includes('e')) return { quit: false }; throw new ExError(`E486: Pattern not found: ${pat}`); }
          if (countOnly) { this.host.message(`${matches} match${matches === 1 ? '' : 'es'}\n`); return { quit: false }; }
          out += text.slice(at);
          let count = to - from + 1;
          if (out.endsWith('\n')) out = out.slice(0, -1);
          else if (to < this.last) { out += buf.lines[to + 1].t; count++; }
          const newLines = out.split('\n');
          this.setLines(from, count, newLines);
          buf.cur = Math.min(from + newLines.length - 1, this.last);
          return { quit: false };
        }
        // \zs: the whole match is found, the part after the prefix replaced
        const vr = vimRegex(buf.lastSub.pat);
        const pre = vr.prefix !== null ? new RegExp(vr.prefix, 'y' + (re.flags.includes('i') ? 'i' : '')) : null;
        const sre = pre ? new RegExp(vr.full, re.flags) : re;
        for (let ln = from; ln <= to; ln++) {
          const line = buf.lines[ln].t;
          sre.lastIndex = 0;
          let out = '', at = 0, hit = 0;
          let mm: RegExpExecArray | null;
          while ((mm = sre.exec(line)) !== null) {
            hit++;
            let skip = 0;
            if (pre) { pre.lastIndex = mm.index; const pm = pre.exec(line); skip = pm ? pm[0].length : 0; }
            const shown = Object.assign([mm[0].slice(skip), ...mm.slice(1)], { index: mm.index + skip, input: mm.input, groups: mm.groups }) as unknown as RegExpExecArray;
            out += line.slice(at, mm.index + skip) + expandRep(rep, shown, prevRep);
            at = mm.index + mm[0].length;
            if (mm[0] === '') { if (mm.index < line.length) out += line[mm.index]; at++; sre.lastIndex = at; }
            if (!global || at > line.length) break;
          }
          if (!hit) continue;
          matches += hit;
          out += line.slice(at);
          if (countOnly) { lastLine = ln; countLines.add(ln); continue; }
          const parts = out.split('\n');
          buf.lines[ln].t = parts[0];
          buf.modified = true; buf.empty = false;
          if (parts.length > 1) {
            buf.lines.splice(ln + 1, 0, ...parts.slice(1).map((t) => ({ t })));
            ln += parts.length - 1;
            to += parts.length - 1;
          }
          lastLine = ln;
        }
        if (!matches) { if (flags.includes('e')) return { quit: false }; throw new ExError(`E486: Pattern not found: ${pat}`); }
        if (countOnly) { this.host.message(`${matches} match${matches === 1 ? '' : 'es'} on ${countLines.size} line${countLines.size === 1 ? '' : 's'}\n`); return { quit: false }; }
        buf.cur = lastLine;
        if (flags.includes('p')) this.host.print(buf.lines[lastLine].t + '\n');
        return { quit: false };
      }
      case 'global': case 'vglobal': {
        const invert = cmd === 'vglobal' || bang;
        const delim = arg[0];
        if (!delim || /[\w"|]/.test(delim)) throw new ExError('E146: Regular expressions can\'t be delimited by letters');
        const p = until(arg, 1, delim);
        const sub = arg.slice(p.end).trim() || 'p';
        if (given === 0) { from = 0; to = this.last; }
        range();
        const re = this.regex(p.text, '');
        const marked: Line[] = [];
        for (let ln = from; ln <= to; ln++) {
          re.lastIndex = 0;
          if (re.test(buf.lines[ln].t) !== invert) marked.push(buf.lines[ln]);
        }
        if (!marked.length) {
          if (invert) return { quit: false };
          throw new ExError(`E486: Pattern not found: ${p.text}`);
        }
        let hint = 0;
        for (const line of marked) {
          let at = buf.lines.indexOf(line, Math.min(hint, buf.lines.length));
          if (at < 0) at = buf.lines.indexOf(line);
          if (at < 0) continue; // deleted by an earlier one
          buf.cur = at;
          hint = Math.max(0, at - 1);
          const r = await this.run(sub);
          if (r.quit) return r;
        }
        return { quit: false };
      }
      case 'delete': case 'yank': {
        let reg = a;
        let count = 0;
        const cm = /^([a-zA-Z"]?)\s*(\d*)$/.exec(reg);
        if (cm) { reg = cm[1]; count = Number(cm[2] || 0); }
        if (count) { from = to; to = Math.min(this.last, from + count - 1); }
        range();
        buf.register = buf.lines.slice(from, to + 1).map((l) => l.t);
        if (cmd === 'yank') return { quit: false };
        buf.lines.splice(from, to - from + 1);
        if (!buf.lines.length) { buf.lines.push({ t: '' }); }
        buf.modified = true;
        buf.cur = Math.min(from, this.last);
        return { quit: false };
      }
      case 'put': {
        if (!buf.register.length) throw new ExError('E353: Nothing in register "');
        const at = bang ? to : to + 1;
        buf.lines.splice(Math.max(0, at), 0, ...buf.register.map((t) => ({ t })));
        buf.modified = true; buf.empty = false;
        buf.cur = Math.max(0, at) + buf.register.length - 1;
        return { quit: false };
      }
      case 'move': case 'copy': case 't': {
        range();
        const dest = this.address(a, 0, buf.cur);
        const target = a === '0' ? -1 : dest ? dest.line : (() => { throw new ExError('E14: Invalid address'); })();
        if (target < -1 || target > this.last) throw new ExError('E16: Invalid range');
        const chunk = buf.lines.slice(from, to + 1);
        if (cmd === 'move') {
          if (target >= from && target < to) throw new ExError('E134: Cannot move a range of lines into itself');
          if (target === to || target === from - 1) { buf.cur = to; return { quit: false }; }
          buf.lines.splice(from, chunk.length);
          const ins = target > to ? target - chunk.length + 1 : target + 1;
          buf.lines.splice(ins, 0, ...chunk);
          buf.cur = ins + chunk.length - 1;
        } else {
          buf.lines.splice(target + 1, 0, ...chunk.map((l) => ({ t: l.t })));
          buf.cur = target + chunk.length;
        }
        buf.modified = true;
        return { quit: false };
      }
      case 'join': {
        const cnt = /^\d+$/.test(a) ? Number(a) : 0;
        if (cnt) { from = to; to = Math.min(this.last, from + cnt - 1); }
        else if (given < 2) to = Math.min(this.last, from + 1);
        range();
        if (from === to) return { quit: false };
        let text = buf.lines[from].t;
        for (let k = from + 1; k <= to; k++) {
          let next = buf.lines[k].t;
          if (bang) { text += next; continue; }
          next = next.replace(/^\s+/, '');
          if (next === '') continue;
          if (next.startsWith(')') || text === '' ) text += next;
          else if (/\s$/.test(text)) text += next;
          else text += (/[.!?]$/.test(text) ? ' ' : ' ') + next;
        }
        buf.lines.splice(from, to - from + 1, { t: text });
        buf.modified = true;
        buf.cur = from;
        return { quit: false };
      }
      case '>': case '>>': case '>>>': case '<': case '<<': case '<<<': {
        range();
        const n = cmd.length;
        for (let k = from; k <= to; k++) {
          const l = buf.lines[k];
          if (cmd[0] === '>') { if (l.t !== '') l.t = '\t'.repeat(n) + l.t; }
          else {
            let rem = 8 * n;
            let t = l.t;
            while (rem > 0 && /^[ \t]/.test(t)) { rem -= t[0] === '\t' ? 8 : 1; t = t.slice(1); }
            l.t = t;
          }
        }
        buf.modified = true;
        buf.cur = to;
        return { quit: false };
      }
      case 'normal': {
        if (given === 0) { from = to = buf.cur; }
        range();
        const keys = arg.replace(/^\s/, '');
        const lines = buf.lines.slice(from, to + 1);
        for (const line of lines) {
          const at = buf.lines.indexOf(line);
          if (at < 0) continue;
          buf.cur = at;
          this.normal(keys);
        }
        return { quit: false };
      }
      case 'sort': {
        if (given === 0) { from = 0; to = this.last; }
        range();
        let rest = a, pat: RegExp | null = null;
        const pm = /^([a-z\s]*)([^a-z\s])(.*)$/.exec(rest);
        let byMatch = false;
        if (pm) {
          const p = until(pm[3], 0, pm[2]);
          pat = this.regex(p.text, '');
          rest = pm[1] + pm[3].slice(p.end);
        }
        if (/r/.test(rest)) byMatch = true;
        const ci = /i/.test(rest), numeric = /n/.test(rest), unique = /u/.test(rest), hex = /x/.test(rest), float = /f/.test(rest);
        const key = (t: string) => {
          if (!pat) return t;
          pat.lastIndex = 0;
          const mm = pat.exec(t);
          if (!mm) return byMatch ? '' : t;
          return byMatch ? mm[0] : t.slice(mm.index + mm[0].length);
        };
        const rows = buf.lines.slice(from, to + 1).map((l, k) => ({ l, k, key: key(l.t) }));
        const num = (s: string): number | null => {
          const mm = (hex ? /-?(?:0[xX])?[0-9a-fA-F]+/ : float ? /-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/ : /-?\d+/).exec(s);
          if (!mm) return null;
          return hex ? parseInt(mm[0].replace(/^(-?)0[xX]/, '$1'), 16) : Number(mm[0]);
        };
        rows.sort((x, y) => {
          let d = 0;
          if (numeric || hex || float) {
            const nx = num(x.key), ny = num(y.key);
            d = nx === null ? (ny === null ? 0 : -1) : ny === null ? 1 : nx - ny;
          } else {
            const kx = ci ? x.key.toLowerCase() : x.key, ky = ci ? y.key.toLowerCase() : y.key;
            d = kx < ky ? -1 : kx > ky ? 1 : 0;
          }
          return d || x.k - y.k;
        });
        if (bang) rows.reverse();
        let out = rows.map((r) => r.l.t);
        if (unique) {
          const same = (p: string, q: string) => (numeric ? num(key(p)) === num(key(q)) : ci ? p.toLowerCase() === q.toLowerCase() : p === q);
          out = out.filter((t, k) => k === 0 || !same(out[k - 1], t));
        }
        const before = buf.lines.slice(from, to + 1).map((l) => l.t).join('\n');
        if (before !== out.join('\n')) this.setLines(from, to - from + 1, out);
        return { quit: false };
      }
      case 'write': case 'wq': case 'xit': case 'exit': case 'update': case 'wall': case 'wqall': case 'xall': {
        let append = false;
        let file = a;
        if (file.startsWith('>>')) { append = true; file = file.slice(2).trim(); }
        if (file.startsWith('!') && cmd === 'write') {
          // :w !cmd: the lines to a command's stdin
          if (this.host.run) this.host.print(await this.host.run(file.slice(1), this.rangeText(given ? from : 0, given ? to : this.last)));
          return { quit: false };
        }
        const quits = cmd === 'wq' || cmd === 'xit' || cmd === 'exit' || cmd === 'wqall' || cmd === 'xall';
        const onlyIfChanged = cmd === 'xit' || cmd === 'exit' || cmd === 'update' || cmd === 'xall';
        const path = file ? this.host.resolve(file) : buf.path;
        if (!path) throw new ExError('E32: No file name');
        if (!onlyIfChanged || buf.modified || (file && path !== buf.path) || !(await this.host.readFile(buf.path).then((t) => t !== null))) {
          const text = given ? this.rangeText(from, to) : bufferText(buf);
          await this.write(path, text, append);
          if (path === buf.path && !given) buf.modified = false;
        }
        if (!buf.name && file) { buf.name = file; buf.path = path; }
        return quits ? { quit: true, code: 0 } : { quit: false };
      }
      case 'quit': case 'qall': case 'quitall': {
        if (buf.modified && !bang) throw new ExError('E37: No write since last change (add ! to override)');
        return { quit: true, code: 0 };
      }
      case 'cquit': return { quit: true, code: /^\d+$/.test(a) ? Number(a) : 1 };
      case 'edit': {
        if (a && this.host.resolve(a) !== buf.path) {
          if (buf.modified && !bang) throw new ExError('E37: No write since last change (add ! to override)');
          const path = this.host.resolve(a);
          const nb = newBuffer(a, path, await this.host.readFile(path));
          Object.assign(buf, { ...nb, marks: new Map(), register: buf.register, lastPattern: buf.lastPattern, lastSub: buf.lastSub });
          return { quit: false };
        }
        if (buf.modified && !bang) throw new ExError('E37: No write since last change (add ! to override)');
        const nb = newBuffer(buf.name, buf.path, buf.path ? await this.host.readFile(buf.path) : null);
        buf.lines = nb.lines; buf.modified = false; buf.empty = nb.empty; buf.crlf = nb.crlf;
        buf.cur = Math.min(buf.cur, this.last);
        return { quit: false };
      }
      case 'read': {
        let text: string | null;
        if (a.startsWith('!')) {
          if (!this.host.run) throw new ExError('E484: Cannot run a command here');
          text = await this.host.run(a.slice(1), '');
        } else {
          const path = a ? this.host.resolve(a) : buf.path;
          text = path ? await this.host.readFile(path) : null;
          if (text === null) throw new ExError(`E484: Can't open file ${a || buf.name}`);
        }
        const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n');
        const at = given ? to + 1 : buf.cur + 1;
        // (into an empty buffer, Vim reads them above its one empty line)
        const into = buf.empty && buf.lines.length === 1 && buf.lines[0].t === '' ? 0 : at;
        buf.lines.splice(into, 0, ...lines.map((t) => ({ t })));
        if (lines.length) { buf.modified = true; buf.empty = false; buf.cur = into + lines.length - 1; }
        return { quit: false };
      }
      case '!': {
        if (!this.host.run) throw new ExError('E484: Cannot run a command here');
        if (!given) { this.host.print(await this.host.run(arg, '')); return { quit: false }; }
        range();
        const out = await this.host.run(arg, this.rangeText(from, to));
        const lines = out === '' ? [] : out.replace(/\n$/, '').split('\n');
        this.setLines(from, to - from + 1, lines);
        buf.cur = Math.min(from + Math.max(0, lines.length - 1), this.last);
        return { quit: false };
      }
      case 'print': case 'number': case '#': case 'list': {
        if (given === 0) { from = to = buf.cur; }
        range();
        for (let k = from; k <= to; k++) {
          let t = buf.lines[k].t;
          if (cmd === 'list') t = t.replace(/\t/g, '^I') + '$';
          this.host.print((cmd === 'number' || cmd === '#' || a.includes('#') ? `${String(k + 1).padStart(7)} ` : '') + t + '\n');
        }
        buf.cur = to;
        return { quit: false };
      }
      case '=': {
        this.host.message(`${given ? to + 1 : buf.lines.length}\n`);
        return { quit: false };
      }
      case 'append': case 'insert': case 'change': {
        const text: string[] = [];
        if (this.host.nextLine) {
          for (let l = this.host.nextLine(); l !== null && l !== '.'; l = this.host.nextLine()) text.push(l);
        }
        if (cmd === 'change') {
          range();
          buf.lines.splice(from, to - from + 1, ...text.map((t) => ({ t })));
          if (!buf.lines.length) buf.lines.push({ t: '' });
          buf.cur = Math.max(0, Math.min(from + text.length - 1, this.last));
        } else {
          const replaceEmpty = buf.empty && buf.lines.length === 1 && buf.lines[0].t === '';
          const at = replaceEmpty ? 0 : cmd === 'append' ? to + 1 : to;
          buf.lines.splice(at, replaceEmpty ? 1 : 0, ...text.map((t) => ({ t })));
          if (text.length) buf.cur = at + text.length - 1;
        }
        if (text.length || cmd === 'change') { buf.modified = true; buf.empty = false; }
        return { quit: false };
      }
      case 'k': case 'mark': {
        const mk = (cmd === 'k' && !a ? arg : a).trim()[0];
        if (!mk) throw new ExError('E471: Argument required');
        buf.marks.set(mk, buf.lines[to]);
        return { quit: false };
      }
      case 'set': {
        for (const opt of a.split(/\s+/)) {
          if (/^(ff|fileformat)=dos$/.test(opt)) { if (!buf.crlf) { buf.crlf = true; buf.modified = true; } }
          else if (/^(ff|fileformat)=unix$/.test(opt)) { if (buf.crlf) { buf.crlf = false; buf.modified = true; } }
          else if (opt === 'ic' || opt === 'ignorecase') buf.ignorecase = true;
          else if (opt === 'noic' || opt === 'noignorecase') buf.ignorecase = false;
        }
        return { quit: false };
      }
      case 'silent': case 'keepjumps': case 'keeppatterns': case 'noautocmd': {
        try { return await this.run(arg.replace(/^!/, '')); }
        catch (e) { if (cmd === 'silent' && arg.startsWith('!') && e instanceof ExError) return { quit: false }; throw e; }
      }
      case 'execute': {
        // string literals joined, then run (no expressions)
        const parts: string[] = [];
        const re = /"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'/g;
        let mm: RegExpExecArray | null;
        while ((mm = re.exec(arg)) !== null) {
          parts.push(mm[1] !== undefined ? mm[1].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'e' ? '\x1b' : c === 'r' ? '\r' : c)) : mm[2].replace(/''/g, "'"));
        }
        if (!parts.length) throw new ExError('E121: Undefined variable');
        return this.run(parts.join(' '));
      }
      case 'undo': case 'redo': case 'nohlsearch': case 'echo': case 'retab': case 'left': case 'right':
      case 'center': case 'file': case 'buffers': case 'let': case 'syntax': case 'filetype':
        return { quit: false };
      default:
        throw new ExError(`E492: Not an editor command: ${cmd}`);
    }
  }

  private rangeText(from: number, to: number): string {
    const nl = this.buf.crlf ? '\r\n' : '\n';
    return this.buf.lines.slice(from, to + 1).map((l) => l.t).join(nl) + nl;
  }

  /** Normal-mode keys on the current line: A I a i o O (text up to <Esc>), x X dd D J 0 ^ $ w, counts */
  normal(keys: string): void {
    const buf = this.buf;
    let col = 0;
    let k = 0;
    const line = () => buf.lines[buf.cur];
    const take = () => { const e = keys.indexOf('\x1b', k); const t = e < 0 ? keys.slice(k) : keys.slice(k, e); k = e < 0 ? keys.length : e + 1; return t; };
    const changed = () => { buf.modified = true; buf.empty = false; };
    while (k < keys.length) {
      let count = 0;
      while (/\d/.test(keys[k] ?? '') && !(keys[k] === '0' && count === 0)) count = count * 10 + Number(keys[k++]);
      const n = Math.max(1, count);
      const c = keys[k++];
      const l = line();
      switch (c) {
        case 'A': { const t = take(); l.t += t.repeat(n); col = l.t.length - 1; changed(); break; }
        case 'I': { const t = take(); const ws = /^\s*/.exec(l.t)![0].length; l.t = l.t.slice(0, ws) + t.repeat(n) + l.t.slice(ws); col = ws + t.length - 1; changed(); break; }
        case 'i': { const t = take(); l.t = l.t.slice(0, col) + t.repeat(n) + l.t.slice(col); col += t.length - 1; changed(); break; }
        case 'a': { const t = take(); const at = Math.min(col + 1, l.t.length); l.t = l.t.slice(0, at) + t.repeat(n) + l.t.slice(at); col = at + t.length - 1; changed(); break; }
        case 'o': case 'O': {
          const t = take();
          const at = c === 'o' ? buf.cur + 1 : buf.cur;
          buf.lines.splice(at, 0, ...t.split('\r').map((x) => ({ t: x })));
          buf.cur = at; col = Math.max(0, t.length - 1); changed();
          break;
        }
        case 'x': { if (l.t.length) { l.t = l.t.slice(0, col) + l.t.slice(col + n); col = Math.min(col, Math.max(0, l.t.length - 1)); changed(); } break; }
        case 'X': { const s = Math.max(0, col - n); l.t = l.t.slice(0, s) + l.t.slice(col); col = s; changed(); break; }
        case 'D': { l.t = l.t.slice(0, col); col = Math.max(0, col - 1); changed(); break; }
        case 'd': {
          const m = keys[k++];
          if (m === 'd') {
            buf.register = buf.lines.slice(buf.cur, buf.cur + n).map((x) => x.t);
            buf.lines.splice(buf.cur, n);
            if (!buf.lines.length) buf.lines.push({ t: '' });
            buf.cur = Math.min(buf.cur, buf.lines.length - 1); col = 0; changed();
          } else if (m === '$') { l.t = l.t.slice(0, col); changed(); }
          else if (m === 'w') { const mm = /^\S*\s*/.exec(l.t.slice(col))!; l.t = l.t.slice(0, col) + l.t.slice(col + mm[0].length); changed(); }
          else return;
          break;
        }
        case 'J': {
          for (let r = 0; r < Math.max(1, n - 1) && buf.cur + 1 < buf.lines.length; r++) {
            const next = buf.lines[buf.cur + 1].t.replace(/^\s+/, '');
            col = l.t.length;
            l.t = next === '' ? l.t : /\s$/.test(l.t) || l.t === '' ? l.t + next : l.t + ' ' + next;
            buf.lines.splice(buf.cur + 1, 1);
          }
          changed();
          break;
        }
        case '0': col = 0; break;
        case '^': col = /^\s*/.exec(l.t)![0].length; break;
        case '$': col = Math.max(0, l.t.length - 1); break;
        case 'w': { for (let r = 0; r < n; r++) { const mm = /^\S*\s+/.exec(l.t.slice(col)); if (mm) col += mm[0].length; } break; }
        case 'j': buf.cur = Math.min(buf.lines.length - 1, buf.cur + n); break;
        case 'k': buf.cur = Math.max(0, buf.cur - n); break;
        case 'l': col = Math.min(Math.max(0, l.t.length - 1), col + n); break;
        case 'h': col = Math.max(0, col - n); break;
        case '~': { const s = l.t.slice(col, col + n); l.t = l.t.slice(0, col) + [...s].map((ch) => (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase())).join('') + l.t.slice(col + n); col = Math.min(col + n, Math.max(0, l.t.length - 1)); changed(); break; }
        case '>': if (keys[k] === '>') { k++; if (l.t) l.t = '\t' + l.t; changed(); } break;
        case '<': if (keys[k] === '<') { k++; l.t = l.t.replace(/^(\t| {1,8})/, ''); changed(); } break;
        case 'r': { const ch = keys[k++]; if (ch && l.t.length) { l.t = l.t.slice(0, col) + ch.repeat(Math.min(n, l.t.length - col)) + l.t.slice(col + n); changed(); } break; }
        default: return; // a key not handled here: the rest is dropped, as Vim drops after an error
      }
    }
  }
}
