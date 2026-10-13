/**
 * The notebook kernel's Python side: the modules a Pyodide guest writes into
 * its own site-packages before it runs cells (notebook-guest.ts).
 *
 *   tabcomputer_nb       runs a cell, turns values into mime bundles, answers
 *                        get_ipython() (magics, `!cmd`), display(), input()
 *   tabcomputer_nb_mpl   matplotlib's backend: figures are drawn under the cell
 *   IPython, matplotlib_inline
 *                        the names notebooks import from them, when the real
 *                        packages are not installed
 */

export const NB_KERNEL_PY = String.raw`"""The notebook kernel's Python side (written by tabcomputer)."""
import ast
import base64
import builtins
import io
import json
import linecache
import os
import re
import sys
import time
import tokenize
import traceback

import tabcomputer_nbjs as _js

user_ns = {"__name__": "__main__", "__builtins__": builtins, "__doc__": None}
_count = 0
_retina = False
_site_dirs = []
_rid = 0


class UsageError(Exception):
    pass


def _flush():
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.flush()
        except Exception:
            pass


def _send(msg):
    _flush()
    _js.send(json.dumps(msg))


def _request(msg):
    """Ask the page for something and wait for its answer (input, a shell command)."""
    global _rid
    _rid += 1
    _flush()
    reply = _js.request(json.dumps(dict(msg, rid=_rid)), _rid)
    if not isinstance(reply, str):
        raise KeyboardInterrupt
    return json.loads(reply)


# ── Values as mime bundles ──

_REPRS = (
    ("_repr_html_", "text/html"),
    ("_repr_markdown_", "text/markdown"),
    ("_repr_svg_", "image/svg+xml"),
    ("_repr_png_", "image/png"),
    ("_repr_jpeg_", "image/jpeg"),
    ("_repr_latex_", "text/latex"),
    ("_repr_json_", "application/json"),
    ("_repr_javascript_", "application/javascript"),
)


def _clean(mime, value):
    if isinstance(value, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(value)).decode("ascii")
    if mime == "application/json" or mime.endswith("+json"):
        # (NaN and Infinity are not JSON)
        return json.loads(json.dumps(value, default=str), parse_constant=lambda c: None)
    return value if isinstance(value, str) else str(value)


def _is_figure(obj):
    mod = sys.modules.get("matplotlib.figure")
    return mod is not None and isinstance(obj, mod.Figure)


def _figure_png(fig):
    buf = io.BytesIO()
    scale = 2 if _retina else 1
    fig.canvas.print_figure(buf, format="png", bbox_inches="tight", dpi=fig.dpi * scale,
                            facecolor=fig.get_facecolor(), edgecolor=fig.get_edgecolor())
    data = buf.getvalue()
    meta = {}
    if _retina and len(data) > 24:
        import struct
        w, h = struct.unpack(">II", data[16:24])
        meta = {"width": w // 2, "height": h // 2}
    return data, meta


def _bundle(obj):
    data, meta = {}, {}
    # (a class has the methods but they are not its own; an object that answers every name has none)
    plain = isinstance(obj, type)
    if not plain:
        try:
            plain = getattr(obj, "_ipython_canary_method_should_not_exist_", None) is not None
        except Exception:
            plain = True
    if not plain:
        mb = getattr(obj, "_repr_mimebundle_", None)
        if callable(mb):
            try:
                r = mb(include=None, exclude=None)
                if isinstance(r, tuple) and len(r) == 2:
                    r, md = r
                    meta.update(md or {})
                for mime, value in (r or {}).items():
                    data[mime] = _clean(mime, value)
            except Exception:
                pass
        for attr, mime in _REPRS:
            if mime in data:
                continue
            try:
                method = getattr(obj, attr, None)
                if not callable(method):
                    continue
                r = method()
            except Exception:
                continue
            if r is None:
                continue
            if isinstance(r, tuple) and len(r) == 2:
                r, md = r
                if md:
                    meta[mime] = md
            data[mime] = _clean(mime, r)
        if "image/png" not in data and _is_figure(obj):
            try:
                png, md = _figure_png(obj)
                data["image/png"] = _clean("image/png", png)
                if md:
                    meta["image/png"] = md
            except Exception:
                pass
    if "text/plain" not in data:
        try:
            data["text/plain"] = repr(obj)
        except Exception as e:
            data["text/plain"] = "<%s object: repr failed (%s)>" % (type(obj).__name__, e)
    return data, meta


# ── display() and the display classes ──

class DisplayHandle:
    def __init__(self, display_id=None):
        self.display_id = display_id or os.urandom(8).hex()

    def display(self, obj, **kwargs):
        display(obj, display_id=self.display_id, **kwargs)

    def update(self, obj, **kwargs):
        update_display(obj, display_id=self.display_id, **kwargs)


def display(*objs, include=None, exclude=None, metadata=None, transient=None, display_id=None,
            raw=False, clear=False, update=False, **kwargs):
    if display_id is True:
        display_id = os.urandom(8).hex()
    if clear:
        clear_output(wait=True)
    for obj in objs:
        if raw:
            data, meta = dict(obj), {}
        else:
            data, meta = _bundle(obj)
        if metadata:
            meta.update(metadata)
        msg = {"t": "display", "data": data, "metadata": meta}
        if display_id:
            msg["display_id"] = str(display_id)
            msg["update"] = bool(update)
        _send(msg)
    if display_id:
        return DisplayHandle(display_id)


def update_display(obj, *, display_id, **kwargs):
    display(obj, display_id=display_id, update=True, **kwargs)


def clear_output(wait=False):
    _send({"t": "clear", "wait": bool(wait)})


class DisplayObject:
    _mime = "text/plain"

    def __init__(self, data=None, url=None, filename=None, metadata=None):
        if data is None and filename is not None:
            with open(filename, "r", encoding="utf-8") as f:
                data = f.read()
        if data is None and url is not None:
            data = _fetch(url, binary=False)
        self.data = data
        self.url = url
        self.filename = filename
        self.metadata = metadata or {}

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {self._mime: self.data, "text/plain": "<IPython.display.%s object>" % type(self).__name__}


def _fetch(url, binary=True):
    if not binary:
        from pyodide.http import open_url
        return open_url(url).read()
    from js import XMLHttpRequest
    req = XMLHttpRequest.new()
    req.open("GET", url, False)
    req.responseType = "arraybuffer"
    req.send(None)
    return bytes(req.response.to_py())


class HTML(DisplayObject):
    _mime = "text/html"


class Markdown(DisplayObject):
    _mime = "text/markdown"


class Latex(DisplayObject):
    _mime = "text/latex"


class Math(Latex):
    def __init__(self, data=None, **kwargs):
        super().__init__(data, **kwargs)
        self.data = "$\\displaystyle %s$" % str(self.data).strip("$")


class SVG(DisplayObject):
    _mime = "image/svg+xml"


class Javascript(DisplayObject):
    _mime = "application/javascript"


class Pretty(DisplayObject):
    _mime = "text/plain"

    def _repr_mimebundle_(self, include=None, exclude=None):
        return {"text/plain": self.data}


class Code(Pretty):
    def __init__(self, data=None, url=None, filename=None, language=None):
        super().__init__(data, url=url, filename=filename)


class JSON(DisplayObject):
    _mime = "application/json"

    def __init__(self, data=None, url=None, filename=None, **kwargs):
        if isinstance(data, str):
            data = json.loads(data)
        if data is None and filename is not None:
            with open(filename, "r", encoding="utf-8") as f:
                data = json.load(f)
        self.data = data
        self.metadata = {}


_IMAGE_MIMES = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "svg": "image/svg+xml", "webp": "image/webp"}


class Image:
    def __init__(self, data=None, url=None, filename=None, format=None, embed=None, width=None, height=None,
                 retina=False, unconfined=False, metadata=None, alt=None):
        if isinstance(data, str) and (data.startswith("http://") or data.startswith("https://")):
            url, data = data, None
        elif isinstance(data, str) and filename is None and os.path.exists(data):
            filename, data = data, None
        if data is None and filename is not None:
            with open(filename, "rb") as f:
                data = f.read()
        if data is None and url is not None:
            data = _fetch(url)
        ext = format or os.path.splitext(str(filename or url or ""))[1].lstrip(".").lower() or "png"
        self.format = ext
        self.data = data
        self.width, self.height = width, height

    def _repr_mimebundle_(self, include=None, exclude=None):
        mime = _IMAGE_MIMES.get(self.format, "image/png")
        meta = {}
        if self.width:
            meta["width"] = self.width
        if self.height:
            meta["height"] = self.height
        data = self.data.decode("utf-8") if mime == "image/svg+xml" and isinstance(self.data, bytes) else self.data
        return {mime: data, "text/plain": "<IPython.core.display.Image object>"}, ({mime: meta} if meta else {})


class IFrame:
    def __init__(self, src, width, height, extras=None, **kwargs):
        self.src, self.width, self.height = src, width, height

    def __repr__(self):
        return "<IFrame %s (frames are not shown in this notebook)>" % self.src


class YouTubeVideo(IFrame):
    def __init__(self, id, width=400, height=300, **kwargs):
        super().__init__("https://www.youtube.com/embed/%s" % id, width, height)


# ── Figures ──

def flush_figures():
    """Draw every open figure under the cell and close it, as the inline backend does."""
    if "matplotlib.pyplot" not in sys.modules:
        return
    from matplotlib._pylab_helpers import Gcf
    managers = Gcf.get_all_fig_managers()
    if not managers:
        return
    try:
        for manager in managers:
            fig = manager.canvas.figure
            if not fig.axes and not fig.lines and not fig.images and not fig.texts and not fig.patches[1:]:
                continue
            display(fig)
    finally:
        sys.modules["matplotlib.pyplot"].close("all")


def set_matplotlib_formats(*formats, **kwargs):
    global _retina
    _retina = any(f in ("retina", "png2x") for f in formats)


# ── get_ipython() ──

class SList(list):
    @property
    def n(self):
        return "\n".join(self)

    @property
    def s(self):
        return " ".join(self)

    l = property(lambda self: self)


class _Captured:
    def __init__(self, stdout, stderr):
        self.stdout, self.stderr = stdout, stderr

    def show(self):
        sys.stdout.write(self.stdout)
        sys.stderr.write(self.stderr)

    __call__ = show

    def __str__(self):
        return self.stdout


_line_magics = {}
_cell_magics = {}


def _line(*names):
    def deco(fn):
        for n in names:
            _line_magics[n] = fn
        return fn
    return deco


def _cell(*names):
    def deco(fn):
        for n in names:
            _cell_magics[n] = fn
        return fn
    return deco


def _expand(cmd):
    """{expr} and $name in a shell line, from the notebook's variables."""
    def brace(m):
        try:
            return str(eval(m.group(1), user_ns))
        except Exception:
            return m.group(0)

    def dollar(m):
        name = m.group(1)
        return str(user_ns[name]) if name in user_ns else m.group(0)

    return re.sub(r"\$([A-Za-z_]\w*)", dollar, re.sub(r"\{([^{}]+)\}", brace, cmd))


class TabInteractiveShell:
    """What get_ipython() returns: the magics and shell lines a notebook uses."""
    user_ns = user_ns
    execution_count = 0
    kernel = None
    colors = "NoColor"

    def system(self, cmd):
        r = _request({"t": "shell", "cmd": _expand(cmd), "cwd": os.getcwd(), "capture": False})
        user_ns["_exit_code"] = r.get("code", 0)

    system_raw = system_piped = system

    def getoutput(self, cmd, split=True):
        r = _request({"t": "shell", "cmd": _expand(cmd), "cwd": os.getcwd(), "capture": True})
        user_ns["_exit_code"] = r.get("code", 0)
        out = r.get("out", "")
        return SList(out.splitlines()) if split else out

    def run_line_magic(self, name, line):
        fn = _line_magics.get(name)
        if fn is None:
            if name in _cell_magics:
                raise UsageError("%%%%%s is a cell magic: it goes on the first line of a cell, as %%%%%s." % (name, name))
            raise UsageError("Line magic function %s%s not found." % ("%", name))
        return fn(self, line)

    def run_cell_magic(self, name, line, cell):
        fn = _cell_magics.get(name)
        if fn is None:
            raise UsageError("Cell magic %s%s not found." % ("%%", name))
        return fn(self, line, cell)

    def magic(self, text):
        name, _, line = text.lstrip("%").partition(" ")
        return self.run_line_magic(name, line)

    def run_cell(self, source, **kwargs):
        _exec_sync(source, "<cell>")

    def register_magic_function(self, fn, magic_kind="line", magic_name=None):
        name = magic_name or fn.__name__
        if magic_kind in ("line", "line_cell"):
            _line_magics[name] = lambda shell, line: fn(line)
        if magic_kind in ("cell", "line_cell"):
            _cell_magics[name] = lambda shell, line, cell: fn(line, cell)

    def set_next_input(self, text, replace=False):
        print(text)

    def enable_matplotlib(self, gui=None):
        return "inline", "module://tabcomputer_nb_mpl"

    def ev(self, expr):
        return eval(expr, user_ns)

    def ex(self, code):
        exec(code, user_ns)

    def push(self, variables):
        user_ns.update(variables)

    @classmethod
    def instance(cls, *args, **kwargs):
        return _shell

    class events:
        @staticmethod
        def register(event, fn):
            pass

        @staticmethod
        def unregister(event, fn):
            pass


_shell = TabInteractiveShell()


def get_ipython():
    return _shell


def _run_system(name):
    return lambda shell, line: shell.system((name + " " + line).strip())


for _name in ("ls", "ll", "cat", "mkdir", "rmdir", "rm", "cp", "mv", "head", "tail", "less", "more", "man", "git", "wc", "grep", "find", "touch", "echo", "du", "df"):
    _line_magics[_name] = _run_system("ls -l" if _name == "ll" else "cat" if _name in ("less", "more") else _name)


def _noop(shell, line):
    return None


for _name in ("load_ext", "reload_ext", "unload_ext", "autoreload", "aimport", "precision", "colors", "xmode", "autosave",
              "notebook", "gui", "history", "hist", "store", "doctest_mode", "pprint", "automagic", "autocall",
              "logstart", "logstop", "logon", "logoff", "bookmark", "alias", "rehashx", "tb", "pdb", "debug", "matplotlib_inline"):
    _line_magics[_name] = _noop


@_line("matplotlib")
def _m_matplotlib(shell, line):
    arg = line.split()[0] if line.split() else "inline"
    if arg not in ("inline", "agg", "--list", "-l"):
        print("Plots are drawn under the cell here. %smatplotlib %s is not available." % ("%", arg), file=sys.stderr)
    if arg in ("--list", "-l"):
        print("Available matplotlib backends: ['inline']")


@_line("config")
def _m_config(shell, line):
    m = re.match(r"\s*InlineBackend\.figure_formats?\s*=\s*(.+)$", line)
    if m:
        set_matplotlib_formats(*re.findall(r"[A-Za-z0-9]+", m.group(1)))


@_line("pylab")
def _m_pylab(shell, line):
    exec("import numpy\nimport matplotlib\nfrom matplotlib import pyplot as plt\nnp = numpy\nfrom numpy import *\nfrom matplotlib.pyplot import *", user_ns)


@_line("pip")
def _m_pip(shell, line):
    import importlib
    shell.system("pip " + line)
    add_sites(_site_dirs)
    importlib.invalidate_caches()


@_line("conda", "mamba", "micromamba", "apt", "apt-get", "brew")
def _m_conda(shell, line):
    print("This notebook installs Python packages with pip: %spip install NAME" % "%", file=sys.stderr)


@_line("cd")
def _m_cd(shell, line):
    target = os.path.expanduser(line.strip().strip("'\"") or "~")
    os.chdir(target)
    print(os.getcwd())


@_line("pwd")
def _m_pwd(shell, line):
    return os.getcwd()


@_line("env", "set_env")
def _m_env(shell, line):
    line = line.strip()
    if not line:
        return dict(os.environ)
    name, sep, value = line.partition("=")
    if not sep:
        name, sep, value = line.partition(" ")
    if not sep:
        return os.environ.get(name)
    os.environ[name.strip()] = _expand(value.strip())
    print("env: %s=%s" % (name.strip(), os.environ[name.strip()]))


@_line("sx", "system")
def _m_sx(shell, line):
    return shell.getoutput(line)


@_line("clear", "cls")
def _m_clear(shell, line):
    clear_output()


@_line("who")
def _m_who(shell, line):
    names = sorted(k for k in user_ns if not k.startswith("_") and k not in _HIDDEN)
    print("\t ".join(names) if names else "Interactive namespace is empty.")


@_line("whos")
def _m_whos(shell, line):
    names = sorted(k for k in user_ns if not k.startswith("_") and k not in _HIDDEN)
    if not names:
        print("Interactive namespace is empty.")
        return
    print("%-20s %-16s %s" % ("Variable", "Type", "Data/Info"))
    print("-" * 60)
    for k in names:
        v = user_ns[k]
        try:
            info = repr(v).replace("\n", " ")
        except Exception:
            info = "?"
        print("%-20s %-16s %s" % (k, type(v).__name__, info[:60]))


@_line("reset")
def _m_reset(shell, line):
    for k in [k for k in user_ns if k not in _HIDDEN and k not in ("__name__", "__builtins__", "__doc__")]:
        del user_ns[k]
    _seed_ns()


@_line("run")
def _m_run(shell, line):
    import shlex
    args = shlex.split(line)
    args = [a for a in args if not (a.startswith("-") and a in ("-i", "-e", "-t", "-n"))]
    if not args:
        raise UsageError("%srun needs a file: %srun script.py" % ("%", "%"))
    path = os.path.expanduser(args[0])
    with open(path, "r", encoding="utf-8") as f:
        source = f.read()
    saved = sys.argv[:]
    sys.argv[:] = args
    try:
        scope = dict(user_ns, __file__=path)
        exec(compile(source, path, "exec"), scope)
        scope.pop("__file__", None)
        user_ns.update(scope)
    finally:
        sys.argv[:] = saved


@_line("lsmagic")
def _m_lsmagic(shell, line):
    print("Available line magics:\n" + "  ".join("%" + n for n in sorted(_line_magics)))
    print("\nAvailable cell magics:\n" + "  ".join("%%" + n for n in sorted(_cell_magics)))


@_line("pinfo", "pinfo2", "pdoc")
def _m_pinfo(shell, line):
    import inspect
    try:
        obj = eval(line, user_ns)
    except Exception:
        print("Object %s not found." % line)
        return
    try:
        print("Signature: %s%s" % (line.split(".")[-1], inspect.signature(obj)))
    except Exception:
        pass
    print("Type:      %s" % type(obj).__name__)
    doc = inspect.getdoc(obj)
    if doc:
        print("Docstring:\n" + doc)


def _span(seconds):
    if seconds >= 1:
        return "%.3g s" % seconds
    if seconds >= 1e-3:
        return "%.3g ms" % (seconds * 1e3)
    if seconds >= 1e-6:
        return "%.3g µs" % (seconds * 1e6)
    return "%.3g ns" % (seconds * 1e9)


@_line("time")
def _m_time(shell, line):
    t0 = time.perf_counter()
    try:
        return _exec_sync(line, "<timed exec>", want_value=True)
    finally:
        print("Wall time: %s" % _span(time.perf_counter() - t0))


@_cell("time")
def _c_time(shell, line, cell):
    t0 = time.perf_counter()
    try:
        value = _exec_sync(cell, "<timed exec>", want_value=True)
    finally:
        print("Wall time: %s" % _span(time.perf_counter() - t0))
    if value is not None:
        _result(value, _count)


def _timeit(stmt, setup="pass"):
    import timeit
    timer = timeit.Timer(stmt, setup, globals=user_ns)
    number, total = timer.autorange()
    best = min([total] + timer.repeat(repeat=2, number=number)) / number
    print("%s per loop (best of 3 runs, %d loop%s each)" % (_span(best), number, "" if number == 1 else "s"))


@_line("timeit")
def _m_timeit(shell, line):
    _timeit(re.sub(r"^(\s*-[nrtcpqo]\s*\S*)+\s*", "", line))


@_cell("timeit")
def _c_timeit(shell, line, cell):
    _timeit(cell, re.sub(r"^(\s*-[nrtcpqo]\s*\S*)+\s*", "", line) or "pass")


@_cell("capture")
def _c_capture(shell, line, cell):
    name = next((a for a in line.split() if not a.startswith("-")), None)
    out, err = io.StringIO(), io.StringIO()
    saved = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = out, err
    try:
        _exec_sync(cell, "<capture>")
    finally:
        sys.stdout, sys.stderr = saved
    if name:
        user_ns[name] = _Captured(out.getvalue(), err.getvalue())


@_cell("python", "python3", "prun")
def _c_python(shell, line, cell):
    _exec_sync(cell, "<cell>")


@_cell("writefile", "file")
def _c_writefile(shell, line, cell):
    args = line.split()
    append = "-a" in args
    names = [a for a in args if a != "-a"]
    if not names:
        raise UsageError("%swritefile needs a file name." % "%%")
    path = os.path.expanduser(names[0].strip("'\""))
    existed = os.path.exists(path)
    with open(path, "a" if append else "w", encoding="utf-8") as f:
        f.write(cell if cell.endswith("\n") else cell + "\n")
    print(("Appending to %s" if append else "Overwriting %s" if existed else "Writing %s") % path)


@_cell("bash", "sh", "script", "shell", "system", "sx", "zsh")
def _c_bash(shell, line, cell):
    shell.system(cell)


@_cell("html", "HTML")
def _c_html(shell, line, cell):
    display(HTML(cell))


@_cell("markdown")
def _c_markdown(shell, line, cell):
    display(Markdown(cell))


@_cell("latex")
def _c_latex(shell, line, cell):
    display(Latex(cell))


@_cell("svg", "SVG")
def _c_svg(shell, line, cell):
    display(SVG(cell))


@_cell("javascript", "js")
def _c_js(shell, line, cell):
    display(Javascript(cell))


def register_line_magic(fn):
    _line_magics[fn.__name__] = lambda shell, line: fn(line)
    return fn


def register_cell_magic(fn):
    _cell_magics[fn.__name__] = lambda shell, line, cell: fn(line, cell)
    return fn


def register_line_cell_magic(fn):
    _line_magics[fn.__name__] = lambda shell, line: fn(line)
    _cell_magics[fn.__name__] = lambda shell, line, cell: fn(line, cell)
    return fn


# ── Running a cell ──

_FLAGS = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
_CO_COROUTINE = 0x80


def _quiet(source):
    """Whether the cell ends with a semicolon: its last value is then not shown."""
    try:
        skip = (tokenize.COMMENT, tokenize.NL, tokenize.NEWLINE, tokenize.ENDMARKER, tokenize.INDENT, tokenize.DEDENT)
        toks = [t for t in tokenize.generate_tokens(io.StringIO(source).readline) if t.type not in skip]
        return bool(toks) and toks[-1].string == ";"
    except Exception:
        return False


def _compile(source, filename, flags=_FLAGS):
    tree = ast.parse(source, filename, "exec")
    last = None
    if tree.body and isinstance(tree.body[-1], ast.Expr) and not _quiet(source):
        last = ast.Expression(tree.body.pop().value)
    main = compile(tree, filename, "exec", flags=flags) if tree.body else None
    last = compile(last, filename, "eval", flags=flags) if last is not None else None
    return main, last


def _exec_sync(source, filename, want_value=False):
    """Run Python that a magic was given (no top-level await)."""
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    main, last = _compile(source, filename, flags=0)
    if main is not None:
        exec(main, user_ns)
    if last is not None:
        value = eval(last, user_ns)
        if want_value:
            return value
        if value is not None:
            _result(value, _count)
    return None


def _result(value, count):
    user_ns["_"] = value
    _Out[count] = value
    if _is_figure(value) and "matplotlib.pyplot" in sys.modules:
        # (an open figure is drawn once, when the cell ends)
        from matplotlib._pylab_helpers import Gcf
        if any(m.canvas.figure is value for m in Gcf.get_all_fig_managers()):
            return
    data, meta = _bundle(value)
    _send({"t": "result", "data": data, "metadata": meta, "count": count})


def _format_error(e, seen):
    seen.add(id(e))
    lines = []
    cause = e.__cause__
    context = None if e.__suppress_context__ else e.__context__
    if cause is not None and id(cause) not in seen:
        lines += _format_error(cause, seen) + ["\nThe above exception was the direct cause of the following exception:\n\n"]
    elif context is not None and id(context) not in seen:
        lines += _format_error(context, seen) + ["\nDuring handling of the above exception, another exception occurred:\n\n"]
    # (the frames of this file are the kernel's, not the notebook's)
    frames = [f for f in traceback.extract_tb(e.__traceback__) if f.filename != __file__]
    if frames:
        lines += ["Traceback (most recent call last):\n"] + traceback.format_list(frames)
    return lines + traceback.format_exception_only(type(e), e)


def _error(e):
    text = "".join(_format_error(e, set())).rstrip("\n")
    _send({"t": "error", "ename": type(e).__name__, "evalue": str(e), "traceback": text.split("\n")})


async def run_cell(source):
    global _count
    _count += 1
    n = _count
    _shell.execution_count = n
    filename = "<ipython-input-%d>" % n
    linecache.cache[filename] = (len(source), None, source.splitlines(True), filename)
    _In.append(source)
    status = "ok"
    try:
        try:
            main, last = _compile(source, filename)
            if main is not None:
                r = eval(main, user_ns)
                if main.co_flags & _CO_COROUTINE:
                    await r
            if last is not None:
                value = eval(last, user_ns)
                if last.co_flags & _CO_COROUTINE:
                    value = await value
                if value is not None:
                    _result(value, n)
        except UsageError as e:
            _flush()
            print("UsageError: %s" % e, file=sys.stderr)
            status = "error"
        except BaseException as e:
            _error(e)
            status = "error"
        try:
            flush_figures()
        except BaseException as e:
            _error(e)
            status = "error"
    except BaseException:
        # (a second interrupt, while the first was being reported)
        status = "error"
    _flush()
    return json.dumps({"status": status, "count": n})


# ── Setup ──

_HIDDEN = ("In", "Out", "get_ipython", "display", "exit", "quit")


_In = [""]
_Out = {}


def _seed_ns():
    user_ns["In"] = _In
    user_ns["Out"] = _Out
    user_ns["get_ipython"] = get_ipython
    user_ns["display"] = display


def _input(prompt=""):
    return _request({"t": "input", "prompt": str(prompt), "password": False})["value"]


def _getpass(prompt="Password: ", stream=None):
    return _request({"t": "input", "prompt": str(prompt), "password": True})["value"]


def _sleep(seconds):
    if seconds < 0:
        raise ValueError("sleep length must be non-negative")
    if _js.sleep(float(seconds)):
        raise KeyboardInterrupt


def add_sites(dirs):
    import site
    for d in dirs:
        if d not in sys.path and os.path.isdir(d):
            site.addsitedir(d)


def init(env, sitedirs, cwd):
    """Once, before the first cell."""
    import getpass
    global _site_dirs
    for key, value in env.items():
        os.environ[key] = value
    os.environ["MPLBACKEND"] = "module://tabcomputer_nb_mpl"
    os.environ.setdefault("TERM", "dumb")
    _site_dirs = list(sitedirs)
    add_sites(_site_dirs)
    try:
        os.chdir(cwd)
    except OSError:
        pass
    if "" not in sys.path:
        sys.path.insert(0, "")
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(write_through=True, errors="replace")
        except Exception:
            pass
    builtins.input = _input
    getpass.getpass = _getpass
    time.sleep = _sleep
    sys.argv[:] = [""]
    _seed_ns()
    return "%d.%d.%d" % sys.version_info[:3]
`;

