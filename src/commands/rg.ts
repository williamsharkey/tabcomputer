import { Command, CommandContext } from './index';
import { decodeBytes } from '../utils/byte-text';

/**
 * rg: ripgrep 14's command line, over the built-in file system.
 *
 * Claude Code's Grep and Glob tools depend on this (--json, --null, -l, -c,
 * --files, -U, -m, --max-columns). Output follows ripgrep's rules: line numbers
 * and a heading per file only on a terminal (or -n / --heading), the path only
 * when searching a directory or several paths (or -H; -I hides it). Also -r
 * (with $0, $1, ${name}), --count-matches, --stats, --column, -b, --vimgrep,
 * --passthru, --trim, -x, smart case, -q, --files-without-match, colour.
 */

/** Options taking a value: --opt VALUE or --opt=VALUE */
const LONG_VALUE = new Set([
  'regexp', 'replace', 'sort', 'sortr', 'max-depth', 'maxdepth', 'type', 'type-not', 'glob', 'iglob',
  'after-context', 'before-context', 'context', 'max-columns', 'max-count', 'color', 'colour', 'colors',
  'threads', 'file', 'encoding', 'context-separator', 'field-match-separator', 'field-context-separator',
  'path-separator', 'max-filesize', 'type-add', 'type-clear', 'ignore-file', 'pre', 'pre-glob', 'engine',
  'dfa-size-limit', 'regex-size-limit', 'hyperlink-format', 'generate', 'hostname-bin',
]);
/** Short options taking a value (-m1, -m 1) */
const SHORT_VALUE: Record<string, string> = {
  e: 'regexp', r: 'replace', t: 'type', T: 'type-not', g: 'glob', A: 'after-context', B: 'before-context',
  C: 'context', M: 'max-columns', m: 'max-count', j: 'threads', f: 'file', E: 'encoding', d: 'max-depth',
};
/** Short switches, as their long names */
const SHORT_SWITCH: Record<string, string> = {
  i: 'ignore-case', s: 'case-sensitive', S: 'smart-case', v: 'invert-match', n: 'line-number',
  N: 'no-line-number', c: 'count', l: 'files-with-matches', w: 'word-regexp', x: 'line-regexp',
  o: 'only-matching', F: 'fixed-strings', H: 'with-filename', I: 'no-filename', U: 'multiline',
  '0': 'null', L: 'follow', q: 'quiet', b: 'byte-offset', p: 'pretty', a: 'text', z: 'search-zip',
  P: 'pcre2', u: 'unrestricted', '.': 'hidden', V: 'version', h: 'help',
};

// File type → extensions (a subset of ripgrep's built-in types)
const TYPES: Record<string, string[]> = {
  c: ['.c', '.h'],
  cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.h', '.hh', '.inl'],
  css: ['.css', '.scss', '.less', '.sass'],
  go: ['.go'],
  html: ['.html', '.htm', '.xhtml'],
  java: ['.java'],
  js: ['.js', '.mjs', '.cjs', '.jsx', '.vue'],
  json: ['.json', '.jsonl'],
  kotlin: ['.kt', '.kts'],
  lua: ['.lua'],
  make: ['.mk', '.mak'],
  markdown: ['.md', '.markdown', '.mdx'],
  md: ['.md', '.markdown', '.mdx'],
  php: ['.php'],
  py: ['.py', '.pyi'],
  python: ['.py', '.pyi'],
  ruby: ['.rb', '.gemspec'],
  rust: ['.rs'],
  sh: ['.sh', '.bash', '.zsh', '.ksh'],
  sql: ['.sql'],
  swift: ['.swift'],
  toml: ['.toml'],
  ts: ['.ts', '.tsx', '.mts', '.cts'],
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  txt: ['.txt'],
  xml: ['.xml', '.xsd', '.xsl', '.svg'],
  yaml: ['.yaml', '.yml'],
};

const POSIX_CLASS: Record<string, string> = {
  alnum: 'a-zA-Z0-9', alpha: 'a-zA-Z', ascii: '\\x00-\\x7F', blank: ' \\t', cntrl: '\\x00-\\x1F\\x7F',
  digit: '0-9', graph: '!-~', lower: 'a-z', print: ' -~', punct: '!-\\/:-@\\[-`{-~',
  space: ' \\t\\n\\r\\f\\v', upper: 'A-Z', word: '\\w', xdigit: '0-9A-Fa-f',
};

/**
 * Rust regex syntax → JavaScript: (?P<n>, [[:class:]] and flag groups. With
 * `fold`, leading groups like (?i)(?s) become RegExp flags. Any other (?flags)
 * becomes a modifier group (?i:…) that runs to the end of its enclosing group,
 * reopened after each |, as Rust scopes it. x (ignore whitespace and # comments)
 * and U (swap greedy and lazy) have no JavaScript flag, so they are applied here.
 */
