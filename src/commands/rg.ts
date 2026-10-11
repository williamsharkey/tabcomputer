import { Command, CommandContext } from './index';
import { decodeBytes } from '../utils/byte-text';

/**
 * rg: ripgrep-compatible search command
 *
 * Claude Code's Grep tool depends on this. Searches recursively by default.
 * Supports the most common ripgrep flags that Claude Code actually uses.
 */
export const rgCmd: Command = {
  name: 'rg',
  description: 'Recursively search for a pattern in files (ripgrep)',
  async exec(ctx: CommandContext) {
    let ignoreCase = false;
    let invertMatch = false;
    let lineNumbers = true; // rg shows line numbers by default
    let lineNumbersGiven = false; // -n or -N (stdin alone: off unless -n)
    let countOnly = false;
    let filesOnly = false;
    let listFiles = false; // --files mode (Glob tool)
    let wordMatch = false;
    let onlyMatching = false;
    let fixedStrings = false;
    let noFilename = false;
    let forceFilename = false;
    let hidden = false;
    let followSymlinks = false;
    let noIgnore = false;
    let sortBy = ''; // 'modified', 'path', etc.
    let maxDepth = 0; // 0 = unlimited
    let afterCtx = 0, beforeCtx = 0;
    let nullSep = false; // --null / -0: a NUL after each path instead of : or a newline
    let json = false; // --json: ripgrep's JSON lines (Claude Code's Grep content mode)
    let multiline = false; // -U / --multiline: a match may span lines
    let dotall = false; // --multiline-dotall: . matches \n too
    let maxCount = 0; // -m N: at most N matching lines per file (0: no limit)
    let pattern = '';
    const paths: string[] = [];
    const typeFilters: string[] = [];
    const globFilters: string[] = [];

    // File type → extensions mapping (subset of rg's built-in types)
    const typeMap: Record<string, string[]> = {
      js: ['.js', '.mjs', '.cjs'],
      ts: ['.ts', '.tsx', '.mts', '.cts'],
      py: ['.py', '.pyi'],
      rust: ['.rs'],
      go: ['.go'],
      java: ['.java'],
      c: ['.c', '.h'],
      cpp: ['.cpp', '.cc', '.cxx', '.hpp', '.hxx', '.h'],
      css: ['.css', '.scss', '.less'],
      html: ['.html', '.htm'],
      json: ['.json'],
      yaml: ['.yaml', '.yml'],
      toml: ['.toml'],
      md: ['.md', '.markdown'],
      sh: ['.sh', '.bash', '.zsh'],
      xml: ['.xml'],
      sql: ['.sql'],
      ruby: ['.rb'],
      php: ['.php'],
      swift: ['.swift'],
      kotlin: ['.kt', '.kts'],
    };

    let i = 0;
    while (i < ctx.args.length) {
      const arg = ctx.args[i];
      if (arg === '--') { i++; while (i < ctx.args.length) paths.push(ctx.args[i++]); break; }
      if (arg === '-i' || arg === '--ignore-case') { ignoreCase = true; }
      else if (arg === '-v' || arg === '--invert-match') { invertMatch = true; }
      else if (arg === '-n' || arg === '--line-number') { lineNumbers = true; lineNumbersGiven = true; }
      else if (arg === '-N' || arg === '--no-line-number') { lineNumbers = false; lineNumbersGiven = true; }
      else if (arg === '-c' || arg === '--count') { countOnly = true; }
      else if (arg === '-l' || arg === '--files-with-matches') { filesOnly = true; }
      else if (arg === '-w' || arg === '--word-regexp') { wordMatch = true; }
      else if (arg === '-o' || arg === '--only-matching') { onlyMatching = true; }
      else if (arg === '-F' || arg === '--fixed-strings') { fixedStrings = true; }
      else if (arg === '--no-filename') { noFilename = true; }
      else if (arg === '--with-filename' || arg === '-H') { forceFilename = true; }
      else if (arg === '--hidden') { hidden = true; }
      else if (arg === '--files') { listFiles = true; }
      else if (arg === '--follow' || arg === '-L') { followSymlinks = true; }
      else if (arg === '--no-ignore') { noIgnore = true; }
      else if (arg === '--no-heading') { /* default behavior */ }
      else if (arg === '--heading') { /* ignore for now */ }
      else if (arg === '-e' && i + 1 < ctx.args.length) { pattern = ctx.args[++i]; }
      else if (arg === '--sort' && i + 1 < ctx.args.length) { sortBy = ctx.args[++i]; }
      else if (arg.startsWith('--sort=')) { sortBy = arg.slice(7); }
      else if (arg === '--max-depth' || arg === '--maxdepth') {
        if (i + 1 < ctx.args.length) maxDepth = parseInt(ctx.args[++i], 10) || 0;
      } else if (arg.startsWith('--max-depth=')) {
        maxDepth = parseInt(arg.slice(12), 10) || 0;
      }
      else if (arg === '-t' || arg === '--type') {
        if (i + 1 < ctx.args.length) typeFilters.push(ctx.args[++i]);
      } else if (arg.startsWith('--type=')) {
        typeFilters.push(arg.slice(7));
      } else if (arg === '-g' || arg === '--glob') {
        if (i + 1 < ctx.args.length) globFilters.push(ctx.args[++i]);
      } else if (arg.startsWith('--glob=')) {
        globFilters.push(arg.slice(7));
      } else if (arg === '-A' || arg === '--after-context') {
        if (i + 1 < ctx.args.length) afterCtx = parseInt(ctx.args[++i], 10) || 0;
      } else if (arg.startsWith('-A') && /^-A\d+$/.test(arg)) {
        afterCtx = parseInt(arg.slice(2), 10) || 0;
      } else if (arg === '-B' || arg === '--before-context') {
        if (i + 1 < ctx.args.length) beforeCtx = parseInt(ctx.args[++i], 10) || 0;
      } else if (arg.startsWith('-B') && /^-B\d+$/.test(arg)) {
        beforeCtx = parseInt(arg.slice(2), 10) || 0;
      } else if (arg === '-C' || arg === '--context') {
        if (i + 1 < ctx.args.length) { const c = parseInt(ctx.args[++i], 10) || 0; afterCtx = beforeCtx = c; }
      } else if (arg.startsWith('-C') && /^-C\d+$/.test(arg)) {
        afterCtx = beforeCtx = parseInt(arg.slice(2), 10) || 0;
      } else if (arg === '--max-columns' || arg === '-M') {
        if (i + 1 < ctx.args.length) i++; // consume value, ignore
      } else if (arg.startsWith('--max-columns=')) {
        // ignore
      } else if (arg === '-m' || arg === '--max-count') {
        if (i + 1 < ctx.args.length) maxCount = parseInt(ctx.args[++i], 10) || 0;
      } else if (arg.startsWith('--max-count=')) {
        maxCount = parseInt(arg.slice(12), 10) || 0;
      } else if (arg === '--null' || arg === '-0') {
        nullSep = true;
      } else if (arg === '--json') {
        json = true;
      } else if (arg === '--multiline' || arg === '-U') {
        multiline = true;
      } else if (arg === '--multiline-dotall') {
        dotall = true;
      } else if (arg === '--color' || arg === '--colour' || arg === '--colors' || arg === '--colours') {
        if (i + 1 < ctx.args.length) i++; // consume value (never, always, auto)
      } else if (arg.startsWith('--color=') || arg.startsWith('--colour=')) {
        // ignore
      } else if (arg === '--no-config' || arg === '--no-messages'
        || arg === '--pcre2'
        || arg === '--sort-files'
        || arg === '-S' || arg === '--smart-case'
        || arg === '--trim' || arg === '-j' || arg === '--threads'
        || arg === '--vimgrep') {
        // flags without values — consume and ignore
        if (arg === '-j' || arg === '--threads') { if (i + 1 < ctx.args.length) i++; } // -j takes a value
      } else if (arg === '--help' || arg === '-h') {
        ctx.stdout = 'Usage: rg [OPTIONS] PATTERN [PATH...]\n\nOptions:\n  -i          Case insensitive\n  -v          Invert match\n  -n/-N       Show/hide line numbers\n  -c          Count matches\n  -l          Files with matches only\n  -w          Word match\n  -o          Only matching text\n  -F          Fixed strings (no regex)\n  -t TYPE     File type (js, ts, py, etc.)\n  -g GLOB     Glob filter\n  -A/-B/-C N  Context lines\n  -e PATTERN  Pattern\n  --hidden    Search hidden files\n';
        return 0;
      } else if (arg.startsWith('-') && arg.length > 1 && !arg.startsWith('--')) {
        // Combined short flags like -in
        for (const ch of arg.slice(1)) {
          if (ch === 'i') ignoreCase = true;
          else if (ch === 'v') invertMatch = true;
          else if (ch === 'n') { lineNumbers = true; lineNumbersGiven = true; }
          else if (ch === 'N') { lineNumbers = false; lineNumbersGiven = true; }
          else if (ch === 'c') countOnly = true;
          else if (ch === 'l') filesOnly = true;
          else if (ch === 'w') wordMatch = true;
          else if (ch === 'o') onlyMatching = true;
          else if (ch === 'F') fixedStrings = true;
          else if (ch === 'H') forceFilename = true;
          else if (ch === 'U') multiline = true;
          else if (ch === '0') nullSep = true;
          else if (ch === 'L') { followSymlinks = true; }
        }
      } else if (arg.startsWith('--') && arg.length > 2) {
        // Another long option: not the pattern (an unknown --flag took its place)
      } else if (!pattern) {
        pattern = arg;
      } else {
        paths.push(arg);
      }
      i++;
    }

    // --files mode: list matching files (used by Claude Code Glob tool)
    if (listFiles) {
      // In --files mode, pattern is actually a path (no pattern needed)
      if (pattern) paths.unshift(pattern);
      const searchPaths = paths.length > 0 ? paths : [ctx.cwd];
      const files: { path: string; mtime: number }[] = [];

      const collectFiles = async (dirPath: string, basePath: string, depth: number) => {
        if (maxDepth > 0 && depth > maxDepth) return;
        let entries: string[];
        try { entries = await ctx.fs.readdir(dirPath); } catch { return; }
        for (const entry of entries) {
          if (!hidden && entry.startsWith('.')) continue;
          if (entry === 'node_modules' || entry === '.git') continue;
          const childPath = dirPath === '/' ? '/' + entry : dirPath + '/' + entry;
          const displayPath = basePath ? basePath + '/' + entry : entry;
          try {
            const stat = await ctx.fs.stat(childPath);
            if (stat.isDirectory()) {
              await collectFiles(childPath, displayPath, depth + 1);
            } else if (stat.isFile()) { // (not a FIFO: reading one would wait)
              if (matchesFilters(displayPath)) {
                files.push({ path: displayPath, mtime: stat.mtime?.getTime?.() || 0 });
              }
            }
          } catch { /* skip */ }
        }
      };

      // Build filters using the same glob/type matchers below
      const allowedExts = new Set<string>();
      for (const t of typeFilters) {
        const exts = typeMap[t];
        if (exts) exts.forEach(e => allowedExts.add(e));
      }
      const globMatchers = globFilters.map(g => {
        const neg = g.startsWith('!');
        const pat = neg ? g.slice(1) : g;
        // rg matches patterns without '/' against basename only
        const basenameOnly = !pat.includes('/');
        const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*').replace(/\?/g, '.') + '$');
        return { re, neg, basenameOnly };
      });
      const matchesFilters = (filePath: string): boolean => {
        const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
        if (allowedExts.size > 0 && !allowedExts.has(ext)) return false;
        const basename = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
        for (const { re, neg, basenameOnly } of globMatchers) {
          const target = basenameOnly ? basename : filePath;
          if (neg && re.test(target)) return false;
          if (!neg && !re.test(target)) return false;
        }
        return true;
      };

      for (const p of searchPaths) {
        const resolved = ctx.fs.resolvePath(p, ctx.cwd);
        try {
          const stat = await ctx.fs.stat(resolved);
          if (stat.isDirectory()) {
            await collectFiles(resolved, paths.length > 0 ? p : '', 1);
          } else {
            const display = paths.length > 0 ? p : resolved;
            if (matchesFilters(display)) {
              files.push({ path: display, mtime: stat.mtime?.getTime?.() || 0 });
            }
          }
        } catch {
          ctx.stderr += `rg: ${p}: No such file or directory\n`;
        }
      }

      // Sort by requested order
      if (sortBy === 'modified') {
        files.sort((a, b) => b.mtime - a.mtime); // newest first
      } else {
        files.sort((a, b) => a.path.localeCompare(b.path)); // alphabetical
      }

      ctx.stdout = files.map(f => f.path + (nullSep ? '\0' : '\n')).join('');
      return files.length > 0 ? 0 : 1;
    }

    if (!pattern) {
      ctx.stderr = 'rg: no pattern given\n';
      return 2;
    }

    // Build regex
    let patternStr = fixedStrings ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    if (wordMatch) patternStr = `\\b${patternStr}\\b`;
    const flags = ignoreCase ? 'gi' : 'g';
    let regex: RegExp;
    try {
      regex = new RegExp(patternStr, flags);
    } catch {
      ctx.stderr = `rg: invalid regex '${pattern}'\n`;
      return 2;
    }

    // Build allowed extensions from type filters
    const allowedExts = new Set<string>();
    for (const t of typeFilters) {
      const exts = typeMap[t];
      if (exts) exts.forEach(e => allowedExts.add(e));
      else { ctx.stderr += `rg: unknown file type: ${t}\n`; }
    }

    // Glob matchers
    const globMatchers = globFilters.map(g => {
      const neg = g.startsWith('!');
      const pat = neg ? g.slice(1) : g;
      // rg matches patterns without '/' against basename only
      const basenameOnly = !pat.includes('/');
      const re = new RegExp('^' + pat.replace(/\./g, '\\.').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*').replace(/\?/g, '.') + '$');
      return { re, neg, basenameOnly };
    });

    const matchesFilters = (filePath: string): boolean => {
      const ext = filePath.includes('.') ? filePath.slice(filePath.lastIndexOf('.')) : '';
      if (allowedExts.size > 0 && !allowedExts.has(ext)) return false;
      const basename = filePath.includes('/') ? filePath.slice(filePath.lastIndexOf('/') + 1) : filePath;
      for (const { re, neg, basenameOnly } of globMatchers) {
        const target = basenameOnly ? basename : filePath;
        if (neg && re.test(target)) return false;
        if (!neg && !re.test(target)) return false;
      }
      return true;
    };

    let found = false;
    // No path and stdin is a pipe or file (`cmd | rg PAT`, `rg PAT < f`): search
    // stdin, as ripgrep does; a terminal or /dev/null means the working directory
    const fromStdin = paths.length === 0 && !!ctx.stdinReadable;
    if (fromStdin && !lineNumbersGiven) lineNumbers = false;
    const searchPaths = paths.length > 0 ? paths : [ctx.cwd];
    const multiFile = !fromStdin; // rg shows filenames, except for stdin
    const showFilename = !noFilename && (forceFilename || multiFile);

    // --json: the run's totals for its summary line
    const totals = { searches: 0, searchesWithMatch: 0, bytesSearched: 0, matchedLines: 0, matches: 0 };
    const t0 = Date.now();
    const jsonLine = (o: unknown) => { ctx.stdout += JSON.stringify(o) + '\n'; };
    const elapsed = () => { const ms = Date.now() - t0; return { secs: Math.floor(ms / 1000), nanos: (ms % 1000) * 1e6, human: `${(ms / 1000).toFixed(6)}s` }; };
    /** Path then : (or a NUL with --null) before a line or count */
    const pathSep = nullSep ? '\0' : ':';
    // A multiline search runs one regex over the whole text (^ $ at line ends)
    const mlRegex = multiline ? new RegExp(patternStr, (ignoreCase ? 'gim' : 'gm') + (dotall ? 's' : '')) : null;

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

    const searchFile = async (filePath: string, displayPath: string, text?: string) => {
      if (text === undefined && !matchesFilters(displayPath)) return;
      if (text === undefined && await binaryHead(filePath)) return;
      let content: string;
      try {
        if (text !== undefined) content = text;
        else {
          const bytes = await ctx.fs.readFile(filePath) as Uint8Array;
          if (bytes.indexOf(0) >= 0) return; // binary: skipped, before decoding it (~0.3 s for 30 MB, #19)
          content = decodeBytes(bytes);
        }
      } catch { return; }
      // Skip binary files (a NUL near the start)
      if (content.slice(0, 65536).includes('\0')) return;
      totals.searches++;
      totals.bytesSearched += content.length;

      const lines = content.split('\n');
      const lineStart: number[] = [];
      for (let k = 0, off = 0; k < lines.length; k++) { lineStart.push(off); off += lines[k].length + 1; }
      const matchedLineNums = new Set<number>();
      const contextLineNums = new Set<number>();
      /** Per matching line (its first line, for a multiline match): the matches, offsets in that line */
      const subs = new Map<number, { text: string; start: number; end: number }[]>();
      /** Multiline: the last line of the match block that starts at a line */
      const blockEnd = new Map<number, number>();
      let matchCount = 0;
      const addContext = (first: number, last: number) => {
        for (let b = Math.max(0, first - beforeCtx); b < first; b++) contextLineNums.add(b);
        for (let a = last + 1; a <= Math.min(lines.length - 1, last + afterCtx); a++) contextLineNums.add(a);
      };

      if (mlRegex) {
        // -U: matches over the whole text; each covers the lines from its start to its end
        mlRegex.lastIndex = 0;
        let m: RegExpExecArray | null;
        const lineOf = (off: number) => { let lo = 0, hi = lineStart.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStart[mid] <= off) lo = mid; else hi = mid - 1; } return lo; };
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
          list.push({ text: m[0], start: m.index - lineStart[first], end: m.index - lineStart[first] + m[0].length });
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
              const list: { text: string; start: number; end: number }[] = [];
              regex.lastIndex = 0;
              let m: RegExpExecArray | null;
              while ((m = regex.exec(lines[ln])) !== null) {
                if (m[0] === '') { regex.lastIndex++; continue; }
                list.push({ text: m[0], start: m.index, end: m.index + m[0].length });
              }
              subs.set(ln, list);
            } else subs.set(ln, []);
            addContext(ln, ln);
          }
        }
      }

      if (matchCount === 0) return;
      found = true;
      totals.searchesWithMatch++;
      const nMatches = [...subs.values()].reduce((n, l) => n + l.length, 0);
      totals.matchedLines += matchedLineNums.size;
      totals.matches += nMatches;

      if (filesOnly) {
        ctx.stdout += displayPath + (nullSep ? '\0' : '\n');
        return;
      }
      if (countOnly) {
        ctx.stdout += (showFilename ? displayPath + pathSep : '') + matchCount + '\n';
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
          const textLines = lines.slice(ln, last + 1).join('\n') + (last < lines.length - 1 || content.endsWith('\n') ? '\n' : '');
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
            stats: { elapsed: elapsed(), searches: 1, searches_with_match: 1, bytes_searched: content.length, bytes_printed: 0, matched_lines: matchedLineNums.size, matches: nMatches },
          },
        });
        return;
      }

      // Output matched and context lines
      const allLineNums = new Set([...matchedLineNums, ...contextLineNums]);
      const sorted = [...allLineNums].sort((a, b) => a - b);
      let lastLn = -2;
      for (const ln of sorted) {
        if ((afterCtx || beforeCtx) && lastLn >= 0 && ln > lastLn + 1) ctx.stdout += '--\n'; // separator between context groups
        const prefix = showFilename ? displayPath + pathSep : '';
        const lineNum = lineNumbers ? (ln + 1) + ':' : '';
        if (onlyMatching && matchedLineNums.has(ln)) {
          for (const m of subs.get(ln) ?? []) ctx.stdout += prefix + lineNum + m.text + '\n';
        } else {
          const ctxSep = matchedLineNums.has(ln) ? ':' : '-';
          const lineNumStr = lineNumbers ? (ln + 1) + ctxSep : '';
          ctx.stdout += prefix + lineNumStr + lines[ln] + '\n';
        }
        lastLn = ln;
      }
    };

    const searchDir = async (dirPath: string, basePath: string) => {
      let entries: string[];
      try {
        entries = await ctx.fs.readdir(dirPath);
      } catch { return; }
      for (const entry of entries) {
        if (!hidden && entry.startsWith('.')) continue;
        if (entry === 'node_modules' || entry === '.git') continue;
        const childPath = dirPath === '/' ? '/' + entry : dirPath + '/' + entry;
        const displayPath = basePath ? basePath + '/' + entry : entry;
        try {
          const stat = await ctx.fs.stat(childPath);
          if (stat.isDirectory()) {
            await searchDir(childPath, displayPath);
          } else if (stat.isFile()) { // (not a FIFO: reading one would wait)
            await searchFile(childPath, displayPath);
          }
        } catch { /* skip */ }
      }
    };

    if (fromStdin) {
      const text = ctx.liveStdin && ctx.shell?.kernelStdio ? await ctx.shell.kernelStdio.readAll()
        : ctx.readStdin ? await ctx.readStdin() : ctx.stdin;
      await searchFile('-', '<stdin>', text.replace(/\n$/, ''));
      summary();
      return found ? 0 : 1;
    }

    for (const p of searchPaths) {
      const resolved = ctx.fs.resolvePath(p, ctx.cwd);
      try {
        const stat = await ctx.fs.stat(resolved);
        if (stat.isDirectory()) {
          await searchDir(resolved, paths.length > 0 ? p : '');
        } else {
          const display = paths.length > 0 ? p : resolved;
          await searchFile(resolved, display);
        }
      } catch {
        ctx.stderr += `rg: ${p}: No such file or directory\n`;
      }
    }

    summary();
    return found ? 0 : 1;

    function summary() {
      if (!json) return;
      jsonLine({
        data: {
          bytes_printed: ctx.stdout.length, bytes_searched: totals.bytesSearched, elapsed_total: elapsed(),
          matched_lines: totals.matchedLines, matches: totals.matches, searches: totals.searches, searches_with_match: totals.searchesWithMatch,
        },
        type: 'summary',
      });
    }
  },
};
