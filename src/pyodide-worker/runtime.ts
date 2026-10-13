/**
 * What a Pyodide guest does with a loaded Pyodide, apart from where its
 * calls go (guest.ts gives it the kernel's): mount the tab's files, run one
 * program as `python3` would, and return its exit status.
 */
import { createKfs, type KfsSys } from './kfs';

/** What to run: one of python3's forms, already parsed (src/python/route.ts) */
export interface PyRun {
  /** 'stdin': the program is what fd 0 holds (`python3 -`, `python3 < file`) */
  kind: 'file' | 'module' | 'code' | 'repl' | 'stdin';
  /** The script's path, the module's name, or the code */
  target: string;
  /** sys.argv */
  argv: string[];
  /** Pyodide packages to load before it starts (the ones its imports need) */
  packages: string[];
  /** site-packages directories of the tab's pip, added to sys.path after Pyodide's own */
  sitePaths: string[];
}

/** Top-level directories that stay Pyodide's own: its standard library and devices */
const OWN_DIRS = new Set(['lib', 'dev', 'proc']);

/** Mount every top-level directory of the tab over the same name in Pyodide. */
export function mountTab(py: any, sys: KfsSys): void {
  const FS = py.FS;
  const kfs = createKfs(FS, py.ERRNO_CODES, sys);
  const names = sys.readdir('/');
  if (typeof names === 'number') return;
  FS.chdir('/');
  for (const name of names) {
    if (OWN_DIRS.has(name)) continue;
    const st = sys.stat('/' + name, true);
    if (typeof st === 'number' || (st.mode & 0o170000) !== 0o040000) continue;
    try {
      FS.mkdirTree('/' + name);
      FS.mount(kfs, { root: '/' + name }, '/' + name);
    } catch { /* mounted already, or not a directory in Pyodide */ }
  }
}

/** The module that runs a program as `python3` does: sys.argv, sys.path[0], `__main__`, the exit status */
export const RUNNER_PY = `"""Runs one program in Pyodide as python3 would (written by tabcomputer)."""
import os
import sys


def show_figure(path, title):
    import tabcomputer_js
    tabcomputer_js.show(path, title)


def _trim(tb):
    # (the frames of this file and of runpy are not the program's)
    while tb is not None:
        name = tb.tb_frame.f_code.co_filename
        if name != __file__ and "runpy" not in name:
            break
        tb = tb.tb_next
    return tb


def _flush():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass


def main(kind, target, argv, sitedirs, env):
    import site
    import traceback

    for key, value in env.items():
        os.environ[key] = value
    for d in sitedirs:
        if os.path.isdir(d):
            site.addsitedir(d)
    sys.argv[:] = argv
    import __main__

    scope = __main__.__dict__
    for key in [k for k in scope if k not in ("__name__", "__builtins__", "__doc__", "__spec__", "__loader__", "__package__")]:
        del scope[key]
    rc = 0
    try:
        if kind == "file":
            sys.path.insert(0, os.path.dirname(os.path.abspath(target)))
            with open(target, "rb") as f:
                source = f.read()
            scope["__file__"] = target
            exec(compile(source, target, "exec"), scope)
        elif kind == "module":
            sys.path.insert(0, os.getcwd())
            import runpy

            runpy.run_module(target, run_name="__main__", alter_sys=True)
        elif kind == "code":
            sys.path.insert(0, "")
            exec(compile(target, "<string>", "exec"), scope)
        else:
            sys.path.insert(0, "")
            import code

            banner = "Python %s (Pyodide) on tabcomputer\\nType exit() or press Ctrl+D to leave." % sys.version.split()[0]
            code.interact(banner=banner, local=scope, exitmsg="")
    except SystemExit as e:
        c = e.code
        if c is None:
            rc = 0
        elif isinstance(c, int):
            rc = c & 0xFF
        else:
            _flush()
            print(c, file=sys.stderr)
            rc = 1
    except KeyboardInterrupt as e:
        _flush()
        traceback.print_exception(type(e), e, _trim(e.__traceback__))
        rc = 130
    except BaseException as e:
        _flush()
        traceback.print_exception(type(e), e, _trim(e.__traceback__))
        rc = 1
    _flush()
    return rc
`;

/**
 * The matplotlib backend (MPLBACKEND=module://tabcomputer_mpl): Agg, whose
 * show() saves each open figure as a PNG in the tab's files and asks the page
 * to open it in a window. It returns at once and closes the figures, as a
 * window's show() does once the windows are closed.
 */
export const MPL_BACKEND_PY = `"""matplotlib backend for tabcomputer: Agg; show() opens each figure in a desktop window."""
import os

from matplotlib._pylab_helpers import Gcf
from matplotlib.backend_bases import FigureManagerBase
from matplotlib.backends.backend_agg import FigureCanvasAgg

_shown = 0


class FigureManagerTab(FigureManagerBase):
    @classmethod
    def pyplot_show(cls, *, block=None):
        global _shown
        import tabcomputer_run

        managers = Gcf.get_all_fig_managers()
        if not managers:
            return
        d = os.environ.get("TABCOMPUTER_PLOT_DIR") or "/tmp/tabcomputer-plots"
        os.makedirs(d, exist_ok=True)
        for manager in managers:
            _shown += 1
            path = "%s/figure-%s-%d.png" % (d, os.environ.get("TABCOMPUTER_PID", "0"), _shown)
            manager.canvas.figure.savefig(path)
            tabcomputer_run.show_figure(path, "Figure %s" % manager.num)
        Gcf.destroy_all()


class FigureCanvasTab(FigureCanvasAgg):
    manager_class = FigureManagerTab


FigureCanvas = FigureCanvasTab
FigureManager = FigureManagerTab
`;

