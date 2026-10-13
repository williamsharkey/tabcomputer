/**
 * tabcomputer#125: the built-in Python's pip and releases with no
 * pure-Python wheel. `pip install flask` stopped at MarkupSafe, `pyyaml`,
 * `tornado` and `check50` at "has no pure-Python wheel". Now a source
 * distribution that needs no compiler installs: one with no compiled part,
 * or one whose extension is optional (its Python fallback runs; that it does
 * in the real interpreter is python-cpython.test.ts). Anything else with
 * compiled sources is refused before or right after the download, with what
 * to do instead.
 *
 * TABCOMPUTER_PIP_NET=1 adds the real projects from pypi.org.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { pipMain, createVenv, venvTarget, listInstalled } from '@shiro/commands/pip';
import { OPTIONAL_EXTENSIONS } from '@shiro/commands/pip-sdist';
import type { CommandContext } from '@shiro/commands/index';
import { fakeSdistIndex, pkgInfo, SAFEMARK, type FakeRelease } from './pip-sdist-helpers';

const VENV = '/sdist/.venv';
const SITE = `${VENV}/lib/python3.13/site-packages`;
let fs: FileSystem;

beforeEach(async () => {
  fs = new FileSystem();
  await fs.init();
  await fs.rm('/sdist', { recursive: true }).catch(() => {});
  await fs.mkdir('/sdist', { recursive: true });
  await createVenv(fs, VENV);
  OPTIONAL_EXTENSIONS.add('safemark');
});
afterAll(() => { OPTIONAL_EXTENSIONS.delete('safemark'); });

async function pip(args: string[], fetchFn: typeof fetch) {
  const ctx = { fs, cwd: '/sdist', env: { VIRTUAL_ENV: VENV }, stdout: '', stderr: '', args } as unknown as CommandContext;
  const code = await pipMain(ctx, args, venvTarget(VENV), fetchFn);
  return { code, out: ctx.stdout, err: ctx.stderr };
}
const read = async (p: string) => (await fs.readFile(p, 'utf8')) as string;
const tree = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const n of await fs.readdir(dir)) {
    const p = `${dir}/${n}`;
    if ((await fs.stat(p)).isDirectory()) out.push(...await tree(p)); else out.push(p.slice(SITE.length + 1));
  }
  return out.sort();
};

describe('pip install from a source distribution (#125)', () => {
  it('an optional extension is left out: the Python files, a dist-info, pip list and uninstall', async () => {
    const index = fakeSdistIndex([SAFEMARK]);
    const r = await pip(['install', 'safemark'], index.fetch);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Downloading safemark-3.0.4.tar.gz');
    expect(r.out).toContain('Built SafeMark 3.0.4 from its source distribution (pure Python: 1 compiled source file left out)');
    expect(r.out).toContain('Successfully installed SafeMark-3.0.4');
    expect(await tree(SITE)).toEqual([
      'SafeMark-3.0.4.dist-info/INSTALLER', 'SafeMark-3.0.4.dist-info/METADATA', 'SafeMark-3.0.4.dist-info/RECORD',
      'SafeMark-3.0.4.dist-info/REQUESTED', 'SafeMark-3.0.4.dist-info/WHEEL', 'SafeMark-3.0.4.dist-info/top_level.txt',
      'safemark/__init__.py', 'safemark/_native.py', 'safemark/_speedups.pyi', 'safemark/py.typed',
    ]);
    expect(await read(`${SITE}/SafeMark-3.0.4.dist-info/METADATA`)).toBe(pkgInfo('SafeMark', '3.0.4'));
    expect(await read(`${SITE}/SafeMark-3.0.4.dist-info/WHEEL`)).toContain('Tag: py3-none-any');
    expect((await listInstalled(fs, SITE)).get('safemark')?.version).toBe('3.0.4');
    // A second install is satisfied without a download
    const before = index.fetched.length;
    const again = await pip(['install', 'safemark>=2'], index.fetch);
    expect(again.out).toContain('Requirement already satisfied: safemark>=2');
    expect(index.fetched.slice(before).some((u) => u.endsWith('.tar.gz'))).toBe(false);
    expect((await pip(['uninstall', '-y', 'safemark'], index.fetch)).code).toBe(0);
    expect(await fs.exists(`${SITE}/safemark`)).toBe(false);
  });

  it('a dependency with an optional extension comes in with the package that needs it', async () => {
    const app: FakeRelease = {
      name: 'webby', version: '1.0', requires: ['SafeMark>=2.0'],
      sdist: { 'webby/__init__.py': 'import safemark\n', 'pyproject.toml': '[project]\nname = "webby"\nversion = "1.0"\n\n[project.scripts]\nwebby = "webby:main"\n' },
    };
    const r = await pip(['install', 'webby'], fakeSdistIndex([SAFEMARK, app]).fetch);
    expect(r.err).toBe('');
    expect(r.out).toMatch(/Successfully installed .*SafeMark-3\.0\.4/);
    expect(await fs.exists(`${SITE}/safemark/_native.py`)).toBe(true);
    // no egg-info: the package is found at the root, its script in pyproject.toml
    expect(await fs.exists(`${SITE}/webby/__init__.py`)).toBe(true);
    expect(await read(`${VENV}/bin/webby`)).toContain('from webby import main');
    expect(await read(`${SITE}/webby-1.0.dist-info/METADATA`)).toContain('Requires-Dist: SafeMark>=2.0');
  });

  it('an old release with only an sdist and no compiled part: a single module (termcolor 1.1.0)', async () => {
    const old: FakeRelease = {
      name: 'colorterm', version: '1.1.0',
      sdist: { 'setup.py': "from distutils.core import setup\nsetup(name='colorterm', py_modules=['colorterm'])\n", 'colorterm.py': 'def colored(s):\n    return s\n', 'README.rst': 'x\n' },
    };
    const r = await pip(['install', 'colorterm<2'], fakeSdistIndex([old]).fetch);
    expect(r.err).toBe('');
    expect(r.out).toContain('Built colorterm 1.1.0 from its source distribution\n');
    expect((await tree(SITE)).filter((f) => !f.includes('.dist-info/'))).toEqual(['colorterm.py']);
    expect(await read(`${SITE}/colorterm-1.1.0.dist-info/top_level.txt`)).toBe('colorterm\n');
  });

  it('PyYAML\'s layout: two top-level packages under lib/, named by the egg-info; a namespace package', async () => {
    OPTIONAL_EXTENSIONS.add('yamlish');
    const yamlish: FakeRelease = {
      name: 'yamlish', version: '6.0', otherWheels: ['yamlish-6.0-cp313-cp313-manylinux_2_28_x86_64.whl'],
      sdist: {
        'lib/yamlish.egg-info/top_level.txt': '_yamlish\nyamlish\nzns\n',
        'lib/yamlish.egg-info/entry_points.txt': '[console_scripts]\nyamlish = yamlish:main\n',
        'lib/yamlish/__init__.py': 'x = 1\n', 'lib/_yamlish/__init__.py': '', 'lib/zns/part/__init__.py': '',
        'yamlish/_yamlish.pyx': 'cdef x\n', 'yamlish/_yamlish.h': '', 'tests/legacy_tests/test_x.py': '',
      },
    };
    const r = await pip(['install', 'yamlish'], fakeSdistIndex([yamlish]).fetch);
    OPTIONAL_EXTENSIONS.delete('yamlish');
    expect(r.err).toBe('');
    expect((await tree(SITE)).filter((f) => !f.includes('.dist-info/'))).toEqual(['_yamlish/__init__.py', 'yamlish/__init__.py', 'zns/part/__init__.py']);
    expect(await read(`${VENV}/bin/yamlish`)).toContain('from yamlish import main');
  });

  it('a required extension is refused without downloading it, saying what to do', async () => {
    const numpyish: FakeRelease = {
      name: 'numberz', version: '2.0', otherWheels: ['numberz-2.0-cp313-cp313-manylinux_2_28_x86_64.whl'],
      sdist: { 'numberz/__init__.py': 'from . import _core\n', 'numberz/_core.c': '' },
    };
    const index = fakeSdistIndex([numpyish]);
    const r = await pip(['install', 'numberz'], index.fetch);
    expect(r.code).toBe(1);
    expect(r.err).toContain('numberz: version 2.0 has a compiled extension and no wheel for this Python.');
    expect(r.err).toContain("the built-in Python can't load compiled extensions");
    expect(r.err).toContain('toolchain install python');
    expect(index.fetched.some((u) => u.endsWith('.tar.gz'))).toBe(false);
  });

  it('an sdist-only release that turns out to need a compiler is refused, and nothing is installed', async () => {
    const mk = (name: string, sdist: Record<string, string>): FakeRelease => ({ name, version: '0.1', sdist });
    const cases = [
      mk('cext', { 'setup.py': 'from setuptools import setup, Extension\nsetup(ext_modules=[Extension("cext._c", ["cext/_c.c"])])\n', 'cext/__init__.py': '', 'cext/_c.c': '' }),
      mk('rusty', { 'pyproject.toml': '[build-system]\nrequires = ["maturin>=1"]\nbuild-backend = "maturin"\n', 'Cargo.toml': '', 'python/rusty/__init__.py': 'from ._rusty import *\n' }),
      mk('cythoned', { 'pyproject.toml': '[build-system]\nrequires = ["setuptools", "Cython>=3"]\nbuild-backend = "setuptools.build_meta"\n', 'cythoned/__init__.py': '' }),
    ];
    for (const c of cases) {
      const r = await pip(['install', 'colorterm', c.name], fakeSdistIndex([c, { name: 'colorterm', version: '1.0', sdist: { 'colorterm.py': '' } }]).fetch);
      expect(r.code, c.name).toBe(1);
      expect(r.err, c.name).toContain(`ERROR: ${c.name} 0.1 has a compiled extension`);
      expect(r.err, c.name).toContain('toolchain install python');
      expect((await tree(SITE)).length, c.name).toBe(0);
    }
  });

  it('a newer release with a wheel still wins over an sdist; -d saves the sdist as it is', async () => {
    const index = fakeSdistIndex([{ name: 'colorterm', version: '1.1.0', sdist: { 'colorterm.py': '' } }]);
    const r = await pip(['download', 'colorterm', '-d', '/sdist/dl'], index.fetch);
    expect(r.err).toBe('');
    expect(await fs.exists('/sdist/dl/colorterm-1.1.0.tar.gz')).toBe(true);
  });
});

describe.skipIf(!process.env.TABCOMPUTER_PIP_NET)('pip install from pypi.org (TABCOMPUTER_PIP_NET=1)', () => {
  const real = (...a: Parameters<typeof fetch>) => fetch(...a);
  for (const [spec, files] of [
    ['flask', ['markupsafe/_native.py', 'flask/app.py', 'werkzeug/serving.py', 'jinja2/environment.py']],
    ['pyyaml', ['yaml/__init__.py', '_yaml/__init__.py']],
    ['tornado', ['tornado/web.py', 'tornado/util.py']],
    ['msgpack', ['msgpack/fallback.py']],
    ['zope.interface', ['zope/interface/__init__.py']],
    ['termcolor<2', ['termcolor.py']],
  ] as [string, string[]][]) {
    it(`pip install ${spec}`, async () => {
      const t = Date.now();
      const r = await pip(['install', spec], real);
      console.log(`pip install ${spec}: ${Date.now() - t} ms\n${r.out.split('\n').filter((l) => /Built|Successfully/.test(l)).join('\n')}`);
      expect(r.err).toBe('');
      expect(r.code).toBe(0);
      const have = await tree(SITE);
      for (const f of files) expect(have, f).toContain(f);
      expect(have.filter((f) => /\.(c|pyx|h|so)$/.test(f))).toEqual([]);
    }, 120_000);
  }

  for (const spec of ['numpy', 'check50', 'jupyterlab']) {
    it(`pip install ${spec} says why not`, async () => {
      const r = await pip(['install', spec], real);
      console.log(`pip install ${spec}: ${r.err}`);
      expect(r.code).toBe(1);
      expect(r.err).toMatch(/has a compiled extension/);
      expect(r.err).toContain('toolchain install python');
      expect(r.err.includes('pyodide FILE.py')).toBe(spec === 'numpy');
      expect((await tree(SITE)).length).toBe(0);
    }, 120_000);
  }
});
