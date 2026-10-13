/**
 * Source distributions for the built-in Python's pip (tabcomputer#125).
 *
 * The built-in CPython is one statically linked WASI module: it has no
 * dlopen, so it can't load a compiled extension, and nothing here can
 * compile one. What pip can do with an sdist is install its Python files:
 *
 *  - a project with no compiled part (old releases that never had a wheel:
 *    termcolor 1.1.0) installs as it would from a wheel;
 *  - a project whose compiled part is optional (OPTIONAL_EXTENSIONS:
 *    MarkupSafe, PyYAML, tornado, ...) installs without it, and its own
 *    `except ImportError` fallback runs instead.
 *
 * Any other project with compiled sources is refused (CompiledSdistError).
 * No setup.py or build backend runs: the layout comes from the sdist's
 * egg-info (top_level.txt, entry_points.txt) or from where packages
 * usually are (src/, the root).
 */

/** One file of what gets installed: the shape pip's wheel reader gives. */
export interface BuiltFile { name: string; data: () => Promise<Uint8Array> }

/**
 * Projects (normalized names) that work without their compiled extension:
 * each imports it in a `try` and falls back to Python on ImportError.
 * Checked against the sdists named in tests/tests/shiro-vitest/pip-sdist.test.ts.
 */
export const OPTIONAL_EXTENSIONS = new Set(['markupsafe', 'pyyaml', 'tornado', 'msgpack', 'zope-interface']);

