# Compiled Python packages on the built-in Python

Research for tabcomputer#125 (and #112), 2026-10-12, Build 1008 plus branch
`unix/python-wheels`. Measured on an Apple M3 in headless Chrome unless a line
says otherwise. Nothing here was built: this is what was measured, what now
works, and the plan for numpy, pandas and matplotlib.

## What the built-in Python is

`pkg install python3` is CPython 3.13.7 from `scripts/pkgbuild/python3.sh`:
upstream's WASI port, wasi-sdk 25, target `wasm32-wasip1`, linked statically
with zlib, sqlite, OpenSSL and the compat shims.

It cannot load an extension module, and no file dropped next to it can change
that:

| Fact | Evidence |
| --- | --- |
| One static executable | `python3.wasm` (11,102,133 bytes) exports `memory` and `_start` only, has no `dylink.0` section, and imports only `wasi_snapshot_preview1` (42 functions) and `wasix_32v1` (21). No table, no `__stack_pointer`, no `Py*` symbol is exported, so a side module has nothing to link against. |
| `dlopen` is a stub | configure found `dlopen` in wasi-libc, so `_imp.create_dynamic` exists and `importlib.machinery.EXTENSION_SUFFIXES` is `['.cpython-313-wasm32-wasi.so', '.abi3.so', '.so']`. Importing such a file fails with `ImportError: dlopen not implemented`. |
| The kernel has no loader for side modules | `src/wasi/dylink.ts` places a position-independent main module; "dlopen of side modules is not implemented (ENOSYS)" (AGENTS.md, "WASM Processes"). |
| No threads | tabcomputer#84: the build is `wasm32-wasip1`, not `-threads`. |

`python-cpython.test.ts` ("cannot load extension modules") pins the first two
rows.

## What now installs (pure Python from the sdist)

The tab's `pip` is `src/commands/pip.ts`, running in the page. It used to
install pure-Python wheels only. A release with no such wheel now installs
from its source distribution when that needs no compiler
(`src/commands/pip-sdist.ts`):

