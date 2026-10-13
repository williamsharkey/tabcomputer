/**
 * Which Python `python3 ARGS` runs once Debian's is installed too
 * (`toolchain install python`): tabcomputer's own (the built-in CPython for
 * WASI, or Pyodide for numpy: route.ts) or Debian's, which runs in the
 * x86-64 emulator and starts and runs several times slower (#124).
 *
 * The built-in one, unless the program needs what only Debian's has:
 *
 * - it imports tkinter or turtle (or `-m` names them: turtledemo, idlelib);
 * - it imports a package that is installed in Debian's site-packages and
 *   nowhere the built-in Python looks (apt's python3-*, or what Debian's pip
 *   installed because nothing else could: a compiled package Pyodide lacks);
 * - it imports a package Pyodide provides together with sockets, subprocess
 *   or threads, which Pyodide has none of, and Debian's Python has the package.
 *
 * The imports are read from the program without running it (imports.ts: the
 * file, `-c` code or `-m` module, and the modules beside it), so a miss is
 * possible. It costs an ImportError that says what to type
 * (src/python-hints.ts), never a wrong result.
 *
 * `--debian`, `--wasi` and `--pyodide` before the program, or
 * TABCOMPUTER_PYTHON=debian|wasi|pyodide, decide it outright. The REPL,
 * `python3 -` and `-V` are the built-in one. `python3.13` and
 * `/usr/bin/python3` are Debian's by name: only the bare `python3` and
 * `python` typed at a shell (or run by one) are chosen for. Debian's own
 * scripts start with `#!/usr/bin/python3` and never come through here.
 */
import type { FileSystem } from '../filesystem';
import { importsOf, parsePythonArgs, pythonSites, type RouteContext } from './route';
import { readPyodideIndex } from './pyodide-dist';

/** Where Debian's `python3` link lives: its target is the interpreter (python3.13) */
export const DEBIAN_PYTHON_LINK = '/usr/bin/python3';
const PKG_PREFIX = '/usr/lib/pkg/';

/** Modules of the standard library that need Tk, which the built-in Python and Pyodide don't have */
export const TK_MODULES = new Set(['tkinter', '_tkinter', 'turtle', 'turtledemo', 'idlelib']);

/**
 * Modules whose use means sockets, processes or threads: none of which
 * Pyodide has. Kept short on purpose (`threading` and `urllib` are imported
 * by programs that never start a thread or open a URL).
 */
export const NOT_IN_PYODIDE = new Set(['socket', 'socketserver', 'subprocess', 'multiprocessing', 'ssl', 'ftplib', 'smtplib', 'imaplib', 'poplib', 'telnetlib', 'xmlrpc', 'requests', 'urllib3', 'httpx', 'aiohttp', 'websockets', 'flask', 'django', 'fastapi', 'uvicorn', 'paramiko']);

/**
 * Debian's interpreter when it is installed: the file `/usr/bin/python3`
 * leads to, when that is not tabcomputer's own package (`pkg install
 * python3` links the same name until Debian's replaces it).
 */
export async function debianPython(fs: FileSystem): Promise<string | null> {
  try {
    const real = await fs.realpath(DEBIAN_PYTHON_LINK);
    if (real.startsWith(PKG_PREFIX)) return null;
    const st = await fs.stat(real);
    // (not a builtin's shim, which is a few lines of text)
    return st.type === 'file' && st.size > 4096 ? real : null;
  } catch { return null; }
}

/** The directories Debian's Python takes third-party packages from */
export function debianSites(version: string, home: string): string[] {
  return ['/usr/lib/python3/dist-packages', `/usr/local/lib/python${version}/dist-packages`, `${home}/.local/lib/python${version}/site-packages`];
}

/** `python3.13` → `3.13` */
const versionOf = (interpreter: string) => /python(\d+\.\d+)$/.exec(interpreter)?.[1] ?? '3.13';

async function names(fs: FileSystem, dir: string): Promise<string[]> {
  try { return await fs.readdir(dir); } catch { return []; }
}

/** Is module `mod` among `entries` of a site directory? (a package, a module file, a compiled module) */
function hasModule(entries: string[], mod: string): boolean {
  for (const e of entries) {
    if (e === mod || e === `${mod}.py`) return true;
    if (e.startsWith(`${mod}.`) && e.endsWith('.so')) return true;
  }
  return false;
}

