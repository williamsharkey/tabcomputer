/**
 * numpy on the tab's Python (tabcomputer#125, option A of
 * docs/research/PYTHON_NATIVE_WHEELS.md): what can be checked without a
 * browser. `pip install numpy` records the Pyodide build instead of failing;
 * `python3` then sends a program that imports it to Pyodide, and everything
 * else to the built-in Python as before. Running in Pyodide itself is
 * tests/browser/pyodide-numpy.mjs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { pipMain, createVenv, venvTarget, listInstalled } from '@shiro/commands/pip';
import type { CommandContext } from '@shiro/commands/index';
import { scanImports } from '@shiro/python/imports';
import { parsePythonArgs, routePython, importsOf } from '@shiro/python/route';
import { INDEX_FILE, PYODIDE_VERSION, STUB_DIR, STUB_PTH, clearLockCache, lockClosure, pyodideProvides, readPyodideIndex, type PyodideLock } from '@shiro/python/pyodide-dist';
import { emErrno } from '@shiro/pyodide-worker/kfs';
import { fakeSdistIndex, type FakeRelease } from './pip-sdist-helpers';

const VENV = '/pyo/.venv';
const SITE = `${VENV}/lib/python3.13/site-packages`;
let fs: FileSystem;

/** A cut of pyodide-lock.json with the shapes that matter: compiled wheels, pure ones, a shared library */
const LOCK: PyodideLock = {
  info: { python: '3.13.2' },
  packages: {
    numpy: { name: 'numpy', version: '2.2.5', file_name: 'numpy-2.2.5-cp313-cp313-pyemscripten_2025_0_wasm32.whl', imports: ['numpy'], depends: [], package_type: 'package' },
    pandas: { name: 'pandas', version: '2.3.3', file_name: 'pandas-2.3.3-cp313-cp313-pyemscripten_2025_0_wasm32.whl', imports: ['pandas'], depends: ['numpy', 'python-dateutil', 'pytz'], package_type: 'package' },
    'python-dateutil': { name: 'python-dateutil', version: '2.9.0.post0', file_name: 'python_dateutil-2.9.0.post0-py2.py3-none-any.whl', imports: ['dateutil'], depends: ['six'], package_type: 'package' },
    pytz: { name: 'pytz', version: '2025.2', file_name: 'pytz-2025.2-py2.py3-none-any.whl', imports: ['pytz'], depends: [], package_type: 'package' },
    six: { name: 'six', version: '1.17.0', file_name: 'six-1.17.0-py2.py3-none-any.whl', imports: ['six'], depends: [], package_type: 'package' },
    scipy: { name: 'scipy', version: '1.14.1', file_name: 'scipy-1.14.1-cp313-cp313-pyemscripten_2025_0_wasm32.whl', imports: ['scipy'], depends: ['numpy', 'libopenblas'], package_type: 'package' },
    libopenblas: { name: 'libopenblas', version: '0.3.26', file_name: 'libopenblas-0.3.26.zip', imports: [], depends: [], package_type: 'shared_library' },
    pillow: { name: 'pillow', version: '11.3.0', file_name: 'pillow-11.3.0-cp313-cp313-pyemscripten_2025_0_wasm32.whl', imports: ['PIL'], depends: [], package_type: 'package' },
  },
};

/** What PyPI has: compiled projects with wheels for other platforms only, and a pure one that needs them */
const compiled = (name: string, version: string): FakeRelease => ({
  name, version, otherWheels: [`${name}-${version}-cp313-cp313-manylinux_2_28_x86_64.whl`],
  sdist: { [`${name}/__init__.py`]: 'from . import _core\n', [`${name}/_core.c`]: '' },
});
const SEAPLOT: FakeRelease = {
  name: 'seaplot', version: '0.9', requires: ['numpy>=1.20', 'pandas'],
  sdist: { 'seaplot/__init__.py': 'import numpy, pandas\n' },
};

function index(releases: FakeRelease[], lock: PyodideLock | null = LOCK) {
  const pypi = fakeSdistIndex(releases);
  const fetched: string[] = [];
  const fetchFn = (async (input: any, init?: any) => {
    const url = String(input);
    if (url.endsWith('/pyodide-lock.json')) {
      fetched.push(url);
      return lock ? new Response(JSON.stringify(lock), { status: 200 }) : new Response('', { status: 503 });
    }
    return pypi.fetch(input, init);
  }) as typeof fetch;
  return { fetch: fetchFn, fetched, pypi };
}

