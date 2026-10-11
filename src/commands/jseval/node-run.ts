import type { CommandContext } from '../index';
import { executeNodeScript } from '../../node-compat/execution';
import { NODE_REPL } from './node-repl';
import { CLAUDE_CODE_CLI_JS } from '../../claude-code-version';
import { readClaudeTransform, saveClaudeTransform } from '../../claude-transform-cache';
import { parseNodeArgs, parseEnvFile } from './node-args';

/**
 * node (node-cmd.ts runs it here, or in a Worker as a kernel guest): executes JS files from the virtual filesystem.
 *
 * Usage:
 *   node script.js
 *   node -e 'console.log("hello")'
 *   node -p '1 + 2'    (print result)
 *
 * Provides a minimal Node-like environment:
 *   - console.log/warn/error write to stdout/stderr
 *   - process.env, process.cwd(), process.exit()
 *   - require() for CommonJS modules and npm packages
 */
/** `node ARGS` in this JS realm (the page, or a node-worker guest): arguments, the script, then node-compat */
export async function runNode(ctx: CommandContext): Promise<number> {
  const node = parseNodeArgs(ctx.args, ctx.env?.NODE_OPTIONS);
  if (node.error) {
    ctx.stderr += node.error + '\n';
    return 9;
  }
  for (const w of node.warnings) ctx.stderr += w + '\n';
  if (node.version) {
    // The version the runtime reports (process.version), as node prints it
    ctx.stdout += 'v22.12.0\n';
    return 0;
  }
  if (node.help) {
    ctx.stdout += NODE_HELP;
    return 0;
  }
  // --env-file: its variables, under the environment's own (as node)
  for (const f of node.envFiles) {
    let text: string;
    try { text = await ctx.fs.readFile(ctx.fs.resolvePath(f.path, ctx.cwd), 'utf8') as string; } catch {
      if (f.optional) continue;
      ctx.stderr += `node: ${f.path}: not found\n`;
      return 9;
    }
    ctx.env = { ...parseEnvFile(text), ...ctx.env };
  }

  // --test: the test files, each run as a child node (node:test's runner reports them together)
  if (node.test) {
    const patterns = node.script !== undefined ? [node.script, ...node.scriptArgs] : [];
    const files = await findTestFiles(ctx, patterns);
    const opts = { reporter: node.testReporter, namePattern: node.testNamePattern };
    const src = `require('node:test')[Symbol.for('tabcomputer.runTestFiles')](${JSON.stringify(files)}, { ...${JSON.stringify(opts)}, execPath: process.execPath });`;
    return executeNodeScript(ctx, src, '', [], false, { node });
  }

  let code = node.eval ?? '';
  const printResult = node.print;
  const run = (src: string, path: string, args: string[], more: Parameters<typeof executeNodeScript>[5] = {}) =>
    executeNodeScript(ctx, src, path, args, printResult, { node, ...more });
  // process.argv after 'node': the script and its arguments (with -e/-p, the arguments)
  const fileArgs = node.script !== undefined ? [node.script, ...node.scriptArgs] : node.scriptArgs;
  if (node.script === '-') {
    code = ctx.stdin;
    if (node.check) return checkSyntax(ctx, code, '[stdin]');
    return run(code, '', fileArgs);
  }

  // A script: read from the filesystem
  let scriptPath = '';
  if (node.eval === undefined && node.script !== undefined) {
    scriptPath = ctx.fs.resolvePath(fileArgs[0], ctx.cwd);
    // Claude Code's npm build: its transformed text, when the page has written it
    if (scriptPath === CLAUDE_CODE_CLI_JS) {
      const cache = await readClaudeTransform(ctx.fs as any);
      if (cache.text && !node.check) return run(cache.text, scriptPath, fileArgs, { pretransformed: true });
      // none: this run transforms it, and saves the text once its program has ended
      if (cache.path && !node.check) {
        let text: string | undefined;
        const code = await run(await ctx.fs.readFile(scriptPath, 'utf8') as string, scriptPath, fileArgs, { onTransformed: (t) => { text = t; } });
        if (text) await saveClaudeTransform(ctx.fs as any, cache.path, text).catch(() => {});
        return code;
      }
    }
    // If no extension given, probe .js, .ts, .tsx, .jsx
    let found = false;
    try {
      code = await ctx.fs.readFile(scriptPath, 'utf8') as string;
      found = true;
    } catch {
      if (!/\.\w+$/.test(scriptPath)) {
        for (const ext of ['.js', '.ts', '.tsx', '.jsx']) {
          try {
            code = await ctx.fs.readFile(scriptPath + ext, 'utf8') as string;
            scriptPath = scriptPath + ext;
            found = true;
            break;
          } catch { /* try next */ }
        }
      }
    }
    if (!found) {
      ctx.stderr += `node: Cannot find module '${fileArgs[0]}'\n`;
      return 1;
    }
  }

  if (node.check) return scriptPath ? checkSyntax(ctx, code, scriptPath) : 0;

  // Neither: the REPL on a terminal (or with -i), else the program is stdin
  const noProgram = node.eval === undefined && node.script === undefined;
  if (noProgram && (node.interactive || (!ctx.stdin && ctx.terminal && (ctx.stdinIsTTY ?? true)))) {
    return executeNodeScript(ctx, NODE_REPL, '', [], false, { node });
  }
  if (noProgram && ctx.stdin) {
    code = ctx.stdin;
  }

  if (!code && node.eval === undefined) {
    ctx.stderr += 'node: no input provided\n';
    return 1;
  }

  return run(code, scriptPath, fileArgs);
}

