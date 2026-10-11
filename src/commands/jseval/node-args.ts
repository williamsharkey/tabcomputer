/**
 * node's command line: its options (and NODE_OPTIONS's), then the script and
 * the script's arguments. node-run.ts runs what this gives; shell-stdio.ts and
 * the node-worker guest ask it whether the program comes from stdin.
 *
 * An option node has that does nothing here (memory limits, source maps,
 * experimental features) is taken quietly; one whose work isn't done here
 * (--inspect, --watch) or that isn't known is taken with a warning,
 * never as the script's name.
 */

export interface NodeArgs {
  /** The command line's options before the script, as process.execArgv (NODE_OPTIONS's are not in it, as node) */
  execArgv: string[];
  /** -e / -p: the code */
  eval?: string;
  print: boolean;
  /** -c / --check: the script's syntax only */
  check: boolean;
  /** -i: the REPL, even with stdin not a terminal */
  interactive: boolean;
  version: boolean;
  help: boolean;
  /** The script ('-': stdin), and what follows it */
  script?: string;
  scriptArgs: string[];
  /** -r / --require and --import: loaded before the script, in order */
  preload: { kind: 'require' | 'import'; spec: string }[];
  envFiles: { path: string; optional: boolean }[];
  noWarnings: boolean;
  noDeprecation: boolean;
  /** --disable-warning: codes or types not printed */
  disableWarnings: string[];
  /** --test: run test files (the script and what follows are their paths or globs; none: node's defaults) */
  test: boolean;
  /** --test-reporter (spec, tap) and --test-name-pattern */
  testReporter?: string;
  testNamePattern?: string;
  /** One line each for stderr: options taken but not acted on */
  warnings: string[];
  /** node's own usage error (exit 9) */
  error?: string;
}

/** Options that take a value, as `--opt value` or `--opt=value` */
const VALUE = new Set([
  '-r', '--require', '--import', '-C', '--conditions', '--env-file', '--env-file-if-exists', '--disable-warning',
  '--input-type', '--title', '--unhandled-rejections', '--stack-trace-limit', '--stack-size', '--max-old-space-size',
  '--max-semi-space-size', '--dns-result-order', '--icu-data-dir', '--openssl-config', '--tls-cipher-list',
  '--tls-keylog', '--tls-min-v1.0', '--redirect-warnings', '--diagnostic-dir', '--report-dir', '--report-directory',
  '--report-filename', '--report-signal', '--heapsnapshot-signal', '--heapsnapshot-near-heap-limit',
  '--secure-heap', '--secure-heap-min', '--experimental-default-type', '--experimental-loader', '--loader',
  '--inspect-port', '--debug-port', '--watch-path', '--test-reporter', '--test-reporter-destination',
  '--test-name-pattern', '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--cpu-prof-dir',
  '--cpu-prof-name', '--cpu-prof-interval', '--heap-prof-dir', '--heap-prof-name', '--heap-prof-interval',
  '--snapshot-blob', '--run', '--max-http-header-size', '--v8-pool-size', '--localstorage-file',
  '--experimental-config-file', '--allow-fs-read', '--allow-fs-write', '--network-family-autoselection-attempt-timeout',
]);

