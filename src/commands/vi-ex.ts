/**
 * Ex commands for the builtin vi: `vi -c CMD`, `+CMD`, `vi -es < script`,
 * `ex`, and the `:` commands of interactive vi beyond :w/:q (tabcomputer#62).
 * Scripts and agents edit files this way without a terminal.
 *
 * Addresses: N, ., $, /re/, ?re?, +N/-N offsets, %, a,b and a;b.
 * Commands: (a bare address goes to the line), d, s/re/rep/[gieI&n] and
 * & (repeat), g/re/cmd, g!/re/cmd, v/re/cmd, p, nu (#), =, m, t (co), j,
 * a/i/c (text lines follow, up to "."; from a script on stdin only), r FILE,
 * w [FILE], w >> FILE, up, wq, x, q, q!, qa, cq. set, syntax, filetype,
 * redraw, visual and "comments are accepted and do nothing.
 *
 * Patterns are vim's magic regexes, translated to JavaScript ones (\( \)
 * \| \+ \? \= \{n,m} \< \> groups and quantifiers, [[:alpha:]] classes,
 * \c/\C). In a replacement: & and \0 (the match), \1-\9, \r or \n (a line
 * break), \u \l \U \L \E (case), ~ (the previous replacement).
 */

export interface ExIO {
  /** Read a file (throws if it doesn't exist). */
  read(path: string): Promise<string>;
  write(path: string, text: string, append?: boolean): Promise<void>;
  resolve(path: string): string;
  out(text: string): void;
  err(text: string): void;
  /** An informational message (vim's "Pattern not found" of :g, :s///n's count): not an error. */
  msg?(text: string): void;
  /** The next line of the script, for a/i/c text; null at its end (or when there is no script). */
  input?(): string | null;
}

export class ExBuffer {
  /** The lines, without their newlines; [] is an empty buffer. */
  lines: string[] = [];
  /** The current line, 1-based (0 in an empty buffer). */
  cur = 0;
  modified = false;
  filename: string | null = null;
  readonly = false;
  /** Set by :q and friends: the exit status to quit with. */
  quit: number | null = null;
  /** Commands that failed (vim -es exits 1 if any did). */
  errors = 0;
  lastPattern: string | null = null;
  lastSub: { pattern: string; replacement: string; flags: string } | null = null;
  /** Inside :g (no nested :g; a :s without a match is no error there). */
  inGlobal = false;

  /** The buffer's text as vim writes it: each line ends with a newline. */
  text(lines = this.lines): string {
    return lines.length ? lines.join('\n') + '\n' : '';
  }

  setText(text: string): void {
    this.lines = text === '' ? [] : text.split('\n');
    if (text.endsWith('\n')) this.lines.pop();
  }
}

class ExError extends Error {}

const fail = (msg: string): never => { throw new ExError(msg); };

/** vim's magic regex `pat` as a JavaScript RegExp source, and whether \c asked to ignore case. */
export function vimRegex(pat: string): { source: string; ignoreCase?: boolean } {
  let out = '';
  let ignoreCase: boolean | undefined;
  const atStart = () => out === '' || out.endsWith('(') || out.endsWith('|');
  const classes: Record<string, string> = {
    alpha: 'A-Za-z', digit: '0-9', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s',
    blank: ' \\t', punct: '!-/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', print: ' -~', graph: '!-~', cntrl: '\\x00-\\x1f',
  };
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '\\' && i + 1 < pat.length) {
      const d = pat[++i];
      if (d === '(' || d === ')' || d === '|' || d === '+' || d === '?') out += d;
      else if (d === '=') out += '?';
      else if (d === '{') {
        const close = pat.indexOf('}', i + 1);
        if (close < 0) fail(`E554: Syntax error in \\{...}`);
        let body = pat.slice(i + 1, close).replace(/\\$/, '');
        i = close;
        const lazy = body.startsWith('-');
        if (lazy) body = body.slice(1);
        out += (body === '' ? '*' : body.startsWith(',') ? `{0${body}}` : `{${body}}`) + (lazy ? '?' : '');
      } else if (d === '<' || d === '>') out += '\\b';
      else if ('sSdDwW'.includes(d)) out += '\\' + d;
      else if (d === 'a') out += '[A-Za-z]';
      else if (d === 'l') out += '[a-z]';
      else if (d === 'u') out += '[A-Z]';
      else if (d === 'x') out += '[0-9A-Fa-f]';
      else if (d === 'n') out += '\\n';
      else if (d === 't') out += '\\t';
      else if (d === 'e') out += '\\x1b';
      else if (d === 'r') out += '\\r';
      else if (d === 'c') ignoreCase = true;
      else if (d === 'C') ignoreCase = false;
      else if (d >= '1' && d <= '9') out += '\\' + d;
      else out += /[\w]/.test(d) ? d : '\\' + d;
    } else if (c === '[') {
      // A bracket expression, copied up to its ']' (a ']' first is a member)
      let j = i + 1;
      let body = '';
      if (pat[j] === '^') { body += '^'; j++; }
      if (pat[j] === ']') { body += '\\]'; j++; }
      let closed = false;
      for (; j < pat.length; j++) {
        if (pat[j] === ']') { closed = true; break; }
        const cls = /^\[:(\w+):\]/.exec(pat.slice(j));
        if (cls && classes[cls[1]]) { body += classes[cls[1]]; j += cls[0].length - 1; continue; }
        if (pat[j] === '\\' && j + 1 < pat.length) { body += '\\' + pat[++j]; continue; }
        body += pat[j] === '[' ? '\\[' : pat[j];
      }
      if (!closed) out += '\\[';
      else { out += `[${body}]`; i = j; }
    } else if (c === '^') out += atStart() ? '^' : '\\^';
    else if (c === '$') {
      const rest = pat.slice(i + 1);
      out += rest === '' || rest.startsWith('\\|') || rest.startsWith('\\)') ? '$' : '\\$';
    } else if ('()|+?{}'.includes(c)) out += '\\' + c;
    else if (c === '~') out += '~';
    else out += c;
  }
  return { source: out, ignoreCase };
}