export function toJs(p: string, fold = true): { src: string; flags: string } {
  type Frame = { x: boolean; U: boolean; mods: string[] };
  const frames: Frame[] = [{ x: false, U: false, mods: [] }];
  const top = () => frames[frames.length - 1];
  let flags = '';
  let i = 0;
  let lead: RegExpExecArray | null;
  while (fold && (lead = /^\(\?([imsxUuR]+)\)/.exec(p.slice(i)))) {
    for (const c of lead[1]) if ('ims'.includes(c) && !flags.includes(c)) flags += c;
    if (lead[1].includes('x')) top().x = true;
    if (lead[1].includes('U')) top().U = true;
    i += lead[0].length;
  }
  let out = '';
  while (i < p.length) {
    const ch = p[i];
    const f = top();
    if (ch === '\\') {
      const next = p[i + 1] ?? '';
      out += f.x && (next === ' ' || next === '#') ? next : ch + next;
      i += 2;
    } else if (ch === '[') {
      let j = i + 1;
      if (p[j] === '^') j++;
      if (p[j] === ']') j++;
      let cls = p.slice(i, j);
      while (j < p.length && p[j] !== ']') {
        const posix = /^\[:(\w+):\]/.exec(p.slice(j));
        if (posix) { cls += POSIX_CLASS[posix[1]] ?? posix[0]; j += posix[0].length; }
        else if (p[j] === '\\') { cls += p.slice(j, j + 2); j += 2; }
        else cls += p[j++];
      }
      out += cls + (p[j] ?? '');
      i = j + 1;
    } else if (f.x && /\s/.test(ch)) {
      i++;
    } else if (f.x && ch === '#') {
      while (i < p.length && p[i] !== '\n') i++;
    } else if (ch === '(') {
      const fg = /^\(\?([imsxUuR]*)(?:-([imsxUuR]*))?([:)])/.exec(p.slice(i));
      if (fg && (fg[1] || fg[2] !== undefined)) {
        const on = fg[1], off = fg[2] ?? '';
        const x = (f.x && !off.includes('x')) || on.includes('x');
        const U = (f.U && !off.includes('U')) || on.includes('U');
        const jsOn = on.replace(/[^ims]/g, ''), jsOff = off.replace(/[^ims]/g, '');
        const open = jsOn || jsOff ? `(?${jsOn}${jsOff ? '-' + jsOff : ''}:` : '(?:';
        if (fg[3] === ':') { out += open; frames.push({ x, U, mods: [] }); }
        else {
          f.x = x; f.U = U;
          if (jsOn || jsOff) { out += open; f.mods.push(open); }
        }
        i += fg[0].length;
      } else {
        // (?P<name> is (?<name>; other (? groups pass through whole, so their ? isn't a quantifier
        const g = /^\((?:\?(?:P?<(?![=!])[^>]*>|<[=!]|[:=!])?)?/.exec(p.slice(i))![0];
        out += g.replace('(?P<', '(?<');
        frames.push({ x: f.x, U: f.U, mods: [] });
        i += g.length;
      }
    } else if (ch === ')') {
      out += ')'.repeat(f.mods.length) + ')';
      if (frames.length > 1) frames.pop();
      i++;
    } else if (ch === '|') {
      out += ')'.repeat(f.mods.length) + '|' + f.mods.join('');
      i++;
    } else {
      const q = /^(?:[*+?]|\{\d+(?:,\d*)?\})/.exec(p.slice(i));
      if (!q) { out += ch; i++; continue; }
      i += q[0].length;
      let lazy = p[i] === '?';
      if (lazy) i++;
      if (f.U) lazy = !lazy;
      out += q[0] + (lazy ? '?' : '');
    }
  }
  while (frames.length) out += ')'.repeat(frames.pop()!.mods.length);
  return { src: out, flags };
}

/** A glob (*, **, ?, [..], {a,b}) as a regex over a path */
function globRe(g: string, ci: boolean): RegExp {
  let re = '', i = 0, brace = 0;
  while (i < g.length) {
    const ch = g[i];
    if (ch === '*' && g[i + 1] === '*') {
      if (g[i + 2] === '/') { re += '(?:.*/)?'; i += 3; } else { re += '.*'; i += 2; }
      continue;
    }
    if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else if (ch === '[') { const j = g.indexOf(']', i + 1); if (j < 0) re += '\\['; else { re += '[' + g.slice(i + 1, j).replace(/^!/, '^').replace(/\\/g, '\\\\') + ']'; i = j; } }
    else if (ch === '{') { re += '(?:'; brace++; }
    else if (ch === '}' && brace) { re += ')'; brace--; }
    else if (ch === ',' && brace) re += '|';
    else if (ch === '\\' && i + 1 < g.length) { re += '\\' + g[++i]; }
    else re += ch.replace(/[.+^$()|\\/]/g, '\\$&');
    i++;
  }
  return new RegExp('^' + re + '$', ci ? 'i' : '');
}

const utf8 = new TextEncoder();
/** UTF-8 length (ripgrep's columns and offsets count bytes) */
const blen = (s: string) => (/^[\x00-\x7f]*$/.test(s) ? s.length : utf8.encode(s).length);

const C = { path: '\x1b[0m\x1b[35m', num: '\x1b[0m\x1b[32m', col: '\x1b[0m', match: '\x1b[0m\x1b[1m\x1b[31m', end: '\x1b[0m' };

interface Sub { text: string; start: number; end: number; m?: RegExpExecArray }

export const rgCmd: Command = {
  name: 'rg',
  description: 'Recursively search for a pattern in files (ripgrep)',
  async exec(ctx: CommandContext) {
    const tty = !!ctx.terminal && ctx.stdoutIsTTY !== false;
    let caseMode = 'sensitive' as 'sensitive' | 'insensitive' | 'smart';
    let invertMatch = false;
    let lineNumbers: boolean | null = null; // null: on a terminal only
    let mode = 'lines' as 'lines' | 'count' | 'count-matches' | 'files' | 'files-without';
    let listFiles = false; // --files (Glob tool)
    let wordMatch = false, lineMatch = false;
    let onlyMatching = false;
    let fixedStrings = false;
    let filename: boolean | null = null; // -H / -I; null: a directory or several paths
    let heading: boolean | null = null; // null: on a terminal
    let color = 'auto' as 'auto' | 'always' | 'never';
    let hidden = false;
    let searchBinary = false;
    let sortBy = '', sortReverse = false;
    let maxDepth = -1; // -1: unlimited
    let afterCtx = 0, beforeCtx = 0;
    let nullSep = false; // --null / -0: a NUL after each path instead of : or a newline
    let json = false; // --json: ripgrep's JSON lines (Claude Code's Grep content mode)
    let multiline = false; // -U / --multiline: a match may span lines
    let dotall = false; // --multiline-dotall: . matches \n too
    let maxCount = 0; // -m N: at most N matching lines per file (0: no limit)
    let maxColumns = 0;
    let replace: string | null = null;
    let quiet = false, stats = false, column = false, byteOffset = false, vimgrep = false;
    let trim = false, passthru = false, includeZero = false, noMessages = false;
    let ctxSeparator: string | null = '--';
    const patterns: string[] = [];
    let patternGiven = false; // -e / -f: every positional is a path
    const positional: string[] = [];
    const typeFilters: string[] = [];
    const typeNot: string[] = [];
    const globFilters: { g: string; ci: boolean }[] = [];
    let unrestricted = 0;

    const option = async (name: string, value?: string): Promise<number | undefined> => {
      switch (name) {
        case 'ignore-case': caseMode = 'insensitive'; break;
        case 'case-sensitive': caseMode = 'sensitive'; break;
        case 'smart-case': caseMode = 'smart'; break;
        case 'invert-match': invertMatch = true; break;
        case 'line-number': lineNumbers = true; break;
        case 'no-line-number': lineNumbers = false; break;
        case 'count': mode = 'count'; break;
        case 'count-matches': mode = 'count-matches'; break;
        case 'files-with-matches': mode = 'files'; break;
        case 'files-without-match': mode = 'files-without'; break;
        case 'word-regexp': wordMatch = true; break;
        case 'line-regexp': lineMatch = true; break;
        case 'only-matching': onlyMatching = true; break;
        case 'fixed-strings': fixedStrings = true; break;
        case 'no-fixed-strings': fixedStrings = false; break;
        case 'with-filename': filename = true; break;
        case 'no-filename': filename = false; break;
        case 'heading': heading = true; break;
        case 'no-heading': heading = false; break;
        case 'hidden': hidden = true; break;
        case 'no-hidden': hidden = false; break;
        case 'files': listFiles = true; break;
        case 'null': nullSep = true; break;
        case 'json': json = true; break;
        case 'no-json': json = false; break;
        case 'multiline': multiline = true; break;
        case 'multiline-dotall': dotall = true; break;
        case 'quiet': quiet = true; break;
        case 'stats': stats = true; break;
        case 'column': column = true; break;
        case 'no-column': column = false; break;
        case 'byte-offset': byteOffset = true; break;
        case 'vimgrep': vimgrep = true; break;
        case 'trim': trim = true; break;
        case 'no-trim': trim = false; break;
        case 'passthru': case 'passthrough': passthru = true; break;
        case 'include-zero': includeZero = true; break;
        case 'no-messages': noMessages = true; break;
        case 'text': searchBinary = true; break;
        case 'unrestricted': unrestricted++; break;
        case 'pretty': color = 'always'; heading = true; lineNumbers = true; break;
        case 'no-context-separator': ctxSeparator = null; break;
        case 'regexp': patterns.push(value!); patternGiven = true; break;
        case 'file': {
          const text = value === '-' ? (ctx.readStdin ? await ctx.readStdin() : ctx.stdin)
            : await ctx.fs.readFile(ctx.fs.resolvePath(value!, ctx.cwd), 'utf8').catch(() => null) as string | null;
          if (text === null) { ctx.stderr += `rg: ${value}: No such file or directory (os error 2)\n`; return 2; }
          patterns.push(...text.split('\n').filter((l, k, a) => k < a.length - 1 || l !== ''));
          patternGiven = true;
          break;
        }
        case 'replace': replace = value!; break;
        case 'sort': sortBy = value!; sortReverse = false; break;
        case 'sortr': sortBy = value!; sortReverse = true; break;
        case 'sort-files': sortBy = 'path'; break;
        case 'max-depth': case 'maxdepth': maxDepth = parseInt(value!, 10); if (isNaN(maxDepth)) maxDepth = -1; break;
        case 'type': typeFilters.push(value!); break;
        case 'type-not': typeNot.push(value!); break;
        case 'glob': globFilters.push({ g: value!, ci: false }); break;
        case 'iglob': globFilters.push({ g: value!, ci: true }); break;
        case 'after-context': afterCtx = parseInt(value!, 10) || 0; break;
        case 'before-context': beforeCtx = parseInt(value!, 10) || 0; break;
        case 'context': afterCtx = beforeCtx = parseInt(value!, 10) || 0; break;
        case 'max-columns': maxColumns = parseInt(value!, 10) || 0; break;
        case 'max-count': maxCount = parseInt(value!, 10) || 0; break;
        case 'color': case 'colour': color = value === 'always' || value === 'ansi' ? 'always' : value === 'never' ? 'never' : 'auto'; break;
        case 'context-separator': ctxSeparator = value!; break;
        case 'type-list':
          for (const t of Object.keys(TYPES)) ctx.stdout += `${t}: ${TYPES[t].map((e) => '*' + e).join(', ')}\n`;
          return 0;
        case 'version': ctx.stdout = 'ripgrep 14.1.0 (tabcomputer built-in)\n'; return 0;
        case 'help':
          ctx.stdout = 'Usage: rg [OPTIONS] PATTERN [PATH...]\n       rg --files [PATH...]\n\nOptions:\n  -i/-s/-S    Case insensitive / sensitive / smart\n  -v          Invert match\n  -n/-N       Show/hide line numbers\n  -H/-I       Show/hide file names\n  -c          Count matching lines (--count-matches: matches)\n  -l          Files with matches (--files-without-match)\n  -w/-x       Whole words / whole lines\n  -o          Only the matching text\n  -r TEXT     Replace each match ($0, $1, ${name})\n  -F          Fixed strings (no regex)\n  -e PATTERN  A pattern (repeatable); -f FILE: patterns from a file\n  -t/-T TYPE  Only / not this file type (--type-list)\n  -g GLOB     Glob filter (!GLOB excludes)\n  -A/-B/-C N  Context lines\n  -m N        At most N matches per file\n  -U          Multiline\n  -q          Quiet; --stats, --json, --vimgrep, --column, -b\n  --hidden    Search hidden files\n';
          return 0;
        default: break; // another option: accepted, no effect here
      }
      return undefined;
    };

    const args = ctx.args;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      let r: number | undefined;
      if (arg === '--') { positional.push(...args.slice(i + 1)); break; }
      if (arg.startsWith('--') && arg.length > 2) {
        const eq = arg.indexOf('=');
        const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
        if (LONG_VALUE.has(name)) {
          let value: string;
          if (eq > 0) value = arg.slice(eq + 1);
          else if (i + 1 < args.length) value = args[++i];
          else { ctx.stderr = `rg: flag --${name} requires a value\n`; return 2; }
          r = await option(name, value);
        } else r = await option(name);
      } else if (arg.startsWith('-') && arg.length > 1) {
        // bundled short flags; a value-taking one takes the rest of the word or the next
        for (let k = 1; k < arg.length; k++) {
          const ch = arg[k];
          if (SHORT_VALUE[ch]) {
            let value: string;
            if (k + 1 < arg.length) value = arg.slice(k + 1);
            else if (i + 1 < args.length) value = args[++i];
            else { ctx.stderr = `rg: flag -${ch} requires a value\n`; return 2; }
            r = await option(SHORT_VALUE[ch], value);
            break;
          }
          if (SHORT_SWITCH[ch]) { r = await option(SHORT_SWITCH[ch]); if (r !== undefined) break; }
        }
      } else positional.push(arg);
      if (r !== undefined) return r;
    }
    // -u: no ignore files (none are read here); -uu: hidden files too; -uuu: binary ones
    if (unrestricted >= 2) hidden = true;
    if (unrestricted >= 3) searchBinary = true;
    if (!patternGiven && !listFiles) {
      if (!positional.length) { ctx.stderr = 'rg: no pattern given\n'; return 2; }
      patterns.push(positional.shift()!);
    }
    const paths = positional;
    if (vimgrep) { filename = true; lineNumbers = true; column = true; heading = false; }

    // which files: --type, --type-not, globs (the last matching glob decides)
    const allowedExts = new Set<string>();
    for (const t of typeFilters) {
      const exts = TYPES[t];
      if (exts) exts.forEach((e) => allowedExts.add(e));
      else { ctx.stderr = `rg: error parsing flag -t: unrecognized file type: ${t}\n`; return 2; }
    }
    const deniedExts = new Set<string>();
    for (const t of typeNot) TYPES[t]?.forEach((e) => deniedExts.add(e));
    const globs = globFilters.map(({ g, ci }) => {
      const neg = g.startsWith('!');
      const pat = neg ? g.slice(1) : g;
      // a glob without '/' matches the basename
      return { re: globRe(pat.replace(/^\//, ''), ci), neg, basenameOnly: !pat.includes('/') };
    });
    const hasWhitelist = globs.some((g) => !g.neg);
    const globVerdict = (filePath: string): boolean | null => {
      const basename = filePath.slice(filePath.lastIndexOf('/') + 1);
      for (let k = globs.length - 1; k >= 0; k--) {
        const { re, neg, basenameOnly } = globs[k];
        if (re.test(basenameOnly ? basename : filePath.replace(/^\.\//, ''))) return !neg;
      }
      return null;
    };
    const matchesFilters = (filePath: string): boolean => {
      const base = filePath.slice(filePath.lastIndexOf('/') + 1);
      const ext = base.includes('.') ? base.slice(base.lastIndexOf('.')) : '';
      if (allowedExts.size > 0 && !allowedExts.has(ext)) return false;
      if (deniedExts.has(ext)) return false;
      const v = globVerdict(filePath);
      return v === null ? !hasWhitelist : v;
    };
    /** A directory a negated glob names is not entered */
    const dirAllowed = (dirPath: string) => globVerdict(dirPath) !== false;

    /** The files under each path: [real path, shown path, mtime], in walk (or --sort) order */
    let hadError = false;
    const walk = async (p: string, implicit: boolean): Promise<{ file: string; shown: string; mtime: number; explicit: boolean }[]> => {
      const out: { file: string; shown: string; mtime: number; explicit: boolean }[] = [];
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      let st: any;
      try { st = await ctx.fs.stat(resolved); }
      catch {
        hadError = true;
        if (!noMessages) ctx.stderr += `rg: ${p}: No such file or directory (os error 2)\n`;
        return out;
      }
      if (!st.isDirectory()) {
        out.push({ file: resolved, shown: p, mtime: st.mtime?.getTime?.() || 0, explicit: true });
        return out;
      }
      const visit = async (dirPath: string, shownBase: string, depth: number) => {
        if (maxDepth >= 0 && depth > maxDepth) return;
        let entries: string[];
        try { entries = await ctx.fs.readdir(dirPath); } catch { return; }
        if (sortBy === 'path') entries = [...entries].sort();
        for (const entry of entries) {
          if (!hidden && entry.startsWith('.')) continue;
          if (entry === 'node_modules' || entry === '.git') continue;
          const childPath = dirPath === '/' ? '/' + entry : dirPath + '/' + entry;
          const shown = shownBase ? (shownBase.endsWith('/') ? shownBase + entry : shownBase + '/' + entry) : entry;
          try {
            const s = await ctx.fs.stat(childPath);
            if (s.isDirectory()) { if (dirAllowed(shown)) await visit(childPath, shown, depth + 1); }
            else if (s.isFile() && matchesFilters(shown)) // (not a FIFO: reading one would wait)
              out.push({ file: childPath, shown, mtime: s.mtime?.getTime?.() || 0, explicit: false });
          } catch { /* skip */ }
        }
      };
      await visit(resolved, implicit ? '' : p, 1);
      if (sortBy === 'modified' || sortBy === 'accessed' || sortBy === 'created') out.sort((a, b) => a.mtime - b.mtime);
      else if (sortBy === 'path') out.sort((a, b) => (a.shown < b.shown ? -1 : a.shown > b.shown ? 1 : 0));
      if (sortReverse) out.reverse();
      return out;
    };

    // --files mode: list the files that would be searched (Claude Code's Glob tool)
    if (listFiles) {
      const all = paths.length ? paths : [ctx.cwd];
      let n = 0;
      for (const p of all) {
        const files = await walk(p, !paths.length);
        for (const f of files) {
          if (f.explicit && !matchesFilters(f.shown)) continue;
          ctx.stdout += f.shown + (nullSep ? '\0' : '\n');
          n++;
        }
      }
      return hadError ? 2 : n > 0 ? 0 : 1;
    }

    // Build the regex: the patterns as alternatives
    if (caseMode === 'smart') caseMode = patterns.some((p) => /[A-Z]/.test(fixedStrings ? p : p.replace(/\\./g, ''))) ? 'sensitive' : 'insensitive';
    let extraFlags = '';
    const parts = patterns.map((p) => {
      if (fixedStrings) return p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
      // Several patterns: one's (?i) mustn't become a flag for all of them
      const t = toJs(p, patterns.length === 1);
      extraFlags += t.flags;
      return t.src;
    });
    let patternStr = parts.length === 1 ? parts[0] : parts.map((p) => `(?:${p})`).join('|');
    if (!parts.length) patternStr = '(?!)';
    if (lineMatch) patternStr = `^(?:${patternStr})$`;
    else if (wordMatch) patternStr = `(?<![\\w])(?:${patternStr})(?![\\w])`;
    const ci = caseMode === 'insensitive' || extraFlags.includes('i');
    const unicode = /\\[pP]/.test(patternStr) ? 'u' : '';
    let regex: RegExp;
    let mlRegex: RegExp | null = null;
    try {
      regex = new RegExp(patternStr, 'g' + (ci ? 'i' : '') + unicode + (extraFlags.includes('s') ? 's' : ''));
      // A multiline search runs one regex over the whole text (^ $ at line ends)
      if (multiline) mlRegex = new RegExp(patternStr, 'gm' + (ci ? 'i' : '') + unicode + (dotall || extraFlags.includes('s') ? 's' : ''));
    } catch (e: any) {
      ctx.stderr = `rg: regex parse error:\n    ${patterns.join('\n    ')}\nerror: ${String(e?.message ?? e).replace(/^Invalid regular expression: /, '')}\n`;
      return 2;
    }

    /** -r: the replacement for one match ($0, $1, $name, ${name}, $$) */
    const expand = (m: RegExpExecArray) => replace!.replace(/\$(\$|\{([^}]*)\}|([0-9A-Za-z_]+))/g, (_, all, braced, bare) => {
      if (all === '$') return '$';
      const name = braced ?? bare;
      const v = /^\d+$/.test(name) ? m[Number(name)] : m.groups?.[name];
      return v ?? '';
    });

    const useColor = color === 'always' || (color === 'auto' && tty);
    const paint = (code: string, s: string) => (useColor ? code + s + C.end : s);

    // --json: the run's totals for its summary line
    const totals = { searches: 0, searchesWithMatch: 0, bytesSearched: 0, matchedLines: 0, matches: 0 };
    const t0 = Date.now();
    let printed = 0; // bytes of results written
    const emit = (s: string) => { if (!quiet) { ctx.stdout += s; printed += blen(s); } };
    const jsonLine = (o: unknown) => emit(JSON.stringify(o) + '\n');
    const elapsed = () => { const ms = Date.now() - t0; return { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6, human: `${(ms / 1000).toFixed(6)}s` }; };

    let found = false;
    let anyPrinted = false; // for the separator between files
    // No path and stdin is a pipe or file (`cmd | rg PAT`, `rg PAT < f`): search
    // stdin, as ripgrep does; a terminal or /dev/null means the working directory
    const fromStdin = paths.length === 0 && !!ctx.stdinReadable;
    const showLineNumbers = lineNumbers ?? (tty || column);
    let showFilename = false; // set below: a directory or several paths
    const useHeading = () => (heading ?? tty) && showFilename && mode === 'lines' && !json;

    /**
     * Binary: a NUL in the first 64 KiB (rg gives up on a binary file at its first
     * NUL). A big file is checked from its first stored block, not read whole.
     */
    const binaryHead = async (filePath: string): Promise<boolean> => {
      const fs = ctx.fs as unknown as { blobOf?: (p: string) => string | undefined; readBlock?: (id: string, i: number, keep?: boolean) => Promise<Uint8Array> };
      const id = fs.blobOf?.(filePath);
      if (!id || !fs.readBlock) return false;
      try { return (await fs.readBlock(id, 0, false)).subarray(0, 65536).includes(0); } catch { return false; }
    };

    const searchFile = async (filePath: string, displayPath: string, explicit: boolean, text?: string) => {
      if (text === undefined && !explicit && !searchBinary && await binaryHead(filePath)) return;
      let content: string;
      let size: number;
      let nulAt = -1;
      try {
        if (text !== undefined) { content = text; size = blen(text); }
        else {
          const bytes = await ctx.fs.readFile(filePath) as Uint8Array;
          size = bytes.length;
          nulAt = searchBinary ? -1 : bytes.indexOf(0);
          if (nulAt >= 0 && !explicit) return; // binary: skipped, before decoding it (~0.3 s for 30 MB, #19)
          content = decodeBytes(bytes);
        }
      } catch { return; }
      if (nulAt < 0 && !searchBinary) nulAt = content.indexOf('\0');
      totals.searches++;
      totals.bytesSearched += size;

      const lines = content.split('\n');
      const endsNL = content.endsWith('\n');
      if (endsNL) lines.pop();
      const lineStart: number[] = [];
      for (let k = 0, off = 0; k < lines.length; k++) { lineStart.push(off); off += blen(lines[k]) + 1; }
      const matchedLineNums = new Set<number>();
      const contextLineNums = new Set<number>();
      /** Per matching line (its first line, for a multiline match): the matches, offsets in that line */
      const subs = new Map<number, Sub[]>();
      /** Multiline: the last line of the match block that starts at a line */
      const blockEnd = new Map<number, number>();
      let matchCount = 0;
      const addContext = (first: number, last: number) => {
        for (let b = Math.max(0, first - beforeCtx); b < first; b++) contextLineNums.add(b);
        for (let a = last + 1; a <= Math.min(lines.length - 1, last + afterCtx); a++) contextLineNums.add(a);
      };

      if (mlRegex) {
        // -U: matches over the whole text; each covers the lines from its start to its end
        const lineStartCh: number[] = [];
        for (let k = 0, off = 0; k < lines.length; k++) { lineStartCh.push(off); off += lines[k].length + 1; }
        mlRegex.lastIndex = 0;
        let m: RegExpExecArray | null;
        const lineOf = (off: number) => { let lo = 0, hi = lineStartCh.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStartCh[mid] <= off) lo = mid; else hi = mid - 1; } return lo; };
        while ((m = mlRegex.exec(content)) !== null) {
          if (m[0] === '') { mlRegex.lastIndex++; continue; }
          const first = lineOf(m.index), last = lineOf(m.index + m[0].length - 1);
          if (!subs.has(first)) {
            if (maxCount && matchCount >= maxCount) break;
            matchCount++;
          }
          for (let k = first; k <= last; k++) matchedLineNums.add(k);
          blockEnd.set(first, Math.max(blockEnd.get(first) ?? first, last));
          const list = subs.get(first) ?? [];
          list.push({ text: m[0], start: m.index - lineStartCh[first], end: m.index - lineStartCh[first] + m[0].length, m });
          subs.set(first, list);
          addContext(first, last);
        }
      } else {
        for (let ln = 0; ln < lines.length; ln++) {
          regex.lastIndex = 0;
          const match = regex.test(lines[ln]);
          if (match !== invertMatch) {
            if (maxCount && matchCount >= maxCount) break;
            matchedLineNums.add(ln);
            matchCount++;
            if (!invertMatch) {
              const list: Sub[] = [];
              regex.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = regex.exec(lines[ln])) !== null) {
                if (m[0] === '') { regex.lastIndex++; if (list.length || lines[ln] !== '') continue; }
                list.push({ text: m[0], start: m.index, end: m.index + m[0].length, m });
                if (m[0] === '') break;
              }
              subs.set(ln, list);
            } else subs.set(ln, []);
            addContext(ln, ln);
          }
        }
      }

      const nMatches = invertMatch ? matchCount : [...subs.values()].reduce((n, l) => n + l.length, 0);
      const pathOut = (p: string) => paint(C.path, p);
      const pathPrefix = () => (showFilename ? pathOut(displayPath) + (nullSep ? '\0' : ':') : '');

      if (mode === 'files-without') {
        if (matchCount === 0) { found = true; emit(pathOut(displayPath) + (nullSep ? '\0' : '\n')); }
        return;
      }
      const passAll = passthru && mode === 'lines' && !json; // --passthru: every line, matching or not
      if (matchCount === 0 && !passAll) {
        if (includeZero && (mode === 'count' || mode === 'count-matches')) emit(pathPrefix() + '0\n');
        return;
      }
      if (matchCount) { found = true; totals.searchesWithMatch++; }
      totals.matchedLines += matchedLineNums.size;
      totals.matches += nMatches;

      if (mode === 'files') { emit(pathOut(displayPath) + (nullSep ? '\0' : '\n')); return; }
      if (mode === 'count' || mode === 'count-matches') {
        emit(pathPrefix() + (mode === 'count-matches' || onlyMatching ? nMatches : matchCount) + '\n');
        return;
      }

      if (json) {
        // ripgrep's JSON lines: begin, a match (or context) per line, end
        const path = { text: displayPath };
        jsonLine({ type: 'begin', data: { path } });
        const shown = [...new Set([...subs.keys(), ...contextLineNums])].filter((ln) => !(matchedLineNums.has(ln) && !subs.has(ln))).sort((a, b) => a - b);
        for (const ln of shown) {
          const isMatch = subs.has(ln);
          const last = isMatch ? (blockEnd.get(ln) ?? ln) : ln;
          const textLines = lines.slice(ln, last + 1).join('\n') + (last < lines.length - 1 || endsNL ? '\n' : '');
          jsonLine({
            type: isMatch ? 'match' : 'context',
            data: {
              path, lines: { text: textLines }, line_number: ln + 1,
              absolute_offset: lineStart[ln],
              submatches: isMatch ? subs.get(ln)!.map((m) => ({ match: { text: m.text }, start: m.start, end: m.end })) : [],
            },
          });
        }
        jsonLine({
          type: 'end',
          data: {
            path, binary_offset: null,
            stats: { elapsed: elapsed(), searches: 1, searches_with_match: 1, bytes_searched: size, bytes_printed: 0, matched_lines: matchedLineNums.size, matches: nMatches },
          },
        });
        return;
      }

      if (nulAt >= 0) {
        // an explicitly named binary file: ripgrep reports it instead of printing its lines
        emit(`${showFilename ? pathOut(displayPath) + ': ' : ''}binary file matches (found "\\0" byte around offset ${nulAt})\n`);
        return;
      }

      // matched and context lines
      const withCtx = afterCtx > 0 || beforeCtx > 0;
      if (useHeading()) {
        if (anyPrinted) emit('\n');
        emit(pathOut(displayPath) + (nullSep ? '\0' : '\n'));
      } else if (anyPrinted && withCtx && ctxSeparator !== null) emit(ctxSeparator + '\n');
      anyPrinted = true;
      const allLines = passthru ? lines.map((_, k) => k) : [...new Set([...matchedLineNums, ...contextLineNums])].sort((a, b) => a - b);
      const inlinePath = showFilename && !useHeading();
      /** path, line number, column, byte offset, each with its separator (: a match, - context) */
      const head = (ln: number, sep: string, col: number, off: number) => {
        let h = inlinePath ? pathOut(displayPath) + (nullSep ? '\0' : sep) : '';
        if (showLineNumbers) h += paint(C.num, String(ln + 1)) + sep;
        if (column) h += (useColor ? C.col + col + C.end : String(col)) + sep;
        if (byteOffset) h += (useColor ? C.col + off + C.end : String(off)) + sep;
        return h;
      };
      const body = (s: string, kind: 'matching' | 'context') => {
        const t = trim ? s.replace(/^[ \t\f\v\r]+/, '') : s;
        return maxColumns && blen(t) >= maxColumns ? `[Omitted long ${kind} line]` : t;
      };
      /** A line with its matches coloured / replaced */
      const marked = (ln: number, list: Sub[]) => {
        const line = lines.slice(ln, (blockEnd.get(ln) ?? ln) + 1).join('\n'); // (-U: a match's lines)
        if (!list.length || (!useColor && replace === null)) return line;
        let out = '', at = 0;
        for (const s of list) {
          if (s.start < at) continue;
          out += line.slice(at, s.start) + paint(C.match, replace !== null ? expand(s.m!) : s.text);
          at = Math.min(s.end, line.length);
        }
        return out + line.slice(at);
      };
      let lastLn = -2, doneUntil = -1;
      for (const ln of allLines) {
        if (ln <= doneUntil) continue; // printed with the multiline match before it
        if (withCtx && !passthru && lastLn >= 0 && ln > lastLn + 1 && ctxSeparator !== null) emit(ctxSeparator + '\n'); // between context groups
        const isMatch = matchedLineNums.has(ln);
        const list = subs.get(ln) ?? [];
        if (onlyMatching && isMatch) {
          for (const s of list) {
            const text = replace !== null ? expand(s.m!) : s.text;
            const col = blen(lines[ln].slice(0, s.start)) + 1;
            emit(head(ln, ':', col, lineStart[ln] + col - 1) + body(paint(C.match, text), 'matching') + '\n');
          }
        } else if (vimgrep && isMatch && list.length > 1) {
          for (const s of list) {
            const col = blen(lines[ln].slice(0, s.start)) + 1;
            emit(head(ln, ':', col, lineStart[ln]) + body(marked(ln, list), 'matching') + '\n');
          }
        } else {
          const first = list[0];
          const col = isMatch && first ? blen(lines[ln].slice(0, first.start)) + 1 : 1;
          const sep = isMatch ? ':' : '-';
          const text = isMatch && !invertMatch && subs.has(ln) ? marked(ln, list) : lines[ln];
          text.split('\n').forEach((t, k) => emit(head(ln + k, sep, k ? 1 : col, lineStart[ln + k]) + body(t, isMatch ? 'matching' : 'context') + '\n'));
          if (blockEnd.has(ln)) doneUntil = blockEnd.get(ln)!;
        }
        lastLn = ln;
      }
    };

    if (fromStdin) {
      const text = ctx.liveStdin && ctx.shell?.kernelStdio ? await ctx.shell.kernelStdio.readAll()
        : ctx.readStdin ? await ctx.readStdin() : ctx.stdin;
      showFilename = filename === true;
      await searchFile('-', '<stdin>', true, text);
      return finish();
    }

    // the path shows with a directory search or several paths
    const searchPaths = paths.length > 0 ? paths : [ctx.cwd];
    if (filename === null) {
      showFilename = searchPaths.length > 1;
      for (const p of searchPaths) {
        if (showFilename) break;
        try { if ((await ctx.fs.stat(ctx.fs.resolvePath(p, ctx.cwd))).isDirectory()) showFilename = true; } catch { /* reported by the walk */ }
      }
    } else showFilename = filename;
    for (const p of searchPaths) {
      for (const f of await walk(p, paths.length === 0)) {
        await searchFile(f.file, f.shown, f.explicit);
        if (quiet && found && mode !== 'files-without') return finish();
      }
    }
    if (!totals.searches && !hadError && (globs.length || allowedExts.size || deniedExts.size)) {
      if (!noMessages) ctx.stderr += "rg: No files were searched, which means ripgrep probably applied a filter you didn't expect.\nRunning with --debug will show why files are being skipped.\n";
      return 2;
    }
    return finish();

    function finish(): number {
      const ms = Date.now() - t0;
      if (json) {
        const e = elapsed();
        ctx.stdout += JSON.stringify({
          data: {
            elapsed_total: { human: e.human, nanos: e.nanos, secs: e.secs },
            stats: {
              bytes_printed: printed, bytes_searched: totals.bytesSearched, elapsed: { human: e.human, nanos: e.nanos, secs: e.secs },
              matched_lines: totals.matchedLines, matches: totals.matches, searches: totals.searches, searches_with_match: totals.searchesWithMatch,
            },
          },
          type: 'summary',
        }) + '\n';
      } else if (stats) {
        ctx.stdout += `\n${totals.matches} matches\n${totals.matchedLines} matched lines\n${totals.searchesWithMatch} files contained matches\n`
          + `${totals.searches} files searched\n${printed} bytes printed\n${totals.bytesSearched} bytes searched\n`
          + `${(ms / 1000).toFixed(6)} seconds spent searching\n${(ms / 1000).toFixed(6)} seconds\n`;
      }
      if (quiet && found) return 0;
      return hadError ? 2 : found ? 0 : 1;
    }
  },
};
