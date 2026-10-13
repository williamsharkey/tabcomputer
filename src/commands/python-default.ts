/**
 * `python`, `python3`, `pip` and `pip3` when the profile's python shim is
 * "cpython" (docs/PROFILES.md): the prebuilt CPython package (`pkg install
 * python3`, WASI, scripts/pkgbuild/python3.sh), installed on first use. Once
 * it is installed its /usr/bin links shadow the two interpreters' builtins,
 * so those run only the first time, and for `-m pip`, `-m venv` and
 * `-m ensurepip`, which are tabcomputer's (`keepOverPackage`). Pyodide stays
 * available as `pyodide`.
 *
 * With Debian's Python installed as well (`toolchain install python`) these
 * names stay tabcomputer's: `python3` runs a program on the built-in Python
 * unless it needs Debian's (src/python/choose.ts; the shell asks it for a
 * program it runs as a kernel job, shell-kernel.ts), and `pip` is one
 * command: it installs for the built-in Python, and hands a package that
 * only Debian's Python can have to Debian's pip.
 */
import type { Command, CommandContext } from './index';

const PY_PACKAGE = 'python3';

/** Install the CPython package if it isn't; returns an exit code (0 = ready). */
async function ensureCPython(ctx: CommandContext, name: string): Promise<number> {
  const pm = await import('../pkg-manager');
  if ((await pm.readStatus(ctx.fs))[PY_PACKAGE]) return 0;
  // Say so on the terminal only: scripts' stderr stays clean
  ctx.terminal?.writeOutput(`${name}: installing CPython (pkg install ${PY_PACKAGE}) on first use...\r\n`);
  try {
    await pm.installPackages(ctx.fs, await pm.loadIndex(ctx.fs), [PY_PACKAGE], { env: ctx.env });
    return 0;
  } catch (e: any) {
    ctx.stderr += `${name}: could not install ${PY_PACKAGE}: ${e?.message ?? e}\n`;
    return 1;
  }
}

/** Run a program by path with these arguments, its output going where this command's goes */
async function runProgram(ctx: CommandContext, path: string, args: string[]): Promise<number> {
  const { quoteArgsForShell } = await import('../shell');
  // What this command printed so far comes first
  if (ctx.streamStdout && ctx.stdout) { ctx.streamStdout(ctx.stdout); ctx.stdout = ''; }
  if (ctx.streamStderr && ctx.stderr) { ctx.streamStderr(ctx.stderr); ctx.stderr = ''; }
  const out = (s: string) => { if (ctx.streamStdout) ctx.streamStdout(s); else ctx.stdout += s.replace(/\r\n/g, '\n'); };
  const err = (s: string) => { if (ctx.streamStderr) ctx.streamStderr(s); else ctx.stderr += s.replace(/\r\n/g, '\n'); };
  return ctx.shell.execute(quoteArgsForShell([path, ...args]), out, err);
}

/**
 * The venv that is active when it was made by Debian's Python (`python3.13
 * -m venv`): its `home` is not the built-in Python's. Its own python and pip
 * are the ones to run.
 */
async function debianVenv(ctx: CommandContext): Promise<string | null> {
  const venv = ctx.env.VIRTUAL_ENV;
  if (!venv) return null;
  try {
    const cfg = await ctx.fs.readFile(`${venv}/pyvenv.cfg`, 'utf8') as string;
    const home = /^home\s*=\s*(.+)$/m.exec(cfg)?.[1].trim() ?? '';
    const { PY_PREFIX } = await import('./pip');
    return home && !home.startsWith(PY_PREFIX) && await ctx.fs.exists(`${venv}/bin/python`) ? venv : null;
  } catch { return null; }
}

/** Debian's pip is there to hand a package to (python3-pip, part of `toolchain install python`) */
async function debianPip(ctx: CommandContext): Promise<string | null> {
  const { debianPython } = await import('../python/choose');
  const py = await debianPython(ctx.fs);
  return py && await ctx.fs.exists('/usr/lib/python3/dist-packages/pip') ? py : null;
}

/**
 * `pip ARGS` (and `python3 -m pip ARGS`): tabcomputer's pip, which installs
 * for the built-in Python and records what Pyodide provides (pip.ts). What
 * neither can have, a package with a compiled part and no build for them,
 * goes to Debian's pip when Debian's Python is installed, so that `python3`
 * finds it there (choose.ts); else the message says to install it.
 */
