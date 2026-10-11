/**
 * pip install -e DIR for pure-Python projects (audit 6: the usual
 * `python3 -m venv .venv; pip install -e .; pytest` stopped at "editable
 * installs (-e) are not supported yet"). As PEP 660's: a .pth file putting the
 * project's source (src/ when it has one) on sys.path, a dist-info pip
 * list/show/uninstall know, [project.scripts], and the project's dependencies
 * (its extras' too) resolved with the rest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { pipMain, createVenv, venvTarget, listInstalled } from '@shiro/commands/pip';
import type { CommandContext } from '@shiro/commands/index';

const VENV = '/proj/.venv';
const SITE = `${VENV}/lib/python3.13/site-packages`;
let fs: FileSystem;

beforeEach(async () => {
  fs = new FileSystem();
  await fs.init();
  // (the test FileSystems share one IndexedDB: start each test from an empty /proj)
  await fs.rm('/proj', { recursive: true }).catch(() => {});
  await fs.mkdir('/proj', { recursive: true });
  await createVenv(fs, VENV);
});

async function pip(args: string[], fetchFn?: typeof fetch) {
  const ctx = { fs, cwd: '/proj', env: { VIRTUAL_ENV: VENV }, stdout: '', stderr: '', args } as unknown as CommandContext;
  const code = await pipMain(ctx, args, venvTarget(VENV), fetchFn ?? (async () => new Response('not found', { status: 404 })));
  return { code, out: ctx.stdout, err: ctx.stderr };
}
const read = async (p: string) => (await fs.readFile(p, 'utf8')) as string;

describe('pip install -e', () => {
  it('a src-layout project: .pth to src/, dist-info, console scripts, pip list', async () => {
    await fs.mkdir('/proj/src/demo', { recursive: true });
    await fs.writeFile('/proj/src/demo/__init__.py', 'def main():\n    return 0\n');
    await fs.writeFile('/proj/pyproject.toml', [
      '[project]', 'name = "demo-pkg"', 'version = "1.2.3"', 'description = "A demo"', 'requires-python = ">=3.10"',
      '', '[project.scripts]', 'demo = "demo:main"',
      '', '[build-system]', 'requires = ["flit_core<4"]', 'build-backend = "flit_core.buildapi"', '',
    ].join('\n'));
    const r = await pip(['install', '-e', '.']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Successfully installed demo-pkg-1.2.3');
    expect(await read(`${SITE}/__editable__.demo_pkg-1.2.3.pth`)).toBe('/proj/src\n');
    const md = await read(`${SITE}/demo_pkg-1.2.3.dist-info/METADATA`);
    expect(md).toContain('Name: demo-pkg\nVersion: 1.2.3\n');
    expect(JSON.parse(await read(`${SITE}/demo_pkg-1.2.3.dist-info/direct_url.json`))).toEqual({ url: 'file:///proj', dir_info: { editable: true } });
    expect(await read(`${VENV}/bin/demo`)).toMatch(/^#!\/proj\/\.venv\/bin\/python\n[\s\S]*from demo import main/);
    expect((await listInstalled(fs, SITE)).get('demo-pkg')?.version).toBe('1.2.3');
    expect((await pip(['list'])).out).toMatch(/demo-pkg\s+1\.2\.3/);
  });

  it('a flat project with a dynamic version reads __version__; the .pth is the project dir', async () => {
    await fs.mkdir('/proj/flat_mod', { recursive: true });
    await fs.writeFile('/proj/flat_mod/__init__.py', '"""doc"""\n__version__ = "10.1.0"\n');
    await fs.writeFile('/proj/pyproject.toml', '[project]\nname = "flat-mod"\ndynamic = ["version", "description"]\n');
    expect((await pip(['install', '-e', '/proj'])).code).toBe(0);
    expect(await read(`${SITE}/__editable__.flat_mod-10.1.0.pth`)).toBe('/proj\n');
  });

  it('dependencies and extras go to the resolver; --no-deps records them only', async () => {
    await fs.mkdir('/proj/src/withdeps', { recursive: true });
    await fs.writeFile('/proj/pyproject.toml', [
      '[project]', 'name = "withdeps"', 'version = "0.1"', 'dependencies = [', '  "needed-dep>=1",', ']',
      '[project.optional-dependencies]', 'test = ["test-only-dep"]', '',
    ].join('\n'));
    const asked: string[] = [];
    const r = await pip(['install', '-e', '.[test]'], (async (u: any) => { asked.push(String(u)); return new Response('nope', { status: 404 }); }) as typeof fetch);
    expect(r.code).toBe(1); // (the fake index has neither)
    expect(asked.join(' ')).toContain('needed-dep');
    const nd = await pip(['install', '--no-deps', '-e', '.[test]']);
    expect(nd.code).toBe(0);
    const md = await read(`${SITE}/withdeps-0.1.dist-info/METADATA`);
    expect(md).toContain('Requires-Dist: needed-dep>=1\n');
    expect(md).toContain('Provides-Extra: test\n');
    expect(md).toContain('Requires-Dist: test-only-dep; extra == "test"\n');
  });

  it('installing again replaces it, and pip uninstall removes the .pth and scripts', async () => {
    await fs.mkdir('/proj/src/re', { recursive: true });
    await fs.writeFile('/proj/pyproject.toml', '[project]\nname = "re"\nversion = "1.0"\n[project.scripts]\nre-run = "re:main"\n');
    expect((await pip(['install', '-e', '.'])).code).toBe(0);
    await fs.writeFile('/proj/pyproject.toml', '[project]\nname = "re"\nversion = "2.0"\n[project.scripts]\nre-run = "re:main"\n');
    expect((await pip(['install', '-e', '.'])).code).toBe(0);
    const entries = await fs.readdir(SITE);
    expect(entries.filter((e) => e.startsWith('re-'))).toEqual(['re-2.0.dist-info']);
    expect(entries).not.toContain('__editable__.re-1.0.pth');
    expect((await pip(['uninstall', '-y', 're'])).code).toBe(0);
    expect(await fs.exists(`${SITE}/__editable__.re-2.0.pth`)).toBe(false);
    expect(await fs.exists(`${VENV}/bin/re-run`)).toBe(false);
  });

  it('a setup.py-only project says why, with a failing status', async () => {
    await fs.writeFile('/proj/setup.py', 'from setuptools import setup\nsetup(name="old")\n');
    const r = await pip(['install', '-e', '.']);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/setup\.py\/setup\.cfg project/);
  });
});