export class CompiledSdistError extends Error {}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Sources of a compiled part (headers alone don't make one). */
const COMPILED_SOURCE = /\.(c|cc|cpp|cxx|pyx|rs|f|f90|go)$/i;
/** Not installed: sources and build leftovers. */
const NOT_INSTALLED = /\.(c|cc|cpp|cxx|h|hpp|pyx|pxd|pxi|rs|f|f90|o|so|pyc|pyo)$/i;
const NOT_PACKAGES = new Set(['test', 'tests', 'testing', 'doc', 'docs', 'example', 'examples', 'benchmarks', 'bench', 'scripts', 'tools', 'build', 'dist', 'ci']);
const COMPILED_BACKEND = /maturin|mesonpy|scikit_build|setuptools_rust|pdm\.backend\.mesonpy|cffi|pybind11|Cython/;

const distName = (name: string) => name.replace(/[-_.]+/g, '_');

/** The files of an unpacked sdist, without its top directory. */
export function stripTopDir(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const tops = new Set([...files.keys()].map((n) => n.split('/')[0]));
  if (tops.size !== 1) return files;
  const out = new Map<string, Uint8Array>();
  for (const [n, d] of files) {
    const rest = n.slice(n.indexOf('/') + 1);
    if (n.includes('/') && rest) out.set(rest, d);
  }
  return out;
}

function entryPointsFromPyproject(project: any): string {
  const sections: [string, Record<string, unknown>][] = [];
  if (project?.scripts) sections.push(['console_scripts', project.scripts]);
  if (project?.['gui-scripts']) sections.push(['gui_scripts', project['gui-scripts']]);
  for (const [group, eps] of Object.entries(project?.['entry-points'] ?? {})) sections.push([group, eps as Record<string, unknown>]);
  return sections.map(([g, eps]) => `[${g}]\n` + Object.entries(eps).map(([k, v]) => `${k} = ${v}\n`).join('')).join('\n');
}

/**
 * What installing the sdist `files` (top directory stripped) puts in
 * site-packages, as wheel entries: its packages and modules without compiled
 * sources, and a dist-info made from PKG-INFO.
 */
export async function buildSdist(files: Map<string, Uint8Array>, normalizedName: string): Promise<{ name: string; version: string; entries: BuiltFile[]; skipped: number }> {
  const text = (p: string) => { const d = files.get(p); return d ? dec.decode(d) : null; };
  const pkgInfo = text('PKG-INFO');
  if (!pkgInfo) throw new Error(`${normalizedName}: the source distribution has no PKG-INFO`);
  const name = /^Name:\s*(.+)$/m.exec(pkgInfo)?.[1].trim() ?? normalizedName;
  const version = /^Version:\s*(.+)$/m.exec(pkgInfo)?.[1].trim();
  if (!version) throw new Error(`${name}: the source distribution's PKG-INFO has no Version`);
  const optional = OPTIONAL_EXTENSIONS.has(normalizedName);
  const names = [...files.keys()];
  const setupPy = text('setup.py') ?? '';
  const pyproject = text('pyproject.toml');

  if (!optional) {
    const backend = /^\s*build-backend\s*=\s*["']([^"']+)["']/m.exec(pyproject ?? '')?.[1] ?? '';
    const requires = /^\s*requires\s*=\s*\[([^\]]*)\]/m.exec(pyproject ?? '')?.[1] ?? '';
    const source = names.find((n) => COMPILED_SOURCE.test(n) && !n.split('/').slice(0, -1).some((d) => NOT_PACKAGES.has(d)));
    if (source || names.includes('Cargo.toml') || COMPILED_BACKEND.test(backend) || COMPILED_BACKEND.test(requires) ||
        /\bext_modules\b|\bcffi_modules\b|\brust_extensions\b|\bExtension\s*\(/.test(setupPy)) {
      throw new CompiledSdistError(`${name} ${version} has a compiled extension${source ? ` (${source})` : ''}`);
    }
  }

  // Where the packages are: egg-info's top_level.txt names them; without it, the usual places
  const eggTop = names.filter((n) => /^(?:[^/]+\/)?[^/]+\.egg-info\/top_level\.txt$/.test(n)).sort((a, b) => a.length - b.length)[0];
  const eggDir = eggTop ? eggTop.slice(0, eggTop.lastIndexOf('/')) : null;
  const eggBase = eggDir && eggDir.includes('/') ? eggDir.slice(0, eggDir.indexOf('/')) : '';
  const under = (base: string, rel: string) => (base ? `${base}/${rel}` : rel);
  const roots: { from: string; to: string }[] = []; // directory or file prefix → name in site-packages
  if (eggTop) {
    const bases = [...new Set([eggBase, 'src', 'lib', ''])];
    for (const top of text(eggTop)!.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const found =
        bases.find((b) => files.has(under(b, `${top}/__init__.py`))) ??
        bases.find((b) => files.has(under(b, `${top}.py`))) ??
        bases.find((b) => names.some((n) => n.startsWith(under(b, `${top}/`)) && n.endsWith('.py'))); // a namespace package
      if (found === undefined) continue;
      if (files.has(under(found, `${top}/__init__.py`)) || !files.has(under(found, `${top}.py`))) roots.push({ from: under(found, `${top}/`), to: `${top}/` });
      else roots.push({ from: under(found, `${top}.py`), to: `${top}.py` });
    }
  } else {
    const base = ['src', ''].find((b) => names.some((n) => {
      const rel = b ? (n.startsWith(`${b}/`) ? n.slice(b.length + 1) : null) : n;
      return !!rel && /^[^/]+\/__init__\.py$/.test(rel) && !NOT_PACKAGES.has(rel.split('/')[0]);
    })) ?? '';
    for (const n of names) {
      const rel = base ? (n.startsWith(`${base}/`) ? n.slice(base.length + 1) : null) : n;
      const m = rel && /^([^/]+)\/__init__\.py$/.exec(rel);
      if (m && !NOT_PACKAGES.has(m[1])) roots.push({ from: under(base, `${m[1]}/`), to: `${m[1]}/` });
    }
    const listed = /\bpy_modules\s*=\s*\[([^\]]*)\]/.exec(setupPy)?.[1].match(/[A-Za-z_][\w.]*/g) ?? [];
    for (const mod of new Set([...listed, distName(normalizedName)])) {
      const b = [base, ''].find((x) => files.has(under(x, `${mod}.py`)));
      if (b !== undefined && !roots.some((r) => r.to === `${mod}.py`)) roots.push({ from: under(b, `${mod}.py`), to: `${mod}.py` });
    }
  }
  if (!roots.length) throw new Error(`${name} ${version}: could not find its Python packages in the source distribution (tabcomputer's pip runs no build backend)`);

  const entries: BuiltFile[] = [];
  let skipped = 0;
  for (const [n, d] of files) {
    const root = roots.find((r) => (r.from.endsWith('/') ? n.startsWith(r.from) : n === r.from));
    if (!root || n.includes('/__pycache__/')) continue;
    if (NOT_INSTALLED.test(n)) { skipped++; continue; }
    entries.push({ name: root.to + n.slice(root.from.length), data: async () => d });
  }

  const distInfo = `${distName(name)}-${version}.dist-info`;
  const add = (file: string, body: string) => entries.push({ name: `${distInfo}/${file}`, data: async () => enc.encode(body) });
  add('METADATA', pkgInfo);
  add('WHEEL', 'Wheel-Version: 1.0\nGenerator: tabcomputer-pip (from the source distribution)\nRoot-Is-Purelib: true\nTag: py3-none-any\n');
  add('top_level.txt', [...new Set(roots.map((r) => r.to.replace(/(\/|\.py)$/, '')))].join('\n') + '\n');
  let entryPoints = eggDir ? text(`${eggDir}/entry_points.txt`) : null;
  if (!entryPoints && pyproject) {
    try {
      const { parse } = await import('smol-toml');
      entryPoints = entryPointsFromPyproject((parse(pyproject) as any).project) || null;
    } catch { /* a pyproject.toml smol-toml can't read: no scripts */ }
  }
  if (entryPoints) add('entry_points.txt', entryPoints);
  return { name, version, entries, skipped };
}
