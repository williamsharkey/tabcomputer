/**
 * Which Python runs `python3 ARGS`: the built-in one (CPython for WASI:
 * fast to start, no compiled packages) or Pyodide (numpy, pandas,
 * matplotlib). A program goes to Pyodide when it imports a module that
 * `pip` recorded as needing it (pyodide-dist.ts): the scan covers the
 * script, `-c` code or `-m` module and the local modules it imports.
 * `--pyodide` / `--wasi` as the first argument, or TABCOMPUTER_PYTHON=pyodide
 * / wasi in the environment, decide it outright. With nothing recorded this
 * costs one failed file read.
 *
 * Debian's Python, where `toolchain install python` installed it, is chosen
 * before this (choose.ts): `--debian` is its flag.
 */
import type { FileSystem } from '../filesystem';
import type { PyRun } from '../pyodide-worker/runtime';
import { scanImports } from './imports';
import { readPyodideIndex } from './pyodide-dist';

const SYSTEM_SITE = '/usr/lib/pkg/python3/lib/python3.13/site-packages';
const venvSite = (venv: string) => `${venv}/lib/python3.13/site-packages`;

export interface PyInvocation {
  /** 'stdin': the program is read from fd 0 (`-`, or no arguments and no terminal); 'info': -V, -h */
  kind: 'file' | 'module' | 'code' | 'repl' | 'stdin' | 'info';
  target: string;
  /** sys.argv */
  argv: string[];
  force?: 'wasi' | 'pyodide' | 'debian';
  /** The arguments without --wasi / --pyodide / --debian: what the interpreter is given */
  args: string[];
}

/** Options of CPython that take a value */
const VALUE_FLAGS = new Set(['W', 'X']);

export function parsePythonArgs(input: string[]): PyInvocation {
  let force: PyInvocation['force'];
  const args = input.filter((a, i) => {
    // (only before the program: after it they are the program's own arguments)
    if ((a === '--pyodide' || a === '--wasi' || a === '--debian') && input.slice(0, i).every((b) => b.startsWith('-') && b !== '-' && b !== '-c' && b !== '-m')) {
      force = a === '--pyodide' ? 'pyodide' : a === '--wasi' ? 'wasi' : 'debian';
      return false;
    }
    return true;
  });
  const done = (kind: PyInvocation['kind'], target: string, argv: string[]): PyInvocation => ({ kind, target, argv, force, args });
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-') return done('stdin', '', ['-', ...args.slice(i + 1)]);
    if (a === '--version' || a === '--help' || a === '--help-all' || a === '--help-env' || a === '--help-xoptions') return done('info', a, []);
    if (a === '--') { i++; if (i < args.length) return done('file', args[i], args.slice(i)); break; }
    if (a.startsWith('--')) { if (a === '--check-hash-based-pycs') i++; continue; }
    if (!a.startsWith('-')) return done('file', a, args.slice(i));
    // a cluster of short options: -uB, -Wignore, -c CODE, -mMOD
    for (let j = 1; j < a.length; j++) {
      const c = a[j];
      if (c === 'c' || c === 'm') {
        const rest = a.slice(j + 1);
        const value = rest || args[i + 1];
        const after = args.slice(rest ? i + 1 : i + 2);
        if (value === undefined) return done('info', a, []); // python3 reports the missing argument
        return c === 'c' ? done('code', value, ['-c', ...after]) : done('module', value, ['-m', ...after]);
      }
      if (c === 'V' || c === 'h' || c === '?') return done('info', a, []);
      if (VALUE_FLAGS.has(c)) { if (j === a.length - 1) i++; break; }
    }
  }
  return done('repl', '', ['']);
}

export type PythonRoute =
  | { engine: 'wasi'; args: string[] }
  | { engine: 'pyodide'; args: string[]; run: PyRun };

export interface RouteContext {
  cwd: string;
  env: Record<string, string | undefined>;
  /** The path python was started as (`.venv/bin/python`): its venv's packages are the ones that count */
  invokedPath?: string;
  /** Whether Pyodide can run as a kernel process here (pyodideWorkerMode) */
  canPyodide: boolean;
  /** No terminal on stdin: with no program named, it is read from stdin */
  stdinIsTTY?: boolean;
}

const MAX_FILES = 40;