/** Options that change nothing here (the engine is the browser's) */
const QUIET = new Set([
  '--enable-source-maps', '--max-old-space-size', '--max-semi-space-size', '--stack-size', '--stack-trace-limit',
  '-C', '--conditions', '--input-type', '--title', '--unhandled-rejections', '--trace-warnings', '--trace-deprecation',
  '--trace-uncaught', '--trace-exit', '--trace-sigint', '--trace-sync-io', '--trace-tls', '--throw-deprecation',
  '--pending-deprecation', '--preserve-symlinks', '--preserve-symlinks-main', '--openssl-legacy-provider',
  '--openssl-shared-config', '--use-openssl-ca', '--use-bundled-ca', '--dns-result-order', '--abort-on-uncaught-exception',
  '--frozen-intrinsics', '--zero-fill-buffers', '--no-addons', '--addons', '--no-global-search-paths',
  '--force-context-aware', '--insecure-http-parser', '--max-http-header-size', '--jitless', '--v8-pool-size',
  '--expose-gc', '--icu-data-dir', '--openssl-config', '--tls-cipher-list', '--tls-keylog', '--redirect-warnings',
  '--diagnostic-dir', '--force-fips', '--enable-fips', '--no-force-async-hooks-checks', '--force-node-api-uncaught-exceptions-policy',
  '--network-family-autoselection', '--network-family-autoselection-attempt-timeout', '--experimental-default-type',
  '--deprecation', '--warnings', '--async-context-frame', '--localstorage-file', '--permission', '--allow-fs-read',
  '--allow-fs-write', '--allow-child-process', '--allow-worker', '--allow-addons', '--allow-wasi', '--disable-proto',
  '--disable-wasm-trap-handler', '--interpreted-frames-native-stack', '--perf-basic-prof', '--perf-basic-prof-only-functions',
  '--perf-prof', '--perf-prof-unwinding-info', '--node-memory-debug', '--security-revert', '--heapsnapshot-signal',
  '--heapsnapshot-near-heap-limit', '--secure-heap', '--secure-heap-min', '--report-on-signal', '--report-uncaught-exception',
  '--report-on-fatalerror', '--report-compact', '--report-dir', '--report-directory', '--report-filename', '--report-signal',
  '--report-exclude-network', '--report-exclude-env', '--experimental-config-file',
]);
/** Families of options that change nothing here */
const QUIET_PREFIX = ['--experimental-', '--no-experimental-', '--harmony', '--trace-', '--max-', '--report-', '--tls-', '--use-'];

/** Options whose work isn't done here: taken, with a warning */
const UNSUPPORTED = new Set([
  '--inspect', '--inspect-brk', '--inspect-wait', '--inspect-port', '--inspect-publish-uid', '--debug', '--debug-brk', '--debug-port',
  '--watch', '--watch-path', '--watch-preserve-output', '--test-reporter-destination',
  '--test-skip-pattern', '--test-concurrency', '--test-timeout', '--test-coverage', '--experimental-test-coverage',
  '--prof', '--prof-process', '--cpu-prof', '--cpu-prof-dir', '--cpu-prof-name', '--cpu-prof-interval', '--heap-prof',
  '--heap-prof-dir', '--heap-prof-name', '--heap-prof-interval', '--loader', '--experimental-loader', '--snapshot-blob',
  '--build-snapshot', '--run', '--experimental-sea-config', '--completion-bash', '--v8-options', '--policy-integrity',
  '--experimental-policy',
]);

/** NODE_OPTIONS's words: shell-like (quotes, backslashes) */
export function splitNodeOptions(s: string): string[] {
  const out: string[] = [];
  let cur = '', q: string | null = null, has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === q) q = null;
      else if (c === '\\' && q === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") { q = c; has = true; }
    else if (c === '\\' && i + 1 < s.length) { cur += s[++i]; has = true; }
    else if (/\s/.test(c)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else { cur += c; has = true; }
  }
  if (cur || has) out.push(cur);
  return out;
}

