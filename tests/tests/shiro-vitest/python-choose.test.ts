/**
 * Which Python `python3` runs where Debian's is installed too (tabcomputer#124,
 * src/python/choose.ts): the built-in one unless the program needs Debian's.
 * And `pip` as one command: what neither the built-in Python nor Pyodide can
 * have is handed on. The real interpreters, in a browser:
 * tests/browser/python-first.mjs.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { FileSystem } from '@shiro/filesystem';
import { choosePython, debianPython, debianHasDists, shellPython, keepConsoleScripts, BUILTIN_PYTHON, TK_MODULES } from '@shiro/python/choose';
import { parsePythonArgs } from '@shiro/python/route';
import { INDEX_FILE } from '@shiro/python/pyodide-dist';
import { pipMain, systemTarget, consoleScript } from '@shiro/commands/pip';
import { pythonFrontend } from '@shiro/pkg-manager';
import type { CommandContext } from '@shiro/commands/index';
import { fakeSdistIndex, type FakeRelease } from './pip-sdist-helpers';

const SITE = '/usr/lib/pkg/python3/lib/python3.13/site-packages';
const DIST = '/usr/lib/python3/dist-packages';
let fs: FileSystem;

/** The built-in Python as `pkg install python3` leaves it */
async function builtinPython() {
  await fs.mkdir('/usr/lib/pkg/python3/bin', { recursive: true });
  await fs.mkdir(SITE, { recursive: true });
  await fs.writeFile(BUILTIN_PYTHON, new Uint8Array([0, 0x61, 0x73, 0x6d]));
  await fs.mkdir('/usr/bin', { recursive: true });
  for (const n of ['python3', 'python']) { await fs.unlink(`/usr/bin/${n}`).catch(() => {}); await fs.symlink(BUILTIN_PYTHON, `/usr/bin/${n}`); }
}

/** Debian's, as `toolchain install python` leaves it: /usr/bin/python3 → python3.13, apt's packages in dist-packages */
async function debianInstalled() {
  await fs.mkdir('/usr/bin', { recursive: true });
  await fs.writeFile('/usr/bin/python3.13', new Uint8Array(8192).fill(0x7f), { mode: 0o755 });
  await fs.unlink('/usr/bin/python3').catch(() => {});
  await fs.symlink('python3.13', '/usr/bin/python3');
  await fs.mkdir(`${DIST}/numpy`, { recursive: true });
  await fs.mkdir(`${DIST}/yaml`, { recursive: true });
  await fs.mkdir(`${DIST}/requests`, { recursive: true });
  await fs.mkdir(`${DIST}/pip`, { recursive: true });
  await fs.mkdir(`${DIST}/numpy-2.2.4.dist-info`, { recursive: true });
  await fs.mkdir(`${DIST}/PyYAML-6.0.2.egg-info`, { recursive: true });
  await fs.writeFile(`${DIST}/six.py`, '');
  await fs.writeFile(`${DIST}/_cffi_backend.cpython-313-x86_64-linux-gnu.so`, '');
  await fs.mkdir('/usr/lib/python3.13/tkinter', { recursive: true });
}

const rc = (env: Record<string, string> = {}) => ({ cwd: '/py', env: { HOME: '/home/user', ...env } });
const choose = (args: string[], env: Record<string, string> = {}) => choosePython(fs, args, rc(env));
const engine = async (args: string[], env: Record<string, string> = {}) => (await choose(args, env)).engine;

beforeEach(async () => {
  fs = new FileSystem();
  await fs.init();
  for (const d of ['/py', '/usr/lib/pkg/python3', '/usr/lib/python3', '/usr/lib/python3.13', '/usr/local/lib/python3.13', '/home/user/.local/lib', '/usr/local/bin']) await fs.rm(d, { recursive: true }).catch(() => {});
  for (const f of ['/usr/bin/python3', '/usr/bin/python', '/usr/bin/python3.13']) await fs.unlink(f).catch(() => {});
  await fs.mkdir('/py', { recursive: true });
  await fs.writeFile('/py/hello.py', 'import sys, json, os.path\nprint("hello")\n');
  await fs.writeFile('/py/draw.py', 'import turtle\nturtle.forward(100)\n');
  await fs.writeFile('/py/config.py', 'import yaml\n');
  await fs.writeFile('/py/data.py', 'import numpy as np\n');
  await fs.writeFile('/py/fetch.py', 'import numpy\nimport socket\n');
});