/** Does Debian's Python have a distribution of every one of `dists` installed? (`pip show`, without running it) */
export async function debianHasDists(fs: FileSystem, dists: string[], env: Record<string, string | undefined>): Promise<boolean> {
  const deb = await debianPython(fs);
  if (!deb || !dists.length) return false;
  const norm = (s: string) => s.toLowerCase().replace(/[-_.]+/g, '-');
  const have = new Set<string>();
  for (const d of debianSites(versionOf(deb), env.HOME || '/home/user')) {
    for (const e of await names(fs, d)) {
      const m = /^(.+?)-[^-]+(?:-py[\d.]+)?\.(?:dist-info|egg-info)$/.exec(e);
      if (m) have.add(norm(m[1]));
    }
  }
  return dists.every((d) => have.has(norm(d.replace(/[\s\[<>=!~;].*$/, ''))));
}

export type PythonChoice =
  /** tabcomputer's: `args` go to route.ts, which picks the built-in one or Pyodide */
  | { engine: 'builtin'; args: string[] }
  /** Debian's interpreter at `path`; `why` says what needs it (for --verbose and the tests) */
  | { engine: 'debian'; path: string; args: string[]; why: string }
  /** `--debian` was asked for and Debian's Python is not installed */
  | { engine: 'missing'; args: string[] };

export const DEBIAN_MISSING = "Debian's Python is not installed. Run: toolchain install python";

export async function choosePython(fs: FileSystem, input: string[], rc: Pick<RouteContext, 'cwd' | 'env' | 'invokedPath'>): Promise<PythonChoice> {
  const inv = parsePythonArgs(input);
  const builtin: PythonChoice = { engine: 'builtin', args: input };
  const envForce = rc.env.TABCOMPUTER_PYTHON;
  const force = inv.force ?? (envForce === 'debian' ? 'debian' : envForce === 'pyodide' ? 'pyodide' : envForce === 'wasi' || envForce === 'cpython' ? 'wasi' : undefined);
  if (force === 'wasi' || force === 'pyodide') return builtin;
  const deb = await debianPython(fs);
  if (force === 'debian') return deb ? { engine: 'debian', path: deb, args: inv.args, why: 'asked for' } : { engine: 'missing', args: inv.args };
  if (!deb || inv.kind === 'info' || inv.kind === 'repl' || inv.kind === 'stdin') return builtin;

  const abs = (p: string) => fs.resolvePath(p, rc.cwd);
  const read = async (path: string): Promise<string | null> => {
    try {
      const st = await fs.stat(path);
      if (st.type !== 'file' || st.size > 2_000_000) return null;
      return await fs.readFile(path, 'utf8') as string;
    } catch { return null; }
  };
  let source: string | null = null;
  let dir = rc.cwd;
  const imported = new Set<string>();
  if (inv.kind === 'file') {
    const path = abs(inv.target);
    source = await read(path);
    dir = path.slice(0, path.lastIndexOf('/')) || '/';
  } else if (inv.kind === 'code') {
    source = inv.target;
  } else if (inv.kind === 'module') {
    const rel = inv.target.replace(/\./g, '/');
    imported.add(inv.target.split('.')[0]);
    source = await read(`${rc.cwd}/${rel}.py`) ?? await read(`${rc.cwd}/${rel}/__main__.py`);
  }
  if (source !== null) for (const m of await importsOf(fs, source, dir)) imported.add(m);
  if (!imported.size) return builtin;
  const debian = (why: string): PythonChoice => ({ engine: 'debian', path: deb, args: inv.args, why });

  for (const m of imported) if (TK_MODULES.has(m)) return debian(`it imports ${m}`);

  // What the built-in Python can import: its site-packages (a venv's when one is active), and what pip recorded as Pyodide's
  const sites = await pythonSites(fs, { ...rc, canPyodide: true });
  const own: string[] = [];
  const pyodide: Record<string, string[]> = {};
  for (const site of sites) {
    own.push(...await names(fs, site));
    for (const [mod, pkgs] of Object.entries((await readPyodideIndex(fs, site))?.modules ?? {})) pyodide[mod] ??= pkgs;
  }
  const theirs: string[] = [];
  for (const d of debianSites(versionOf(deb), rc.env.HOME || '/home/user')) theirs.push(...await names(fs, d));
  // (a module beside the program is the program's own, whatever Debian has of that name)
  const local = async (m: string) => (await fs.exists(`${dir}/${m}.py`)) || (await fs.exists(`${dir}/${m}/__init__.py`));

  const needsPyodide: string[] = [];
  for (const m of imported) {
    if (pyodide[m]) { needsPyodide.push(m); continue; }
    if (hasModule(own, m) || !hasModule(theirs, m) || await local(m)) continue;
    return debian(`${m} is installed for Debian's Python only`);
  }
  if (needsPyodide.length) {
    const blocked = [...imported].find((m) => NOT_IN_PYODIDE.has(m));
    if (blocked && needsPyodide.every((m) => hasModule(theirs, m))) return debian(`it imports ${needsPyodide[0]} and ${blocked}`);
  }
  return builtin;
}

// ── for the shell ──

/** tabcomputer's own interpreter (the python3 package's file) */
export const BUILTIN_PYTHON = '/usr/lib/pkg/python3/bin/python3.wasm';

/**
 * What the shell runs for a bare `python3` / `python` that PATH resolved to
 * `found` (absolute), where Debian's Python is installed or `--debian` was
 * given: null when there is nothing to choose (a venv's python, which is
 * that venv's; or no Debian Python and no flag: as before).
 */
export async function shellPython(fs: FileSystem, args: string[], found: string, rc: Pick<RouteContext, 'cwd' | 'env'>): Promise<PythonChoice | null> {
  // (`.venv/bin/python3` first on PATH: the person chose that one by activating it)
  const m = /^(.*)\/bin\/[^/]+$/.exec(found);
  if (m && await fs.exists(`${m[1]}/pyvenv.cfg`)) return null;
  const pick = await choosePython(fs, args, rc);
  if (pick.engine === 'builtin' && !(await debianPython(fs))) return null;
  return pick;
}

/**
 * Console scripts the built-in pip wrote before Debian's Python was
 * installed (`#!/usr/bin/python3`: then the built-in one, now Debian's, which
 * has none of their packages): name the built-in interpreter by its file.
 * Run once, when `toolchain install python` first installs Debian's.
 */
export async function keepConsoleScripts(fs: FileSystem, dir = '/usr/local/bin'): Promise<string[]> {
  const changed: string[] = [];
  for (const name of await names(fs, dir)) {
    const path = `${dir}/${name}`;
    try {
      const st = await fs.lstat(path);
      if (st.type !== 'file' || st.size > 4096) continue;
      const text = await fs.readFile(path, 'utf8') as string;
      if (!text.startsWith('#!/usr/bin/python3\n# -*- coding: utf-8 -*-\nimport re\nimport sys\n')) continue;
      await fs.writeFile(path, `#!${BUILTIN_PYTHON}` + text.slice(text.indexOf('\n')), { mode: 0o755 });
      changed.push(path);
    } catch { /* not a script of ours */ }
  }
  return changed;
}
