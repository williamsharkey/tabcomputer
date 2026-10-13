/**
 * The Pyodide distribution the tab uses for compiled Python packages, and
 * the record `pip` keeps of what comes from it.
 *
 * The built-in Python (CPython for WASI) can't load compiled extensions, so
 * `pip install numpy` doesn't download anything: it writes a dist-info for
 * the Pyodide build of numpy into site-packages (so `pip list`, `pip show`,
 * `pip uninstall` and "Requirement already satisfied" work) and rebuilds
 * `tabcomputer-pyodide.json` there: for every importable module that needs
 * Pyodide, the Pyodide packages to load. `python3` reads that one file to
 * decide where a program runs (route.ts).
 */
import type { FileSystem } from '../filesystem';
import { normalizeName, parseRequirement } from '../utils/pep440';

/** Pyodide 0.29 is CPython 3.13.2: the built-in Python's minor version, so pure-Python packages serve both */
export const PYODIDE_VERSION = '0.29.5';
export const PYODIDE_PYTHON = '3.13.2';
export const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

/**
 * Where Pyodide is fetched from: jsdelivr, or the URL in localStorage
 * `tabcomputer-pyodide-url` (a mirror of the distribution's `full/` directory).
 */
export function pyodideIndexURL(): string {
  let url = '';
  try { url = globalThis.localStorage?.getItem('tabcomputer-pyodide-url') ?? ''; } catch { /* no storage */ }
  return (url || PYODIDE_CDN).replace(/\/?$/, '/');
}

export interface LockPackage {
  name: string; version: string; file_name: string; imports: string[]; depends: string[];
  /** 'package' (a wheel), 'shared_library', 'cpython_module' */
  package_type?: string;
}
export interface PyodideLock { info: { python: string; version?: string }; packages: Record<string, LockPackage> }

const locks = new Map<string, Promise<PyodideLock>>();
/** (tests) */
export function clearLockCache(): void { locks.clear(); }

/** The distribution's package list (pyodide-lock.json), fetched once per page */
export function fetchLock(fetchFn: typeof fetch = (...a) => fetch(...a), base = pyodideIndexURL()): Promise<PyodideLock> {
  let p = locks.get(base);
  if (!p) {
    p = fetchFn(`${base}pyodide-lock.json`).then((r) => {
      if (!r.ok) throw new Error(`${base}pyodide-lock.json: HTTP ${r.status}`);
      return r.json() as Promise<PyodideLock>;
    });
    locks.set(base, p);
    p.catch(() => { locks.delete(base); });
  }
  return p;
}

const isWheel = (p: LockPackage) => (p.package_type ?? 'package') === 'package';
/** A wheel with compiled code: what the built-in Python can't load */
export const isCompiled = (p: LockPackage) => isWheel(p) && !/-none-any\.whl$/.test(p.file_name);

/** `name` in the lock, when it is a compiled package there (pure ones install from PyPI as before) */
export function pyodideProvides(lock: PyodideLock, name: string): LockPackage | null {
  const p = lock.packages[normalizeName(name)];
  return p && isCompiled(p) ? p : null;
}

/** `name` and the wheels it depends on in the lock, dependencies first */
export function lockClosure(lock: PyodideLock, name: string): LockPackage[] {
  const out: LockPackage[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    const key = normalizeName(n);
    if (seen.has(key)) return;
    seen.add(key);
    const p = lock.packages[key];
    if (!p) return;
    for (const d of p.depends) visit(d);
    if (isWheel(p)) out.push(p);
  };
  visit(name);
  return out;
}

// ── the record in site-packages ──────────────────────────────────────

export const PYODIDE_INSTALLER = 'tabcomputer-pyodide';
export const INDEX_FILE = 'tabcomputer-pyodide.json';
/**
 * The stand-in modules' directory, and the .pth file that puts it at the end
 * of the built-in Python's sys.path only. In Pyodide they must not be found
 * at all: a stand-in `mpl_toolkits/__init__.py` anywhere on the path would
 * win over matplotlib's real one, which is a namespace package.
 */
export const STUB_DIR = '_tabcomputer_pyodide_stubs';
export const STUB_PTH = 'tabcomputer-pyodide.pth';
const stubPth = (site: string) => `import sys; sys.platform == "emscripten" or sys.path.append(${JSON.stringify(`${site}/${STUB_DIR}`)})\n`;

/** `python3` under the built-in Python meeting one of these modules: what to do, instead of a bare ModuleNotFoundError */
export function stubSource(module: string, pkg: string): string {
  return `# Written by tabcomputer's pip (src/python/pyodide-dist.ts): ${pkg} is compiled, and comes from Pyodide.
import sys

if sys.platform == "emscripten":
    raise ModuleNotFoundError("No module named '${module}': Pyodide could not load ${pkg} (is the network reachable?)", name="${module}")
raise ModuleNotFoundError(
    "No module named '${module}' in the built-in Python: ${pkg} is compiled, and runs in Pyodide here. "
    "python3 FILE.py picks Pyodide when the file imports ${module}; for anything else say so: "
    "python3 --pyodide ...   (or TABCOMPUTER_PYTHON=pyodide)",
    name="${module}")
`;
}

async function write(fs: FileSystem, path: string, data: string): Promise<void> {
  await fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
  await fs.writeFile(path, data);
}