describe('which Python runs python3', () => {
  it('finds Debian\'s interpreter, and not tabcomputer\'s own package behind the same name', async () => {
    expect(await debianPython(fs)).toBeNull();
    await builtinPython();
    expect(await debianPython(fs)).toBeNull();
    await debianInstalled();
    expect(await debianPython(fs)).toBe('/usr/bin/python3.13');
  });

  it('without Debian\'s Python nothing changes: the built-in one, whatever the program imports', async () => {
    await builtinPython();
    for (const f of ['hello.py', 'draw.py', 'config.py', 'data.py']) expect(await engine([f]), f).toBe('builtin');
    expect(await shellPython(fs, ['draw.py'], '/usr/bin/python3', rc())).toBeNull();
    // --debian has nothing to run
    expect(await engine(['--debian', 'hello.py'])).toBe('missing');
    expect((await shellPython(fs, ['--debian', 'hello.py'], '/usr/bin/python3', rc()))?.engine).toBe('missing');
  });

  it('with Debian\'s installed, a plain program still runs on the built-in Python', async () => {
    await builtinPython();
    await debianInstalled();
    expect(await choose(['hello.py'])).toEqual({ engine: 'builtin', args: ['hello.py'] });
    expect(await engine(['-c', 'print(1)'])).toBe('builtin');
    expect(await engine(['-m', 'http.server'])).toBe('builtin');
    expect(await engine(['-m', 'json.tool', 'x.json'])).toBe('builtin');
    // the prompt, a program on stdin, and -V are the built-in one
    expect(await engine([])).toBe('builtin');
    expect(await engine(['-'])).toBe('builtin');
    expect(await engine(['-V'])).toBe('builtin');
    expect(await engine(['missing.py'])).toBe('builtin');   // (python says it can't open the file, at once)
  });

  it('a program that imports tkinter or turtle runs on Debian\'s', async () => {
    await builtinPython();
    await debianInstalled();
    const pick = await choose(['draw.py', '--speed', '3']);
    expect(pick).toEqual({ engine: 'debian', path: '/usr/bin/python3.13', args: ['draw.py', '--speed', '3'], why: 'it imports turtle' });
    expect(await engine(['-c', 'import tkinter as tk; tk.Tk()'])).toBe('debian');
    expect(await engine(['-m', 'turtledemo'])).toBe('debian');
    expect(await engine(['-m', 'tkinter'])).toBe('debian');
    expect(await engine(['-u', '-W', 'ignore', 'draw.py'])).toBe('debian');
    // ... through a module of the program's own
    await fs.writeFile('/py/shapes.py', 'from turtle import Turtle\n');
    await fs.writeFile('/py/main.py', 'import shapes\n');
    expect(await engine(['main.py'])).toBe('debian');
    expect([...TK_MODULES]).toContain('turtle');
  });

  it('a package that only Debian\'s Python has runs there; one the built-in has too stays', async () => {
    await builtinPython();
    await debianInstalled();
    const pick = await choose(['config.py']);
    expect(pick.engine).toBe('debian');
    expect((pick as { why: string }).why).toBe("yaml is installed for Debian's Python only");
    expect(await engine(['-c', 'import six'])).toBe('debian');            // a module file
    expect(await engine(['-c', 'import _cffi_backend'])).toBe('debian');  // a compiled module
    expect(await engine(['-c', 'import nothere'])).toBe('builtin');       // nobody has it: the built-in one says so, fast
    // `pip install pyyaml` put it in the built-in Python's own site-packages
    await fs.mkdir(`${SITE}/yaml`, { recursive: true });
    expect(await engine(['config.py'])).toBe('builtin');
    // a file of the program's own with a package's name is the program's
    await fs.writeFile('/py/requests.py', 'x = 1\n');
    expect(await engine(['-c', 'import requests'])).toBe('builtin');
    // what Debian's pip installed for the user, or into /usr/local
    await fs.mkdir('/home/user/.local/lib/python3.13/site-packages/lxml', { recursive: true });
    await fs.mkdir('/usr/local/lib/python3.13/dist-packages/psutil', { recursive: true });
    expect(await engine(['-c', 'import lxml'])).toBe('debian');
    expect(await engine(['-c', 'from psutil import cpu_count'])).toBe('debian');
  });

  it('numpy runs in Pyodide once pip recorded it; with sockets or subprocess as well, on Debian\'s', async () => {
    await builtinPython();
    await debianInstalled();
    // not recorded: Debian's is the only one that has it
    expect(await engine(['data.py'])).toBe('debian');
    await fs.writeFile(`${SITE}/${INDEX_FILE}`, JSON.stringify({ pyodide: '0.29.5', modules: { numpy: ['numpy'], pandas: ['pandas', 'numpy'] } }));
    expect(await engine(['data.py'])).toBe('builtin');
    const both = await choose(['fetch.py']);
    expect(both.engine).toBe('debian');
    expect((both as { why: string }).why).toBe('it imports numpy and socket');
    expect(await engine(['-c', 'import numpy, subprocess'])).toBe('debian');
    // threading and urllib alone are not a reason (most programs that import them start no thread)
    expect(await engine(['-c', 'import numpy, threading, urllib.parse'])).toBe('builtin');
    // pandas is not in Debian's: Pyodide is the only Python that has it
    expect(await engine(['-c', 'import pandas, socket'])).toBe('builtin');
  });

  it('--debian, --wasi, --pyodide and TABCOMPUTER_PYTHON decide it outright', async () => {
    await builtinPython();
    await debianInstalled();
    expect(await choose(['--debian', 'hello.py', '--debian'])).toEqual({ engine: 'debian', path: '/usr/bin/python3.13', args: ['hello.py', '--debian'], why: 'asked for' });
    expect(await engine(['--debian'])).toBe('debian');                       // Debian's prompt
    expect(await engine(['--wasi', 'draw.py'])).toBe('builtin');
    expect(await engine(['--pyodide', 'config.py'])).toBe('builtin');
    expect(await engine(['hello.py'], { TABCOMPUTER_PYTHON: 'debian' })).toBe('debian');
    expect(await engine(['draw.py'], { TABCOMPUTER_PYTHON: 'wasi' })).toBe('builtin');
    expect(await engine(['--debian', 'hello.py'], { TABCOMPUTER_PYTHON: 'wasi' })).toBe('debian');   // the flag wins
    expect(parsePythonArgs(['--debian', '-u', 'x.py']).force).toBe('debian');
    expect(parsePythonArgs(['--debian', '-u', 'x.py']).args).toEqual(['-u', 'x.py']);
    expect(parsePythonArgs(['x.py', '--debian']).force).toBeUndefined();
  });

  it('the shell leaves a venv\'s python alone, and asks only when Debian\'s is installed', async () => {
    await builtinPython();
    await debianInstalled();
    await fs.mkdir('/py/.venv/bin', { recursive: true });
    await fs.writeFile('/py/.venv/pyvenv.cfg', 'home = /usr/bin\n');
    expect(await shellPython(fs, ['draw.py'], '/py/.venv/bin/python3', rc())).toBeNull();
    expect((await shellPython(fs, ['draw.py'], '/usr/bin/python3', rc()))?.engine).toBe('debian');
    expect(await shellPython(fs, ['hello.py'], '/usr/bin/python3', rc())).toEqual({ engine: 'builtin', args: ['hello.py'] });
  });

  it('python3 -m pip, -m venv and -m ensurepip stay tabcomputer\'s (the builtin keeps those arguments); --debian first makes them Debian\'s', () => {
    expect(pythonFrontend(['-m', 'pip', 'install', 'x'])).toBe('pip');
    expect(pythonFrontend(['-m', 'venv', '.venv'])).toBe('venv');
    expect(pythonFrontend(['--debian', '-m', 'venv', '.venv'])).toBeNull();
    expect(pythonFrontend(['hello.py'])).toBeNull();
  });
});