async function read(fs: FileSystem, path: string): Promise<string | null> {
  try {
    const st = await fs.stat(path);
    if (st.type !== 'file' || st.size > 2_000_000) return null;
    return await fs.readFile(path, 'utf8') as string;
  } catch { return null; }
}

/** The site-packages a python started this way sees */
export async function pythonSites(fs: FileSystem, rc: RouteContext): Promise<string[]> {
  let venv = '';
  const m = rc.invokedPath ? /^(.*)\/bin\/[^/]+$/.exec(rc.invokedPath) : null;
  if (m && await fs.exists(`${m[1]}/pyvenv.cfg`)) venv = m[1];
  else if (rc.env.VIRTUAL_ENV && await fs.exists(`${rc.env.VIRTUAL_ENV}/pyvenv.cfg`)) venv = rc.env.VIRTUAL_ENV;
  if (!venv) return [SYSTEM_SITE];
  const cfg = await read(fs, `${venv}/pyvenv.cfg`) ?? '';
  return /^include-system-site-packages\s*=\s*true/m.test(cfg) ? [venvSite(venv), SYSTEM_SITE] : [venvSite(venv)];
}

/**
 * The modules `source` imports, following the ones that are files next to it
 * (`import helpers` → helpers.py or helpers/__init__.py under `dir`).
 */
export async function importsOf(fs: FileSystem, source: string, dir: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [source];
  let files = 0;
  while (queue.length) {
    for (const mod of scanImports(queue.shift()!)) {
      if (seen.has(mod)) continue;
      seen.add(mod);
      if (files >= MAX_FILES) continue;
      const local = await read(fs, `${dir}/${mod}.py`) ?? await read(fs, `${dir}/${mod}/__init__.py`);
      if (local !== null) { files++; queue.push(local); }
    }
  }
  return seen;
}

export async function routePython(fs: FileSystem, input: string[], rc: RouteContext): Promise<PythonRoute> {
  const inv = parsePythonArgs(input);
  const wasi: PythonRoute = { engine: 'wasi', args: inv.args };
  const envForce = rc.env.TABCOMPUTER_PYTHON;
  // ('debian' is choose.ts's: a program that reaches here runs on one of tabcomputer's two)
  const asked = inv.force === 'debian' ? undefined : inv.force;
  const force = asked ?? (envForce === 'pyodide' ? 'pyodide' : envForce === 'wasi' || envForce === 'cpython' ? 'wasi' : undefined);
  if (force === 'wasi' || inv.kind === 'info') return wasi;
  if (!rc.canPyodide && force !== 'pyodide') return wasi;

  const sites = await pythonSites(fs, rc);
  const modules: Record<string, string[]> = {};
  for (const site of sites) {
    const index = await readPyodideIndex(fs, site);
    for (const [mod, pkgs] of Object.entries(index?.modules ?? {})) modules[mod] ??= pkgs;
  }
  const kind = inv.kind === 'repl' && rc.stdinIsTTY === false ? 'stdin' : inv.kind;
  const run = (packages: string[]): PythonRoute => ({
    engine: 'pyodide', args: inv.args,
    run: { kind: kind as PyRun['kind'], target: inv.target, argv: kind === 'stdin' && inv.kind === 'repl' ? ['-'] : inv.argv, packages, sitePaths: sites },
  });
  if (!Object.keys(modules).length) return force === 'pyodide' ? run([]) : wasi;

  const abs = (p: string) => fs.resolvePath(p, rc.cwd);
  let source: string | null = null;
  let dir = rc.cwd;
  const first = new Set<string>();
  if (inv.kind === 'file') {
    const path = abs(inv.target);
    source = await read(fs, path);
    dir = path.slice(0, path.lastIndexOf('/')) || '/';
  } else if (inv.kind === 'code') {
    source = inv.target;
  } else if (inv.kind === 'module') {
    const rel = inv.target.replace(/\./g, '/');
    first.add(inv.target.split('.')[0]); // python3 -m numpy.f2py
    source = await read(fs, `${rc.cwd}/${rel}.py`) ?? await read(fs, `${rc.cwd}/${rel}/__main__.py`);
  }
  const imported = source !== null ? await importsOf(fs, source, dir) : new Set<string>();
  for (const m of first) imported.add(m);
  const packages = new Set<string>();
  for (const mod of imported) for (const p of modules[mod] ?? []) packages.add(p);
  if (!packages.size && force !== 'pyodide') return wasi;
  return run([...packages].sort());
}