beforeEach(async () => {
  fs = new FileSystem();
  await fs.init();
  await fs.rm('/pyo', { recursive: true }).catch(() => {});
  await fs.mkdir('/pyo/proj', { recursive: true });
  await createVenv(fs, VENV);
});

async function pip(args: string[], fetchFn: typeof fetch) {
  const ctx = { fs, cwd: '/pyo', env: { VIRTUAL_ENV: VENV }, stdout: '', stderr: '', args } as unknown as CommandContext;
  const code = await pipMain(ctx, args, venvTarget(VENV), fetchFn);
  return { code, out: ctx.stdout, err: ctx.stderr };
}
const read = async (p: string) => (await fs.readFile(p, 'utf8')) as string;
const route = (args: string[], extra: Record<string, unknown> = {}) =>
  routePython(fs, args, { cwd: '/pyo/proj', env: { VIRTUAL_ENV: VENV }, canPyodide: true, ...extra });

describe('the import scan', () => {
  it('reads import and from lines, wherever they are', () => {
    expect(scanImports('import os, sys\nimport numpy as np\nfrom pandas.io import json\nfrom . import sibling\nfrom .local import x\n').sort())
      .toEqual(['numpy', 'os', 'pandas', 'sys']);
    expect(scanImports('try:\n    import ujson as json\nexcept ImportError:\n    import json\n').sort()).toEqual(['json', 'ujson']);
    expect(scanImports('if fast: import numpy\nx = 1; import scipy.linalg\n').sort()).toEqual(['numpy', 'scipy']);
    expect(scanImports('from matplotlib import (\n    pyplot,\n)\nimport matplotlib.pyplot as plt, PIL.Image\n').sort()).toEqual(['PIL', 'matplotlib']);
    expect(scanImports('np = __import__("numpy")\nimport importlib\npd = importlib.import_module(\'pandas.core\')\n').sort()).toEqual(['importlib', 'numpy', 'pandas']);
  });

  it('skips comments and triple-quoted text', () => {
    expect(scanImports('# import numpy\n"""\nimport pandas\n"""\nimport json  # import scipy\n')).toEqual(['json']);
    expect(scanImports("'''doc\nfrom numpy import x\n''' ; import re\nx = '''a''' ; import io\n").sort()).toEqual(['io', 're']);
    expect(scanImports('important = 1\nreimport = 2\nprint("imports")\n')).toEqual([]);
  });

  it('follows the modules that are files next to the program', async () => {
    await fs.writeFile('/pyo/proj/helpers.py', 'import stats\n');
    await fs.mkdir('/pyo/proj/stats', { recursive: true });
    await fs.writeFile('/pyo/proj/stats/__init__.py', 'import numpy as np\nimport helpers\n');
    expect([...await importsOf(fs, 'import helpers, json\n', '/pyo/proj')].sort()).toEqual(['helpers', 'json', 'numpy', 'stats']);
  });
});

describe('python3 arguments', () => {
  it('finds the program and its own arguments', () => {
    expect(parsePythonArgs(['plot.py', '--pyodide', '-c'])).toMatchObject({ kind: 'file', target: 'plot.py', argv: ['plot.py', '--pyodide', '-c'], force: undefined });
    expect(parsePythonArgs(['-u', '-W', 'ignore', '-c', 'import numpy', 'a'])).toMatchObject({ kind: 'code', target: 'import numpy', argv: ['-c', 'a'] });
    expect(parsePythonArgs(['-Bm', 'pkg.tool', '-v'])).toMatchObject({ kind: 'module', target: 'pkg.tool', argv: ['-m', '-v'] });
    expect(parsePythonArgs(['-cprint(1)'])).toMatchObject({ kind: 'code', target: 'print(1)' });
    expect(parsePythonArgs([])).toMatchObject({ kind: 'repl' });
    expect(parsePythonArgs(['-', 'x'])).toMatchObject({ kind: 'stdin', argv: ['-', 'x'] });
    expect(parsePythonArgs(['-V'])).toMatchObject({ kind: 'info' });
    expect(parsePythonArgs(['--version'])).toMatchObject({ kind: 'info' });
  });

  it('--pyodide and --wasi before the program choose the Python, and are not passed on', () => {
    expect(parsePythonArgs(['--pyodide', 'x.py'])).toMatchObject({ force: 'pyodide', args: ['x.py'], kind: 'file' });
    expect(parsePythonArgs(['-u', '--wasi', '-c', 'pass'])).toMatchObject({ force: 'wasi', args: ['-u', '-c', 'pass'] });
    expect(parsePythonArgs(['--pyodide'])).toMatchObject({ force: 'pyodide', kind: 'repl', args: [] });
  });
});