const distName = (name: string) => normalizeName(name).replace(/-/g, '_');

/**
 * Record one Pyodide package in `site`: a dist-info (INSTALLER says where it
 * comes from) and, for each module it provides, a stand-in that only the
 * built-in Python finds (STUB_DIR) and that says what to do.
 */
export async function recordPyodidePackage(fs: FileSystem, site: string, p: LockPackage, requested: boolean): Promise<void> {
  const di = `${distName(p.name)}-${p.version}.dist-info`;
  const record: string[] = [];
  const put = async (rel: string, text: string) => { await write(fs, `${site}/${rel}`, text); record.push(`${rel},,`); };
  for (const mod of p.imports) {
    if (!/^[A-Za-z_]\w*$/.test(mod)) continue;
    await put(`${STUB_DIR}/${mod}/__init__.py`, stubSource(mod, p.name));
  }
  await put(`${di}/METADATA`, [
    'Metadata-Version: 2.1', `Name: ${p.name}`, `Version: ${p.version}`,
    `Summary: Provided by Pyodide ${PYODIDE_VERSION}: python3 runs programs that import it in Pyodide`,
    ...p.depends.map((d) => `Requires-Dist: ${d}`),
  ].join('\n') + '\n');
  await put(`${di}/INSTALLER`, `${PYODIDE_INSTALLER}\n`);
  await put(`${di}/top_level.txt`, p.imports.join('\n') + '\n');
  if (requested) await put(`${di}/REQUESTED`, '');
  record.push(`${di}/RECORD,,`);
  await write(fs, `${site}/${di}/RECORD`, record.join('\n') + '\n');
}

/** An installed distribution, as pip.ts lists them */
interface Dist { name: string; version: string; distInfo: string; metadata: Record<string, string[]> }

export interface PyodideIndex {
  pyodide: string;
  /** importable module → the Pyodide packages a program importing it needs */
  modules: Record<string, string[]>;
}

async function readText(fs: FileSystem, path: string): Promise<string | null> {
  try { return await fs.readFile(path, 'utf8') as string; } catch { return null; }
}

/** The modules a distribution provides: top_level.txt, else the first component of its RECORD's paths */
async function topLevel(fs: FileSystem, d: Dist): Promise<string[]> {
  const tl = await readText(fs, `${d.distInfo}/top_level.txt`);
  if (tl !== null) return tl.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = new Set<string>();
  for (const line of (await readText(fs, `${d.distInfo}/RECORD`) ?? '').split('\n')) {
    const first = line.split(',')[0].split('/')[0];
    if (!first || first.startsWith('.') || /\.(dist-info|data|pth)$/.test(first) || first === '__pycache__') continue;
    out.add(first.replace(/\.py$/, ''));
  }
  return [...out];
}

/**
 * Rebuild `site`'s index from what is installed there (after every pip
 * install and uninstall): the Pyodide packages' own modules, and the modules
 * of every other distribution that depends on one (seaborn needs numpy,
 * pandas and matplotlib loaded). No Pyodide packages: no file.
 */
export async function rebuildPyodideIndex(fs: FileSystem, site: string, installed: Map<string, Dist>): Promise<PyodideIndex | null> {
  const fromPyodide = new Set<string>();
  for (const [key, d] of installed) {
    if ((await readText(fs, `${d.distInfo}/INSTALLER`))?.trim() === PYODIDE_INSTALLER) fromPyodide.add(key);
  }
  const file = `${site}/${INDEX_FILE}`;
  if (!fromPyodide.size) {
    for (const f of [file, `${site}/${STUB_PTH}`]) { try { await fs.unlink(f); } catch { /* none */ } }
    return null;
  }
  await write(fs, `${site}/${STUB_PTH}`, stubPth(site));
  const needs = (key: string, seen = new Set<string>()): Set<string> => {
    const out = new Set<string>();
    if (seen.has(key)) return out;
    seen.add(key);
    const d = installed.get(key);
    if (!d) return out;
    if (fromPyodide.has(key)) out.add(key);
    for (const r of d.metadata['requires-dist'] ?? []) {
      let dep: string;
      try {
        const q = parseRequirement(r);
        if (q.marker && /extra\s*==/.test(q.marker)) continue;
        dep = normalizeName(q.name);
      } catch { continue; }
      for (const n of needs(dep, seen)) out.add(n);
    }
    return out;
  };
  const modules: Record<string, string[]> = {};
  for (const [key, d] of installed) {
    const pkgs = [...needs(key)].sort();
    if (!pkgs.length) continue;
    for (const mod of await topLevel(fs, d)) modules[mod] = [...new Set([...(modules[mod] ?? []), ...pkgs])].sort();
  }
  const index: PyodideIndex = { pyodide: PYODIDE_VERSION, modules };
  await write(fs, file, JSON.stringify(index, null, 1) + '\n');
  return index;
}

export async function readPyodideIndex(fs: FileSystem, site: string): Promise<PyodideIndex | null> {
  const text = await readText(fs, `${site}/${INDEX_FILE}`);
  if (text === null) return null;
  try {
    const j = JSON.parse(text);
    return j && typeof j.modules === 'object' ? j as PyodideIndex : null;
  } catch { return null; }
}
