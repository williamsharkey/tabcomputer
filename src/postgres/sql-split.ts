/**
 * Cutting SQL text into statements the way psql does: a `;` ends one unless
 * it is inside a string, a quoted name, a dollar-quoted body, a comment or
 * parentheses.
 */

export interface SqlScan {
  /** Complete statements, without their `;` */
  statements: string[];
  /** The text after the last complete statement */
  rest: string;
  /** What `rest` is inside of: '' (nothing), `'`, `"`, `$` (a dollar quote), `*` (a block comment), `(` */
  open: '' | "'" | '"' | '$' | '*' | '(';
  /** `rest` with strings and comments blanked: true when it holds anything but white space */
  restHasCode: boolean;
}

/**
 * Scan `text`. `code`, when given, receives the text with string contents
 * and comments replaced by spaces (keywords can then be looked for safely).
 */
export function scanSql(text: string, code?: { text: string }): SqlScan {
  const statements: string[] = [];
  let start = 0;
  let depth = 0;
  let open: SqlScan['open'] = '';
  let blank = '';
  let restCode = '';
  const n = text.length;
  let i = 0;
  const emit = (from: number, to: number, keep: boolean) => {
    const s = keep ? text.slice(from, to) : text.slice(from, to).replace(/[^\n]/g, ' ');
    blank += s;
    restCode += s;
  };
  while (i < n) {
    const c = text[i];
    const d = text[i + 1];
    if (c === '-' && d === '-') {
      let j = text.indexOf('\n', i);
      if (j < 0) j = n;
      emit(i, j, false);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      let level = 1;
      let j = i + 2;
      while (j < n && level > 0) {
        if (text[j] === '/' && text[j + 1] === '*') { level++; j += 2; }
        else if (text[j] === '*' && text[j + 1] === '/') { level--; j += 2; }
        else j++;
      }
      if (level > 0) { open = '*'; emit(i, n, false); i = n; break; }
      emit(i, j, false);
      i = j;
      continue;
    }
    if (c === "'" || c === '"') {
      // E'...' strings take backslash escapes
      const escapes = c === "'" && i > 0 && /[eE]/.test(text[i - 1]) && !/[A-Za-z0-9_]/.test(text[i - 2] ?? ' ');
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (escapes && text[j] === '\\') { j += 2; continue; }
        if (text[j] === c) {
          if (text[j + 1] === c) { j += 2; continue; }
          closed = true;
          j++;
          break;
        }
        j++;
      }
      if (!closed) { open = c; emit(i, n, false); i = n; break; }
      emit(i, i + 1, true);
      emit(i + 1, j - 1, false);
      emit(j - 1, j, true);
      i = j;
      continue;
    }
    if (c === '$' && !/[A-Za-z0-9_]/.test(text[i - 1] ?? ' ')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 80));
      if (m) {
        const j = text.indexOf(m[0], i + m[0].length);
        if (j < 0) { open = '$'; emit(i, n, false); i = n; break; }
        emit(i, j + m[0].length, false);
        i = j + m[0].length;
        continue;
      }
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      statements.push(text.slice(start, i).trim());
      emit(i, i + 1, true);
      i++;
      start = i;
      restCode = '';
      continue;
    }
    emit(i, i + 1, true);
    i++;
  }
  if (!open && depth > 0) open = '(';
  if (code) code.text = blank;
  return { statements: statements.filter((s) => s !== ''), rest: text.slice(start), open, restHasCode: restCode.trim() !== '' };
}

/** Every statement of `text`, the last one with or without its `;`. */
export function statementsOf(text: string): string[] {
  const scan = scanSql(text);
  return scan.restHasCode ? [...scan.statements, scan.rest.trim()] : scan.statements;
}

/** `sql` with string contents and comments blanked. */
export function codeOf(sql: string): string {
  const code = { text: '' };
  scanSql(sql, code);
  return code.text;
}

const COPY_IN = /\bcopy\b[\s\S]*\bfrom\s+stdin\b/i;

/**
 * Whether `sql` reads COPY data from the client: 'one' when it is a single
 * COPY ... FROM STDIN statement, 'mixed' when such a statement is one of
 * several, else ''.
 */
export function copyFromStdin(sql: string): '' | 'one' | 'mixed' {
  if (!/stdin/i.test(sql)) return '';
  const parts = statementsOf(sql);
  const hits = parts.filter((p) => COPY_IN.test(codeOf(p)));
  if (!hits.length) return '';
  return parts.length === 1 && /^\s*copy\b/i.test(codeOf(parts[0])) ? 'one' : 'mixed';
}

/** A COPY ... FROM STDIN statement reading the file `path` instead. */
export function copyFromPath(sql: string, path: string): string {
  const code = codeOf(sql);
  const m = /\bfrom\s+stdin\b/i.exec(code);
  if (!m) return sql;
  return sql.slice(0, m.index) + `FROM '${path}'` + sql.slice(m.index + m[0].length);
}