describe('pip install of a package Pyodide provides', () => {
  it('numpy: recorded, said in one line, listed, and no file downloaded', async () => {
    const ix = index([compiled('numpy', '2.5.4')]);
    const r = await pip(['install', 'numpy'], ix.fetch);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const lines = r.out.split('\n').filter((l) => /Pyodide/.test(l));
    expect(lines).toEqual(["Provided by Pyodide, the tab's Python for compiled packages (python3 runs a program that imports them there): numpy 2.2.5"]);
    expect(r.out).toContain('Successfully installed numpy-2.2.5');
    expect(ix.pypi.fetched.some((u) => /\.(tar\.gz|whl)$/.test(u))).toBe(false);
    expect((await listInstalled(fs, SITE)).get('numpy')?.version).toBe('2.2.5');
    expect((await read(`${SITE}/numpy-2.2.5.dist-info/INSTALLER`)).trim()).toBe('tabcomputer-pyodide');
    expect(await fs.exists(`${SITE}/numpy-2.2.5.dist-info/REQUESTED`)).toBe(true);
    expect(await readPyodideIndex(fs, SITE)).toEqual({ pyodide: PYODIDE_VERSION, modules: { numpy: ['numpy'] } });
    // The built-in Python, meeting `import numpy`, is told what to do: a stand-in on its path only
    // (in Pyodide a stand-in mpl_toolkits would win over matplotlib's namespace package)
    expect(await read(`${SITE}/${STUB_DIR}/numpy/__init__.py`)).toContain('python3 --pyodide');
    expect(await fs.exists(`${SITE}/numpy`)).toBe(false);
    expect(await read(`${SITE}/${STUB_PTH}`)).toBe(`import sys; sys.platform == "emscripten" or sys.path.append("${SITE}/${STUB_DIR}")\n`);
    const list = await pip(['list'], ix.fetch);
    expect(list.out).toMatch(/^numpy\s+2\.2\.5$/m);
    expect((await pip(['show', 'numpy'], ix.fetch)).out).toContain('Summary: Provided by Pyodide');
    // Again: satisfied, and nothing asked of PyPI's files or the lock
    const again = await pip(['install', 'numpy>=2'], ix.fetch);
    expect(again.out).toContain('Requirement already satisfied: numpy>=2');
  });

  it('pandas brings what it depends on, compiled or not', async () => {
    const ix = index([compiled('pandas', '3.0.6'), compiled('numpy', '2.5.4')]);
    const r = await pip(['install', 'pandas'], ix.fetch);
    expect(r.code, r.err).toBe(0);
    const have = await listInstalled(fs, SITE);
    expect([...have.keys()].sort()).toEqual(['numpy', 'pandas', 'python-dateutil', 'pytz', 'six']);
    expect(await fs.exists(`${SITE}/numpy-2.2.5.dist-info/REQUESTED`)).toBe(false);
    expect(await fs.exists(`${SITE}/pandas-2.3.3.dist-info/REQUESTED`)).toBe(true);
    const ixf = await readPyodideIndex(fs, SITE);
    expect(ixf?.modules.pandas).toEqual(['numpy', 'pandas', 'python-dateutil', 'pytz', 'six']);
    expect(ixf?.modules.dateutil).toEqual(['python-dateutil', 'six']);
    expect(ixf?.modules.numpy).toEqual(['numpy']);
  });

  it('a pure-Python package that needs numpy installs from PyPI, and its module is marked', async () => {
    const ix = index([SEAPLOT, compiled('numpy', '2.5.4'), compiled('pandas', '3.0.6')]);
    const r = await pip(['install', 'seaplot'], ix.fetch);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('Provided by Pyodide');
    expect(r.out).toMatch(/Successfully installed .*numpy-2\.2\.5.*seaplot-0\.9/);
    expect(await read(`${SITE}/seaplot/__init__.py`)).toBe('import numpy, pandas\n');
    expect((await readPyodideIndex(fs, SITE))?.modules.seaplot).toEqual(['numpy', 'pandas', 'python-dateutil', 'pytz', 'six']);
  });

  it('a version Pyodide does not have is refused, naming the one it has', async () => {
    const ix = index([compiled('numpy', '1.26.4')]);
    const r = await pip(['install', 'numpy==1.26.4'], ix.fetch);
    expect(r.code).toBe(1);
    expect(r.err).toContain(`numpy==1.26.4: numpy is compiled, so it comes from Pyodide ${PYODIDE_VERSION}, which has version 2.2.5 only`);
    expect(await fs.exists(`${SITE}/${INDEX_FILE}`)).toBe(false);
  });

  it('a compiled package Pyodide does not have, or no package list, is refused as before', async () => {
    const ix = index([compiled('jellyfish', '1.2.0')]);
    const r = await pip(['install', 'jellyfish'], ix.fetch);
    expect(r.code).toBe(1);
    expect(r.err).toContain('has a compiled extension and no wheel for this Python');
    expect(r.err).toContain('toolchain install python');
    clearLockCache(); // (the list is fetched once per page)
    const off = index([compiled('numpy', '2.5.4')], null);
    const r2 = await pip(['install', 'numpy'], off.fetch);
    expect(r2.code).toBe(1);
    expect(r2.err).toContain('has a compiled extension');
  });

  it('uninstall removes the record, the stand-in module and the index', async () => {
    const ix = index([compiled('numpy', '2.5.4')]);
    await pip(['install', 'numpy'], ix.fetch);
    const r = await pip(['uninstall', '-y', 'numpy'], ix.fetch);
    expect(r.code).toBe(0);
    expect(await fs.exists(`${SITE}/${STUB_DIR}`)).toBe(false);
    expect(await fs.exists(`${SITE}/${STUB_PTH}`)).toBe(false);
    expect(await fs.exists(`${SITE}/numpy-2.2.5.dist-info`)).toBe(false);
    expect(await fs.exists(`${SITE}/${INDEX_FILE}`)).toBe(false);
    expect((await route(['-c', 'import numpy'])).engine).toBe('wasi');
  });

  it('the lock: compiled wheels only, dependencies first, no shared libraries', () => {
    expect(pyodideProvides(LOCK, 'NumPy')?.version).toBe('2.2.5');
    expect(pyodideProvides(LOCK, 'Pillow')?.imports).toEqual(['PIL']);
    expect(pyodideProvides(LOCK, 'six')).toBeNull(); // pure: PyPI's
    expect(pyodideProvides(LOCK, 'libopenblas')).toBeNull();
    expect(lockClosure(LOCK, 'scipy').map((p) => p.name)).toEqual(['numpy', 'scipy']);
    expect(lockClosure(LOCK, 'pandas').map((p) => p.name)).toEqual(['numpy', 'six', 'python-dateutil', 'pytz', 'pandas']);
  });
});