function makeRegex(pat: string, flags = ''): RegExp {
  const { source, ignoreCase } = vimRegex(pat);
  const i = ignoreCase ?? (flags.includes('i') && !flags.includes('I'));
  try { return new RegExp(source, (i ? 'i' : '') + (flags.includes('g') ? 'g' : '')); } catch (e) { return fail(`E486: Bad pattern: ${pat}`); }
}

/** The replacement of one match: & \0-\9, \r \n (line break), \u \l \U \L \E, \& \\ and other escapes. */
function expandReplacement(rep: string, m: RegExpExecArray | string[]): string {
  let out = '';
  let once: 'u' | 'l' | null = null;
  let mode: 'U' | 'L' | null = null;
  const add = (s: string) => {
    for (const ch of s) {
      let c = mode === 'U' ? ch.toUpperCase() : mode === 'L' ? ch.toLowerCase() : ch;
      if (once) { c = once === 'u' ? c.toUpperCase() : c.toLowerCase(); once = null; }
      out += c;
    }
  };
  for (let i = 0; i < rep.length; i++) {
    const c = rep[i];
    if (c === '&') add(m[0] ?? '');
    else if (c === '\\' && i + 1 < rep.length) {
      const d = rep[++i];
      if (d >= '0' && d <= '9') add(m[+d] ?? '');
      else if (d === 'r' || d === 'n') out += '\n';
      else if (d === 't') add('\t');
      else if (d === 'u' || d === 'l') once = d;
      else if (d === 'U' || d === 'L') mode = d;
      else if (d === 'E' || d === 'e') { mode = null; once = null; }
      else add(d);
    } else add(c);
  }
  return out;
}

/** Read up to an unescaped `delim`; returns the text (escaped delimiters unescaped) and the index after the delimiter (or the end). */
function readDelimited(s: string, i: number, delim: string): { text: string; next: number; closed: boolean } {
  let text = '';
  for (; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) {
      text += s[i + 1] === delim ? delim : s[i] + s[i + 1];
      i++;
    } else if (s[i] === delim) return { text, next: i + 1, closed: true };
    else text += s[i];
  }
  return { text, next: i, closed: false };
}

const COMMANDS: Array<[full: string, min: number]> = [
  ['append', 1], ['change', 1], ['copy', 2], ['delete', 1], ['global', 1], ['insert', 1], ['join', 1],
  ['move', 1], ['number', 2], ['print', 1], ['quit', 1], ['qall', 2], ['quitall', 5], ['cquit', 2], ['read', 1],
  ['substitute', 1], ['t', 1], ['update', 2], ['vglobal', 1], ['write', 1], ['wq', 2], ['xit', 1], ['exit', 3],
  ['wqall', 3], ['xall', 2], ['set', 2], ['setlocal', 4], ['syntax', 2], ['filetype', 5], ['redraw', 4],
  ['visual', 2], ['vi', 2], ['nohlsearch', 3], ['edit', 1],
];