describe('pip, one command', () => {
  const LXML: FakeRelease = { name: 'lxml', version: '5.3.0', otherWheels: ['lxml-5.3.0-cp313-cp313-manylinux_2_28_x86_64.whl'], sdist: { 'lxml/__init__.py': 'from . import etree\n', 'lxml/etree.c': '' } };
  const PURE: FakeRelease = { name: 'tinypure', version: '1.0', sdist: { 'tinypure/__init__.py': 'x = 1\n' } };
  const ctxFor = (args: string[]) => ({ fs, cwd: '/py', env: {}, stdout: '', stderr: '', args }) as unknown as CommandContext;

  it('a package with a compiled part that neither Python here can have is handed on when something can install it', async () => {
    await builtinPython();
    const { fetch } = fakeSdistIndex([LXML, PURE]);
    // nothing to hand it to: the sentence that says what to run
    const refused = ctxFor(['install', 'lxml']);
    expect(await pipMain(refused, ['install', 'lxml'], systemTarget(), fetch)).toBe(1);
    expect(refused.stderr).toContain('compiled extension');
    expect(refused.stderr).toContain("Debian's Python can install it. Run: toolchain install python, then this command again.");
    // Debian's pip is there: it gets the request, and its status is pip's
    const seen: string[] = [];
    const handed = ctxFor(['install', 'lxml']);
    expect(await pipMain(handed, ['install', 'lxml'], systemTarget(), fetch, { compiled: async (what) => { seen.push(what); return 0; } })).toBe(0);
    expect(seen).toEqual(['lxml']);
    expect(handed.stderr).toBe('');
    // ... and when that can't either (null), the sentence again
    const again = ctxFor(['install', 'lxml']);
    expect(await pipMain(again, ['install', 'lxml'], systemTarget(), fetch, { compiled: async () => null })).toBe(1);
    expect(again.stderr).toContain('toolchain install python');
    // a pure package never asks
    const pure = ctxFor(['install', 'tinypure']);
    expect(await pipMain(pure, ['install', 'tinypure'], systemTarget(), fetch, { compiled: async () => { throw new Error('not asked'); } })).toBe(0);
    expect(await fs.exists(`${SITE}/tinypure/__init__.py`)).toBe(true);
  });

  it('console scripts name the built-in interpreter by its file, so they still run it once /usr/bin/python3 is Debian\'s', async () => {
    expect(systemTarget().python).toBe(BUILTIN_PYTHON);
    // one written before (`#!/usr/bin/python3` was the built-in Python then) is put right when Debian's arrives
    await fs.mkdir('/usr/local/bin', { recursive: true });
    await fs.writeFile('/usr/local/bin/flask', consoleScript('/usr/bin/python3', 'flask.cli:main'), { mode: 0o755 });
    await fs.writeFile('/usr/local/bin/mine', '#!/usr/bin/python3\nprint("my own script")\n', { mode: 0o755 });
    expect(await keepConsoleScripts(fs)).toEqual(['/usr/local/bin/flask']);
    expect(((await fs.readFile('/usr/local/bin/flask', 'utf8')) as string).split('\n')[0]).toBe(`#!${BUILTIN_PYTHON}`);
    expect(((await fs.readFile('/usr/local/bin/flask', 'utf8')) as string)).toContain('from flask.cli import main');
    expect(((await fs.readFile('/usr/local/bin/mine', 'utf8')) as string).split('\n')[0]).toBe('#!/usr/bin/python3');
  });

  it('knows which distributions Debian\'s Python has (pip show and uninstall go there for those)', async () => {
    await builtinPython();
    expect(await debianHasDists(fs, ['numpy'], {})).toBe(false);
    await debianInstalled();
    expect(await debianHasDists(fs, ['numpy'], {})).toBe(true);
    expect(await debianHasDists(fs, ['pyyaml'], {})).toBe(true);
    expect(await debianHasDists(fs, ['numpy', 'PyYAML'], {})).toBe(true);
    expect(await debianHasDists(fs, ['numpy', 'pandas'], {})).toBe(false);
    expect(await debianHasDists(fs, [], {})).toBe(false);
  });
});
