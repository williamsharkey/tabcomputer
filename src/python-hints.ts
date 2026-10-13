/**
 * The built-in Python (the WASI CPython package) has no Tk, so `import
 * tkinter` and `import turtle` (which imports it) failed with a bare "No
 * module named 'tkinter'". A `tkinter` package in its site-packages now
 * raises the same error with what to do. Debian's Python has the real one:
 * its tkinter draws in an X11 window.
 *
 * With Debian's Python installed, `python3 FILE.py` runs a file that imports
 * tkinter or turtle there by itself (src/python/choose.ts), so this is met
 * only where the import could not be seen beforehand: at the built-in
 * Python's prompt, in a program read from stdin, or in an import made at run
 * time. The message then names `python3 --debian`.
 */
import type { FileSystem } from './filesystem';

const SITE = '/usr/lib/pkg/python3/lib/python3.13/site-packages';

/** The stand-in `tkinter/__init__.py` */
export const TKINTER_STUB = `# Written by tabcomputer (src/python-hints.ts). Its built-in Python has no Tk.
import glob as _glob
if _glob.glob('/usr/lib/python3*/tkinter/__init__.py'):
    raise ModuleNotFoundError(
        "No module named 'tkinter' in tabcomputer's built-in Python. Debian's Python is installed and has it. "
        "Use it for this: python3 --debian FILE.py, or python3 --debian for its prompt.",
        name='tkinter')
raise ModuleNotFoundError(
    "No module named 'tkinter': tabcomputer's built-in Python has no Tk, so no tkinter and no turtle. "
    "Debian's Python has both and draws in a window. Run: toolchain install python   "
    "(python3 then runs a program that imports tkinter or turtle on Debian's Python)",
    name='tkinter')
`;

const done = new WeakSet<FileSystem>();

/** Write the stand-in where the built-in Python is installed and has no tkinter of its own. */
export async function ensurePythonHints(fs: FileSystem): Promise<void> {
  if (done.has(fs)) return;
  done.add(fs);
  try {
    if (!(await fs.exists(SITE))) { done.delete(fs); return; }
    const file = `${SITE}/tkinter/__init__.py`;
    const have = await fs.readFile(file, 'utf8').catch(() => null);
    if (have === TKINTER_STUB) return;
    // (a tkinter someone put there themselves is theirs)
    if (have !== null && !(typeof have === 'string' && have.startsWith('# Written by tabcomputer'))) return;
    await fs.mkdir(`${SITE}/tkinter`, { recursive: true });
    await fs.writeFile(file, TKINTER_STUB);
  } catch { /* the import then fails as before */ }
}