function commandName(word: string): string | null {
  for (const [full, min] of COMMANDS) if (word.length >= min && full.startsWith(word)) return full;
  return null;
}

class Parser {
  i = 0;
  constructor(readonly s: string, readonly buf: ExBuffer) {}
  peek(): string { return this.s[this.i] ?? ''; }
  skipSpace(): void { while (this.s[this.i] === ' ' || this.s[this.i] === '\t') this.i++; }
  rest(): string { return this.s.slice(this.i); }

  private search(pat: string, forward: boolean, from: number): number {
    if (pat === '') pat = this.buf.lastPattern ?? fail('E35: No previous regular expression');
    this.buf.lastPattern = pat;
    const re = makeRegex(pat);
    const n = this.buf.lines.length;
    for (let k = 1; k <= n; k++) {
      const line = forward ? ((from - 1 + k) % n) + 1 : ((from - 1 - k + n * 2) % n) + 1;
      if (re.test(this.buf.lines[line - 1])) return line;
    }
    return fail(`E486: Pattern not found: ${pat}`);
  }

  /** One address, or null when there is none here. */
  address(base: number): number | null {
    this.skipSpace();
    let line: number | null = null;
    const c = this.peek();
    if (/\d/.test(c)) {
      const m = /^\d+/.exec(this.rest())!;
      line = +m[0];
      this.i += m[0].length;
    } else if (c === '.') { line = base; this.i++; }
    else if (c === '$') { line = this.buf.lines.length; this.i++; }
    else if (c === '/' || c === '?') {
      const { text, next } = readDelimited(this.s, this.i + 1, c);
      this.i = next;
      line = this.search(text, c === '/', base);
    } else if (c === "'") fail('E20: Mark not set');
    for (;;) {
      const o = this.peek();
      if (o !== '+' && o !== '-') break;
      this.i++;
      const m = /^\d+/.exec(this.rest());
      const n = m ? +m[0] : 1;
      if (m) this.i += m[0].length;
      line = (line ?? base) + (o === '+' ? n : -n);
    }
    return line;
  }

  /** The range before a command: [start, end] and whether one was given. */
  range(): { start: number; end: number; given: boolean } {
    this.skipSpace();
    while (this.peek() === ':') { this.i++; this.skipSpace(); }
    if (this.peek() === '%') {
      this.i++;
      return { start: Math.min(1, this.buf.lines.length), end: this.buf.lines.length, given: true };
    }
    const a = this.address(this.buf.cur);
    this.skipSpace();
    const sep = this.peek();
    if (sep !== ',' && sep !== ';') return a === null ? { start: this.buf.cur, end: this.buf.cur, given: false } : { start: a, end: a, given: true };
    this.i++;
    const first = a ?? this.buf.cur;
    const b = this.address(sep === ';' ? first : this.buf.cur);
    return { start: first, end: b ?? (sep === ',' && a === null ? this.buf.lines.length : first), given: true };
  }
}

function checkRange(buf: ExBuffer, start: number, end: number, allowZero = false): [number, number] {
  if (start > end) [start, end] = [end, start];
  if (start < (allowZero ? 0 : 1) || end > buf.lines.length) fail('E16: Invalid range');
  return [start, end];
}

/**
 * Run one ex command line (several when joined by |). Errors are reported
 * through io.err and counted in buf.errors; they don't throw.
 */
export async function runExCommand(buf: ExBuffer, line: string, io: ExIO): Promise<void> {
  try {
    await runOne(buf, line, io);
  } catch (e) {
    if (!(e instanceof ExError)) throw e;
    buf.errors++;
    io.err(e.message + '\n');
  }
}