- the release has no wheels at all and no compiled sources (termcolor 1.1.0,
  which check50's lib50 pins with `termcolor<2`);
- the project is on `OPTIONAL_EXTENSIONS`: MarkupSafe, PyYAML, tornado,
  msgpack, zope.interface. Each imports its extension in a `try` and falls
  back to Python on `ImportError`; the extension's sources are left out.

No setup.py or build backend runs. The package directories come from the
sdist's egg-info `top_level.txt`, else `src/` or the root.

| Command | Before | Now, in a tab (fresh profile, python3 already installed) |
| --- | --- | --- |
| `pip install flask` | fails: no MarkupSafe wheel | 0.7 s; 2.2 s in a second run on a busier machine (7 distributions) |
| hello-world Flask app (`app.run(port=5000)`), first request answered | n/a | 1.8 s after starting it (4.1 s in the second run); a later request 0.5 s (0.8 s), most of it starting the `python3` that asks |
| `pip install pyyaml tornado` | fails | 0.4 s (0.6 s); `import yaml, tornado.web` works, `yaml.__with_libyaml__` is False |
| `pip install "termcolor<2"` | fails | 0.2 s |
| `pip install numpy` | fails | fails in 0.6 s, saying why and what to do |
| `pip install check50 submit50` | fails at PyYAML | fails at jellyfish in 1.0 s |
| `pip install jupyterlab` | fails at tornado | fails at pyzmq in 1.2 s |

Times are from two runs of `tests/browser/python-wheels.mjs` against a local
build, with packages from pypi.org; the first run is shown, the second in
brackets where it differs much. The issue's target for Flask was 5 s.

Flask's development server runs because `socketserver`'s threading mix-in
handles the request inline when no thread can start (the patch in
`python3.sh`). `asyncio.run` works in the tab, so tornado can start a loop;
a tornado server was not tried.

## What does not, and why

Each of these is a required extension with no Python fallback. The refusal
names the first one pip meets and points at Debian's Python.

| Wanted | Blocked by | Notes |
| --- | --- | --- |
| check50, submit50 | `jellyfish>=1,<2` (Rust; `__init__` is `from ._rustyfish import *`, and the Python version in the sdist is only its test reference), `cryptography` (Rust + cffi) | Also `pexpect`, which needs a pty and `fork`: WASI has neither, so check50 could not run students' programs here even if it installed. Debian's Python installs both in 41 s (the issue's measurement). |
| jupyterlab, notebook | `pyzmq` (libzmq), `psutil`, `rpds-py` (Rust), `argon2-cffi-bindings`, `cffi` | A Jupyter kernel is also a second process talking over ZeroMQ sockets with threads (#84). |
| numpy, pandas, matplotlib, scipy | their own C, C++ and Fortran | below |
| fastapi | `pydantic-core` (Rust) | |
| pillow, lxml, pygame, regex, psutil, cryptography | C or Rust throughout | |

## Pyodide's wheels do not load in this Python

Pyodide 0.28.3 is CPython 3.13.2 (`pyodide-lock.json`: ABI `2025_0`,
`emscripten_4_0_9`), so the Python ABI is close. Its numpy wheel
(`numpy-2.2.5-cp313-cp313-pyodide_2025_0_wasm32.whl`, 3.1 MB, 11.7 MB
unpacked) has 13 extension modules totalling 6.4 MB. Every one is a
WebAssembly side module (`dylink.0`), and together they import from `env`:

- `memory`, `__indirect_function_table`, `__stack_pointer`, `__memory_base`,
  `__table_base`, plus `GOT.mem` and `GOT.func` entries: the main module's
  memory, table and stack, which `python3.wasm` does not export;
- 314 `Py*` symbols, which it does not export either;
- 218 libc, libm, compiler-rt and libc++abi symbols, among them
  `__cxa_throw`, `__cxa_begin_catch`, `_Unwind_CallPersonality` and the
  `__cpp_exception` tag: C++ exceptions on WebAssembly exception handling.
  pandas (44 modules, 15.4 MB) and matplotlib (which adds `__c_longjmp`,
  libc++ `std::string` and `dlopen`) need the same.

So loading them needs three things this Python lacks: a loader for side
modules in the kernel, a main module rebuilt to export its C API and a libc
with a C++ runtime, and Emscripten's libc ABI rather than wasi-libc's (both
derive from musl, but nothing guarantees their structures match, and a
mismatch corrupts memory instead of failing). The third cannot be had by
rebuilding: it would mean building CPython with Emscripten, which is Pyodide.

PyPI's own WebAssembly wheels are the same kind (`pyemscripten_*_wasm32`,
PEP 783): pandas 3.0.6 has one for cp312, pydantic-core 2.50.1 for cp314;
numpy 2.5.4 and matplotlib 3.11.2 have none.

## What works for numpy today

| Route | First `import numpy` | State |
| --- | --- | --- |
| `pyodide FILE.py` / `pyodide -c` | 2.4 s the first time in a fresh profile (fetch from the CDN and import), 0.3 s for a later `pyodide -c`; pandas 3.5 s, matplotlib to a saved PNG 3.7 s | Works on this branch: `pyodide` now fetches the Pyodide packages a program imports (`loadImports` in `src/commands/python.ts`). Before, `import numpy` there failed with ModuleNotFoundError, and with the CPython package installed `pip` no longer reaches micropip to fetch it. |
| Debian's Python (`toolchain install python`, numpy in the layer) | 7.2 s, with float128 warnings (#110; the issue's measurement) | Works; x86-64 under the emulator. |
| The built-in Python | n/a | Refused; the message names both routes above. |

`pyodide` is Pyodide 0.27.2 (Python 3.12, numpy 2.0.2, pandas 2.2.3), loaded
from jsdelivr into the page. Its gaps for a class: it runs on the page's main
thread, so `input()` and long loops block the tab; it copies the working
directory in and does not copy written files back (the PNG above stayed in
Pyodide's memory); packages outside its distribution need `micropip`, which
has no command here now.

## Plan for numpy on a fast Python

Not started: each option is more than a day, and none can be built on the
machine this was written on (the recipes use the x86-64 Linux wasi-sdk and a
native build Python).

**A. Make `pyodide` the numpy Python (smallest; about 2 to 3 days).** It
already meets the `import numpy` target. Work: run it in a Worker as a kernel
process so stdin, Ctrl-C and long loops behave (the node Worker runtime is the
model); mount the tab's filesystem instead of copying one directory in; move
to Pyodide 0.28 so it is Python 3.13 like the other; host the distribution on
the mirror instead of jsdelivr (what must be hosted: `pyodide.asm.wasm`,
`python_stdlib.zip` and the wheels, about 2.7 MB + 2.4 MB + 3.1 MB numpy +
5.3 MB pandas + 6.6 MB matplotlib and its dependencies, as served); route
`pip install numpy` on the built-in Python to say so, or to it. JupyterLite is
the same engine and is the realistic way to a notebook in 10 s.

**B. numpy linked into a second build of the built-in Python (about 1 to 2
weeks, uncertain).** A package `python3-numpy` whose `python3.wasm` has
numpy's 13 modules linked in and registered as built-ins (a meta-path finder
for the dotted names), with numpy's Python files in site-packages. Blocking
facts: numpy needs C++ with exceptions (`_multiarray_umath` imports the
libc++abi exception runtime in Pyodide's build, measured above) and
`feraiseexcept`/`fetestexcept`. Not verified here, from memory of the
projects: numpy's meson build has no supported `wasm32-wasi` target (the
precedent to read first is the `wasi-wheels` project used by componentize-py,
which patches it), and wasi-sdk 25's libc++ is built without exceptions. Size:
about +6.4 MB of code on the 11.1 MB interpreter, which is why it should be a
separate package and not the default. pandas (15.4 MB of modules) and
matplotlib (freetype, C++, contourpy, kiwisolver, pillow) are each a further
project of the same kind, and every other compiled package stays out.

**C. Real dynamic loading (weeks).** `dlopen` in the kernel for `dylink.0`
side modules, the interpreter rebuilt position-independent with its symbols
exported, and every wheel built here with wasi-sdk. This is the only route
where `pip install` finds wheels for arbitrary compiled packages, and it
means running a wheel-building service for a platform nobody else targets.
It does not make Pyodide's wheels usable (the libc ABI above).

Recommendation: A, and keep Debian's Python as the answer for everything
compiled that Pyodide does not ship (check50, Jupyter with real kernels).

## Also checked for #112

- The built-in `pip` never refuses with PEP 668: it is not real pip.
  `pip install --user cowsay` installs and `python3 -m cowsay` runs (local
  build).
- Debian's Python, on production (Build 1008), in a fresh profile:
  `toolchain install python` (2.2 s), `/etc/pip.conf` is there with
  `break-system-packages = true`, `pip install cowsay` installs with no
  refusal (79 s) and so does `pip install --user pyfiglet` (75 s).
- turtle draws there: a 36-line filled star from `turtle.Turtle()` at
  `speed(0)` was complete in a "Python Turtle Graphics" X11 window (700x675)
  less than 45 s after `python3 t.py` started (the first check was at 45 s).
  The built-in Python has no tkinter (`import turtle` fails at
  `import tkinter`); a canvas-backed turtle for it is not written.