/** `args`: node's arguments; `nodeOptions`: $NODE_OPTIONS (its options apply first, and stay out of execArgv) */
export function parseNodeArgs(args: string[], nodeOptions?: string): NodeArgs {
  const r: NodeArgs = {
    execArgv: [], print: false, check: false, interactive: false, version: false, help: false, test: false, scriptArgs: [],
    preload: [], envFiles: [], noWarnings: false, noDeprecation: false, disableWarnings: [], warnings: [],
  };
  const warned = new Set<string>();
  const warn = (name: string) => {
    if (warned.has(name)) return;
    warned.add(name);
    r.warnings.push(`node: warning: ${name} is not supported here; ignored`);
  };

  /** One option at words[i] (and its value); returns how many words it took, or -1 at the end of options */
  const option = (words: string[], i: number, fromEnv: boolean): number => {
    const a = words[i];
    const eq = a.startsWith('--') ? a.indexOf('=') : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    let value: string | undefined = eq > 0 ? a.slice(eq + 1) : undefined;
    let used = 1;
    if (value === undefined && VALUE.has(name)) {
      if (i + 1 >= words.length) { r.error = `node: ${name} requires an argument`; return used; }
      value = words[i + 1];
      used = 2;
    }
    if (!fromEnv) r.execArgv.push(...words.slice(i, i + used));
    // (`--no-x` is x turned off)
    const base = name.startsWith('--no-') ? '--' + name.slice(5) : name;
    switch (name) {
      case '-v': case '--version': r.version = true; return used;
      case '-h': case '--help': r.help = true; return used;
      case '-i': case '--interactive': r.interactive = true; return used;
      case '-c': case '--check': r.check = true; return used;
      case '-r': case '--require': r.preload.push({ kind: 'require', spec: value! }); return used;
      case '--import': r.preload.push({ kind: 'import', spec: value! }); return used;
      case '--env-file': case '--env-file-if-exists': r.envFiles.push({ path: value!, optional: name.endsWith('-if-exists') }); return used;
      case '--no-warnings': r.noWarnings = true; return used;
      case '--no-deprecation': r.noDeprecation = true; return used;
      case '--disable-warning': r.disableWarnings.push(value!); return used;
      case '--test': r.test = true; return used;
      case '--test-reporter': r.testReporter = value; return used;
      case '--test-name-pattern': r.testNamePattern = value; return used;
      case '--test-only': return used;
    }
    if (UNSUPPORTED.has(name) || UNSUPPORTED.has(base) || /^--(inspect|debug)(-|$)/.test(name)) { warn(name); return used; }
    if (QUIET.has(name) || QUIET.has(base) || QUIET_PREFIX.some((p) => name.startsWith(p))) return used;
    warn(name);
    return used;
  };

  if (nodeOptions) {
    const words = splitNodeOptions(nodeOptions);
    for (let i = 0; i < words.length;) {
      const a = words[i];
      if (!a.startsWith('-') || /^(-e|--eval|-p|--print|-pe|-ep)$/.test(a)) {
        r.error = `node: ${a} is not allowed in NODE_OPTIONS`;
        return r;
      }
      i += option(words, i, true);
    }
  }

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // the first word that isn't an option: the script, or with -e/-p the program's first argument
    if (a === '-' || !a.startsWith('-')) {
      if (r.eval !== undefined) r.scriptArgs = args.slice(i);
      else { r.script = a; r.scriptArgs = args.slice(i + 1); }
      break;
    }
    if (a === '--') {
      if (r.eval !== undefined) r.scriptArgs = args.slice(i + 1);
      else if (i + 1 < args.length) { r.script = args[i + 1]; r.scriptArgs = args.slice(i + 2); }
      break;
    }
    // -e/-p and their combinations (-pe), the code next
    const ev = /^(?:-e|--eval|-p|--print|-pe|-ep)$/.exec(a) ? a : null;
    if (ev) {
      r.execArgv.push(a);
      if (ev.includes('p')) r.print = true;
      if (i + 1 >= args.length) { r.error = `node: ${a} requires an argument`; break; }
      r.eval = args[++i];
      r.execArgv.push(r.eval);
      continue;
    }
    if (a.startsWith('--eval=') || a.startsWith('--print=')) {
      r.execArgv.push(a);
      r.print = a.startsWith('--print=');
      r.eval = a.slice(a.indexOf('=') + 1);
      continue;
    }
    i += option(args, i, false) - 1;
    if (r.error) break;
  }
  return r;
}

/** Whether node reads its program from stdin for these arguments (no script, no -e/-p, not -v/-h) */
export function programFromStdin(args: string[]): boolean {
  const a = parseNodeArgs(args);
  return !a.error && !a.version && !a.help && a.eval === undefined && (a.script === undefined || a.script === '-');
}

/** A dotenv file (`--env-file`): KEY=value lines, `export`, quotes, comments */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|`([^`]*)`|([^\n#]*?))\s*(?:#.*)?$/gm;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [, key, sq, dq, bq, plain] = m;
    out[key] = sq ?? bq ?? (dq !== undefined ? dq.replace(/\\n/g, '\n').replace(/\\(.)/g, '$1') : plain ?? '');
  }
  return out;
}