export async function pipCommand(ctx: CommandContext, name: string, args: string[], system?: import('./pip').PipTarget): Promise<number> {
  const { DEBIAN_MISSING } = await import('../python/choose');
  // (`system`: the system Python's own pip, `/usr/bin/python3 -m pip`, whatever venv is active)
  const inVenv = !system && !!ctx.env.VIRTUAL_ENV;
  // In a venv made by Debian's Python: that venv's pip
  const venv = system ? null : await debianVenv(ctx);
  if (venv) return runProgram(ctx, `${venv}/bin/python`, ['-m', 'pip', ...args]);
  if (args[0] === '--debian' || ctx.env.TABCOMPUTER_PYTHON === 'debian') {
    const rest = args[0] === '--debian' ? args.slice(1) : args;
    const py = await debianPip(ctx);
    if (!py) { ctx.stderr += `${name}: ${DEBIAN_MISSING}\n`; return 1; }
    return runProgram(ctx, py, ['-m', 'pip', ...rest]);
  }
  const rc = await ensureCPython(ctx, name);
  if (rc) return rc;
  const pip = await import('./pip');
  const target = system ?? await pip.pipTarget(ctx);
  const sub = args[0];
  // A package that was handed to Debian's pip is shown and removed there too
  if ((sub === 'uninstall' || sub === 'show') && !inVenv) {
    const names = args.slice(1).filter((a) => !a.startsWith('-'));
    const have = await pip.listInstalled(ctx.fs, target.site);
    const { normalizeName } = await import('../utils/pep440');
    const py = names.length && names.every((n) => !have.has(normalizeName(n))) ? await debianPip(ctx) : null;
    if (py && await (await import('../python/choose')).debianHasDists(ctx.fs, names, ctx.env)) return runProgram(ctx, py, ['-m', 'pip', ...args]);
  }
  return pip.pipMain(ctx, args, target, undefined, {
    // Only outside a venv of the built-in Python: Debian's pip would install beside it, where its python never looks
    compiled: inVenv ? undefined : async (what) => {
      const py = await debianPip(ctx);
      if (!py) return null;
      ctx.stdout += `${what} has a compiled part that only Debian's Python can use. Installing it for Debian's Python, where python3 runs a program that imports it.\n`;
      return runProgram(ctx, py, ['-m', 'pip', ...args]);
    },
  });
}

/** `python3 -m pip|venv|ensurepip`: tabcomputer's own (pkg-manager.ts pythonFrontend) */
async function frontend(ctx: CommandContext, name: string, which: 'pip' | 'venv' | 'ensurepip'): Promise<number> {
  const rest = ctx.args.slice(ctx.args.indexOf('-m') + 2);
  if (which === 'pip') return pipCommand(ctx, name, rest);
  // (in a venv made by Debian's Python, `python -m venv` is that Python's)
  const venv = await debianVenv(ctx);
  if (venv) return runProgram(ctx, `${venv}/bin/python`, ctx.args);
  const rc = await ensureCPython(ctx, name);
  if (rc) return rc;
  if (which === 'venv') return (await import('./pip')).venvMain(ctx, rest);
  ctx.stdout += 'pip is built into tabcomputer (python -m pip, pip); nothing to bootstrap.\n';
  return 0;
}

function cpython(name: string): Command {
  return {
    name,
    description: 'Python 3 interpreter (CPython for WASI; installs the python3 package on first use)',
    async exec(ctx) {
      const pm = await import('../pkg-manager');
      const which = pm.pythonFrontend(ctx.args);
      if (which) return frontend(ctx, name, which);
      // Debian's Python when the program needs it, or was asked for (src/python/choose.ts)
      const { choosePython, DEBIAN_MISSING } = await import('../python/choose');
      const pick = await choosePython(ctx.fs, ctx.args, { cwd: ctx.cwd, env: ctx.env });
      if (pick.engine === 'missing') { ctx.stderr += `${name}: ${DEBIAN_MISSING}\n`; return 1; }
      if (pick.engine === 'debian') return runProgram(ctx, pick.path, pick.args);
      const rc = await ensureCPython(ctx, name);
      if (rc) return rc;
      return pm.runPackageBinary(`${pm.PKG_ROOT}/${PY_PACKAGE}/bin/python3.wasm`, name, ctx.args, ctx, `/usr/bin/${name}`);
    },
  };
}

function cpip(name: string): Command {
  return {
    name,
    description: 'Install Python packages (pure-Python wheels and sources from PyPI; compiled ones from Pyodide or Debian)',
    // /usr/bin/pip is Debian's once `toolchain install python` ran; at the prompt this one command decides
    keepOverPackage: () => true,
    async exec(ctx) {
      return pipCommand(ctx, name, ctx.args);
    },
  };
}

export const cpythonCmd = cpython('python');
export const cpython3Cmd = cpython('python3');
export const cpipCmd = cpip('pip');
export const cpip3Cmd = cpip('pip3');