async function runOne(buf: ExBuffer, line: string, io: ExIO): Promise<void> {
  const p = new Parser(line, buf);
  const { start, end, given } = p.range();
  p.skipSpace();
  let word = '';
  const c0 = p.peek();
  if (/[a-zA-Z]/.test(c0)) {
    const m = /^[a-zA-Z]+/.exec(p.rest())!;
    word = m[0];
    // s, g and v take any delimiter, letters excepted: "s/a/b/" reads "s" then "/"
    for (const short of ['s', 'g', 'v']) {
      if (word.startsWith(short) && word.length > 1 && !commandName(word)) word = short;
    }
    p.i += word.length;
  } else if ('&#="<>'.includes(c0) && c0) { word = c0; p.i++; }
  const bang = p.peek() === '!' ? (p.i++, true) : false;
  const name = word === '' ? '' : word === '&' || word === '#' || word === '=' || word === '"' ? word : commandName(word);
  if (name === null) fail(`E492: Not an editor command: ${line.trim()}`);
  const n = buf.lines.length;
  /** The rest after the command's own arguments: another command after | */
  const next = async (rest: string) => {
    const r = rest.replace(/^\s*/, '');
    if (r.startsWith('|')) await runOne(buf, r.slice(1), io);
    else if (r !== '' && !r.startsWith('"')) fail(`E488: Trailing characters: ${r}`);
  };
  /** The argument up to an unescaped | */
  const arg = (): { text: string; rest: string } => {
    const s = p.rest();
    let j = 0, text = '';
    for (; j < s.length; j++) {
      if (s[j] === '\\' && s[j + 1] === '|') { text += '|'; j++; continue; }
      if (s[j] === '|') break;
      text += s[j];
    }
    return { text: text.trim(), rest: s.slice(j) };
  };

  switch (name) {
    case '': {
      if (p.rest().trim() === '' && !given) return;
      if (given) buf.cur = Math.max(Math.min(1, n), Math.min(end, n));
      return next(p.rest());
    }
    case '"':
      return;
    case 'delete': {
      if (n === 0) return next(arg().rest);
      const [a, b] = checkRange(buf, start, end);
      // A count: "d 3" deletes 3 lines from the range's end
      const { text, rest } = arg();
      const count = /^\d+$/.test(text) ? +text : 0;
      const from = count ? b : a, to = count ? Math.min(n, b + count - 1) : b;
      buf.lines.splice(from - 1, to - from + 1);
      buf.modified = true;
      buf.cur = Math.min(from, buf.lines.length);
      return next(rest);
    }
    case 'substitute':
    case '&': {
      let pattern: string, replacement: string, flags = '';
      const delim = p.peek();
      let rest: string;
      if (name === 'substitute' && delim && !/[\s\w"|\\]/.test(delim)) {
        const pa = readDelimited(p.s, p.i + 1, delim);
        const re = readDelimited(p.s, pa.next, delim);
        pattern = pa.text === '' ? (buf.lastPattern ?? fail('E35: No previous regular expression')) : pa.text;
        replacement = re.text === '~' ? buf.lastSub?.replacement ?? '' : re.text.replace(/(^|[^\\])~/g, (_m, pre) => pre + (buf.lastSub?.replacement ?? ''));
        p.i = re.next;
        const m = re.closed ? /^[&cegiInp#l]*/.exec(p.rest())! : ['']; flags = m[0]; p.i += m[0].length;
        if (flags.startsWith('&')) flags = (buf.lastSub?.flags ?? '') + flags.slice(1);
      } else {
        // :s or :& repeats the last substitute; its flags only with &
        if (!buf.lastSub) fail('E35: No previous regular expression');
        pattern = buf.lastSub!.pattern;
        replacement = buf.lastSub!.replacement;
        const m = /^[&cegiInp#l]*/.exec(p.rest())!; flags = m[0]; p.i += m[0].length;
        if (flags.startsWith('&')) flags = buf.lastSub!.flags + flags.slice(1);
      }
      p.skipSpace();
      const cm = /^\d+/.exec(p.rest());
      let [a, b] = checkRange(buf, start, end);
      if (cm) { p.i += cm[0].length; a = b; b = Math.min(n, b + +cm[0] - 1); }
      rest = p.rest();
      buf.lastPattern = pattern;
      buf.lastSub = { pattern, replacement, flags: flags.replace(/[&n]/g, '') };
      const re = makeRegex(pattern, flags);
      let count = 0, lastLine = 0;
      const out: string[] = [];
      for (let k = a; k <= b; k++) {
        const text = buf.lines[k - 1];
        re.lastIndex = 0;
        let changed = text, hit = false;
        if (flags.includes('g')) {
          changed = text.replace(re, (...args) => { hit = true; count++; return expandReplacement(replacement, args.slice(0, -2).filter((x) => typeof x !== 'object') as string[]); });
        } else {
          const m = re.exec(text);
          if (m) { hit = true; count++; changed = text.slice(0, m.index) + expandReplacement(replacement, m) + text.slice(m.index + m[0].length); }
        }
        if (hit && !flags.includes('n')) { out.push(...changed.split('\n')); lastLine = a - 1 + out.length; }
        else out.push(text);
      }
      if (flags.includes('n')) { io.msg?.(`${count} match${count === 1 ? '' : 'es'}\n`); return next(rest); }
      if (!count) {
        if (!flags.includes('e') && !buf.inGlobal) fail(`E486: Pattern not found: ${pattern}`);
        return next(rest);
      }
      buf.lines.splice(a - 1, b - a + 1, ...out);
      buf.modified = true;
      buf.cur = lastLine;
      if (flags.includes('p') || flags.includes('#') || flags.includes('l')) io.out((flags.includes('#') ? `${String(buf.cur).padStart(3)} ` : '') + buf.lines[buf.cur - 1] + '\n');
      return next(rest);
    }
    case 'global':
    case 'vglobal': {
      if (buf.inGlobal) fail('E147: Cannot do :global recursive');
      const invert = name === 'vglobal' || bang;
      const delim = p.peek();
      if (!delim || /[\s\w"|\\]/.test(delim)) fail('E146: Regular expressions can\'t be delimited by letters');
      const pa = readDelimited(p.s, p.i + 1, delim);
      const pattern = pa.text === '' ? (buf.lastPattern ?? fail('E35: No previous regular expression')) : pa.text;
      buf.lastPattern = pattern;
      const cmd = p.s.slice(pa.next).trim() || 'p';
      const [a, b] = given ? checkRange(buf, start, end) : [1, n];
      const re = makeRegex(pattern);
      // Mark the lines first (as vim does), then run the command on each still there
      const lines = buf.lines.map((t) => ({ t }));
      const marked = new Set<{ t: string }>();
      for (let k = a; k <= b; k++) if (re.test(lines[k - 1].t) !== invert) marked.add(lines[k - 1]);
      if (!marked.size) { io.msg?.(`Pattern ${invert ? 'found in every line' : 'not found'}: ${pattern}\n`); return; }
      if (/^d(e(l(e(te?)?)?)?)?$/.test(cmd)) {
        // The common g/re/d, without a pass per line
        buf.lines = lines.filter((l) => !marked.has(l)).map((l) => l.t);
        buf.modified = true;
        let last = 0;
        lines.forEach((l, k) => { if (marked.has(l)) last = k + 1; });
        buf.cur = Math.min(Math.max(1, last - marked.size + 1), buf.lines.length);
        return;
      }
      // Other commands: each marked line still in the buffer, found again after
      // edits by keeping the objects of the unchanged lines before and after them
      let objs = lines;
      buf.inGlobal = true;
      try {
        for (const obj of lines) {
          if (!marked.has(obj)) continue;
          const at = objs.indexOf(obj);
          if (at < 0) continue;
          buf.cur = at + 1;
          await runOne(buf, cmd, io);
          const now = buf.lines;
          let head = 0;
          while (head < now.length && head < objs.length && objs[head].t === now[head]) head++;
          let tail = 0;
          while (tail < now.length - head && tail < objs.length - head && objs[objs.length - 1 - tail].t === now[now.length - 1 - tail]) tail++;
          objs = [...objs.slice(0, head), ...now.slice(head, now.length - tail).map((t) => ({ t })), ...objs.slice(objs.length - tail)];
        }
      } finally { buf.inGlobal = false; }
      return;
    }
    case 'print':
    case 'number':
    case '#': {
      const [a, b] = checkRange(buf, start, end);
      const { rest } = arg();
      for (let k = a; k <= b; k++) io.out((name === 'print' ? '' : `${String(k).padStart(3)} `) + buf.lines[k - 1] + '\n');
      buf.cur = b;
      return next(rest);
    }
    case '=': {
      io.out(`${given ? end : n}\n`);
      return next(p.rest());
    }
    case 'move':
    case 'copy':
    case 't': {
      const [a, b] = checkRange(buf, start, end);
      const target = p.address(buf.cur);
      if (target === null) fail('E14: Invalid address');
      if (target! < 0 || target! > n) fail('E16: Invalid range');
      const moved = buf.lines.slice(a - 1, b);
      if (name === 'move') {
        if (target! >= a && target! < b) fail('E134: Cannot move a range of lines into itself');
        if (target! === b || target! === a - 1) { buf.cur = b; return next(p.rest()); }
        buf.lines.splice(a - 1, moved.length);
        const at = target! > b ? target! - moved.length : target!;
        buf.lines.splice(at, 0, ...moved);
        buf.cur = at + moved.length;
      } else {
        buf.lines.splice(target!, 0, ...moved);
        buf.cur = target! + moved.length;
      }
      buf.modified = true;
      return next(p.rest());
    }
    case 'join': {
      let [a, b] = checkRange(buf, start, end);
      if (a === b) b = a + 1;
      const { text, rest } = arg();
      if (/^\d+$/.test(text)) b = Math.min(n, (given ? b : a) + +text - 1);
      if (b > n) { if (!given) return next(rest); fail('E16: Invalid range'); }
      let joined = buf.lines[a - 1];
      for (let k = a + 1; k <= b; k++) {
        const t = buf.lines[k - 1];
        if (bang) joined += t;
        else {
          const s = t.replace(/^\s+/, '');
          joined = joined.replace(/\s+$/, '');
          joined += s === '' ? '' : (joined === '' || s.startsWith(')') ? '' : /[.!?]$/.test(joined) ? '  ' : ' ') + s;
        }
      }
      buf.lines.splice(a - 1, b - a + 1, joined);
      buf.modified = true;
      buf.cur = a;
      return next(rest);
    }
    case 'append':
    case 'insert':
    case 'change': {
      const text: string[] = [];
      for (let l = io.input?.() ?? null; l !== null && l !== '.'; l = io.input?.() ?? null) text.push(l);
      let at: number;
      if (name === 'change') {
        const [a, b] = checkRange(buf, start, end);
        buf.lines.splice(a - 1, b - a + 1);
        at = a - 1;
      } else {
        const line = name === 'append' ? end : Math.max(0, end - 1);
        if (line < 0 || line > n) fail('E16: Invalid range');
        at = line;
      }
      buf.lines.splice(at, 0, ...text);
      buf.cur = Math.max(text.length ? at + text.length : at, Math.min(1, buf.lines.length));
      if (text.length || name === 'change') buf.modified = true;
      return;
    }
    case 'read': {
      const { text: file, rest } = arg();
      if (!file) fail('E32: No file name');
      let data: string;
      try { data = await io.read(io.resolve(file)); } catch { return fail(`E484: Can't open file ${file}`); }
      const add = new ExBuffer();
      add.setText(data);
      const at = given ? end : buf.cur;
      if (at < 0 || at > n) fail('E16: Invalid range');
      buf.lines.splice(at, 0, ...add.lines);
      if (add.lines.length) { buf.modified = true; buf.cur = at + add.lines.length; }
      return next(rest);
    }
    case 'write':
    case 'update':
    case 'wq':
    case 'xit':
    case 'exit':
    case 'wqall':
    case 'xall': {
      let { text: file, rest } = arg();
      let append = false;
      if (file.startsWith('>>')) { append = true; file = file.slice(2).trim(); }
      if (file.startsWith('!')) fail('E492: :w !cmd is not supported here');
      const quits = name !== 'write' && name !== 'update';
      const needed = name === 'write' || name === 'wq' || buf.modified || (file !== '' && file !== buf.filename);
      if (needed) {
        const target = file || buf.filename;
        if (!target) fail('E32: No file name');
        if (buf.readonly && !bang && !file) fail('E45: \'readonly\' option is set (add ! to override)');
        const [a, b] = n === 0 ? [1, 0] : checkRange(buf, given ? start : 1, given ? end : n);
        await io.write(io.resolve(target!), buf.text(buf.lines.slice(a - 1, b)), append);
        if (!buf.filename && file && !append) buf.filename = file;
        if (!given && !append && (!file || file === buf.filename)) buf.modified = false;
      }
      if (quits) { buf.quit = 0; return; }
      return next(rest);
    }
    case 'quit':
    case 'qall':
    case 'quitall':
      if (buf.modified && !bang) fail('E37: No write since last change (add ! to override)');
      buf.quit = 0;
      return;
    case 'cquit':
      buf.quit = 1;
      return;
    case 'edit':
      if (p.rest().trim() !== '') fail('E492: :e FILE is not supported here');
      if (buf.modified && !bang) fail('E37: No write since last change (add ! to override)');
      if (buf.filename) {
        try { buf.setText(await io.read(io.resolve(buf.filename))); } catch { buf.lines = []; }
        buf.modified = false;
        buf.cur = Math.min(1, buf.lines.length);
      }
      return;
    case 'set': case 'setlocal': case 'syntax': case 'filetype': case 'redraw':
    case 'visual': case 'vi': case 'nohlsearch':
      return; // options and display: nothing to do here
    default:
      fail(`E492: Not an editor command: ${line.trim()}`);
  }
}