describe('which Python runs a program', () => {
  beforeEach(async () => {
    const ix = index([SEAPLOT, compiled('numpy', '2.5.4'), compiled('pandas', '3.0.6')]);
    expect((await pip(['install', 'seaplot'], ix.fetch)).code).toBe(0);
    await fs.writeFile('/pyo/proj/plot.py', 'import sys\nimport numpy as np\nprint(np.arange(3))\n');
    await fs.writeFile('/pyo/proj/hello.py', 'import json, os\nprint("hi")\n');
    await fs.writeFile('/pyo/proj/uses.py', 'from helpers import mean\n');
    await fs.writeFile('/pyo/proj/helpers.py', 'import pandas as pd\n');
    await fs.writeFile('/pyo/proj/sea.py', 'import seaplot\n');
  });

  it('a file that imports numpy goes to Pyodide with what to load; one that does not stays', async () => {
    const r = await route(['plot.py', 'a', 'b']);
    expect(r).toEqual({
      engine: 'pyodide', args: ['plot.py', 'a', 'b'],
      run: { kind: 'file', target: 'plot.py', argv: ['plot.py', 'a', 'b'], packages: ['numpy'], sitePaths: [SITE] },
    });
    expect(await route(['hello.py'])).toEqual({ engine: 'wasi', args: ['hello.py'] });
    expect(await route(['/pyo/proj/plot.py'], { cwd: '/' })).toMatchObject({ engine: 'pyodide' });
    expect(await route(['missing.py'])).toMatchObject({ engine: 'wasi' });
  });

  it('through a local module, and through a pure package that needs it', async () => {
    expect(await route(['uses.py'])).toMatchObject({ engine: 'pyodide', run: { packages: ['numpy', 'pandas', 'python-dateutil', 'pytz', 'six'] } });
    expect(await route(['sea.py'])).toMatchObject({ engine: 'pyodide', run: { packages: ['numpy', 'pandas', 'python-dateutil', 'pytz', 'six'] } });
  });

  it('-c and -m', async () => {
    expect(await route(['-c', 'import numpy; print(numpy.pi)', 'x'])).toMatchObject({ engine: 'pyodide', run: { kind: 'code', target: 'import numpy; print(numpy.pi)', argv: ['-c', 'x'], packages: ['numpy'] } });
    expect(await route(['-c', 'print(1)'])).toMatchObject({ engine: 'wasi' });
    expect(await route(['-m', 'plot'])).toMatchObject({ engine: 'pyodide', run: { kind: 'module', target: 'plot', argv: ['-m'] } });
    expect(await route(['-m', 'numpy.f2py'])).toMatchObject({ engine: 'pyodide', run: { packages: ['numpy'] } });
    expect(await route(['-m', 'hello'])).toMatchObject({ engine: 'wasi' });
    expect(await route(['-m', 'http.server'])).toMatchObject({ engine: 'wasi' });
  });

  it('the REPL, -V and a program on stdin stay on the built-in Python', async () => {
    for (const args of [[], ['-V'], ['--version'], ['-']]) expect((await route(args)).engine, args.join(' ')).toBe('wasi');
  });

  it('--wasi, --pyodide and TABCOMPUTER_PYTHON decide it outright', async () => {
    expect(await route(['--wasi', 'plot.py'])).toEqual({ engine: 'wasi', args: ['plot.py'] });
    expect(await route(['--pyodide', 'hello.py'])).toMatchObject({ engine: 'pyodide', args: ['hello.py'], run: { kind: 'file', packages: [] } });
    expect(await route(['--pyodide'])).toMatchObject({ engine: 'pyodide', run: { kind: 'repl', argv: [''] } });
    expect(await route(['--pyodide'], { stdinIsTTY: false })).toMatchObject({ engine: 'pyodide', run: { kind: 'stdin', argv: ['-'] } });
    const env = (v: string) => ({ env: { VIRTUAL_ENV: VENV, TABCOMPUTER_PYTHON: v } });
    expect((await route(['plot.py'], env('wasi'))).engine).toBe('wasi');
    expect((await route(['hello.py'], env('pyodide'))).engine).toBe('pyodide');
    // the flag wins over the environment
    expect((await route(['--pyodide', 'hello.py'], env('wasi'))).engine).toBe('pyodide');
  });

  it('a page that cannot run Pyodide as a process keeps the built-in Python', async () => {
    expect((await route(['plot.py'], { canPyodide: false })).engine).toBe('wasi');
  });

  it('a venv has its own record: numpy installed in one is not installed in another', async () => {
    await createVenv(fs, '/pyo/other');
    expect((await route(['plot.py'], { env: { VIRTUAL_ENV: '/pyo/other' } })).engine).toBe('wasi');
    expect((await route(['plot.py'], { env: {} })).engine).toBe('wasi'); // the system site-packages
    // started by its path, a venv's python uses that venv whatever $VIRTUAL_ENV says
    expect((await route(['plot.py'], { env: {}, invokedPath: `${VENV}/bin/python` })).engine).toBe('pyodide');
  });
});

describe('errors from the tab reach Python as its own errno', () => {
  it('maps Linux numbers to Emscripten ones by name', () => {
    const codes = { ENOENT: 44, EEXIST: 20, EISDIR: 31, ENOTEMPTY: 55, EINTR: 27, EIO: 29 };
    expect(emErrno(2, codes)).toBe(44);
    expect(emErrno(17, codes)).toBe(20);
    expect(emErrno(39, codes)).toBe(55);
    expect(emErrno(4, codes)).toBe(27);
    expect(emErrno(9999, codes)).toBe(29);
  });
});