export const NB_MPL_PY = String.raw`"""matplotlib backend for tabcomputer's notebook: Agg; figures are drawn under the cell."""
from matplotlib.backend_bases import FigureManagerBase
from matplotlib.backends.backend_agg import FigureCanvasAgg

import tabcomputer_nb


class FigureManagerNotebook(FigureManagerBase):
    @classmethod
    def pyplot_show(cls, *, block=None):
        tabcomputer_nb.flush_figures()

    def show(self):
        tabcomputer_nb.display(self.canvas.figure)


class FigureCanvasNotebook(FigureCanvasAgg):
    manager_class = FigureManagerNotebook


FigureCanvas = FigureCanvasNotebook
FigureManager = FigureManagerNotebook
show = tabcomputer_nb.flush_figures
flush_figures = tabcomputer_nb.flush_figures
set_matplotlib_formats = tabcomputer_nb.set_matplotlib_formats


def configure_inline_support(shell, backend):
    pass
`;

const DISPLAY_NAMES = 'display, update_display, clear_output, DisplayHandle, DisplayObject, HTML, Markdown, Latex, Math, SVG, Javascript, Pretty, Code, JSON, Image, IFrame, YouTubeVideo, set_matplotlib_formats';

/** The stand-ins, as files under site-packages: written only where the real package is not importable */
export const NB_STUBS: Record<string, Record<string, string>> = {
  IPython: {
    'IPython/__init__.py': `"""The parts of IPython a notebook imports (written by tabcomputer; the real package is not installed)."""
from tabcomputer_nb import get_ipython, display, UsageError
from . import display as display  # noqa: F811
from .core.interactiveshell import InteractiveShell

__version__ = "8.30.0"
version_info = (8, 30, 0, "")


def embed(*args, **kwargs):
    raise RuntimeError("IPython.embed() is not available in this notebook")
`,
    'IPython/display.py': `from tabcomputer_nb import ${DISPLAY_NAMES}\n`,
    'IPython/core/__init__.py': '',
    'IPython/core/display.py': `from tabcomputer_nb import ${DISPLAY_NAMES}\n`,
    'IPython/core/display_functions.py': 'from tabcomputer_nb import display, update_display, clear_output, DisplayHandle\n',
    'IPython/core/getipython.py': 'from tabcomputer_nb import get_ipython\n',
    'IPython/core/error.py': 'from tabcomputer_nb import UsageError\n',
    'IPython/core/interactiveshell.py': 'from tabcomputer_nb import TabInteractiveShell as InteractiveShell\n',
    'IPython/core/magic.py': `from tabcomputer_nb import register_line_magic, register_cell_magic, register_line_cell_magic


def needs_local_scope(fn):
    return fn
`,
    'IPython/utils/__init__.py': '',
    'IPython/utils/io.py': `from tabcomputer_nb import _Captured as CapturedIO\n`,
  },
  matplotlib_inline: {
    'matplotlib_inline/__init__.py': '__version__ = "0.1.7"\n',
    'matplotlib_inline/backend_inline.py': 'from tabcomputer_nb_mpl import *  # noqa: F401,F403\nfrom tabcomputer_nb_mpl import FigureCanvas, FigureManager, show, flush_figures, set_matplotlib_formats, configure_inline_support\n',
  },
};
