import type { CommandContext } from '../index';
import { executeNodeScript } from '../../node-compat/execution';
import { NODE_REPL } from './node-repl';
import { CLAUDE_CODE_CLI_JS } from '../../claude-code-version';
import { readClaudeTransform, saveClaudeTransform } from '../../claude-transform-cache';

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
/** Options runNode handles itself */
const NODE_OWN_FLAGS = new Set(['-e', '--eval', '-p', '--print', '-v', '--version', '-h', '--help']);
/** node options whose value can be the next word (`--conditions node`, `-r dotenv/config`) */
const NODE_VALUE_OPTIONS = new Set([
  '-C', '--conditions', '-r', '--require', '--import', '--loader', '--experimental-loader', '--title',
  '--input-type', '--env-file', '--env-file-if-exists', '--inspect-port', '--debug-port', '--redirect-warnings',
  '--diagnostic-dir', '--report-dir', '--report-directory', '--report-filename', '--heapsnapshot-signal',
  '--icu-data-dir', '--openssl-config', '--tls-cipher-list', '--disable-warning', '--watch-path',
  '--experimental-default-type', '--unhandled-rejections', '--test-reporter', '--test-reporter-destination',
  '--test-name-pattern', '--test-skip-pattern', '--secure-heap', '--secure-heap-min', '--stack-trace-limit',
]);
/** Options that load code before the script: not implemented, so said rather than silently dropped */
const NODE_PRELOAD_OPTIONS = new Set(['-r', '--require', '--import', '--loader', '--experimental-loader']);

/** `node ARGS` in this JS realm (the page, or a node-worker guest): arguments, the script, then node-compat */
export async function runNode(ctx: CommandContext): Promise<number> {
  let code = '';
  let printResult = false;

  // Parse args — once we see a script file, everything after is script args
  const fileArgs: string[] = [];
  /** node's own options before the script: process.execArgv */
  const execArgv: string[] = [];
  let foundScript = false;
  for (let i = 0; i < ctx.args.length; i++) {
    const a = ctx.args[i];
    if (foundScript) {
      fileArgs.push(ctx.args[i]);
    } else if (a === '--') {
      fileArgs.push(...ctx.args.slice(i + 1, i + 2));
      foundScript = true;
    } else if (a.startsWith('-') && a !== '-' && !NODE_OWN_FLAGS.has(a)) {
      // Any other option (vitest's fork passes `--conditions node`): it is
      // not the script. One that takes a value takes the next word too.
      execArgv.push(a);
      const name = a.split('=')[0];
      if (!a.includes('=') && NODE_VALUE_OPTIONS.has(name) && i + 1 < ctx.args.length) execArgv.push(ctx.args[++i]);
      if (NODE_PRELOAD_OPTIONS.has(name)) ctx.stderr += `node: ${name} is not supported here; ignored\n`;
    } else if (ctx.args[i] === '-e' || ctx.args[i] === '--eval') {
      code = ctx.args[++i] || '';
    } else if (ctx.args[i] === '-p' || ctx.args[i] === '--print') {
      code = ctx.args[++i] || '';
      printResult = true;
    } else if (ctx.args[i] === '--version' || ctx.args[i] === '-v') {
      // The version the runtime reports (process.version), as node prints it
      ctx.stdout += 'v22.12.0\n';
      return 0;
    } else if (ctx.args[i] === '--help' || ctx.args[i] === '-h') {
      ctx.stdout += 'Usage: node [options] [script.js] [arguments]\n';
      ctx.stdout += '  -e, --eval <code>   Evaluate code\n';
      ctx.stdout += '  -p, --print <code>  Evaluate and print result\n';
      ctx.stdout += '\nNote: Runs in browser JS VM, not real Node.js.\n';
      ctx.stdout += 'Full DOM/browser API access available.\n';
      return 0;
    } else {
      fileArgs.push(ctx.args[i]);
      foundScript = true;
    }
  }

  (ctx as any).nodeExecArgv = execArgv;

  // If no -e flag, read from file
  let scriptPath = '';
  if (!code && fileArgs.length > 0) {
    scriptPath = ctx.fs.resolvePath(fileArgs[0], ctx.cwd);
    // Claude Code's npm build: its transformed text, when the page has written it
    if (scriptPath === CLAUDE_CODE_CLI_JS) {
      const cache = await readClaudeTransform(ctx.fs as any);
      if (cache.text) return executeNodeScript(ctx, cache.text, scriptPath, fileArgs, printResult, { pretransformed: true });
      // none: this run transforms it, and saves the text once its program has ended
      if (cache.path) {
        let text: string | undefined;
        const code = await executeNodeScript(ctx, await ctx.fs.readFile(scriptPath, 'utf8') as string, scriptPath, fileArgs, printResult, { onTransformed: (t) => { text = t; } });
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

  // Neither: the REPL on a terminal, else the program is stdin
  if (!code && !fileArgs.length && !ctx.stdin && ctx.terminal && (ctx.stdinIsTTY ?? true)) {
    return executeNodeScript(ctx, NODE_REPL, '', [], false);
  }
  if (!code && ctx.stdin) {
    code = ctx.stdin;
  }

  if (!code) {
    ctx.stderr += 'node: no input provided\n';
    return 1;
  }

  return executeNodeScript(ctx, code, scriptPath, fileArgs, printResult);
}