/** Where Pyodide keeps the modules it loads (its own site-packages, in memory) */
function ownSite(py: any): string {
  const v = String(py.runPython('import sys; "%d.%d" % sys.version_info[:2]'));
  return `/lib/python${v}/site-packages`;
}

/** The two modules above, written once a Pyodide is loaded (before any program) */
export function installSupport(py: any): void {
  const site = ownSite(py);
  py.FS.mkdirTree(site);
  py.FS.writeFile(`${site}/tabcomputer_run.py`, RUNNER_PY);
  py.FS.writeFile(`${site}/tabcomputer_mpl.py`, MPL_BACKEND_PY);
}

/** A wait longer than this gets a line saying what it is for */
export const SLOW_MS = 2000;

export interface RunIo {
  /** Bytes for fd 0 into `buf`: the count, 0 at end of input, or a negative Linux errno */
  read(buf: Uint8Array): number;
  write(fd: 1 | 2, data: Uint8Array): void;
  isatty(fd: number): boolean;
  /** plt.show(): a figure saved at `path` */
  show(path: string, title: string): void;
}

/** Run `run` in `py` with the tab mounted; resolves with the exit status. */
export async function runProgram(py: any, run: PyRun, cwd: string, env: Record<string, string>, io: RunIo): Promise<number> {
  const enc = new TextEncoder();
  const say = (s: string) => io.write(2, enc.encode(s));
  py.setStdin({
    read(buf: Uint8Array) {
      const n = io.read(buf);
      // (EINTR: CPython checks for the interrupt and raises KeyboardInterrupt)
      if (n < 0) throw new py.FS.ErrnoError(n === -4 ? py.ERRNO_CODES.EINTR : py.ERRNO_CODES.EIO);
      return n;
    },
    isatty: io.isatty(0),
  });
  py.setStdout({ write(buf: Uint8Array) { io.write(1, buf); return buf.length; }, isatty: io.isatty(1) });
  py.setStderr({ write(buf: Uint8Array) { io.write(2, buf); return buf.length; }, isatty: io.isatty(2) });
  py.registerJsModule('tabcomputer_js', { show: (path: string, title: string) => io.show(String(path), String(title)) });
  try {
    py.FS.chdir(cwd);
  } catch {
    say(`python3: the working directory ${cwd} is not reachable from Pyodide\n`);
    return 1;
  }
  if (run.kind === 'stdin') {
    const chunks: Uint8Array[] = [];
    const buf = new Uint8Array(65536);
    for (let n = io.read(buf); n > 0; n = io.read(buf)) chunks.push(buf.slice(0, n));
    const all = new Uint8Array(chunks.reduce((a, c) => a + c.length, 0));
    chunks.reduce((off, c) => (all.set(c, off), off + c.length), 0);
    run = { ...run, kind: 'code', target: new TextDecoder().decode(all) };
  }
  const quiet = { messageCallback: () => {}, errorCallback: (m: string) => say(`python3: ${m}\n`) };
  // (a first fetch on a slow network: say what the wait is, on a terminal only)
  const note = io.isatty(2) ? setTimeout(() => say('python3: fetching packages from Pyodide...\n'), SLOW_MS) : undefined;
  try {
    if (run.packages.length) await py.loadPackage(run.packages, quiet);
    // (and what the program itself names, when the tab's scan did not see it)
    let source = run.kind === 'code' ? run.target : '';
    if (run.kind === 'file') { try { source = py.FS.readFile(run.target, { encoding: 'utf8' }); } catch { /* the run reports it */ } }
    if (source) await py.loadPackagesFromImports(source, quiet);
  } catch (e: any) {
    say(`python3: could not load a Pyodide package: ${e?.message ?? e}\n`);
  } finally {
    clearTimeout(note);
  }
  if (run.kind === 'file') {
    try { py.FS.stat(run.target); } catch {
      say(`python3: can't open file '${run.target}': [Errno 2] No such file or directory\n`);
      return 2;
    }
  }
  const runner = py.pyimport('tabcomputer_run');
  const args = [py.toPy(run.argv), py.toPy(run.sitePaths), py.toPy({ MPLBACKEND: 'module://tabcomputer_mpl', ...env })];
  try {
    // Where the engine can switch stacks (JSPI), the program may wait for a promise: asyncio.run
    // works. Elsewhere (or with TABCOMPUTER_PYODIDE_JSPI=0) it is an ordinary call, and
    // asyncio.run says it can't.
    const main = runner.main;
    const promising = env.TABCOMPUTER_PYODIDE_JSPI !== '0' && typeof (WebAssembly as any).Suspending === 'function' && typeof main.callPromising === 'function';
    return Number(promising ? await main.callPromising(run.kind, run.target, ...args) : main(run.kind, run.target, ...args));
  } catch (e: any) {
    // (Pyodide itself failed: a fatal error, not the program's exception)
    say(`python3: ${e?.message ?? e}\n`);
    return 1;
  } finally {
    for (const a of args) { try { a.destroy(); } catch { /* gone */ } }
  }
}