/** node --check: the script parses (as node-compat transforms it), nothing runs */
async function checkSyntax(ctx: CommandContext, code: string, name: string): Promise<number> {
  const { transformESModules, transformTS } = await import('./module-transform');
  let src = code.replace(/^#!.*/, '');
  if (/\.tsx?$/.test(name)) src = transformTS(src);
  try {
    new (Object.getPrototypeOf(async function () { /* */ }).constructor)(transformESModules(src));
    return 0;
  } catch (e: any) {
    ctx.stderr += `${name}\n${e?.name ?? 'SyntaxError'}: ${e?.message ?? e}\n`;
    return 1;
  }
}

const NODE_HELP = `Usage: node [options] [ script.js ] [arguments]
       node [options] -e <code> [arguments]

Options:
  -e, --eval <code>           evaluate the code
  -p, --print <code>          evaluate the code and print the result
  -c, --check                 check the script's syntax without running it
  -i, --interactive           the REPL, even if stdin isn't a terminal
  -r, --require <module>      require the module before the script
  --import <module>           import the module before the script
  --env-file <file>           set environment variables from the file
  --no-warnings               don't print process warnings
  --no-deprecation            don't print deprecation warnings
  -v, --version               print node's version
  -h, --help                  print this help
  -                           the script is stdin
  --                          the end of node's options

NODE_OPTIONS: options read before the command line's.
Options that change nothing in a browser tab (--max-old-space-size,
--enable-source-maps, --experimental-*, ...) are taken quietly; --inspect,
--watch, --test and options this node doesn't know are taken with a warning.
This node runs in the browser's JavaScript engine (node-compat), not V8 under libuv.
`;

/** node's default test files, when --test is given no paths */
const TEST_DEFAULTS = ['**/*.test.{cjs,mjs,js}', '**/*-test.{cjs,mjs,js}', '**/*_test.{cjs,mjs,js}', '**/test-*.{cjs,mjs,js}', '**/test.{cjs,mjs,js}', '**/test/**/*.{cjs,mjs,js}'];

/** A glob as a regular expression: **, *, ? and {a,b} */
function globRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { i++; if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') { const end = glob.indexOf('}', i); re += `(?:${glob.slice(i + 1, end).split(',').map((x) => x.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`; i = end; }
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** --test's files, relative to the cwd and sorted: paths as given, globs and directories walked (node_modules left out) */
async function findTestFiles(ctx: CommandContext, patterns: string[]): Promise<string[]> {
  const all: string[] = [];
  const walk = async (dir: string, rel: string) => {
    let names: string[];
    try { names = await ctx.fs.readdir(dir); } catch { return; }
    for (const n of names) {
      if (n === 'node_modules' || n === '.git') continue;
      const p = dir === '/' ? `/${n}` : `${dir}/${n}`;
      const r = rel ? `${rel}/${n}` : n;
      let st: any;
      try { st = await ctx.fs.stat(p); } catch { continue; }
      if (st.isDirectory?.() ?? st.type === 'directory') await walk(p, r); else all.push(r);
    }
  };
  const out = new Set<string>();
  const globs: RegExp[] = [];
  for (const pat of patterns.length ? patterns : TEST_DEFAULTS) {
    if (/[*?{]/.test(pat)) { globs.push(globRegex(pat.replace(/^\.\//, ''))); continue; }
    const abs = ctx.fs.resolvePath(pat, ctx.cwd);
    let st: any;
    try { st = await ctx.fs.stat(abs); } catch { out.add(pat); continue; } // (missing: its child says so)
    if (st.isDirectory?.() ?? st.type === 'directory') {
      const base = pat.replace(/\/+$/, '');
      for (const d of TEST_DEFAULTS) globs.push(globRegex(`${base}/${d}`));
    } else out.add(pat);
  }
  if (globs.length) {
    await walk(ctx.cwd, '');
    for (const f of all) if (globs.some((g) => g.test(f))) out.add(f);
  }
  return [...out].sort();
}
